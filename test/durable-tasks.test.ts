import { describe, expect, test } from "bun:test";
import {
  countsTowardGlobalDurableBusy,
  describeDurableState,
  isDurableTaskPending,
  isRestartLimitedRecord,
  markRestartLimitedBusinessTask,
  parseConfiguredMaxTurns,
  restartLimitReportTaskId,
} from "../src/core/agent-manager.ts";
import type { TaskInspection } from "@earendil-works/pi-durable";

const task = (
  state: TaskInspection["state"],
  record: { kind?: string; conversationId?: string; background?: boolean } = {},
): TaskInspection =>
  ({
    record: {
      kind: record.kind ?? "pi.generation",
      conversationId: record.conversationId ?? "1",
      background: record.background,
    },
    state,
  }) as unknown as TaskInspection;

describe("1.5.0 durable 任务状态", () => {
  test("sleeping/blocked 不阻塞队列与 drain", () => {
    expect(isDurableTaskPending(task({ kind: "sleeping", until: Date.now() + 60_000 }))).toBe(false);
    expect(isDurableTaskPending(task({ kind: "blocked", reason: "missing_task" }))).toBe(false);
  });

  test("running/pending/waiting/completing 仍计入 busy", () => {
    expect(isDurableTaskPending(task({ kind: "running" }))).toBe(true);
    expect(isDurableTaskPending(task({ kind: "pending", migrates: false }))).toBe(true);
    expect(isDurableTaskPending(task({ kind: "waiting", on: [] }))).toBe(true);
    expect(isDurableTaskPending(task({ kind: "completing" }))).toBe(true);
  });

  test("六期：调度任务与调度 conversation 不阻塞全局队列/drain", () => {
    const schedulerConversations = new Set(["42"]);
    // 调度 durable task 本身（即使 running）
    expect(
      countsTowardGlobalDurableBusy(
        task({ kind: "running" }, { kind: "bot.scheduled-prompt", conversationId: "2", background: true }),
        schedulerConversations,
      ),
    ).toBe(false);
    // 调度 conversation 下的 generation/tool
    expect(
      countsTowardGlobalDurableBusy(
        task({ kind: "running" }, { kind: "pi.generation", conversationId: "42" }),
        schedulerConversations,
      ),
    ).toBe(false);
    // 普通会话照常计入
    expect(
      countsTowardGlobalDurableBusy(
        task({ kind: "running" }, { kind: "pi.generation", conversationId: "7" }),
        schedulerConversations,
      ),
    ).toBe(true);
  });

  test("管理台状态摘要不直接透出框架内部字段", () => {
    expect(describeDurableState({ kind: "sleeping", until: 123 })).toEqual({ kind: "sleeping", until: 123 });
    expect(describeDurableState({ kind: "blocked", reason: "task_too_old" })).toEqual({
      kind: "blocked",
      reason: "task_too_old",
    });
    expect(describeDurableState({ kind: "waiting", on: ["a", "b"] })).toEqual({
      kind: "waiting",
      on: ["a", "b"],
    });
    expect(describeDurableState({ kind: "pending", migrates: true })).toEqual({
      kind: "pending",
      migrates: true,
    });
  });

  test("maxTurns 配置默认关闭，正整数才启用", () => {
    expect(parseConfiguredMaxTurns(undefined)).toBeUndefined();
    expect(parseConfiguredMaxTurns("0")).toBeUndefined();
    expect(parseConfiguredMaxTurns("-3")).toBeUndefined();
    expect(parseConfiguredMaxTurns("abc")).toBeUndefined();
    expect(parseConfiguredMaxTurns("12abc")).toBeUndefined();
    expect(parseConfiguredMaxTurns("1e3")).toBeUndefined();
    expect(parseConfiguredMaxTurns("64")).toBe(64);
    expect(parseConfiguredMaxTurns("99999")).toBe(1_000);
  });

  test("1.5.0: restart-limit report 能定位 bot.scheduled-prompt 业务任务", () => {
    const report = (patch: Record<string, unknown> = {}) =>
      ({
        kind: "task_faulted",
        reason: "restart_limit",
        task: { id: 42, kind: "bot.scheduled-prompt", conversationId: 1 },
        error: new Error("limit"),
        ...patch,
      }) as any;
    expect(restartLimitReportTaskId(report())).toBe("42");
    expect(restartLimitReportTaskId(report({ kind: "task_interrupted" }))).toBe("42");
    expect(restartLimitReportTaskId(report({ reason: "threw" }))).toBeUndefined();
    expect(restartLimitReportTaskId(report({ kind: "task_error" }))).toBeUndefined();
    expect(
      restartLimitReportTaskId(report({ task: { id: 42, kind: "pi.generation", conversationId: 1 } })),
    ).toBeUndefined();
  });

  test("1.5.0: restart-limit report 回写业务 blocked 并审计", () => {
    const calls: unknown[][] = [];
    const store = {
      getScheduledTaskByDurableTaskId: (id: string) =>
        id === "42" ? { id: "task-x", agentId: "agent-default" } : undefined,
      markScheduledTaskBlockedIfDurable: (...args: unknown[]) => {
        calls.push(["mark", ...args]);
        return true;
      },
      recordAudit: (...args: unknown[]) => calls.push(["audit", ...args]),
    };
    const report = {
      kind: "task_faulted",
      reason: "restart_limit",
      task: { id: 42, kind: "bot.scheduled-prompt", conversationId: 1 },
      error: new Error("limit"),
    } as any;
    expect(markRestartLimitedBusinessTask(store as any, report)).toBe("task-x");
    expect(calls).toEqual([
      ["mark", "task-x", "42"],
      ["audit", "scheduler.durable_blocked", { taskId: "task-x", durableTaskId: "42", reason: "restart_limit" }],
    ]);
    expect(markRestartLimitedBusinessTask(store as any, { ...report, reason: "threw" })).toBeUndefined();
  });

  test("1.5.0: restart-limited 终态任务可被识别（不再 park）", () => {
    const terminal = (outcome: unknown) => ({ state: { status: "terminal", outcome } });
    expect(
      isRestartLimitedRecord(terminal({ status: "faulted", error: { message: "x", detail: { reason: "restart_limit" } } })),
    ).toBe(true);
    expect(
      isRestartLimitedRecord(terminal({ status: "failed", error: { message: "x", detail: { reason: "restart_limit" } } })),
    ).toBe(true);
    expect(
      isRestartLimitedRecord(terminal({ status: "completed", result: { reason: "restart_limit" } })),
    ).toBe(false);
    expect(isRestartLimitedRecord(terminal({ status: "faulted", error: { message: "x" } }))).toBe(false);
    expect(isRestartLimitedRecord({ state: { status: "running" } })).toBe(false);
    expect(isRestartLimitedRecord(undefined)).toBe(false);
  });
});
