import { logger } from "../../utils/logger.ts";
import type { ChannelAdapter, InboundMessage, MediaAttachment } from "../base.ts";
import { InboundPipeline } from "../runtime/dispatch.ts";
import { ChannelManager } from "../manager.ts";
import { safeFetch } from "../../utils/net-guard.ts";
import { storeMediaStream, withDownloadSlot } from "../runtime/media-cache.ts";
import { startTypingHeartbeat } from "../runtime/typing.ts";

export interface QQCredentials {
  appId?: string;
  clientSecret?: string;
  /** 沙箱环境 (api.sandbox 前缀, 沙箱频道/测试机器人) */
  sandbox?: boolean;
}

// ── 平台常量 (对齐 hermes qqbot/constants.py) ──

const API_BASE = "https://api.sgroup.qq.com";
const SANDBOX_API_BASE = "https://sandbox.api.sgroup.qq.com";
const TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";
/** C2C + 群 @ 消息 intent (官方 Bot API v2) */
const INTENT_C2C_GROUP_AT_MESSAGES = 1 << 25;
const RECONNECT_BACKOFF_MS = [2_000, 5_000, 10_000, 30_000, 60_000];
const MAX_RECONNECT_ATTEMPTS = 100;
/** QQ 单条消息 4000 字符上限 (字节口径略保守) */
const MAX_MESSAGE_BYTES = 4_000;
/** REST 超时 (平台挂起时 sendMessage 不允许永久 pending) */
const REST_TIMEOUT_MS = 15_000;

/**
 * 致命 close code (对齐 hermes qqbot 语义): 不再重连, 需人工处理。
 * 其余 close code 一律重连——4004 先刷 token, 4006/4007/4009 清 session
 * 后重新 Identify; 心跳超时/无效 seq 都是可恢复故障, 列致命会让渠道
 * 在一次网络抖动后永久静默。
 */
const FATAL_CLOSE_CODES: Record<number, string> = {
  4001: "invalid opcode",
  4002: "invalid payload",
  4010: "invalid shard",
  4011: "sharding required",
  4012: "invalid API version",
  4013: "invalid intent",
  4014: "intent 未授权 (平台未开通对应能力)",
  4914: "已下线/仅沙箱可用",
  4915: "已封禁",
};
/** 需要清 session 重新 Identify 的 close code (4009 心跳超时可 Resume, 不在此列) */
const SESSION_INVALID_CLOSE_CODES = new Set([4006, 4007]);

type WsPayload = { op: number; s?: number; t?: string; d?: any };

/**
 * QQ 官方 Bot API v2 渠道 (M2, 设计 §4.2)——自实现薄 WS 客户端:
 * token (bots.qq.com) → gateway (api.sgroup.qq.com/gateway) → WS
 * (Hello op10 → Identify op2 / Resume op6, 心跳 op1 @ 80% interval)。
 * 出站 REST: /v2/users|groups/{id}/messages; 被动回复带 msg_id+msg_seq
 * (单聊 60min / 群 5min 窗口, 超窗 sendReply 返回 false → 网关回退主动
 * 发送——主动消息有每月配额, 通知类投递见管理台审计)。
 * 协议语义移植自 hermes qqbot/adapter.py (生产验证), 零外部依赖。
 */
export class QQChannelAdapter implements ChannelAdapter {
  readonly type = "qq" as const;
  readonly id: string;
  readonly name: string;
  maxMessageBytes = MAX_MESSAGE_BYTES;
  markdownMode = "plain" as const;

  private credentials: QQCredentials;
  private pipeline?: InboundPipeline;

  // 连接状态
  private ws?: WebSocket;
  private running = false;
  private sessionId?: string;
  private lastSeq?: number;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private reconnecting = false;

  // token (单飞刷新)
  private token?: string;
  private tokenExpiresAt = 0;
  private tokenPromise?: Promise<string>;

  // 被动回复: msg_id → 已用 seq (同 msg_id 的多次回复 seq 递增)
  private msgSeqCounters = new Map<string, number>();
  private typingPeers = new Map<string, () => void>();

  constructor(id: string, name: string, credentials: QQCredentials) {
    this.id = id;
    this.name = name;
    this.credentials = credentials;
  }

  public async start(): Promise<void> {
    if (!this.credentials.appId || !this.credentials.clientSecret) {
      throw new Error(`channel '${this.id}' is missing credentials.appId/clientSecret`);
    }
    this.pipeline = new InboundPipeline({
      channelId: this.id,
      dispatch: (msg) => ChannelManager.getInstance().dispatchAndReply(msg),
      startTyping: (peerId) => {
        const existing = this.typingPeers.get(peerId);
        if (existing) return existing;
        const stop = startTypingHeartbeat(() => this.sendTypingIndicator(peerId), 30_000);
        this.typingPeers.set(peerId, stop);
        return () => {
          this.typingPeers.delete(peerId);
          stop();
        };
      },
    });
    this.running = true;
    await this.connectGateway();
    logger.info("QQAdapter", `[${this.id}] Connected to gateway (${this.credentials.sandbox ? "sandbox" : "production"})`);
  }

  public async stop(): Promise<void> {
    this.running = false;
    await this.pipeline?.stop();
    this.clearHeartbeat();
    try {
      // 等待 close 完成 (热重启时防新旧 WS 短暂并存; 2s 超时兜底)
      const ws = this.ws;
      if (ws && ws.readyState !== ws.CLOSED) {
        await new Promise<void>((resolve) => {
          const done = () => resolve();
          ws.addEventListener("close", done, { once: true });
          setTimeout(done, 2_000).unref?.();
          ws.close(1000, "shutdown");
        });
      } else {
        ws?.close(1000, "shutdown");
      }
    } catch {
      // 已断开忽略
    }
    logger.info("QQAdapter", `[${this.id}] Stopped`);
  }

  // ── 出站 ──

  /** 主动发送 (无 msg_id): 受每月主动消息配额限制 */
  public async sendMessage(peerId: string, content: string): Promise<void> {
    await this.postMessage(peerId, { content, msg_type: 0, msg_seq: this.nextSeq("active") });
  }

  /**
   * 被动回复 (带 msg_id): 窗口内 (单聊 60min/群 5min) 免配额; 平台拒绝
   * (超窗/配额/风控) 返回 false, 网关回退主动发送。
   */
  public async sendReply(peerId: string, content: string, replyContext: unknown): Promise<boolean> {
    const ctx = replyContext as { msgId?: string } | undefined;
    const msgId = ctx?.msgId;
    if (!msgId) return false;
    try {
      await this.postMessage(peerId, {
        content,
        msg_type: 0,
        msg_id: msgId,
        msg_seq: this.nextSeq(msgId),
      });
      return true;
    } catch (err) {
      logger.debug("QQAdapter", `[${this.id}] Passive reply rejected (fallback to active): ${err}`);
      return false;
    }
  }

  /** 输入状态提示 (仅单聊支持, 群聊忽略; 官方 input_notify 协议体) */
  private async sendTypingIndicator(peerId: string): Promise<void> {
    if (this.peerChatType.get(peerId) !== "c2c") return;
    const msgId = this.lastInboundMsgId.get(peerId);
    if (!msgId) return;
    await this.postMessage(peerId, {
      msg_type: 6,
      msg_id: msgId,
      msg_seq: this.nextSeq(msgId),
      input_notify: { input_type: 1, input_second: 30 },
    });
  }

  /** 最近一条入站消息 id (typing 的被动凭据) */
  private lastInboundMsgId = new Map<string, string>();
  /** 入站时记录的会话类型 (peerId → "c2c"|"group"; 出站端点选择的真相源) */
  private peerChatType = new Map<string, "c2c" | "group">();

  /** 容量上限 (淘汰最旧, Map 保持插入序): 公开 bot 被大量陌生 peer 访问时防无界增长 */
  private static readonly PEER_STATE_CAP = 1000;
  private capPeerState<T>(map: Map<string, T>): void {
    while (map.size > QQChannelAdapter.PEER_STATE_CAP) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }

  private async postMessage(peerId: string, body: Record<string, unknown>): Promise<void> {
    // 端点选择以入站时记录的会话类型为准 (openid 是不透明 id, 前缀启发式不可靠);
    // 无记录的 peer (纯主动推送) 按单聊端点尝试
    const chatType = this.peerChatType.get(peerId) ?? (peerId.startsWith("G") ? "group" : "c2c");
    const path =
      chatType === "group"
        ? `/v2/groups/${encodeURIComponent(peerId)}/messages`
        : `/v2/users/${encodeURIComponent(peerId)}/messages`;
    const res = await this.restRequest("POST", path, body);
    logger.debug("QQAdapter", `[${this.id}] Sent to ${peerId.slice(0, 8)}…: ${JSON.stringify(res).slice(0, 120)}`);
  }

  private nextSeq(key: string): number {
    const next = (this.msgSeqCounters.get(key) ?? 0) + 1;
    this.msgSeqCounters.set(key, next);
    // 计数器防膨胀: 淘汰最旧条目 (Map 保持插入序), 不整体清空——
    // 清空会让仍在窗口内的 msg_id 的 seq 从 1 重新计数 (平台拒重复 seq)
    if (this.msgSeqCounters.size > 500) {
      const oldest = this.msgSeqCounters.keys().next().value;
      if (oldest !== undefined) this.msgSeqCounters.delete(oldest);
    }
    return next;
  }

  // ── REST ──

  private restRequest(method: string, path: string, body?: Record<string, unknown>): Promise<any> {
    return this.ensureToken().then((token) =>
      fetch(`${this.apiBase()}${path}`, {
        method,
        headers: {
          Authorization: `QQBot ${token}`,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REST_TIMEOUT_MS),
      }).then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(`QQ API ${method} ${path} → HTTP ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
        }
        return data;
      }),
    );
  }

  private apiBase(): string {
    return this.credentials.sandbox ? SANDBOX_API_BASE : API_BASE;
  }

  /** access_token 单飞刷新 (提前 60s 过期) */
  private async ensureToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt - 60_000) return this.token;
    if (this.tokenPromise) return this.tokenPromise;
    this.tokenPromise = (async () => {
      const res = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appId: this.credentials.appId, clientSecret: this.credentials.clientSecret }),
        signal: AbortSignal.timeout(REST_TIMEOUT_MS),
      });
      const data = (await res.json()) as { access_token?: string; expires_in?: string | number };
      if (!data.access_token) {
        throw new Error(`QQ token response missing access_token: ${JSON.stringify(data).slice(0, 200)}`);
      }
      this.token = data.access_token;
      this.tokenExpiresAt = Date.now() + Number(data.expires_in ?? 7200) * 1000;
      logger.debug("QQAdapter", `[${this.id}] Access token refreshed, expires in ${data.expires_in}s`);
      return this.token;
    })();
    try {
      return await this.tokenPromise;
    } finally {
      this.tokenPromise = undefined;
    }
  }

  // ── WebSocket 网关 ──

  private async connectGateway(): Promise<void> {
    const token = await this.ensureToken();
    const gwRes = await fetch(`${this.apiBase()}/gateway`, {
      headers: { Authorization: `QQBot ${token}` },
      signal: AbortSignal.timeout(REST_TIMEOUT_MS),
    });
    if (!gwRes.ok) throw new Error(`QQ gateway HTTP ${gwRes.status}`);
    const { url } = (await gwRes.json()) as { url?: string };
    if (!url) throw new Error("QQ gateway response missing url");

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = (e) => reject(new Error(`gateway WS error: ${e}`));
      ws.onclose = (e) => {
        if (!this.running) return;
        void this.handleClose(e.code, e.reason);
      };
      ws.onmessage = (e) => {
        try {
          this.dispatchPayload(JSON.parse(String(e.data)) as WsPayload);
        } catch (err) {
          // 平台错误帧/非 JSON 帧: 记录并继续 (同步抛出会成 uncaught exception 杀进程)
          logger.warn("QQAdapter", `[${this.id}] Bad WS frame: ${err}`);
        }
      };
    });
  }

  private dispatchPayload(payload: WsPayload): void {
    if (typeof payload.s === "number" && (this.lastSeq === undefined || payload.s > this.lastSeq)) {
      this.lastSeq = payload.s;
    }
    switch (payload.op) {
      case 10: {
        // Hello: 心跳间隔取 80% (对齐 hermes), 有会话先 Resume 失败再 Identify
        const intervalMs = Number(payload.d?.heartbeat_interval ?? 30_000);
        this.clearHeartbeat();
        this.heartbeatTimer = setInterval(() => {
          try {
            this.ws?.send(JSON.stringify({ op: 1, d: this.lastSeq ?? null }));
          } catch {
            // 心跳失败由 close 处理
          }
        }, intervalMs * 0.8);
        const canResume = this.sessionId && this.lastSeq !== undefined;
        if (canResume) {
          void this.resume();
        } else {
          void this.identify();
        }
        break;
      }
      case 0:
        this.handleDispatch(payload.t, payload.d);
        break;
      case 9:
        // Invalid Session: d=false 不可 resume, 清会话重 Identify
        this.sessionId = undefined;
        this.lastSeq = undefined;
        this.ws?.close(4000, "invalid session");
        break;
      case 7:
        // 服务端要求重连
        this.ws?.close(4000, "server requested reconnect");
        break;
      case 11:
        break; // Heartbeat ACK
      default:
        logger.debug("QQAdapter", `[${this.id}] Unhandled op ${payload.op}`);
    }
  }

  private async identify(): Promise<void> {
    try {
      const token = await this.ensureToken();
      this.ws?.send(
        JSON.stringify({
          op: 2,
          d: {
            token: `QQBot ${token}`,
            intents: INTENT_C2C_GROUP_AT_MESSAGES,
            shard: [0, 1],
            properties: { $os: process.platform, $browser: "bot-agent", $device: "bot-agent" },
          },
        }),
      );
    } catch (err) {
      // token 刷新失败: 清会话并触发重连 (void 调用链上的 rejection 必须就地消化)
      logger.error("QQAdapter", `[${this.id}] Identify failed:`, err);
      this.sessionId = undefined;
      this.lastSeq = undefined;
      this.ws?.close(4000, "identify failed");
    }
  }

  private async resume(): Promise<void> {
    try {
      const token = await this.ensureToken();
      this.ws?.send(
        JSON.stringify({
          op: 6,
          d: { token: `QQBot ${token}`, session_id: this.sessionId, seq: this.lastSeq },
        }),
      );
    } catch (err) {
      // resume 失败: 清会话, 下次 Hello 走 Identify
      logger.warn("QQAdapter", `[${this.id}] Resume failed, will re-identify: ${err}`);
      this.sessionId = undefined;
      this.lastSeq = undefined;
    }
  }

  private handleDispatch(type: string | undefined, d: any): void {
    if (type === "READY") {
      this.sessionId = d?.session_id;
      logger.info("QQAdapter", `[${this.id}] Ready (session ${this.sessionId})`);
      return;
    }
    if (type === "RESUMED") {
      logger.info("QQAdapter", `[${this.id}] Session resumed`);
      return;
    }
    if (type === "C2C_MESSAGE_CREATE" || type === "GROUP_AT_MESSAGE_CREATE") {
      void this.onChatMessage(type, d);
    }
  }

  private async onChatMessage(eventType: string, d: any): Promise<void> {
    const isGroup = eventType === "GROUP_AT_MESSAGE_CREATE";
    // 群消息: peer 是群 openid; 单聊: peer 是用户 openid
    const peerId = isGroup ? String(d?.group_openid ?? "") : String(d?.author?.user_openid ?? "");
    const rawContent = String(d?.content ?? "").trim();
    if (!peerId) return;
    // 群 @ 消息剥离首段 @ 占位 (对齐 hermes _strip_at_mention)
    const content = isGroup ? rawContent.replace(/^@\S+\s*/, "").trim() : rawContent;

    const attachments = await this.resolveAttachments(d?.attachments, peerId);
    const inbound: InboundMessage = {
      channelInstanceId: this.id,
      peerId,
      senderName: d?.author?.username,
      content,
      messageId: `${this.id}:${peerId}:${d?.id ?? ""}`,
      conversationType: isGroup ? "group" : "direct",
      replyContext: { msgId: String(d?.id ?? ""), chatType: isGroup ? "group" : "c2c" },
      ...(attachments.length > 0 ? { attachments } : {}),
      raw: d,
    };
    // set 前先 delete: 让活跃 peer 移到插入序末尾 (配合 capPeerState 的 LRU 语义)
    this.peerChatType.delete(peerId);
    this.peerChatType.set(peerId, isGroup ? "group" : "c2c");
    this.lastInboundMsgId.delete(peerId);
    this.lastInboundMsgId.set(peerId, String(d?.id ?? ""));
    this.capPeerState(this.peerChatType);
    this.capPeerState(this.lastInboundMsgId);
    await this.pipeline?.submit(inbound);
  }

  /** 入站媒体经官方 CDN 拉取 (需 Authorization 头) → 落媒体缓存 */
  private async resolveAttachments(raw: any, peerId: string): Promise<MediaAttachment[]> {
    if (!Array.isArray(raw) || raw.length === 0) return [];
    const out: MediaAttachment[] = [];
    for (const att of raw.slice(0, 4)) {
      const url = String(att?.url ?? "");
      if (!url) continue;
      try {
        const token = await this.ensureToken();
        // QQ CDN 常见 // 开头的协议相对形态 (拼 https:// 会得到非法双斜杠)
        const abs = url.startsWith("http") ? url : url.startsWith("//") ? `https:${url}` : `https://${url}`;
        // 建连+落盘全程占并发信号量
        const stored = await withDownloadSlot(async () => {
          const res = await safeFetch(abs, {
            headers: { Authorization: `QQBot ${token}` },
            signal: AbortSignal.timeout(60_000),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          if (!res.body) throw new Error("CDN response has no body");
          // 流式落盘 (零内存累积, 与飞书/微信同款管线)
          return storeMediaStream(this.id, res.body, {
            filename: att.filename,
            mimeType: att.content_type,
          });
        });
        out.push({
          kind: att.content_type?.startsWith("image/") ? "image" : "file",
          ...stored,
          filename: att.filename,
          mimeType: att.content_type,
        });
      } catch (err) {
        logger.warn("QQAdapter", `[${this.id}] Attachment download failed: ${err}`);
      }
    }
    return out;
  }

  // ── 断线重连 (指数退避; session 尽量 resume) ──

  private failCount = 0;

  private async handleClose(code: number, reason: string): Promise<void> {
    if (!this.running || this.reconnecting) return;
    if (this.failCount >= MAX_RECONNECT_ATTEMPTS) {
      logger.error("QQAdapter", `[${this.id}] Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached; channel stopped`);
      this.running = false;
      return;
    }
    this.reconnecting = true;
    this.clearHeartbeat();
    const fatal = FATAL_CLOSE_CODES[code];
    if (fatal) {
      logger.error("QQAdapter", `[${this.id}] Fatal close ${code}: ${fatal}`);
      this.running = false;
      this.reconnecting = false;
      return;
    }
    // 可恢复故障: 4004 = token 失效 (刷新后重连); 4006/4007/4009 = 会话/心跳
    // 失效 (清 session 后重新 Identify); 其余照常重连
    if (code === 4004) {
      this.token = undefined;
      this.tokenExpiresAt = 0;
      logger.info("QQAdapter", `[${this.id}] Close 4004: token refreshed for reconnect`);
    }
    if (SESSION_INVALID_CLOSE_CODES.has(code)) {
      this.sessionId = undefined;
      this.lastSeq = undefined;
      logger.info("QQAdapter", `[${this.id}] Close ${code}: session cleared, will re-identify`);
    }
    const delay = RECONNECT_BACKOFF_MS[Math.min(this.failCount++, RECONNECT_BACKOFF_MS.length - 1)];
    logger.warn("QQAdapter", `[${this.id}] WS closed (${code} ${reason}); reconnect in ${delay}ms`);
    await new Promise((r) => setTimeout(r, delay));
    this.reconnecting = false;
    if (!this.running) return;
    try {
      await this.connectGateway();
      this.failCount = 0;
    } catch (err) {
      logger.error("QQAdapter", `[${this.id}] Reconnect failed: ${err}`);
      void this.handleClose(code, "reconnect failed");
    }
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }
}
