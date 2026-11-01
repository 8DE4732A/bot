import { BACKGROUND_CONTEXT, withAbortSignal, withTelemetry } from "@earendil-works/chord/context";
import { estimateContextTokens, estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import {
  LiveDoc,
  type CompactionResult,
  type Conversation,
  type Harness,
  type SettledTask,
  type TaskId,
} from "@earendil-works/pi-durable";
import { DatabaseStore, type CompactionEventRecord, type CompactionStatus, type CompactionTrigger } from "../config/database-store.ts";
import {
  decideCompaction,
  deriveKeepRecentTokens,
  type ContextPolicy,
} from "./context-policy.ts";
import { diffUsageState, emptyUsageDiff, snapshotUsage } from "./context-usage.ts";
import { logger } from "../utils/logger.ts";
import type { ContextTelemetry } from "./context-telemetry.ts";

export type CompactionProfile = "normal" | "scheduled" | "manual";

export interface CompactionDeps {
  harness: Harness;
  conversation: Conversation;
  conversationId: string;
  agentId?: string;
  sessionId?: string;
  policy: ContextPolicy;
  profile: CompactionProfile;
  trigger: CompactionTrigger;
  /** 当前模型上下文窗口（0 = 未知） */
  contextWindow: number;
  /** 本轮新消息估算（pre-turn 用） */
  incomingTokens?: number;
  instructions?: string;
  signal?: AbortSignal;
  telemetry?: ContextTelemetry;
  store?: DatabaseStore;
}

export interface CompactionOutcome {
  status: CompactionStatus;
  compacted: boolean;
  trigger: CompactionTrigger;
  profile: CompactionProfile;
  threshold?: number;
  beforeTokens?: number;
  afterTokens?: number;
  beforeEstimateTokens?: number;
  afterEstimateTokens?: number;
  beforeEntries?: number;
  afterEntries?: number;
  durationMs: number;
  costUsd?: number;
  requestCount: number;
  taskId?: string;
  traceId?: string;
  failOpen: boolean;
  error?: string;
}

const TIMEOUT = { timeout: true } as const;

function isTimeout(value: unknown): value is typeof TIMEOUT {
  return value === TIMEOUT;
}

async function raceTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | typeof TIMEOUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<typeof TIMEOUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForIdleBounded(harness: Harness, conversation: Conversation, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const live = await harness.snapshot(LiveDoc, conversation.id, BACKGROUND_CONTEXT);
      const busy =
        Boolean(live?.run) ||
        Boolean(live?.generation) ||
        (live?.tools?.length ?? 0) > 0 ||
        (live?.compactions?.length ?? 0) > 0;
      if (!busy) return true;
    } catch {
      return false;
    }
    if (Date.now() >= deadline) return false;
    await sleep(50);
  }
}

function loadPreTurnHistory(
  store: DatabaseStore,
  conversationId: string,
  policy: ContextPolicy,
  profile: "normal" | "scheduled",
): { recentContextTokens: number[]; lastTurnEndedAt?: number } {
  const s = policy.strategies;
  const needsHeuristic = profile === "scheduled" && s.scheduledHeuristic.enabled;
  const needsIdle = profile === "normal" && s.idle.enabled;
  if (!needsHeuristic && !needsIdle) return { recentContextTokens: [] };
  const limit = needsHeuristic ? Math.max(2, s.scheduledHeuristic.sampleSize) : 1;
  try {
    const turns = store.listLlmTurns(conversationId, limit, 0).reverse();
    const recentContextTokens = turns
      .map((turn) => turn.contextTokens)
      .filter((value): value is number => typeof value === "number" && value > 0);
    const latest = turns[turns.length - 1];
    return {
      recentContextTokens,
      lastTurnEndedAt: latest
        ? latest.endedAt ?? latest.startedAt + (latest.durationMs ?? 0)
        : undefined,
    };
  } catch (err) {
    logger.debug("ContextCompaction", `Failed to load recent turns for ${conversationId}: ${err}`);
    return { recentContextTokens: [] };
  }
}

/** 读取当前上下文并估算 token（与框架 estimateContext 同源）。 */
export async function estimateConversationTokens(
  conversation: Conversation,
): Promise<{ tokens: number; entries: number; headId?: string }> {
  const view = await conversation.context(BACKGROUND_CONTEXT);
  const estimate = estimateContextTokens(view.messages);
  return { tokens: estimate.tokens, entries: view.entries.length, headId: view.head?.id !== undefined ? String(view.head.id) : undefined };
}

/**
 * 前置压缩判定：多策略叠加（全局 → 定时启发式 → 固定 → 空闲），
 * 命中即压缩；未命中返回 null（不记录事件，避免噪声）。
 * 会话必须在 session lock 内调用；仍会用 LiveDoc 做有界 idle 检查。
 */
export async function maybeCompactBeforeTurn(deps: CompactionDeps): Promise<CompactionOutcome | null> {
  const profile = deps.profile === "manual" ? "normal" : deps.profile;
  const s = deps.policy.strategies;
  const anyEnabled =
    s.global.enabled ||
    s.fixed.enabled ||
    (profile === "scheduled" && s.scheduledHeuristic.enabled) ||
    (profile === "normal" && s.idle.enabled);
  if (!anyEnabled) return null;

  const store = deps.store ?? new DatabaseStore();
  const history = loadPreTurnHistory(store, deps.conversationId, deps.policy, profile);

  // 先估算再等 idle：绝大多数低于阈值的轮次不需要 LiveDoc 快照。
  const before = await estimateConversationTokens(deps.conversation);
  const projected = before.tokens + (deps.incomingTokens ?? 0) + deps.policy.safetyTokens;
  const decision = decideCompaction(deps.policy, {
    profile,
    window: deps.contextWindow,
    projectedTokens: projected,
    recentContextTokens: history.recentContextTokens,
    lastTurnEndedAt: history.lastTurnEndedAt,
    now: Date.now(),
  });
  if (!decision) return null;

  const idle = await waitForIdleBounded(deps.harness, deps.conversation, deps.policy.settleTimeoutMs);
  if (!idle) {
    logger.warn("ContextCompaction", `Conversation ${deps.conversationId} not idle before pre-turn check; skipping`);
    return null;
  }

  return runCompaction({ ...deps, trigger: decision.trigger, thresholdTokens: decision.thresholdTokens, before } as CompactionDeps & {
    thresholdTokens: number;
    before: Awaited<ReturnType<typeof estimateConversationTokens>>;
  });
}

async function runCompaction(
  deps: CompactionDeps & {
    thresholdTokens?: number;
    before?: Awaited<ReturnType<typeof estimateConversationTokens>>;
  },
): Promise<CompactionOutcome> {
  const store = deps.store ?? new DatabaseStore();
  const telemetry = deps.telemetry;
  const compactionId = crypto.randomUUID();
  const startedAt = Date.now();
  const before = deps.before ?? (await estimateConversationTokens(deps.conversation));
  const usageBefore = await snapshotUsage(deps.harness, deps.conversation.id);
  const ctx = deps.signal ? withAbortSignal(deps.signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT;
  telemetry?.beginCompaction(deps.conversationId, compactionId);

  let taskId: TaskId<CompactionResult> | undefined;
  let traceId: string | undefined;
  let settled: SettledTask<CompactionResult> | typeof TIMEOUT | undefined;
  let error: string | undefined;
  let status: CompactionStatus = "failed";

  try {
    const execute = async (span?: Parameters<typeof withTelemetry>[0]) => {
      const compactCtx = span ? withTelemetry(span, ctx) : ctx;
      taskId = await deps.conversation.compact(deps.instructions, compactCtx);
      settled = await raceTimeout(deps.harness.waitForTask(taskId, ctx), deps.policy.timeoutMs);
    };

    if (telemetry) {
      await telemetry.startSpan(
        {
          name: "bot.compaction",
          attributes: {
            "conversation.id": deps.conversationId,
            "bot.compaction.id": compactionId,
            trigger: deps.trigger,
            profile: deps.profile,
          },
        },
        async (span) => {
          traceId = telemetry.traceForCompaction?.(compactionId);
          await execute(span);
        },
      );
    } else {
      await execute();
    }
    traceId = traceId ?? telemetry?.traceForCompaction?.(compactionId);

    if (isTimeout(settled)) {
      status = "timeout";
      error = `compaction timed out after ${deps.policy.timeoutMs}ms`;
      if (taskId) await deps.harness.abortTask(taskId, BACKGROUND_CONTEXT).catch(() => {});
      await waitForIdleBounded(deps.harness, deps.conversation, deps.policy.settleTimeoutMs);
    } else if (settled) {
      const outcome = settled.state.outcome;
      if (outcome.status === "completed") {
        const result = outcome.result;
        if (result?.entryId !== undefined || result?.submissionId !== undefined) {
          status = "done";
        } else {
          status = "skipped";
        }
      } else if (outcome.status === "aborted") {
        status = "aborted";
        error = outcome.reason;
      } else {
        status = "failed";
        error = outcome.status === "failed" || outcome.status === "faulted"
          ? outcome.error?.message
          : outcome.reason;
      }
    }
  } catch (err) {
    if (deps.signal?.aborted) {
      status = "aborted";
      error = "cancelled";
    } else {
      status = "failed";
      error = err instanceof Error ? err.message : String(err);
    }
    if (taskId) await deps.harness.abortTask(taskId, BACKGROUND_CONTEXT).catch(() => {});
  } finally {
    telemetry?.endCompaction(deps.conversationId, compactionId);
  }

  // 等摘要 write submission 落盘（idle 时通常已生效；busy 时在下一边界）
  const settledIdle = await waitForIdleBounded(
    deps.harness,
    deps.conversation,
    deps.policy.settleTimeoutMs,
  ).catch(() => false);
  if (!settledIdle && status === "done") {
    // 摘要任务已完成但 write submission 仍未落盘：不能把它当作成功压缩
    status = "timeout";
    error = "compaction summary did not settle before the timeout";
  }

  const after = await estimateConversationTokens(deps.conversation).catch(() => ({
    tokens: before.tokens,
    entries: before.entries,
    headId: before.headId,
  }));
  const headChanged = before.headId !== after.headId;
  const entriesReduced = after.entries < before.entries;
  const compacted = status === "done" && (headChanged || entriesReduced);
  if (status === "done" && !compacted) status = "skipped";

  const usageAfter = await snapshotUsage(deps.harness, deps.conversation.id);
  const diff = usageBefore && usageAfter
    ? diffUsageState(usageBefore, usageAfter)
    : emptyUsageDiff();
  await telemetry?.flush().catch(() => {});

  const durationMs = Date.now() - startedAt;
  const failOpen = status === "failed" || status === "timeout" || status === "aborted";
  const record: CompactionEventRecord = {
    conversationId: deps.conversationId,
    agentId: deps.agentId,
    sessionId: deps.sessionId,
    taskId: taskId !== undefined ? String(taskId) : undefined,
    traceId,
    compactionId,
    profile: deps.profile,
    trigger: deps.trigger,
    thresholdTokens: deps.thresholdTokens,
    keepRecentTokens: deriveKeepRecentTokens(deps.policy, deps.contextWindow),
    beforeTokens: before.tokens,
    afterTokens: after.tokens,
    beforeEstimateTokens: before.tokens,
    afterEstimateTokens: after.tokens,
    beforeEntries: before.entries,
    afterEntries: after.entries,
    startedAt,
    endedAt: Date.now(),
    durationMs,
    costUsd: diff.totals.costUsd,
    costInTurn: false,
    requestCount: store.countLlmRequestsByCompaction(compactionId),
    status,
    failOpen,
    error: error?.slice(0, 500),
  };
  try {
    store.insertCompactionEvent(record);
  } catch (err) {
    logger.warn("ContextCompaction", `Failed to record compaction event: ${err}`);
  }
  if (failOpen) {
    try {
      store.recordAudit("context.compact_failed", {
        conversationId: deps.conversationId,
        trigger: deps.trigger,
        status,
        error: error?.slice(0, 500),
      }, deps.agentId);
    } catch {
      /* audit best effort */
    }
  }

  return {
    status,
    compacted,
    trigger: deps.trigger,
    profile: deps.profile,
    threshold: deps.thresholdTokens,
    beforeTokens: before.tokens,
    afterTokens: after.tokens,
    beforeEstimateTokens: before.tokens,
    afterEstimateTokens: after.tokens,
    beforeEntries: before.entries,
    afterEntries: after.entries,
    durationMs,
    costUsd: diff.totals.costUsd,
    requestCount: store.countLlmRequestsByCompaction(compactionId),
    taskId: taskId !== undefined ? String(taskId) : undefined,
    traceId,
    failOpen,
    error,
  };
}

/** 手动压缩（/compact 与管理台）：不受 enabled 限制，总是尝试。 */
export async function compactConversationNow(
  deps: Omit<CompactionDeps, "profile" | "trigger"> & {
    profile?: CompactionProfile;
    trigger?: CompactionTrigger;
  },
): Promise<CompactionOutcome> {
  return runCompaction({
    ...deps,
    profile: deps.profile ?? "manual",
    trigger: deps.trigger ?? "manual",
    thresholdTokens: undefined,
  });
}

/** pre-turn 估算用：新消息 token 估算（与框架同一估算器）。 */
export function estimateIncomingTokens(text: string): number {
  return estimateMessageTokens({ role: "user", content: text, timestamp: Date.now() });
}
