import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import type { BotSandboxConfig } from "../config/database-store.ts";
import { DatabaseStore } from "../config/database-store.ts";
import { join } from "node:path";
import { getBotPaths } from "../config/env-paths.ts";
import { EventBus } from "../core/event-bus.ts";
import { logger } from "../utils/logger.ts";

/**
 * 平台级内核禁读: 与应用层 PathGuard 的 platformDenyRead 同源,
 * ASRT 读策略是"默认放行 + deny 列表", 不合并的话 bash 仍可直接
 * cat 出密钥库。每次 wrapCommand 都随配置传入, 不依赖全局 initialize。
 */
function kernelDenyRead(extraDenyRead: string[] = []): string[] {
  const paths = getBotPaths();
  return [
    join(paths.dotBot, "bot.sqlite"),
    join(paths.dotBot, "bot.sqlite-wal"),
    join(paths.dotBot, "bot.sqlite-shm"),
    join(paths.dotBot, "conversations.sqlite"),
    join(paths.dotBot, "conversations.sqlite-wal"),
    join(paths.dotBot, "conversations.sqlite-shm"),
    // 渠道持久化凭据 (微信 bot_token/context_token 等)——0600 只防其他 OS 用户,
    // 沙盒 Agent 同一 OS 用户, 必须靠路径 deny (与 platformDenyRead 同步演进)
    join(paths.dotBot, "channels"),
    join(paths.dotBot, "logs"),
    join(paths.root, ".env"),
    join(paths.root, ".env.*"),
    join(paths.root, ".git-credentials"),
    ...extraDenyRead,
  ];
}

export class SandboxRuntimeManager {
  private static initialized = false;
  /** 平台是否支持内核级沙盒 (macOS Seatbelt / Linux Bubblewrap) */
  static isSupported = process.platform === "darwin" || process.platform === "linux";
  /** 命令文本前缀 → agentId: 内核违规事件 (violation.command) 归因用 */
  private static commandOwners = new Map<string, string>();

  public static async init(config: BotSandboxConfig): Promise<boolean> {
    if (!config.enabled) {
      logger.info("Sandbox", "Sandbox is disabled in configuration");
      return false;
    }

    if (!this.isSupported) {
      logger.warn("Sandbox", `OS sandboxing not supported on platform: ${process.platform}`);
      return false;
    }

    try {
      // enableLogMonitor=true: macOS 监听系统日志 / Linux 监听 seccomp,
      // 内核层 deny 事件进入 SandboxViolationStore (否则内核拦截完全静默)
      await SandboxManager.initialize({
        network: {
          allowedDomains: config.network.allowedDomains,
          deniedDomains: config.network.deniedDomains,
          allowLocalBinding: config.network.allowLocalBinding ?? false,
        },
        filesystem: {
          allowWrite: config.filesystem.allowWrite,
          denyRead: config.filesystem.denyRead,
          denyWrite: config.filesystem.denyWrite,
        },
      }, undefined, true);

      // 违规事件 → 审计 + 平台事件总线 (内核静默拒绝从此可追溯)
      SandboxManager.getSandboxViolationStore().subscribe((violations) => {
        for (const violation of violations) this.recordViolation(violation);
      });

      this.initialized = true;
      logger.info(
        "Sandbox",
        `Sandbox initialized: ${config.network.allowedDomains.length} allowed domains, ${config.filesystem.allowWrite.length} write paths, violation monitor on`,
      );
      return true;
    } catch (err) {
      logger.error("Sandbox", "Failed to initialize Anthropic Sandbox Runtime:", err);
      this.initialized = false;
      return false;
    }
  }

  /** 归因: 命令文本前缀 → agentId (keys 比较前 100 字符, 与 ASRT commandId 语义一致) */
  private static noteCommandOwner(command: string, agentId?: string): void {
    if (!agentId) return;
    const key = command.slice(0, 100);
    // LRU: 先删后插保持插入序, 超上限淘汰最旧
    this.commandOwners.delete(key);
    this.commandOwners.set(key, agentId);
    if (this.commandOwners.size > 500) {
      const oldest = this.commandOwners.keys().next().value;
      if (oldest !== undefined) this.commandOwners.delete(oldest);
    }
  }

  private static recordViolation(violation: { line: string; command?: string; timestamp: Date }): void {
    const agentId = violation.command
      ? this.commandOwners.get(violation.command.slice(0, 100))
      : undefined;
    const details = {
      command: violation.command?.slice(0, 200),
      line: violation.line.slice(0, 300),
      agentId: agentId ?? null,
    };
    try {
      new DatabaseStore().recordAudit("sandbox.violation", details, agentId);
    } catch (err) {
      logger.warn("Sandbox", `Failed to record violation audit: ${err}`);
    }
    EventBus.getInstance().publish({
      type: "sandbox.violation",
      agentId: agentId ?? null,
      line: violation.line,
      command: violation.command,
      timestamp: violation.timestamp.getTime(),
    });
  }

  public static async wrapCommand(
    command: string,
    config: BotSandboxConfig,
    cwd?: string,
    extraDenyRead: string[] = [],
    agentId?: string,
  ): Promise<string> {
    if (!config.enabled || !this.isSupported) {
      return command;
    }

    // Ensure manager is initialized
    if (!this.initialized) {
      await this.init(config);
    }
    this.noteCommandOwner(command, agentId);

    try {
      return await SandboxManager.wrapWithSandbox(command, undefined, {
        network: {
          allowedDomains: config.network.allowedDomains,
          deniedDomains: config.network.deniedDomains,
          allowLocalBinding: config.network.allowLocalBinding ?? false,
        },
        filesystem: {
          allowWrite: config.filesystem.allowWrite,
          // 平台红线 (密钥库/会话库/其他 Agent 工作区) 对内核层同样生效
          denyRead: [...kernelDenyRead(extraDenyRead), ...config.filesystem.denyRead],
          denyWrite: config.filesystem.denyWrite,
        },
      });
    } catch (err) {
      // fail-closed: 沙盒包装失败时拒绝降级为裸执行, 由调用方返回执行错误并审计
      logger.error("Sandbox", `wrapWithSandbox failed, refusing to run unsandboxed: ${err}`);
      throw new Error(`Sandbox wrap failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}
