import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { UsageDoc, type Harness, type UsageState } from "@earendil-works/pi-durable";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { Usage } from "@earendil-works/pi-ai";

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  totalTokens: number;
  costUsd: number;
}

export interface UsageDiff {
  totals: UsageTotals;
  models: Record<string, UsageTotals>;
  tools: Record<string, UsageTotals>;
}

export function emptyUsageDiff(): UsageDiff {
  return { totals: emptyUsageTotals(), models: {}, tools: {} };
}

export function emptyUsageTotals(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, costUsd: 0 };
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function addUsageTotals(target: UsageTotals, usage: Partial<Usage> | undefined): UsageTotals {
  if (!usage) return target;
  target.input += num(usage.input);
  target.output += num(usage.output);
  target.cacheRead += num(usage.cacheRead);
  target.cacheWrite += num(usage.cacheWrite);
  target.reasoning += num(usage.reasoning);
  target.totalTokens += num(usage.totalTokens) || num(usage.input) + num(usage.output) + num(usage.cacheRead) + num(usage.cacheWrite);
  target.costUsd += num(usage.cost?.total);
  return target;
}

function totalsFrom(usage: Partial<Usage> | undefined): UsageTotals {
  return addUsageTotals(emptyUsageTotals(), usage);
}

function subtractTotals(after: UsageTotals, before: UsageTotals): UsageTotals {
  return {
    input: Math.max(0, after.input - before.input),
    output: Math.max(0, after.output - before.output),
    cacheRead: Math.max(0, after.cacheRead - before.cacheRead),
    cacheWrite: Math.max(0, after.cacheWrite - before.cacheWrite),
    reasoning: Math.max(0, after.reasoning - before.reasoning),
    totalTokens: Math.max(0, after.totalTokens - before.totalTokens),
    costUsd: Math.max(0, after.costUsd - before.costUsd),
  };
}

function hasUsage(totals: UsageTotals): boolean {
  return (
    totals.input > 0 ||
    totals.output > 0 ||
    totals.cacheRead > 0 ||
    totals.cacheWrite > 0 ||
    totals.totalTokens > 0 ||
    totals.costUsd > 0
  );
}

function sumTotals(target: UsageTotals, source: UsageTotals): void {
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.reasoning += source.reasoning;
  target.totalTokens += source.totalTokens;
  target.costUsd += source.costUsd;
}

/** UsageDoc 是两个累计账本；turn 成本 = after - before（含压缩摘要与工具内部调用）。 */
export function diffUsageState(before: UsageState | undefined, after: UsageState | undefined): UsageDiff {
  const totals = emptyUsageTotals();
  const models: Record<string, UsageTotals> = {};
  const tools: Record<string, UsageTotals> = {};
  const buckets: Array<["models" | "tools", Record<string, UsageTotals>]> = [
    ["models", models],
    ["tools", tools],
  ];
  for (const [bucket, target] of buckets) {
    const afterBucket = (after?.[bucket] ?? {}) as Record<string, Partial<Usage>>;
    const beforeBucket = (before?.[bucket] ?? {}) as Record<string, Partial<Usage>>;
    const keys = new Set([...Object.keys(afterBucket), ...Object.keys(beforeBucket)]);
    for (const key of keys) {
      const delta = subtractTotals(totalsFrom(afterBucket[key]), totalsFrom(beforeBucket[key]));
      if (!hasUsage(delta)) continue;
      target[key] = delta;
      sumTotals(totals, delta);
    }
  }
  return { totals, models, tools };
}

export async function snapshotUsage(
  harness: Harness,
  conversationId: ConversationId,
): Promise<UsageState | undefined> {
  try {
    return await harness.snapshot(UsageDoc, conversationId, BACKGROUND_CONTEXT);
  } catch {
    return undefined;
  }
}
