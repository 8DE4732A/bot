import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { DatabaseManager } from "../src/database/index.ts";
import { DatabaseStore } from "../src/config/database-store.ts";
import { EventBus } from "../src/core/event-bus.ts";
import type { SchedulerCompletedEvent } from "../src/core/events.ts";
import { ChannelManager } from "../src/channels/manager.ts";
import type { ChannelAdapter } from "../src/channels/base.ts";
import { NotificationDispatcher } from "../src/notifications/dispatcher.ts";
import { SchedulerManager } from "../src/scheduler/index.ts";

// 测试隔离纪律: 临时目录 + 显式 DatabaseManager 单例 (单例被全部套件共享, 勿删除)
const tmp = join(tmpdir(), `bot-notify-test-${Date.now()}`);
DatabaseManager.getInstance(join(tmp, "bot.sqlite"));
const store = new DatabaseStore();

/** 记录调用的最小渠道适配器 */
function makeFakeAdapter(id: string, type: ChannelAdapter["type"], sent: { peerId: string; content: string }[]): ChannelAdapter {
  return {
    id,
    type,
    name: `fake-${id}`,
    async start() {},
    async stop() {},
    async sendMessage(peerId, content) {
      sent.push({ peerId, content });
    },
  };
}

const waitFor = async (cond: () => boolean, ms = 1000): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return cond();
};

describe("event-bus: 发布/订阅", () => {
  test("订阅者收到事件; 退订后不再收到; 单个订阅者抛错不影响他人", async () => {
    const bus = EventBus.getInstance();
    const got: string[] = [];
    const failing = () => {
      throw new Error("boom");
    };
    const off1 = bus.subscribe((e) => got.push(e.type));
    bus.subscribe(failing);

    bus.publish({ type: "scheduler.completed", taskId: "t", taskName: "n", agentId: "a", status: "ok", runNumber: 1, result: "" });
    await waitFor(() => got.length === 1);
    expect(got).toEqual(["scheduler.completed"]);

    off1();
    bus.publish({ type: "scheduler.completed", taskId: "t", taskName: "n", agentId: "a", status: "ok", runNumber: 2, result: "" });
    await new Promise((r) => setTimeout(r, 50));
    expect(got.length).toBe(1); // 退订后不再递增
  });
});

describe("notifications: 事件 → 渠道分发", () => {
  NotificationDispatcher.getInstance().init();
  SchedulerManager.getInstance(); // 确保单例存在 (不 start, 避免轮询干扰断言)

  const recorded: { peerId: string; content: string }[] = [];
  const recordedTerminal: { peerId: string; content: string }[] = [];
  const fakeIm = makeFakeAdapter("im-test", "qq", recorded);
  const fakeTerminal = makeFakeAdapter("terminal-main", "terminal", recordedTerminal);
  ChannelManager.getInstance().register(fakeIm);
  ChannelManager.getInstance().register(fakeTerminal);

  test("任务记录的通知目标优先: 推送到创建会话所在渠道+peer", async () => {
    // 渠道配置 + 任务 (notify 目标指向 im-test)
    store.saveChannel({
      id: "im-test",
      type: "qq",
      name: "IM 测试",
      enabled: true,
      boundAgentId: "agent-default",
      credentials: {},
      updatedAt: Date.now(),
    });
    const now = Date.now();
    store.saveScheduledTask({
      id: "task-notify-hit",
      agentId: "agent-default",
      name: "通知命中",
      prompt: "p",
      scheduleType: "every",
      intervalSeconds: 120,
      enabled: true,
      notifyChannelInstanceId: "im-test",
      notifyPeerId: "user-42",
      notifyEnabled: true,
      runCount: 0,
      createdAt: now,
      updatedAt: now,
    });

    const event: SchedulerCompletedEvent = {
      type: "scheduler.completed",
      taskId: "task-notify-hit",
      taskName: "通知命中",
      agentId: "agent-default",
      status: "ok",
      runNumber: 1,
      result: "运行结果 ABC",
    };
    EventBus.getInstance().publish(event);
    const hit = await waitFor(() => recorded.length > 0);
    expect(hit).toBe(true);
    expect(recorded[0].peerId).toBe("user-42");
    expect(recorded[0].content).toContain("通知命中");
    expect(recorded[0].content).toContain("运行结果 ABC");
  });

  test("通知目标不可用时 fallback 到 Agent 绑定的终端渠道", async () => {
    const now = Date.now();
    store.saveScheduledTask({
      id: "task-notify-fallback",
      agentId: "agent-default",
      name: "fallback 任务",
      prompt: "p",
      scheduleType: "every",
      intervalSeconds: 120,
      enabled: true,
      // 指向不存在的渠道
      notifyChannelInstanceId: "gone-channel",
      notifyPeerId: "someone",
      notifyEnabled: true,
      runCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    EventBus.getInstance().publish({
      type: "scheduler.completed",
      taskId: "task-notify-fallback",
      taskName: "fallback 任务",
      agentId: "agent-default",
      status: "ok",
      runNumber: 1,
      result: "fallback 结果",
    });
    // fallback = 该 Agent 绑定的启用渠道 (updatedAt 最新优先 → im-test)
    const before = recorded.length;
    const hit = await waitFor(() => recorded.length > before);
    expect(hit).toBe(true);
    expect(recorded.at(-1)?.content).toContain("fallback 任务");
  });

  test("notify_enabled=false 的任务不推送", async () => {
    const before = recorded.length;
    const now = Date.now();
    store.saveScheduledTask({
      id: "task-notify-off",
      agentId: "agent-default",
      name: "静默任务",
      prompt: "p",
      scheduleType: "every",
      intervalSeconds: 120,
      enabled: true,
      notifyChannelInstanceId: "im-test",
      notifyPeerId: "user-42",
      notifyEnabled: false,
      runCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    EventBus.getInstance().publish({
      type: "scheduler.completed",
      taskId: "task-notify-off",
      taskName: "静默任务",
      agentId: "agent-default",
      status: "ok",
      runNumber: 1,
      result: "不应出现",
    });
    await new Promise((r) => setTimeout(r, 120));
    expect(recorded.length).toBe(before);
    expect(recorded.at(-1)?.content ?? "").not.toContain("不应出现");
  });

  test("getSessionByConversation: 渠道映射往返 (通知寻址依据)", () => {
    store.saveSession({
      channelInstanceId: "im-test",
      peerId: "user-77",
      agentId: "agent-default",
      conversationId: "990001",
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    });
    const session = store.getSessionByConversation("990001");
    expect(session?.channelInstanceId).toBe("im-test");
    expect(session?.peerId).toBe("user-77");
    expect(store.getSessionByConversation("999999")).toBeUndefined();
  });
});
