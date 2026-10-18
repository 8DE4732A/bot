import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getBotPaths } from "../config/env-paths.ts";
import { logger } from "../utils/logger.ts";
import { runMigrations } from "./migrations.ts";

export class DatabaseManager {
  private db: DatabaseSync;
  private readonly path: string;
  private static instance?: DatabaseManager;
  /** 预编译语句缓存 (sql → StatementSync): 高频路径 (调度器秒级轮询/审计写入) 免重复 prepare */
  private stmtCache = new Map<string, import("node:sqlite").StatementSync>();
  private recovering = false;
  /** 显式事务进行中：IO 错误时只回滚/重开，绝不透明重试语句 */
  private inTransaction = false;

  constructor(dbPath?: string) {
    const path = dbPath || getBotPaths().dbFile;
    this.path = path;
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

  private isDiskIoError(err: unknown): boolean {
    return (
      err instanceof Error &&
      ((err as any).code === "ERR_SQLITE_ERROR" || (err as any).errcode === 6922) &&
      /disk I\/O error/i.test(err.message)
    );
  }

  /** 五期安全修复: 主库被硬链接后 SQLite WAL 会持续 disk I/O error。 */
  private recoverOnce<T>(fn: () => T): T {
    try {
      return fn();
    } catch (err) {
      if (!this.isDiskIoError(err)) throw err;
      if (this.inTransaction) {
        // 显式事务中途 IO 错误：重开连接会回滚未提交的写入；
        // 绝不能在新连接上重放语句（否则半程提交，COMMIT/ROLLBACK 失效）
        this.reopen();
        throw err;
      }
      this.reopen();
      return fn();
    }
  }

  /** 重新打开连接（清除预编译语句缓存；WAL 在 open 时自然恢复） */
  public reopen(): void {
    if (this.recovering) return;
    this.recovering = true;
    try {
      logger.warn("Database", `SQLite disk I/O error detected; reopening ${this.path}`);
      try {
        this.db.close();
      } catch {
        /* 已损坏的连接关闭失败可忽略 */
      }
      this.stmtCache.clear();
      this.db = new DatabaseSync(this.path);
      this.initPragmas();
      this.tightenFilePermissions(this.path);
      this.inTransaction = false; // 旧连接上的事务已被 close 回滚
      logger.warn("Database", `SQLite connection reopened: ${this.path}`);
    } finally {
      this.recovering = false;
    }
  }

  /** 以底层连接的真实事务状态为准（Node/Bun DatabaseSync 提供 isTransaction） */
  private syncTransactionState(): void {
    const raw = (this.db as any).isTransaction;
    if (typeof raw === "boolean") this.inTransaction = raw;
  }

  public exec(sql: string) {
    // 支持单条或多条语句：先剔除字符串字面量与注释，避免误判。
    const cleaned = sql
      .replace(/'(?:''|[^'])*'/g, "''")
      .replace(/"(?:""|[^"])*"/g, '""')
      .replace(/`[^`]*`/g, "``")
      .replace(/--[^\n]*/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    const txns = [
      ...cleaned.matchAll(/\b(BEGIN|COMMIT|ROLLBACK(?!\s+TO)|END|SAVEPOINT|RELEASE)\b/gi),
    ].map((m) => m[1].toUpperCase());
    const lastTxn = txns[txns.length - 1];
    const hasRawState = typeof (this.db as any).isTransaction === "boolean";
    try {
      this.db.exec(sql);
      this.syncTransactionState();
      if (!hasRawState) {
        if (lastTxn === "BEGIN" || lastTxn === "SAVEPOINT") this.inTransaction = true;
        else if (lastTxn) this.inTransaction = false;
      }
    } catch (err) {
      // 失败路径也必须同步真实状态：多语句事务可能在失败前已开启事务
      this.syncTransactionState();
      if (!hasRawState && lastTxn === "BEGIN") this.inTransaction = true;
      // 事务/DDL 不自动重放（避免半程重入）；恢复连接后把原错误交给调用方
      if (this.isDiskIoError(err)) this.reopen();
      throw err;
    }
  }

  public prepare(sql: string) {
    let stmt = this.stmtCache.get(sql);
    if (!stmt) {
      stmt = this.recoverOnce(() => this.db.prepare(sql));
      this.stmtCache.set(sql, stmt);
      // 语句种类由代码决定 (几十条), 缓存无界但有界
    }
    return stmt;
  }

  public query<T = any>(sql: string, ...params: any[]): T[] {
    return this.recoverOnce(() => this.prepare(sql).all(...params)) as T[];
  }

  public queryOne<T = any>(sql: string, ...params: any[]): T | undefined {
    return (this.recoverOnce(() => this.prepare(sql).get(...params)) as T) || undefined;
  }

  public run(sql: string, ...params: any[]) {
    return this.recoverOnce(() => this.prepare(sql).run(...params));
  }

  public close() {
    this.stmtCache.clear();
    this.db.close();
  }
}
