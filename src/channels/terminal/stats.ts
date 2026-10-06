import type { TurnUsage } from "../../core/agent-manager.ts";

/**
 * 终端可观测性渲染 (纯函数): 对齐 pi coding-agent footer 的统计语义——
 * ↑input ↓output R cacheRead W cacheWrite · CH 缓存命中率 · ctx 上下文占比 · $cost · 耗时。
 */

export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

const DIM = "\x1b[90m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

/** 上下文占比分级色: <50% 青, <80% 黄, 其余红 */
export function ctxColor(percent: number): string {
  if (percent < 50) return CYAN;
  if (percent < 80) return YELLOW;
  return RED;
}

/** 一轮对话结束后的统计行 (打印在回复下方) */
export function renderTurnStats(u: TurnUsage): string {
  const parts: string[] = [];
  parts.push(`${DIM}↑${formatTokens(u.input)} ↓${formatTokens(u.output)}${RESET}`);
  if (u.cacheRead > 0) parts.push(`${DIM}R${formatTokens(u.cacheRead)}${RESET}`);
  if (u.cacheWrite > 0) parts.push(`${DIM}W${formatTokens(u.cacheWrite)}${RESET}`);
  if (u.cacheHitRate !== undefined) {
    const rateColor = u.cacheHitRate >= 80 ? GREEN : u.cacheHitRate >= 50 ? YELLOW : RED;
    parts.push(`${DIM}CH${RESET}${rateColor}${u.cacheHitRate.toFixed(1)}%${RESET}`);
  }
  if (u.reasoning && u.reasoning > 0) parts.push(`${DIM}think ${formatTokens(u.reasoning)}${RESET}`);
  if (u.contextWindow > 0) {
    const percent = (u.contextTokens / u.contextWindow) * 100;
    const c = ctxColor(percent);
    parts.push(`${DIM}ctx ${RESET}${c}${formatTokens(u.contextTokens)}/${formatTokens(u.contextWindow)} (${percent.toFixed(1)}%)${RESET}`);
  } else {
    parts.push(`${DIM}ctx ${RESET}${CYAN}${formatTokens(u.contextTokens)}${RESET}`);
  }
  if (u.costTotal > 0) parts.push(`${DIM}$${u.costTotal.toFixed(4)}${RESET}`);
  const secs = u.durationMs / 1000;
  parts.push(`${DIM}${secs >= 100 ? secs.toFixed(0) : secs.toFixed(1)}s${RESET}`);
  return `  ${DIM}──${RESET} ${parts.join(` ${DIM}·${RESET} `)} ${DIM}──${RESET}`;
}

/** 会话累计 (进程生命周期内) */
export interface UsageTotals {
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  durationMs: number;
  lastContextTokens: number;
  lastContextWindow: number;
}

export function createTotals(): UsageTotals {
  return { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, durationMs: 0, lastContextTokens: 0, lastContextWindow: 0 };
}

export function addTurn(totals: UsageTotals, u: TurnUsage): void {
  totals.turns += 1;
  totals.input += u.input;
  totals.output += u.output;
  totals.cacheRead += u.cacheRead;
  totals.cacheWrite += u.cacheWrite;
  totals.cost += u.costTotal;
  totals.durationMs += u.durationMs;
  totals.lastContextTokens = u.contextTokens;
  totals.lastContextWindow = u.contextWindow;
}

/** 会话整体缓存命中率 */
export function totalCacheHitRate(totals: UsageTotals): number | undefined {
  const prompt = totals.input + totals.cacheRead + totals.cacheWrite;
  return prompt > 0 ? (totals.cacheRead / prompt) * 100 : undefined;
}

/** 动态 prompt: 嵌入 agent/model/上下文状态 */
export function buildPrompt(agentId: string, modelId: string, totals: UsageTotals): string {
  let ctxPart = "";
  if (totals.lastContextTokens > 0) {
    const pct = (n: number) => (n >= 10 ? n.toFixed(0) : n.toFixed(1));
    if (totals.lastContextWindow > 0) {
      const percent = (totals.lastContextTokens / totals.lastContextWindow) * 100;
      ctxPart = ` ${ctxColor(percent)}ctx ${pct(percent)}%${RESET}`;
    } else {
      ctxPart = ` ${CYAN}ctx ${formatTokens(totals.lastContextTokens)}${RESET}`;
    }
  }
  return `\x1b[1;34m[${agentId}${DIM}·${RESET}\x1b[35m${modelId}${RESET}${ctxPart}\x1b[1;34m] > \x1b[0m`;
}

/** /status 的可观测面板 */
export function renderStatusPanel(agentName: string, agentId: string, provider: string, modelId: string, totals: UsageTotals): string {
  const lines: string[] = [];
  lines.push(`  Agent:      ${agentName} [${agentId}]`);
  lines.push(`  Model:      ${provider}/${modelId}`);
  if (totals.turns > 0) {
    lines.push(`  对话轮数:   ${totals.turns}`);
    lines.push(`  输入 tokens: ${totals.input} (缓存读 ${totals.cacheRead} / 缓存写 ${totals.cacheWrite})`);
    lines.push(`  输出 tokens: ${totals.output}`);
    const hit = totalCacheHitRate(totals);
    if (hit !== undefined) lines.push(`  缓存命中率: ${hit.toFixed(1)}%`);
    if (totals.cost > 0) lines.push(`  花费:       $${totals.cost.toFixed(4)}`);
    lines.push(`  累计耗时:   ${(totals.durationMs / 1000).toFixed(1)}s`);
    if (totals.lastContextWindow > 0) {
      const percent = (totals.lastContextTokens / totals.lastContextWindow) * 100;
      lines.push(`  上下文:     ${totals.lastContextTokens}/${totals.lastContextWindow} (${percent.toFixed(1)}%)`);
    } else if (totals.lastContextTokens > 0) {
      lines.push(`  上下文:     ~${totals.lastContextTokens} tokens`);
    }
  } else {
    lines.push(`  (本会话暂无对话统计)`);
  }
  return lines.join("\n");
}
