import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import type { BotSandboxConfig } from "../config/database-store.ts";
import { join } from "node:path";
import { getBotPaths } from "../config/env-paths.ts";
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
      });

      this.initialized = true;
      logger.info(
        "Sandbox",
        `Sandbox initialized: ${config.network.allowedDomains.length} allowed domains, ${config.filesystem.allowWrite.length} write paths`,
      );
      return true;
    } catch (err) {
      logger.error("Sandbox", "Failed to initialize Anthropic Sandbox Runtime:", err);
      this.initialized = false;
      return false;
    }
  }

  public static async wrapCommand(
    command: string,
    config: BotSandboxConfig,
    cwd?: string,
    extraDenyRead: string[] = [],
  ): Promise<string> {
    if (!config.enabled || !this.isSupported) {
      return command;
    }

    // Ensure manager is initialized
    if (!this.initialized) {
      await this.init(config);
    }

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
