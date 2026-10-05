import { describe, expect, it } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ensureBotDirectories, getAgentWorkspaceDir, getBotPaths } from "../src/config/env-paths.ts";

describe("env-paths", () => {
  const testCwd = "/tmp/test-bot-paths-" + Date.now();

  it("should compute correct localized paths under cwd/.bot/", () => {
    const paths = getBotPaths(testCwd);
    expect(paths.root).toBe(testCwd);
    expect(paths.dotBot).toBe(join(testCwd, ".bot"));
    expect(paths.dbFile).toBe(join(testCwd, ".bot", "bot.sqlite"));
    // 会话状态机分库, 与业务库物理隔离
    expect(paths.conversationsDbFile).toBe(join(testCwd, ".bot", "conversations.sqlite"));
    expect(paths.logsDir).toBe(join(testCwd, ".bot", "logs"));
    expect(paths.workspacesDir).toBe(join(testCwd, ".bot", "workspaces"));
  });

  it("should ensure all bot directories exist", () => {
    const paths = ensureBotDirectories(testCwd);
    expect(existsSync(paths.dotBot)).toBe(true);
    expect(existsSync(paths.logsDir)).toBe(true);
    expect(existsSync(paths.workspacesDir)).toBe(true);
    expect(existsSync(paths.skillsDir)).toBe(true);

    const agentDir = getAgentWorkspaceDir("test-agent", testCwd);
    expect(existsSync(agentDir)).toBe(true);

    rmSync(testCwd, { recursive: true, force: true });
  });
});
