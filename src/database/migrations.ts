import type { DatabaseSync } from "node:sqlite";
import { getAgentWorkspaceDir } from "../config/env-paths.ts";
import { defaultSandbox } from "../config/sandbox-defaults.ts";
import { logger } from "../utils/logger.ts";

/**
 * 版本化迁移: PRAGMA user_version 顺序推进。二期新增列/表时在数组末尾追加
 * 一个迁移函数即可 (从 vN 到 vN+1), 不要修改历史迁移。
 */
const MIGRATIONS: ((db: DatabaseSync) => void)[] = [
  // v1: 初始业务表
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS system_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS model_providers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        protocol TEXT NOT NULL,
        api_base TEXT NOT NULL,
        api_key TEXT NOT NULL,
        models TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        model_provider TEXT NOT NULL,
        model_id TEXT NOT NULL,
        temperature REAL DEFAULT 0.7,
        thinking_level TEXT DEFAULT 'medium',
        instructions TEXT NOT NULL,
        workspace_dir TEXT NOT NULL,
        sandbox_config TEXT NOT NULL,
        skills_config TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS channel_instances (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        bound_agent_id TEXT NOT NULL,
        credentials TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS channel_sessions (
        channel_instance_id TEXT NOT NULL,
        peer_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_active_at INTEGER NOT NULL,
        PRIMARY KEY (channel_instance_id, peer_id)
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT,
        channel_instance_id TEXT,
        event_type TEXT NOT NULL,
        details TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  },
  // v2: MCP server 配置 (二期 M2)
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        transport TEXT NOT NULL,
        command TEXT,
        args TEXT,
        env TEXT,
        url TEXT,
        headers TEXT,
        description TEXT,
        exposure TEXT NOT NULL DEFAULT 'direct',
        tool_exposure TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL
      );
    `);
  },
  // v3: 定时任务 (系统级 scheduler 工具组)
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        name TEXT NOT NULL,
        prompt TEXT NOT NULL,
        schedule_type TEXT NOT NULL,
        run_at INTEGER,
        interval_seconds INTEGER,
        cron_expr TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        deleted_at INTEGER,
        next_run_at INTEGER,
        last_run_at INTEGER,
        last_status TEXT,
        last_result TEXT,
        run_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_next_run
        ON scheduled_tasks (enabled, deleted_at, next_run_at);
    `);
  },
  // v4: 定时任务通知 (事件机制 → 渠道寻址)
  (db) => {
    db.exec(`
      ALTER TABLE scheduled_tasks ADD COLUMN notify_channel_instance_id TEXT;
      ALTER TABLE scheduled_tasks ADD COLUMN notify_peer_id TEXT;
      ALTER TABLE scheduled_tasks ADD COLUMN notify_enabled INTEGER NOT NULL DEFAULT 1;
    `);
  },
  // v5: WS 排队消息持久化 (四期 §4.2 "受理即落库"; R2 评审 B6——内存队列
  // 在 drain/崩溃时丢失用户已确认受理的消息)
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS gateway_queued_prompts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_gateway_queued_prompts_session
        ON gateway_queued_prompts (agent_id, session_id);
    `);
  },
  // v6: 六期——durable 调度 (每任务一个 durable task) + run ledger + 通知 outbox
  // (docs/PHASE6-DESIGN.md §5.6; 只增列/表, 旧版本可忽略)
  (db) => {
    db.exec(`
      ALTER TABLE scheduled_tasks ADD COLUMN durable_task_id TEXT;
      ALTER TABLE scheduled_tasks ADD COLUMN durable_state TEXT NOT NULL DEFAULT 'pending'
        CHECK (durable_state IN ('pending','active','aborting','blocked','disabled','done','deleted','failed','poisoned'));
      ALTER TABLE scheduled_tasks ADD COLUMN schedule_version INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE scheduled_tasks ADD COLUMN conversation_id TEXT;
      ALTER TABLE scheduled_tasks ADD COLUMN conversation_poisoned INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE scheduled_tasks ADD COLUMN poison_run_key TEXT;
      ALTER TABLE scheduled_tasks ADD COLUMN poison_fence INTEGER;

      CREATE TABLE IF NOT EXISTS scheduled_task_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        run_key TEXT NOT NULL,
        scheduled_for INTEGER NOT NULL,
        run_number INTEGER NOT NULL,
        schedule_version INTEGER NOT NULL,
        request_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running','ok','error','done','aborted')),
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        conversation_id TEXT,
        durable_task_id TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 1,
        lease_owner TEXT,
        lease_until INTEGER,
        lease_fence INTEGER NOT NULL DEFAULT 0,
        result TEXT,
        error TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduled_task_runs_key
        ON scheduled_task_runs (task_id, run_key);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduled_task_runs_number
        ON scheduled_task_runs (task_id, run_number);
      CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_task
        ON scheduled_task_runs (task_id, scheduled_for DESC);
      CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_lease
        ON scheduled_task_runs (status, lease_until);

      CREATE TABLE IF NOT EXISTS scheduled_task_notifications (
        run_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        payload TEXT NOT NULL CHECK (json_valid(payload) AND length(CAST(payload AS BLOB)) <= 65536),
        status TEXT NOT NULL CHECK (status IN ('pending','sending','delivered','failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER,
        last_error TEXT,
        claimed_by TEXT,
        claim_token TEXT,
        claimed_at INTEGER,
        claimed_until INTEGER,
        delivered_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_scheduled_task_notifications_due
        ON scheduled_task_notifications (status, next_attempt_at);
      CREATE INDEX IF NOT EXISTS idx_scheduled_task_notifications_claim
        ON scheduled_task_notifications (status, claimed_until);
    `);
  },
  // v7: 七期——上下文管理与可观测性（docs/CONTEXT-OBSERVABILITY.md）
  // 只增表/索引；模型元数据、turn 聚合、请求/工具明细、压缩事件
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS model_catalog_cache (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        payload_gz BLOB NOT NULL,
        etag TEXT,
        last_modified TEXT,
        fetched_at INTEGER NOT NULL,
        last_checked_at INTEGER NOT NULL,
        provider_count INTEGER NOT NULL DEFAULT 0,
        model_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS model_metadata (
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        auto_json TEXT,
        auto_source TEXT,
        manual_json TEXT,
        matched_provider TEXT,
        matched_model TEXT,
        refreshed_at INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (provider_id, model_id)
      );

      CREATE TABLE IF NOT EXISTS llm_turns (
        turn_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        session_kind TEXT NOT NULL,
        scheduler_task_id TEXT,
        provider TEXT,
        model_id TEXT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        duration_ms INTEGER,
        first_chunk_ms INTEGER,
        ttft_ms INTEGER,
        llm_ms INTEGER,
        tool_ms INTEGER,
        request_count INTEGER NOT NULL DEFAULT 0,
        tool_count INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read INTEGER NOT NULL DEFAULT 0,
        cache_write INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        priced INTEGER NOT NULL DEFAULT 0,
        usage_json TEXT,
        context_tokens INTEGER,
        context_estimate_tokens INTEGER,
        context_window INTEGER,
        compacted_before INTEGER NOT NULL DEFAULT 0,
        compaction_ms INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        error TEXT,
        request_id TEXT,
        run_key TEXT,
        trace_id TEXT,
        submission_id TEXT,
        detail_truncated INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_llm_turns_conv ON llm_turns(conversation_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_llm_turns_agent ON llm_turns(agent_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_llm_turns_started ON llm_turns(started_at);

      CREATE TABLE IF NOT EXISTS llm_requests (
        span_id TEXT PRIMARY KEY,
        turn_id TEXT,
        conversation_id TEXT,
        trace_id TEXT,
        parent_span_id TEXT,
        task_id TEXT,
        kind TEXT NOT NULL,
        task_kind TEXT,
        compaction_id TEXT,
        provider TEXT,
        model_id TEXT,
        api TEXT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        duration_ms INTEGER,
        first_chunk_ms INTEGER,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read INTEGER NOT NULL DEFAULT 0,
        cache_write INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        stop_reason TEXT,
        status TEXT NOT NULL,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_llm_requests_turn ON llm_requests(turn_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_llm_requests_conv ON llm_requests(conversation_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_llm_requests_started ON llm_requests(started_at);
      CREATE INDEX IF NOT EXISTS idx_llm_requests_task ON llm_requests(task_id);

      CREATE TABLE IF NOT EXISTS tool_invocations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        turn_id TEXT,
        conversation_id TEXT,
        trace_id TEXT,
        task_id TEXT,
        tool_call_id TEXT,
        tool_name TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        duration_ms INTEGER,
        status TEXT NOT NULL,
        error TEXT,
        UNIQUE(trace_id, tool_call_id)
      );
      CREATE INDEX IF NOT EXISTS idx_tool_inv_turn ON tool_invocations(turn_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_tool_inv_started ON tool_invocations(started_at);

      CREATE TABLE IF NOT EXISTS compaction_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL,
        agent_id TEXT,
        session_id TEXT,
        turn_id TEXT,
        task_id TEXT,
        trace_id TEXT,
        compaction_id TEXT,
        profile TEXT NOT NULL,
        trigger TEXT NOT NULL,
        threshold_tokens INTEGER,
        keep_recent_tokens INTEGER,
        before_tokens INTEGER,
        after_tokens INTEGER,
        before_estimate_tokens INTEGER,
        after_estimate_tokens INTEGER,
        before_entries INTEGER,
        after_entries INTEGER,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        duration_ms INTEGER,
        cost_usd REAL,
        cost_in_turn INTEGER NOT NULL DEFAULT 0,
        request_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        fail_open INTEGER NOT NULL DEFAULT 0,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_compaction_conv ON compaction_events(conversation_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_compaction_turn ON compaction_events(turn_id);
      CREATE INDEX IF NOT EXISTS idx_compaction_started ON compaction_events(started_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_compaction_turn_task
        ON compaction_events(turn_id, task_id)
        WHERE turn_id IS NOT NULL AND task_id IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_conversation ON scheduled_tasks(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_channel_sessions_conversation ON channel_sessions(conversation_id);
    `);
  },
];

export function runMigrations(db: DatabaseSync) {
  logger.debug("Database", "Running migrations...");
  const { user_version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let v = user_version; v < MIGRATIONS.length; v++) {
    logger.info("Database", `Applying schema migration v${v + 1}`);
    try {
      // 迁移与版本号在同一事务内原子推进: 中途失败回滚后下次重试, 不会
      // 出现"列已加、版本未推进"导致的 duplicate column 卡死
      db.exec("BEGIN IMMEDIATE");
      MIGRATIONS[v](db);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
      logger.error("Database", `Migration v${v + 1} failed and was rolled back:`, err);
      throw err;
    }
  }
  // 版本号可能领先于当前源码（切回旧分支、手工改过 user_version、或新版本
  // 曾写入更高的 PRAGMA）。此时上面的循环会静默跳过，最新迁移的表可能缺失，
  // 启动后第一条 SELECT 就会报 "no such table"。最新迁移必须保持幂等
  // （CREATE TABLE/INDEX IF NOT EXISTS），在此安全重放一次。
  const { user_version: versionAfter } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  if (versionAfter >= MIGRATIONS.length) repairLatestSchema(db);
  bootstrapDefaults(db);
}

function repairLatestSchema(db: DatabaseSync): void {
  const latest = MIGRATIONS[MIGRATIONS.length - 1];
  const sentinel = "model_metadata";
  const present = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(sentinel);
  if (present) return;
  logger.warn(
    "Database",
    `Schema version is ahead of this build but '${sentinel}' is missing; replaying the latest idempotent migration`,
  );
  try {
    db.exec("BEGIN IMMEDIATE");
    latest(db);
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw err;
  }
}

function bootstrapDefaults(db: DatabaseSync) {
  const now = Date.now();

  // Check if system has already been bootstrapped
  const checkInit = db.prepare("SELECT value FROM system_config WHERE key = 'bootstrapped'").get() as { value: string } | undefined;
  if (checkInit && checkInit.value === "true") {
    // Already bootstrapped once! Do not re-bootstrap deleted items.
    return;
  }

  // Check if this database was already in use from previous versions
  const checkConfig = db.prepare("SELECT COUNT(*) as count FROM system_config").get() as { count: number };
  const checkAgent = db.prepare("SELECT COUNT(*) as count FROM agents").get() as { count: number };
  const checkChannel = db.prepare("SELECT COUNT(*) as count FROM channel_instances").get() as { count: number };
  const checkProviders = db.prepare("SELECT COUNT(*) as count FROM model_providers").get() as { count: number };

  if (checkConfig.count > 0 || checkAgent.count > 0 || checkChannel.count > 0 || checkProviders.count > 0) {
    // Existing database with user modifications. Mark as bootstrapped and never restore deleted items.
    db.prepare("INSERT INTO system_config (key, value, updated_at) VALUES ('bootstrapped', 'true', ?) ON CONFLICT(key) DO UPDATE SET value = 'true', updated_at = excluded.updated_at").run(now);
    return;
  }

  // Truly a fresh database: perform one-time initial seed
  logger.info("Database", "Performing initial one-time database bootstrap...");

  // 1. Bootstrap default BYOK model providers
  logger.info("Database", "Bootstrapping default BYOK model providers...");
  const insertProvider = db.prepare(`
    INSERT INTO model_providers (id, name, protocol, api_base, api_key, models, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertProvider.run(
    "deepseek",
    "DeepSeek 官方",
    "openai-completions",
    "https://api.deepseek.com",
    "",
    JSON.stringify(["deepseek-chat", "deepseek-reasoner"]),
    now,
    now,
  );

  insertProvider.run(
    "siliconflow",
    "硅基流动 (SiliconFlow)",
    "openai-completions",
    "https://api.siliconflow.cn/v1",
    "",
    JSON.stringify(["deepseek-ai/DeepSeek-V3", "deepseek-ai/DeepSeek-R1", "Qwen/Qwen2.5-72B-Instruct"]),
    now,
    now,
  );

  insertProvider.run(
    "openai",
    "OpenAI 官方",
    "openai-responses",
    "https://api.openai.com/v1",
    "",
    JSON.stringify(["gpt-4o", "gpt-4o-mini", "o1", "o3-mini"]),
    now,
    now,
  );

  insertProvider.run(
    "ollama",
    "本地 Ollama",
    "openai-completions",
    "http://localhost:11434/v1",
    "ollama",
    JSON.stringify(["llama3.3", "qwen2.5-coder", "deepseek-r1:8b"]),
    now,
    now,
  );

  // 2. Bootstrap default agent
  logger.info("Database", "Bootstrapping initial default agent...");
  const defaultWorkspace = getAgentWorkspaceDir("agent-default");
  const defaultSandboxJson = JSON.stringify(defaultSandbox(defaultWorkspace));

  const defaultSkills = JSON.stringify(["coding-tools", "web-search", "datetime"]);

  db.prepare(`
    INSERT INTO agents (
      id, name, description, model_provider, model_id,
      temperature, thinking_level, instructions,
      workspace_dir, sandbox_config, skills_config,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "agent-default",
    "默认通用助手",
    "开箱即用的默认通用 Agent，支持代码编写、检索与工具执行",
    "deepseek",
    "deepseek-chat",
    0.7,
    "medium",
    "You are a helpful, precise, and proactive AI assistant.",
    defaultWorkspace,
    defaultSandboxJson,
    defaultSkills,
    now,
    now,
  );

  // 3. Bootstrap default terminal channel
  logger.info("Database", "Bootstrapping initial terminal channel...");
  db.prepare(`
    INSERT INTO channel_instances (
      id, type, name, enabled, bound_agent_id, credentials, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    "terminal-main",
    "terminal",
    "本地终端交互通道",
    1,
    "agent-default",
    JSON.stringify({}),
    now,
  );

  // 4. Default web port
  db.prepare("INSERT INTO system_config (key, value, updated_at) VALUES (?, ?, ?)").run(
    "web_port",
    "3000",
    now,
  );

  // 5. Mark database as bootstrapped
  db.prepare("INSERT INTO system_config (key, value, updated_at) VALUES ('bootstrapped', 'true', ?)").run(
    now,
  );
}
