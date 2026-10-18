import { describe, expect, it } from "bun:test";
import { linkSync, rmSync } from "node:fs";
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

  it("reopens SQLite after hardlink-induced disk I/O error (五期安全修复)", () => {
    const p = `/tmp/test-db-recover-${Date.now()}.sqlite`;
    const d = new DatabaseManager(p);
    d.run("CREATE TABLE t(x INTEGER)");
    d.run("INSERT INTO t VALUES (1)");
    d.run("INSERT INTO t VALUES (2)");
    // WAL 连接在主库出现第二个硬链接后会持续 disk I/O error
    linkSync(p, `${p}.link`);
    const rows = d.query<{ x: number }>("SELECT x FROM t ORDER BY x");
    expect(rows.map((r) => r.x)).toEqual([1, 2]);
    d.run("INSERT INTO t VALUES (3)");
    expect(d.queryOne<{ c: number }>("SELECT COUNT(*) AS c FROM t")?.c).toBe(3);
    d.close();
    for (const f of [p, `${p}-wal`, `${p}-shm`, `${p}.link`]) rmSync(f, { force: true });
  });

  it("tracks transaction state for single and multi-statement exec", () => {
    const p = `/tmp/test-db-txn-state-${Date.now()}.sqlite`;
    const d = new DatabaseManager(p);
    d.run("CREATE TABLE t(x INTEGER)");
    d.exec("BEGIN IMMEDIATE; INSERT INTO t VALUES (1); COMMIT;");
    expect((d as any).inTransaction).toBe(false);
    d.exec("BEGIN IMMEDIATE; INSERT INTO t VALUES (2);");
    expect((d as any).inTransaction).toBe(true);
    d.exec("ROLLBACK");
    expect((d as any).inTransaction).toBe(false);
    // 字符串字面量/注释中的事务词不得污染状态
    d.exec("INSERT INTO t VALUES ('BEGIN')");
    d.exec("INSERT INTO t VALUES ('COMMIT') -- BEGIN");
    d.exec('CREATE TABLE dq("BEGIN" INTEGER)');
    d.exec('INSERT INTO dq("BEGIN") VALUES (1)');
    expect((d as any).inTransaction).toBe(false);
    // savepoint 的 ROLLBACK TO 不是事务结束
    d.exec("BEGIN IMMEDIATE; SAVEPOINT s; ROLLBACK TO s; COMMIT;");
    expect((d as any).inTransaction).toBe(false);
    d.exec("BEGIN IMMEDIATE; SAVEPOINT s; ROLLBACK TO s;");
    expect((d as any).inTransaction).toBe(true);
    d.exec("ROLLBACK");
    expect((d as any).inTransaction).toBe(false);

    // 失败的多语句事务：管理器状态必须与底层真实状态一致
    expect(() =>
      d.exec("BEGIN IMMEDIATE; INSERT INTO t VALUES (10); INSERT INTO no_such_table VALUES (1)"),
    ).toThrow();
    expect((d as any).inTransaction).toBe(true);
    expect((d.getRawDatabase() as any).isTransaction).toBe(true);
    d.exec("ROLLBACK");
    expect((d as any).inTransaction).toBe(false);

    // END 结束事务；SAVEPOINT/RELEASE 也必须被真实状态覆盖
    d.exec("BEGIN IMMEDIATE; INSERT INTO t VALUES (11); END;");
    expect((d as any).inTransaction).toBe(false);
    d.exec("SAVEPOINT s1");
    expect((d as any).inTransaction).toBe(true);
    d.exec("RELEASE s1");
    expect((d as any).inTransaction).toBe(false);
    d.close();
    for (const f of [p, `${p}-wal`, `${p}-shm`]) rmSync(f, { force: true });
  });

  it("does not replay a statement inside an explicit transaction on disk I/O error", () => {
    const p = `/tmp/test-db-txn-recover-${Date.now()}.sqlite`;
    const d = new DatabaseManager(p);
    d.run("CREATE TABLE t(x INTEGER)");
    d.exec("BEGIN IMMEDIATE");
    d.run("INSERT INTO t VALUES (1)");
    linkSync(p, `${p}.link`);
    // 先把底层连接推入 disk I/O error 状态（绕过 manager 的恢复逻辑）
    expect(() => (d.getRawDatabase() as any).exec("COMMIT")).toThrow();
    // 事务内 IO 错误：重开连接，不在新连接上重放失败语句
    expect(() => d.run("INSERT INTO t VALUES (2)")).toThrow();
    // 关键断言：失败的第二条写入没有被透明重放到新连接
    expect(d.query<{ x: number }>("SELECT x FROM t").map((r) => r.x)).not.toContain(2);
    d.close();
    for (const f of [p, `${p}-wal`, `${p}-shm`, `${p}.link`]) rmSync(f, { force: true });
  });
});
