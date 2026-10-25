import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import type { ConversationId, TaskId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { DatabaseManager } from "../src/database/index.ts";
import { DatabaseStore, type ScheduledTaskDefinition } from "../src/config/database-store.ts";
import { ModelFactory } from "../src/core/model-factory.ts";
import { SchedulerSystemExtension } from "../src/scheduler/system-extension.ts";
import {
  SCHEDULED_PROMPT_TASK,
  ScheduledPromptTask,
  setSchedulerRunner,
} from "../src/scheduler/durable-task.ts";

/**
 * 六期：durable scheduler 的 run ledger / lease / outbox 与 task phase 集成。
 * 纪律同其他套件：共享 DatabaseManager 单例，不自建第二个库；harness 用独立临时目录。
 */

const tmp = join(tmpdir(), `bot-phase6-scheduler-${Date.now()}`);
const db = DatabaseManager.getInstance(join(tmp, "bot.sqlite"));
const store = new DatabaseStore();

function makeTask(overrides: Partial<ScheduledTaskDefinition> = {}): ScheduledTaskDefinition {
  const now = Date.now();
  return {
    id: `task-p6-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    agentId: "agent-default",
    name: "六期测试任务",
    prompt: "do durable things",
    scheduleType: "every",
    intervalSeconds: 300,
    enabled: true,
    nextRunAt: now + 300_000,
    runCount: 0,
    notifyEnabled: true,
    durableState: "pending",
    scheduleVersion: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("phase6: migration v6", () => {
  test("scheduled_tasks 新列 + run ledger/outbox 表存在", () => {
    const cols = db.query<any>("PRAGMA table_info(scheduled_tasks)").map((c) => c.name);
    for (const name of [
      "durable_task_id",
      "durable_state",
      "schedule_version",
      "conversation_id",
      "conversation_poisoned",
      "poison_run_key",
      "poison_fence",
    ]) {
      expect(cols).toContain(name);
    }
    const tables = db
      .query<any>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .map((r) => r.name);
    expect(tables).toContain("scheduled_task_runs");
    expect(tables).toContain("scheduled_task_notifications");
  });
});

describe("phase6: run ledger / lease / outbox", () => {
  test("reserve 幂等：同一 (taskId, runKey) 只生成一条 ledger、runCount 只加一次", () => {
    const now = Date.now();
    const task = makeTask({ scheduleType: "every", nextRunAt: now, scheduleVersion: 0 });
    store.saveScheduledTask(task);
    const runKey = `schedule:${task.id}:0:${now}`;
    const input = {
      taskId: task.id,
      runKey,
      scheduledFor: now,
      scheduleVersion: 0,
      now,
      leaseOwner: "owner-a",
      leaseMs: 60_000,
      advanceSchedule: true,
      nextRunAt: now + 300_000,
    };
    const first = store.reserveScheduledRun(input);
    expect(first.kind).toBe("reserved");
    // 同一 owner 重放默认视为仍在执行：不得递增 fence / 二次执行
    const second = store.reserveScheduledRun(input);
    expect(second.kind).toBe("existing");
    if (second.kind === "existing") {
      expect(second.active).toBe(true);
      expect(second.run.leaseFence).toBe(1);
      expect(second.run.attemptCount).toBe(1);
    }
    // 显式崩溃恢复（同 owner）也必须等持久 lease 过期；未过期时即使传
    // allowSelfTakeover 也不能接管
    const notExpired = store.reserveScheduledRun({ ...input, allowSelfTakeover: true });
    expect(notExpired.kind).toBe("existing");
    if (notExpired.kind === "existing") {
      expect(notExpired.active).toBe(true);
      expect(notExpired.run.leaseFence).toBe(1);
    }
    db.run(
      "UPDATE scheduled_task_runs SET lease_until = ? WHERE task_id = ? AND run_key = ?",
      now - 1,
      task.id,
      runKey,
    );
    const resumed = store.reserveScheduledRun({ ...input, allowSelfTakeover: true });
    expect(resumed.kind).toBe("existing");
    if (resumed.kind === "existing") {
      expect(resumed.active).toBe(false);
      expect(resumed.run.leaseFence).toBe(2);
    }
    expect(store.listScheduledRuns(task.id).length).toBe(1);
    expect(store.getScheduledTaskRaw(task.id)?.runCount).toBe(1);
    if (first.kind === "reserved") {
      expect(first.run.requestId).toBe(`sched:${task.id}:${runKey}`);
      expect(first.run.leaseFence).toBe(1);
    }
  });

  test("reserve 代际：scheduleVersion 不匹配返回 superseded，不写 ledger", () => {
    const now = Date.now();
    const task = makeTask({ nextRunAt: now, scheduleVersion: 3 });
    store.saveScheduledTask(task);
    const result = store.reserveScheduledRun({
      taskId: task.id,
      runKey: `schedule:${task.id}:2:${now}`,
      scheduledFor: now,
      scheduleVersion: 2,
      now,
      leaseOwner: "owner-a",
      leaseMs: 60_000,
      advanceSchedule: true,
      nextRunAt: now + 300_000,
    });
    expect(result.kind).toBe("superseded");
    expect(store.listScheduledRuns(task.id).length).toBe(0);
  });

  test("删除后收尾：ledger aborted，业务行不复活、不写 outbox", () => {
    const now = Date.now();
    const task = makeTask({ nextRunAt: now });
    store.saveScheduledTask(task);
    const reserved = store.reserveScheduledRun({
      taskId: task.id,
      runKey: `schedule:${task.id}:0:${now}`,
      scheduledFor: now,
      scheduleVersion: 0,
      now,
      leaseOwner: "owner-a",
      leaseMs: 60_000,
      advanceSchedule: true,
      nextRunAt: now + 300_000,
    });
    expect(reserved.kind).toBe("reserved");
    if (reserved.kind !== "reserved") return;
    store.markScheduledTaskDeleted(task.id);
    const finished = store.finishScheduledRun({
      runId: reserved.run.id,
      owner: "owner-a",
      fence: reserved.run.leaseFence,
      status: "aborted",
      error: "deleted",
      now: now + 1,
    });
    expect(finished.ok).toBe(true);
    expect(finished.taskChanged).toBe(false);
    expect(store.getScheduledRun(reserved.run.id)?.status).toBe("aborted");
    expect(store.getScheduledTaskRaw(task.id)?.deletedAt).toBeDefined();
    expect(store.getScheduledNotification(reserved.run.id)).toBeUndefined();
  });

  test("orphan 收尾：forceAbort 同步业务 last_* 与 outbox", () => {
    const now = Date.now();
    const task = makeTask({ nextRunAt: now });
    store.saveScheduledTask(task);
    const reserved = store.reserveScheduledRun({
      taskId: task.id,
      runKey: `schedule:${task.id}:0:${now}`,
      scheduledFor: now,
      scheduleVersion: 0,
      now,
      leaseOwner: "dead-owner",
      leaseMs: 60_000,
      advanceSchedule: true,
      nextRunAt: now + 300_000,
    });
    expect(reserved.kind).toBe("reserved");
    if (reserved.kind !== "reserved") return;
    expect(store.forceAbortScheduledRun(reserved.run.id, "orphaned", now + 1)).toBe(true);
    expect(store.getScheduledRun(reserved.run.id)?.status).toBe("aborted");
    expect(store.getScheduledTaskRaw(task.id)?.lastStatus).toBe("aborted");
    const note = store.getScheduledNotification(reserved.run.id);
    expect(note?.status).toBe("pending");
    expect(JSON.parse(note!.payload).status).toBe("aborted");
  });

  test("orphan 收尾尊重用户禁用：只写 ledger，不覆盖 last_* / 不发通知", () => {
    const now = Date.now();
    const task = makeTask({ nextRunAt: now });
    store.saveScheduledTask(task);
    const reserved = store.reserveScheduledRun({
      taskId: task.id,
      runKey: `schedule:${task.id}:0:${now}`,
      scheduledFor: now,
      scheduleVersion: 0,
      now,
      leaseOwner: "dead-owner",
      leaseMs: 60_000,
      advanceSchedule: true,
      nextRunAt: now + 300_000,
    });
    expect(reserved.kind).toBe("reserved");
    if (reserved.kind !== "reserved") return;
    store.saveScheduledTaskConfig({ ...task, enabled: false, nextRunAt: undefined });
    expect(store.forceAbortScheduledRun(reserved.run.id, "orphaned", now + 1)).toBe(true);
    expect(store.getScheduledRun(reserved.run.id)?.status).toBe("aborted");
    expect(store.getScheduledTaskRaw(task.id)?.lastStatus).toBeUndefined();
    expect(store.getScheduledNotification(reserved.run.id)).toBeUndefined();
  });

  test("same task busy：另一 runKey 返回 busy", () => {
    const now = Date.now();
    const task = makeTask({ nextRunAt: now });
    store.saveScheduledTask(task);
    const first = store.reserveScheduledRun({
      taskId: task.id,
      runKey: `schedule:${task.id}:0:${now}`,
      scheduledFor: now,
      scheduleVersion: 0,
      now,
      leaseOwner: "owner-a",
      leaseMs: 60_000,
      advanceSchedule: true,
      nextRunAt: now + 300_000,
    });
    expect(first.kind).toBe("reserved");
    const manual = store.reserveScheduledRun({
      taskId: task.id,
      runKey: `manual:${now}`,
      scheduledFor: now,
      scheduleVersion: 0,
      now,
      leaseOwner: "owner-b",
      leaseMs: 60_000,
      advanceSchedule: false,
    });
    expect(manual.kind).toBe("busy");
    if (manual.kind === "busy") expect(manual.run.taskId).toBe(task.id);
  });

  test("lease：活跃 owner 不能被抢；过期/fence 可接管且 fence 递增", () => {
    const now = Date.now();
    const task = makeTask({ nextRunAt: now });
    store.saveScheduledTask(task);
    const runKey = `schedule:${task.id}:0:${now}`;
    const a = store.reserveScheduledRun({
      taskId: task.id,
      runKey,
      scheduledFor: now,
      scheduleVersion: 0,
      now,
      leaseOwner: "owner-a",
      leaseMs: 60_000,
      advanceSchedule: true,
      nextRunAt: now + 300_000,
    });
    expect(a.kind).toBe("reserved");

    const held = store.reserveScheduledRun({
      taskId: task.id,
      runKey,
      scheduledFor: now,
      scheduleVersion: 0,
      now: now + 1_000,
      leaseOwner: "owner-b",
      leaseMs: 60_000,
      advanceSchedule: true,
      nextRunAt: now + 300_000,
    });
    expect(held.kind).toBe("existing");
    if (held.kind === "existing") {
      expect(held.active).toBe(true);
      expect(held.run.leaseOwner).toBe("owner-a");
    }

    // 模拟 lease 过期
    db.run(
      "UPDATE scheduled_task_runs SET lease_until = ? WHERE task_id = ? AND run_key = ?",
      now - 1,
      task.id,
      runKey,
    );
    const taken = store.reserveScheduledRun({
      taskId: task.id,
      runKey,
      scheduledFor: now,
      scheduleVersion: 0,
      now: now + 2_000,
      leaseOwner: "owner-b",
      leaseMs: 60_000,
      advanceSchedule: true,
      nextRunAt: now + 300_000,
    });
    expect(taken.kind).toBe("existing");
    if (taken.kind === "existing") {
      expect(taken.active).toBe(false); // 接管成功 → 本调用应继续执行
      expect(taken.run.leaseOwner).toBe("owner-b");
      expect(taken.run.leaseFence).toBe(2);
      expect(taken.run.attemptCount).toBe(2);
    }
  });

  test("finish：旧 fence 不能写终态；新 owner 写 ledger + last_* + outbox", () => {
    const now = Date.now();
    const task = makeTask({
      nextRunAt: now,
      notifyChannelInstanceId: "terminal-main",
      notifyPeerId: "local-user",
    });
    store.saveScheduledTask(task);
    const runKey = `schedule:${task.id}:0:${now}`;
    const reserved = store.reserveScheduledRun({
      taskId: task.id,
      runKey,
      scheduledFor: now,
      scheduleVersion: 0,
      now,
      leaseOwner: "owner-a",
      leaseMs: 60_000,
      advanceSchedule: true,
      nextRunAt: now + 300_000,
    });
    expect(reserved.kind).toBe("reserved");
    if (reserved.kind !== "reserved") return;

    const stale = store.finishScheduledRun({
      runId: reserved.run.id,
      owner: "owner-a",
      fence: 999,
      status: "ok",
      result: "stale",
      now: now + 1,
    });
    expect(stale.ok).toBe(false);
    expect(stale.reason).toBe("fence_lost");

    const ok = store.finishScheduledRun({
      runId: reserved.run.id,
      owner: "owner-a",
      fence: reserved.run.leaseFence,
      status: "ok",
      result: "done answer",
      now: now + 2,
    });
    expect(ok.ok).toBe(true);
    expect(store.getScheduledRun(reserved.run.id)?.status).toBe("ok");
    expect(store.getScheduledTaskRaw(task.id)?.lastStatus).toBe("ok");
    expect(store.getScheduledTaskRaw(task.id)?.lastResult).toBe("done answer");
    const note = store.getScheduledNotification(reserved.run.id);
    expect(note?.status).toBe("pending");
    expect(JSON.parse(note!.payload).source).toBe("schedule");
    expect(JSON.parse(note!.payload).target).toEqual({
      channelInstanceId: "terminal-main",
      peerId: "local-user",
    });
  });

  test("once 成功：finish 才置 enabled=0 / next_run_at=NULL / durable done", () => {
    const now = Date.now();
    const task = makeTask({ scheduleType: "once", runAt: now - 1, nextRunAt: now - 1 });
    store.saveScheduledTask(task);
    const runKey = `schedule:${task.id}:0:${now - 1}`;
    const reserved = store.reserveScheduledRun({
      taskId: task.id,
      runKey,
      scheduledFor: now - 1,
      scheduleVersion: 0,
      now,
      leaseOwner: "owner-a",
      leaseMs: 60_000,
      advanceSchedule: true,
    });
    expect(reserved.kind).toBe("reserved");
    // reserve 后 next_run_at 已置空，但 enabled 仍为 true（等到 finish）
    expect(store.getScheduledTaskRaw(task.id)?.enabled).toBe(true);
    expect(store.getScheduledTaskRaw(task.id)?.nextRunAt).toBeUndefined();
    if (reserved.kind !== "reserved") return;
    const done = store.finishScheduledRun({
      runId: reserved.run.id,
      owner: "owner-a",
      fence: reserved.run.leaseFence,
      status: "done",
      result: "once answer",
      now: now + 1,
    });
    expect(done.ok).toBe(true);
    const fresh = store.getScheduledTaskRaw(task.id)!;
    expect(fresh.enabled).toBe(false);
    expect(fresh.nextRunAt).toBeUndefined();
    expect(fresh.lastStatus).toBe("done");
    expect(fresh.durableState).toBe("done");
  });

  test("poison：旧 fence 不能 poison 新 owner；canonical 只写一次", () => {
    const now = Date.now();
    const task = makeTask({ nextRunAt: now });
    store.saveScheduledTask(task);
    const runKey = `schedule:${task.id}:0:${now}`;
    const reserved = store.reserveScheduledRun({
      taskId: task.id,
      runKey,
      scheduledFor: now,
      scheduleVersion: 0,
      now,
      leaseOwner: "owner-a",
      leaseMs: 60_000,
      advanceSchedule: true,
      nextRunAt: now + 300_000,
    });
    expect(reserved.kind).toBe("reserved");
    // 错误 fence
    expect(store.markConversationPoisoned(task.id, runKey, 999, 0, "owner-a")).toBe(false);
    expect(store.getScheduledTaskRaw(task.id)?.conversationPoisoned).toBe(false);
    // 当前 fence 成功
    expect(store.markConversationPoisoned(task.id, runKey, 1, 0, "owner-a")).toBe(true);
    const poisoned = store.getScheduledTaskRaw(task.id)!;
    expect(poisoned.conversationPoisoned).toBe(true);
    expect(poisoned.durableState).toBe("poisoned");
    expect(poisoned.poisonRunKey).toBe(runKey);
    expect(poisoned.poisonFence).toBe(1);
    // 已 poison 不覆盖
    expect(store.markConversationPoisoned(task.id, runKey, 1, 0, "owner-a")).toBe(false);
  });

  test("retired conversation：reset 后旧 id 永久拒绝", () => {
    const id = `retired-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    expect(store.isRetiredSchedulerConversation(id)).toBe(false);
    store.retireSchedulerConversation(id);
    expect(store.isRetiredSchedulerConversation(id)).toBe(true);
    expect(store.isRetiredSchedulerConversation(`${id}-other`)).toBe(false);
  });

  test("outbox：notifyEnabled=false 不写 outbox", () => {
    const now = Date.now();
    const task = makeTask({ nextRunAt: now, notifyEnabled: false });
    store.saveScheduledTask(task);
    const reserved = store.reserveScheduledRun({
      taskId: task.id,
      runKey: `schedule:${task.id}:0:${now}`,
      scheduledFor: now,
      scheduleVersion: 0,
      now,
      leaseOwner: "owner-a",
      leaseMs: 60_000,
      advanceSchedule: true,
      nextRunAt: now + 300_000,
    });
    expect(reserved.kind).toBe("reserved");
    if (reserved.kind !== "reserved") return;
    store.finishScheduledRun({
      runId: reserved.run.id,
      owner: "owner-a",
      fence: reserved.run.leaseFence,
      status: "ok",
      result: "quiet",
      now: now + 1,
    });
    expect(store.getScheduledNotification(reserved.run.id)).toBeUndefined();
  });

  test("outbox：原子 claim 只成功一次；sending 过期可接管；失败退避", () => {
    const now = Date.now();
    const task = makeTask({ nextRunAt: now });
    store.saveScheduledTask(task);
    const reserved = store.reserveScheduledRun({
      taskId: task.id,
      runKey: `schedule:${task.id}:0:${now}`,
      scheduledFor: now,
      scheduleVersion: 0,
      now,
      leaseOwner: "owner-a",
      leaseMs: 60_000,
      advanceSchedule: true,
      nextRunAt: now + 300_000,
    });
    expect(reserved.kind).toBe("reserved");
    if (reserved.kind !== "reserved") return;
    store.finishScheduledRun({
      runId: reserved.run.id,
      owner: "owner-a",
      fence: reserved.run.leaseFence,
      status: "ok",
      result: "hello",
      now: now + 1,
    });

    const first = store
      .claimScheduledNotifications("notifier-a", now + 2, 50)
      .filter((c) => c.record.runId === reserved.run.id);
    expect(first.length).toBe(1);
    const second = store
      .claimScheduledNotifications("notifier-b", now + 3, 50)
      .filter((c) => c.record.runId === reserved.run.id);
    expect(second.length).toBe(0);

    expect(
      store.markNotificationFailed(reserved.run.id, first[0].token, now + 4, "boom", 1_000),
    ).toBe(true);
    const notDue = store
      .claimScheduledNotifications("notifier-b", now + 5, 50)
      .filter((c) => c.record.runId === reserved.run.id);
    expect(notDue.length).toBe(0);
    const due = store
      .claimScheduledNotifications("notifier-b", now + 10_000, 50)
      .filter((c) => c.record.runId === reserved.run.id);
    expect(due.length).toBe(1);
    expect(store.markNotificationDelivered(reserved.run.id, due[0].token, now + 10_001)).toBe(true);
    expect(store.getScheduledNotification(reserved.run.id)?.status).toBe("delivered");
  });
});

describe("phase6: ScheduledPromptTask phase（真实 Harness + fake runner）", () => {
  test("wait → checkpoint(run) 先落盘 → run → terminal done", async () => {
    const storage = await openNodeSqliteStorage(join(tmp, "conversations.sqlite"));
    const registry = createRegistry();
    registry.install(SchedulerSystemExtension);
    const harness = await Harness.open(
      storage,
      {
        models: () => ModelFactory.createConfiguredModels(),
        registry,
      },
      BACKGROUND_CONTEXT,
    );

    try {
      const now = Date.now();
      const business = makeTask({
        scheduleType: "once",
        runAt: now - 1,
        nextRunAt: now - 1,
        enabled: true,
      });
      store.saveScheduledTask(business);

      const owner = await harness.createConversation(
        { ownership: { kind: "ownerless" } },
        BACKGROUND_CONTEXT,
      );
      const durableId = await harness.commit(
        (tx) =>
          tx.createTask(
            ScheduledPromptTask,
            { scheduledTaskId: business.id },
            {
              ownership: { kind: "conversation" },
              conversationId: owner.id as ConversationId,
              background: true,
            },
          ),
        BACKGROUND_CONTEXT,
      );

      let observedCheckpoint: any;
      let observedRunKey = "";
      setSchedulerRunner({
        isReady: () => true,
        async runScheduledPrompt(input) {
          observedRunKey = input.runKey;
          const during = await harness.getTask(durableId, BACKGROUND_CONTEXT);
          observedCheckpoint = during?.state.status === "running" ? during.state.checkpoint : undefined;
          // 模拟 reserve/finish：once 完成 → next_run_at=NULL + enabled=0
          store.saveScheduledTaskConfig({
            ...business,
            enabled: false,
            nextRunAt: undefined,
            durableState: "done",
          });
          return { kind: "completed", runId: "run-fake", answer: "ok" };
        },
        async currentRunFence() {
          return 1;
        },
        async cancelChatForTask() {
          return { chatExited: true, idle: true, reason: "no_active_chat" };
        },
        async markConversationPoisoned() {},
        async releaseRunLease() {},
      });

      harness.resume();
      const settled = await harness.waitForTask(durableId as TaskId, BACKGROUND_CONTEXT);

      expect(observedCheckpoint?.phase).toBe("run");
      expect(observedCheckpoint?.runKey).toBe(`schedule:${business.id}:0:${now - 1}`);
      expect(observedRunKey).toBe(`schedule:${business.id}:0:${now - 1}`);
      expect(settled.state.status).toBe("terminal");
      if (settled.state.status === "terminal") {
        expect(settled.state.outcome.status).toBe("completed");
        if (settled.state.outcome.status === "completed") {
          expect(settled.state.outcome.result.reason).toBe("done");
        }
      }
      expect(settled.kind).toBe(SCHEDULED_PROMPT_TASK);
    } finally {
      setSchedulerRunner(undefined);
      await harness.close(BACKGROUND_CONTEXT);
      await storage.close(BACKGROUND_CONTEXT);
    }
  });
});

afterAll(() => {
  // 只清理本套件自己的临时目录（DatabaseManager 单例库在其他临时目录）
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});
