import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { logger } from "../../utils/logger.ts";
import { DatabaseManager } from "../../database/index.ts";
import type { ChannelAdapter, InboundMessage, MediaAttachment, OutboundMedia } from "../base.ts";
import type { ChannelAdapterDeps } from "../descriptor.ts";
import { createChannelInboundPipeline, createTypingController } from "../runtime/dispatch.ts";
import { storeMediaStream, withDownloadSlot } from "../runtime/media-cache.ts";
import { uploadWeixinMedia } from "./weixin-media.ts";
import {
  WX_ITEM_FILE as ITEM_FILE,
  WX_ITEM_IMAGE as ITEM_IMAGE,
  WX_ITEM_TEXT as ITEM_TEXT,
  WX_ITEM_VIDEO as ITEM_VIDEO,
  WX_ITEM_VOICE as ITEM_VOICE,
  describeReference,
  formatWeixinCopyFriendly,
  referencedMediaItems,
  voiceTranscript,
} from "./weixin-protocol.ts";
import { safeFetch } from "../../utils/net-guard.ts";

export interface WeixinCredentials {
  /** iLink bot id (扫码确认后返回 ilink_bot_id); 缺省 "default" */
  accountId?: string;
  /** bot_token (扫码获得; 也可落盘凭据文件持久化) */
  token?: string;
  baseUrl?: string;
  /** 媒体 CDN base（默认官方 CDN；私有化/测试可覆盖） */
  cdnBaseUrl?: string;
  dmPolicy?: string;
  allowFrom?: string[];
  groupPolicy?: string;
  groupAllowFrom?: string[];
}

// ── iLink 协议常量 (对齐 hermes weixin.py, 接口无 SLA, 演进集中在这一层) ──

export const ILINK_BASE_URL = "https://ilinkai.weixin.qq.com";
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
  private deps: ChannelAdapterDeps;
  private pipeline?: ReturnType<typeof createChannelInboundPipeline>;
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
  private lastInboundAt?: number;
  private lastSendAt?: number;
  private lastPollOkAt?: number;
  private startedAt = 0;
  private sessionExpired = false;
  /** 已启用但尚未扫码：保持实例可管理，前端可直接拉起二维码 */
  private pendingAuth = false;
  /** 限频熔断：窗口内 -2 事件达到阈值后暂停发送，避免持续撞平台风控 */
  private rateLimitEvents: number[] = [];
  private rateLimitUntil = 0;

  constructor(
    id: string,
    name: string,
    credentials: WeixinCredentials,
    deps: ChannelAdapterDeps,
  ) {
    this.id = id;
    this.name = name;
    this.credentials = credentials;
    this.deps = deps;
  }

  // ── 持久化 ──

  private dotBotDir(): string {
    // 默认与业务库同目录（生产即 <cwd>/.bot）；测试注入 deps.dotBotDir 隔离
    return this.deps.dotBotDir ?? dirname(DatabaseManager.getInstance().dbPath);
  }

  private accountDir(): string {
    return join(this.dotBotDir(), "channels", "weixin", this.accountId.replace(/[^a-zA-Z0-9_-]/g, "_"));
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
      this.dotBotDir(),
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
      // 未扫码不是配置错误：渠道保持已启用，前端可立即拉起扫码；扫码确认后
      // ChannelManager 会用新凭据热重启本渠道。健康检查会明确报「待扫码」。
      this.pendingAuth = true;
      logger.info(
        "WeixinAdapter",
        `[${this.id}] Waiting for QR login (no credentials yet); use ${this.id} scan action in the admin UI`,
      );
      return;
    }
    this.pendingAuth = false;
    this.restoreContextTokens();
    this.saveAccount(); // 凭据同步落 0600 文件 (SQLite 文件权限是 0644)
    this.pipeline = createChannelInboundPipeline({
      channelId: this.id,
      runtime: this.deps.runtime,
      startTyping: createTypingController(
        (peerId) => this.sendTyping(peerId),
        this.deps.tuning?.typingIntervalMs ?? 30_000,
        (peerId) => this.stopTyping(peerId),
      ),
    });
    this.running = true;
    this.startedAt = Date.now();
    const groupPolicy = String(this.credentials.groupPolicy ?? "").trim();
    if (groupPolicy && groupPolicy !== "disabled") {
      logger.warn(
        "WeixinAdapter",
        `[${this.id}] groupPolicy is enabled, but QR-login iLink bot identities usually cannot receive ordinary group events; group messages may never arrive (iLink-side limitation)`,
      );
    }
    this.stopController = new AbortController();
    this.pollLoop = this.pollLoopFn();
    logger.info("WeixinAdapter", `[${this.id}] iLink long-polling started (account=${this.maskId(this.accountId)})`);
  }

  public async stop(): Promise<void> {
    this.running = false;
    // 中断挂起中的长轮询/退避 (否则 stop 最长挂 10 分钟, 卡死 QR 热重启)
    this.stopController?.abort();
    await this.pipeline?.stop();
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

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private rateLimitCircuitOpen(): boolean {
    return this.now() < this.rateLimitUntil;
  }

  /** 记录 -2 限频事件；窗口内达到阈值则打开熔断（返回 true = 已打开） */
  private recordRateLimitEvent(): boolean {
    const now = this.now();
    const windowMs = this.deps.tuning?.rateLimitWindowMs ?? 30_000;
    const openMs = this.deps.tuning?.rateLimitOpenMs ?? 30_000;
    const threshold = this.deps.tuning?.rateLimitThreshold ?? 2;
    this.rateLimitEvents = this.rateLimitEvents.filter((t) => now - t < windowMs);
    this.rateLimitEvents.push(now);
    if (this.rateLimitEvents.length >= threshold) {
      this.rateLimitUntil = now + openMs;
      logger.warn("WeixinAdapter", `[${this.id}] Rate-limit circuit opened for ${openMs}ms`);
      return true;
    }
    return false;
  }

  private clearRateLimitCircuit(): void {
    this.rateLimitEvents = [];
    this.rateLimitUntil = 0;
  }

  /** 健康检查：进程在跑 + token 存在 + 最近长轮询成功未超时（不做额外网络调用） */
  public async healthCheck(): Promise<{
    ok: boolean;
    detail?: string;
    lastInboundAt?: number;
    lastSendAt?: number;
  }> {
    if (this.pendingAuth) {
      return {
        ok: false,
        detail: "not authenticated — 请点击「微信扫码登录」完成扫码",
        lastInboundAt: this.lastInboundAt,
        lastSendAt: this.lastSendAt,
      };
    }
    const lastOk = this.lastPollOkAt ?? this.startedAt;
    const fresh = this.running && this.token.length > 0 && this.now() - lastOk < 90_000;
    const circuit = this.rateLimitCircuitOpen()
      ? ` · rate-limit circuit open (${Math.ceil((this.rateLimitUntil - this.now()) / 1000)}s)`
      : "";
    return {
      ok: fresh,
      detail: fresh
        ? `long-poll ok (account=${this.maskId(this.accountId)})${circuit}`
        : !this.running
          ? "stopped"
          : this.sessionExpired || !this.token
            ? "session expired — 请重新扫码登录"
            : `long-poll stale (${Math.round((this.now() - lastOk) / 1000)}s)${circuit}`,
      lastInboundAt: this.lastInboundAt,
      lastSendAt: this.lastSendAt,
    };
  }

  // ── 出站 ──

  /** 出站文本排版：微信以纯文本阅读为主，先做 copy-friendly 归一化再走通用降级 */
  public formatOutbound(content: string): string {
    return formatWeixinCopyFriendly(content);
  }

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

  /** 出站媒体：getuploadurl → AES-128-ECB → CDN → sendmessage item_list */
  public async sendMedia(
    peerId: string,
    media: OutboundMedia,
    replyContext?: unknown,
  ): Promise<boolean> {
    if (this.pendingAuth) {
      logger.warn("WeixinAdapter", `[${this.id}] sendMedia skipped: waiting for QR login`);
      return false;
    }
    const ctx = replyContext as { contextToken?: string } | undefined;
    if (ctx?.contextToken) this.contextTokens.set(peerId, ctx.contextToken);
    // 上传 + 发送整体进入 sendGate：stop() 等待 gate 即覆盖在途上传，
    // 不会出现 stop 返回后旧 adapter 仍把文件发出去。
    const run = this.sendGate.then(async () => {
      if (!this.running || this.pendingAuth) {
        throw new Error("adapter stopped while preparing media");
      }
      const item = await uploadWeixinMedia(
        {
          cdnBaseUrl: String(this.credentials.cdnBaseUrl || WEIXIN_CDN_BASE_URL),
          apiPost: (endpoint, payload, timeoutMs) => this.apiPost(endpoint, payload, timeoutMs),
          fetchImpl: this.deps.mediaFetch ?? safeFetch,
          signal: this.stopController?.signal,
        },
        media,
        peerId,
      );
      if (!this.running || this.pendingAuth) {
        throw new Error("adapter stopped during media upload");
      }
      await this.sendItems(peerId, [item], this.contextTokens.get(peerId));
    });
    this.sendGate = run.catch(() => {});
    try {
      await run;
      return true;
    } catch (err) {
      logger.warn("WeixinAdapter", `[${this.id}] sendMedia failed: ${err}`);
      return false;
    }
  }

  /** typing 单次心跳 (需 getconfig 换 typing_ticket, 600s TTL)；由管道统一调度 */
  private async sendTyping(peerId: string): Promise<void> {
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
  }

  /** typing 结束指示器 (失败忽略——回复落地后客户端自然消失) */
  private async stopTyping(peerId: string): Promise<void> {
    const ticket = this.typingTickets.get(peerId)?.ticket;
    if (!ticket) return;
    await this.apiPost(
      EP_SEND_TYPING,
      { ilink_user_id: peerId, typing_ticket: ticket, status: TYPING_STOP },
      CONFIG_TIMEOUT_MS,
    ).catch(() => {});
  }

  // ── 发送管线 (串行 gate + 过期降级 + 限频退避, 对齐 hermes _send_text_chunk) ──

  private sendText(peerId: string, text: string, contextToken?: string): Promise<void> {
    if (!text.trim()) return Promise.resolve();
    if (this.pendingAuth) {
      return Promise.reject(new Error("weixin channel is not authenticated; complete QR login first"));
    }
    // 串行化: 同一账号的 sendmessage 必须按序 (context_token 语义)
    const run = this.sendGate.then(() => this.sendItems(peerId, [{ type: ITEM_TEXT, text_item: { text } }], contextToken));
    this.sendGate = run.catch(() => {});
    return run;
  }

  private async sendItems(
    peerId: string,
    itemList: Record<string, unknown>[],
    contextToken?: string,
  ): Promise<void> {
    let token = contextToken;
    let retriedWithoutToken = false;
    let attempt = 0;
    const maxRetries = 4;
    if (this.rateLimitCircuitOpen()) {
      throw new Error(
        `iLink sendmessage paused by rate-limit circuit (${Math.ceil((this.rateLimitUntil - this.now()) / 1000)}s remaining)`,
      );
    }

    while (true) {
      const clientId = `botagent-weixin-${randomUUID()}`;
      const message: Record<string, unknown> = {
        from_user_id: "",
        to_user_id: peerId,
        client_id: clientId,
        message_type: MSG_TYPE_BOT,
        message_state: MSG_STATE_FINISH,
        item_list: itemList,
        ...(token ? { context_token: token } : {}),
      };
      const resp = await this.apiPost(EP_SEND_MESSAGE, { msg: message }, API_TIMEOUT_MS);
      const ret = toInt(resp?.ret, 0);
      const errcode = toInt(resp?.errcode, 0);
      if (ret === 0 && errcode === 0) {
        this.lastSendAt = Date.now();
        this.sessionExpired = false;
        this.clearRateLimitCircuit();
        return;
      }

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
      if (this.recordRateLimitEvent()) {
        throw new Error(`iLink rate limit circuit opened after repeated -2 responses: ${errmsg}`);
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
            this.sessionExpired = true;
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
        this.lastPollOkAt = Date.now();
        this.sessionExpired = false;
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

      // 群聊识别 (对齐 hermes _guess_chat_type): 有 room_id/chat_room_id，
      // 或 to_user_id 不是本 bot 且 msg_type=1。iLink bot 通常收不到普通群事件，
      // 这里只做语义归位与策略判定，不承诺平台投递。
      const roomId = String(message?.room_id ?? message?.chat_room_id ?? "").trim();
      const toUserId = String(message?.to_user_id ?? "").trim();
      const isGroup =
        Boolean(roomId) ||
        Boolean(toUserId && toUserId !== this.accountId && Number(message?.msg_type) === 1);
      const peerId = isGroup ? roomId || toUserId || senderId : senderId;

      const items = (message?.item_list as any[]) ?? [];
      const text = this.extractText(items);
      // 注: 不做内容指纹去重——同文本的合法重发 ("继续"/"1" 等确认) 会被误杀;
      // 上游换 message_id 重发属罕见场景, 交给 loop-guard 熔断兜底

      const contextToken = String(message?.context_token ?? "").trim();
      if (contextToken) {
        this.contextTokens.set(peerId, contextToken);
        this.persistContextTokens();
      }

      const attachmentsResult = await this.collectMedia(items);
      const content = [text, ...attachmentsResult.transcripts].filter(Boolean).join("\n\n");
      if (!content && attachmentsResult.attachments.length === 0) return;

      const inbound: InboundMessage = {
        channelInstanceId: this.id,
        peerId,
        senderName: senderId,
        senderId,
        content,
        messageId: messageId || undefined,
        receivedAt: Date.now(),
        conversationType: isGroup ? "group" : "direct",
        replyContext: { contextToken: contextToken || undefined },
        ...(attachmentsResult.attachments.length > 0 ? { attachments: attachmentsResult.attachments } : {}),
        raw: message,
      };
      this.lastInboundAt = inbound.receivedAt;
      await this.pipeline?.submit(inbound);
    } catch (err) {
      logger.error("WeixinAdapter", `[${this.id}] Inbound processing error:`, err);
    }
  }

  /** 抽取文本（含引用标注：文本引用、媒体引用分别标注） */
  private extractText(items: any[]): string {
    for (const item of items) {
      if (item?.type === ITEM_TEXT) {
        const text = String(item?.text_item?.text ?? "");
        const refLabel = describeReference(item?.ref_msg);
        return refLabel ? `${refLabel}\n${text}` : text;
      }
    }
    return "";
  }

  /**
   * 入站媒体（含引用消息内的媒体）：CDN 下载 + AES-128-ECB 解密 → 媒体缓存。
   * 语音：平台转写文本保留在正文；原始音频仍下载（每消息总上限 4）。
   */
  private async collectMedia(items: any[]): Promise<{
    attachments: MediaAttachment[];
    transcripts: string[];
  }> {
    const out: MediaAttachment[] = [];
    const transcripts: string[] = [];
    const candidates: Array<{ item: any; title?: string }> = items.map((item) => ({ item }));
    for (const ref of referencedMediaItems(items)) candidates.push({ item: ref.item, title: ref.title });

    const seen = new Set<string>();
    for (const { item, title } of candidates) {
      if (out.length >= 4) break;
      const spec: Array<{ type: number; key: string; kind: MediaAttachment["kind"] }> = [
        { type: ITEM_IMAGE, key: "image_item", kind: "image" },
        { type: ITEM_VIDEO, key: "video_item", kind: "video" },
        { type: ITEM_VOICE, key: "voice_item", kind: "audio" },
        { type: ITEM_FILE, key: "file_item", kind: "file" },
      ];
      for (const s of spec) {
        if (item?.type !== s.type) continue;
        const transcript = voiceTranscript(item);
        if (transcript) transcripts.push(`[语音转写] ${transcript}`);
        try {
          const payload = item[s.key] ?? {};
          const media = payload.media ?? {};
          const dedupeKey = String(media?.encrypt_query_param ?? media?.full_url ?? "");
          if (dedupeKey && seen.has(dedupeKey)) continue;
          if (dedupeKey) seen.add(dedupeKey);
          // image_item 可能把原始 hex aeskey 放在 payload.aeskey 而非 media.aes_key
          const aesKeyB64 =
            media?.aes_key ??
            (payload.aeskey ? Buffer.from(String(payload.aeskey), "hex").toString("base64") : undefined);
          const stored = await this.downloadMediaItem(media, aesKeyB64, payload.file_name);
          const filename = String(payload.file_name ?? title ?? "media.bin");
          out.push({ kind: s.kind, ...stored, filename });
        } catch (err) {
          logger.warn("WeixinAdapter", `[${this.id}] Media download failed: ${err}`);
        }
      }
    }
    return { attachments: out, transcripts };
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
    if (this.stopController?.signal.aborted) {
      throw new Error("adapter stopped");
    }
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

/** 原子写: 随机 tmp + rename (写一半崩溃不留半截文件; 随机名防并发交叉写) */
function atomicWrite(file: string, content: string, mode: number): void {
  const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(tmp, content, { mode });
  renameSync(tmp, file);
}

function toInt(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
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
export function clearWeixinPersistedState(accountId?: string, dataDir?: string): void {
  const id = accountId || "default";
  const base = dataDir ?? dirname(DatabaseManager.getInstance().dbPath);
  const dir = join(base, "channels", "weixin", id.replace(/[^a-zA-Z0-9_-]/g, "_"));
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
