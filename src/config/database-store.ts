import { DatabaseManager } from "../database/index.ts";
import { EventBus } from "../core/event-bus.ts";
import { LAST_RESULT_MAX_CHARS } from "../scheduler/schedule.ts";
import { logger } from "../utils/logger.ts";
import { normalizeSandbox } from "./sandbox-defaults.ts";

/**
 * 内部会话映射的哨兵渠道 id（非真实渠道实例）：AgentManager 用它记录
 * `${agentId}:${sessionId}` 形态的映射，真实渠道行优先于它。
 */
export const INTERNAL_MAPPING_CHANNEL = "channel_session";

export type ModelProtocol = "openai-completions" | "openai-responses" | "anthropic-messages" | "google";

export interface ModelProviderDefinition {
  id: string;
  name: string;
  protocol: ModelProtocol;
  apiBase: string;
  apiKey: string;
  models: string[];
  createdAt: number;
  updatedAt: number;
}

export interface BotSandboxConfig {
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

export interface AgentDefinition {
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
  sandbox: BotSandboxConfig;
  skills: string[];
  createdAt: number;
  updatedAt: number;
}

export interface ChannelInstanceConfig {
  id: string;
  /** 渠道类型（注册表 key；合法性由 ChannelRegistry 在 API 边界校验） */
  type: string;
  name: string;
  enabled: boolean;
  boundAgentId: string;
  credentials: Record<string, any>;
  updatedAt: number;
}

export interface ChannelSession {
  channelInstanceId: string;
  peerId: string;
  agentId: string;
  conversationId: string;
  createdAt: number;
  lastActiveAt: number;
}

export interface AuditLogEntry {
  id?: number;
  agentId?: string;
  channelInstanceId?: string;
  eventType: string;
  details: string;
  createdAt: number;
}

export interface McpServerDefinition {
  id: string;
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  /** MCP server 进程需要的环境变量——bash 最小环境白名单不含它们, 必须显式配置 */
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  description?: string;
  /** direct = 工具声明给模型; hidden = 注册但不暴露 (留作观察/手动启用) */
  exposure: "direct" | "hidden";
  /** per-tool 覆盖: 工具名或通配模式 → direct/hidden (精确名优先于模式) */
  toolExposure?: Record<string, "direct" | "hidden">;
  enabled: boolean;
  updatedAt: number;
}

export type ScheduleType = "once" | "every" | "cron";

/** 六期：scheduler durable 生命周期声明状态（API 会与 harness.inspect 的 live 状态组合） */
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

export interface ScheduledTaskRunRecord {
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

export interface ScheduledNotificationRecord {
  runId: string;
  taskId: string;
  payload: string;
  status: "pending" | "sending" | "delivered" | "failed";
  attempts: number;
  nextAttemptAt?: number;
  lastError?: string;
  claimedBy?: string;
  claimToken?: string;
  claimedAt?: number;
  claimedUntil?: number;
  deliveredAt?: number;
  createdAt: number;
}

export type ReserveScheduledRunResult =
  | { kind: "reserved"; run: ScheduledTaskRunRecord; task: ScheduledTaskDefinition }
  | { kind: "existing"; run: ScheduledTaskRunRecord; task: ScheduledTaskDefinition; active: boolean }
  | { kind: "busy"; run: ScheduledTaskRunRecord }
  | { kind: "superseded"; reason: string };

export interface FinishScheduledRunResult {
  ok: boolean;
  reason?: "settled" | "fence_lost";
  taskChanged?: boolean;
}

/** outbox payload 上限（与 schema CHECK 一致；字段已在 build 时截断） */

/**
 * 通知 payload 是不可变快照：先截断字段再序列化（各字段上限合计远小于
 * 64KB schema CHECK，无需二级 fallback）。
 */
function buildNotificationPayload(input: {
  run: ScheduledTaskRunRecord;
  task: ScheduledTaskDefinition;
  status: "ok" | "error" | "done" | "aborted";
  result?: string;
  error?: string;
}): string {
  const { run, task } = input;
  const source = run.runKey.startsWith("manual:") ? "manual" : "schedule";
  return JSON.stringify({
    runId: run.id,
    runNumber: run.runNumber,
    taskId: run.taskId,
    taskName: task.name.slice(0, 200),
    agentId: task.agentId.slice(0, 200),
    status: input.status,
    source,
    result: (input.result ?? "").slice(0, LAST_RESULT_MAX_CHARS),
    error: input.error ? input.error.slice(0, LAST_RESULT_MAX_CHARS) : undefined,
    target:
      task.notifyChannelInstanceId && task.notifyPeerId
        ? {
            channelInstanceId: task.notifyChannelInstanceId.slice(0, 200),
            peerId: task.notifyPeerId.slice(0, 500),
          }
        : null,
  });
}

export interface ScheduledTaskDefinition {
  id: string;
  /** 创建任务的 Agent——触发会话以此 Agent 的配置执行; 工具归属校验的依据 */
  agentId: string;
  name: string;
  /** 触发时发送给 Agent 的消息 */
  prompt: string;
  scheduleType: ScheduleType;
  /** once: 触发时间戳 (ms) */
  runAt?: number;
  /** every: 重复间隔秒 (最小 60) */
  intervalSeconds?: number;
  /** cron: 标准 5 字段表达式 (本地时区) */
  cronExpr?: string;
  enabled: boolean;
  /** 逻辑删除时间戳 (ms); 非 null 即不可见/不触发 */
  deletedAt?: number;
  nextRunAt?: number;
  lastRunAt?: number;
  /** ok | error | done (once 任务完成) */
  lastStatus?: string;
  /** 最近一次执行的回答摘要 (截断) */
  lastResult?: string;
  runCount: number;
  /**
   * 通知目标 (创建任务的会话所在渠道, 渠道层寻址与会话无关——会话重置不影响):
   * 触发完成后由 NotificationDispatcher 经 ChannelManager 推送到该渠道该 peer;
   * 未记录 (如在 Web Playground 创建) 时 fallback 到 Agent 绑定的终端类渠道
   */
  notifyChannelInstanceId?: string;
  notifyPeerId?: string;
  /** false = 触发结果不推送渠道 (仍记录在任务上) */
  notifyEnabled: boolean;
  /** 六期：关联的 durable task id（numeric TaskId 的文本形态） */
  durableTaskId?: string;
  /** 六期：SchedulerRuntime 持久化的声明状态 */
  durableState: ScheduledTaskDurableState;
  /** 六期：只在调度字段/enabled 变化时递增；runKey 代际校验 */
  scheduleVersion: number;
  /** 六期：scheduler:<taskId> 的持久 conversation（首次 run 写入） */
  conversationId?: string;
  /** 六期：连续取消失败后的 poisoned 标记（禁止自动复用/重建） */
  conversationPoisoned?: boolean;
  poisonRunKey?: string;
  poisonFence?: number;
  createdAt: number;
  updatedAt: number;
}

// --- 七期：上下文管理与可观测性 ---

export interface ModelCostRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelCostTier extends ModelCostRates {
  inputTokensAbove: number;
}

export interface ModelMetadataReference {
  /** models.dev 的 provider key（非本地 provider id） */
  providerId: string;
  providerName?: string;
  /** models.dev 的 model key */
  modelId: string;
  displayName?: string;
  matchedAt: number;
}

export interface ModelMetadataValues {
  displayName?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  inputModalities?: string[];
  outputModalities?: string[];
  reasoning?: boolean;
  toolCall?: boolean;
  cost?: ModelCostRates;
  costTiers?: ModelCostTier[];
  /** 手动值来自用户选择的目录参考条目时记录来源（仅 manual_json） */
  reference?: ModelMetadataReference;
}

export type ModelMetadataSource = "models.dev" | "builtin" | "fallback";

export interface ModelMetadataRecord {
  providerId: string;
  modelId: string;
  auto: ModelMetadataValues | null;
  autoSource?: ModelMetadataSource;
  manual: Partial<ModelMetadataValues> | null;
  matchedProvider?: string;
  matchedModel?: string;
  refreshedAt?: number;
  updatedAt: number;
}

export interface ModelCatalogCacheRecord {
  payload: Buffer;
  etag?: string;
  lastModified?: string;
  fetchedAt: number;
  lastCheckedAt: number;
  providerCount: number;
  modelCount: number;
}

export type LlmTurnStatus = "running" | "done" | "error" | "aborted" | "interrupted";
export type SessionKind = "normal" | "scheduled";

export interface LlmTurnRecord {
  turnId: string;
  conversationId: string;
  agentId: string;
  sessionId: string;
  sessionKind: SessionKind;
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
  usageJson?: string;
  contextTokens?: number;
  contextEstimateTokens?: number;
  contextWindow?: number;
  compactedBefore: boolean;
  compactionMs: number;
  status: LlmTurnStatus;
  error?: string;
  requestId?: string;
  runKey?: string;
  traceId?: string;
  submissionId?: string;
  detailTruncated: boolean;
}

export interface LlmRequestRecord {
  spanId: string;
  turnId?: string;
  conversationId?: string;
  traceId?: string;
  parentSpanId?: string;
  taskId?: string;
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
  status: "ok" | "error" | "aborted";
  error?: string;
}

export interface ToolInvocationRecord {
  turnId?: string;
  conversationId?: string;
  traceId?: string;
  taskId?: string;
  toolCallId?: string;
  toolName: string;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  status: "ok" | "error" | "aborted";
  error?: string;
}

export type CompactionTrigger =
  | "pre_turn"
  | "pre_turn_global"
  | "pre_turn_scheduled"
  | "pre_turn_fixed"
  | "pre_turn_idle"
  | "manual"
  | "threshold"
  | "overflow";
export type CompactionStatus = "done" | "skipped" | "failed" | "timeout" | "aborted";

export interface CompactionEventRecord {
  id?: number;
  conversationId: string;
  agentId?: string;
  sessionId?: string;
  turnId?: string;
  taskId?: string;
  traceId?: string;
  compactionId?: string;
  profile: "normal" | "scheduled" | "manual";
  trigger: CompactionTrigger;
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
  status: CompactionStatus;
  failOpen: boolean;
  error?: string;
}

export interface ContextSessionRow {
  conversationId: string;
  agentId: string;
  agentName?: string;
  sessionId: string;
  sessionKind: SessionKind;
  schedulerTaskId?: string;
  schedulerTaskName?: string;
  channelType?: string;
  channelName?: string;
  provider?: string;
  modelId?: string;
  contextTokens?: number;
  contextWindow?: number;
  turns: number;
  costUsd: number;
  priced: boolean;
  lastActiveAt: number;
  compactions: number;
  status?: string;
}

export class DatabaseStore {
  private db: DatabaseManager;

  constructor(db?: DatabaseManager) {
    this.db = db || DatabaseManager.getInstance();
  }

  // --- System Config ---
  public getConfig(key: string, defaultValue = ""): string {
    const row = this.db.queryOne<{ value: string }>(
      "SELECT value FROM system_config WHERE key = ?",
      key,
    );
    return row ? row.value : defaultValue;
  }

  public setConfig(key: string, value: string): void {
    const now = Date.now();
    this.db.run(
      "INSERT INTO system_config (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      key,
      value,
      now,
    );
  }

  public getAllConfigs(): Record<string, string> {
    const rows = this.db.query<{ key: string; value: string }>(
      "SELECT key, value FROM system_config",
    );
    const result: Record<string, string> = {};
    for (const r of rows) {
      result[r.key] = r.value;
    }
    return result;
  }

  // --- BYOK Model Providers ---
  public listModelProviders(): ModelProviderDefinition[] {
    const rows = this.db.query<any>("SELECT * FROM model_providers ORDER BY created_at ASC");
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      protocol: r.protocol,
      apiBase: r.api_base,
      apiKey: r.api_key,
      models: JSON.parse(r.models || "[]"),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  public getModelProvider(id: string): ModelProviderDefinition | undefined {
    const r = this.db.queryOne<any>("SELECT * FROM model_providers WHERE id = ?", id);
    if (!r) return undefined;
    return {
      id: r.id,
      name: r.name,
      protocol: r.protocol,
      apiBase: r.api_base,
      apiKey: r.api_key,
      models: JSON.parse(r.models || "[]"),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  public saveModelProvider(provider: ModelProviderDefinition): void {
    const now = Date.now();
    this.db.run(
      `INSERT INTO model_providers (
        id, name, protocol, api_base, api_key, models, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        protocol = excluded.protocol,
        api_base = excluded.api_base,
        api_key = excluded.api_key,
        models = excluded.models,
        updated_at = excluded.updated_at`,
      provider.id,
      provider.name,
      provider.protocol,
      provider.apiBase,
      provider.apiKey,
      JSON.stringify(provider.models || []),
      provider.createdAt || now,
      now,
    );
  }

  public deleteModelProvider(id: string): boolean {
    const inUse = this.db.queryOne<{ count: number }>(
      "SELECT COUNT(*) as count FROM agents WHERE model_provider = ?",
      id,
    );
    if (inUse && inUse.count > 0) {
      throw new Error(`Provider '${id}' is still referenced by ${inUse.count} agent(s); rebind them first`);
    }
    this.db.transaction(() => {
      this.db.run("DELETE FROM model_providers WHERE id = ?", id);
      this.db.run("DELETE FROM model_metadata WHERE provider_id = ?", id);
    });
    return true;
  }

  // --- 七期：模型目录缓存与 per-model 元数据 ---

  private parseJsonOrNull<T>(value: unknown): T | null {
    if (typeof value !== "string" || value.length === 0) return null;
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }

  public getModelCatalogCache(): ModelCatalogCacheRecord | undefined {
    const row = this.db.queryOne<any>("SELECT * FROM model_catalog_cache WHERE id = 1");
    if (!row) return undefined;
    return {
      payload: Buffer.isBuffer(row.payload_gz) ? row.payload_gz : Buffer.from(row.payload_gz),
      etag: row.etag ?? undefined,
      lastModified: row.last_modified ?? undefined,
      fetchedAt: row.fetched_at,
      lastCheckedAt: row.last_checked_at,
      providerCount: row.provider_count,
      modelCount: row.model_count,
    };
  }

  /** 只取元信息（不读 payload_gz BLOB）：TTL/界面状态用。 */
  public getModelCatalogMeta():
    | { fetchedAt: number; lastCheckedAt: number; providerCount: number; modelCount: number }
    | undefined {
    const row = this.db.queryOne<any>(
      "SELECT fetched_at, last_checked_at, provider_count, model_count FROM model_catalog_cache WHERE id = 1",
    );
    if (!row) return undefined;
    return {
      fetchedAt: row.fetched_at,
      lastCheckedAt: row.last_checked_at,
      providerCount: row.provider_count,
      modelCount: row.model_count,
    };
  }

  public saveModelCatalogCache(record: ModelCatalogCacheRecord): void {
    this.db.run(
      `INSERT INTO model_catalog_cache (
        id, payload_gz, etag, last_modified, fetched_at, last_checked_at, provider_count, model_count
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        payload_gz = excluded.payload_gz,
        etag = excluded.etag,
        last_modified = excluded.last_modified,
        fetched_at = excluded.fetched_at,
        last_checked_at = excluded.last_checked_at,
        provider_count = excluded.provider_count,
        model_count = excluded.model_count`,
      record.payload,
      record.etag ?? null,
      record.lastModified ?? null,
      record.fetchedAt,
      record.lastCheckedAt,
      record.providerCount,
      record.modelCount,
    );
  }

  private mapModelMetadataRow(row: any): ModelMetadataRecord {
    return {
      providerId: row.provider_id,
      modelId: row.model_id,
      auto: this.parseJsonOrNull<ModelMetadataValues>(row.auto_json),
      autoSource: row.auto_source ?? undefined,
      manual: this.parseJsonOrNull<Partial<ModelMetadataValues>>(row.manual_json),
      matchedProvider: row.matched_provider ?? undefined,
      matchedModel: row.matched_model ?? undefined,
      refreshedAt: row.refreshed_at ?? undefined,
      updatedAt: row.updated_at,
    };
  }

  public listModelMetadata(providerId?: string): ModelMetadataRecord[] {
    const rows = providerId
      ? this.db.query<any>("SELECT * FROM model_metadata WHERE provider_id = ? ORDER BY model_id", providerId)
      : this.db.query<any>("SELECT * FROM model_metadata ORDER BY provider_id, model_id");
    return rows.map((row) => this.mapModelMetadataRow(row));
  }

  public getModelMetadata(providerId: string, modelId: string): ModelMetadataRecord | undefined {
    const row = this.db.queryOne<any>(
      "SELECT * FROM model_metadata WHERE provider_id = ? AND model_id = ?",
      providerId,
      modelId,
    );
    return row ? this.mapModelMetadataRow(row) : undefined;
  }

  public saveModelMetadata(record: ModelMetadataRecord): void {
    this.db.run(
      `INSERT INTO model_metadata (
        provider_id, model_id, auto_json, auto_source, manual_json,
        matched_provider, matched_model, refreshed_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider_id, model_id) DO UPDATE SET
        auto_json = excluded.auto_json,
        auto_source = excluded.auto_source,
        manual_json = excluded.manual_json,
        matched_provider = excluded.matched_provider,
        matched_model = excluded.matched_model,
        refreshed_at = excluded.refreshed_at,
        updated_at = excluded.updated_at`,
      record.providerId,
      record.modelId,
      record.auto ? JSON.stringify(record.auto) : null,
      record.autoSource ?? null,
      record.manual && Object.keys(record.manual).length > 0 ? JSON.stringify(record.manual) : null,
      record.matchedProvider ?? null,
      record.matchedModel ?? null,
      record.refreshedAt ?? null,
      record.updatedAt,
    );
  }

  /** 批量元数据写入：refresh 时数百个模型共用一个事务，避免逐条 fsync。 */
  public saveModelMetadataBatch(records: ModelMetadataRecord[]): void {
    if (records.length === 0) return;
    this.db.transaction(() => {
      for (const record of records) this.saveModelMetadata(record);
    });
  }

  public deleteModelMetadata(providerId: string, modelId?: string): void {
    if (modelId === undefined) {
      this.db.run("DELETE FROM model_metadata WHERE provider_id = ?", providerId);
    } else {
      this.db.run("DELETE FROM model_metadata WHERE provider_id = ? AND model_id = ?", providerId, modelId);
    }
  }

  /** 删除 provider 已不再声明的模型元数据（agent 绑定仍算声明，调用方合并后传入）。 */
  public pruneModelMetadata(providerId: string, keepModelIds: string[]): number {
    const existing = this.listModelMetadata(providerId).map((r) => r.modelId);
    const keep = new Set(keepModelIds);
    const stale = existing.filter((id) => !keep.has(id));
    if (stale.length === 0) return 0;
    for (const modelId of stale) this.deleteModelMetadata(providerId, modelId);
    return stale.length;
  }

  // --- Agents ---
  public listAgents(): AgentDefinition[] {
    const rows = this.db.query<any>("SELECT * FROM agents ORDER BY created_at ASC");
    return rows.map(this.mapAgentRow);
  }

  public getAgent(id: string): AgentDefinition | undefined {
    const row = this.db.queryOne<any>("SELECT * FROM agents WHERE id = ?", id);
    return row ? this.mapAgentRow(row) : undefined;
  }

  public saveAgent(agent: AgentDefinition): void {
    const now = Date.now();
    this.db.run(
      `INSERT INTO agents (
        id, name, description, model_provider, model_id,
        temperature, thinking_level, instructions,
        workspace_dir, sandbox_config, skills_config,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        model_provider = excluded.model_provider,
        model_id = excluded.model_id,
        temperature = excluded.temperature,
        thinking_level = excluded.thinking_level,
        instructions = excluded.instructions,
        workspace_dir = excluded.workspace_dir,
        sandbox_config = excluded.sandbox_config,
        skills_config = excluded.skills_config,
        updated_at = excluded.updated_at`,
      agent.id,
      agent.name,
      agent.description || "",
      agent.model.provider,
      agent.model.modelId,
      agent.model.temperature ?? 0.7,
      agent.model.thinkingLevel ?? "medium",
      agent.instructions,
      agent.workspaceDir,
      JSON.stringify(normalizeSandbox(agent.sandbox)),
      JSON.stringify(agent.skills ?? []),
      agent.createdAt || now,
      now,
    );
  }

  /** 删除前置校验（保留项/渠道绑定）；需要在副作用（如归档工作区）之前单独调用。 */
  public assertAgentDeletable(id: string): void {
    if (id === "agent-default") {
      throw new Error("Cannot delete default agent");
    }
    const bound = this.db.queryOne<{ count: number }>(
      "SELECT COUNT(*) as count FROM channel_instances WHERE bound_agent_id = ?",
      id,
    );
    if (bound && bound.count > 0) {
      throw new Error(`Agent '${id}' is still bound to ${bound.count} channel(s); rebind them first`);
    }
  }

  public deleteAgent(id: string): boolean {
    this.assertAgentDeletable(id);
    // 级联停掉该 Agent 的定时任务: 否则任务按周期触发 → chat 找不到 agent →
    // 每周期 error 审计 + 失败通知循环骚扰 (孤儿任务)。级联在单事务内原子完成
    this.db.transaction(() => {
      this.db.run(
        "UPDATE scheduled_tasks SET deleted_at = ?, enabled = 0, updated_at = ? WHERE agent_id = ? AND deleted_at IS NULL",
        Date.now(),
        Date.now(),
        id,
      );
      this.db.run("DELETE FROM agents WHERE id = ?", id);
      this.db.run("DELETE FROM channel_sessions WHERE agent_id = ?", id);
    });
    return true;
  }

  private mapAgentRow(row: any): AgentDefinition {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      model: {
        provider: row.model_provider,
        modelId: row.model_id,
        temperature: row.temperature,
        thinkingLevel: row.thinking_level,
      },
      instructions: row.instructions,
      workspaceDir: row.workspace_dir,
      sandbox: normalizeSandbox(JSON.parse(row.sandbox_config || "{}")),
      skills: JSON.parse(row.skills_config || "[]"),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // --- Channel Instances ---
  public listChannels(): ChannelInstanceConfig[] {
    const rows = this.db.query<any>("SELECT * FROM channel_instances ORDER BY updated_at DESC");
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      name: r.name,
      enabled: Boolean(r.enabled),
      boundAgentId: r.bound_agent_id,
      credentials: JSON.parse(r.credentials || "{}"),
      updatedAt: r.updated_at,
    }));
  }

  public getChannel(id: string): ChannelInstanceConfig | undefined {
    const r = this.db.queryOne<any>("SELECT * FROM channel_instances WHERE id = ?", id);
    if (!r) return undefined;
    return {
      id: r.id,
      type: r.type,
      name: r.name,
      enabled: Boolean(r.enabled),
      boundAgentId: r.bound_agent_id,
      credentials: JSON.parse(r.credentials || "{}"),
      updatedAt: r.updated_at,
    };
  }

  public saveChannel(channel: ChannelInstanceConfig): void {
    const now = Date.now();
    this.db.run(
      `INSERT INTO channel_instances (
        id, type, name, enabled, bound_agent_id, credentials, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        enabled = excluded.enabled,
        bound_agent_id = excluded.bound_agent_id,
        credentials = excluded.credentials,
        updated_at = excluded.updated_at`,
      channel.id,
      channel.type,
      channel.name,
      channel.enabled ? 1 : 0,
      channel.boundAgentId,
      JSON.stringify(channel.credentials || {}),
      now,
    );
  }

  public deleteChannel(id: string): boolean {
    if (id === "terminal-main") {
      throw new Error("Cannot delete primary terminal channel");
    }
    this.db.run("DELETE FROM channel_instances WHERE id = ?", id);
    this.db.run("DELETE FROM channel_sessions WHERE channel_instance_id = ?", id);
    return true;
  }

  // --- Channel Sessions ---
  public getSession(channelInstanceId: string, peerId: string): ChannelSession | undefined {
    const r = this.db.queryOne<any>(
      "SELECT * FROM channel_sessions WHERE channel_instance_id = ? AND peer_id = ?",
      channelInstanceId,
      peerId,
    );
    if (!r) return undefined;
    return {
      channelInstanceId: r.channel_instance_id,
      peerId: r.peer_id,
      agentId: r.agent_id,
      conversationId: r.conversation_id,
      createdAt: r.created_at,
      lastActiveAt: r.last_active_at,
    };
  }

  /** 按会话库 conversationId 反查归属 Agent (env 回调 fail-closed 用) */
  public getAgentIdByConversation(conversationId: string): string | undefined {
    const row = this.db.queryOne<{ agent_id: string }>(
      "SELECT agent_id FROM channel_sessions WHERE conversation_id = ? ORDER BY last_active_at DESC LIMIT 1",
      conversationId,
    );
    return row?.agent_id;
  }

  /**
   * 按会话库 conversationId 反查完整渠道映射 (定时任务通知寻址用)。
   * 同一 conversation 可能有两行 (真实渠道行 + AgentManager 内部哨兵行),
   * 真实渠道行优先——通知要送达真实渠道。
   */
  public getSessionByConversation(conversationId: string): ChannelSession | undefined {
    const r = this.db.queryOne<any>(
      `SELECT * FROM channel_sessions WHERE conversation_id = ?
       ORDER BY (channel_instance_id = 'channel_session') ASC, last_active_at DESC LIMIT 1`,
      conversationId,
    );
    if (!r) return undefined;
    return {
      channelInstanceId: r.channel_instance_id,
      peerId: r.peer_id,
      agentId: r.agent_id,
      conversationId: r.conversation_id,
      createdAt: r.created_at,
      lastActiveAt: r.last_active_at,
    };
  }

  public saveSession(session: ChannelSession): void {
    const now = Date.now();
    this.db.run(
      `INSERT INTO channel_sessions (
        channel_instance_id, peer_id, agent_id, conversation_id, created_at, last_active_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(channel_instance_id, peer_id) DO UPDATE SET
        agent_id = excluded.agent_id,
        conversation_id = excluded.conversation_id,
        last_active_at = excluded.last_active_at`,
      session.channelInstanceId,
      session.peerId,
      session.agentId,
      session.conversationId,
      session.createdAt || now,
      now,
    );
  }

  /**
   * 全部会话映射 (管理台会话浏览页; 最近活跃优先)。
   * 同一 conversation 可能有多行 (真实渠道行 + 'channel_session' 哨兵行):
   * 真实渠道行优先; **无真实渠道行的会话 (web-playground/scheduler, R2 评审
   * B8) 提升哨兵行为展示行**——channelInstanceId/peerId 改写为 sessionId
   * 首段来源 (web-playground / scheduler), 前端来源徽章可正确着色。
   */
  public listSessions(): ChannelSession[] {
    // 去重后再截断 (R3 评审 M-3: 哨兵+真实行成对存在, SQL 先 LIMIT 会把
    // 真实行截掉只剩哨兵)——全量取行 (映射行总量有限), 分组后截 500
    const rows = this.db.query<any>(
      // 上界防全表扫描失控 (R5 评审 M-6); 超大部署的分页记 backlog
      `SELECT * FROM channel_sessions ORDER BY last_active_at DESC LIMIT 5000`,
    );
    // 按 conversation 分组, 真实渠道行优先 (哨兵行兜底)——不能先到先得:
    // 同 last_active_at 的插入序不定 (R2 评审回归实测踩坑)
    const byConversation = new Map<string, any>();
    for (const r of rows) {
      const convId = String(r.conversation_id);
      const existing = byConversation.get(convId);
      if (!existing || (existing.channel_instance_id === "channel_session" && r.channel_instance_id !== "channel_session")) {
        byConversation.set(convId, r);
      }
    }
    return [...byConversation.values()]
      .sort((a, b) => b.last_active_at - a.last_active_at)
      .slice(0, 500)
      .map((r) => {
        let channelInstanceId = r.channel_instance_id as string;
        let peerId = r.peer_id as string;
        if (channelInstanceId === "channel_session") {
          if (peerId.startsWith("scheduler:")) {
            // 调度会话的映射 peerId 是 `scheduler:<taskId>`（没有 agentId 前缀）
            channelInstanceId = "scheduler";
            peerId = peerId.slice("scheduler:".length);
          } else {
            // 哨兵行提升: peerId 形态为 `${agentId}:${sessionId}`——剥 agentId
            // 得 sessionId, 再剥 sessionId 首段为来源 (web-playground/scheduler)
            const derivedPeer = peerId.slice(peerId.indexOf(":") + 1);
            const sep = derivedPeer.indexOf(":");
            channelInstanceId = sep > 0 ? derivedPeer.slice(0, sep) : "internal";
            peerId = sep > 0 ? derivedPeer.slice(sep + 1) : derivedPeer;
          }
        }
        return {
          channelInstanceId,
          peerId,
          agentId: r.agent_id,
          conversationId: r.conversation_id,
          createdAt: r.created_at,
          lastActiveAt: r.last_active_at,
        };
      });
  }

  /**
   * 渠道绑定解析 (chat-orchestrator 的 IM fast path 与 ChannelManager.dispatchInbound
   * 共用, R8 simplify Reuse#6: 此前两处各写一遍 enabled/悬空校验)。
   * 返回 agentId 或错误说明。
   */
  public resolveBoundAgent(channelInstanceId: string): { agentId: string } | { error: string } {
    const channelConfig = this.getChannel(channelInstanceId);
    if (channelConfig && !channelConfig.enabled) {
      return { error: `渠道 ${channelInstanceId} 已停用` };
    }
    const agentId = channelConfig?.boundAgentId;
    if (!agentId || !this.getAgent(agentId)) {
      return { error: `渠道 ${channelInstanceId} 尚未绑定有效 Agent, 请在管理台「渠道」页配置` };
    }
    return { agentId };
  }

  /**
   * 按 agentId + sessionId 查会话映射 (管理台 /api/sessions/find, R1 评审
   * B6/B14): 真实渠道行优先 (channelInstanceId=sessionId 首段), 哨兵行
   * (`channel_session`, peerId=`${agentId}:${sessionId}`) 兜底——与
   * AgentManager 的映射写入语义同一形态, 前端不再猜 peer 字符串。
   */
  public findSessionByKeys(agentId: string, sessionId: string): ChannelSession | undefined {
    const idx = sessionId.indexOf(":");
    if (idx > 0) {
      const channelInstanceId = sessionId.slice(0, idx);
      const peerId = sessionId.slice(idx + 1);
      if (this.getChannel(channelInstanceId)) {
        const real = this.getSession(channelInstanceId, peerId);
        if (real) return real;
      }
    }
    return this.getSession("channel_session", `${agentId}:${sessionId}`);
  }

  // --- MCP Servers ---
  private mapMcpServerRow(row: any): McpServerDefinition {
    return {
      id: row.id,
      name: row.name,
      transport: row.transport,
      command: row.command ?? undefined,
      args: JSON.parse(row.args || "null") ?? undefined,
      env: JSON.parse(row.env || "null") ?? undefined,
      url: row.url ?? undefined,
      headers: JSON.parse(row.headers || "null") ?? undefined,
      description: row.description ?? undefined,
      exposure: row.exposure === "hidden" ? "hidden" : "direct",
      toolExposure: JSON.parse(row.tool_exposure || "null") ?? undefined,
      enabled: Boolean(row.enabled),
      updatedAt: row.updated_at,
    };
  }

  public listMcpServers(): McpServerDefinition[] {
    const rows = this.db.query<any>("SELECT * FROM mcp_servers ORDER BY updated_at DESC");
    return rows.map((r) => this.mapMcpServerRow(r));
  }

  public getMcpServer(id: string): McpServerDefinition | undefined {
    const row = this.db.queryOne<any>("SELECT * FROM mcp_servers WHERE id = ?", id);
    return row ? this.mapMcpServerRow(row) : undefined;
  }

  public saveMcpServer(server: McpServerDefinition): void {
    const now = Date.now();
    this.db.run(
      `INSERT INTO mcp_servers (
        id, name, transport, command, args, env, url, headers,
        description, exposure, tool_exposure, enabled, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        transport = excluded.transport,
        command = excluded.command,
        args = excluded.args,
        env = excluded.env,
        url = excluded.url,
        headers = excluded.headers,
        description = excluded.description,
        exposure = excluded.exposure,
        tool_exposure = excluded.tool_exposure,
        enabled = excluded.enabled,
        updated_at = excluded.updated_at`,
      server.id,
      server.name,
      server.transport,
      server.command ?? null,
      JSON.stringify(server.args ?? null),
      JSON.stringify(server.env ?? null),
      server.url ?? null,
      JSON.stringify(server.headers ?? null),
      server.description ?? null,
      server.exposure === "hidden" ? "hidden" : "direct",
      JSON.stringify(server.toolExposure ?? null),
      server.enabled ? 1 : 0,
      now,
    );
  }

  public deleteMcpServer(id: string): boolean {
    const selected = this.listAgents().filter((a) => a.skills.includes(`mcp__${id}`));
    if (selected.length > 0) {
      throw new Error(
        `MCP server '${id}' is still selected by agent(s): ${selected.map((a) => a.id).join(", ")}; remove it from their skills first`,
      );
    }
    this.db.run("DELETE FROM mcp_servers WHERE id = ?", id);
    return true;
  }

  // --- Scheduled Tasks (逻辑删除) ---
  private mapScheduledTaskRow(row: any): ScheduledTaskDefinition {
    return {
      id: row.id,
      agentId: row.agent_id,
      name: row.name,
      prompt: row.prompt,
      scheduleType: row.schedule_type,
      runAt: row.run_at ?? undefined,
      intervalSeconds: row.interval_seconds ?? undefined,
      cronExpr: row.cron_expr ?? undefined,
      enabled: Boolean(row.enabled),
      deletedAt: row.deleted_at ?? undefined,
      nextRunAt: row.next_run_at ?? undefined,
      lastRunAt: row.last_run_at ?? undefined,
      lastStatus: row.last_status ?? undefined,
      lastResult: row.last_result ?? undefined,
      runCount: row.run_count,
      notifyChannelInstanceId: row.notify_channel_instance_id ?? undefined,
      notifyPeerId: row.notify_peer_id ?? undefined,
      notifyEnabled: row.notify_enabled === undefined ? true : Boolean(row.notify_enabled),
      durableTaskId: row.durable_task_id ?? undefined,
      durableState: (row.durable_state ?? "pending") as ScheduledTaskDurableState,
      scheduleVersion: row.schedule_version ?? 0,
      conversationId: row.conversation_id ?? undefined,
      conversationPoisoned: Boolean(row.conversation_poisoned),
      poisonRunKey: row.poison_run_key ?? undefined,
      poisonFence: row.poison_fence ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  public saveScheduledTask(task: ScheduledTaskDefinition): void {
    const now = Date.now();
    this.db.run(
      `INSERT INTO scheduled_tasks (
        id, agent_id, name, prompt, schedule_type, run_at, interval_seconds, cron_expr,
        enabled, deleted_at, next_run_at, last_run_at, last_status, last_result,
        run_count, notify_channel_instance_id, notify_peer_id, notify_enabled,
        durable_task_id, durable_state, schedule_version, conversation_id,
        conversation_poisoned, poison_run_key, poison_fence,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        prompt = excluded.prompt,
        schedule_type = excluded.schedule_type,
        run_at = excluded.run_at,
        interval_seconds = excluded.interval_seconds,
        cron_expr = excluded.cron_expr,
        enabled = excluded.enabled,
        deleted_at = excluded.deleted_at,
        next_run_at = excluded.next_run_at,
        last_run_at = excluded.last_run_at,
        last_status = excluded.last_status,
        last_result = excluded.last_result,
        run_count = excluded.run_count,
        notify_channel_instance_id = excluded.notify_channel_instance_id,
        notify_peer_id = excluded.notify_peer_id,
        notify_enabled = excluded.notify_enabled,
        durable_task_id = excluded.durable_task_id,
        durable_state = excluded.durable_state,
        schedule_version = excluded.schedule_version,
        conversation_id = excluded.conversation_id,
        conversation_poisoned = excluded.conversation_poisoned,
        poison_run_key = excluded.poison_run_key,
        poison_fence = excluded.poison_fence,
        updated_at = excluded.updated_at`,
      task.id,
      task.agentId,
      task.name,
      task.prompt,
      task.scheduleType,
      task.runAt ?? null,
      task.intervalSeconds ?? null,
      task.cronExpr ?? null,
      task.enabled ? 1 : 0,
      task.deletedAt ?? null,
      task.nextRunAt ?? null,
      task.lastRunAt ?? null,
      task.lastStatus ?? null,
      task.lastResult ?? null,
      task.runCount,
      task.notifyChannelInstanceId ?? null,
      task.notifyPeerId ?? null,
      task.notifyEnabled ? 1 : 0,
      task.durableTaskId ?? null,
      task.durableState ?? "pending",
      task.scheduleVersion ?? 0,
      task.conversationId ?? null,
      task.conversationPoisoned ? 1 : 0,
      task.poisonRunKey ?? null,
      task.poisonFence ?? null,
      task.createdAt || now,
      now,
    );
  }

  /** 不含逻辑删除的 (工具可见; 调度循环也用此查询) */
  public getScheduledTask(id: string): ScheduledTaskDefinition | undefined {
    const row = this.db.queryOne<any>(
      "SELECT * FROM scheduled_tasks WHERE id = ? AND deleted_at IS NULL",
      id,
    );
    return row ? this.mapScheduledTaskRow(row) : undefined;
  }

  /** 七期：按 conversation 反查定时任务（手动压缩/会话观测用）。 */
  public getScheduledTaskByConversation(conversationId: string): ScheduledTaskDefinition | undefined {
    if (!conversationId) return undefined;
    const row = this.db.queryOne<any>(
      "SELECT * FROM scheduled_tasks WHERE conversation_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 1",
      conversationId,
    );
    return row ? this.mapScheduledTaskRow(row) : undefined;
  }

  public listScheduledTasks(agentId?: string): ScheduledTaskDefinition[] {
    const rows = agentId
      ? this.db.query<any>(
          "SELECT * FROM scheduled_tasks WHERE deleted_at IS NULL AND agent_id = ? ORDER BY created_at ASC",
          agentId,
        )
      : this.db.query<any>(
          "SELECT * FROM scheduled_tasks WHERE deleted_at IS NULL ORDER BY created_at ASC",
        );
    return rows.map((r) => this.mapScheduledTaskRow(r));
  }

  /** 活跃任务总数（创建限额；只 count 不物化整行） */
  public countScheduledTasks(): number {
    const row = this.db.queryOne<{ n: number }>(
      "SELECT COUNT(*) AS n FROM scheduled_tasks WHERE deleted_at IS NULL",
    );
    return Number(row?.n ?? 0);
  }

  /** 管理台状态汇总（一条聚合查询，避免 /api/status 全表物化） */
  public countScheduledTaskStates(): { active: number; blocked: number } {
    const row = this.db.queryOne<{ active: number; blocked: number }>(
      `SELECT
         COALESCE(SUM(CASE WHEN enabled = 1 AND durable_state = 'active' THEN 1 ELSE 0 END), 0) AS active,
         COALESCE(SUM(CASE WHEN durable_state = 'blocked' THEN 1 ELSE 0 END), 0) AS blocked
       FROM scheduled_tasks WHERE deleted_at IS NULL`,
    );
    return { active: Number(row?.active ?? 0), blocked: Number(row?.blocked ?? 0) };
  }

  /** 调度循环的轻量探针: 覆盖索引一查, 未到期时免去全行 SELECT + 行映射 */
  public hasDueScheduledTasks(now: number): boolean {
    const row = this.db.queryOne<{ n: number }>(
      "SELECT EXISTS(SELECT 1 FROM scheduled_tasks WHERE deleted_at IS NULL AND enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?) as n",
      now,
    );
    return Boolean(row?.n);
  }

  /** 调度循环: 到期任务 (含上次进程未跑完的 catch-up) */
  public listDueScheduledTasks(now: number): ScheduledTaskDefinition[] {
    const rows = this.db.query<any>(
      "SELECT * FROM scheduled_tasks WHERE deleted_at IS NULL AND enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC",
      now,
    );
    return rows.map((r) => this.mapScheduledTaskRow(r));
  }

  /** 逻辑删除: deleted_at 置位, 记录保留 (禁用触发, 工具/调度循环均不可见) */
  public softDeleteScheduledTask(id: string, agentId?: string): boolean {
    const task = this.getScheduledTask(id);
    if (!task) return false;
    if (agentId && task.agentId !== agentId) {
      throw new Error(`Task '${id}' belongs to another agent`);
    }
    this.db.run(
      "UPDATE scheduled_tasks SET deleted_at = ?, enabled = 0, updated_at = ? WHERE id = ?",
      Date.now(),
      Date.now(),
      id,
    );
    return true;
  }

  /** 原子递增 run_count (手动触发与到点调度并发防覆盖, R1 评审 B18/M15), 返回递增后的值 */
  public incrementScheduledTaskRun(id: string): number {
    this.db.run("UPDATE scheduled_tasks SET run_count = run_count + 1 WHERE id = ?", id);
    const row = this.db.queryOne<any>("SELECT run_count FROM scheduled_tasks WHERE id = ?", id);
    return row?.run_count ?? 0;
  }

  // --- 六期：durable 调度 run ledger / lease / outbox (docs/PHASE6-DESIGN.md §5.2/§5.6) ---

  /** 含逻辑删除的原始行 (reconcile/删除后清理必须看到 deleted 行) */
  public getScheduledTaskRaw(id: string): ScheduledTaskDefinition | undefined {
    const row = this.db.queryOne<any>("SELECT * FROM scheduled_tasks WHERE id = ?", id);
    return row ? this.mapScheduledTaskRow(row) : undefined;
  }

  public listScheduledTasksRaw(agentId?: string): ScheduledTaskDefinition[] {
    const rows = agentId
      ? this.db.query<any>("SELECT * FROM scheduled_tasks WHERE agent_id = ? ORDER BY created_at ASC", agentId)
      : this.db.query<any>("SELECT * FROM scheduled_tasks ORDER BY created_at ASC");
    return rows.map((r) => this.mapScheduledTaskRow(r));
  }

  /** 只更新任务定义字段 (不覆盖并发 run 回写的 last_* / run_count / durable_*) */
  public saveScheduledTaskConfig(task: ScheduledTaskDefinition): boolean {
    const { changes } = this.db.run(
      `UPDATE scheduled_tasks SET
        name = ?, prompt = ?, schedule_type = ?, run_at = ?, interval_seconds = ?, cron_expr = ?,
        enabled = ?, next_run_at = ?, notify_channel_instance_id = ?, notify_peer_id = ?,
        notify_enabled = ?, schedule_version = ?, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL`,
      task.name,
      task.prompt,
      task.scheduleType,
      task.runAt ?? null,
      task.intervalSeconds ?? null,
      task.cronExpr ?? null,
      task.enabled ? 1 : 0,
      task.nextRunAt ?? null,
      task.notifyChannelInstanceId ?? null,
      task.notifyPeerId ?? null,
      task.notifyEnabled ? 1 : 0,
      task.scheduleVersion,
      Date.now(),
      task.id,
    );
    return Number(changes ?? 0) > 0;
  }

  public setScheduledTaskDurable(id: string, durableTaskId: string | undefined, state: ScheduledTaskDurableState): void {
    this.db.run(
      "UPDATE scheduled_tasks SET durable_task_id = ?, durable_state = ?, updated_at = ? WHERE id = ?",
      durableTaskId ?? null,
      state,
      Date.now(),
      id,
    );
  }

  /** 逻辑删除：用户意图先落库（deleted_at/enabled/durable_state），abort 后置 */
  public markScheduledTaskDeleted(id: string, agentId?: string): boolean {
    const task = this.getScheduledTaskRaw(id);
    if (!task || task.deletedAt) return false;
    if (agentId && task.agentId !== agentId) {
      throw new Error(`Task '${id}' belongs to another agent`);
    }
    this.db.run(
      `UPDATE scheduled_tasks SET deleted_at = ?, enabled = 0, durable_state = 'deleted', updated_at = ?
       WHERE id = ? AND deleted_at IS NULL`,
      Date.now(),
      Date.now(),
      id,
    );
    return true;
  }

  /** 首次 run 绑定 scheduler conversation（mapping + task 字段同事务）；不一致 fail-closed */
  public bindSchedulerConversation(taskId: string, conversationId: string, agentId: string): void {
    this.db.transaction(() => {
      const task = this.getScheduledTaskRaw(taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);
      if (task.deletedAt) throw new Error(`Task '${taskId}' is deleted`);
      if (task.conversationId && task.conversationId !== conversationId) {
        throw new Error(
          `Task '${taskId}' already bound to conversation ${task.conversationId}; refusing to rebind to ${conversationId}`,
        );
      }
      const peerId = `scheduler:${taskId}`;
      const existing = this.getSession("channel_session", peerId);
      if (existing && existing.conversationId !== conversationId) {
        throw new Error(
          `Session mapping for '${taskId}' already points at conversation ${existing.conversationId}; refusing ${conversationId}`,
        );
      }
      const now = Date.now();
      this.saveSession({
        channelInstanceId: "channel_session",
        peerId,
        agentId,
        conversationId,
        createdAt: now,
        lastActiveAt: now,
      });
      this.db.run(
        "UPDATE scheduled_tasks SET conversation_id = ?, updated_at = ? WHERE id = ? AND (conversation_id IS NULL OR conversation_id = ?)",
        conversationId,
        now,
        taskId,
        conversationId,
      );
    });
  }

  /** 人工 reset：清 poison、递增代际、绑定新 conversation（同一事务） */
  public resetScheduledConversation(taskId: string, conversationId: string, agentId: string): void {
    this.db.transaction(() => {
      const task = this.getScheduledTaskRaw(taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);
      const now = Date.now();
      this.saveSession({
        channelInstanceId: "channel_session",
        peerId: `scheduler:${taskId}`,
        agentId,
        conversationId,
        createdAt: now,
        lastActiveAt: now,
      });
      this.db.run(
        `UPDATE scheduled_tasks SET
           conversation_id = ?, conversation_poisoned = 0, poison_run_key = NULL, poison_fence = NULL,
           durable_task_id = NULL, durable_state = 'pending', schedule_version = schedule_version + 1, updated_at = ?
         WHERE id = ?`,
        conversationId,
        now,
        taskId,
      );
    });
  }

  /**
   * poison 写入带 runKey/fence + 单次条件：旧 fence / 已 poison 的行不会被覆盖。
   * 返回是否真正写入（并发下由 reconcile 在全局锁补写）。
   */
  public markConversationPoisoned(
    taskId: string,
    runKey: string,
    fence: number,
    scheduleVersion: number,
    expectedOwner: string,
  ): boolean {
    return this.db.transaction(() => {
      // 旧 fence/旧 owner 不得 poison 新 owner：以 ledger 当前 running 行为准
      const running = this.db.queryOne<any>(
        "SELECT lease_fence, lease_owner FROM scheduled_task_runs WHERE task_id = ? AND run_key = ? AND status = 'running'",
        taskId,
        runKey,
      );
      if (running) {
        if (Number(running.lease_fence) !== fence) return false;
        if (running.lease_owner !== expectedOwner) return false;
      } else {
        // 带 owner 的 poison 是并发收尾：running 已消失说明 run 已正常终态，拒绝 poison
        return false;
      }
      const { changes } = this.db.run(
        `UPDATE scheduled_tasks SET
           conversation_poisoned = 1, durable_state = 'poisoned', poison_run_key = ?, poison_fence = ?, updated_at = ?
         WHERE id = ? AND deleted_at IS NULL AND schedule_version = ? AND poison_run_key IS NULL`,
        runKey,
        fence,
        Date.now(),
        taskId,
        scheduleVersion,
      );
      return Number(changes ?? 0) > 0;
    });
  }

  /** 调度会话 id 集合（durable busy 排除面：owner conversation + 每任务绑定） */
  public listSchedulerConversationIds(): Set<string> {
    const ids = new Set<string>();
    const owner = this.getConfig("scheduler_owner_conversation_id", "");
    if (owner) ids.add(owner);
    for (const row of this.db.query<any>(
      "SELECT conversation_id FROM scheduled_tasks WHERE conversation_id IS NOT NULL",
    )) {
      ids.add(String(row.conversation_id));
    }
    for (const retired of this.retiredSchedulerConversationIds()) ids.add(retired);
    return ids;
  }

  /** reset 后旧 conversation 永久退休：任何调度绑定都不得再引用它 */
  public retiredSchedulerConversationIds(): Set<string> {
    const raw = this.getConfig("scheduler_retired_conversations", "[]");
    try {
      const parsed = JSON.parse(raw);
      return new Set(Array.isArray(parsed) ? parsed.map(String) : []);
    } catch {
      return new Set();
    }
  }

  public retireSchedulerConversation(conversationId: string): void {
    const ids = this.retiredSchedulerConversationIds();
    ids.add(conversationId);
    // 保留最近 1000 个，防止 system_config 无限增长
    const list = [...ids].slice(-1_000);
    this.setConfig("scheduler_retired_conversations", JSON.stringify(list));
  }

  public isRetiredSchedulerConversation(conversationId: string | undefined): boolean {
    if (!conversationId) return false;
    return this.retiredSchedulerConversationIds().has(String(conversationId));
  }

  private mapScheduledRunRow(row: any): ScheduledTaskRunRecord {
    return {
      id: row.id,
      taskId: row.task_id,
      runKey: row.run_key,
      scheduledFor: row.scheduled_for,
      runNumber: row.run_number,
      scheduleVersion: row.schedule_version,
      requestId: row.request_id,
      status: row.status,
      startedAt: row.started_at,
      endedAt: row.ended_at ?? undefined,
      conversationId: row.conversation_id ?? undefined,
      durableTaskId: row.durable_task_id ?? undefined,
      attemptCount: row.attempt_count,
      leaseOwner: row.lease_owner ?? undefined,
      leaseUntil: row.lease_until ?? undefined,
      leaseFence: row.lease_fence,
      result: row.result ?? undefined,
      error: row.error ?? undefined,
      createdAt: row.created_at,
    };
  }

  public getScheduledRun(id: string): ScheduledTaskRunRecord | undefined {
    const row = this.db.queryOne<any>("SELECT * FROM scheduled_task_runs WHERE id = ?", id);
    return row ? this.mapScheduledRunRow(row) : undefined;
  }

  public getScheduledRunByKey(taskId: string, runKey: string): ScheduledTaskRunRecord | undefined {
    const row = this.db.queryOne<any>(
      "SELECT * FROM scheduled_task_runs WHERE task_id = ? AND run_key = ?",
      taskId,
      runKey,
    );
    return row ? this.mapScheduledRunRow(row) : undefined;
  }

  public listScheduledRuns(taskId: string, limit = 50, offset = 0): ScheduledTaskRunRecord[] {
    return this.db
      .query<any>(
        "SELECT * FROM scheduled_task_runs WHERE task_id = ? ORDER BY started_at DESC, run_number DESC LIMIT ? OFFSET ?",
        taskId,
        Math.max(1, Math.min(200, limit)),
        Math.max(0, offset),
      )
      .map((r) => this.mapScheduledRunRow(r));
  }

  public countScheduledRuns(taskId: string): number {
    const row = this.db.queryOne<{ n: number }>(
      "SELECT COUNT(*) AS n FROM scheduled_task_runs WHERE task_id = ?",
      taskId,
    );
    return Number(row?.n ?? 0);
  }

  /** 按 (task_id, run_key) 读取当前 running 行的 fence；无 running 行返回 undefined */
  public currentRunFence(taskId: string, runKey: string): number | undefined {
    const row = this.db.queryOne<any>(
      "SELECT lease_fence FROM scheduled_task_runs WHERE task_id = ? AND run_key = ? AND status = 'running'",
      taskId,
      runKey,
    );
    return row ? Number(row.lease_fence) : undefined;
  }

  public listRunningScheduledRuns(taskId?: string): ScheduledTaskRunRecord[] {
    const rows = taskId
      ? this.db.query<any>(
          "SELECT * FROM scheduled_task_runs WHERE status = 'running' AND task_id = ? ORDER BY started_at ASC",
          taskId,
        )
      : this.db.query<any>("SELECT * FROM scheduled_task_runs WHERE status = 'running' ORDER BY started_at ASC");
    return rows.map((r) => this.mapScheduledRunRow(r));
  }

  /** reconcile 条件接管：只有 owner/fence 仍与读取时一致才允许 */
  public takeoverScheduledRunIf(
    runId: string,
    expectedOwner: string | null,
    expectedFence: number,
    owner: string,
    until: number,
  ): boolean {
    const { changes } = this.db.run(
      `UPDATE scheduled_task_runs SET lease_owner = ?, lease_until = ?, lease_fence = lease_fence + 1,
         attempt_count = attempt_count + 1
       WHERE id = ? AND status = 'running' AND lease_fence = ? AND lease_owner IS ?`,
      owner,
      until,
      runId,
      expectedFence,
      expectedOwner,
    );
    return Number(changes ?? 0) > 0;
  }

  /**
   * 显式释放租约（本 invocation 异常退出但有待重试的 checkpoint）。
   * 把 lease_until 置为 0，使下一次同 owner 恢复必须走“租约已过期”的接管路径。
   */
  public releaseScheduledRunLease(runId: string, owner: string, fence: number): boolean {
    const { changes } = this.db.run(
      `UPDATE scheduled_task_runs SET lease_until = 0
       WHERE id = ? AND status = 'running' AND lease_owner = ? AND lease_fence = ?`,
      runId,
      owner,
      fence,
    );
    return Number(changes ?? 0) > 0;
  }

  /**
   * 原子 reserve：插入唯一 run ledger（或接管过期 lease）。
   * nextRunAt 由调用方按 (task, scheduledFor) 计算；advanceSchedule=false 用于手动触发。
   */
  public reserveScheduledRun(input: {
    taskId: string;
    runKey: string;
    scheduledFor: number;
    scheduleVersion: number;
    now: number;
    leaseOwner: string;
    leaseMs: number;
    durableTaskId?: string;
    advanceSchedule: boolean;
    nextRunAt?: number;
    /**
     * 仅崩溃恢复/同进程重启时由 runtime 显式置 true：
     * 同一 owner 的 running run 才允许接管。默认 false = 同 owner 的有效租约视为
     * 仍在执行，必须返回 active，绝不复用同一 run 并发执行。
     */
    allowSelfTakeover?: boolean;
  }): ReserveScheduledRunResult {
    try {
      return this.db.transaction((): ReserveScheduledRunResult => {
        const task = this.getScheduledTaskRaw(input.taskId);
        if (!task || task.deletedAt) return { kind: "superseded", reason: "deleted" };
        if (!task.enabled) return { kind: "superseded", reason: "disabled" };
        if (task.scheduleVersion !== input.scheduleVersion) {
          return { kind: "superseded", reason: "schedule_version" };
        }

        const existing = this.getScheduledRunByKey(input.taskId, input.runKey);
        if (existing) {
          if (existing.status !== "running") {
            return { kind: "existing", run: existing, task, active: false };
          }
          const sameOwner = existing.leaseOwner === input.leaseOwner;
          const leaseExpired = (existing.leaseUntil ?? 0) < input.now;
          // 租约未过期绝不可接管；同 owner 还需 runtime 显式声明这是崩溃恢复
          // （allowSelfTakeover），不能仅凭内存缺失判断。
          const canTakeover =
            leaseExpired && (sameOwner ? Boolean(input.allowSelfTakeover) : true);
          const leaseHeld = Boolean(existing.leaseOwner && !canTakeover);
          if (leaseHeld) return { kind: "existing", run: existing, task, active: true };
          const fence = existing.leaseFence + 1;
          this.db.run(
            `UPDATE scheduled_task_runs SET lease_owner = ?, lease_until = ?, lease_fence = ?,
               attempt_count = attempt_count + 1,
               durable_task_id = COALESCE(?, durable_task_id)
             WHERE id = ? AND status = 'running'`,
            input.leaseOwner,
            input.now + input.leaseMs,
            fence,
            input.durableTaskId ?? null,
            existing.id,
          );
          return {
            kind: "existing",
            run: this.getScheduledRun(existing.id)!,
            task,
            // false = 本调用已接管 lease，应继续执行这个 run（崩溃恢复/并发去重）
            active: false,
          };
        }

        const runNumber = task.runCount + 1;
        const runId = `run-${input.now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        const requestId = `sched:${input.taskId}:${input.runKey}`;

        // 同一任务同一时刻只允许一个 run（manual 与 scheduled 共用仲裁）。
        // 占用者由发起方明确处理：scheduled 退避重试，manual 返回冲突。
        const other = this.db.queryOne<any>(
          "SELECT * FROM scheduled_task_runs WHERE task_id = ? AND run_key != ? AND status = 'running' LIMIT 1",
          input.taskId,
          input.runKey,
        );
        if (other) return { kind: "busy", run: this.mapScheduledRunRow(other) };

        this.db.run(
          "UPDATE scheduled_tasks SET run_count = run_count + 1, updated_at = ? WHERE id = ?",
          input.now,
          input.taskId,
        );

        if (input.advanceSchedule) {
          if (task.scheduleType === "once") {
            // once：先置空 next_run_at；enabled/durable_state 由 finishRun 在成功终态统一处理
            this.db.run(
              `UPDATE scheduled_tasks SET next_run_at = NULL, updated_at = ?
               WHERE id = ? AND deleted_at IS NULL AND enabled = 1 AND schedule_version = ?`,
              input.now,
              input.taskId,
              input.scheduleVersion,
            );
          } else if (input.nextRunAt !== undefined) {
            this.db.run(
              `UPDATE scheduled_tasks SET next_run_at = ?, updated_at = ?
               WHERE id = ? AND deleted_at IS NULL AND enabled = 1 AND schedule_version = ?`,
              input.nextRunAt,
              input.now,
              input.taskId,
              input.scheduleVersion,
            );
          }
        }

        this.db.run(
          `INSERT INTO scheduled_task_runs (
            id, task_id, run_key, scheduled_for, run_number, schedule_version, request_id,
            status, started_at, conversation_id, durable_task_id, attempt_count,
            lease_owner, lease_until, lease_fence, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, 1, ?, ?, 1, ?)`,
          runId,
          input.taskId,
          input.runKey,
          input.scheduledFor,
          runNumber,
          input.scheduleVersion,
          requestId,
          input.now,
          task.conversationId ?? null,
          input.durableTaskId ?? null,
          input.leaseOwner,
          input.now + input.leaseMs,
          input.now,
        );

        // 每任务最多保留 200 条 run（不删 running）
        this.db.run(
          `DELETE FROM scheduled_task_runs
            WHERE task_id = ? AND status != 'running' AND id NOT IN (
              SELECT id FROM scheduled_task_runs WHERE task_id = ? ORDER BY started_at DESC, run_number DESC LIMIT 200
            )`,
          input.taskId,
          input.taskId,
        );

        return {
          kind: "reserved",
          run: this.getScheduledRun(runId)!,
          task,
        };
      });
    } catch (err) {
      // 唯一键竞争（并发 reserve）视为已存在
      const existing = this.getScheduledRunByKey(input.taskId, input.runKey);
      if (existing) {
        const task = this.getScheduledTaskRaw(input.taskId);
        return { kind: "existing", run: existing, task: task!, active: existing.status === "running" };
      }
      throw err;
    }
  }

  /** 续租：返回 ok / settled（已终态，静默停止）/ lost（fence/owner 已变，必须取消聊天） */
  public renewScheduledRunLease(
    runId: string,
    owner: string,
    fence: number,
    until: number,
  ): "ok" | "settled" | "lost" {
    const { changes } = this.db.run(
      `UPDATE scheduled_task_runs SET lease_until = ?
       WHERE id = ? AND status = 'running' AND lease_owner = ? AND lease_fence = ?`,
      until,
      runId,
      owner,
      fence,
    );
    if (Number(changes ?? 0) > 0) return "ok";
    const run = this.getScheduledRun(runId);
    if (!run || run.status !== "running") return "settled";
    return "lost";
  }

  /**
   * 终态写入（lease owner + fence 独占）：ledger → scheduled_tasks 条件回写 → outbox。
   * 用户删除/禁用优先：deleted_at/enabled 不会被复活。
   */
  public finishScheduledRun(input: {
    runId: string;
    owner: string;
    fence: number;
    status: "ok" | "error" | "done" | "aborted";
    result?: string;
    error?: string;
    now: number;
  }): FinishScheduledRunResult {
    return this.db.transaction((): FinishScheduledRunResult => {
      const run = this.getScheduledRun(input.runId);
      if (!run || run.status !== "running") return { ok: false, reason: "settled" };
      if (run.leaseOwner !== input.owner || run.leaseFence !== input.fence) {
        return { ok: false, reason: "fence_lost" };
      }
      const result = input.result?.slice(0, LAST_RESULT_MAX_CHARS);
      const error = input.error?.slice(0, LAST_RESULT_MAX_CHARS);
      const { changes } = this.db.run(
        `UPDATE scheduled_task_runs SET status = ?, result = ?, error = ?, ended_at = ?
         WHERE id = ? AND status = 'running' AND lease_owner = ? AND lease_fence = ?`,
        input.status,
        result ?? null,
        error ?? null,
        input.now,
        input.runId,
        input.owner,
        input.fence,
      );
      if (Number(changes ?? 0) === 0) return { ok: false, reason: "fence_lost" };

      const task = this.getScheduledTaskRaw(run.taskId);
      if (task?.conversationId && run.conversationId !== task.conversationId) {
        // 首次 run 在预留后才绑定 conversation；终态时补齐 ledger 的 conversation_id
        this.db.run(
          "UPDATE scheduled_task_runs SET conversation_id = ? WHERE id = ?",
          task.conversationId,
          run.id,
        );
      }
      const taskChanged = this.applyRunOutcome(run, task, {
        status: input.status,
        result,
        error,
        lastStatus: input.status,
        lastResult: input.status === "error" ? error ?? null : result ?? null,
        onceDurableState: input.status === "error" ? "failed" : "done",
        now: input.now,
      });
      return {
        ok: true,
        taskChanged,
      };
    });
  }

  /**
   * 终态回写业务行 + outbox（finish/forceAbort 共用）：
   * 条件更新保证用户删除/禁用/改代际优先；通知只在确实写入时入队。
   */
  private applyRunOutcome(
    run: ScheduledTaskRunRecord,
    task: ScheduledTaskDefinition | undefined,
    input: {
      status: "ok" | "error" | "done" | "aborted";
      result?: string;
      error?: string;
      lastStatus: ScheduledTaskDefinition["lastStatus"];
      lastResult: string | null;
      onceDurableState: ScheduledTaskDurableState;
      now: number;
    },
  ): boolean {
    let taskChanged = false;
    if (task && !task.deletedAt && task.scheduleVersion === run.scheduleVersion) {
      if (task.scheduleType === "once" && run.runKey.startsWith("schedule:")) {
        const r = this.db.run(
          `UPDATE scheduled_tasks SET
             enabled = 0, next_run_at = NULL, last_run_at = ?, last_status = ?, last_result = ?,
             durable_state = ?, updated_at = ?
           WHERE id = ? AND deleted_at IS NULL AND enabled = 1 AND schedule_version = ?`,
          input.now,
          input.lastStatus,
          input.lastResult,
          input.onceDurableState,
          input.now,
          task.id,
          run.scheduleVersion,
        );
        taskChanged = Number(r.changes ?? 0) > 0;
      } else {
        const r = this.db.run(
          `UPDATE scheduled_tasks SET last_run_at = ?, last_status = ?, last_result = ?, updated_at = ?
           WHERE id = ? AND deleted_at IS NULL AND enabled = 1 AND schedule_version = ?`,
          input.now,
          input.lastStatus,
          input.lastResult,
          input.now,
          task.id,
          run.scheduleVersion,
        );
        taskChanged = Number(r.changes ?? 0) > 0;
      }
    }
    if (taskChanged && task && task.notifyEnabled) {
      this.enqueueScheduledNotification({
        runId: run.id,
        taskId: run.taskId,
        payload: buildNotificationPayload({
          run,
          task,
          status: input.status,
          result: input.result,
          error: input.error,
        }),
        now: input.now,
      });
    }
    return taskChanged;
  }

  /**
   * 无 owner 可写终态时的统一收尾（reconcile/orphan/manual 兜底）：
   * 不做 lease 校验，但同样执行 ledger + 条件业务回写 + outbox，
   * 避免“只写 ledger”导致任务列表与通知不可见（R13-B4）。
   * expected 存在时必须匹配当前 owner/fence，防覆盖接管后的新执行。
   */
  public forceAbortScheduledRun(
    runId: string,
    reason: string,
    now: number,
    expected?: { owner: string | null; fence: number },
  ): boolean {
    return this.db.transaction(() => {
      const run = this.getScheduledRun(runId);
      if (!run || run.status !== "running") return false;
      if (
        expected &&
        ((run.leaseOwner ?? null) !== expected.owner || run.leaseFence !== expected.fence)
      ) {
        return false;
      }
      const error = reason.slice(0, LAST_RESULT_MAX_CHARS);
      const { changes } = this.db.run(
        `UPDATE scheduled_task_runs SET status = 'aborted', error = ?, ended_at = ?
         WHERE id = ? AND status = 'running' AND lease_fence = ? AND lease_owner IS ?`,
        error,
        now,
        runId,
        run.leaseFence,
        run.leaseOwner ?? null,
      );
      if (Number(changes ?? 0) === 0) return false;

      const task = this.getScheduledTaskRaw(run.taskId);
      this.applyRunOutcome(run, task, {
        status: "aborted",
        error,
        lastStatus: "aborted",
        lastResult: error,
        onceDurableState: "failed",
        now,
      });
      return true;
    });
  }


  // --- 通知 outbox ---

  private enqueueScheduledNotification(input: {
    runId: string;
    taskId: string;
    payload: string;
    now: number;
  }): void {
    this.db.run(
      `INSERT OR IGNORE INTO scheduled_task_notifications
        (run_id, task_id, payload, status, attempts, created_at)
       VALUES (?, ?, ?, 'pending', 0, ?)`,
      input.runId,
      input.taskId,
      input.payload,
      input.now,
    );
  }

  public getScheduledNotification(runId: string): ScheduledNotificationRecord | undefined {
    const row = this.db.queryOne<any>("SELECT * FROM scheduled_task_notifications WHERE run_id = ?", runId);
    return row ? this.mapNotificationRow(row) : undefined;
  }

  private mapNotificationRow(row: any): ScheduledNotificationRecord {
    return {
      runId: row.run_id,
      taskId: row.task_id,
      payload: row.payload,
      status: row.status,
      attempts: row.attempts,
      nextAttemptAt: row.next_attempt_at ?? undefined,
      lastError: row.last_error ?? undefined,
      claimedBy: row.claimed_by ?? undefined,
      claimToken: row.claim_token ?? undefined,
      claimedAt: row.claimed_at ?? undefined,
      claimedUntil: row.claimed_until ?? undefined,
      deliveredAt: row.delivered_at ?? undefined,
      createdAt: row.created_at,
    };
  }

  /** 原子 claim：pending / 到期 failed / claim 过期的 sending */
  public claimScheduledNotifications(
    owner: string,
    now: number,
    limit = 10,
    claimMs = 60_000,
  ): { record: ScheduledNotificationRecord; token: string }[] {
    return this.db.transaction(() => {
      const rows = this.db.query<any>(
        `SELECT * FROM scheduled_task_notifications
          WHERE (status = 'pending')
             OR (status = 'failed' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
             OR (status = 'sending' AND (claimed_until IS NULL OR claimed_until < ?))
          ORDER BY created_at ASC LIMIT ?`,
        now,
        now,
        limit,
      );
      const claimed: { record: ScheduledNotificationRecord; token: string }[] = [];
      for (const row of rows) {
        const token = `${owner}:${now.toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
        const { changes } = this.db.run(
          `UPDATE scheduled_task_notifications SET
             status = 'sending', claimed_by = ?, claim_token = ?, claimed_at = ?, claimed_until = ?
           WHERE run_id = ? AND (
             status = 'pending'
             OR (status = 'failed' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
             OR (status = 'sending' AND (claimed_until IS NULL OR claimed_until < ?))
           )`,
          owner,
          token,
          now,
          now + claimMs,
          row.run_id,
          now,
          now,
        );
        if (Number(changes ?? 0) > 0) {
          const updated = this.db.queryOne<any>(
            "SELECT * FROM scheduled_task_notifications WHERE run_id = ?",
            row.run_id,
          );
          if (updated) claimed.push({ record: this.mapNotificationRow(updated), token });
        }
      }
      return claimed;
    });
  }

  public markNotificationDelivered(runId: string, token: string, now: number): boolean {
    const { changes } = this.db.run(
      `UPDATE scheduled_task_notifications SET status = 'delivered', delivered_at = ?, claimed_until = NULL
       WHERE run_id = ? AND status = 'sending' AND claim_token = ?`,
      now,
      runId,
      token,
    );
    return Number(changes ?? 0) > 0;
  }

  public markNotificationFailed(
    runId: string,
    token: string,
    now: number,
    error: string,
    backoffMs: number,
  ): boolean {
    const { changes } = this.db.run(
      `UPDATE scheduled_task_notifications SET
         status = 'failed', attempts = attempts + 1, next_attempt_at = ?, last_error = ?,
         claimed_until = NULL, claim_token = NULL
       WHERE run_id = ? AND status = 'sending' AND claim_token = ?`,
      now + Math.max(1_000, backoffMs),
      error.slice(0, 2_000),
      runId,
      token,
    );
    return Number(changes ?? 0) > 0;
  }

  public purgeScheduledNotifications(now: number): void {
    this.db.run(
      "DELETE FROM scheduled_task_notifications WHERE (status = 'delivered' AND delivered_at < ?) OR (status = 'failed' AND created_at < ?)",
      now - 7 * 24 * 3600_000,
      now - 30 * 24 * 3600_000,
    );
  }

  // --- WS 排队消息持久化 (四期 §4.2 "受理即落库"; R2 评审 B6) ---

  /** 入队落库 (受理即持久), 返回行 id */
  public enqueueQueuedPrompt(agentId: string, sessionId: string, message: string): number {
    const result = this.db.run(
      "INSERT INTO gateway_queued_prompts (agent_id, session_id, message, created_at) VALUES (?, ?, ?, ?)",
      agentId,
      sessionId,
      message,
      Date.now(),
    );
    return Number(result.lastInsertRowid ?? 0);
  }

  /** 出队 (已投递) 删行 */
  public deleteQueuedPrompt(id: number): void {
    this.db.run("DELETE FROM gateway_queued_prompts WHERE id = ?", id);
  }

  /** drain 清空某会话的持久队列 */
  public clearQueuedPrompts(agentId: string, sessionId: string): number {
    const { changes } = this.db.run(
      "DELETE FROM gateway_queued_prompts WHERE agent_id = ? AND session_id = ?",
      agentId,
      sessionId,
    );
    return Number(changes ?? 0);
  }

  /** 启动恢复: 上次进程残留的排队消息 (出队失败/崩溃遗留) */
  public listQueuedPrompts(): { id: number; agentId: string; sessionId: string; message: string; createdAt: number }[] {
    return this.db
      .query<any>("SELECT * FROM gateway_queued_prompts ORDER BY id ASC")
      .map((r) => ({
        id: r.id,
        agentId: r.agent_id,
        sessionId: r.session_id,
        message: r.message,
        createdAt: r.created_at,
      }));
  }

  // --- 七期：上下文观测（turn / request / tool / compaction） ---

  private mapLlmTurnRow(row: any): LlmTurnRecord {
    return {
      turnId: row.turn_id,
      conversationId: row.conversation_id,
      agentId: row.agent_id,
      sessionId: row.session_id,
      sessionKind: row.session_kind,
      schedulerTaskId: row.scheduler_task_id ?? undefined,
      provider: row.provider ?? undefined,
      modelId: row.model_id ?? undefined,
      startedAt: row.started_at,
      endedAt: row.ended_at ?? undefined,
      durationMs: row.duration_ms ?? undefined,
      firstChunkMs: row.first_chunk_ms ?? undefined,
      ttftMs: row.ttft_ms ?? undefined,
      llmMs: row.llm_ms ?? undefined,
      toolMs: row.tool_ms ?? undefined,
      requestCount: row.request_count,
      toolCount: row.tool_count,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheRead: row.cache_read,
      cacheWrite: row.cache_write,
      reasoningTokens: row.reasoning_tokens,
      costUsd: row.cost_usd,
      priced: row.priced !== 0,
      usageJson: row.usage_json ?? undefined,
      contextTokens: row.context_tokens ?? undefined,
      contextEstimateTokens: row.context_estimate_tokens ?? undefined,
      contextWindow: row.context_window ?? undefined,
      compactedBefore: row.compacted_before !== 0,
      compactionMs: row.compaction_ms,
      status: row.status,
      error: row.error ?? undefined,
      requestId: row.request_id ?? undefined,
      runKey: row.run_key ?? undefined,
      traceId: row.trace_id ?? undefined,
      submissionId: row.submission_id ?? undefined,
      detailTruncated: row.detail_truncated !== 0,
    };
  }

  public insertLlmTurn(turn: LlmTurnRecord): void {
    this.db.run(
      `INSERT INTO llm_turns (
        turn_id, conversation_id, agent_id, session_id, session_kind, scheduler_task_id,
        provider, model_id, started_at, ended_at, duration_ms, first_chunk_ms, ttft_ms,
        llm_ms, tool_ms, request_count, tool_count,
        input_tokens, output_tokens, cache_read, cache_write, reasoning_tokens,
        cost_usd, priced, usage_json, context_tokens, context_estimate_tokens, context_window,
        compacted_before, compaction_ms, status, error, request_id, run_key, trace_id,
        submission_id, detail_truncated
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(turn_id) DO UPDATE SET
        provider = excluded.provider,
        model_id = excluded.model_id,
        ended_at = excluded.ended_at,
        duration_ms = excluded.duration_ms,
        first_chunk_ms = excluded.first_chunk_ms,
        ttft_ms = excluded.ttft_ms,
        llm_ms = excluded.llm_ms,
        tool_ms = excluded.tool_ms,
        request_count = excluded.request_count,
        tool_count = excluded.tool_count,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        cache_read = excluded.cache_read,
        cache_write = excluded.cache_write,
        reasoning_tokens = excluded.reasoning_tokens,
        cost_usd = excluded.cost_usd,
        priced = excluded.priced,
        usage_json = excluded.usage_json,
        context_tokens = excluded.context_tokens,
        context_estimate_tokens = excluded.context_estimate_tokens,
        context_window = excluded.context_window,
        compacted_before = excluded.compacted_before,
        compaction_ms = excluded.compaction_ms,
        status = excluded.status,
        error = excluded.error,
        request_id = excluded.request_id,
        run_key = excluded.run_key,
        trace_id = excluded.trace_id,
        submission_id = excluded.submission_id,
        detail_truncated = excluded.detail_truncated`,
      turn.turnId,
      turn.conversationId,
      turn.agentId,
      turn.sessionId,
      turn.sessionKind,
      turn.schedulerTaskId ?? null,
      turn.provider ?? null,
      turn.modelId ?? null,
      turn.startedAt,
      turn.endedAt ?? null,
      turn.durationMs ?? null,
      turn.firstChunkMs ?? null,
      turn.ttftMs ?? null,
      turn.llmMs ?? null,
      turn.toolMs ?? null,
      turn.requestCount,
      turn.toolCount,
      turn.inputTokens,
      turn.outputTokens,
      turn.cacheRead,
      turn.cacheWrite,
      turn.reasoningTokens,
      turn.costUsd,
      turn.priced ? 1 : 0,
      turn.usageJson ?? null,
      turn.contextTokens ?? null,
      turn.contextEstimateTokens ?? null,
      turn.contextWindow ?? null,
      turn.compactedBefore ? 1 : 0,
      turn.compactionMs,
      turn.status,
      turn.error ?? null,
      turn.requestId ?? null,
      turn.runKey ?? null,
      turn.traceId ?? null,
      turn.submissionId ?? null,
      turn.detailTruncated ? 1 : 0,
    );
  }

  public updateLlmTurn(turnId: string, patch: Partial<LlmTurnRecord>): void {
    const current = this.getLlmTurn(turnId);
    if (!current) return;
    this.insertLlmTurn({ ...current, ...patch, turnId });
  }

  public getLlmTurn(turnId: string): LlmTurnRecord | undefined {
    const row = this.db.queryOne<any>("SELECT * FROM llm_turns WHERE turn_id = ?", turnId);
    return row ? this.mapLlmTurnRow(row) : undefined;
  }

  public listLlmTurns(conversationId: string, limit = 50, offset = 0): LlmTurnRecord[] {
    return this.db
      .query<any>(
        "SELECT * FROM llm_turns WHERE conversation_id = ? ORDER BY started_at DESC LIMIT ? OFFSET ?",
        conversationId,
        limit,
        offset,
      )
      .map((row) => this.mapLlmTurnRow(row));
  }

  public countLlmTurns(conversationId: string): number {
    return (
      this.db.queryOne<{ n: number }>(
        "SELECT COUNT(*) AS n FROM llm_turns WHERE conversation_id = ?",
        conversationId,
      )?.n ?? 0
    );
  }

  public listContextSessions(filters: {
    agentId?: string;
    sessionKind?: SessionKind;
    since?: number;
    until?: number;
    q?: string;
    limit?: number;
    offset?: number;
  }): { rows: ContextSessionRow[]; total: number } {
    const since = filters.since ?? 0;
    const until = filters.until ?? Number.MAX_SAFE_INTEGER;
    const where = ["t.started_at >= ?", "t.started_at <= ?"];
    const baseParams: unknown[] = [since, until];
    if (filters.agentId) {
      where.push("t.agent_id = ?");
      baseParams.push(filters.agentId);
    }
    if (filters.sessionKind) {
      where.push("t.session_kind = ?");
      baseParams.push(filters.sessionKind);
    }
    const q = filters.q?.trim().toLowerCase();
    if (q) {
      const escaped = q.replace(/[\\%_]/g, "\\$&");
      const like = `%${escaped}%`;
      where.push(`(
        LOWER(t.session_id) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(t.model_id, '')) LIKE ? ESCAPE '\\'
        OR LOWER(t.agent_id) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(a.name, '')) LIKE ? ESCAPE '\\'
        OR LOWER(COALESCE(st.name, '')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(ci.name, '')) LIKE ? ESCAPE '\\'
      )`);
      for (let i = 0; i < 6; i++) baseParams.push(like);
    }
    const whereSql = where.join(" AND ");
    const joins = `
      LEFT JOIN agents a ON a.id = t.agent_id
      LEFT JOIN scheduled_tasks st ON st.id = t.scheduler_task_id
      LEFT JOIN channel_instances ci ON ci.id = CASE
        WHEN instr(t.session_id, ':') > 0 THEN substr(t.session_id, 1, instr(t.session_id, ':') - 1)
        ELSE t.session_id END`;
    const rangeParams = [since, until];
    const rows = this.db.query<any>(
      `SELECT t.conversation_id, t.agent_id, t.session_id, t.session_kind, t.scheduler_task_id,
              a.name AS agent_name, st.name AS scheduler_task_name,
              ci.type AS channel_type, ci.name AS channel_name,
              COUNT(*) AS turns,
              SUM(t.cost_usd) + COALESCE((
                SELECT SUM(c.cost_usd) FROM compaction_events c
                WHERE c.conversation_id = t.conversation_id AND c.cost_in_turn = 0
                  AND c.started_at >= ? AND c.started_at <= ?
              ), 0) AS cost_usd,
              MAX(t.priced) AS priced,
              MAX(t.started_at) AS last_active_at,
              (SELECT x.context_tokens FROM llm_turns x
                WHERE x.conversation_id = t.conversation_id ORDER BY x.started_at DESC LIMIT 1) AS context_tokens,
              (SELECT x.context_window FROM llm_turns x
                WHERE x.conversation_id = t.conversation_id ORDER BY x.started_at DESC LIMIT 1) AS context_window,
              (SELECT x.provider FROM llm_turns x
                WHERE x.conversation_id = t.conversation_id ORDER BY x.started_at DESC LIMIT 1) AS provider,
              (SELECT x.model_id FROM llm_turns x
                WHERE x.conversation_id = t.conversation_id ORDER BY x.started_at DESC LIMIT 1) AS model_id,
              (SELECT x.status FROM llm_turns x
                WHERE x.conversation_id = t.conversation_id ORDER BY x.started_at DESC LIMIT 1) AS status,
              (SELECT COUNT(*) FROM compaction_events c
                WHERE c.conversation_id = t.conversation_id
                  AND c.started_at >= ? AND c.started_at <= ?) AS compactions
       FROM llm_turns t
       ${joins}
       WHERE ${whereSql}
       GROUP BY t.conversation_id, t.agent_id, t.session_id, t.session_kind, t.scheduler_task_id
       ORDER BY last_active_at DESC
       LIMIT ? OFFSET ?`,
      ...rangeParams,
      ...rangeParams,
      ...baseParams,
      filters.limit ?? 100,
      filters.offset ?? 0,
    );
    const total =
      this.db.queryOne<{ n: number }>(
        `SELECT COUNT(*) AS n FROM (
           SELECT 1 FROM llm_turns t ${joins} WHERE ${whereSql} GROUP BY t.conversation_id
         )`,
        ...baseParams,
      )?.n ?? 0;
    return {
      total,
      rows: rows.map((r) => ({
        conversationId: r.conversation_id,
        agentId: r.agent_id,
        agentName: r.agent_name ?? undefined,
        sessionId: r.session_id,
        sessionKind: r.session_kind,
        schedulerTaskId: r.scheduler_task_id ?? undefined,
        schedulerTaskName: r.scheduler_task_name ?? undefined,
        channelType: r.channel_type ?? undefined,
        channelName: r.channel_name ?? undefined,
        provider: r.provider ?? undefined,
        modelId: r.model_id ?? undefined,
        contextTokens: r.context_tokens ?? undefined,
        contextWindow: r.context_window ?? undefined,
        turns: r.turns,
        costUsd: r.cost_usd ?? 0,
        priced: r.priced !== 0,
        lastActiveAt: r.last_active_at,
        compactions: r.compactions ?? 0,
        status: r.status ?? undefined,
      })),
    };
  }

  public insertLlmRequests(rows: LlmRequestRecord[]): void {
    if (rows.length === 0) return;
    this.db.transaction(() => {
      for (const r of rows) {
        this.db.run(
          `INSERT OR IGNORE INTO llm_requests (
            span_id, turn_id, conversation_id, trace_id, parent_span_id, task_id, kind, task_kind,
            compaction_id, provider, model_id, api, started_at, ended_at, duration_ms,
            first_chunk_ms, input_tokens, output_tokens, cache_read, cache_write,
            reasoning_tokens, cost_usd, stop_reason, status, error
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          r.spanId,
          r.turnId ?? null,
          r.conversationId ?? null,
          r.traceId ?? null,
          r.parentSpanId ?? null,
          r.taskId ?? null,
          r.kind,
          r.taskKind ?? null,
          r.compactionId ?? null,
          r.provider ?? null,
          r.modelId ?? null,
          r.api ?? null,
          r.startedAt,
          r.endedAt ?? null,
          r.durationMs ?? null,
          r.firstChunkMs ?? null,
          r.inputTokens,
          r.outputTokens,
          r.cacheRead,
          r.cacheWrite,
          r.reasoningTokens,
          r.costUsd,
          r.stopReason ?? null,
          r.status,
          r.error ?? null,
        );
      }
    });
  }

  public listLlmRequests(turnId: string): LlmRequestRecord[] {
    return this.db
      .query<any>("SELECT * FROM llm_requests WHERE turn_id = ? ORDER BY started_at ASC", turnId)
      .map((r) => ({
        spanId: r.span_id,
        turnId: r.turn_id ?? undefined,
        conversationId: r.conversation_id ?? undefined,
        traceId: r.trace_id ?? undefined,
        parentSpanId: r.parent_span_id ?? undefined,
        taskId: r.task_id ?? undefined,
        kind: r.kind,
        taskKind: r.task_kind ?? undefined,
        compactionId: r.compaction_id ?? undefined,
        provider: r.provider ?? undefined,
        modelId: r.model_id ?? undefined,
        api: r.api ?? undefined,
        startedAt: r.started_at,
        endedAt: r.ended_at ?? undefined,
        durationMs: r.duration_ms ?? undefined,
        firstChunkMs: r.first_chunk_ms ?? undefined,
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
        cacheRead: r.cache_read,
        cacheWrite: r.cache_write,
        reasoningTokens: r.reasoning_tokens,
        costUsd: r.cost_usd,
        stopReason: r.stop_reason ?? undefined,
        status: r.status,
        error: r.error ?? undefined,
      }));
  }

  public countLlmRequestsByTask(taskId: string): number {
    return (
      this.db.queryOne<{ n: number }>(
        "SELECT COUNT(*) AS n FROM llm_requests WHERE task_id = ?",
        taskId,
      )?.n ?? 0
    );
  }

  public countLlmRequestsByCompaction(compactionId: string): number {
    return (
      this.db.queryOne<{ n: number }>(
        "SELECT COUNT(*) AS n FROM llm_requests WHERE compaction_id = ?",
        compactionId,
      )?.n ?? 0
    );
  }

  public insertToolInvocations(rows: ToolInvocationRecord[]): void {
    if (rows.length === 0) return;
    this.db.transaction(() => {
      for (const r of rows) {
        this.db.run(
          `INSERT INTO tool_invocations (
            turn_id, conversation_id, trace_id, task_id, tool_call_id, tool_name,
            started_at, ended_at, duration_ms, status, error
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(trace_id, tool_call_id) DO UPDATE SET
            turn_id = COALESCE(excluded.turn_id, tool_invocations.turn_id),
            started_at = MIN(tool_invocations.started_at, excluded.started_at),
            ended_at = CASE
              WHEN excluded.ended_at IS NULL THEN tool_invocations.ended_at
              WHEN tool_invocations.ended_at IS NULL THEN excluded.ended_at
              ELSE MAX(tool_invocations.ended_at, excluded.ended_at) END,
            duration_ms = CASE
              WHEN excluded.ended_at IS NULL OR tool_invocations.ended_at IS NULL THEN tool_invocations.duration_ms
              ELSE MAX(tool_invocations.ended_at, excluded.ended_at) - MIN(tool_invocations.started_at, excluded.started_at) END,
            status = excluded.status,
            error = COALESCE(excluded.error, tool_invocations.error)`,
          r.turnId ?? null,
          r.conversationId ?? null,
          r.traceId ?? null,
          r.taskId ?? null,
          r.toolCallId ?? "",
          r.toolName,
          r.startedAt,
          r.endedAt ?? null,
          r.durationMs ?? null,
          r.status,
          r.error ?? null,
        );
      }
    });
  }

  public listToolInvocations(turnId: string): ToolInvocationRecord[] {
    return this.db
      .query<any>("SELECT * FROM tool_invocations WHERE turn_id = ? ORDER BY started_at ASC", turnId)
      .map((r) => ({
        turnId: r.turn_id ?? undefined,
        conversationId: r.conversation_id ?? undefined,
        traceId: r.trace_id ?? undefined,
        taskId: r.task_id ?? undefined,
        toolCallId: r.tool_call_id ?? undefined,
        toolName: r.tool_name,
        startedAt: r.started_at,
        endedAt: r.ended_at ?? undefined,
        durationMs: r.duration_ms ?? undefined,
        status: r.status,
        error: r.error ?? undefined,
      }));
  }

  public insertCompactionEvent(event: CompactionEventRecord): number {
    const result = this.db.run(
      `INSERT OR IGNORE INTO compaction_events (
        conversation_id, agent_id, session_id, turn_id, task_id, trace_id, compaction_id,
        profile, trigger, threshold_tokens, keep_recent_tokens,
        before_tokens, after_tokens, before_estimate_tokens, after_estimate_tokens,
        before_entries, after_entries, started_at, ended_at, duration_ms,
        cost_usd, cost_in_turn, request_count, status, fail_open, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      event.conversationId,
      event.agentId ?? null,
      event.sessionId ?? null,
      event.turnId ?? null,
      event.taskId ?? null,
      event.traceId ?? null,
      event.compactionId ?? null,
      event.profile,
      event.trigger,
      event.thresholdTokens ?? null,
      event.keepRecentTokens ?? null,
      event.beforeTokens ?? null,
      event.afterTokens ?? null,
      event.beforeEstimateTokens ?? null,
      event.afterEstimateTokens ?? null,
      event.beforeEntries ?? null,
      event.afterEntries ?? null,
      event.startedAt,
      event.endedAt ?? null,
      event.durationMs ?? null,
      event.costUsd ?? null,
      event.costInTurn ? 1 : 0,
      event.requestCount,
      event.status,
      event.failOpen ? 1 : 0,
      event.error ?? null,
    );
    const changes = Number(result?.changes ?? 0);
    if (changes === 0 && event.turnId && event.taskId) {
      return (
        this.db.queryOne<{ id: number }>(
          "SELECT id FROM compaction_events WHERE turn_id = ? AND task_id = ?",
          event.turnId,
          event.taskId,
        )?.id ?? 0
      );
    }
    return changes === 0
      ? 0
      : Number(this.db.queryOne<{ id: number }>("SELECT last_insert_rowid() AS id")?.id ?? 0);
  }

  public listCompactionEvents(input: {
    conversationId?: string;
    turnId?: string;
    limit?: number;
  }): CompactionEventRecord[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (input.conversationId) {
      where.push("conversation_id = ?");
      params.push(input.conversationId);
    }
    if (input.turnId) {
      where.push("turn_id = ?");
      params.push(input.turnId);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    return this.db
      .query<any>(
        `SELECT * FROM compaction_events ${whereSql} ORDER BY started_at DESC LIMIT ?`,
        ...params,
        input.limit ?? 100,
      )
      .map((r) => ({
        id: r.id,
        conversationId: r.conversation_id,
        agentId: r.agent_id ?? undefined,
        sessionId: r.session_id ?? undefined,
        turnId: r.turn_id ?? undefined,
        taskId: r.task_id ?? undefined,
        traceId: r.trace_id ?? undefined,
        compactionId: r.compaction_id ?? undefined,
        profile: r.profile,
        trigger: r.trigger,
        thresholdTokens: r.threshold_tokens ?? undefined,
        keepRecentTokens: r.keep_recent_tokens ?? undefined,
        beforeTokens: r.before_tokens ?? undefined,
        afterTokens: r.after_tokens ?? undefined,
        beforeEstimateTokens: r.before_estimate_tokens ?? undefined,
        afterEstimateTokens: r.after_estimate_tokens ?? undefined,
        beforeEntries: r.before_entries ?? undefined,
        afterEntries: r.after_entries ?? undefined,
        startedAt: r.started_at,
        endedAt: r.ended_at ?? undefined,
        durationMs: r.duration_ms ?? undefined,
        costUsd: r.cost_usd ?? undefined,
        costInTurn: r.cost_in_turn !== 0,
        requestCount: r.request_count,
        status: r.status,
        failOpen: r.fail_open !== 0,
        error: r.error ?? undefined,
      }));
  }

  /** 七期：turn 结束后补写轮内压缩事件的实际请求数与 trace（请求明细此时已 flush）。 */
  public updateCompactionEventMetrics(
    id: number,
    patch: { requestCount?: number; traceId?: string },
  ): void {
    if (!Number.isFinite(id) || id <= 0) return;
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.requestCount !== undefined) {
      sets.push("request_count = ?");
      params.push(Math.max(0, Math.floor(patch.requestCount)));
    }
    if (patch.traceId !== undefined) {
      sets.push("trace_id = ?");
      params.push(patch.traceId);
    }
    if (sets.length === 0) return;
    this.db.run(`UPDATE compaction_events SET ${sets.join(", ")} WHERE id = ?`, ...params, id);
  }

  /** 启动时把上次进程遗留的 running turn 标记为 interrupted。 */
  public markRunningTurnsInterrupted(now = Date.now()): number {
    const result = this.db.run(
      `UPDATE llm_turns
         SET status = 'interrupted', ended_at = COALESCE(ended_at, ?),
             duration_ms = COALESCE(duration_ms, MAX(0, ? - started_at))
       WHERE status = 'running'`,
      now,
      now,
    );
    return Number(result?.changes ?? 0);
  }

  private deleteOlderThan(table: string, column: string, cutoff: number, limit = 5000): number {
    let deleted = 0;
    for (;;) {
      const result = this.db.run(
        `DELETE FROM ${table} WHERE rowid IN (
           SELECT rowid FROM ${table} WHERE ${column} < ? LIMIT ?
         )`,
        cutoff,
        limit,
      );
      const changes = Number(result?.changes ?? 0);
      deleted += changes;
      if (changes < limit) break;
    }
    return deleted;
  }

  /** 保留期清理：聚合约 90 天、明细约 30 天（由策略传入）。 */
  public cleanupContextMetrics(input: { turnCutoff: number; detailCutoff: number }): {
    turns: number;
    compactions: number;
    requests: number;
    tools: number;
  } {
    return this.db.transaction(() => ({
      turns: this.deleteOlderThan("llm_turns", "started_at", input.turnCutoff),
      compactions: this.deleteOlderThan("compaction_events", "started_at", input.turnCutoff),
      requests: this.deleteOlderThan("llm_requests", "started_at", input.detailCutoff),
      tools: this.deleteOlderThan("tool_invocations", "started_at", input.detailCutoff),
    }));
  }

  // --- Audit Logs ---
  public recordAudit(eventType: string, details: Record<string, unknown>, agentId?: string, channelId?: string): void {
    const now = Date.now();
    logger.audit(eventType, { agentId, channelId, ...details });
    this.db.run(
      "INSERT INTO audit_logs (agent_id, channel_instance_id, event_type, details, created_at) VALUES (?, ?, ?, ?, ?)",
      agentId || null,
      channelId || null,
      eventType,
      JSON.stringify(details),
      now,
    );
    // 审计事件同步广播 (管理台审计页静默刷新); 发布端兜错, 不得影响调用方
    try {
      EventBus.getInstance().publish({ type: "audit.recorded", event: eventType, agentId });
    } catch {}
  }

  public listAuditLogs(limit = 100): AuditLogEntry[] {
    const rows = this.db.query<any>(
      "SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?",
      limit,
    );
    return rows.map((r) => ({
      id: r.id,
      agentId: r.agent_id,
      channelInstanceId: r.channel_instance_id,
      eventType: r.event_type,
      details: r.details,
      createdAt: r.created_at,
    }));
  }

  /** 审计过滤查询 (管理台 2.0: 事件类型 × Agent × 时间范围 + 分页) */
  public listAuditLogsFiltered(filters: {
    event?: string;
    agentId?: string;
    since?: number;
    until?: number;
    limit?: number;
    offset?: number;
  }): { items: AuditLogEntry[]; total: number } {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filters.event) {
      where.push("event_type LIKE ?");
      params.push(`${filters.event}%`);
    }
    if (filters.agentId) {
      where.push("agent_id = ?");
      params.push(filters.agentId);
    }
    if (filters.since !== undefined) {
      where.push("created_at >= ?");
      params.push(filters.since);
    }
    if (filters.until !== undefined) {
      where.push("created_at <= ?");
      params.push(filters.until);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = this.db.queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_logs ${whereSql}`, ...params)?.n ?? 0;
    const rows = this.db.query<any>(
      `SELECT * FROM audit_logs ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`,
      ...params,
      filters.limit ?? 100,
      filters.offset ?? 0,
    );
    return {
      total,
      items: rows.map((r) => ({
        id: r.id,
        agentId: r.agent_id,
        channelInstanceId: r.channel_instance_id,
        eventType: r.event_type,
        details: r.details,
        createdAt: r.created_at,
      })),
    };
  }
}
