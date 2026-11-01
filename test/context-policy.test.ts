import { describe, expect, test } from "bun:test";
import { addUsageTotals, diffUsageState, emptyUsageTotals } from "../src/core/context-usage.ts";
import {
  DEFAULT_CONTEXT_POLICY,
  buildCompactionSettings,
  decideCompaction,
  deriveKeepRecentTokens,
  parseContextPolicy,
  resolveContextThresholds,
  resolveEmergencyReserve,
  resolveHeuristicThreshold,
  validateContextPolicy,
  type ContextPolicy,
} from "../src/core/context-policy.ts";

describe("context usage diff", () => {
  test("usage totals 累加并包含 cost", () => {
    const totals = emptyUsageTotals();
    addUsageTotals(totals, {
      input: 10,
      output: 5,
      cacheRead: 3,
      cacheWrite: 1,
      totalTokens: 19,
      cost: { total: 0.02 },
    });
    expect(totals).toMatchObject({ input: 10, output: 5, cacheRead: 3, cacheWrite: 1, totalTokens: 19 });
    expect(totals.costUsd).toBeCloseTo(0.02);
  });

  test("UsageDoc 差分覆盖 models/tools，含压缩与工具", () => {
    const diff = diffUsageState(
      {
        models: {
          "deepseek/deepseek-chat": {
            input: 100,
            output: 10,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 110,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.1 },
          },
        },
        tools: {},
      } as any,
      {
        models: {
          "deepseek/deepseek-chat": {
            input: 250,
            output: 30,
            cacheRead: 50,
            cacheWrite: 0,
            totalTokens: 330,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 },
          },
        },
        tools: {
          bash: {
            input: 5,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 10,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
          },
        },
      } as any,
    );
    expect(diff.models["deepseek/deepseek-chat"]).toMatchObject({ input: 150, output: 20, cacheRead: 50 });
    expect(diff.tools.bash).toMatchObject({ input: 5, output: 5 });
    expect(diff.totals.input).toBe(155);
    expect(diff.totals.costUsd).toBeCloseTo(0.16);
  });

  test("相同账本差分为空", () => {
    const state = {
      models: {
        "p/m": {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
      tools: {},
    } as any;
    const diff = diffUsageState(state, state);
    expect(diff.totals.totalTokens).toBe(0);
    expect(Object.keys(diff.models)).toHaveLength(0);
  });
});

describe("context policy strategies", () => {
  const policy = structuredClone(DEFAULT_CONTEXT_POLICY);

  test("默认：全局 80% + 定时启发式 50k 回退", () => {
    expect(policy.strategies.global.percent).toBe(0.8);
    expect(policy.strategies.scheduledHeuristic.fallbackTokens).toBe(50_000);
    expect(policy.strategies.scheduledHeuristic.enabled).toBe(true);
    expect(policy.strategies.fixed.enabled).toBe(false);
    expect(policy.strategies.idle.enabled).toBe(false);

    const thresholds = resolveContextThresholds(policy, 1_000_000);
    expect(thresholds.globalThreshold).toBe(800_000);
    expect(thresholds.scheduledFallbackThreshold).toBe(50_000);
    expect(thresholds.fixedThreshold).toBe(50_000);
  });

  test("窗口未知：全局跳过，定时回退/固定阈值用绝对 tokens", () => {
    const thresholds = resolveContextThresholds(policy, 0);
    expect(thresholds.globalThreshold).toBe(0);
    expect(thresholds.scheduledFallbackThreshold).toBe(50_000);
    expect(thresholds.fixedThreshold).toBe(50_000);
  });

  test("小窗口按窗口夹住，keepRecent 不会吃掉阈值", () => {
    const reserve = resolveEmergencyReserve(policy, 20_000);
    const thresholds = resolveContextThresholds(policy, 20_000);
    expect(thresholds.scheduledFallbackThreshold).toBeLessThanOrEqual(20_000 - reserve);
    expect(thresholds.scheduledFallbackThreshold).toBeGreaterThan(
      deriveKeepRecentTokens(policy, 20_000),
    );
  });

  test("keepRecent 受已启用策略的最低阈值 40% 约束", () => {
    expect(deriveKeepRecentTokens(policy, 1_000_000)).toBe(20_000);
    expect(deriveKeepRecentTokens(policy, 200_000)).toBe(20_000);
    expect(deriveKeepRecentTokens(policy, 20_000)).toBe(2_000);
  });

  test("定时启发式：最近 N 个净增量平均值 × 倍数", () => {
    const threshold = resolveHeuristicThreshold(
      policy,
      1_000_000,
      [10_000, 21_000, 32_000, 41_000, 52_000],
    );
    // 净增量 11k, 11k, 9k, 11k → 平均 10.5k × 5 = 52.5k
    expect(threshold).toBe(52_500);
    // 历史不足或全为负增量 → 回退
    expect(resolveHeuristicThreshold(policy, 1_000_000, [])).toBe(50_000);
    expect(resolveHeuristicThreshold(policy, 1_000_000, [50_000, 40_000])).toBe(50_000);
  });

  test("策略判定优先级：全局 → 定时启发式 → 固定 → 空闲", () => {
    const p: ContextPolicy = structuredClone(DEFAULT_CONTEXT_POLICY);
    p.strategies.fixed = { enabled: true, tokens: 30_000, minTokens: 1_000, scope: "all" };
    p.strategies.idle = { enabled: true, idleHours: 24, minTokens: 1_000 };
    const now = Date.now();
    const oldTurn = now - 48 * 3_600_000;
    const recent = [10_000, 21_000, 32_000, 41_000, 52_000];

    // 全局阈值 800k：projected 900k 命中全局
    expect(
      decideCompaction(p, {
        profile: "normal",
        window: 1_000_000,
        projectedTokens: 900_000,
        recentContextTokens: recent,
        lastTurnEndedAt: oldTurn,
        now,
      })?.strategy,
    ).toBe("global");

    // 关闭全局后，定时任务命中启发式（阈值 52.5k）
    const heuristicOnly: ContextPolicy = {
      ...p,
      strategies: {
        ...p.strategies,
        global: { ...p.strategies.global, enabled: false },
        fixed: { ...p.strategies.fixed, enabled: false },
        idle: { ...p.strategies.idle, enabled: false },
      },
    };
    expect(
      decideCompaction(heuristicOnly, {
        profile: "scheduled",
        window: 1_000_000,
        projectedTokens: 60_000,
        recentContextTokens: recent,
        now,
      })?.strategy,
    ).toBe("scheduled_heuristic");
    // 普通会话不适用定时启发式
    expect(
      decideCompaction(heuristicOnly, {
        profile: "normal",
        window: 1_000_000,
        projectedTokens: 60_000,
        now,
      }),
    ).toBeNull();

    // 关闭启发式后，固定阈值命中
    const fixedOnly: ContextPolicy = {
      ...heuristicOnly,
      strategies: {
        ...heuristicOnly.strategies,
        scheduledHeuristic: { ...heuristicOnly.strategies.scheduledHeuristic, enabled: false },
        fixed: { ...heuristicOnly.strategies.fixed, enabled: true, tokens: 30_000, minTokens: 1_000, scope: "all" },
      },
    };
    expect(
      decideCompaction(fixedOnly, { profile: "normal", window: 1_000_000, projectedTokens: 40_000, now })?.strategy,
    ).toBe("fixed");

    // 只剩空闲：普通会话间隔超过 24h 且达到 minTokens
    const idleOnly: ContextPolicy = {
      ...fixedOnly,
      strategies: {
        ...fixedOnly.strategies,
        fixed: { ...fixedOnly.strategies.fixed, enabled: false },
        idle: { ...fixedOnly.strategies.idle, enabled: true, idleHours: 24, minTokens: 1_000 },
      },
    };
    expect(
      decideCompaction(idleOnly, {
        profile: "normal",
        window: 1_000_000,
        projectedTokens: 10_000,
        lastTurnEndedAt: oldTurn,
        now,
      })?.strategy,
    ).toBe("idle");
    // 空闲策略不作用于定时任务
    expect(
      decideCompaction(idleOnly, {
        profile: "scheduled",
        window: 1_000_000,
        projectedTokens: 10_000,
        lastTurnEndedAt: oldTurn,
        now,
      }),
    ).toBeNull();
  });

  test("旧配置迁移：normal → 全局百分比，scheduled → 仅定时固定 token", () => {
    const legacy = parseContextPolicy(
      JSON.stringify({
        normal: { enabled: true, percent: 0.7, minTokens: 10_000 },
        scheduled: { enabled: true, tokens: 40_000, maxPercentOfWindow: 0.6, minTokens: 2_000 },
        safetyTokens: 4_096,
      }),
    );
    expect(legacy.strategies.global).toMatchObject({ enabled: true, percent: 0.7, minTokens: 10_000 });
    expect(legacy.strategies.fixed).toMatchObject({ enabled: true, tokens: 40_000, minTokens: 2_000, scope: "scheduled" });
    expect(legacy.strategies.scheduledHeuristic.enabled).toBe(false);
    expect(legacy.strategies.idle.enabled).toBe(false);
    expect(legacy.safetyTokens).toBe(4_096);
  });

  test("harness-wide 基础 policy 显式关闭 background", () => {
    const settings = buildCompactionSettings(policy, [
      { provider: "p", id: "m", contextWindow: 0 },
      { provider: "p", id: "big", contextWindow: 1_000_000 },
    ]);
    expect(settings.enabled).toBe(true);
    expect(settings.backgroundTokens).toBe(0);
    expect((settings.modelOverrides as any)["p/m"].backgroundTokens).toBe(0);
    expect((settings.modelOverrides as any)["p/big"].backgroundTokens).toBe(0);
  });

  test("解析/校验：损坏 JSON 回退默认，非法值夹住，明细保留不能超过聚合", () => {
    expect(parseContextPolicy("{bad").strategies.global.percent).toBe(0.8);
    expect(
      parseContextPolicy(JSON.stringify({ strategies: { global: { percent: 2 }, scheduledHeuristic: { sampleSize: 1, multiplier: 100 } } }))
        .strategies.global.percent,
    ).toBe(0.95);
    const clamped = parseContextPolicy(
      JSON.stringify({ strategies: { scheduledHeuristic: { sampleSize: 1, multiplier: 100 } } }),
    );
    expect(clamped.strategies.scheduledHeuristic.sampleSize).toBe(2);
    expect(clamped.strategies.scheduledHeuristic.multiplier).toBe(20);
    expect(validateContextPolicy({ ...policy, retentionDays: 10, detailRetentionDays: 20 })).toContain("明细");
    expect(validateContextPolicy(policy)).toBeUndefined();
  });
});
