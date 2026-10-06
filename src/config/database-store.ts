import { DatabaseManager } from "../database/index.ts";
import { logger } from "../utils/logger.ts";
import { normalizeSandbox } from "./sandbox-defaults.ts";

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
  type: "terminal" | "wecom" | "weixin" | "qq";
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
  createdAt: number;
  updatedAt: number;
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
    this.db.run("DELETE FROM model_providers WHERE id = ?", id);
    return true;
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

  public deleteAgent(id: string): boolean {
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
    // 级联停掉该 Agent 的定时任务: 否则任务按周期触发 → chat 找不到 agent →
    // 每周期 error 审计 + 失败通知循环骚扰 (孤儿任务)。级联在单事务内原子完成
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.run(
        "UPDATE scheduled_tasks SET deleted_at = ?, enabled = 0, updated_at = ? WHERE agent_id = ? AND deleted_at IS NULL",
        Date.now(),
        Date.now(),
        id,
      );
      this.db.run("DELETE FROM agents WHERE id = ?", id);
      this.db.run("DELETE FROM channel_sessions WHERE agent_id = ?", id);
      this.db.exec("COMMIT");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
      throw err;
    }
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
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
}
