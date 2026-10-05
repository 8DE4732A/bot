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
    this.db.run("DELETE FROM agents WHERE id = ?", id);
    this.db.run("DELETE FROM channel_sessions WHERE agent_id = ?", id);
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
