import type { CompactionSettings } from "@earendil-works/pi-durable";
import { DatabaseStore } from "../config/database-store.ts";

export const CONTEXT_POLICY_KEY = "context_policy";

export type ContextSessionProfile = "normal" | "scheduled";
export type StrategyScope = "all" | "normal" | "scheduled";
export type CompactionStrategy = "global" | "scheduled_heuristic" | "fixed" | "idle";
export type AutoCompactionTrigger =
  | "pre_turn_global"
  | "pre_turn_scheduled"
  | "pre_turn_fixed"
  | "pre_turn_idle";

/** 1. 全局百分比：所有会话的硬上限，优先级最高。 */
export interface GlobalStrategy {
  enabled: boolean;
  /** 窗口比例（0.05..0.95） */
  percent: number;
  /** 低于该 token 数不压缩 */
  minTokens: number;
}

/** 2. 定时任务启发式：最近 N 次 run 的 context 净增量平均值 × 倍数。 */
export interface ScheduledHeuristicStrategy {
  enabled: boolean;
  /** 采样最近 N 次 run（N 个 context_tokens 点 → N-1 个净增量） */
  sampleSize: number;
  multiplier: number;
  /** 历史不足时的回退阈值 */
  fallbackTokens: number;
  minTokens: number;
  /** 同时不超过窗口的该比例 */
  maxPercentOfWindow: number;
}

/** 3. 固定 token 上限：窗口未知或明确预算时的兜底。 */
export interface FixedStrategy {
  enabled: boolean;
  tokens: number;
  minTokens: number;
  scope: StrategyScope;
}

/** 4. 空闲超时：普通会话上一轮结束超过指定时长后，本轮开始前先压缩。 */
export interface IdleStrategy {
  enabled: boolean;
  idleHours: number;
  minTokens: number;
}

export interface ContextStrategies {
  global: GlobalStrategy;
  scheduledHeuristic: ScheduledHeuristicStrategy;
  fixed: FixedStrategy;
  idle: IdleStrategy;
}

export interface ContextPolicy {
  strategies: ContextStrategies;
  /** 估算安全垫（system prompt/tool schema 等缺口） */
  safetyTokens: number;
  /** keepRecent 上限（框架全局值） */
  keepRecentCapTokens: number;
  /** 紧急兜底 reserve 上限 */
  emergencyReserveCapTokens: number;
  /** 前置压缩等待上限 */
  timeoutMs: number;
  /** 压缩后等待 idle 的上限 */
  settleTimeoutMs: number;
  /** turn/压缩聚合保留天数 */
  retentionDays: number;
  /** 请求/工具明细保留天数 */
  detailRetentionDays: number;
}

export const DEFAULT_CONTEXT_POLICY: ContextPolicy = {
  strategies: {
    global: { enabled: true, percent: 0.8, minTokens: 20_000 },
    scheduledHeuristic: {
      enabled: true,
      sampleSize: 5,
      multiplier: 5,
      fallbackTokens: 50_000,
      minTokens: 5_000,
      maxPercentOfWindow: 0.8,
    },
    fixed: { enabled: false, tokens: 50_000, minTokens: 5_000, scope: "all" },
    idle: { enabled: false, idleHours: 24, minTokens: 8_000 },
  },
  safetyTokens: 8_192,
  keepRecentCapTokens: 32_768,
  emergencyReserveCapTokens: 32_768,
  timeoutMs: 90_000,
  settleTimeoutMs: 5_000,
  retentionDays: 90,
  detailRetentionDays: 30,
};

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function intOr(value: unknown, fallback: number, min: number, max: number): number {
  return clamp(Math.floor(numberOr(value, fallback)), min, max);
}

function scopeOr(value: unknown, fallback: StrategyScope): StrategyScope {
  return value === "all" || value === "normal" || value === "scheduled" ? value : fallback;
}

/** 宽松解析：缺字段用默认值，非法值忽略；绝不因配置损坏阻塞启动。 */
export function parseContextPolicy(raw: string | undefined | null): ContextPolicy {
  if (!raw) return structuredClone(DEFAULT_CONTEXT_POLICY);
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return structuredClone(DEFAULT_CONTEXT_POLICY);
  }
  if (!parsed || typeof parsed !== "object") return structuredClone(DEFAULT_CONTEXT_POLICY);

  const defaults = DEFAULT_CONTEXT_POLICY.strategies;
  const rawStrategies =
    parsed.strategies && typeof parsed.strategies === "object" && !Array.isArray(parsed.strategies)
      ? parsed.strategies
      : undefined;

  let strategies: ContextStrategies;
  if (rawStrategies) {
    const global = rawStrategies.global ?? {};
    const heuristic = rawStrategies.scheduledHeuristic ?? {};
    const fixed = rawStrategies.fixed ?? {};
    const idle = rawStrategies.idle ?? {};
    strategies = {
      global: {
        enabled: boolOr(global.enabled, defaults.global.enabled),
        percent: clamp(numberOr(global.percent, defaults.global.percent), 0.05, 0.95),
        minTokens: Math.max(0, Math.floor(numberOr(global.minTokens, defaults.global.minTokens))),
      },
      scheduledHeuristic: {
        enabled: boolOr(heuristic.enabled, defaults.scheduledHeuristic.enabled),
        sampleSize: intOr(heuristic.sampleSize, defaults.scheduledHeuristic.sampleSize, 2, 20),
        multiplier: clamp(numberOr(heuristic.multiplier, defaults.scheduledHeuristic.multiplier), 1, 20),
        fallbackTokens: Math.max(
          1_024,
          Math.floor(numberOr(heuristic.fallbackTokens, defaults.scheduledHeuristic.fallbackTokens)),
        ),
        minTokens: Math.max(0, Math.floor(numberOr(heuristic.minTokens, defaults.scheduledHeuristic.minTokens))),
        maxPercentOfWindow: clamp(
          numberOr(heuristic.maxPercentOfWindow, defaults.scheduledHeuristic.maxPercentOfWindow),
          0.05,
          0.95,
        ),
      },
      fixed: {
        enabled: boolOr(fixed.enabled, defaults.fixed.enabled),
        tokens: Math.max(1_024, Math.floor(numberOr(fixed.tokens, defaults.fixed.tokens))),
        minTokens: Math.max(0, Math.floor(numberOr(fixed.minTokens, defaults.fixed.minTokens))),
        scope: scopeOr(fixed.scope, defaults.fixed.scope),
      },
      idle: {
        enabled: boolOr(idle.enabled, defaults.idle.enabled),
        idleHours: clamp(Math.floor(numberOr(idle.idleHours, defaults.idle.idleHours)), 1, 8_760),
        minTokens: Math.max(0, Math.floor(numberOr(idle.minTokens, defaults.idle.minTokens))),
      },
    };
  } else {
    // 旧配置（normal/scheduled 两套固定阈值）→ 保持原有行为：
    // normal 映射为全局百分比；scheduled 映射为仅定时任务的固定 token 策略。
    const normal = parsed.normal ?? {};
    const scheduled = parsed.scheduled ?? {};
    const scheduledTokens = Math.max(1_024, Math.floor(numberOr(scheduled.tokens, 50_000)));
    const scheduledMin = Math.max(0, Math.floor(numberOr(scheduled.minTokens, 5_000)));
    strategies = {
      global: {
        enabled: boolOr(normal.enabled, true),
        percent: clamp(numberOr(normal.percent, 0.8), 0.05, 0.95),
        minTokens: Math.max(0, Math.floor(numberOr(normal.minTokens, 20_000))),
      },
      scheduledHeuristic: {
        enabled: false,
        sampleSize: defaults.scheduledHeuristic.sampleSize,
        multiplier: defaults.scheduledHeuristic.multiplier,
        fallbackTokens: scheduledTokens,
        minTokens: scheduledMin,
        maxPercentOfWindow: clamp(numberOr(scheduled.maxPercentOfWindow, 0.8), 0.05, 0.95),
      },
      fixed: {
        enabled: boolOr(scheduled.enabled, false),
        tokens: scheduledTokens,
        minTokens: scheduledMin,
        scope: "scheduled",
      },
      idle: { enabled: false, idleHours: 24, minTokens: 8_000 },
    };
  }

  return {
    strategies,
    safetyTokens: Math.max(0, Math.floor(numberOr(parsed.safetyTokens, DEFAULT_CONTEXT_POLICY.safetyTokens))),
    keepRecentCapTokens: Math.max(
      1_024,
      Math.floor(numberOr(parsed.keepRecentCapTokens, DEFAULT_CONTEXT_POLICY.keepRecentCapTokens)),
    ),
    emergencyReserveCapTokens: Math.max(
      1_024,
      Math.floor(numberOr(parsed.emergencyReserveCapTokens, DEFAULT_CONTEXT_POLICY.emergencyReserveCapTokens)),
    ),
    timeoutMs: clamp(Math.floor(numberOr(parsed.timeoutMs, DEFAULT_CONTEXT_POLICY.timeoutMs)), 5_000, 600_000),
    settleTimeoutMs: clamp(
      Math.floor(numberOr(parsed.settleTimeoutMs, DEFAULT_CONTEXT_POLICY.settleTimeoutMs)),
      500,
      60_000,
    ),
    retentionDays: clamp(Math.floor(numberOr(parsed.retentionDays, DEFAULT_CONTEXT_POLICY.retentionDays)), 1, 3_650),
    detailRetentionDays: clamp(
      Math.floor(numberOr(parsed.detailRetentionDays, DEFAULT_CONTEXT_POLICY.detailRetentionDays)),
      1,
      3_650,
    ),
  };
}

export function validateContextPolicy(policy: ContextPolicy): string | undefined {
  const s = policy.strategies;
  if (!Number.isFinite(s.global.percent) || s.global.percent <= 0 || s.global.percent > 1) {
    return "全局百分比阈值必须在 (0, 1] 之间";
  }
  if (!Number.isInteger(s.scheduledHeuristic.sampleSize) || s.scheduledHeuristic.sampleSize < 2 || s.scheduledHeuristic.sampleSize > 20) {
    return "定时任务采样次数必须在 2..20 之间";
  }
  if (!Number.isFinite(s.scheduledHeuristic.multiplier) || s.scheduledHeuristic.multiplier < 1 || s.scheduledHeuristic.multiplier > 20) {
    return "定时任务倍数必须在 1..20 之间";
  }
  if (s.scheduledHeuristic.fallbackTokens < 1_024) {
    return "定时任务无历史回退阈值至少 1024 tokens";
  }
  if (
    !Number.isFinite(s.scheduledHeuristic.maxPercentOfWindow) ||
    s.scheduledHeuristic.maxPercentOfWindow <= 0 ||
    s.scheduledHeuristic.maxPercentOfWindow > 1
  ) {
    return "定时任务窗口比例必须在 (0, 1] 之间";
  }
  if (s.fixed.tokens < 1_024) {
    return "固定 token 阈值至少 1024 tokens";
  }
  if (s.fixed.scope !== "all" && s.fixed.scope !== "normal" && s.fixed.scope !== "scheduled") {
    return "固定 token 作用范围不合法";
  }
  if (!Number.isFinite(s.idle.idleHours) || s.idle.idleHours < 1 || s.idle.idleHours > 8_760) {
    return "空闲时长必须在 1..8760 小时之间";
  }
  if (policy.detailRetentionDays > policy.retentionDays) {
    return "明细保留天数不能超过聚合保留天数";
  }
  if (policy.timeoutMs < 5_000 || policy.timeoutMs > 600_000) {
    return "压缩超时必须在 5s..600s 之间";
  }
  return undefined;
}

export function loadContextPolicy(store = new DatabaseStore()): ContextPolicy {
  return parseContextPolicy(store.getConfig(CONTEXT_POLICY_KEY, ""));
}

export function saveContextPolicy(policy: ContextPolicy, store = new DatabaseStore()): void {
  store.setConfig(CONTEXT_POLICY_KEY, JSON.stringify(policy));
}

/** 紧急兜底预留：窗口的 5%，限制在 [2k, cap]；窗口未知用默认 16k。 */
export function resolveEmergencyReserve(policy: ContextPolicy, window: number): number {
  if (!Number.isFinite(window) || window <= 0) return Math.min(16_384, policy.emergencyReserveCapTokens);
  return clamp(Math.floor(window * 0.05), 2_048, policy.emergencyReserveCapTokens);
}

function scopeApplies(scope: StrategyScope, profile: ContextSessionProfile): boolean {
  return scope === "all" || scope === profile;
}

/**
 * keepRecent 是框架全局值；用所有已启用策略里最低的阈值约束它，
 * 保证任何策略触发时都还能选出 cut。
 */
export function deriveKeepRecentTokens(policy: ContextPolicy, window: number): number {
  const s = policy.strategies;
  const candidates: number[] = [];
  if (s.global.enabled && Number.isFinite(window) && window > 0) {
    candidates.push(Math.floor(window * s.global.percent));
  }
  if (s.scheduledHeuristic.enabled) {
    candidates.push(
      Number.isFinite(window) && window > 0
        ? Math.min(s.scheduledHeuristic.fallbackTokens, Math.floor(window * s.scheduledHeuristic.maxPercentOfWindow))
        : s.scheduledHeuristic.fallbackTokens,
    );
  }
  if (s.fixed.enabled) {
    candidates.push(s.fixed.tokens);
  }
  const minThreshold = candidates.length > 0 ? Math.min(...candidates) : undefined;
  const byThreshold = minThreshold !== undefined ? Math.floor(minThreshold * 0.4) : 16_384;
  const byWindow = Number.isFinite(window) && window > 0 ? Math.floor(window * 0.1) : 16_384;
  return Math.max(1_024, Math.min(byThreshold, byWindow, policy.keepRecentCapTokens));
}

function finalizeThreshold(
  policy: ContextPolicy,
  raw: number,
  window: number,
  reserve: number,
  minTokens: number,
): number {
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  let threshold = Math.max(raw, minTokens);
  if (Number.isFinite(window) && window > 0) {
    threshold = Math.min(threshold, window - reserve);
  }
  // 必须比 keepRecent 大出可切分空间，否则框架 selectCut 永远返回 undefined
  threshold = Math.max(threshold, deriveKeepRecentTokens(policy, window) + 1_024);
  return threshold > 0 ? Math.floor(threshold) : 0;
}

export interface ResolvedThresholds {
  reserve: number;
  keepRecent: number;
  /** 全局百分比阈值（窗口未知为 0） */
  globalThreshold: number;
  /** 定时任务启发式：无历史时的回退阈值 */
  scheduledFallbackThreshold: number;
  /** 固定 token 阈值 */
  fixedThreshold: number;
  idleHours: number;
}

/** 静态阈值（管理台预览 / 判定共用；启发式动态值单独计算）。 */
export function resolveContextThresholds(policy: ContextPolicy, window: number): ResolvedThresholds {
  const s = policy.strategies;
  const reserve = resolveEmergencyReserve(policy, window);
  const globalRaw = Number.isFinite(window) && window > 0 ? Math.floor(window * s.global.percent) : 0;
  const heuristicRaw =
    Number.isFinite(window) && window > 0
      ? Math.min(s.scheduledHeuristic.fallbackTokens, Math.floor(window * s.scheduledHeuristic.maxPercentOfWindow))
      : s.scheduledHeuristic.fallbackTokens;
  return {
    reserve,
    keepRecent: deriveKeepRecentTokens(policy, window),
    globalThreshold: finalizeThreshold(policy, globalRaw, window, reserve, s.global.minTokens),
    scheduledFallbackThreshold: finalizeThreshold(
      policy,
      heuristicRaw,
      window,
      reserve,
      s.scheduledHeuristic.minTokens,
    ),
    fixedThreshold: finalizeThreshold(policy, s.fixed.tokens, window, reserve, s.fixed.minTokens),
    idleHours: s.idle.idleHours,
  };
}

/**
 * 定时任务启发式阈值：最近 N 个 context_tokens 点的正净增量平均值 × 倍数；
 * 历史不足或全为负增量时回退到 fallbackTokens。
 */
export function resolveHeuristicThreshold(
  policy: ContextPolicy,
  window: number,
  recentContextTokens: number[],
): number {
  const s = policy.strategies.scheduledHeuristic;
  const values = recentContextTokens
    .filter((value) => Number.isFinite(value) && value > 0)
    .slice(-Math.max(2, s.sampleSize));
  const deltas: number[] = [];
  for (let i = 1; i < values.length; i++) {
    const delta = values[i]! - values[i - 1]!;
    if (delta > 0) deltas.push(delta);
  }
  const raw =
    deltas.length > 0
      ? Math.floor((deltas.reduce((sum, delta) => sum + delta, 0) / deltas.length) * s.multiplier)
      : s.fallbackTokens;
  const reserve = resolveEmergencyReserve(policy, window);
  return finalizeThreshold(policy, raw, window, reserve, s.minTokens);
}

export interface CompactionDecisionInput {
  profile: ContextSessionProfile;
  window: number;
  /** 当前上下文 + 本轮新消息 + 安全垫 */
  projectedTokens: number;
  /** 按时序排列的最近 context_tokens（旧 → 新） */
  recentContextTokens?: number[];
  /** 上一轮结束时间（空闲策略用） */
  lastTurnEndedAt?: number;
  now?: number;
}

export interface CompactionDecision {
  strategy: CompactionStrategy;
  trigger: AutoCompactionTrigger;
  thresholdTokens: number;
}

/** 多策略叠加，按 全局 → 定时启发式 → 固定 token → 空闲 的顺序判定。 */
export function decideCompaction(
  policy: ContextPolicy,
  input: CompactionDecisionInput,
): CompactionDecision | null {
  const s = policy.strategies;
  const thresholds = resolveContextThresholds(policy, input.window);

  if (s.global.enabled && thresholds.globalThreshold > 0 && input.projectedTokens >= thresholds.globalThreshold) {
    return { strategy: "global", trigger: "pre_turn_global", thresholdTokens: thresholds.globalThreshold };
  }

  if (input.profile === "scheduled" && s.scheduledHeuristic.enabled) {
    const threshold = resolveHeuristicThreshold(policy, input.window, input.recentContextTokens ?? []);
    if (threshold > 0 && input.projectedTokens >= threshold) {
      return {
        strategy: "scheduled_heuristic",
        trigger: "pre_turn_scheduled",
        thresholdTokens: threshold,
      };
    }
  }

  if (
    s.fixed.enabled &&
    scopeApplies(s.fixed.scope, input.profile) &&
    thresholds.fixedThreshold > 0 &&
    input.projectedTokens >= thresholds.fixedThreshold
  ) {
    return { strategy: "fixed", trigger: "pre_turn_fixed", thresholdTokens: thresholds.fixedThreshold };
  }

  if (s.idle.enabled && input.profile === "normal" && input.lastTurnEndedAt !== undefined) {
    const gapMs = (input.now ?? Date.now()) - input.lastTurnEndedAt;
    if (gapMs >= s.idle.idleHours * 3_600_000 && input.projectedTokens >= s.idle.minTokens) {
      return { strategy: "idle", trigger: "pre_turn_idle", thresholdTokens: s.idle.minTokens };
    }
  }

  return null;
}

/** 构造 HarnessSettings.compaction：harness-wide 基础值 + per-model override。 */
export function buildCompactionSettings(
  policy: ContextPolicy,
  models: { provider: string; id: string; contextWindow: number }[],
): CompactionSettings {
  const baseKeepRecent = deriveKeepRecentTokens(policy, 0);
  const overrides: Record<string, { reserveTokens: number; keepRecentTokens: number; backgroundTokens: number }> = {};
  for (const model of models) {
    const window = Number(model.contextWindow);
    const keepRecent = deriveKeepRecentTokens(policy, window);
    overrides[`${model.provider}/${model.id}`] = {
      reserveTokens: resolveEmergencyReserve(policy, window),
      keepRecentTokens: keepRecent,
      backgroundTokens: 0,
    };
  }
  return {
    // 关键：即使模型窗口未知也必须显式关闭 background，否则落回框架默认 32768
    enabled: true,
    reserveTokens: Math.min(16_384, policy.emergencyReserveCapTokens),
    keepRecentTokens: baseKeepRecent,
    backgroundTokens: 0,
    modelOverrides: overrides,
  };
}
