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
  type: "terminal" | "wecom" | "weixin" | "qq";
  name: string;
  enabled: boolean;
  boundAgentId: string;
  credentials: Record<string, unknown>;
  updatedAt: number;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  category: "coding" | "search" | "utility" | "design" | "custom";
  builtin: boolean;
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
  error?: string;
}
