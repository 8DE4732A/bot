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
  /** 真实发送者的不可变 id（群聊时与 peerId 不同；访问策略/审计用） */
  senderId?: string;
  content: string;
  /** 平台事件时间（毫秒）；缺省由管道收到时补 Date.now() */
  receivedAt?: number;
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

/** 出站媒体（路径已由 ChannelManager 做 workspace/realpath/大小校验） */
export interface OutboundMedia {
  kind: MediaKind;
  localPath: string;
  filename: string;
  mimeType?: string;
  sizeBytes: number;
  /** 校验时从受控 fd 读出的内容快照；adapter 必须发送这份数据，避免路径 TOCTOU */
  data: Buffer;
}

export interface ChannelWebhookResult {
  status: number;
  body: string;
  contentType?: string;
}

export interface ChannelHealth {
  ok: boolean;
  detail?: string;
  lastInboundAt?: number;
  lastSendAt?: number;
  lastConnectedAt?: number;
  reconnectAttempts?: number;
  nextRetryAt?: number;
}

export type MarkdownMode = "full" | "limited" | "plain";

export interface ChannelAdapter {
  readonly id: string;
  /** 渠道类型（注册表 key；string 以便扩展，API 边界由 registry 校验） */
  readonly type: string;
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendMessage(peerId: string, content: string): Promise<void>;
  /**
   * 被动回复窗口内发送 (携带 replyContext)。无窗口机制、超窗或发送失败
   * 返回 false——网关回退 sendMessage (主动发送)。平台窗口差异留在 adapter 内。
   */
  sendReply?(peerId: string, content: string, replyContext: unknown): Promise<boolean>;
  /**
   * 出站媒体（图片/文件/语音/视频）。路径已由网关校验为 Agent 工作区内普通文件。
   * 返回 false = 平台拒绝/不支持（调用方降级为文本提示）。
   */
  sendMedia?(peerId: string, media: OutboundMedia, replyContext?: unknown): Promise<boolean>;
  /** 出站文本平台化排版（在 markdown 降级之前调用） */
  formatOutbound?(content: string): string;
  /** 平台单条消息长度上限 (字节, UTF-8); 缺省不分段 */
  maxMessageBytes?: number;
  /** 平台 markdown 能力: 分段前先按此降级转换 (缺省 full) */
  markdownMode?: MarkdownMode;
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
