import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { DatabaseManager } from "../src/database/index.ts";
import { DatabaseStore, type ScheduledTaskDefinition } from "../src/config/database-store.ts";
import { SchedulerManager } from "../src/scheduler/index.ts";
import { MIN_INTERVAL_SECONDS, computeNextRunAt, validateCronExpr } from "../src/scheduler/schedule.ts";
import { SchedulerTools } from "../src/scheduler/tools.ts";
import { SkillRegistry } from "../src/skills/registry.ts";

// 测试隔离纪律: 临时目录 + 显式 DatabaseManager 单例 (单例被全部套件共享, 勿删除)
const tmp = join(tmpdir(), `bot-scheduler-test-${Date.now()}`);
DatabaseManager.getInstance(join(tmp, "bot.sqlite"));
const store = new DatabaseStore();

function makeTask(overrides: Partial<ScheduledTaskDefinition> = {}): ScheduledTaskDefinition {
  const now = Date.now();
  return {
    id: `task-${Math.random().toString(36).slice(2, 8)}`,
    agentId: "agent-default",
    name: "测试任务",
    prompt: "do the thing",
    scheduleType: "every",
    intervalSeconds: 300,
    enabled: true,
    runCount: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("scheduler: 下次触发时间计算", () => {
  test("once: 未来时刻有效, 过期/缺省为 undefined", () => {
    const now = Date.now();
    expect(computeNextRunAt(makeTask({ scheduleType: "once", runAt: now + 60_000 }), now)).toBe(now + 60_000);
    expect(computeNextRunAt(makeTask({ scheduleType: "once", runAt: now - 60_000 }), now)).toBeUndefined();
    expect(computeNextRunAt(makeTask({ scheduleType: "once" }), now)).toBeUndefined();
  });

  test("every: from + interval; 低于最小间隔无效", () => {
    const now = Date.now();
    expect(computeNextRunAt(makeTask({ intervalSeconds: 120 }), now)).toBe(now + 120_000);
    expect(computeNextRunAt(makeTask({ intervalSeconds: MIN_INTERVAL_SECONDS - 30 }), now)).toBeUndefined();
  });

  test("cron: 标准 5 字段表达式, 非法表达式无效", () => {
    const now = new Date(2026, 9, 5, 10, 0, 0).getTime(); // 2026-10-05 10:00 local
    const next = computeNextRunAt(makeTask({ scheduleType: "cron", cronExpr: "0 9 * * *" }), now);
    expect(next).toBeGreaterThan(now);
    // 下次 09:00 是明天 (今天 9 点已过)
    const d = new Date(next!);
    expect(d.getDate()).toBe(6);
    expect(d.getHours()).toBe(9);
    expect(computeNextRunAt(makeTask({ scheduleType: "cron" }), now)).toBeUndefined();
  });

  test("validateCronExpr: 合法 undefined, 非法给错误消息", () => {
    expect(validateCronExpr("*/5 * * * *")).toBeUndefined();
    expect(validateCronExpr("not a cron")).toBeDefined();
  });
});

describe("scheduler: 任务 CRUD 与逻辑删除", () => {
  test("save/get/list 往返; listDue 只取 enabled 且到期", () => {
    const now = Date.now();
    const t1 = makeTask({ nextRunAt: now - 1000 });
    const t2 = makeTask({ enabled: false, nextRunAt: now - 1000 });
    const t3 = makeTask({ nextRunAt: now + 60_000 });
    store.saveScheduledTask(t1);
    store.saveScheduledTask(t2);
    store.saveScheduledTask(t3);

    expect(store.getScheduledTask(t1.id)?.name).toBe("测试任务");
    expect(store.listScheduledTasks("agent-default").map((t) => t.id)).toContain(t1.id);
    const due = store.listDueScheduledTasks(now).map((t) => t.id);
    expect(due).toContain(t1.id);
    expect(due).not.toContain(t2.id); // disabled
    expect(due).not.toContain(t3.id); // 未到期
  });

  test("逻辑删除: 工具不可见 + 不触发; 记录仍在表中", () => {
    const t = makeTask({ nextRunAt: Date.now() - 1000 });
    store.saveScheduledTask(t);
    expect(store.softDeleteScheduledTask(t.id, t.agentId)).toBe(true);
    expect(store.getScheduledTask(t.id)).toBeUndefined();
    expect(store.listDueScheduledTasks(Date.now()).map((x) => x.id)).not.toContain(t.id);
    // 原始记录保留 (物理行未删)
    const raw = DatabaseManager.getInstance().queryOne<any>("SELECT * FROM scheduled_tasks WHERE id = ?", t.id);
    expect(raw).toBeDefined();
    expect(raw.deleted_at).not.toBeNull();
  });

  test("逻辑删除: 其他 agent 的任务被拒绝", () => {
    const t = makeTask({ agentId: "agent-owner" });
    store.saveScheduledTask(t);
    expect(() => store.softDeleteScheduledTask(t.id, "agent-other")).toThrow(/belongs to another agent/);
    expect(store.getScheduledTask(t.id)).toBeDefined(); // 未被删除
  });
});

describe("scheduler: 工具归属 (fail-closed)", () => {
  test("conversationId 无法归属时 schedule_list 拒绝执行", async () => {
    const listTool = SchedulerTools.tools!.find((t) => t.name === "schedule_list")!;
    try {
      await listTool.execute({}, { conversationId: "999999" } as any, undefined as any);
      throw new Error("should have thrown");
    } catch (err) {
      expect(String(err)).toContain("Unable to resolve the calling agent");
    }
  });

  test("resolveAgentId: 归属不明的会话创建任务被拒", async () => {
    const createTool = SchedulerTools.tools!.find((t) => t.name === "schedule_create")!;
    try {
      await createTool.execute(
        { name: "x", prompt: "y", scheduleType: "every", intervalSeconds: 120 },
        { conversationId: "888888" } as any,
        undefined as any,
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(String(err)).toContain("Unable to resolve the calling agent");
    }
  });

  test("归属解析: channel_sessions 映射的会话可反查 agent", async () => {
    store.saveSession({
      channelInstanceId: "channel_session",
      peerId: "agent-default:scheduler-mapping-test",
      agentId: "agent-default",
      conversationId: "777001",
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    });
    const listTool = SchedulerTools.tools!.find((t) => t.name === "schedule_list")!;
    const result: any = await listTool.execute({}, { conversationId: "777001" } as any, undefined as any);
    const payload = JSON.parse(result.content[0].text);
    expect(Array.isArray(payload.tasks)).toBe(true);
  });

  test("schedule_create: interval 低于下限返回错误 (不抛异常)", async () => {
    // 建立归属映射
    store.saveSession({
      channelInstanceId: "channel_session",
      peerId: "agent-default:scheduler-mapping-test",
      agentId: "agent-default",
      conversationId: "777001",
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    });
    const createTool = SchedulerTools.tools!.find((t) => t.name === "schedule_create")!;
    const result: any = await createTool.execute(
      { name: "too fast", prompt: "y", scheduleType: "every", intervalSeconds: 10 },
      { conversationId: "777001" } as any,
      undefined as any,
    );
    expect(JSON.parse(result.content[0].text).error).toContain("intervalSeconds");
  });
});

describe("scheduler: 注册与生命周期", () => {
  test("scheduler 技能注册且含 4 个工具", () => {
    const skill = SkillRegistry.getInstance().getSkill("scheduler");
    expect(skill?.kind).toBe("extension");
    expect(skill?.extension.tools?.map((t) => t.name)).toEqual([
      "schedule_create",
      "schedule_list",
      "schedule_update",
      "schedule_delete",
    ]);
  });

  test("SchedulerManager start/stop 幂等", () => {
    const mgr = SchedulerManager.getInstance();
    mgr.start();
    mgr.start(); // 重复 start 不叠加定时器
    mgr.stop();
    mgr.stop();
  });
});
