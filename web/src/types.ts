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
  /** 历史数据中与其他 Agent 的工作区重叠时的诊断（只读） */
  workspaceConflict?: string;
  sandbox: SandboxConfig;
  skills: string[];
  createdAt: number;
  updatedAt: number;
}

export interface Channel {
  id: string;
  /** 渠道类型（由后端 /api/channel-types 注册表定义，前端不再枚举） */
  type: string;
  name: string;
  enabled: boolean;
  boundAgentId: string;
  credentials: Record<string, unknown>;
  updatedAt: number;
}

export type ChannelFieldType = "string" | "secret" | "boolean" | "list" | "select";

export interface ChannelFieldDescriptor {
  key: string;
  label: string;
  type: ChannelFieldType;
  required?: boolean;
  section?: "basic" | "access" | "advanced";
  options?: { value: string; label: string }[];
  placeholder?: string;
  hint?: string;
  maxItems?: number;
  defaultValue?: string | boolean | string[];
}

export interface ChannelTypeDescriptor {
  type: string;
  label: string;
  description: string;
  managedBy: "manager" | "cli";
  creatable: boolean;
  deletable: boolean;
  credentialHint?: string;
  credentials: ChannelFieldDescriptor[];
  capabilities: {
    groupChat: boolean;
    mediaInbound: string[];
    mediaOutbound: string[];
    passiveReply: boolean;
    typing: boolean;
    streaming: boolean;
    markdown: "full" | "limited" | "plain";
    maxMessageBytes: number;
  };
  auth: {
    kind: "qr";
    label: string;
    pollIntervalMs: number;
    hint?: string;
    readyFields?: string[];
  } | null;
}

export interface ChannelHealth {
  ok: boolean;
  detail?: string;
  lastInboundAt?: number;
  lastSendAt?: number;
}

export interface ChannelAuthStart {
  qrcode: string;
  qrcodeImgContent?: string;
  dataUrl?: string;
}

export interface ChannelAuthPoll {
  status: string;
  redirectHost?: string;
}

export type SkillKind = "extension" | "skill" | "mcp";

export interface Skill {
  id: string;
  name: string;
  description: string;
  category: "coding" | "search" | "utility" | "design" | "custom" | "document" | "mcp";
  builtin: boolean;
  kind: SkillKind;
  /** platform | workspace（五期） */
  scope?: "platform" | "workspace";
  ownerAgentId?: string;
  /** 内置常驻文档技能（如 skill-creator），不参与勾选 */
  autoEnabled?: boolean;
  /** kind === "mcp" 时桥接的工具数 */
  toolCount?: number;
  /** kind === "skill" 时后端附加的文档技能信息 */
  location?: string;
  bodyPreview?: string;
  warnings?: string[];
  disableModelInvocation?: boolean;
  spec?: {
    license?: string;
    compatibility?: string;
    metadata?: Record<string, string>;
    allowedTools?: string;
  };
}

export interface WorkspaceSkill {
  id: string;
  name: string;
  description: string;
  path?: string;
  warnings: string[];
  spec?: {
    license?: string;
    compatibility?: string;
    metadata?: Record<string, string>;
    allowedTools?: string;
  };
}

export interface WorkspaceSkillDiagnostic {
  skill?: string;
  path: string;
  reason: string;
}

export interface WorkspaceSkillSnapshot {
  agentId: string;
  enabled: boolean;
  roots: string[];
  skills: WorkspaceSkill[];
  diagnostics: WorkspaceSkillDiagnostic[];
  memory: {
    path: string;
    bytes: number;
    truncated: boolean;
    mtimeMs: number;
  } | null;
  scannedAt: number;
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

export type ScheduledTaskDurableState =
  | "pending"
  | "active"
  | "aborting"
  | "blocked"
  | "disabled"
  | "done"
  | "deleted"
  | "failed"
  | "poisoned";

export type ScheduledRunStatus = "running" | "ok" | "error" | "done" | "aborted";

export interface ScheduledTaskRun {
  id: string;
  taskId: string;
  runKey: string;
  scheduledFor: number;
  runNumber: number;
  scheduleVersion: number;
  requestId: string;
  status: ScheduledRunStatus;
  startedAt: number;
  endedAt?: number;
  conversationId?: string;
  durableTaskId?: string;
  attemptCount: number;
  leaseOwner?: string;
  leaseUntil?: number;
  leaseFence: number;
  result?: string;
  error?: string;
  createdAt: number;
}

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
  /* ---------------- 六期 durable 生命周期 ---------------- */
  durableTaskId?: string;
  durableState: ScheduledTaskDurableState;
  scheduleVersion: number;
  conversationId?: string;
  conversationPoisoned?: boolean;
  poisonRunKey?: string;
  poisonFence?: number;
  /** harness.inspect 的 live 状态（null = 无 live durable task） */
  liveState?: DurableTaskStateInfo | null;
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
  scheduler?: {
    mode?: "durable" | "polling";
    started: boolean;
    ready: boolean;
    inFlight: number;
    nextWakeAt?: number | null;
    tasksActive: number;
    tasksBlocked: number;
  };
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

/* ---------------- Durable 任务（1.4.0） ---------------- */

export interface DurableTaskStateInfo {
  kind: "running" | "ready" | "waiting" | "sleeping" | "completing" | "blocked";
  migrates?: boolean;
  on?: string[];
  until?: number;
  reason?: string;
}

export interface DurableTaskInfo {
  id: string;
  kind: string;
  conversationId: string;
  agentId?: string;
  state: DurableTaskStateInfo;
  restarts: number;
  startedAt?: number;
}

/* ---------------- 上下文管理与可观测性（七期） ---------------- */

export type StrategyScope = "all" | "normal" | "scheduled";

export interface GlobalContextStrategy {
  enabled: boolean;
  percent: number;
  minTokens: number;
}

export interface ScheduledHeuristicStrategy {
  enabled: boolean;
  sampleSize: number;
  multiplier: number;
  fallbackTokens: number;
  minTokens: number;
  maxPercentOfWindow: number;
}

export interface FixedContextStrategy {
  enabled: boolean;
  tokens: number;
  minTokens: number;
  scope: StrategyScope;
}

export interface IdleContextStrategy {
  enabled: boolean;
  idleHours: number;
  minTokens: number;
}

export interface ContextStrategies {
  global: GlobalContextStrategy;
  scheduledHeuristic: ScheduledHeuristicStrategy;
  fixed: FixedContextStrategy;
  idle: IdleContextStrategy;
}

export interface ContextPolicy {
  strategies: ContextStrategies;
  safetyTokens: number;
  keepRecentCapTokens: number;
  emergencyReserveCapTokens: number;
  timeoutMs: number;
  settleTimeoutMs: number;
  retentionDays: number;
  detailRetentionDays: number;
}

export interface EffectiveContextThreshold {
  providerId: string;
  modelId: string;
  contextWindow: number;
  keepRecentTokens: number;
  globalThreshold: number;
  scheduledFallbackThreshold: number;
  fixedThreshold: number;
  idleHours: number;
}

export interface ContextPolicyResponse {
  policy: ContextPolicy;
  effective: EffectiveContextThreshold[];
  catalogFetchedAt?: number;
}

export interface ContextSessionRow {
  conversationId: string;
  agentId: string;
  agentName?: string;
  sessionId: string;
  sessionKind: "normal" | "scheduled";
  schedulerTaskId?: string;
  schedulerTaskName?: string;
  channelType?: string;
  label?: string;
  provider?: string;
  modelId?: string;
  contextTokens?: number;
  contextWindow?: number;
  fillRatio?: number;
  turns: number;
  costUsd: number;
  priced: boolean;
  lastActiveAt: number;
  compactions: number;
  status?: string;
}

export interface ContextTurn {
  turnId: string;
  conversationId: string;
  agentId: string;
  sessionId: string;
  sessionKind: string;
  schedulerTaskId?: string;
  provider?: string;
  modelId?: string;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  firstChunkMs?: number;
  ttftMs?: number;
  llmMs?: number;
  toolMs?: number;
  requestCount: number;
  toolCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  reasoningTokens: number;
  costUsd: number;
  priced: boolean;
  contextTokens?: number;
  contextEstimateTokens?: number;
  contextWindow?: number;
  compactedBefore: boolean;
  compactionMs: number;
  status: string;
  error?: string;
  requestId?: string;
  runKey?: string;
  traceId?: string;
  detailTruncated: boolean;
}

export interface ContextRequest {
  spanId: string;
  turnId?: string;
  conversationId?: string;
  traceId?: string;
  parentSpanId?: string;
  kind: "request" | "poll";
  taskKind?: "generation" | "compaction" | "tool";
  compactionId?: string;
  provider?: string;
  modelId?: string;
  api?: string;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  firstChunkMs?: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  reasoningTokens: number;
  costUsd: number;
  stopReason?: string;
  status: string;
  error?: string;
}

export interface ContextTool {
  turnId?: string;
  conversationId?: string;
  traceId?: string;
  taskId?: string;
  toolCallId?: string;
  toolName: string;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  status: string;
  error?: string;
}

export interface CompactionEvent {
  conversationId: string;
  agentId?: string;
  sessionId?: string;
  turnId?: string;
  taskId?: string;
  traceId?: string;
  compactionId?: string;
  profile: "normal" | "scheduled" | "manual";
  trigger:
    | "pre_turn"
    | "pre_turn_global"
    | "pre_turn_scheduled"
    | "pre_turn_fixed"
    | "pre_turn_idle"
    | "manual"
    | "threshold"
    | "overflow";
  thresholdTokens?: number;
  keepRecentTokens?: number;
  beforeTokens?: number;
  afterTokens?: number;
  beforeEstimateTokens?: number;
  afterEstimateTokens?: number;
  beforeEntries?: number;
  afterEntries?: number;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  costUsd?: number;
  costInTurn: boolean;
  requestCount: number;
  status: string;
  failOpen: boolean;
  error?: string;
}

export interface ContextSessionTurns {
  conversationId: string;
  turns: ContextTurn[];
  total: number;
  compactions: CompactionEvent[];
}

export interface ContextTurnDetail {
  turn: ContextTurn;
  requests: ContextRequest[];
  tools: ContextTool[];
  compactions: CompactionEvent[];
}

export interface ModelMetadataReference {
  providerId: string;
  providerName?: string;
  modelId: string;
  displayName?: string;
  matchedAt: number;
}

export interface ModelMetadataRow {
  providerId: string;
  providerName: string;
  protocol: string;
  modelId: string;
  displayName?: string;
  contextWindow: number;
  maxOutputTokens: number;
  inputModalities: string[];
  outputModalities: string[];
  reasoning: boolean;
  toolCall: boolean;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costTiers: { inputTokensAbove: number; input: number; output: number; cacheRead: number; cacheWrite: number }[];
  source: string;
  priced: boolean;
  auto: Record<string, unknown> | null;
  autoSource?: string | null;
  manual: Record<string, unknown> | null;
  reference?: ModelMetadataReference | null;
  matchedProvider?: string;
  matchedModel?: string;
}

export interface ModelMetadataCandidate {
  providerKey: string;
  providerName?: string;
  modelKey: string;
  displayName?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  inputModalities?: string[];
  outputModalities?: string[];
  reasoning?: boolean;
  toolCall?: boolean;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costTiers?: { inputTokensAbove: number; input: number; output: number; cacheRead: number; cacheWrite: number }[];
  priced: boolean;
  canonicalModelId?: string;
  match: "exact" | "normalized";
  preferredProvider: boolean;
}

export interface ModelMetadataCandidatesResponse {
  candidates: ModelMetadataCandidate[];
  total: number;
  catalog: { fetchedAt: number; lastCheckedAt: number; providerCount: number; modelCount: number } | null;
}

export interface ModelMetadataResponse {
  models: ModelMetadataRow[];
  catalog: { fetchedAt: number; lastCheckedAt: number; providerCount: number; modelCount: number } | null;
}

export interface ModelMetadataOverride {
  displayName?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  inputModalities?: string[];
  outputModalities?: string[];
  reasoning?: boolean;
  toolCall?: boolean;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costTiers?: { inputTokensAbove: number; input: number; output: number; cacheRead: number; cacheWrite: number }[];
}
