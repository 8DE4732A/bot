import { logger } from "../../utils/logger.ts";
import type { ChannelAdapter, InboundMessage, MediaAttachment } from "../base.ts";
import { InboundPipeline } from "../runtime/dispatch.ts";
import { ChannelManager } from "../manager.ts";
import { startTypingHeartbeat } from "../runtime/typing.ts";

export interface TelegramCredentials {
  botToken?: string;
}

const API_BASE = "https://api.telegram.org";
/** 长轮询超时 (服务端挂起秒数) */
const LONG_POLL_SECONDS = 25;
/** API 调用超时 (长轮询按 LONG_POLL_SECONDS 放量) */
const API_TIMEOUT_MS = 30_000;
/** Telegram 单条消息 4096 UTF-16 code units; 分段器按 UTF-8 字节切,
 * 字节口径下英文/代码 1:1、CJK 更紧——取 4096 字节保守预算保证永不超限 */
const TG_MAX_MESSAGE_BYTES = 4_096;

/**
 * Telegram 基准渠道 (设计 §4.5): Bot API 最简, 长轮询免公网零审核——
 * 作为渠道运行时设施 (去重/防抖/分段/typing/loop-guard) 的验收基准。
 * 纯 fetch 实现零依赖; 入站/出站均走官方 Bot API。
 */
export class TelegramChannelAdapter implements ChannelAdapter {
  readonly type = "telegram" as const;
  readonly id: string;
  readonly name: string;
  maxMessageBytes = TG_MAX_MESSAGE_BYTES;
  /** Telegram 私聊支持 MarkdownV2/HTML, 但转义规则繁琐——基准渠道直接纯文本 */
  markdownMode = "plain" as const;

  private credentials: TelegramCredentials;
  private botUsername = "";
  private botUserId = "";
  private pipeline?: InboundPipeline;
  private pollAbort?: AbortController;
  private pollLoop?: Promise<void>;
  private typingPeers = new Map<string, () => void>();

  constructor(id: string, name: string, credentials: TelegramCredentials) {
    this.id = id;
    this.name = name;
    this.credentials = credentials;
  }

  public async start(): Promise<void> {
    if (!this.credentials.botToken) {
      throw new Error(`channel '${this.id}' is missing credentials.botToken`);
    }
    // 启动即校验 token (getMe), 失败显式报错而不是静默空转
    const me = await this.callApi<Record<string, any>>("getMe");
    this.botUsername = String(me.username ?? "");
    this.botUserId = String(me.id ?? "");

    this.pipeline = new InboundPipeline({
      channelId: this.id,
      dispatch: (msg) => ChannelManager.getInstance().dispatchAndReply(msg),
      startTyping: (peerId) => {
        const existing = this.typingPeers.get(peerId);
        if (existing) return existing;
        const stop = startTypingHeartbeat(() => this.sendChatAction(peerId));
        this.typingPeers.set(peerId, stop);
        return () => {
          this.typingPeers.delete(peerId);
          stop();
        };
      },
    });

    // 轮询循环常驻 (退出码经废弃实例 stop 中断); 记录在实例上供 stop 等待
    this.pollAbort = new AbortController();
    this.pollLoop = this.pollUpdates(this.pollAbort.signal);
    logger.info("TelegramAdapter", `[${this.id}] Long-polling started as @${this.botUsername}`);
  }

  public async stop(): Promise<void> {
    this.pollAbort?.abort();
    await this.pipeline?.stop();
    try {
      await this.pollLoop;
    } catch {
      // 中断引发的 fetch 异常属预期
    }
    logger.info("TelegramAdapter", `[${this.id}] Stopped`);
  }

  public async sendMessage(peerId: string, content: string): Promise<void> {
    await this.callApi("sendMessage", {
      chat_id: peerId,
      text: content,
      // 不带 parse_mode: markdownMode=plain, 内容原样可达
    });
  }

  public async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const me = await this.callApi<Record<string, any>>("getMe");
      return { ok: true, detail: `@${me.username ?? "?"}` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  // --- 内部 ---

  private async pollUpdates(signal: AbortSignal): Promise<void> {
    let offset = 0;
    while (!signal.aborted) {
      try {
        const updates = await this.callApi<any[]>("getUpdates", {
          offset,
          timeout: LONG_POLL_SECONDS,
          allowed_updates: ["message"],
        });
        for (const update of updates ?? []) {
          offset = Math.max(offset, Number(update.update_id) + 1);
          void this.handleUpdate(update);
        }
      } catch (err) {
        if (signal.aborted) return;
        // 长轮询网络抖动退避后重试 (设计 §4.3 同款 2s→30s); sleep 可被 stop 中断
        const delay = Math.min(30_000, 2_000 * Math.pow(2, Math.min(4, (this.pollFailures = (this.pollFailures ?? 0) + 1))));
        logger.warn("TelegramAdapter", `[${this.id}] Poll failed (${err}); retry in ${delay}ms`);
        await this.abortableSleep(delay, signal);
        continue;
      }
      this.pollFailures = 0;
    }
  }

  private pollFailures?: number;

  /**
   * 群消息归属判定 (privacy mode 可被关闭/管理员身份会收到全量消息, 不能依赖平台):
   * 仅接受 @机器人 / 回复机器人的消息 / 命令——与设计"群聊默认仅 @ 响应"对齐。
   */
  private isGroupMessageForBot(msg: any): boolean {
    if (String(msg.reply_to_message?.from?.id ?? "") === this.botUserId) return true;
    const text = String(msg.text ?? msg.caption ?? "");
    if (text.startsWith("/")) {
      // /cmd@otherbot 是给别的 bot 的命令 (privacy 关闭时会全量收到)
      const cmd = text.split(/\s/)[0];
      const at = cmd.indexOf("@");
      if (at === -1 || cmd.slice(at + 1).toLowerCase() === this.botUsername.toLowerCase()) return true;
      return false;
    }
    const entities = [...(msg.entities ?? []), ...(msg.caption_entities ?? [])];
    return entities.some(
      (e: any) =>
        (e.type === "mention" || e.type === "text_mention") &&
        (e.user?.id != null ? String(e.user.id) === this.botUserId : text.slice(e.offset, e.offset + e.length) === `@${this.botUsername}`),
    );
  }

  /** 可中断 sleep: stop() 触发 abort 时立即返回 */
  private abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      }
      signal.addEventListener("abort", done, { once: true });
    });
  }

  private async handleUpdate(update: any): Promise<void> {
    const msg = update.message;
    if (!msg || (!msg.text && !msg.caption && !Array.isArray(msg.photo))) return;
    const chatId = String(msg.chat?.id ?? "");
    if (!chatId) return;
    const isGroup = msg.chat?.type === "group" || msg.chat?.type === "supergroup";
    if (isGroup && !this.isGroupMessageForBot(msg)) return;

    // getFile 失败的附件直接跳过 (url/localPath 双空会产生 "→ undefined" 引用)
    const attachments: MediaAttachment[] = [];
    const photo = (msg.photo ?? []).slice(-1)[0]; // 取最大尺寸
    if (photo) {
      const url = await this.resolveFileUrl(photo.file_id);
      if (url) attachments.push({ kind: "image", url, filename: "photo.jpg", mimeType: "image/jpeg" });
    } else if (msg.document) {
      const url = await this.resolveFileUrl(msg.document.file_id);
      if (url)
        attachments.push({ kind: "file", url, filename: msg.document.file_name, mimeType: msg.document.mime_type });
    }

    const inbound: InboundMessage = {
      channelInstanceId: this.id,
      peerId: chatId,
      senderName: msg.from?.first_name ?? msg.chat?.title,
      content: String(msg.text ?? msg.caption ?? ""),
      messageId: `${chatId}:${msg.message_id}`,
      conversationType: msg.chat?.type === "group" || msg.chat?.type === "supergroup" ? "group" : "direct",
      ...(attachments.length > 0 ? { attachments } : {}),
      raw: msg,
    };
    await this.pipeline?.submit(inbound);
  }

  /** file_id → 下载 URL (Telegram 媒体需二次 getFile; 失败返回 undefined 丢弃附件) */
  private async resolveFileUrl(fileId: string): Promise<string | undefined> {
    try {
      const file = await this.callApi<Record<string, any>>("getFile", { file_id: fileId });
      return file.file_path ? `${API_BASE}/file/bot${this.credentials.botToken}/${file.file_path}` : undefined;
    } catch (err) {
      logger.warn("TelegramAdapter", `[${this.id}] getFile failed: ${err}`);
      return undefined;
    }
  }

  private async sendChatAction(peerId: string): Promise<void> {
    await this.callApi("sendChatAction", { chat_id: peerId, action: "typing" });
  }

  /** Bot API 调用封装: 超时 + stop() 可中断; ok=false 抛出 (URL/token 不进错误信息) */
  private async callApi<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    // stop() 中断挂起中的请求 (尤其是 25s 长轮询)
    const onAbort = () => controller.abort();
    this.pollAbort?.signal.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await fetch(`${API_BASE}/bot${this.credentials.botToken}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params ?? {}),
        signal: controller.signal,
      });
      const data = (await res.json()) as { ok: boolean; result?: T; description?: string };
      if (!res.ok || !data.ok) {
        // 绝不把含 token 的 URL 放进错误信息 (错误会进日志)
        throw new Error(`Telegram ${method} failed: HTTP ${res.status} ${data.description ?? ""}`.trim());
      }
      return data.result as T;
    } finally {
      clearTimeout(timer);
      this.pollAbort?.signal.removeEventListener("abort", onAbort);
    }
  }
}
