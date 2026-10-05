import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

export interface BotPaths {
  readonly root: string;
  readonly dotBot: string;
  /** 业务库: 配置/Agent/渠道/审计 (DatabaseManager 管理) */
  readonly dbFile: string;
  /** 会话库: pi-durable 状态机专用 (框架自建自管, 业务代码勿触碰) */
  readonly conversationsDbFile: string;
  readonly logsDir: string;
  readonly systemLogFile: string;
  readonly auditLogFile: string;
  readonly workspacesDir: string;
  readonly skillsDir: string;
}

/**
 * Computes all localized paths under <cwd>/.bot/
 */
export function getBotPaths(cwd: string = process.cwd()): BotPaths {
  const root = resolve(cwd);
  const dotBot = join(root, ".bot");
  const logsDir = join(dotBot, "logs");
  const workspacesDir = join(dotBot, "workspaces");
  const skillsDir = join(dotBot, "skills");

  return {
    root,
    dotBot,
    dbFile: join(dotBot, "bot.sqlite"),
    conversationsDbFile: join(dotBot, "conversations.sqlite"),
    logsDir,
    systemLogFile: join(logsDir, "bot.log"),
    auditLogFile: join(logsDir, "audit.log"),
    workspacesDir,
    skillsDir,
  };
}

/**
 * Ensures that <cwd>/.bot and all essential subdirectories exist.
 */
export function ensureBotDirectories(cwd: string = process.cwd()): BotPaths {
  const paths = getBotPaths(cwd);
  const dirs = [paths.dotBot, paths.logsDir, paths.workspacesDir, paths.skillsDir];

  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  return paths;
}

/**
 * Computes the dedicated workspace directory for a specific agent.
 */
export function getAgentWorkspaceDir(agentId: string, cwd: string = process.cwd()): string {
  const paths = getBotPaths(cwd);
  const safeId = agentId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const agentDir = join(paths.workspacesDir, safeId);
  if (!existsSync(agentDir)) {
    mkdirSync(agentDir, { recursive: true });
  }
  return agentDir;
}
