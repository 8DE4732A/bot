import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../../utils/logger.ts";
import { getBotPaths } from "../../config/env-paths.ts";
import type { ChannelAdapter, InboundMessage, MediaAttachment } from "../base.ts";
import { InboundPipeline } from "../runtime/dispatch.ts";
import { ChannelManager } from "../manager.ts";
import { storeMediaStream, withDownloadSlot, MEDIA_MAX_BYTES } from "../runtime/media-cache.ts";
import { safeFetch } from "../../utils/net-guard.ts";

export interface WeixinCredentials {
  /** iLink bot id (扫码确认后返回 ilink_bot_id); 缺省 "default" */
  accountId?: string;
  /** bot_token (扫码获得; 也可落盘凭据文件持久化) */
  token?: string;
  baseUrl?: string;
}

// ── iLink 协议常量 (对齐 hermes weixin.py, 接口无 SLA, 演进集中在这一层) ──

const ILINK_BASE_URL = "https://ilinkai.weixin.qq.com";
const WEIXIN_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const ILINK_APP_ID = "bot";
const ILINK_APP_CLIENT_VERSION = (2 << 16) | (2 << 8) | 0;
const EP_GET_UPDATES = "ilink/bot/getupdates";
const EP_SEND_MESSAGE = "ilink/bot/sendmessage";
const EP_SEND_TYPING = "ilink/bot/sendtyping";
const EP_GET_CONFIG = "ilink/bot/getconfig";
const EP_GET_BOT_QR = "ilink/bot/get_bot_qrcode";
const EP_GET_QR_STATUS = "ilink/bot/get_qrcode_status";
const LONG_POLL_TIMEOUT_MS = 35_000;
const API_TIMEOUT_MS = 15_000;
const CONFIG_TIMEOUT_MS = 10_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const RETRY_DELAY_MS = 2_000;
const BACKOFF_DELAY_MS = 30_000;
const SESSION_EXPIRED_ERRCODE = -14;
const RATE_LIMIT_ERRCODE = -2;
const MSG_TYPE_BOT = 2;
const MSG_STATE_FINISH = 2;
const ITEM_TEXT = 1;
const ITEM_IMAGE = 2;
const ITEM_VOICE = 3;
const ITEM_FILE = 4;
const ITEM_VIDEO = 5;
const TYPING_START = 1;
const TYPING_STOP = 2;
/** iLink 单条 ~2048 字符分块, 保守取 2000 */
const MAX_MESSAGE_BYTES = 2_000;
/** 群聊: iLink bot 身份通常收不到普通群事件 (hermes 实证), 仅作类型标注 */
const TYPING_TICKET_TTL_MS = 600_000;

/**
 * 微信个人号 iLink Bot API 渠道 (M3, 设计 §4.3)——零 SDK 依赖, 协议语义
 * 移植自 hermes weixin.py (生产级实现):
 * - 登录: QR 扫码 (get_bot_qrcode → get_qrcode_status 轮询) 获得 bot_token;
 *   凭据落盘 `<dotBot>/channels/weixin/<accountId>/account.json` (0600)
 * - 入站: getupdates 长轮询 (35s, 服务端建议超时自适应); sync_buf 游标持久化
 * - 回复: sendmessage 必须回执 peer 最新 context_token (磁盘持久化); 会话
 *   过期 (-14/陈旧 -2) 降级 tokenless 重发一次; -2 限频退避重试
 * - 媒体: CDN AES-128-ECB 加密传输, Node crypto 原生支持
 * 限制即语义: 仅私聊、纯文本 (markdown 经 plain 降级)、-14 需重新扫码。
 */
export class WeixinChannelAdapter implements ChannelAdapter {
  readonly type = "weixin" as const;
  readonly id: string;
  readonly name: string;
  maxMessageBytes = MAX_MESSAGE_BYTES;
  markdownMode = "plain" as const;

  private credentials: WeixinCredentials;
  private pipeline?: InboundPipeline;
  private running = false;
  private pollLoop?: Promise<void>;

  // 运行时凭据 (扫码/落盘恢复)
  private accountId = "";
  private token = "";
  private baseUrl = ILINK_BASE_URL;

  private contextTokens = new Map<string, string>();
  private typingTickets = new Map<string, { ticket: string; at: number }>();
  private seen = new Set<string>();
  private lastSweepAt = 0;
  private sendGate: Promise<void> = Promise.resolve();
  private typingPeers = new Map<string, () => void>();

  constructor(id: string, name: string, credentials: WeixinCredentials) {
    this.id = id;
    this.name = name;
    this.credentials = credentials;
  }

  // ── 持久化 ──

  private accountDir(): string {
    return join(getBotPaths().dotBot, "channels", "weixin", this.accountId.replace(/[^a-zA-Z0-9_-]/g, "_"));
  }

  private saveAccount(): void {
    const dir = this.accountDir();
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "account.json");
    atomicWrite(file, JSON.stringify({ token: this.token, baseUrl: this.baseUrl, accountId: this.accountId, savedAt: new Date().toISOString() }, null, 2), 0o600);
  }

  private restoreAccount(): boolean {
    // credentials.token 优先 (管理台手工配置), 否则读扫码落盘的凭据
    if (this.credentials.token) {
      this.token = this.credentials.token;
      this.accountId = this.credentials.accountId || "default";
      this.baseUrl = (this.credentials.baseUrl || ILINK_BASE_URL).replace(/\/$/, "");
      return true;
    }
    const file = join(
      getBotPaths().dotBot,
      "channels",
      "weixin",
      (this.credentials.accountId || "default").replace(/[^a-zA-Z0-9_-]/g, "_"),
      "account.json",
    );
    if (!existsSync(file)) return false;
    try {
      const data = JSON.parse(readFileSync(file, "utf8"));
      this.token = String(data.token ?? "");
      this.accountId = String(data.accountId ?? this.credentials.accountId ?? "default");
      this.baseUrl = String(data.baseUrl ?? ILINK_BASE_URL).replace(/\/$/, "");
      return Boolean(this.token);
    } catch {
      return false;
    }
  }

  // ── 生命周期 ──

  public async start(): Promise<void> {
    if (!this.restoreAccount()) {
      throw new Error(`channel '${this.id}' has no weixin credentials — call the QR login API first (POST /api/channels/${this.id}/qr-login)`);
    }
    this.restoreContextTokens();
    this.saveAccount(); // 凭据同步落 0600 文件 (SQLite 文件权限是 0644)
    this.pipeline = new InboundPipeline({
      channelId: this.id,
      dispatch: (msg) => ChannelManager.getInstance().dispatchAndReply(msg),
      startTyping: (peerId) => {
        const existing = this.typingPeers.get(peerId);
        if (existing) return existing;
        const stop = this.startTypingHeartbeat(peerId);
        this.typingPeers.set(peerId, stop);
        return () => {
          this.typingPeers.delete(peerId);
          stop();
        };
      },
    });
    this.running = true;
    this.stopController = new AbortController();
    this.pollLoop = this.pollLoopFn();
    logger.info("WeixinAdapter", `[${this.id}] iLink long-polling started (account=${this.maskId(this.accountId)})`);
  }

  public async stop(): Promise<void> {
    this.running = false;
    // 中断挂起中的长轮询/退避 (否则 stop 最长挂 10 分钟, 卡死 QR 热重启)
    this.stopController?.abort();
    await this.pipeline?.stop();
    for (const stop of this.typingPeers.values()) stop();
    this.typingPeers.clear();
    try {
      // 等待在途 sendmessage 排空 (防新旧 adapter 并发乱序)
      await this.sendGate;
    } catch {
      // 在途发送失败不影响停机
    }
    try {
      await this.pollLoop;
    } catch {
      // 轮询循环退出异常忽略
    }
    logger.info("WeixinAdapter", `[${this.id}] Stopped`);
  }

  /** stop 感知的分片 sleep (任意时刻可被 stop 中断) */
  private stopAwareSleep(totalMs: number): Promise<void> {
    return new Promise((resolve) => {
      let remaining = totalMs;
      const tick = () => {
        if (!this.running) return resolve();
        const slice = Math.min(500, remaining);
        remaining -= slice;
        if (remaining <= 0) return resolve();
        setTimeout(tick, slice).unref?.();
      };
      tick();
    });
  }

  /** stop 时触发中断的控制器 (长轮询 fetch 挂上去) */
  private stopController?: AbortController;

  // ── 出站 ──

  /** 主动发送: 用 tokenStore 里该 peer 的 context_token (陈旧时 tokenless 降级) */
  public async sendMessage(peerId: string, content: string): Promise<void> {
    await this.sendText(peerId, content, this.contextTokens.get(peerId));
  }

  /** 被动回复: 入站 context_token 先入库 (比存量新), 再走同一发送管线 */
  public async sendReply(peerId: string, content: string, replyContext: unknown): Promise<boolean> {
    const ctx = replyContext as { contextToken?: string } | undefined;
    if (ctx?.contextToken) this.contextTokens.set(peerId, ctx.contextToken);
    try {
      await this.sendText(peerId, content, this.contextTokens.get(peerId));
      return true;
    } catch (err) {
      logger.debug("WeixinAdapter", `[${this.id}] Reply failed (deliverOutbound will log): ${err}`);
      return false;
    }
  }

  /** typing 心跳 (需 getconfig 换 typing_ticket, 600s TTL) */
  private startTypingHeartbeat(peerId: string): () => void {
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      try {
        const ticket = await this.ensureTypingTicket(peerId);
        if (!ticket) return;
        await this.apiPost(
          EP_SEND_TYPING,
          { ilink_user_id: peerId, typing_ticket: ticket, status: TYPING_START },
          CONFIG_TIMEOUT_MS,
        );
      } catch {
        // typing 纯体验优化, 失败静默
      }
    };
    const timer = setInterval(() => void tick(), 30_000);
    timer.unref?.();
    void tick();
    return () => {
      stopped = true;
      clearInterval(timer);
      // 停止指示器 (失败忽略——回复落地后客户端自然消失)
      const ticket = this.typingTickets.get(peerId)?.ticket;
      if (ticket) {
        void this.apiPost(EP_SEND_TYPING, { ilink_user_id: peerId, typing_ticket: ticket, status: TYPING_STOP }, CONFIG_TIMEOUT_MS).catch(() => {});
      }
    };
  }

  // ── 发送管线 (串行 gate + 过期降级 + 限频退避, 对齐 hermes _send_text_chunk) ──

  private sendText(peerId: string, text: string, contextToken?: string): Promise<void> {
    // 串行化: 同一账号的 sendmessage 必须按序 (context_token 语义)
    const run = this.sendGate.then(() => this.sendTextChunk(peerId, text, contextToken));
    this.sendGate = run.catch(() => {});
    return run;
  }

  private async sendTextChunk(peerId: string, text: string, contextToken?: string): Promise<void> {
    if (!text.trim()) return;
    let token = contextToken;
    let retriedWithoutToken = false;
    let attempt = 0;
    const maxRetries = 4;

    while (true) {
      const clientId = `botagent-weixin-${randomUUID()}`;
      const message: Record<string, unknown> = {
        from_user_id: "",
        to_user_id: peerId,
        client_id: clientId,
        message_type: MSG_TYPE_BOT,
        message_state: MSG_STATE_FINISH,
        item_list: [{ type: ITEM_TEXT, text_item: { text } }],
        ...(token ? { context_token: token } : {}),
      };
      const resp = await this.apiPost(EP_SEND_MESSAGE, { msg: message }, API_TIMEOUT_MS);
      const ret = toInt(resp?.ret, 0);
      const errcode = toInt(resp?.errcode, 0);
      if (ret === 0 && errcode === 0) return;

      const errmsg = String(resp?.errmsg ?? resp?.msg ?? "unknown error");
      if (this.isSessionExpired(ret, errcode, errmsg)) {
        if (!retriedWithoutToken && token) {
          // iLink 接受 tokenless 发送 (降级通道): 丢掉过期 token 重发一次
          retriedWithoutToken = true;
          token = undefined;
          this.contextTokens.delete(peerId);
          this.persistContextTokens();
          logger.warn("WeixinAdapter", `[${this.id}] Session expired for ${this.maskId(peerId)}; retrying without context_token`);
          continue;
        }
        throw new Error(
          `iLink sendmessage session not ready (ret=${ret} errcode=${errcode}) — 用户需先给机器人发一条消息 (或重新扫码)`,
        );
      }
      if (ret !== RATE_LIMIT_ERRCODE && errcode !== RATE_LIMIT_ERRCODE) {
        throw new Error(`iLink sendmessage error: ret=${ret} errcode=${errcode} errmsg=${errmsg}`);
      }
      // -2 限频: 退避重试 (3x)
      if (attempt >= maxRetries) {
        throw new Error(`iLink sendmessage rate limited after ${attempt + 1} attempts: errmsg=${errmsg}`);
      }
      attempt++;
      const wait = 3_000 * attempt;
      logger.warn("WeixinAdapter", `[${this.id}] Rate limited, retry ${attempt}/${maxRetries} in ${wait}ms`);
      await this.stopAwareSleep(wait);
    }
  }

  private isSessionExpired(ret: number, errcode: number, errmsg: string): boolean {
    if (SESSION_EXPIRED_ERRCODE === ret || SESSION_EXPIRED_ERRCODE === errcode) return true;
    // 陈旧会话的 -2 变体 (errmsg 是 "unknown error"/"prepare failed"), 非真限频
    return (ret === RATE_LIMIT_ERRCODE || errcode === RATE_LIMIT_ERRCODE) &&
      ["unknown error", "prepare failed"].includes(errmsg.toLowerCase());
  }

  // ── 入站长轮询 ──

  private async pollLoopFn(): Promise<void> {
    let syncBuf = this.loadSyncBuf();
    let timeoutMs = LONG_POLL_TIMEOUT_MS;
    let failures = 0;

    while (this.running) {
      try {
        const resp = await this.apiPost(EP_GET_UPDATES, { get_updates_buf: syncBuf }, timeoutMs);
        const suggested = toInt(resp?.longpolling_timeout_ms, 0);
        if (suggested > 0) timeoutMs = suggested;
        const ret = toInt(resp?.ret, 0);
        const errcode = toInt(resp?.errcode, 0);
        if (ret !== 0 || errcode !== 0) {
          if (this.isSessionExpired(ret, errcode, String(resp?.errmsg ?? ""))) {
            logger.error("WeixinAdapter", `[${this.id}] Session expired; token 无效——请重新扫码登录 (分片等待, 可被 stop 中断)`);
            await this.stopAwareSleep(600_000);
            failures = 0;
            continue;
          }
          failures++;
          logger.warn("WeixinAdapter", `[${this.id}] getupdates failed ret=${ret} errcode=${errcode} (${failures}/${MAX_CONSECUTIVE_FAILURES})`);
          await this.stopAwareSleep(failures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS);
          continue;
        }
        failures = 0;
        // 等待本批消息的媒体下载/入队完成再推进游标。取舍说明 (与 scheduler
        // 的 at-most-once 同款): agent 调用在防抖定时器中异步执行, await 只覆盖
        // 到入队为止——进程在防抖触发前崩溃时, 已落盘游标不会重投这批消息。
        // at-least-once 需要持久化派发确认, 全链路成本高; 此窗口为有意取舍。
        await Promise.allSettled(((resp?.msgs as any[]) ?? []).map((m) => this.processMessage(m)));
        const nextBuf = resp?.get_updates_buf;
        if (typeof nextBuf === "string" && nextBuf && nextBuf !== syncBuf) {
          syncBuf = nextBuf;
          this.saveSyncBuf(syncBuf);
        }
      } catch (err) {
        failures++;
        logger.warn("WeixinAdapter", `[${this.id}] Poll error (${failures}/${MAX_CONSECUTIVE_FAILURES}): ${err}`);
        await this.stopAwareSleep(failures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS);
      }
    }
  }

  private async processMessage(message: any): Promise<void> {
    try {
      const senderId = String(message?.from_user_id ?? "").trim();
      const messageId = String(message?.message_id ?? "").trim();
      if (!senderId || senderId === this.accountId) return;
      if (this.isDuplicate(messageId)) return;

      const items = (message?.item_list as any[]) ?? [];
      const text = this.extractText(items);
      // 注: 不做内容指纹去重——同文本的合法重发 ("继续"/"1" 等确认) 会被误杀;
      // 上游换 message_id 重发属罕见场景, 交给 loop-guard 熔断兜底

      const contextToken = String(message?.context_token ?? "").trim();
      if (contextToken) {
        this.contextTokens.set(senderId, contextToken);
        this.persistContextTokens();
      }

      const attachments = await this.collectMedia(items);
      if (!text && attachments.length === 0) return;

      const inbound: InboundMessage = {
        channelInstanceId: this.id,
        peerId: senderId,
        senderName: senderId,
        content: text,
        messageId: messageId || undefined,
        conversationType: "direct",
        replyContext: { contextToken: contextToken || undefined },
        ...(attachments.length > 0 ? { attachments } : {}),
        raw: message,
      };
      await this.pipeline?.submit(inbound);
    } catch (err) {
      logger.error("WeixinAdapter", `[${this.id}] Inbound processing error:`, err);
    }
  }

  /** 抽取文本 (含引用消息标注, 对齐 hermes _extract_text 简化版) */
  private extractText(items: any[]): string {
    for (const item of items) {
      if (item?.type === ITEM_TEXT) {
        const text = String(item?.text_item?.text ?? "");
        const ref = item?.ref_msg ?? {};
        const refItem = ref?.message_item ?? {};
        if (refItem.type && refItem.type !== ITEM_TEXT) {
          const title = String(ref?.title ?? "");
          return title ? `[引用: ${title}]\n${text}` : `[引用]\n${text}`;
        }
        return text;
      }
    }
    return "";
  }

  /** 入站媒体: CDN 下载 + AES-128-ECB 解密 → 落媒体缓存 (每消息上限 4, 防媒体洪水) */
  private async collectMedia(items: any[]): Promise<MediaAttachment[]> {
    const out: MediaAttachment[] = [];
    for (const item of items.slice(0, 4)) {
      const spec: Array<{ type: number; key: string; kind: MediaAttachment["kind"] }> = [
        { type: ITEM_IMAGE, key: "image_item", kind: "image" },
        { type: ITEM_VIDEO, key: "video_item", kind: "video" },
        { type: ITEM_VOICE, key: "voice_item", kind: "audio" },
        { type: ITEM_FILE, key: "file_item", kind: "file" },
      ];
      for (const s of spec) {
        if (item?.type !== s.type) continue;
        try {
          const payload = item[s.key] ?? {};
          const media = payload.media ?? {};
          // image_item 可能把原始 hex aeskey 放在 payload.aeskey 而非 media.aes_key
          const aesKeyB64 = media?.aes_key ?? (payload.aeskey ? Buffer.from(String(payload.aeskey), "hex").toString("base64") : undefined);
          const stored = await this.downloadMediaItem(media, aesKeyB64, payload.file_name);
          const filename = String(payload.file_name ?? "media.bin");
          out.push({ kind: s.kind, ...stored, filename });
        } catch (err) {
          logger.warn("WeixinAdapter", `[${this.id}] Media download failed: ${err}`);
        }
      }
    }
    return out;
  }

  private async downloadMediaItem(
    media: any,
    aesKeyB64: string | undefined,
    filename?: string,
  ): Promise<{ localPath: string; sizeBytes: number }> {
    const encryptQueryParam = media?.encrypt_query_param;
    const fullUrl = media?.full_url;
    let url: string;
    if (encryptQueryParam) {
      url = `${WEIXIN_CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(encryptQueryParam)}`;
    } else if (fullUrl) {
      // CDN 白名单防 SSRF (对齐 hermes _assert_weixin_cdn_url)
      const host = new URL(fullUrl).hostname;
      if (!["novac2c.cdn.weixin.qq.com", "ilinkai.weixin.qq.com", "long.open.weixin.qq.com"].includes(host)) {
        throw new Error(`media URL host ${host} not in weixin CDN allowlist`);
      }
      url = fullUrl;
    } else {
      throw new Error("media item has neither encrypt_query_param nor full_url");
    }
    // 流式落盘 (解密在管道中完成, 零内存累积; 建连+传输全程占并发信号量,
    // 超时/stop 同时覆盖建连与传输)
    return withDownloadSlot(async () => {
      const stream = await this.openCdnStream(url);
      return storeMediaStream(this.id, stream, {
        filename,
        aesKeyB64,
        signal: AbortSignal.any([
          AbortSignal.timeout(60_000),
          ...(this.stopController ? [this.stopController.signal] : []),
        ]),
      });
    });
  }

  private async openCdnStream(url: string): Promise<ReadableStream<Uint8Array>> {
    // 建连阶段就要带超时/停机信号 (60s 计时从 fetch 开始, 不能等拿到 body)
    const signal = AbortSignal.any([
      AbortSignal.timeout(60_000),
      ...(this.stopController ? [this.stopController.signal] : []),
    ]);
    const res = await safeFetch(url, { signal });
    if (!res.ok) throw new Error(`CDN download HTTP ${res.status}`);
    if (!res.body) throw new Error("CDN response has no body");
    return res.body;
  }

  // ── typing ticket ──

  private async ensureTypingTicket(peerId: string): Promise<string | undefined> {
    const cached = this.typingTickets.get(peerId);
    if (cached && Date.now() - cached.at < TYPING_TICKET_TTL_MS) return cached.ticket;
    try {
      const resp = await this.apiPost(
        EP_GET_CONFIG,
        { ilink_user_id: peerId, ...(this.contextTokens.get(peerId) ? { context_token: this.contextTokens.get(peerId) } : {}) },
        CONFIG_TIMEOUT_MS,
      );
      const ticket = String(resp?.typing_ticket ?? "");
      if (ticket) {
        this.typingTickets.set(peerId, { ticket, at: Date.now() });
        return ticket;
      }
    } catch {
      // getConfig 失败: typing 缺席即可
    }
    return undefined;
  }

  // ── 去重 ──

  private isDuplicate(key: string): boolean {
    const now = Date.now();
    if (now - this.lastSweepAt > 60_000) {
      this.lastSweepAt = now;
      this.seen.clear(); // 简化: message_id 去重窗口按分钟滚动 (上游重发窗口远小于此)
    }
    if (this.seen.has(key)) return true;
    this.seen.add(key);
    return false;
  }

  // ── iLink HTTP ──

  private async apiPost(endpoint: string, payload: Record<string, unknown>, timeoutMs: number): Promise<any> {
    const body = JSON.stringify({ ...payload, base_info: { channel_version: "2.2.0" } });
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      AuthorizationType: "ilink_bot_token",
      "iLink-App-Id": ILINK_APP_ID,
      "iLink-App-ClientVersion": String(ILINK_APP_CLIENT_VERSION),
      "X-WECHAT-UIN": randomBytes(4).toString("base64"),
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // stop() 立即中断在途长轮询
    const onAbort = () => controller.abort();
    this.stopController?.signal.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await fetch(`${this.baseUrl}/${endpoint}`, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`iLink ${endpoint} HTTP ${res.status}: ${text.slice(0, 200)}`);
      return JSON.parse(text);
    } finally {
      clearTimeout(timer);
      this.stopController?.signal.removeEventListener("abort", onAbort);
    }
  }

  // ── 磁盘状态 ──

  private contextTokensFile(): string {
    return join(this.accountDir(), "context-tokens.json");
  }

  private restoreContextTokens(): void {
    const file = this.contextTokensFile();
    if (!existsSync(file)) return;
    try {
      const data = JSON.parse(readFileSync(file, "utf8"));
      for (const [peer, token] of Object.entries(data)) {
        if (typeof token === "string" && token) this.contextTokens.set(peer, token);
      }
    } catch (err) {
      logger.warn("WeixinAdapter", `[${this.id}] Context tokens restore failed: ${err}`);
    }
  }

  private persistContextTokens(): void {
    try {
      mkdirSync(this.accountDir(), { recursive: true });
      atomicWrite(this.contextTokensFile(), JSON.stringify(Object.fromEntries(this.contextTokens), null, 2), 0o600);
    } catch (err) {
      logger.warn("WeixinAdapter", `[${this.id}] Context tokens persist failed: ${err}`);
    }
  }

  private syncBufFile(): string {
    return join(this.accountDir(), "sync.json");
  }

  private loadSyncBuf(): string {
    try {
      if (!existsSync(this.syncBufFile())) return "";
      const data = JSON.parse(readFileSync(this.syncBufFile(), "utf8"));
      return String(data.get_updates_buf ?? "");
    } catch {
      return "";
    }
  }

  private saveSyncBuf(buf: string): void {
    try {
      mkdirSync(this.accountDir(), { recursive: true });
      atomicWrite(this.syncBufFile(), JSON.stringify({ get_updates_buf: buf }), 0o600);
    } catch (err) {
      logger.warn("WeixinAdapter", `[${this.id}] Sync buf persist failed: ${err}`);
    }
  }

  private maskId(id: string): string {
    return id ? `${id.slice(0, 6)}…` : "?";
  }
}

// ── 模块级工具 ──

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 原子写: 随机 tmp + rename (写一半崩溃不留半截文件; 随机名防并发交叉写) */
function atomicWrite(file: string, content: string, mode: number): void {
  const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(tmp, content, { mode });
  renameSync(tmp, file);
}

/** 流式带上限下载: 超 MEDIA_MAX_BYTES 立即中止 (对齐设计"流式下载"约束) */
async function downloadCapped(url: string): Promise<Buffer> {
  const res = await safeFetch(url);
  if (!res.ok) throw new Error(`CDN download HTTP ${res.status}`);
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MEDIA_MAX_BYTES) {
      void reader.cancel();
      throw new Error(`media exceeds ${MEDIA_MAX_BYTES} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function toInt(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/** iLink aes_key 两种形态: base64(16 字节原始 key) 或 base64(hex 字符串) */
function parseAesKey(aesKeyB64: string): Buffer {
  const decoded = Buffer.from(aesKeyB64, "base64");
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32) {
    const text = decoded.toString("ascii");
    if (/^[0-9a-fA-F]{32}$/.test(text)) return Buffer.from(text, "hex");
  }
  throw new Error(`unexpected aes_key format (${decoded.length} bytes)`);
}

function decryptAes128Ecb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function encryptAes128Ecb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

// ── QR 扫码登录 (管理台渠道卡片驱动, 设计 §5) ──

/**
 * 发起扫码登录: 返回二维码 (管理台展示 qrcodeImgContent 为可扫的 liteapp 链接)。
 * 后续前端轮询 pollQrStatus 直到 confirmed (凭据经 extractQrCredentials 落盘) 或 expired。
 */
export async function startQrLogin(baseUrl = ILINK_BASE_URL): Promise<{ qrcode: string; qrcodeImgContent: string }> {
  const res = await fetch(`${baseUrl}/${EP_GET_BOT_QR}?bot_type=3`, {
    headers: { "iLink-App-Id": ILINK_APP_ID, "iLink-App-ClientVersion": String(ILINK_APP_CLIENT_VERSION) },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`get_bot_qrcode HTTP ${res.status}`);
  const data = (await res.json()) as { qrcode?: string; qrcode_img_content?: string };
  if (!data?.qrcode) throw new Error("QR response missing qrcode");
  return { qrcode: String(data.qrcode), qrcodeImgContent: String(data.qrcode_img_content ?? "") };
}

/** 轮询扫码状态 (status: wait/scaned/scaned_but_redirect/expired/confirmed), 返回平台原始响应 */
export async function pollQrStatus(
  qrcode: string,
  baseUrl = ILINK_BASE_URL,
  redirectHost?: string,
): Promise<Record<string, unknown>> {
  // scaned_but_redirect 事件携带 redirect_host: 后续轮询必须切换到新 host。
  // redirectHost 进入 fetch URL 前必须过域名白名单 (它可能来自客户端查询参数,
  // 不校验就是内网探测原语——绕过 safeFetch 防线)
  if (redirectHost && !/^([a-z0-9-]+\.)+(weixin\.qq\.com|qq\.com)$/i.test(redirectHost)) {
    throw new Error(`untrusted QR redirect host: ${redirectHost.slice(0, 64)}`);
  }
  const effectiveBase = redirectHost ? `https://${redirectHost}` : baseUrl;
  const res = await fetch(`${effectiveBase}/${EP_GET_QR_STATUS}?qrcode=${encodeURIComponent(qrcode)}`, {
    headers: { "iLink-App-Id": ILINK_APP_ID, "iLink-App-ClientVersion": String(ILINK_APP_CLIENT_VERSION) },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`get_qrcode_status HTTP ${res.status}`);
  const data = (await res.json()) as Record<string, unknown>;
  if (!data.status) data.status = "wait";
  return data;
}

/** 删除渠道时清理持久化状态 (防同 accountId 重建渠道时旧 token 复活) */
export function clearWeixinPersistedState(accountId?: string): void {
  const id = accountId || "default";
  const dir = join(getBotPaths().dotBot, "channels", "weixin", id.replace(/[^a-zA-Z0-9_-]/g, "_"));
  rmSync(dir, { recursive: true, force: true });
  logger.info("WeixinAdapter", `Cleared persisted state for account ${id.slice(0, 6)}…`);
}

/** 扫码确认后提取凭据 (server.ts 在 status=confirmed 时调用并落盘) */
export function extractQrCredentials(statusResp: Record<string, unknown>): { accountId: string; token: string; baseUrl: string; userId: string } {
  const accountId = String(statusResp.ilink_bot_id ?? "");
  const token = String(statusResp.bot_token ?? "");
  if (!accountId || !token) throw new Error("QR confirmed but credential payload incomplete");
  return {
    accountId,
    token,
    baseUrl: String(statusResp.baseurl ?? ILINK_BASE_URL),
    userId: String(statusResp.ilink_user_id ?? ""),
  };
}
