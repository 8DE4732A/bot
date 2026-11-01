import { describe, expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "../src/database/migrations.ts";

describe("migrations: schema version ahead of build", () => {
  test("user_version=8 但 v7 表缺失时重放最新幂等迁移", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE system_config (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
      INSERT INTO system_config (key, value, updated_at) VALUES ('bootstrapped', 'true', 0);
      CREATE TABLE scheduled_tasks (conversation_id TEXT);
      CREATE TABLE channel_sessions (conversation_id TEXT);
      PRAGMA user_version = 8;
    `);
    runMigrations(db);

    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
        (row) => row.name,
      ),
    );
    for (const table of [
      "model_metadata",
      "model_catalog_cache",
      "llm_turns",
      "llm_requests",
      "tool_invocations",
      "compaction_events",
    ]) {
      expect(tables.has(table)).toBe(true);
    }
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(8);
    db.close();
  });
});
