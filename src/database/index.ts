import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getBotPaths } from "../config/env-paths.ts";
import { logger } from "../utils/logger.ts";
import { runMigrations } from "./migrations.ts";

export class DatabaseManager {
  private db: DatabaseSync;
  private static instance?: DatabaseManager;

  constructor(dbPath?: string) {
    const path = dbPath || getBotPaths().dbFile;
    logger.debug("Database", `Opening SQLite database at ${path}`);
    // 显式确保目录存在, 不依赖日志等其他模块的副作用
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.initPragmas();
    runMigrations(this.db);
  }

  public static getInstance(dbPath?: string): DatabaseManager {
    if (!DatabaseManager.instance) {
      DatabaseManager.instance = new DatabaseManager(dbPath);
    }
    return DatabaseManager.instance;
  }

  public getRawDatabase(): DatabaseSync {
    return this.db;
  }

  private initPragmas() {
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec("PRAGMA foreign_keys = ON;");
  }

  public exec(sql: string) {
    this.db.exec(sql);
  }

  public prepare(sql: string) {
    return this.db.prepare(sql);
  }

  public query<T = any>(sql: string, ...params: any[]): T[] {
    const stmt = this.db.prepare(sql);
    return stmt.all(...params) as T[];
  }

  public queryOne<T = any>(sql: string, ...params: any[]): T | undefined {
    const stmt = this.db.prepare(sql);
    return (stmt.get(...params) as T) || undefined;
  }

  public run(sql: string, ...params: any[]) {
    const stmt = this.db.prepare(sql);
    return stmt.run(...params);
  }

  public close() {
    this.db.close();
  }
}
