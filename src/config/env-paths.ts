import { existsSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";

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
 * Agent id → 安全目录名（workspace / archive / 注册表扩展名共用同一策略）。
 */
export function safeAgentId(agentId: string): string {
  return agentId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** target 是否位于 root 之内（含 root 本身）；路径包含性判断的唯一实现。 */
export function isInsidePath(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Computes the dedicated workspace directory for a specific agent.
 */
export function getAgentWorkspaceDir(agentId: string, cwd: string = process.cwd()): string {
  const paths = getBotPaths(cwd);
  const agentDir = join(paths.workspacesDir, safeAgentId(agentId));
  if (!existsSync(agentDir)) {
    mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  }
  return agentDir;
}

/**
 * 五期: 新建 Agent 的默认工作区带代际后缀。
 * 删除 Agent 时磁盘目录保留/归档，若同 ID 重建仍用 <id> 会继承旧的私有技能与记忆；
 * 代际后缀让每次新建都得到独立目录（现有 Agent 的 workspace_dir 不受影响）。
 */
export function createAgentWorkspaceDir(agentId: string, cwd: string = process.cwd()): string {
  const paths = getBotPaths(cwd);
  const incarnation = `${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`;
  const agentDir = join(paths.workspacesDir, `${safeAgentId(agentId)}-${incarnation}`);
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  return agentDir;
}

/** 删除 Agent 时默认工作区的归档根（位于 workspaces 内，仍受跨 Agent 禁读保护） */
export function getWorkspaceArchiveDir(cwd: string = process.cwd()): string {
  const paths = getBotPaths(cwd);
  return join(paths.workspacesDir, ".archive");
}
