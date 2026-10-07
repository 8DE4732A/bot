/** 与后端 DatabaseStore / server.ts 的 JSON 载荷对齐的共享类型（仅前端侧副本） */

export type ModelProtocol = "openai-completions" | "openai-responses" | "anthropic-messages" | "google";

export interface ModelProvider {
  id: string;
  name: string;
  protocol: ModelProtocol;
  apiBase: string;
  /** 脱敏掩码 (••••尾4), 明文永不回传; 提交时空值表示保留已存密钥 */
  apiKey: string;
  hasApiKey?: boolean;
  models: string[];
  createdAt: number;
  updatedAt: number;
}

export interface SandboxConfig {
  enabled: boolean;
  network: {
    allowedDomains: string[];
    deniedDomains: string[];
    allowLocalBinding?: boolean;
  };
  filesystem: {
    allowWrite: string[];
    denyRead: string[];
    denyWrite: string[];
  };
}

export interface Agent {
  id: string;
  name: string;
  description?: string;
  model: {
    provider: string;
    modelId: string;
    temperature: number;
    thinkingLevel: "low" | "medium" | "high";
  };
  instructions: string;
  workspaceDir: string;
  sandbox: SandboxConfig;
  skills: string[];
  createdAt: number;
  updatedAt: number;
}

export interface Channel {
  id: string;
  type: "terminal" | "wecom" | "weixin" | "qq" | "feishu" | "telegram";
  name: string;
  enabled: boolean;
  boundAgentId: string;
  credentials: Record<string, unknown>;
  updatedAt: number;
}

export interface ChannelHealth {
  ok: boolean;
  detail?: string;
}

export interface WeixinQrLogin {
  qrcode: string;
  qrcodeImgContent: string;
  dataUrl?: string;
}

export type SkillKind = "extension" | "skill" | "mcp";

export interface Skill {
  id: string;
  name: string;
  description: string;
  category: "coding" | "search" | "utility" | "design" | "custom" | "document" | "mcp";
  builtin: boolean;
  kind: SkillKind;
  /** kind === "mcp" 时桥接的工具数 */
  toolCount?: number;
  /** kind === "skill" 时后端附加的文档技能信息 */
  location?: string;
  bodyPreview?: string;
  warnings?: string[];
  disableModelInvocation?: boolean;
}

export type McpTransport = "stdio" | "http";
export type McpExposure = "direct" | "hidden";

export interface McpServer {
  id: string;
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  /** 脱敏掩码 (••••), 明文永不回传; 提交时掩码值表示保留已存值 */
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  description?: string;
  exposure: McpExposure;
  /** 工具名或通配模式 → direct/hidden (精确名优先于模式) */
  toolExposure?: Record<string, McpExposure>;
  enabled: boolean;
  updatedAt: number;
}

export type ScheduleType = "once" | "every" | "cron";

export interface ScheduledTask {
  id: string;
  agentId: string;
  name: string;
  prompt: string;
  scheduleType: ScheduleType;
  runAt?: number;
  intervalSeconds?: number;
  cronExpr?: string;
  enabled: boolean;
  deletedAt?: number;
  nextRunAt?: number;
  lastRunAt?: number;
  lastStatus?: string;
  lastResult?: string;
  runCount: number;
  /** 通知目标 (创建任务的会话所在渠道; 会话重置不影响投递) */
  notifyChannelInstanceId?: string;
  notifyPeerId?: string;
  notifyEnabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface AuditLog {
  id: number;
  agentId?: string | null;
  channelInstanceId?: string | null;
  eventType: string;
  details: string;
  createdAt: number;
}

export interface SystemStatus {
  uptime: number;
  cwd: string;
  platform: string;
  stats: {
    agentsCount: number;
    channelsCount: number;
    providersCount: number;
    auditCount: number;
  };
  memoryMb: number;
}

/** SSE 流式对话的 chunk（对应后端 AgentManager.ChatChunk） */
export interface ChatChunk {
  delta?: string;
  toolCall?: {
    name: string;
    status: string;
  };
  /** 命令结果的结构化数据透传 (/agent <id> 的 switchTo 等, R2 评审 B7) */
  data?: { switchTo?: string };
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    contextTokens: number;
    contextWindow: number;
    cacheHitRate?: number;
    costTotal: number;
    durationMs: number;
    reasoning?: number;
  };
  error?: string;
}

/* ---------------- 会话浏览（四期 §6.2 #1） ---------------- */

export interface SessionRow {
  channelInstanceId: string;
  peerId: string;
  agentId: string;
  conversationId: string;
  createdAt: number;
  lastActiveAt: number;
}

export interface SessionMessage {
  role: "user" | "assistant" | "tool" | "handoff";
  text: string;
  toolName?: string;
  seq: number;
}

export interface SessionHistory {
  conversationId: number;
  messages: SessionMessage[];
  truncated: boolean;
}

export interface SessionSearchHit {
  conversationId: number;
  snippet: string;
}

/** 审计过滤分页响应（四期 §6.2 #4） */
export interface AuditPage {
  items: AuditLog[];
  total: number;
}
