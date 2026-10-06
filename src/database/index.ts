import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getBotPaths } from "../config/env-paths.ts";
import { logger } from "../utils/logger.ts";
import { runMigrations } from "./migrations.ts";

export class DatabaseManager {
  private db: DatabaseSync;
  private static instance?: DatabaseManager;
  /** 预编译语句缓存 (sql → StatementSync): 高频路径 (调度器秒级轮询/审计写入) 免重复 prepare */
  private stmtCache = new Map<string, import("node:sqlite").StatementSync>();

  constructor(dbPath?: string) {
    const path = dbPath || getBotPaths().dbFile;
    logger.debug("Database", `Opening SQLite database at ${path}`);
    // 显式确保目录存在, 不依赖日志等其他模块的副作用
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.initPragmas();
    // 库内含全部凭据 (provider key/渠道 secret/微信 token)——收紧到 0600
    // (SQLite 新建文件默认 0644)。必须在 initPragmas 之后: WAL/SHM 由
    // journal_mode=pragma 创建, 先 chmod 会漏掉首次启动新建的 WAL。
    // WAL 里就是最近写入的凭据页, 只锁主库等于没锁
    this.tightenFilePermissions(path);
    runMigrations(this.db);
  }

  /** 凭据库三文件收紧 0600 (失败必须告警——静默降级等于 0644 裸奔) */
  private tightenFilePermissions(path: string): void {
    for (const file of [path, `${path}-wal`, `${path}-shm`]) {
      try {
        chmodSync(file, 0o600);
      } catch (err) {
        logger.warn("Database", `Failed to tighten permissions on ${file}: ${err}`);
      }
    }
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
    let stmt = this.stmtCache.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.stmtCache.set(sql, stmt);
      // 语句种类由代码决定 (几十条), 缓存无界但有界
    }
    return stmt;
  }

  public query<T = any>(sql: string, ...params: any[]): T[] {
    return this.prepare(sql).all(...params) as T[];
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
    this.stmtCache.clear();
    this.db.close();
  }
}
