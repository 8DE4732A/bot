import { describe, expect, test } from "bun:test";
import type { ConversationView, EntryRecord } from "@earendil-works/pi-durable";
import {
  createTurnViewState,
  reduceTurnView,
  seedTurnView,
} from "../src/core/live-view.ts";

function entry(id: number, kind = "pi.assistant", model?: any[]): EntryRecord {
  return { id, conversationId: 1, kind, model } as unknown as EntryRecord;
}

function message(text: string, timestamp = 1) {
  return { role: "assistant", content: [{ type: "text", text }], timestamp };
}

function thinkingMessage(thinking: string, timestamp = 2) {
  return { role: "assistant", content: [{ type: "thinking", thinking }], timestamp };
}

function view(input: {
  entries?: EntryRecord[];
  live?: Record<string, unknown>;
}): ConversationView {
  return {
    conversation: { id: 1 },
    entries: input.entries ?? [],
    docs: input.live ? { "pi.live": input.live as any } : {},
  } as unknown as ConversationView;
}

function live(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run: { taskId: 1, inputs: [], turns: 0 },
    generation: { attempt: 0 },
    ...patch,
  };
}

describe("ConversationView 归约器（1.5.0）", () => {
  test("attach 基线不重复消费历史 entries", () => {
    const state = createTurnViewState();
    seedTurnView(state, view({ entries: [entry(1), entry(2)] }));
    expect(state.lastEntryId).toBe(2);

    const first = reduceTurnView(state, view({ entries: [entry(1), entry(2)] }));
    expect(first.entries).toHaveLength(0);

    const second = reduceTurnView(state, view({ entries: [entry(1), entry(2), entry(3)] }));
    expect(second.entries.map((e) => e.id)).toEqual([3]);
  });

  test("同一 generation 前缀差分；新 generation 另起一段", () => {
    const state = createTurnViewState();
    seedTurnView(state, view({ entries: [] }));

    let changes = reduceTurnView(
      state,
      view({ entries: [], live: live({ generation: { attempt: 0, message: message("he") } }) }),
    );
    expect(changes.textDelta).toBe("he");

    changes = reduceTurnView(
      state,
      view({ entries: [], live: live({ generation: { attempt: 0, message: message("hello") } }) }),
    );
    expect(changes.textDelta).toBe("llo");

    // 工具轮之间 generation 可能先消失；不能因此忘掉「本轮已经输出过文本」
    changes = reduceTurnView(state, view({ entries: [], live: live({ generation: { attempt: 0 } }) }));
    expect(changes.textDelta).toBeUndefined();

    changes = reduceTurnView(
      state,
      view({
        entries: [],
        live: live({
          run: { taskId: 2, inputs: [], turns: 1 },
          generation: { attempt: 0, message: message("next", 2) },
        }),
      }),
    );
    expect(changes.textDelta).toBe("\nnext");
  });

  test("新 generation 首帧只有 thinking 时，首个 text 前补换行", () => {
    const state = createTurnViewState();
    seedTurnView(state, view({ entries: [] }));

    let changes = reduceTurnView(
      state,
      view({ entries: [], live: live({ generation: { attempt: 0, message: message("first", 1) } }) }),
    );
    expect(changes.textDelta).toBe("first");

    changes = reduceTurnView(
      state,
      view({
        entries: [],
        live: live({
          run: { taskId: 2, inputs: [], turns: 1 },
          generation: { attempt: 0, message: thinkingMessage("checking", 2) },
        }),
      }),
    );
    expect(changes.textDelta).toBeUndefined();

    changes = reduceTurnView(
      state,
      view({
        entries: [],
        live: live({
          run: { taskId: 2, inputs: [], turns: 1 },
          generation: {
            attempt: 0,
            message: {
              role: "assistant",
              content: [{ type: "thinking", thinking: "checking" }, { type: "text", text: "final" }],
              timestamp: 2,
            },
          },
        }),
      }),
    );
    expect(changes.textDelta).toBe("\nfinal");
  });

  test("同 generation 文本被 provider 改写时另起一行，不重复最终回答", () => {
    const state = createTurnViewState();
    seedTurnView(state, view({ entries: [] }));

    let changes = reduceTurnView(
      state,
      view({ entries: [], live: live({ generation: { attempt: 0, message: message("abc") } }) }),
    );
    expect(changes.textDelta).toBe("abc");

    changes = reduceTurnView(
      state,
      view({ entries: [], live: live({ generation: { attempt: 0, message: message("ab") } }) }),
    );
    expect(changes.textDelta).toBe("\nab");

    changes = reduceTurnView(
      state,
      view({ entries: [], live: live({ generation: { attempt: 0, message: message("abc") } }) }),
    );
    expect(changes.textDelta).toBe("c");
  });

  test("工具状态只上报 running/done；pending 是顺序轮占位", () => {
    const state = createTurnViewState();
    seedTurnView(state, view({ entries: [] }));

    let changes = reduceTurnView(
      state,
      view({ entries: [], live: live({ tools: [{ callId: "a", name: "bash", status: "pending" }] }) }),
    );
    expect(changes.toolUpdates).toEqual([]);

    changes = reduceTurnView(
      state,
      view({ entries: [], live: live({ tools: [{ callId: "a", name: "bash", status: "running" }] }) }),
    );
    expect(changes.toolUpdates).toEqual([{ name: "bash", status: "running" }]);

    changes = reduceTurnView(
      state,
      view({ entries: [], live: live({ tools: [{ callId: "a", name: "bash", status: "done" }] }) }),
    );
    expect(changes.toolUpdates).toEqual([{ name: "bash", status: "done" }]);
  });

  test("running 工具 slot 消失（fault/orphan/折叠）时补 done", () => {
    const state = createTurnViewState();
    seedTurnView(state, view({ entries: [] }));

    let changes = reduceTurnView(
      state,
      view({ entries: [], live: live({ tools: [{ callId: "a", name: "bash", status: "running" }] }) }),
    );
    expect(changes.toolUpdates).toEqual([{ name: "bash", status: "running" }]);

    changes = reduceTurnView(state, view({ entries: [], live: live({ tools: [] }) }));
    expect(changes.toolUpdates).toEqual([{ name: "bash", status: "done" }]);
  });

  test("1.6.0 parked 状态（sleeping）槽位消失时补 done", () => {
    const state = createTurnViewState();
    seedTurnView(state, view({ entries: [] }));

    let changes = reduceTurnView(
      state,
      view({ entries: [], live: live({ tools: [{ callId: "p", name: "mcp__x__slow", status: "running" }] }) }),
    );
    expect(changes.toolUpdates).toEqual([{ name: "mcp__x__slow", status: "running" }]);

    // 进入 parked（sleeping/waiting）：不向 UI 上报中间状态
    changes = reduceTurnView(
      state,
      view({ entries: [], live: live({ tools: [{ callId: "p", name: "mcp__x__slow", status: "sleeping" }] }) }),
    );
    expect(changes.toolUpdates).toEqual([]);

    // 中止/重启后槽位直接消失：补 done，避免永久 running
    changes = reduceTurnView(state, view({ entries: [], live: live({ tools: [] }) }));
    expect(changes.toolUpdates).toEqual([{ name: "mcp__x__slow", status: "done" }]);
  });

  test("压缩任务出现/消失即起止；失败原因来自 compactionFailure", () => {
    const state = createTurnViewState();
    seedTurnView(state, view({ entries: [] }));

    let changes = reduceTurnView(
      state,
      view({ entries: [], live: live({ compactions: [{ taskId: 7, trigger: "threshold" }] }) }),
    );
    expect(changes.compactionStarts).toEqual([
      { taskId: "7", trigger: "threshold", at: expect.any(Number) },
    ]);

    changes = reduceTurnView(
      state,
      view({
        entries: [],
        live: live({
          compactions: [],
          compactionFailure: { taskId: 7, trigger: "threshold", error: "boom" },
        }),
      }),
    );
    expect(changes.compactionEnds).toEqual([
      { taskId: "7", trigger: "threshold", at: expect.any(Number), error: "boom" },
    ]);
  });

  test("attach 前已存在的压缩任务结束时不计入本轮", () => {
    const state = createTurnViewState();
    seedTurnView(
      state,
      view({ entries: [], live: live({ compactions: [{ taskId: 9, trigger: "threshold" }] }) }),
    );

    const changes = reduceTurnView(state, view({ entries: [], live: live({ compactions: [] }) }));
    expect(changes.compactionStarts).toEqual([]);
    expect(changes.compactionEnds).toEqual([]);
  });

  test("快速工具在两次 view 之间完成时，由 tool-result 条目补 done", () => {
    const state = createTurnViewState();
    seedTurnView(state, view({ entries: [] }));

    const changes = reduceTurnView(
      state,
      view({
        entries: [
          entry(1, "pi.tool-result", [
            { role: "toolResult", toolCallId: "fast", toolName: "datetime" },
          ]),
        ],
        live: live({ tools: [] }),
      }),
    );
    expect(changes.toolUpdates).toEqual([{ name: "datetime", status: "done" }]);
  });

  test("首个 token 只上报一次（text/thinking/toolCall 任一）", () => {
    const state = createTurnViewState();
    seedTurnView(state, view({ entries: [] }));

    const first = reduceTurnView(
      state,
      view({ entries: [], live: live({ generation: { attempt: 0, message: message("x") } }) }),
    );
    expect(first.firstTokenSeen).toBe(true);

    const second = reduceTurnView(
      state,
      view({ entries: [], live: live({ generation: { attempt: 0, message: message("xy") } }) }),
    );
    expect(second.firstTokenSeen).toBe(false);
  });
});
