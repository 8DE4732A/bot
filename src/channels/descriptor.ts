import type { ChannelInstanceConfig } from "../config/database-store.ts";
import type { ChannelAdapter, InboundMessage, MarkdownMode, MediaKind } from "./base.ts";

/**
 * 渠道类型描述符（渠道平台化的单一真相源）。
 *
 * 后端的类型校验、凭据字段/secret、认证流程、删除清理、能力声明全部从这里派生；
 * 前端通过 GET /api/channel-types 拿 toPublicChannelType() 的白名单快照渲染表单，
 * 因此新增内置渠道只需要「adapter + descriptor 一行注册」，不再改前后端枚举。
 */

export type ChannelFieldType = "string" | "secret" | "boolean" | "list" | "select";

export interface ChannelFieldDescriptor {
  key: string;
  label: string;
  type: ChannelFieldType;
  required?: boolean;
  /** 表单分组（前端仅用于视觉分组） */
  section?: "basic" | "access" | "advanced";
  options?: { value: string; label: string }[];
  placeholder?: string;
  hint?: string;
  maxItems?: number;
  defaultValue?: string | boolean | string[];
}

export interface ChannelCapabilities {
  /** 是否支持群聊事件（决定前端是否展示群策略字段） */
  groupChat: boolean;
  mediaInbound: MediaKind[];
  mediaOutbound: MediaKind[];
  /** 是否具备平台被动回复窗口（sendReply） */
  passiveReply: boolean;
  typing: boolean;
  streaming: boolean;
  markdown: MarkdownMode;
  maxMessageBytes: number;
}

export interface ChannelAuthStart {
  qrcode: string;
  qrcodeImgContent?: string;
}

export interface ChannelAuthPollResult {
  status: string;
  redirectHost?: string;
  /** confirmed 时返回待并入 credentials 的字段（绝不回传给前端明文） */
  credentials?: Record<string, unknown>;
  /** 审计用脱敏标识（如 accountId） */
  identity?: string;
}

export interface ChannelAuthDescriptor {
  kind: "qr";
  label: string;
  pollIntervalMs: number;
  hint?: string;
  /** 这些凭据字段齐备即视为已认证；缺失时前端保存后自动拉起认证 */
  readyFields?: string[];
  start(config: ChannelInstanceConfig): Promise<ChannelAuthStart>;
  poll(
    state: { qrcode: string; redirectHost?: string },
    config: ChannelInstanceConfig,
  ): Promise<ChannelAuthPollResult>;
}

export interface ChannelTypeDescriptor {
  type: string;
  label: string;
  description: string;
  /** manager = 由 ChannelManager 实例化；cli = 由 CLI 单独管理（terminal） */
  managedBy: "manager" | "cli";
  creatable: boolean;
  deletable: boolean;
  /** 无普通凭据字段时的表单提示（如微信扫码） */
  credentialHint?: string;
  credentials: ChannelFieldDescriptor[];
  capabilities: ChannelCapabilities;
  auth?: ChannelAuthDescriptor;
  create?(config: ChannelInstanceConfig, deps: ChannelAdapterDeps): ChannelAdapter;
  /** 保存时的轻量校验（返回错误消息；必填项仍由 API 层校验） */
  validate?(config: ChannelInstanceConfig): string | undefined;
  /** 删除渠道时清理平台持久化状态；媒体缓存由 ChannelManager 统一清理 */
  onDelete?(config: ChannelInstanceConfig): void | Promise<void>;
  /** 认证确认并落库后调用（如微信账号切换时清理旧账号持久化状态） */
  onCredentialsChanged?(
    previous: ChannelInstanceConfig,
    credentials: Record<string, unknown>,
  ): void | Promise<void>;
}

/** adapter 需要的网关能力；由 ChannelManager 实现并注入，避免 adapter 反向 import manager */
export interface ChatDeltaLike {
  delta?: string;
}

export interface DeliverOutboundOptions {
  /** 出站媒体校验所用 Agent（缺省 = 渠道绑定 Agent） */
  agentId?: string;
  /** false = 不解析 MEDIA: 标记（主动通知等场景可显式关闭） */
  allowMedia?: boolean;
}

export interface ChannelDispatchRuntime {
  dispatchAndReply(message: InboundMessage): Promise<void>;
  dispatchInbound(
    message: InboundMessage,
    onChunk?: (chunk: ChatDeltaLike) => void,
  ): Promise<string>;
  deliverOutbound(
    channelInstanceId: string,
    peerId: string,
    content: string,
    replyContext?: unknown,
    options?: DeliverOutboundOptions,
  ): Promise<boolean>;
}

/** 最小 WebSocket 客户端契约（生产用 Bun/Node 全局 WebSocket，测试可注入） */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: any) => void,
    options?: { once?: boolean },
  ): void;
}

/**
 * adapter 构造依赖。所有非确定性/网络能力都可注入：
 * - 生产默认：全局 fetch / WebSocket / Date.now / setTimeout
 * - 测试：本地模拟服务与可控时钟，绝不通过环境变量给生产加旁路
 */
export interface ChannelAdapterDeps {
  runtime: ChannelDispatchRuntime;
  /** 媒体 CDN HTTP（生产默认 safeFetch；测试注入本地 fetch） */
  mediaFetch?: typeof fetch;
  wsFactory?: (url: string) => WebSocketLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** 仅测试覆盖数据目录（默认 <cwd>/.bot；防测试写进真实工作区） */
  dotBotDir?: string;
  /** 仅测试覆盖 QQ 官方地址 */
  qq?: { apiBase?: string; tokenUrl?: string };
  /** 仅测试缩短重连/限流等待 */
  tuning?: Record<string, number>;
}

export type PublicChannelFieldDescriptor = ChannelFieldDescriptor;

export type PublicChannelAuthDescriptor = Omit<ChannelAuthDescriptor, "start" | "poll">;

export interface PublicChannelTypeDescriptor
  extends Omit<
    ChannelTypeDescriptor,
    "create" | "validate" | "onDelete" | "onCredentialsChanged" | "auth" | "credentials" | "capabilities"
  > {
  credentials: ChannelFieldDescriptor[];
  capabilities: ChannelCapabilities;
  auth: PublicChannelAuthDescriptor | null;
}

/** 白名单序列化：绝不把函数/凭据值带出后端 */
export function toPublicChannelType(d: ChannelTypeDescriptor): PublicChannelTypeDescriptor {
  const {
    create: _create,
    validate: _validate,
    onDelete: _onDelete,
    onCredentialsChanged: _onCredentialsChanged,
    auth,
    ...rest
  } = d;
  return {
    ...rest,
    credentials: d.credentials.map((field) => ({ ...field })),
    capabilities: { ...d.capabilities },
    auth: auth
      ? {
          kind: auth.kind,
          label: auth.label,
          pollIntervalMs: auth.pollIntervalMs,
          hint: auth.hint,
          ...(auth.readyFields ? { readyFields: auth.readyFields } : {}),
        }
      : null,
  };
}
