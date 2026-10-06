import { describe, expect, test } from "bun:test";
import type { TurnUsage } from "../src/core/agent-manager.ts";
import {
  addTurn,
  buildPrompt,
  createTotals,
  formatTokens,
  renderTurnStats,
  renderStatusPanel,
  totalCacheHitRate,
} from "../src/channels/terminal/stats.ts";
import { lookupContextWindow } from "../src/config/context-windows.ts";

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

const mkUsage = (over: Partial<TurnUsage> = {}): TurnUsage => ({
  input: 1200,
  output: 356,
  cacheRead: 89200,
  cacheWrite: 12000,
  totalTokens: 102756,
  contextTokens: 102400,
  contextWindow: 128000,
  cacheHitRate: (89200 / 102400) * 100,
  costTotal: 0.0021,
  durationMs: 3200,
  ...over,
});

describe("terminal stats: 可观测性渲染", () => {
  test("formatTokens: k/M 缩写", () => {
    expect(formatTokens(356)).toBe("356");
    expect(formatTokens(1200)).toBe("1.2k");
    expect(formatTokens(102756)).toBe("102.8k");
    expect(formatTokens(1234567)).toBe("1.2M");
  });

  test("统计行包含全部关键指标", () => {
    const line = stripAnsi(renderTurnStats(mkUsage()));
    expect(line).toContain("↑1.2k");
    expect(line).toContain("↓356");
    expect(line).toContain("R89.2k");
    expect(line).toContain("W12.0k");
    expect(line).toContain("CH87.1%");
    expect(line).toContain("ctx 102.4k/128.0k (80.0%)");
    expect(line).toContain("$0.0021");
    expect(line).toContain("3.2s");
  });

  test("高上下文占比使用红色分级", () => {
    const line = renderTurnStats(mkUsage({ contextTokens: 120000, contextWindow: 128000, cacheHitRate: 30 }));
    // 93.8% → 红色码 31; 低命中率 → 红色
    expect(line).toContain("\x1b[31m120.0k/128.0k");
    expect(line).toContain("\x1b[31m30.0%");
  });

  test("无 contextWindow 时只显示 tokens 不显示百分比", () => {
    const line = stripAnsi(renderTurnStats(mkUsage({ contextWindow: 0 })));
    expect(line).toContain("ctx 102.4k");
    expect(line).not.toContain("(%");
  });

  test("会话累计: 多轮相加 + 整体命中率", () => {
    const totals = createTotals();
    addTurn(totals, mkUsage());
    addTurn(totals, mkUsage());
    expect(totals.turns).toBe(2);
    expect(totals.input).toBe(2400);
    expect(totals.output).toBe(712);
    const hit = totalCacheHitRate(totals);
    expect(hit).toBeCloseTo((178400 / 204800) * 100, 5);
  });

  test("status 面板包含会话统计", () => {
    const totals = createTotals();
    addTurn(totals, mkUsage());
    const panel = renderStatusPanel("默认助手", "agent-default", "google", "deepseek-v4-flash", totals);
    expect(panel).toContain("对话轮数:   1");
    expect(panel).toContain("缓存命中率: 87.1%");
    expect(panel).toContain("128000 (80.0%)");
    const empty = renderStatusPanel("x", "x", "x", "x", createTotals());
    expect(empty).toContain("暂无对话统计");
  });

  test("动态 prompt 嵌入 agent/model/ctx 状态", () => {
    const totals = createTotals();
    const cold = buildPrompt("agent-default", "deepseek-v4-flash", totals);
    expect(cold).toContain("[agent-default");
    expect(cold).toContain("deepseek-v4-flash");
    expect(cold).not.toContain("ctx");
    addTurn(totals, mkUsage());
    const warm = buildPrompt("agent-default", "deepseek-v4-flash", totals);
    expect(warm).toContain("ctx 80%");
  });

  test("contextWindow 目录识别: 最长前缀匹配", () => {
    expect(lookupContextWindow("deepseek-v4-flash")).toBe(1_000_000);
    expect(lookupContextWindow("deepseek-v4.1-flash")).toBe(1_000_000);
    expect(lookupContextWindow("deepseek-v4-pro")).toBe(1_000_000);
    expect(lookupContextWindow("deepseek-chat")).toBe(1_000_000);
    expect(lookupContextWindow("deepseek-r1")).toBe(64_000);
    expect(lookupContextWindow("deepseek-v2")).toBe(128_000);
    expect(lookupContextWindow("gpt-4o-mini")).toBe(128_000);
    expect(lookupContextWindow("gpt-4.1-mini")).toBe(1_047_576);
    expect(lookupContextWindow("claude-sonnet-4-5")).toBe(200_000);
    expect(lookupContextWindow("gemini-2.5-pro")).toBe(1_048_576);
    expect(lookupContextWindow("qwen3-max")).toBe(262_144);
    expect(lookupContextWindow("totally-unknown-model")).toBeUndefined();
  });
});
