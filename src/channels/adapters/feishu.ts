import * as lark from "@larksuiteoapi/node-sdk";
import axios from "axios";
import { logger } from "../../utils/logger.ts";
import type { ChannelAdapter, ChannelHealth, InboundMessage, MediaAttachment } from "../base.ts";
import { InboundPipeline } from "../runtime/dispatch.ts";
import { ChannelManager } from "../manager.ts";
import { storeMediaStream, withDownloadSlot, type MediaDownloadResult } from "../runtime/media-cache.ts";

export interface FeishuCredentials {
  appId?: string;
  appSecret?: string;
}

/** 平台事件 3 秒时限内必须返回 (超时重推, 去重器兜住重推) */
const EVENT_ACK_BUDGET_MS = 2500;

/**
 * 飞书渠道 (M1, 设计 §4.1): 官方 SDK WSClient 长连接——免公网、免验签、
 * 免 access_token (SDK 自管 tenant_access_token 刷新)。
 * - 入站: im.message.receive_v1, handler 只做入队 (void submit, 3s 时限内返回)
 * - 出站: 消息一律发到 chat_id (单聊/群聊同构); markdown 经 plain 降级
 *   (飞书 text 消息不渲染 markdown; interactive 卡片形态记 backlog)
 * - 被动回复: sendReply 走 message.reply(message_id), 超窗/失败回退主动发送
 * - 媒体: 入站 image/file 经 client.im 资源接口拉取后落媒体缓存
 */
export class FeishuChannelAdapter implements ChannelAdapter {
  readonly type = "feishu" as const;
  readonly id: string;
  readonly name: string;
  markdownMode = "plain" as const;
  /** 飞书 text 消息 content 上限约 150KB, 保守取 140KB 字节预算 */
  maxMessageBytes = 140_000;

  private client?: lark.Client;
  private wsClient?: lark.WSClient;
  private pipeline?: InboundPipeline;
  private credentials: FeishuCredentials;

  constructor(id: string, name: string, credentials: FeishuCredentials) {
    this.id = id;
    this.name = name;
    this.credentials = credentials;
  }

  public async start(): Promise<void> {
    if (!this.credentials.appId || !this.credentials.appSecret) {
      throw new Error(`channel '${this.id}' is missing credentials.appId/appSecret`);
    }
    const config = { appId: this.credentials.appId, appSecret: this.credentials.appSecret };
    // 自定义 axios 实例带 60s 超时 (SDK 默认 timeout=0 永不超时——挂起的
    // 资源请求会永久占用信号量 slot 并泄漏 socket)。
    // 关键: 必须复刻 SDK defaultHttpInstance 的两个 interceptor (lib/index.js:190-204)——
    // SDK 期望 httpInstance 返回 resp.data (而非 AxiosResponse), 且给缺 UA 的
    // 请求补 User-Agent; 裸 axios.create 会导致 token 获取/消息 API 全部失败
    const httpInstance = axios.create({ timeout: 60_000 });
    httpInstance.interceptors.request.use((req) => {
      if (req.headers && !req.headers["User-Agent"]) {
        req.headers["User-Agent"] = "bot-agent/1.0";
      }
      return req;
    }, undefined, { synchronous: true });
    httpInstance.interceptors.response.use((resp) => {
      if ((resp.config as any)?.$return_headers) {
        return { data: resp.data, headers: resp.headers };
      }
      return resp.data;
    });
    this.client = new lark.Client({
      ...config,
      httpInstance: httpInstance as unknown as lark.HttpInstance,
    });

    this.pipeline = new InboundPipeline({
      channelId: this.id,
      dispatch: (msg) => ChannelManager.getInstance().dispatchAndReply(msg),
    });

    const dispatcher = new lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (data: any) => {
        // 只做入队 (媒体下载/agent 调用都在管道里异步化), 3s 时限内返回
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            this.handleMessage(data),
            new Promise((r) => {
              timer = setTimeout(r, EVENT_ACK_BUDGET_MS);
            }),
          ]);
        } catch (err) {
          logger.error("FeishuAdapter", `[${this.id}] Event handling error:`, err);
        } finally {
          if (timer) clearTimeout(timer);
        }
      },
    });

    this.wsClient = new lark.WSClient({ ...config, loggerLevel: lark.LoggerLevel.warn });
    // SDK 内部自动重连; start 返回后连接在后台维持
    await this.wsClient.start({ eventDispatcher: dispatcher });
    logger.info("FeishuAdapter", `[${this.id}] WS long connection started`);
  }

  public async stop(): Promise<void> {
    await this.pipeline?.stop();
    try {
      // SDK 1.74 的 WSClient 无显式 close API, 连接随进程退出回收
      (this.wsClient as any)?.close?.();
    } catch {
      // 已断开等情况忽略
    }
    logger.info("FeishuAdapter", `[${this.id}] Stopped`);
  }

  /** 主动发送 (通知/被动回复超窗兜底): 文本发到 chat_id */
  public async sendMessage(peerId: string, content: string): Promise<void> {
    await this.sendMessageWithType(peerId, "text", JSON.stringify({ text: content }));
  }

  /** 被动回复: 引用原消息 (群聊中语义更清晰); 失败返回 false 走主动发送 */
  public async sendReply(peerId: string, content: string, replyContext: unknown): Promise<boolean> {
    const messageId = typeof replyContext === "string" ? replyContext : (replyContext as any)?.messageId;
    if (!messageId || !this.client) return false;
    try {
      await this.client.im.v1.message.reply({
        path: { message_id: messageId },
        data: { content: JSON.stringify({ text: content }), msg_type: "text" },
      });
      return true;
    } catch (err) {
      logger.debug("FeishuAdapter", `[${this.id}] Passive reply failed, fallback to active send: ${err}`);
      return false;
    }
  }

  public async healthCheck(): Promise<ChannelHealth> {
    try {
      // tenant_access_token 自取即视为凭据健康 (WS 状态无独立查询接口)
      const res: any = await (this.client as any)?.request({
        method: "POST",
        url: "/open-apis/auth/v3/tenant_access_token/internal",
        data: { app_id: this.credentials.appId, app_secret: this.credentials.appSecret },
      });
      return res?.code === 0 || res?.data?.expire != null
        ? { ok: true }
        : { ok: false, detail: `token request failed: ${res?.msg ?? "unknown"}` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  // --- 内部 ---

  private async sendMessageWithType(peerId: string, msgType: string, content: string): Promise<void> {
    if (!this.client) throw new Error("adapter not started");
    await this.client.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: { receive_id: peerId, msg_type: msgType, content },
    });
  }

  private async handleMessage(data: any): Promise<void> {
    const message = data?.message;
    if (!message) return;
    // bot 自身/其他应用消息不入管道 (防自循环的第一道确定性防线)
    if (data?.sender?.sender_type === "app") return;
    const chatId = String(message.chat_id ?? "");
    if (!chatId) return;

    const { text, attachments } = await this.parseContent(String(message.message_id ?? ""), message);
    // 非 @ 群消息已在开放平台事件配置层过滤 (只订阅 @ 机器人); 这里按需兜底
    const inbound: InboundMessage = {
      channelInstanceId: this.id,
      peerId: chatId,
      senderName: data?.sender?.sender_id?.open_id,
      content: text,
      messageId: String(message.message_id ?? ""),
      conversationType: message.chat_type === "group" ? "group" : "direct",
      // 飞书被动回复窗口宽松, replyContext 带原消息 id 供 sendReply 引用回复
      replyContext: { messageId: String(message.message_id ?? "") },
      ...(attachments.length > 0 ? { attachments } : {}),
      raw: message,
    };
    await this.pipeline?.submit(inbound);
  }

  /** 按消息类型解析文本与媒体附件 (text/post/image/file/media); 媒体下载需 message_id */
  private async parseContent(messageId: string, message: any): Promise<{ text: string; attachments: MediaAttachment[] }> {
    const attachments: MediaAttachment[] = [];
    let text = "";
    let body: any = {};
    try {
      body = JSON.parse(message.content ?? "{}");
    } catch {
      body = {};
    }

    switch (message.message_type) {
      case "text":
        // @ 机器人的占位符 (@_user_1) 对 agent 无意义, 剥掉
        text = String(body.text ?? "").replace(/@_user_\d+/g, "").trim();
        break;
      case "post": {
        // 富文本: 兼容两种形态——{content: {zh_cn: paragraphs}} 与 {content: paragraphs}
        const raw = body.content ?? {};
        const langs: any[] = Array.isArray(raw)
          ? [raw]
          : Object.values(raw) as any[];
        const parts: string[] = [];
        for (const lang of langs) {
          for (const para of (lang ?? []) as any[]) {
            for (const seg of para ?? []) {
              if (seg.tag === "text" || seg.tag === "a") parts.push(String(seg.text ?? ""));
            }
          }
        }
        text = [body.title, ...parts].filter(Boolean).join("\n");
        break;
      }
      case "image": {
        const local = await this.fetchResource(messageId, body.image_key, "image");
        if (local) attachments.push({ kind: "image", ...local });
        break;
      }
      case "file": {
        const local = await this.fetchResource(messageId, body.file_key, "file", body.file_name);
        if (local) attachments.push({ kind: "file", ...local, filename: body.file_name });
        break;
      }
      case "media":
      case "audio": {
        // 音视频: 提取文件引用, 暂不做转写
        const local = await this.fetchResource(messageId, body.file_key ?? body.image_key, "file", body.file_name);
        if (local) attachments.push({ kind: "file", ...local, filename: body.file_name });
        break;
      }
      default:
        text = `[不支持的消息类型: ${message.message_type}]`;
    }
    return { text, attachments };
  }

  /**
   * 用户消息内的资源必须用 messageResource.get (image.get/file.get 只能下载
   * 机器人自己上传的资源, 对用户消息资源平台直接拒绝)。SDK 返回
   * { writeFile, getReadableStream, headers }——经流读取落媒体缓存。
   * 拉取失败返回 undefined (附件丢弃, 不阻断文本)。
   */
  private async fetchResource(
    messageId: string,
    key: string,
    type: "image" | "file",
    filename?: string,
  ): Promise<{ localPath: string; sizeBytes: number; mimeType?: string } | undefined> {
    if (!key || !messageId || !this.client) return undefined;
    const client = this.client; // 闭包内窄化失效, 先捕获
    try {
      // SDK 请求 + 流式落盘全程占并发信号量; SDK 请求受 60s race 约束
      // (axios 默认 timeout=0, 不 race 会永久挂起)
      return await withDownloadSlot(async () => {
        const signal = AbortSignal.timeout(60_000);
        const timeout = new Promise<never>((_, reject) =>
          signal.addEventListener("abort", () => reject(new Error("feishu resource request timed out")), { once: true }),
        );
        const sdkPromise = client.im.v1.messageResource.get({
          path: { message_id: messageId, file_key: key },
          params: { type },
        });
        // 超时路径下底层 axios 请求无法取消——slot 保持占用到其 settle
        // (有界 60s, 防永久泄漏), 否则挂起请求会持续消耗 fd/连接
        const settleGuard = sdkPromise.catch(() => null);
        try {
          const res: any = await Promise.race([sdkPromise, timeout]);
          const stream = res?.getReadableStream?.();
          if (!stream) return undefined;
          // 流式落盘 (零内存累积, 100MB 平台限额内边下边计数; 60s 超时)
          const result: MediaDownloadResult = await storeMediaStream(this.id, stream, {
            filename,
            mimeType: type === "image" ? "image/jpeg" : undefined,
            signal: AbortSignal.timeout(60_000),
          });
          return result.sizeBytes > 0 ? result : undefined;
        } finally {
          await Promise.race([settleGuard, new Promise((r) => setTimeout(r, 60_000).unref?.())]);
        }
      });
    } catch (err) {
      logger.warn("FeishuAdapter", `[${this.id}] Resource fetch failed (${type}): ${err}`);
      return undefined;
    }
  }
}
