export interface InboundMessage {
  channelInstanceId: string;
  peerId: string;
  senderName?: string;
  content: string;
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

export interface ChannelAdapter {
  readonly id: string;
  readonly type: "terminal" | "wecom" | "weixin" | "qq";
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendMessage(peerId: string, content: string): Promise<void>;
  /**
   * 回调型渠道 (企微回调模式/公众号服务器) 可选实现。
   * 管理台 HTTP 服务会把 GET/POST /api/channel-webhook/<channelId> 转发到这里,
   * 渠道自行完成签名验签与消息解析, 无需改动服务器路由。
   */
  handleWebhook?(
    pathname: string,
    query: URLSearchParams,
    body: string,
  ): Promise<ChannelWebhookResult>;
}
