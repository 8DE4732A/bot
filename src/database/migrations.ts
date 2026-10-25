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
  bootstrapDefaults(db);
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
