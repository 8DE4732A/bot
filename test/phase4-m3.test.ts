import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync } from "node:fs";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  type AssistantMessage,
  type UserMessage,
} from "@earendil-works/pi-ai";
import {
  createRegistry,
  Harness,
  MemoryStorage,
} from "@earendil-works/pi-durable";

import { readConversationHistory, searchConversations } from "../src/server/session-history.ts";
import { DatabaseManager } from "../src/database/index.ts";
import { DatabaseStore } from "../src/config/database-store.ts";
import { logger } from "../src/utils/logger.ts";
import { AdminWebServer } from "../src/server/server.ts";

const tmpDbDir = join(tmpdir(), `bot-phase4-m3-${Date.now()}`);
mkdirSync(tmpDbDir, { recursive: true });
DatabaseManager.getInstance(join(tmpDbDir, "bot.sqlite"));
logger.init(tmpDbDir);

describe("phase4: 审计过滤 + 分页", () => {
  test("事件前缀 / agent / 分页语义", () => {
    const store = new DatabaseStore();
    store.recordAudit("test.alpha", { n: 1 }, "agent-x");
    store.recordAudit("test.beta", { n: 2 }, "agent-x");
    store.recordAudit("other.gamma", { n: 3 }, "agent-y");

    const byEvent = store.listAuditLogsFiltered({ event: "test.", limit: 100 });
    expect(byEvent.total).toBe(2);
    expect(byEvent.items.every((l) => l.eventType.startsWith("test."))).toBe(true);

    const byAgent = store.listAuditLogsFiltered({ agentId: "agent-y", limit: 100 });
    expect(byAgent.total).toBe(1);
    expect(byAgent.items[0]!.eventType).toBe("other.gamma");

    // 分页
    const page1 = store.listAuditLogsFiltered({ event: "test.", limit: 1, offset: 0 });
    const page2 = store.listAuditLogsFiltered({ event: "test.", limit: 1, offset: 1 });
    expect(page1.items[0]!.id).not.toBe(page2.items[0]!.id);
  });
});

describe("phase4: 会话历史只读读取", () => {
  test("Harness 不存在时返回空历史 (不抛错)", async () => {
    const hist = await readConversationHistory(99999);
    expect(hist.messages).toEqual([]);
    expect(hist.truncated).toBe(false);
    expect(await searchConversations("不存在的内容xyz")).toEqual([]);
  });

  test("经 Conversation API 读取当前活动 transcript 并搜索", async () => {
    const storage = new MemoryStorage();
    const harness = await Harness.open(
      storage,
      { models: createModels(), registry: createRegistry() },
      BACKGROUND_CONTEXT,
    );
    try {
      const root = await harness.root(BACKGROUND_CONTEXT);
      const user: UserMessage = {
        role: "user",
        content: "alpha question",
        timestamp: Date.now(),
      };
      const assistant: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "beta answer" }],
        api: "openai-completions",
        provider: "test",
        model: "test-model",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      };
      await root.commit(
        (tx) => tx.appendEntry(root.id, { kind: "message", model: [user] }),
        BACKGROUND_CONTEXT,
      );
      await root.commit(
        (tx) => tx.appendEntry(root.id, { kind: "message", model: [assistant] }),
        BACKGROUND_CONTEXT,
      );
      await root.reset("fresh context", BACKGROUND_CONTEXT);

      const history = await readConversationHistory(Number(root.id), harness);
      expect(history.messages.map((m) => m.text)).toEqual(["fresh context"]);
      expect(history.messages.some((m) => m.text === "alpha question")).toBe(false);

      const hits = await searchConversations("fresh", harness, [Number(root.id)]);
      expect(hits).toEqual([
        { conversationId: Number(root.id), snippet: "fresh context" },
      ]);
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
    }
  });
});

describe("phase4: 手动创建定时任务 API", () => {
  const port = 3288;
  const server = new AdminWebServer(port, "127.0.0.1");

  test("POST 校验 (interval 最小值 / cron 非法 / once 过去时间)", async () => {
    await server.start();
    const base = {
      agentId: "agent-default",
      name: "api-创建任务",
      prompt: "报时",
    };
    const post = async (body: unknown) =>
      fetch(`http://127.0.0.1:${port}/api/scheduled-tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    const badInterval = await post({ ...base, scheduleType: "every", intervalSeconds: 10 });
    expect(badInterval.status).toBe(400);

    const badCron = await post({ ...base, scheduleType: "cron", cronExpr: "not a cron" });
    expect(badCron.status).toBe(400);

    const pastOnce = await post({ ...base, scheduleType: "once", runAt: Date.now() - 600_000 });
    expect(pastOnce.status).toBe(400);

    const ok = await post({ ...base, scheduleType: "every", intervalSeconds: 3600, enabled: true });
    expect(ok.status).toBe(200);
    const saved = (await ok.json()) as { id: string; nextRunAt?: number };
    expect(saved.nextRunAt).toBeGreaterThan(Date.now());

    const store = new DatabaseStore();
    const tasks = store.listScheduledTasks();
    expect(tasks.find((t) => t.id === saved.id)).toBeDefined();

    // 清理 (逻辑删除)
    store.softDeleteScheduledTask(saved.id);
    await server.stop();
  });
});
