import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseManager } from "../src/database/index.ts";
import { DatabaseStore } from "../src/config/database-store.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai/utils/transcript";
import { AgentManager } from "../src/core/agent-manager.ts";
import { DEFAULT_CONTEXT_POLICY } from "../src/core/context-policy.ts";
import {
  MAX_OUTBOUND_MEDIA,
  MAX_TOTAL_OUTBOUND_MEDIA_BYTES,
  MEDIA_MAX_BYTES,
} from "../src/channels/runtime/media-outbound.ts";
import { logger } from "../src/utils/logger.ts";

const root = mkdtempSync(join(tmpdir(), "bot-context-agent-chat-"));
DatabaseManager.getInstance(join(root, ".bot", "bot.sqlite"));
logger.init(root);

let mock: ReturnType<typeof Bun.serve> | undefined;
let mockDelayMs = 0;

function sseChunk(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function startMock() {
  mock = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith("/models")) {
        return Response.json({ data: [{ id: "mock-model" }] });
      }
      if (url.pathname.endsWith("/chat/completions")) {
        if (mockDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, mockDelayMs));
        const request = (await req.json().catch(() => ({}))) as any;
        const promptChars = Array.isArray(request.messages)
          ? request.messages.reduce((sum: number, m: any) => sum + JSON.stringify(m.content ?? "").length, 0)
          : 0;
        const promptTokens = Math.max(1, Math.ceil(promptChars / 4));
        const body = sseChunk({
          id: "mock-1",
          object: "chat.completion.chunk",
          created: 1,
          model: "deepseek-chat",
          choices: [{ index: 0, delta: { role: "assistant", content: "hello from mock" }, finish_reason: null }],
        }) +
          sseChunk({
            id: "mock-1",
            object: "chat.completion.chunk",
            created: 1,
            model: "deepseek-chat",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: promptTokens, completion_tokens: 4, total_tokens: promptTokens + 4 },
          }) +
          "data: [DONE]\n\n";
        return new Response(body, {
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return `http://127.0.0.1:${mock.port}/v1`;
}

/** 保证 mock provider 与本地 SSE 服务就绪（多个用例共用） */
function ensureMockProvider(): void {
  const store = new DatabaseStore();
  if (store.getModelProvider("mock")) return;
  const apiBase = startMock();
  store.saveModelProvider({
    id: "mock",
    name: "Mock",
    protocol: "openai-completions",
    apiBase,
    apiKey: "mock-key",
    models: ["deepseek-chat"],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}

afterAll(async () => {
  await AgentManager.getInstance().shutdown().catch(() => {});
  mock?.stop(true);
});

describe("AgentManager chat observability", () => {
  test("一轮 chat 写 llm_turns / llm_requests，并经 telemetry 归因", async () => {
    ensureMockProvider();
    const store = new DatabaseStore();
    store.saveModelMetadata({
      providerId: "mock",
      modelId: "deepseek-chat",
      auto: null,
      manual: { cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } },
      updatedAt: Date.now(),
    });
    const agent = store.getAgent("agent-default");
    expect(agent).toBeDefined();
    store.saveAgent({ ...agent!, model: { ...agent!.model, provider: "mock", modelId: "deepseek-chat" } });

    await AgentManager.getInstance().init(root, { resume: false });
    const messageTime = new Date(2026, 10, 1, 15, 11, 23).getTime();
    await AgentManager.getInstance().chat("agent-default", "terminal-main:local-user", "hello", undefined, {
      messageTime,
    });

    const session = store.getSession("channel_session", "agent-default:terminal-main:local-user");
    expect(session?.conversationId).toBeTruthy();

    // 每条用户消息前置事实型时间上下文（无指令）
    const harness = AgentManager.getInstance().getHarness();
    const conv = await harness!.conversation(session!.conversationId as never, BACKGROUND_CONTEXT);
    const view = await conv.context(BACKGROUND_CONTEXT);
    const userTexts = view.entries.flatMap((entry) =>
      (entry.model ?? [])
        .filter((message) => message.role === "user")
        .map((message) =>
          typeof message.content === "string"
            ? message.content
            : message.content
                .filter((part): part is { type: "text"; text: string } => part.type === "text")
                .map((part) => part.text)
                .join(""),
        ),
    );
    expect(userTexts.some((text) => text.includes("<context>消息时间: 2026-11-01 15:11:23"))).toBe(true);
    expect(userTexts.some((text) => text.includes("hello"))).toBe(true);
    // 终端会话同样要拿到 <context> 说明（说明挂在常驻扩展，不依赖 IM 渠道）
    const terminalSections = getCurrentSystemMessage(view.entries.flatMap((entry) => entry.model ?? []))?.sections;
    expect(terminalSections?.message_time_context).toContain("authoritative");

    const turns = store.listLlmTurns(session!.conversationId, 10, 0);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ status: "done", sessionKind: "normal" });
    expect(turns[0]!.requestCount).toBeGreaterThanOrEqual(1);
    expect(turns[0]!.firstChunkMs).not.toBeUndefined();
    expect(turns[0]!.outputTokens).toBeGreaterThan(0);
    expect(turns[0]!.costUsd).toBeGreaterThan(0);

    const requests = store.listLlmRequests(turns[0]!.turnId);
    expect(requests.length).toBeGreaterThanOrEqual(1);
    expect(requests[0]!.taskKind).toBe("generation");
    expect(requests[0]!.provider).toBe("mock");
  });


  test("轮询模式 legacy scheduler 映射：手动压缩不新建会话", async () => {
    const store = new DatabaseStore();
    AgentManager.getInstance().applyContextPolicy(
      DEFAULT_CONTEXT_POLICY,
    );
    const now = Date.now();
    store.saveScheduledTask({
      id: "legacy-task",
      agentId: "agent-default",
      name: "legacy",
      prompt: "legacy prompt",
      scheduleType: "every",
      intervalSeconds: 300,
      enabled: true,
      runCount: 0,
      durableState: "pending",
      scheduleVersion: 0,
      notifyEnabled: false,
      createdAt: now,
      updatedAt: now,
    } as any);

    // 轮询路径：没有 schedulerTaskId，getOrCreateConversation 写的是
    // `agent-default:scheduler:legacy-task` sentinel。
    await AgentManager.getInstance().chat("agent-default", "scheduler:legacy-task", "legacy hello");
    const legacy = store.getSession("channel_session", "agent-default:scheduler:legacy-task");
    expect(legacy?.conversationId).toBeTruthy();

    const outcome = await AgentManager.getInstance().compactSession("agent-default", "scheduler:legacy-task");
    expect(["done", "skipped"]).toContain(outcome.status);
    const after = store.getSession("channel_session", "agent-default:scheduler:legacy-task");
    expect(after?.conversationId).toBe(legacy!.conversationId);
    expect(store.getScheduledTaskRaw("legacy-task")?.conversationId).toBe(legacy!.conversationId);
  });

  test("取消落在压缩/请求窗口时不继续提交", async () => {
    const sessionId = "terminal-main:local-user";
    AgentManager.getInstance().applyContextPolicy({
      ...DEFAULT_CONTEXT_POLICY,
      strategies: {
        ...DEFAULT_CONTEXT_POLICY.strategies,
        global: { enabled: true, percent: 0.0001, minTokens: 0 },
      },
      safetyTokens: 0,
      settleTimeoutMs: 2_000,
      timeoutMs: 10_000,
    });
    mockDelayMs = 800;
    const chat = AgentManager.getInstance().chat("agent-default", sessionId, "cancel race " + "z".repeat(50_000));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const aborted = await AgentManager.getInstance().abortSession("agent-default", sessionId);
    expect(aborted).toBe(true);
    await expect(chat).rejects.toThrow(/cancel|abort/i);
    mockDelayMs = 0;
    const store = new DatabaseStore();
    const session = store.getSession("channel_session", `agent-default:${sessionId}`);
    const turns = store.listLlmTurns(session!.conversationId, 5, 0);
    expect(turns.every((t) => t.status !== "running")).toBe(true);
  });

  test("下一轮超过策略阈值时，先压缩再提交，turn 标记 compactedBefore", async () => {
    const store = new DatabaseStore();
    AgentManager.getInstance().applyContextPolicy({
      ...DEFAULT_CONTEXT_POLICY,
      strategies: {
        ...DEFAULT_CONTEXT_POLICY.strategies,
        global: { enabled: true, percent: 0.0001, minTokens: 0 },
      },
      safetyTokens: 0,
      settleTimeoutMs: 2_000,
      timeoutMs: 10_000,
    });

    // 第一轮把上下文撑大（本轮开始前上下文还小，不触发）
    await AgentManager.getInstance().chat(
      "agent-default",
      "terminal-main:local-user",
      "long: " + "y".repeat(100_000),
    );
    // 第二轮开始前估算已超过 keepRecent+1k，触发前置压缩
    await AgentManager.getInstance().chat("agent-default", "terminal-main:local-user", "hi again");

    const session = store.getSession("channel_session", "agent-default:terminal-main:local-user");
    const turns = store.listLlmTurns(session!.conversationId, 10, 0);
    expect(turns.length).toBeGreaterThanOrEqual(2);
    const latest = turns[0]!;
    expect(latest.compactedBefore).toBe(true);
    const compactions = store.listCompactionEvents({ conversationId: session!.conversationId });
    expect(compactions.some((c) => c.trigger.startsWith("pre_turn") && c.status === "done")).toBe(true);
  });

  test("IM 会话的系统提示注入 channel_context（MEDIA 出站约定）", async () => {
    ensureMockProvider();
    const store = new DatabaseStore();
    store.saveChannel({
      id: "weixin-test",
      type: "weixin",
      name: "微信测试",
      enabled: true,
      boundAgentId: "agent-default",
      credentials: {},
      updatedAt: Date.now(),
    });
    const agent = store.getAgent("agent-default")!;
    store.saveAgent({ ...agent, model: { ...agent.model, provider: "mock", modelId: "deepseek-chat" } });
    AgentManager.getInstance().applyContextPolicy(DEFAULT_CONTEXT_POLICY);

    await AgentManager.getInstance().chat("agent-default", "weixin-test:wx-peer-1", "发一张图给我");

    const session = store.getSession("channel_session", "agent-default:weixin-test:wx-peer-1");
    expect(session?.conversationId).toBeTruthy();
    const harness = AgentManager.getInstance().getHarness()!;
    const conv = await harness.conversation(Number(session!.conversationId) as never, BACKGROUND_CONTEXT);
    const view = await conv.context(BACKGROUND_CONTEXT);
    // registry.install 只是「可被选择」；会话 configure 的 extensions 名单漏加
    // channel-context 时，整段 section 不会出现在系统提示里（回归点）
    const sections = getCurrentSystemMessage(view.entries.flatMap((entry) => entry.model ?? []))?.sections;
    const rendered = sections?.channel_context ?? "";
    expect(rendered).toContain("MEDIA:");
    // 提示词必须准确描述实际限制：仅工作区、单个与总量上限
    expect(rendered).toContain("inside your workspace");
    expect(rendered).toContain(`${Math.round(MEDIA_MAX_BYTES / (1024 * 1024))} MB`);
    expect(rendered).toContain(`${MAX_OUTBOUND_MEDIA} files`);
    expect(rendered).toContain(`${Math.round(MAX_TOTAL_OUTBOUND_MEDIA_BYTES / (1024 * 1024))} MB in total`);
    // 每条消息的 <context> 事实块说明对所有会话类型生效
    expect(sections?.message_time_context).toContain("authoritative");
  });
});
