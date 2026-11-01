import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseManager } from "../src/database/index.ts";
import { DatabaseStore } from "../src/config/database-store.ts";
import { ContextTelemetry } from "../src/core/context-telemetry.ts";
import { logger } from "../src/utils/logger.ts";

const root = mkdtempSync(join(tmpdir(), "bot-context-telemetry-"));
DatabaseManager.getInstance(join(root, "bot.sqlite"));
logger.init(root);

afterAll(() => {
});

describe("ContextTelemetry", () => {
  test("嵌套 span → request/tool 落库，turn/trace 可回填", async () => {
    const telemetry = new ContextTelemetry();
    telemetry.beginTurn("conv-1", "turn-1");
    const store = new DatabaseStore();

    await telemetry.startSpan(
      {
        name: "pi.durable.submit",
        attributes: { "conversation.id": "conv-1", "submission.id": 42 },
      },
      async (submit) => {
        await submit.startSpan(
          {
            name: "pi.durable.phase",
            attributes: { "task.name": "pi.generation", "task.id": 7 },
          },
          async (phase) => {
            await phase.startSpan(
              {
                name: "pi.ai.request",
                attributes: { provider: "deepseek", model: "deepseek-v4", api: "openai-completions" },
              },
              async (request) => {
                request.addEvent("pi.ai.first_chunk");
                request.setAttributes({
                  "usage.input": 100,
                  "usage.output": 20,
                  "usage.cache_read": 50,
                  "usage.cache_write": 0,
                  "cost.total": 0.02,
                  stop: "stop",
                });
              },
            );
            phase.setAttributes({ "tool.name": "bash", "tool.call_id": "call-1", outcome: "done" });
          },
        );
      },
    );
    await telemetry.flush();

    const requests = store.listLlmRequests("turn-1");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      taskKind: "generation",
      taskId: "7",
      provider: "deepseek",
      modelId: "deepseek-v4",
      inputTokens: 100,
      outputTokens: 20,
      cacheRead: 50,
      stopReason: "stop",
      status: "ok",
    });
    expect(requests[0]!.firstChunkMs).toBeGreaterThanOrEqual(0);

    const tools = store.listToolInvocations("turn-1");
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ toolName: "bash", toolCallId: "call-1", status: "ok" });

    expect(telemetry.traceForTurn("turn-1")).toBeTruthy();
    expect(telemetry.traceForSubmission("42")).toBe(telemetry.traceForTurn("turn-1"));
    await telemetry.close();
  });

  test("compaction span 的 trace 可按 UUID 回查，子请求带 compactionId", async () => {
    const telemetry = new ContextTelemetry();
    const store = new DatabaseStore();
    telemetry.beginCompaction("conv-2", "cmp-1");
    await telemetry.startSpan(
      {
        name: "bot.compaction",
        attributes: { "conversation.id": "conv-2", "bot.compaction.id": "cmp-1", trigger: "manual" },
      },
      async (span) => {
        await span.startSpan(
          {
            name: "pi.durable.phase",
            attributes: { "task.name": "pi.compaction", "task.id": 9 },
          },
          async (phase) => {
            await phase.startSpan(
              { name: "pi.ai.request", attributes: { provider: "p", model: "m" } },
              async (request) => {
                request.setAttributes({ "cost.total": 0.01, "usage.input": 10 });
              },
            );
          },
        );
      },
    );
    await telemetry.flush();
    expect(telemetry.traceForCompaction("cmp-1")).toBeTruthy();
    // 直接按 compactionId 计数（turn_id 为 NULL 的请求不会出现在 listLlmRequests）
    expect(store.countLlmRequestsByCompaction("cmp-1")).toBe(1);
    await telemetry.close();
  });

  test("flush 幂等 + stop 后不再记录", async () => {
    const telemetry = new ContextTelemetry();
    await telemetry.startSpan(
      { name: "pi.ai.request", attributes: { provider: "idempotent-p", model: "m" } },
      async (span) => {
        span.setAttributes({ "cost.total": 0.001 });
      },
    );
    await telemetry.flush();
    await telemetry.flush();
    const db = DatabaseManager.getInstance();
    const count = db.queryOne<{ n: number }>(
      "SELECT COUNT(*) AS n FROM llm_requests WHERE provider = 'idempotent-p'",
    )?.n ?? 0;
    expect(count).toBe(1);
    await telemetry.close();
    await telemetry.startSpan(
      { name: "pi.ai.request", attributes: { provider: "idempotent-p", model: "m" } },
      async () => {},
    );
    await telemetry.flush();
    expect(
      db.queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM llm_requests WHERE provider = 'idempotent-p'")?.n ?? 0,
    ).toBe(1);
  });
});
