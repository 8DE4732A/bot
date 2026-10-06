import { randomUUID } from "node:crypto";
import { WSClient } from "@wecom/aibot-node-sdk";
import type { WsFrameHeaders } from "@wecom/aibot-node-sdk";
import { logger } from "../../utils/logger.ts";
import type { ChannelAdapter, ChannelHealth, InboundMessage, MediaAttachment } from "../base.ts";
import { InboundPipeline } from "../runtime/dispatch.ts";
import { ChannelManager } from "../manager.ts";
import { storeMediaBytes, withDownloadSlot } from "../runtime/media-cache.ts";

export interface WeComCredentials {
  /** 企微后台"智能机器人"的 bot id */
  botId?: string;
  secret?: string;
  /** 进入会话欢迎语 (可选, 5s 窗口内回复) */
  welcomeMessage?: string;
}

/** 流式刷新节流 (企微 stream 回复是全量刷新, 高频全量重发浪费且易限流) */
const STREAM_FLUSH_INTERVAL_MS = 800;
/** stream.content 官方单帧上限 20480 字节, 保守取 20000 (超限触发分段兜底) */
const STREAM_MAX_CONTENT_BYTES = 20_000;
/** stream content 单帧 ≤ 20480 字节; 分段兜底上限留余量 */
const MAX_MESSAGE_BYTES = 20_000;

type ReplyContext = { frame: WsFrameHeaders; msgId: string; chattype: "single" | "group" };

/**
 * 企业微信智能机器人渠道 (M4, 设计 §4.4): 官方 @wecom/aibot-node-sdk,
 * WebSocket 长连接认证帧鉴权——免公网、免回调验签、免 access_token。
 * - 入站: message.* 事件 (SDK 自动分发), chattype single|group;
 *   加密媒体 downloadFile(url, aeskey) (SDK 内置 AES-256-CBC 解密)
 * - 出站: 全渠道唯一流式回复——AgentManager 的 onChunk 节流后映射为
 *   replyStream 全量刷新帧, 企微客户端可见打字机效果; 被动回复超窗/
 *   失败回退 sendMessage 主动推送 (markdown)
 * - enter_chat 欢迎语 (5s 窗口, 需用事件帧 req_id)
 */
export class WeComChannelAdapter implements ChannelAdapter {
  readonly type = "wecom" as const;
  readonly id: string;
  readonly name: string;
  maxMessageBytes = MAX_MESSAGE_BYTES;
  markdownMode = "full" as const;

  private credentials: WeComCredentials;
  private pipeline?: InboundPipeline;
  private ws?: WSClient;
  private authenticated = false;

  constructor(id: string, name: string, credentials: WeComCredentials) {
    this.id = id;
    this.name = name;
    this.credentials = credentials;
  }

  public async start(): Promise<void> {
    if (!this.credentials.botId || !this.credentials.secret) {
      throw new Error(`channel '${this.id}' is missing credentials.botId/secret`);
    }
    this.pipeline = new InboundPipeline({
      channelId: this.id,
      // 企微走流式定制 dispatch (不走 dispatchAndReply 的整段投递)
      dispatch: (msg) => this.dispatchWithStreaming(msg),
    });

    const ws = new WSClient({
      botId: this.credentials.botId,
      secret: this.credentials.secret,
      maxReconnectAttempts: -1, // 长连接常驻, 断线无限重连
      logger: {
        debug: () => {},
        info: (msg) => logger.debug("WeComAdapter", `[${this.id}] ${msg}`),
        warn: (msg) => logger.warn("WeComAdapter", `[${this.id}] ${msg}`),
        error: (msg) => logger.error("WeComAdapter", `[${this.id}] ${msg}`),
      },
    });
    this.ws = ws;

    ws.on("authenticated", () => {
      this.authenticated = true;
      logger.info("WeComAdapter", `[${this.id}] WS authenticated`);
    });
    ws.on("disconnected", (reason) => {
      this.authenticated = false;
      logger.warn("WeComAdapter", `[${this.id}] WS disconnected: ${reason}`);
    });
    ws.on("error", (err) => logger.error("WeComAdapter", `[${this.id}] WS error: ${err.message}`));

    // 文本/语音 (voice.content 为平台 ASR 文本)
    ws.on("message.text", (frame) => void this.onFrame(frame, String(frame.body?.text?.content ?? "")));
    ws.on("message.voice", (frame) => void this.onFrame(frame, String(frame.body?.voice?.content ?? "")));
    ws.on("message.image", (frame) => void this.onFrame(frame, "", { kind: "image", content: frame.body?.image }));
    ws.on("message.file", (frame) => void this.onFrame(frame, "", { kind: "file", content: frame.body?.file }));
    ws.on("message.video", (frame) => void this.onFrame(frame, "", { kind: "video", content: frame.body?.video }));
    ws.on("message.mixed", (frame) => {
      const items = (frame.body?.mixed?.msg_item as any[]) ?? [];
      const text = items.filter((i) => i.msgtype === "text").map((i) => i.text?.content ?? "").join("\n");
      const image = items.find((i) => i.msgtype === "image")?.image;
      void this.onFrame(frame, text, image ? { kind: "image", content: image } : undefined);
    });

    // enter_chat 欢迎语 (5s 窗口, 必须用事件帧的 req_id)
    ws.on("event.enter_chat", (frame) => {
      if (!this.credentials.welcomeMessage) return;
      ws.replyWelcome(frame, { msgtype: "text", text: { content: this.credentials.welcomeMessage } }).catch((err) =>
        logger.warn("WeComAdapter", `[${this.id}] Welcome reply failed: ${err}`),
      );
    });

    await ws.connect();
    logger.info("WeComAdapter", `[${this.id}] WS connecting (auth in background)…`);
  }

  public async stop(): Promise<void> {
    await this.pipeline?.stop();
    this.ws?.disconnect();
    logger.info("WeComAdapter", `[${this.id}] Stopped`);
  }

  /** 主动推送 (通知/流式超窗兜底): markdown 消息 */
  public async sendMessage(peerId: string, content: string): Promise<void> {
    this.requireWs();
    await this.ws!.sendMessage(peerId, { msgtype: "markdown", markdown: { content } });
  }

  /**
   * 被动回复 (aibot_respond_msg, 需原帧 req_id): 以流式帧 finish 一次成文。
   * 失败 (5s 窗口过/队列丢帧) 返回 false → 网关回退主动推送。
   */
  public async sendReply(peerId: string, content: string, replyContext: unknown): Promise<boolean> {
    const ctx = replyContext as ReplyContext | undefined;
    if (!ctx?.frame || !this.ws) return false;
    try {
      await this.ws.reply(ctx.frame, {
        msgtype: "stream",
        stream: { id: ctx.msgId, finish: true, content },
      });
      return true;
    } catch (err) {
      logger.debug("WeComAdapter", `[${this.id}] Passive reply failed (fallback to active send): ${err}`);
      return false;
    }
  }

  public async healthCheck(): Promise<ChannelHealth> {
    return this.authenticated
      ? { ok: true, detail: "ws authenticated" }
      : { ok: false, detail: this.ws ? "ws not authenticated" : "not started" };
  }

  // ── 内部 ──

  private requireWs(): void {
    if (!this.ws) throw new Error("adapter not started");
  }

  /** 入站帧 → 统一 InboundMessage (peer: 单聊 userid / 群聊 chatid) */
  private async onFrame(
    frame: any,
    text: string,
    media?: { kind: MediaAttachment["kind"]; content?: { url?: string; aeskey?: string } },
  ): Promise<void> {
    const body = frame.body;
    if (!body) return;
    const isGroup = body.chattype === "group";
    const peerId = isGroup ? String(body.chatid ?? "") : String(body.from?.userid ?? "");
    if (!peerId) return;

    let attachments: MediaAttachment[] | undefined;
    const mediaUrl = media?.content?.url;
    const mediaAesKey = media?.content?.aeskey;
    if (mediaUrl) {
      try {
        this.requireWs();
        // SDK downloadFile 返回 Buffer (SDK 层限制), 但并发与水位仍受全局约束
        attachments = await withDownloadSlot(async () => {
          const { buffer, filename } = await this.ws!.downloadFile(mediaUrl, mediaAesKey);
          const stored = await storeMediaBytes(this.id, buffer, { filename });
          return [{ kind: media.kind, ...stored, filename }];
        });
      } catch (err) {
        logger.warn("WeComAdapter", `[${this.id}] Media download failed: ${err}`);
      }
    }

    const inbound: InboundMessage = {
      channelInstanceId: this.id,
      peerId,
      senderName: String(body.from?.userid ?? ""),
      content: text,
      messageId: String(body.msgid ?? ""),
      conversationType: isGroup ? "group" : "direct",
      replyContext: { frame: { headers: frame.headers }, msgId: String(body.msgid ?? ""), chattype: body.chattype },
      ...(attachments ? { attachments } : {}),
      raw: body,
    };
    await this.pipeline?.submit(inbound);
  }

  /**
   * 流式定制 dispatch: onChunk 增量累积 → 节流后 replyStream 全量刷新
   * (企微 stream 协议按 stream.id 重刷内容, 非追加), 完成时 finish=true 收尾。
   * 流式期间失败 (超窗/断线) 降级为分段主动推送, 保证回复必达。
   * stream.content 官方上限 20480 字节: 中间刷新超限会断流 (streamBroken),
   * 最终帧经 splitMessage 分段 (首段随 finish 帧, 余下主动推送)。
   */
  private async dispatchWithStreaming(message: InboundMessage): Promise<void> {
    const manager = ChannelManager.getInstance();
    const ctx = message.replyContext as ReplyContext | undefined;
    const streamId = `botagent-${randomUUID()}`;

    // 依赖注入 fallback: 无 replyContext (理论不可达) 或 WS 未就绪 → 分段主动推送
    if (!ctx?.frame || !this.ws) {
      const answer = await manager.dispatchInbound(message);
      if (answer) await this.deliverSegmented(message.peerId, answer);
      return;
    }

    let accumulated = "";
    let lastFlush = 0;
    let streamBroken = false;
    const answer = await manager.dispatchInbound(message, (chunk) => {
      if (streamBroken || !chunk.delta) return;
      accumulated += chunk.delta;
      // 中间刷新的内容超 20480 字节必然被平台拒: 停止流式, 完成后走分段主动推送
      if (Buffer.byteLength(accumulated, "utf8") > STREAM_MAX_CONTENT_BYTES) {
        streamBroken = true;
        return;
      }
      const now = Date.now();
      if (now - lastFlush < STREAM_FLUSH_INTERVAL_MS) return;
      lastFlush = now;
      this.ws!.replyStream(ctx.frame, streamId, accumulated).catch(() => {
        // 流式通道坏了 (超窗/断线): 停止刷新, 完成后走分段主动推送
        streamBroken = true;
      });
    });

    const finalText = answer || accumulated;
    if (!finalText) return;

    try {
      if (streamBroken) {
        await this.deliverSegmented(message.peerId, finalText);
        return;
      }
      // 最终帧: 内容在限额内随 finish 帧一次成文; 超限则 finish 帧发提示, 完整内容分段主动推送
      if (Buffer.byteLength(finalText, "utf8") <= STREAM_MAX_CONTENT_BYTES) {
        await this.ws!.replyStream(ctx.frame, streamId, finalText, true);
        return;
      }
      await this.ws!.replyStream(ctx.frame, streamId, "回复较长，已分段发送 ↓", true);
      await this.deliverSegmented(message.peerId, finalText);
    } catch (err) {
      logger.warn("WeComAdapter", `[${this.id}] Stream finish failed, falling back to segmented send: ${err}`);
      await this.deliverSegmented(message.peerId, finalText);
    }
  }

  /** 分段主动推送 (复用网关的降级/分段管线, 无被动回复凭据) */
  private async deliverSegmented(peerId: string, content: string): Promise<void> {
    const manager = ChannelManager.getInstance();
    const ok = await manager.deliverOutbound(this.id, peerId, content);
    if (!ok) throw new Error(`channel '${this.id}' adapter not available for outbound delivery`);
  }
}
