/**
 * 渠道抽象 (三期扩展): 统一消息模型 + ChannelAdapter 契约。
 * 媒体附件、被动回复凭据 (replyContext)、分段/降级/typing 能力声明——
 * 平台差异封装在 adapter 内, 网关只见统一消息 (对齐 OpenClaw ChannelMessage)。
 */

export type MediaKind = "image" | "file" | "audio" | "video";

export interface MediaAttachment {
  kind: MediaKind;
  /** 入站即下载到本地媒体缓存后的路径 (agent 经沙盒 read/bash 读取) */
  localPath?: string;
  /** 原始 URL (调试用, 不进 prompt) */
  url?: string;
  filename?: string;
  mimeType?: string;
  sizeBytes?: number;
}

export interface InboundMessage {
  channelInstanceId: string;
  /** 会话对端 (飞书 chat_id / QQ openid / iLink peer / TG chat_id) */
  peerId: string;
  peerName?: string;
  senderName?: string;
  content: string;
  /** 平台消息 id (入站去重键) */
  messageId?: string;
  conversationType?: "direct" | "group";
  attachments?: MediaAttachment[];
  /**
   * 被动回复凭据 (QQ msgId+msgSeq / iLink context_token / 飞书 messageId):
   * adapter 自管语义, 网关只负责在回复时原样带回 sendReply。
   */
  replyContext?: unknown;
  raw?: unknown;
}

export interface OutboundMessage {
  channelInstanceId: string;
  peerId: string;
  content: string;
}

export interface ChannelWebhookResult {
  status: number;
  body: string;
  contentType?: string;
}

export interface ChannelHealth {
  ok: boolean;
  detail?: string;
}

export type MarkdownMode = "full" | "limited" | "plain";

export interface ChannelAdapter {
  readonly id: string;
  readonly type: "terminal" | "wecom" | "weixin" | "qq" | "feishu" | "telegram";
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendMessage(peerId: string, content: string): Promise<void>;
  /**
   * 被动回复窗口内发送 (携带 replyContext)。无窗口机制、超窗或发送失败
   * 返回 false——网关回退 sendMessage (主动发送)。平台窗口差异留在 adapter 内。
   */
  sendReply?(peerId: string, content: string, replyContext: unknown): Promise<boolean>;
  /** 平台单条消息长度上限 (字节, UTF-8); 缺省不分段 */
  maxMessageBytes?: number;
  /** 平台 markdown 能力: 分段前先按此降级转换 (缺省 full) */
  markdownMode?: MarkdownMode;
  /** 处理中 typing 心跳 (每 5s 调用, 回复落地即停); 平台不支持则忽略 */
  sendTyping?(peerId: string): Promise<void>;
  /** 连接健康检查 (管理台渠道卡片展示); 缺省视为健康 */
  healthCheck?(): Promise<ChannelHealth>;
  /**
   * 回调型渠道可选实现 (三期四渠道全部 WS/长轮询入站, 预留给老式企微应用)。
   * 管理台 HTTP 服务把 GET/POST /api/channel-webhook/<channelId> 转发到这里,
   * 渠道自行完成签名验签与消息解析, 无需改动服务器路由。
   */
  handleWebhook?(
    pathname: string,
    query: URLSearchParams,
    body: string,
  ): Promise<ChannelWebhookResult>;
}
