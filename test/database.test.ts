import { describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { DatabaseStore } from "../src/config/database-store.ts";
import { DatabaseManager } from "../src/database/index.ts";

describe("Database & Store", () => {
  const testDbFile = `/tmp/test-db-${Date.now()}.sqlite`;
  const db = new DatabaseManager(testDbFile);
  const store = new DatabaseStore(db);

  it("should bootstrap default agent and terminal channel", () => {
    const agents = store.listAgents();
    expect(agents.length).toBeGreaterThanOrEqual(1);

    const defaultAgent = store.getAgent("agent-default");
    expect(defaultAgent).toBeDefined();
    expect(defaultAgent?.name).toBe("默认通用助手");
    expect(defaultAgent?.skills).toContain("coding-tools");

    const channels = store.listChannels();
    expect(channels.length).toBeGreaterThanOrEqual(1);
    expect(channels.find((c) => c.id === "terminal-main")).toBeDefined();
  });

  it("should support creating and retrieving multiple agents", () => {
    const newAgent = {
      id: "agent-wecom-custom",
      name: "企微自定义助手",
      description: "独立客服机器人",
      model: {
        provider: "deepseek",
        modelId: "deepseek-chat",
        temperature: 0.5,
        thinkingLevel: "low" as const,
      },
      instructions: "You are a customer support bot.",
      workspaceDir: "/tmp/custom-workspace",
      sandbox: {
        enabled: true,
        network: { allowedDomains: ["api.example.com"], deniedDomains: [] },
        filesystem: { allowWrite: ["/tmp/custom-workspace"], denyRead: ["~/.ssh"], denyWrite: [".git"] },
      },
      skills: ["web-search"],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    store.saveAgent(newAgent);
    const retrieved = store.getAgent("agent-wecom-custom");
    expect(retrieved).toBeDefined();
    expect(retrieved?.name).toBe("企微自定义助手");
    expect(retrieved?.model.provider).toBe("deepseek");
    expect(retrieved?.skills).toEqual(["web-search"]);

    // Test binding channel to this agent
    const newChannel = {
      id: "wecom-instance-1",
      type: "wecom" as const,
      name: "企微客服机器人 1",
      enabled: true,
      boundAgentId: "agent-wecom-custom",
      credentials: { botId: "bot123", secret: "sec456" },
      updatedAt: Date.now(),
    };
    store.saveChannel(newChannel);

    const retrievedChan = store.getChannel("wecom-instance-1");
    expect(retrievedChan).toBeDefined();
    expect(retrievedChan?.boundAgentId).toBe("agent-wecom-custom");
    expect(retrievedChan?.credentials.botId).toBe("bot123");
  });

  it("should record and list audit logs", () => {
    store.recordAudit("fs_violation", { path: "/etc/passwd", action: "read" }, "agent-default");
    const logs = store.listAuditLogs(10);
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs[0].eventType).toBe("fs_violation");
    expect(logs[0].agentId).toBe("agent-default");
  });

  it("should NOT re-bootstrap default model providers or agents after user deletes them and restarts", () => {
    // 1. Verify providers exist initially
    const initialProviders = store.listModelProviders();
    expect(initialProviders.length).toBeGreaterThan(0);

    // 2. Delete all providers (先解绑 agent 引用, 引用保护会拒绝删除被引用的 provider)
    for (const a of store.listAgents()) {
      a.model.provider = "tmp-unbound";
      store.saveAgent(a);
    }
    for (const p of initialProviders) {
      store.deleteModelProvider(p.id);
    }
    expect(store.listModelProviders().length).toBe(0);

    // 3. Close database and reopen (simulating restart)
    db.close();
    const restartedDb = new DatabaseManager(testDbFile);
    const restartedStore = new DatabaseStore(restartedDb);

    // 4. Verify providers remain empty (not resurrecting)
    expect(restartedStore.listModelProviders().length).toBe(0);

    restartedDb.close();
    rmSync(testDbFile, { force: true });
    rmSync(`${testDbFile}-wal`, { force: true });
    rmSync(`${testDbFile}-shm`, { force: true });
  });
});
