import { describe, expect, test } from "bun:test";
import {
  countsTowardGlobalDurableBusy,
  describeDurableState,
  isDurableTaskPending,
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

describe("1.4.0 durable 任务状态", () => {
  test("sleeping/blocked 不阻塞队列与 drain", () => {
    expect(isDurableTaskPending(task({ kind: "sleeping", until: Date.now() + 60_000 }))).toBe(false);
    expect(isDurableTaskPending(task({ kind: "blocked", reason: "restart_limit" }))).toBe(false);
  });

  test("running/ready/waiting/completing 仍计入 busy", () => {
    expect(isDurableTaskPending(task({ kind: "running" }))).toBe(true);
    expect(isDurableTaskPending(task({ kind: "ready", migrates: false }))).toBe(true);
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
    expect(describeDurableState({ kind: "blocked", reason: "restart_limit" })).toEqual({
      kind: "blocked",
      reason: "restart_limit",
    });
    expect(describeDurableState({ kind: "waiting", on: ["a", "b"] })).toEqual({
      kind: "waiting",
      on: ["a", "b"],
    });
    expect(describeDurableState({ kind: "ready", migrates: true })).toEqual({ kind: "ready", migrates: true });
  });
});
