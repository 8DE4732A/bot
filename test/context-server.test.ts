import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { AdminWebServer } from "../src/server/server.ts";
import { DatabaseManager } from "../src/database/index.ts";
import { DatabaseStore } from "../src/config/database-store.ts";
import { logger } from "../src/utils/logger.ts";

const root = mkdtempSync(join(tmpdir(), "bot-context-server-"));
DatabaseManager.getInstance(join(root, "bot.sqlite"));
logger.init(root);
const port = 3198;
const server = new AdminWebServer(port);
let started = false;

async function ensureStarted() {
  if (!started) {
    await server.start();
    started = true;
  }
}

afterAll(async () => {
  await server.stop().catch(() => {});
});

const base = () => `http://127.0.0.1:${port}`;

describe("context REST", () => {
  test("policy GET 默认值 / PUT 校验", async () => {
    await ensureStarted();
    const res = await fetch(`${base()}/api/context/policy`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.policy.strategies.global.percent).toBe(0.8);
    expect(body.policy.strategies.scheduledHeuristic.fallbackTokens).toBe(50_000);
    expect(Array.isArray(body.effective)).toBe(true);

    const bad = await fetch(`${base()}/api/context/policy`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ policy: { ...body.policy, detailRetentionDays: 999, retentionDays: 1 } }),
    });
    expect(bad.status).toBe(400);

    const good = await fetch(`${base()}/api/context/policy`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ policy: { ...body.policy, strategies: { ...body.policy.strategies, global: { ...body.policy.strategies.global, percent: 0.7 } } } }),
    });
    expect(good.status).toBe(200);
    const saved = await good.json();
    expect(saved.policy.strategies.global.percent).toBe(0.7);
  });

  test("model metadata：手动覆盖 + 恢复自动", async () => {
    await ensureStarted();
    const store = new DatabaseStore();
    store.saveModelProvider({
      id: "ctx-provider",
      name: "Ctx Provider",
      protocol: "openai-completions",
      apiBase: "https://api.deepseek.com",
      apiKey: "secret",
      models: ["deepseek-v4"],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const list = await fetch(`${base()}/api/model-metadata?providerId=ctx-provider`);
    expect(list.status).toBe(200);
    const listed = await list.json();
    expect(listed.models).toHaveLength(1);
    expect(listed.models[0].modelId).toBe("deepseek-v4");
    // 响应永不含明文 key
    expect(JSON.stringify(listed)).not.toContain("secret");

    const saved = await fetch(`${base()}/api/model-metadata`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "ctx-provider",
        modelId: "deepseek-v4",
        overrides: { contextWindow: 123_456, maxOutputTokens: 8_192, cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 } },
      }),
    });
    expect(saved.status).toBe(200);
    const effective = await saved.json();
    expect(effective.contextWindow).toBe(123_456);
    expect(effective.cost.input).toBe(1);
    expect(effective.source).toBe("manual");

    const reset = await fetch(`${base()}/api/model-metadata`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: "ctx-provider", modelId: "deepseek-v4", reset: true }),
    });
    expect(reset.status).toBe(200);
    const resetBody = await reset.json();
    expect(resetBody.manual).toBeNull();
    expect(resetBody.contextWindow).not.toBe(123_456);
  });

  test("model metadata：目录参考价候选与应用", async () => {
    await ensureStarted();
    const store = new DatabaseStore();
    const now = Date.now();
    store.saveModelProvider({
      id: "ctx-ref-provider",
      name: "Local Proxy",
      protocol: "openai-completions",
      apiBase: "http://127.0.0.1:9002/v1",
      apiKey: "k",
      models: ["deepseek-v4-1-flash"],
      createdAt: now,
      updatedAt: now,
    });
    const catalog = {
      deepseek: {
        id: "deepseek",
        name: "DeepSeek",
        models: {
          "deepseek-v4-flash": {
            id: "deepseek-v4-flash",
            limit: { context: 1_000_000, output: 393_216 },
            cost: { input: 0.15, output: 0.6, cache_read: 0.003 },
          },
        },
      },
      neon: {
        id: "neon",
        name: "Neon",
        models: {
          "deepseek-v4-1-flash": {
            id: "deepseek-v4-1-flash",
            limit: { context: 1_000_000, output: 384_000 },
            cost: { input: 0.3, output: 1.2, cache_read: 0.03 },
          },
        },
      },
      openrouter: {
        id: "openrouter",
        name: "OpenRouter",
        models: {
          "deepseek/deepseek-v4.1-flash": {
            id: "deepseek/deepseek-v4.1-flash",
            name: "DeepSeek V4.1 Flash",
            canonical_model_id: "deepseek/deepseek-v4.1-flash",
            limit: { context: 1_048_576, output: 943_718 },
            cost: { input: 0.045, output: 0.5, cache_read: 0.006 },
          },
        },
      },
    };
    store.saveModelCatalogCache({
      payload: gzipSync(Buffer.from(JSON.stringify(catalog))),
      fetchedAt: now,
      lastCheckedAt: now,
      providerCount: 3,
      modelCount: 3,
    });

    const candidatesRes = await fetch(
      `${base()}/api/model-metadata/candidates?providerId=ctx-ref-provider&modelId=deepseek-v4-1-flash`,
    );
    expect(candidatesRes.status).toBe(200);
    const candidatesBody = await candidatesRes.json();
    expect(candidatesBody.candidates.map((c: any) => c.providerKey)).toEqual(["neon", "openrouter"]);
    expect(candidatesBody.candidates[0].match).toBe("exact");
    expect(candidatesBody.candidates[1].match).toBe("normalized");
    expect(candidatesBody.candidates[1].cost.input).toBe(0.045);

    const appliedRes = await fetch(`${base()}/api/model-metadata`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "ctx-ref-provider",
        modelId: "deepseek-v4-1-flash",
        reference: { providerId: "openrouter", modelId: "deepseek/deepseek-v4.1-flash" },
      }),
    });
    expect(appliedRes.status).toBe(200);
    const applied = await appliedRes.json();
    expect(applied.cost.input).toBe(0.045);
    expect(applied.contextWindow).toBe(1_048_576);
    expect(applied.priced).toBe(true);
    expect(applied.manual.reference.providerId).toBe("openrouter");
    expect(applied.manual.reference.providerName).toBe("OpenRouter");

    const listed = await (await fetch(`${base()}/api/model-metadata?providerId=ctx-ref-provider`)).json();
    expect(listed.models[0].reference.providerId).toBe("openrouter");
    expect(listed.models[0].cost.input).toBe(0.045);

    const reset = await fetch(`${base()}/api/model-metadata`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: "ctx-ref-provider", modelId: "deepseek-v4-1-flash", reset: true }),
    });
    const resetBody = await reset.json();
    expect(resetBody.manual).toBeNull();
    expect(resetBody.reference).toBeNull();
    expect(resetBody.priced).toBe(false);
  });

  test("sessions/turns：聚合与 404", async () => {
    await ensureStarted();
    const store = new DatabaseStore();
    const now = Date.now();
    store.insertLlmTurn({
      turnId: "turn-a",
      conversationId: "9001",
      agentId: "agent-default",
      sessionId: "terminal-main:local-user",
      sessionKind: "normal",
      provider: "deepseek",
      modelId: "deepseek-v4",
      startedAt: now - 1000,
      endedAt: now,
      durationMs: 1000,
      requestCount: 2,
      toolCount: 1,
      inputTokens: 100,
      outputTokens: 20,
      cacheRead: 50,
      cacheWrite: 0,
      reasoningTokens: 0,
      costUsd: 0.02,
      priced: true,
      contextTokens: 150,
      contextWindow: 1_000_000,
      compactedBefore: false,
      compactionMs: 0,
      status: "done",
      detailTruncated: false,
    });
    store.insertLlmRequests([
      {
        spanId: "span-a",
        turnId: "turn-a",
        conversationId: "9001",
        kind: "request",
        taskKind: "generation",
        provider: "deepseek",
        modelId: "deepseek-v4",
        startedAt: now - 900,
        endedAt: now - 500,
        durationMs: 400,
        firstChunkMs: 120,
        inputTokens: 100,
        outputTokens: 20,
        cacheRead: 50,
        cacheWrite: 0,
        reasoningTokens: 0,
        costUsd: 0.02,
        stopReason: "stop",
        status: "ok",
      },
    ]);
    store.insertToolInvocations([
      {
        turnId: "turn-a",
        conversationId: "9001",
        traceId: "trace-a",
        toolCallId: "call-a",
        toolName: "bash",
        startedAt: now - 800,
        endedAt: now - 700,
        durationMs: 100,
        status: "ok",
      },
    ]);

    const sessions = await fetch(`${base()}/api/context/sessions`);
    expect(sessions.status).toBe(200);
    const sessionsBody = await sessions.json();
    const row = sessionsBody.rows.find((r: any) => r.conversationId === "9001");
    expect(row).toMatchObject({ turns: 1, costUsd: 0.02, contextTokens: 150, sessionKind: "normal" });
    expect(row.fillRatio).toBeCloseTo(0.00015);

    const search = await fetch(`${base()}/api/context/sessions?q=local-user`);
    expect(search.status).toBe(200);
    const searchBody = await search.json();
    expect(searchBody.total).toBe(1);
    expect(searchBody.rows[0].conversationId).toBe("9001");
    const noHit = await fetch(`${base()}/api/context/sessions?q=no-such-session`);
    expect((await noHit.json()).total).toBe(0);

    const turns = await fetch(`${base()}/api/context/sessions/9001/turns`);
    expect(turns.status).toBe(200);
    const turnsBody = await turns.json();
    expect(turnsBody.turns).toHaveLength(1);
    expect(turnsBody.total).toBe(1);

    const detail = await fetch(`${base()}/api/context/turns/turn-a`);
    expect(detail.status).toBe(200);
    const detailBody = await detail.json();
    expect(detailBody.requests[0].firstChunkMs).toBe(120);
    expect(detailBody.tools[0].toolName).toBe("bash");

    const missing = await fetch(`${base()}/api/context/turns/nope`);
    expect(missing.status).toBe(404);

    const compactMissing = await fetch(`${base()}/api/context/sessions/999999/compact`, { method: "POST" });
    expect(compactMissing.status).toBe(404);
  });
});

describe("context maintenance", () => {
  test("遗留 running → interrupted；保留期清理", () => {
    const store = new DatabaseStore();
    const now = Date.now();
    store.insertLlmTurn({
      turnId: "turn-old-running",
      conversationId: "old-conv",
      agentId: "agent-default",
      sessionId: "s1",
      sessionKind: "normal",
      startedAt: now - 10_000,
      requestCount: 0,
      toolCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoningTokens: 0,
      costUsd: 0,
      priced: false,
      compactedBefore: false,
      compactionMs: 0,
      status: "running",
      detailTruncated: false,
    });
    expect(store.markRunningTurnsInterrupted(now)).toBeGreaterThanOrEqual(1);
    expect(store.getLlmTurn("turn-old-running")?.status).toBe("interrupted");

    store.insertLlmTurn({
      turnId: "turn-ancient",
      conversationId: "ancient",
      agentId: "agent-default",
      sessionId: "s2",
      sessionKind: "normal",
      startedAt: now - 400 * 86_400_000,
      requestCount: 0,
      toolCount: 0,
      inputTokens: 0,
      outputTokens: 0,
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
    const cleaned = store.cleanupContextMetrics({
      turnCutoff: now - 90 * 86_400_000,
      detailCutoff: now - 30 * 86_400_000,
    });
    expect(cleaned.turns).toBeGreaterThanOrEqual(1);
    expect(store.getLlmTurn("turn-ancient")).toBeUndefined();
  });
});
