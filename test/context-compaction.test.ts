import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { DatabaseManager } from "../src/database/index.ts";
import { DatabaseStore } from "../src/config/database-store.ts";
import { logger } from "../src/utils/logger.ts";
import { DEFAULT_CONTEXT_POLICY, type ContextPolicy } from "../src/core/context-policy.ts";
import {
  compactConversationNow,
  maybeCompactBeforeTurn,
} from "../src/core/context-compaction.ts";

const root = mkdtempSync(join(tmpdir(), "bot-context-compaction-"));
DatabaseManager.getInstance(join(root, "bot.sqlite"));
logger.init(root);

afterAll(() => {
});

const policy: ContextPolicy = {
  ...structuredClone(DEFAULT_CONTEXT_POLICY),
  strategies: {
    global: { enabled: true, percent: 0.01, minTokens: 0 },
    scheduledHeuristic: {
      enabled: false,
      sampleSize: 5,
      multiplier: 5,
      fallbackTokens: 5_000,
      minTokens: 0,
      maxPercentOfWindow: 0.8,
    },
    fixed: { enabled: false, tokens: 5_000, minTokens: 0, scope: "all" },
    idle: { enabled: false, idleHours: 24, minTokens: 0 },
  },
  settleTimeoutMs: 2_000,
  timeoutMs: 10_000,
};

function withGlobalPercent(base: ContextPolicy, percent: number): ContextPolicy {
  return {
    ...base,
    strategies: {
      ...base.strategies,
      global: { ...base.strategies.global, percent },
    },
  };
}

async function makeHarness() {
  const faux = fauxProvider({
    models: [{ id: "fake-model", contextWindow: 200_000, maxTokens: 8_192, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await Harness.open(
    new MemoryStorage(),
    {
      models: () => models,
      registry: createRegistry(),
      settings: {
        compaction: { enabled: false, keepRecentTokens: 2_000, backgroundTokens: 0 },
      },
    },
    BACKGROUND_CONTEXT,
  );
  const conv = await harness.root(BACKGROUND_CONTEXT, {
    agent: { model: { provider: "faux", modelId: "fake-model" } },
  });
  return { faux, harness, conv };
}

async function seedLongMessages(harness: Harness, conv: any, faux: any, count: number, reply = "ok") {
  faux.setResponses(Array.from({ length: count + 2 }, () => fauxAssistantMessage(reply)));
  for (let i = 0; i < count; i++) {
    const sub = await conv.submit(
      { type: "input", content: `seed-${i}: ` + "x".repeat(20_000) },
      BACKGROUND_CONTEXT,
    );
    const settled = await sub.wait(BACKGROUND_CONTEXT);
    expect(settled.status).toBe("done");
  }
}

describe("pre-turn compaction", () => {
  test("超过阈值：前置压缩产生 summary，entries 减少", async () => {
    const { faux, harness, conv } = await makeHarness();
    const store = new DatabaseStore();
    await seedLongMessages(harness, conv, faux, 3);
    const before = await conv.context(BACKGROUND_CONTEXT);

    const outcome = await maybeCompactBeforeTurn({
      harness,
      conversation: conv,
      conversationId: String(conv.id),
      agentId: "agent-x",
      sessionId: "terminal-main:local-user",
      policy,
      profile: "normal",
      trigger: "pre_turn",
      contextWindow: 200_000,
      incomingTokens: 10,
      store,
    });
    expect(outcome).not.toBeNull();
    expect(["done", "skipped"]).toContain(outcome!.status);
    const after = await conv.context(BACKGROUND_CONTEXT);
    expect(after.entries.length).toBeLessThan(before.entries.length);
    const events = store.listCompactionEvents({ conversationId: String(conv.id) });
    expect(events.length).toBe(1);
    expect(events[0]!.trigger).toBe("pre_turn_global");
    await harness.close(BACKGROUND_CONTEXT);
  });

  test("低于阈值：不压缩、不写事件", async () => {
    const { faux, harness, conv } = await makeHarness();
    const store = new DatabaseStore();
    const beforeCount = store.listCompactionEvents({ conversationId: String(conv.id) }).length;
    await seedLongMessages(harness, conv, faux, 1, "short");
    const outcome = await maybeCompactBeforeTurn({
      harness,
      conversation: conv,
      conversationId: String(conv.id),
      agentId: "agent-x",
      sessionId: "s1",
      policy: withGlobalPercent(policy, 0.5),
      profile: "normal",
      trigger: "pre_turn",
      contextWindow: 200_000,
      incomingTokens: 10,
      store,
    });
    expect(outcome).toBeNull();
    expect(store.listCompactionEvents({ conversationId: String(conv.id) }).length).toBe(beforeCount);
    await harness.close(BACKGROUND_CONTEXT);
  });

  test("摘要失败：fail-open，返回 failed 且写审计/事件", async () => {
    const { faux, harness, conv } = await makeHarness();
    const store = new DatabaseStore();
    await seedLongMessages(harness, conv, faux, 3);
    faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "summary boom" })]);
    const outcome = await maybeCompactBeforeTurn({
      harness,
      conversation: conv,
      conversationId: String(conv.id),
      agentId: "agent-x",
      sessionId: "s2",
      policy,
      profile: "normal",
      trigger: "pre_turn",
      contextWindow: 200_000,
      incomingTokens: 10,
      store,
    });
    expect(outcome).not.toBeNull();
    expect(outcome!.failOpen).toBe(true);
    expect(["failed", "timeout"]).toContain(outcome!.status);
    const events = store.listCompactionEvents({ conversationId: String(conv.id) });
    expect(events[0]?.failOpen).toBe(true);
    await harness.close(BACKGROUND_CONTEXT);
  });

  test("定时启发式：最近 N 次净增量 × 倍数触发", async () => {
    const { faux, harness, conv } = await makeHarness();
    const store = new DatabaseStore();
    await seedLongMessages(harness, conv, faux, 10);
    faux.setResponses([fauxAssistantMessage("heuristic summary")]);
    const base = Date.now() - 10_000;
    [10_000, 20_000, 30_000].forEach((contextTokens, index) => {
      store.insertLlmTurn({
        turnId: `heur-${index}`,
        conversationId: "heur-conv",
        agentId: "agent-x",
        sessionId: "s5",
        sessionKind: "scheduled",
        startedAt: base + index * 1_000,
        endedAt: base + index * 1_000 + 500,
        durationMs: 500,
        contextTokens,
        requestCount: 1,
        toolCount: 0,
        inputTokens: 1_000,
        outputTokens: 100,
        cacheRead: 0,
        cacheWrite: 0,
        reasoningTokens: 0,
        costUsd: 0,
        priced: false,
        compactedBefore: false,
        compactionMs: 0,
        status: "done",
        detailTruncated: false,
      });
    });
    const heuristicPolicy: ContextPolicy = {
      ...policy,
      strategies: {
        global: { ...policy.strategies.global, enabled: false },
        scheduledHeuristic: {
          enabled: true,
          sampleSize: 5,
          multiplier: 5,
          fallbackTokens: 50_000,
          minTokens: 0,
          maxPercentOfWindow: 0.8,
        },
        fixed: { ...policy.strategies.fixed, enabled: false },
        idle: { ...policy.strategies.idle, enabled: false },
      },
    };
    const outcome = await maybeCompactBeforeTurn({
      harness,
      conversation: conv,
      conversationId: "heur-conv",
      agentId: "agent-x",
      sessionId: "s5",
      policy: heuristicPolicy,
      profile: "scheduled",
      trigger: "pre_turn",
      contextWindow: 200_000,
      incomingTokens: 10,
      store,
    });
    expect(outcome).not.toBeNull();
    expect(outcome!.trigger).toBe("pre_turn_scheduled");
    await harness.close(BACKGROUND_CONTEXT);
  });

  test("空闲超时：上一轮结束超过阈值时触发 idle 压缩", async () => {
    const { faux, harness, conv } = await makeHarness();
    const store = new DatabaseStore();
    await seedLongMessages(harness, conv, faux, 3);
    faux.setResponses([fauxAssistantMessage("idle summary")]);
    const now = Date.now();
    store.insertLlmTurn({
      turnId: "idle-turn",
      conversationId: "idle-conv",
      agentId: "agent-x",
      sessionId: "s6",
      sessionKind: "normal",
      startedAt: now - 48 * 3_600_000,
      endedAt: now - 48 * 3_600_000 + 1_000,
      durationMs: 1_000,
      contextTokens: 10_000,
      requestCount: 1,
      toolCount: 0,
      inputTokens: 1_000,
      outputTokens: 100,
      cacheRead: 0,
      cacheWrite: 0,
      reasoningTokens: 0,
      costUsd: 0,
      priced: false,
      compactedBefore: false,
      compactionMs: 0,
      status: "done",
      detailTruncated: false,
    });
    const idlePolicy: ContextPolicy = {
      ...policy,
      strategies: {
        global: { ...policy.strategies.global, enabled: false },
        scheduledHeuristic: { ...policy.strategies.scheduledHeuristic, enabled: false },
        fixed: { ...policy.strategies.fixed, enabled: false },
        idle: { enabled: true, idleHours: 24, minTokens: 0 },
      },
    };
    const outcome = await maybeCompactBeforeTurn({
      harness,
      conversation: conv,
      conversationId: "idle-conv",
      agentId: "agent-x",
      sessionId: "s6",
      policy: idlePolicy,
      profile: "normal",
      trigger: "pre_turn",
      contextWindow: 200_000,
      incomingTokens: 10,
      store,
    });
    expect(outcome).not.toBeNull();
    expect(outcome!.trigger).toBe("pre_turn_idle");
    await harness.close(BACKGROUND_CONTEXT);
  });

  test("手动压缩：不受 enabled 限制，返回前后 tokens", async () => {
    const { faux, harness, conv } = await makeHarness();
    await seedLongMessages(harness, conv, faux, 2);
    faux.setResponses([fauxAssistantMessage("manual summary")]);
    const outcome = await compactConversationNow({
      harness,
      conversation: conv,
      conversationId: String(conv.id),
      agentId: "agent-x",
      sessionId: "s3",
      policy: {
        ...policy,
        strategies: {
          ...policy.strategies,
          global: { ...policy.strategies.global, enabled: false },
        },
      },
      contextWindow: 200_000,
      store: new DatabaseStore(),
    });
    expect(["done", "skipped"]).toContain(outcome.status);
    expect(outcome.beforeTokens).toBeGreaterThan(0);
    await harness.close(BACKGROUND_CONTEXT);
  });
});
