import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getBotPaths } from "../config/env-paths.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

class Logger {
  private logPath?: string;
  private auditPath?: string;

  constructor() {
    try {
      const paths = getBotPaths();
      this.logPath = paths.systemLogFile;
      this.auditPath = paths.auditLogFile;
    } catch {
      // paths might not be initialized yet
    }
  }

  public init(cwd: string) {
    const paths = getBotPaths(cwd);
    this.logPath = paths.systemLogFile;
    this.auditPath = paths.auditLogFile;
  }

  private writeToFile(path: string | undefined, line: string) {
    if (!path) return;
    try {
      const dir = dirname(path);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      appendFileSync(path, line + "\n", "utf8");
    } catch {
      // Ignore write errors to prevent crashing
    }
  }

  private formatConsole(level: LogLevel, tag: string, message: string): string {
    const timestamp = new Date().toLocaleTimeString();
    const colors: Record<LogLevel, string> = {
      debug: "\x1b[90m", // Gray
      info: "\x1b[36m",  // Cyan
      warn: "\x1b[33m",  // Yellow
      error: "\x1b[31m", // Red
    };
    const reset = "\x1b[0m";
    const color = colors[level] || reset;
    return `\x1b[90m[${timestamp}]\x1b[0m ${color}[${level.toUpperCase()}]\x1b[0m \x1b[35m[${tag}]\x1b[0m ${message}`;
  }

  public debug(tag: string, message: string, data?: unknown) {
    if (process.env.DEBUG || process.env.BOT_DEBUG) {
      console.log(this.formatConsole("debug", tag, message));
    }
    const record = `[${new Date().toISOString()}] [DEBUG] [${tag}] ${message} ${data ? JSON.stringify(data) : ""}`;
    this.writeToFile(this.logPath, record);
  }

  public info(tag: string, message: string, data?: unknown) {
    console.log(this.formatConsole("info", tag, message));
    const record = `[${new Date().toISOString()}] [INFO] [${tag}] ${message} ${data ? JSON.stringify(data) : ""}`;
    this.writeToFile(this.logPath, record);
  }

  public warn(tag: string, message: string, data?: unknown) {
    console.warn(this.formatConsole("warn", tag, message));
    const record = `[${new Date().toISOString()}] [WARN] [${tag}] ${message} ${data ? JSON.stringify(data) : ""}`;
    this.writeToFile(this.logPath, record);
  }

  public error(tag: string, message: string, error?: unknown) {
    console.error(this.formatConsole("error", tag, message));
    if (error && typeof error === "object" && "stack" in error) {
      console.error((error as Error).stack);
    }
    const errText = error instanceof Error ? `${error.message}\n${error.stack}` : JSON.stringify(error || "");
    const record = `[${new Date().toISOString()}] [ERROR] [${tag}] ${message} ${errText}`;
    this.writeToFile(this.logPath, record);
  }

  public audit(eventType: string, details: Record<string, unknown>) {
    const record = `[${new Date().toISOString()}] [AUDIT] [${eventType}] ${JSON.stringify(details)}`;
    this.writeToFile(this.auditPath, record);
  }
}

export const logger = new Logger();
