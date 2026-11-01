import { useEffect, useMemo, useRef, useState } from "react";

import { api, ApiError, isGatewayEvent } from "../api";
import { Empty, Field, Icon, fmtTime, useAsync, useToast } from "../components/ui";
import type {
  Agent,
  ContextPolicy,
  ContextSessionRow,
  ContextSessionTurns,
  ContextTurn,
  ContextTurnDetail,
  EffectiveContextThreshold,
  ModelMetadataRow,
} from "../types";

type Tab = "sessions" | "policy";

function fmtTokens(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

function fmtMs(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  if (value >= 1000) return `${(value / 1000).toFixed(1)}s`;
  return `${Math.round(value)}ms`;
}

function fmtCost(value: number | undefined, priced = true): string {
  if (!priced) return "未定价";
  if (value === undefined || !Number.isFinite(value)) return "—";
  if (value === 0) return "$0";
  if (value < 0.0001) return `$${value.toExponential(2)}`;
  return `$${value.toFixed(4)}`;
}

function fillClass(ratio: number | undefined): string {
  if (ratio === undefined) return "";
  if (ratio >= 0.95) return " is-risk";
  if (ratio >= 0.8) return " is-warn";
  return "";
}

function turnStatus(status: string): { label: string; tone: string } {
  switch (status) {
    case "done":
      return { label: "完成", tone: "live" };
    case "running":
      return { label: "运行中", tone: "ink" };
    case "error":
    case "failed":
      return { label: "失败", tone: "risk" };
    case "aborted":
      return { label: "已取消", tone: "warn" };
    case "interrupted":
      return { label: "中断", tone: "warn" };
    default:
      return { label: status, tone: "ink" };
  }
}

function triggerLabel(trigger: string): string {
  const labels: Record<string, string> = {
    pre_turn: "前置",
    pre_turn_global: "前置·全局",
    pre_turn_scheduled: "前置·定时启发式",
    pre_turn_fixed: "前置·固定 token",
    pre_turn_idle: "前置·空闲超时",
    manual: "手动",
    threshold: "阈值",
    overflow: "溢出",
  };
  return labels[trigger] ?? trigger;
}

function profileLabel(profile: string): string {
  const labels: Record<string, string> = { normal: "普通", scheduled: "定时", manual: "手动" };
  return labels[profile] ?? profile;
}

function taskKindLabel(kind: string | undefined): string {
  const labels: Record<string, string> = { generation: "生成", compaction: "压缩摘要", tool: "工具", request: "请求", poll: "流式轮询" };
  return labels[kind ?? ""] ?? (kind || "请求");
}

/** 上下文水位条：阈值刻度标出自动压缩触发点。 */
function ContextMeter({
  ratio,
  threshold,
  size,
}: {
  ratio: number | undefined;
  threshold?: number;
  size?: "lg";
}) {
  const pct = Math.min(100, Math.max(0, Math.round((ratio ?? 0) * 100)));
  const tick = threshold !== undefined && threshold > 0 && threshold < 1 ? Math.min(99, Math.round(threshold * 100)) : undefined;
  return (
    <span className={`ctx-meter${size === "lg" ? " ctx-meter--lg" : ""}`} aria-hidden="true">
      <span className={`ctx-meter__fill${fillClass(ratio)}`} style={{ width: `${pct}%` }} />
      {tick !== undefined ? (
        <span className="ctx-meter__tick" style={{ left: `${tick}%` }} title={`自动压缩阈值 ${tick}%`} />
      ) : null}
    </span>
  );
}

export function ContextView() {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>("sessions");
  const agentsQ = useAsync(() => api.listAgents(), []);
  const policyQ = useAsync(() => api.getContextPolicy(), []);
  const metadataQ = useAsync(() => api.listModelMetadata(), []);

  const [agentId, setAgentId] = useState("");
  const [kind, setKind] = useState<"" | "normal" | "scheduled">("");
  const [range, setRange] = useState<"7" | "30" | "all">("30");
  const [query, setQuery] = useState("");
  const [sessions, setSessions] = useState<ContextSessionRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<ContextSessionRow | null>(null);
  const [turns, setTurns] = useState<ContextSessionTurns | null>(null);
  const [expandedTurn, setExpandedTurn] = useState<string | null>(null);
  const [detail, setDetail] = useState<ContextTurnDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const detailSeq = useRef(0);

  const [draft, setDraft] = useState<ContextPolicy | null>(null);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (policyQ.data?.policy) setDraft(structuredClone(policyQ.data.policy));
  }, [policyQ.data]);

  const loadSessions = async () => {
    setLoading(true);
    try {
      const now = Date.now();
      const from = range === "all" ? undefined : now - Number(range) * 86_400_000;
      const res = await api.listContextSessions({
        agentId: agentId || undefined,
        kind: kind || undefined,
        from,
        q: query || undefined,
        limit: 100,
      });
      setSessions(res.rows);
      setTotal(res.total);
      // 过滤后选中会话可能已不在列表里，收起详情避免展示孤立数据
      setSelected((prev) =>
        prev && !res.rows.some((row) => row.conversationId === prev.conversationId) ? null : prev,
      );
    } catch (err) {
      toast(String(err), "risk");
    } finally {
      setLoading(false);
    }
  };

  const loadTurns = async (conversationId: string) => {
    try {
      setTurns(await api.contextTurns(conversationId, 50, 0));
    } catch (err) {
      toast(String(err), "risk");
      setTurns(null);
    }
  };

  const loadTurnDetail = async (turnId: string) => {
    const seq = ++detailSeq.current;
    try {
      const res = await api.contextTurnDetail(turnId);
      if (seq === detailSeq.current) setDetail(res);
    } catch (err) {
      if (seq === detailSeq.current) {
        toast(String(err), "risk");
        setExpandedTurn(null);
      }
    }
  };

  // 筛选条件与搜索都会重建列表；搜索输入做 250ms 防抖，避免逐键请求
  useEffect(() => {
    const timer = setTimeout(() => void loadSessions(), 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, kind, range, query]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onEvent = (e: Event) => {
      if (!isGatewayEvent(e, "context.turn", "context.compacted")) return;
      const payload = (e as CustomEvent).detail as { conversationId?: string } | undefined;
      // 合并并发 turn 事件，避免一轮多事件触发多次全量刷新
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void loadSessions();
        if (selected && payload?.conversationId === selected.conversationId) {
          void loadTurns(selected.conversationId);
          if (expandedTurn) void loadTurnDetail(expandedTurn);
        }
      }, 300);
    };
    window.addEventListener("bot:event", onEvent);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener("bot:event", onEvent);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, kind, range, query, selected, expandedTurn]);

  const selectSession = (row: ContextSessionRow) => {
    if (selected?.conversationId === row.conversationId) return;
    setSelected(row);
    setTurns(null);
    setExpandedTurn(null);
    setDetail(null);
    void loadTurns(row.conversationId);
    // 窄屏是上下堆叠布局，选中后把详情带入视野
    if (window.innerWidth < 1100) {
      requestAnimationFrame(() =>
        document.getElementById("context-detail-pane")?.scrollIntoView({ block: "start" }),
      );
    }
  };

  const toggleTurn = (turn: ContextTurn) => {
    if (expandedTurn === turn.turnId) {
      detailSeq.current++;
      setExpandedTurn(null);
      setDetail(null);
      return;
    }
    setExpandedTurn(turn.turnId);
    setDetail(null);
    void loadTurnDetail(turn.turnId);
  };

  // 展开后把明细带入视野（详情面板自身可滚动）
  useEffect(() => {
    if (!expandedTurn) return;
    document.getElementById(`ctx-turn-detail-${expandedTurn}`)?.scrollIntoView({ block: "nearest" });
  }, [expandedTurn]);

  const closeDetail = () => {
    detailSeq.current++;
    setSelected(null);
    setTurns(null);
    setExpandedTurn(null);
    setDetail(null);
  };

  const compactNow = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const result = (await api.compactConversation(selected.conversationId)) as any;
      if (result?.status === "done" && result?.compacted) {
        toast(`已压缩：${fmtTokens(result.beforeTokens)} → ${fmtTokens(result.afterTokens)}`, "ok");
      } else if (result?.status === "skipped") {
        toast("没有可压缩的历史前缀");
      } else {
        toast(`压缩未完成：${result?.error ?? result?.status ?? "未知"}`, "risk");
      }
      detailSeq.current++;
      setExpandedTurn(null);
      setDetail(null);
      await loadSessions();
      await loadTurns(selected.conversationId);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) toast("会话正在生成，请先取消或等待本轮结束", "risk");
      else toast(String(err), "risk");
    } finally {
      setBusy(false);
    }
  };

  const savePolicy = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      await api.saveContextPolicy(draft);
      toast("上下文策略已保存并热应用", "ok");
      policyQ.reload();
    } catch (err) {
      toast(String(err), "risk");
    } finally {
      setSaving(false);
    }
  };

  const refreshCatalog = async () => {
    setRefreshing(true);
    try {
      const stats = await api.refreshModelMetadata();
      toast(
        `模型目录已刷新：匹配 ${stats.matched}，内置 ${stats.builtin}，fallback ${stats.fallback}`,
        "ok",
      );
      policyQ.reload();
      metadataQ.reload();
    } catch (err) {
      toast(String(err), "risk");
    } finally {
      setRefreshing(false);
    }
  };

  const agents = agentsQ.data ?? [];
  const models: ModelMetadataRow[] = metadataQ.data?.models ?? [];
  const totals = useMemo(() => {
    let input = 0;
    let cost = 0;
    let compactions = 0;
    let ratios = 0;
    let ratioCount = 0;
    for (const row of sessions) {
      input += row.contextTokens ?? 0;
      cost += row.costUsd ?? 0;
      compactions += row.compactions ?? 0;
      if (row.fillRatio !== undefined) {
        ratios += row.fillRatio;
        ratioCount++;
      }
    }
    return { input, cost, compactions, avgFill: ratioCount ? ratios / ratioCount : undefined };
  }, [sessions]);

  const kindCounts = useMemo(() => {
    let normal = 0;
    let scheduled = 0;
    for (const row of sessions) {
      if (row.sessionKind === "scheduled") scheduled++;
      else normal++;
    }
    return { normal, scheduled };
  }, [sessions]);

  const unpricedCount = sessions.filter((row) => !row.priced).length;
  const currentSession = selected
    ? sessions.find((row) => row.conversationId === selected.conversationId) ?? selected
    : null;
  const hasFilters = Boolean(agentId || kind || query.trim() || range !== "30");
  const clearFilters = () => {
    setAgentId("");
    setKind("");
    setRange("30");
    setQuery("");
  };

  /** 会话的自动压缩阈值水位：取该 profile 下已启用策略中最低的静态阈值。 */
  const thresholdRatio = (row: ContextSessionRow): number | undefined => {
    if (!row.contextWindow || row.contextWindow <= 0) return undefined;
    const effective = policyQ.data?.effective?.find(
      (m) => m.providerId === row.provider && m.modelId === row.modelId,
    );
    const policy = policyQ.data?.policy;
    if (!effective || !policy) return undefined;
    const { strategies } = policy;
    const candidates: number[] = [];
    if (strategies.global.enabled && effective.globalThreshold > 0) {
      candidates.push(effective.globalThreshold);
    }
    if (
      row.sessionKind === "scheduled" &&
      strategies.scheduledHeuristic.enabled &&
      effective.scheduledFallbackThreshold > 0
    ) {
      candidates.push(effective.scheduledFallbackThreshold);
    }
    if (
      strategies.fixed.enabled &&
      (strategies.fixed.scope === "all" || strategies.fixed.scope === row.sessionKind) &&
      effective.fixedThreshold > 0
    ) {
      candidates.push(effective.fixedThreshold);
    }
    if (candidates.length === 0) return undefined;
    return Math.min(...candidates) / row.contextWindow;
  };
  const selectedThreshold = currentSession ? thresholdRatio(currentSession) : undefined;

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <div className="eyebrow">Context</div>
          <h1 className="page__title">上下文管理</h1>
          <p className="page__desc">
            观察每个会话的上下文水位、成本与每轮调用时序；配置全局百分比、定时增量、固定 token 与空闲超时等多策略自动压缩。
          </p>
        </div>
        <div className="page__actions">
          <button className={`chip-btn${tab === "sessions" ? " is-active" : ""}`} onClick={() => setTab("sessions")} type="button">
            会话观测
          </button>
          <button className={`chip-btn${tab === "policy" ? " is-active" : ""}`} onClick={() => setTab("policy")} type="button">
            策略设置
          </button>
        </div>
      </div>

      {tab === "sessions" ? (
        <>
          <div className="ctx-stats">
            <div className="ctx-stat">
              <span className="ctx-stat__label">会话</span>
              <span className="ctx-stat__value">{total}</span>
              <span className="ctx-stat__hint">
                {kindCounts.normal} 普通 · {kindCounts.scheduled} 定时
              </span>
            </div>
            <div className="ctx-stat">
              <span className="ctx-stat__label">当前上下文</span>
              <span className="ctx-stat__value">{fmtTokens(totals.input)}</span>
              <span className="ctx-stat__hint">prompt 侧合计</span>
            </div>
            <div className="ctx-stat">
              <span className="ctx-stat__label">范围内成本</span>
              <span className="ctx-stat__value">{fmtCost(totals.cost)}</span>
              <span className="ctx-stat__hint">
                {unpricedCount > 0 ? `${unpricedCount} 个会话未定价` : "按有效价格累计"}
              </span>
            </div>
            <div className="ctx-stat">
              <span className="ctx-stat__label">平均窗口占比</span>
              <span className="ctx-stat__value">
                {totals.avgFill === undefined ? "—" : `${Math.round(totals.avgFill * 100)}%`}
              </span>
              <ContextMeter ratio={totals.avgFill} />
            </div>
            <div className="ctx-stat">
              <span className="ctx-stat__label">压缩次数</span>
              <span className="ctx-stat__value">{totals.compactions}</span>
              <span className="ctx-stat__hint">前置 + 手动</span>
            </div>
          </div>

          <div className="ctx-toolbar">
            <div className="search-field">
              <Icon name="search" size={13} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索会话 / 模型…"
                aria-label="搜索会话或模型"
              />
              {query ? (
                <button
                  type="button"
                  className="search-field__clear"
                  aria-label="清除搜索"
                  onClick={() => setQuery("")}
                >
                  ✕
                </button>
              ) : null}
            </div>
            <select
              className="select ctx-toolbar__select"
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              aria-label="按 Agent 筛选"
            >
              <option value="">全部 Agent</option>
              {agents.map((a: Agent) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            <select
              className="select ctx-toolbar__select"
              value={kind}
              onChange={(e) => setKind(e.target.value as "" | "normal" | "scheduled")}
              aria-label="按会话类型筛选"
            >
              <option value="">全部类型</option>
              <option value="normal">普通会话</option>
              <option value="scheduled">定时任务</option>
            </select>
            <select
              className="select ctx-toolbar__select"
              value={range}
              onChange={(e) => setRange(e.target.value as "7" | "30" | "all")}
              aria-label="时间范围"
            >
              <option value="7">最近 7 天</option>
              <option value="30">最近 30 天</option>
              <option value="all">全部</option>
            </select>
            {hasFilters ? (
              <button className="btn btn--ghost btn--sm" type="button" onClick={clearFilters}>
                清除筛选
              </button>
            ) : null}
            <span className="ctx-toolbar__count">{loading ? "刷新中…" : `${total} 个会话`}</span>
            <button
              className="btn btn--secondary btn--sm"
              type="button"
              aria-label="刷新会话列表"
              disabled={loading}
              onClick={() => void loadSessions()}
            >
              <Icon name="refresh" size={13} /> 刷新
            </button>
          </div>

          <div className="ctx-workspace">
            <section className="ctx-pane" aria-label="会话列表">
              <div className="ctx-pane__head">
                <span className="ctx-pane__title">会话列表</span>
                <span className="ctx-pane__hint">按最后活跃排序</span>
              </div>
              {loading && sessions.length === 0 ? (
                <Empty mark="…" title="加载中…" />
              ) : sessions.length === 0 ? (
                <Empty
                  mark={hasFilters ? "NO MATCH" : "—"}
                  title={hasFilters ? "没有匹配的会话" : "暂无会话观测数据"}
                  desc={hasFilters ? "调整搜索词或清除筛选后再试。" : "发起一轮对话或等待定时任务触发后即可看到。"}
                  action={
                    hasFilters ? (
                      <button className="btn btn--secondary btn--sm" type="button" onClick={clearFilters}>
                        清除筛选
                      </button>
                    ) : undefined
                  }
                />
              ) : (
                <div className="ctx-session-list">
                  {sessions.map((row) => {
                    const active = selected?.conversationId === row.conversationId;
                    const pct = row.fillRatio === undefined ? undefined : Math.round(row.fillRatio * 100);
                    const threshold = thresholdRatio(row);
                    return (
                      <button
                        key={row.conversationId}
                        type="button"
                        className={`ctx-session${active ? " is-selected" : ""}`}
                        aria-pressed={active}
                        onClick={() => selectSession(row)}
                      >
                        <span className="ctx-session__top">
                          <span className="ctx-session__label">{row.label ?? row.sessionId}</span>
                          <span className="ctx-session__time">{fmtTime(row.lastActiveAt)}</span>
                        </span>
                        <span className="ctx-session__meta">
                          <span className={`badge badge--${row.sessionKind === "scheduled" ? "warn" : "ink"}`}>
                            {row.sessionKind === "scheduled" ? "定时任务" : "普通会话"}
                          </span>
                          <span className="ctx-session__agent">{row.agentName ?? row.agentId}</span>
                          <span className="mono mono--plain ctx-session__model">{row.modelId ?? "—"}</span>
                          {row.status === "running" ? <span className="badge badge--live">生成中</span> : null}
                        </span>
                        <span className="ctx-session__water">
                          <ContextMeter ratio={row.fillRatio} threshold={threshold} />
                          <span className="ctx-session__waterline">
                            {fmtTokens(row.contextTokens)} / {fmtTokens(row.contextWindow)}
                            {pct !== undefined ? ` · ${pct}%` : ""}
                          </span>
                          {threshold !== undefined ? (
                            <span className="ctx-session__threshold">阈值 {Math.round(threshold * 100)}%</span>
                          ) : null}
                        </span>
                        <span className="ctx-session__foot">
                          <span>
                            <b>{row.turns}</b> 轮
                          </span>
                          <span title="会话成本">{fmtCost(row.costUsd, row.priced)}</span>
                          <span>
                            <b>{row.compactions}</b> 压缩
                          </span>
                          <span className="mono mono--plain ctx-session__sid" title={row.conversationId}>
                            {row.sessionId}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </section>

            <aside className="ctx-detail" id="context-detail-pane" aria-label="会话详情">
              {!currentSession ? (
                <div className="ctx-detail__empty">
                  <span className="ctx-detail__empty-icon">
                    <Icon name="layers" size={18} />
                  </span>
                  <span className="ctx-detail__empty-title">选择一个会话</span>
                  <span className="ctx-detail__empty-desc">查看上下文水位、每轮耗时与模型请求明细。</span>
                </div>
              ) : (
                <>
                  <div className="ctx-detail__head">
                    <div className="ctx-detail__ident">
                      <div className="ctx-detail__title">{currentSession.label ?? currentSession.sessionId}</div>
                      <div className="ctx-detail__sub">
                        <span className={`badge badge--${currentSession.sessionKind === "scheduled" ? "warn" : "ink"}`}>
                          {currentSession.sessionKind === "scheduled" ? "定时任务" : "普通会话"}
                        </span>
                        <span>{currentSession.agentName ?? currentSession.agentId}</span>
                        <span className="mono mono--plain">{currentSession.modelId ?? "—"}</span>
                      </div>
                      <div className="ctx-detail__sid" title={currentSession.conversationId}>
                        {currentSession.sessionId}
                      </div>
                    </div>
                    <button
                      className="btn btn--ghost btn--sm"
                      type="button"
                      aria-label="关闭详情"
                      onClick={closeDetail}
                    >
                      <Icon name="x" size={14} />
                    </button>
                  </div>

                  <div className="ctx-detail__water">
                    <ContextMeter ratio={currentSession.fillRatio} threshold={selectedThreshold} size="lg" />
                    <div className="ctx-detail__waterline">
                      <span className="mono mono--plain">
                        {fmtTokens(currentSession.contextTokens)} / {fmtTokens(currentSession.contextWindow)}
                      </span>
                      <span>
                        {currentSession.fillRatio === undefined
                          ? "—"
                          : `${Math.round(currentSession.fillRatio * 100)}%`}
                      </span>
                      {selectedThreshold !== undefined ? (
                        <span className="ctx-detail__threshold">
                          自动压缩阈值 {Math.round(selectedThreshold * 100)}%
                        </span>
                      ) : null}
                    </div>
                  </div>

                  <div className="ctx-detail__stats">
                    <span>
                      <b>{currentSession.turns}</b> 轮
                    </span>
                    <span>
                      <b>{fmtCost(currentSession.costUsd, currentSession.priced)}</b>
                    </span>
                    <span>
                      <b>{currentSession.compactions}</b> 压缩
                    </span>
                  </div>

                  <div className="ctx-detail__actions">
                    <button
                      className="btn btn--secondary btn--sm"
                      type="button"
                      disabled={busy}
                      onClick={() => void compactNow()}
                    >
                      <Icon name="layers" size={13} /> {busy ? "压缩中…" : "立即压缩"}
                    </button>
                    <span className="ctx-detail__action-hint">先摘要历史，再继续本轮</span>
                  </div>

                  <div className="ctx-turns">
                    {!turns ? (
                      <Empty mark="…" title="加载轮次…" />
                    ) : turns.turns.length === 0 ? (
                      <Empty mark="—" title="还没有轮次记录" />
                    ) : (
                      turns.turns.map((turn) => {
                        const status = turnStatus(turn.status);
                        const expanded = expandedTurn === turn.turnId;
                        const turnDetail = expanded && detail?.turn.turnId === turn.turnId ? detail : null;
                        const requestRows = turnDetail ? turnDetail.requests.filter((r) => r.kind !== "poll") : [];
                        const pollCount = turnDetail ? turnDetail.requests.length - requestRows.length : 0;
                        return (
                          <div key={turn.turnId} className={`ctx-turn${expanded ? " is-open" : ""}`}>
                            <button
                              type="button"
                              className="ctx-turn__head"
                              aria-expanded={expanded}
                              aria-controls={`ctx-turn-detail-${turn.turnId}`}
                              onClick={() => toggleTurn(turn)}
                            >
                              <span className="ctx-turn__time">{fmtTime(turn.startedAt)}</span>
                              <span className={`badge badge--${status.tone}`}>{status.label}</span>
                              {turn.compactedBefore ? <span className="badge badge--ink">前置压缩</span> : null}
                              {turn.detailTruncated ? <span className="badge badge--warn">明细截断</span> : null}
                              <span className="ctx-turn__cost">{fmtCost(turn.costUsd, turn.priced)}</span>
                              <span className="ctx-turn__toggle">{expanded ? "收起" : "明细"}</span>
                            </button>
                            <div className="ctx-turn__metrics">
                              <span className="ctx-turn__metric">
                                <span>上下文</span>
                                <b>{fmtTokens(turn.contextTokens)}</b>
                              </span>
                              <span className="ctx-turn__metric">
                                <span>输入 / 输出</span>
                                <b>
                                  ↑{fmtTokens(turn.inputTokens)} ↓{fmtTokens(turn.outputTokens)}
                                </b>
                              </span>
                              <span className="ctx-turn__metric">
                                <span>Wall</span>
                                <b>{fmtMs(turn.durationMs)}</b>
                              </span>
                              <span className="ctx-turn__metric">
                                <span>首包</span>
                                <b>{fmtMs(turn.firstChunkMs)}</b>
                              </span>
                              <span className="ctx-turn__metric">
                                <span>首字</span>
                                <b>{fmtMs(turn.ttftMs)}</b>
                              </span>
                              <span className="ctx-turn__metric">
                                <span>工具</span>
                                <b>{fmtMs(turn.toolMs)}</b>
                              </span>
                              <span className="ctx-turn__metric">
                                <span>请求</span>
                                <b>{turn.requestCount}</b>
                              </span>
                            </div>
                            {turn.error ? <div className="ctx-turn__error">{turn.error}</div> : null}
                            {expanded ? (
                              <div className="ctx-turn__detail" id={`ctx-turn-detail-${turn.turnId}`}>
                                {!turnDetail ? (
                                  <div className="ctx-hint">加载明细…</div>
                                ) : (
                                  <>
                                    <div className="ctx-subhead">
                                      模型请求 · {requestRows.length}
                                      {pollCount > 0 ? ` · 另有 ${pollCount} 次流式轮询` : ""}
                                    </div>
                                    {requestRows.length === 0 ? (
                                      <div className="ctx-hint">没有请求记录</div>
                                    ) : (
                                      <div className="ctx-requests">
                                        {requestRows.map((r) => (
                                          <div className="ctx-request" key={r.spanId}>
                                            <div className="ctx-request__top">
                                              <span className="ctx-request__kind">
                                                {taskKindLabel(r.taskKind ?? r.kind)}
                                              </span>
                                              <span className="mono mono--plain">{r.modelId ?? "—"}</span>
                                              <span className="mono mono--plain ctx-request__time">
                                                {fmtTime(r.startedAt)}
                                              </span>
                                              <span className="ctx-request__cost">{fmtCost(r.costUsd, turn.priced)}</span>
                                            </div>
                                            <div className="ctx-request__metrics">
                                              <span>
                                                耗时 <b>{fmtMs(r.durationMs)}</b>
                                              </span>
                                              <span>
                                                首包 <b>{fmtMs(r.firstChunkMs)}</b>
                                              </span>
                                              <span>
                                                ↑{fmtTokens(r.inputTokens)} ↓{fmtTokens(r.outputTokens)}
                                              </span>
                                              <span>
                                                缓存 {fmtTokens(r.cacheRead)} / {fmtTokens(r.cacheWrite)}
                                              </span>
                                              <span className={r.status === "error" ? "ctx-request__error" : undefined}>
                                                {r.stopReason ?? r.status}
                                              </span>
                                            </div>
                                          </div>
                                        ))}
                                      </div>
                                    )}
                                    {turnDetail.tools.length > 0 ? (
                                      <>
                                        <div className="ctx-subhead">工具调用 · {turnDetail.tools.length}</div>
                                        <div className="ctx-tools">
                                          {turnDetail.tools.map((tool) => (
                                            <span
                                              key={tool.toolCallId ?? `${tool.toolName}-${tool.startedAt}`}
                                              className={`ctx-tool${tool.status !== "ok" ? " is-error" : ""}`}
                                              title={tool.error ?? tool.status}
                                            >
                                              {tool.toolName}
                                              <b>{fmtMs(tool.durationMs)}</b>
                                            </span>
                                          ))}
                                        </div>
                                      </>
                                    ) : null}
                                    <div className="ctx-hint">
                                      「首包」= pi-ai 首个归一化流事件（不是 HTTP 首字节）；「首字」=
                                      首个文本/思考/工具调用 token（近似 TTFT）。
                                    </div>
                                  </>
                                )}
                              </div>
                            ) : null}
                          </div>
                        );
                      })
                    )}
                  </div>

                  {turns && turns.compactions.length > 0 ? (
                    <div className="ctx-compactions">
                      <div className="ctx-subhead">压缩历史 · {turns.compactions.length}</div>
                      {turns.compactions.map((c) => (
                        <div className="ctx-compaction" key={`${c.startedAt}-${c.compactionId ?? c.taskId ?? "c"}`}>
                          <span className="mono mono--plain">{fmtTime(c.startedAt)}</span>
                          <span
                            className={`badge badge--${c.status === "done" ? "live" : c.status === "skipped" ? "ink" : "warn"}`}
                          >
                            {c.status === "done" ? "完成" : c.status === "skipped" ? "跳过" : c.status}
                          </span>
                          <span className="ctx-compaction__kind">
                            {triggerLabel(c.trigger)} · {profileLabel(c.profile)}
                          </span>
                          <span className="mono mono--plain">
                            {fmtTokens(c.beforeTokens)} → {fmtTokens(c.afterTokens)}
                          </span>
                          <span className="mono mono--plain">{fmtMs(c.durationMs)}</span>
                          <span className="mono mono--plain">{c.costUsd ? fmtCost(c.costUsd) : "—"}</span>
                          {c.costInTurn ? <span className="ctx-hint">含在本轮</span> : null}
                          {c.error ? <span className="ctx-compaction__error">{c.error}</span> : null}
                        </div>
                      ))}
                    </div>
                  ) : null}

                  <div className="ctx-detail__note">
                    内部 ID <span className="mono mono--plain">{currentSession.conversationId}</span>
                  </div>
                </>
              )}
            </aside>
          </div>
        </>
      ) : (
        <PolicyTab
          draft={draft}
          setDraft={setDraft}
          saving={saving}
          save={savePolicy}
          refreshing={refreshing}
          refresh={refreshCatalog}
          effective={policyQ.data?.effective ?? []}
          catalogFetchedAt={policyQ.data?.catalogFetchedAt}
          models={models}
        />
      )}
    </div>
  );
}

function PolicyTab(props: {
  draft: ContextPolicy | null;
  setDraft: (p: ContextPolicy) => void;
  saving: boolean;
  save: () => Promise<void>;
  refreshing: boolean;
  refresh: () => Promise<void>;
  effective: EffectiveContextThreshold[];
  catalogFetchedAt?: number;
  models: ModelMetadataRow[];
}) {
  const { draft, setDraft } = props;
  if (!draft) return <Empty mark="…" title="加载策略…" />;
  const update = (patch: Partial<ContextPolicy>) => setDraft({ ...draft, ...patch });
  const updateGlobal = (patch: Partial<ContextPolicy["strategies"]["global"]>) =>
    setDraft({ ...draft, strategies: { ...draft.strategies, global: { ...draft.strategies.global, ...patch } } });
  const updateHeuristic = (patch: Partial<ContextPolicy["strategies"]["scheduledHeuristic"]>) =>
    setDraft({
      ...draft,
      strategies: {
        ...draft.strategies,
        scheduledHeuristic: { ...draft.strategies.scheduledHeuristic, ...patch },
      },
    });
  const updateFixed = (patch: Partial<ContextPolicy["strategies"]["fixed"]>) =>
    setDraft({ ...draft, strategies: { ...draft.strategies, fixed: { ...draft.strategies.fixed, ...patch } } });
  const updateIdle = (patch: Partial<ContextPolicy["strategies"]["idle"]>) =>
    setDraft({ ...draft, strategies: { ...draft.strategies, idle: { ...draft.strategies.idle, ...patch } } });
  const s = draft.strategies;
  const enabledCount = [s.global.enabled, s.scheduledHeuristic.enabled, s.fixed.enabled, s.idle.enabled].filter(
    Boolean,
  ).length;
  const enabledThresholds = (m: EffectiveContextThreshold): number[] =>
    [
      s.global.enabled ? m.globalThreshold : 0,
      s.scheduledHeuristic.enabled ? m.scheduledFallbackThreshold : 0,
      s.fixed.enabled ? m.fixedThreshold : 0,
    ].filter((threshold) => threshold > 0);
  const warnModels = props.effective.filter(
    (m) =>
      m.contextWindow > 0 &&
      enabledThresholds(m).some((threshold) => threshold >= m.contextWindow || threshold <= m.keepRecentTokens + 1024),
  );

  return (
    <>
      <div className="ctx-strategy-overview">
        <div>
          <div className="card__title">自动压缩策略</div>
          <div className="card__sub">多策略叠加，按优先级判定；命中即压缩，每轮最多一次</div>
        </div>
        <span className={`badge badge--${enabledCount > 0 ? "live" : "ink"}`}>{enabledCount} / 4 已启用</span>
      </div>

      <div className="ctx-strategy-order">
        <span className="ctx-strategy-order__label">判定顺序</span>
        <span className={`ctx-strategy-order__item${s.global.enabled ? " is-on" : ""}`}>1 全局百分比</span>
        <span className="ctx-strategy-order__arrow">→</span>
        <span className={`ctx-strategy-order__item${s.scheduledHeuristic.enabled ? " is-on" : ""}`}>2 定时启发式</span>
        <span className="ctx-strategy-order__arrow">→</span>
        <span className={`ctx-strategy-order__item${s.fixed.enabled ? " is-on" : ""}`}>3 固定 token</span>
        <span className="ctx-strategy-order__arrow">→</span>
        <span className={`ctx-strategy-order__item${s.idle.enabled ? " is-on" : ""}`}>4 空闲超时</span>
      </div>

      {enabledCount === 0 ? (
        <div className="ctx-strategy-warn">
          所有自动策略已关闭：只保留 <span className="mono mono--plain">/compact</span> 手动压缩与框架紧急兜底。
        </div>
      ) : null}

      <div className="grid grid--2 strategy-grid">
        <div className={`card strategy-card${s.global.enabled ? " is-on" : ""}`}>
          <div className="card__head">
            <div>
              <div className="card__title">
                <span className="strategy-priority">1</span>全局百分比
              </div>
              <div className="card__sub">所有会话 · 最高优先级</div>
            </div>
            <label className="toggle">
              <input
                type="checkbox"
                className="toggle__input"
                checked={s.global.enabled}
                onChange={(e) => updateGlobal({ enabled: e.target.checked })}
              />
              <span className="toggle__track" />
              <span className="toggle__label">{s.global.enabled ? "启用" : "停用"}</span>
            </label>
          </div>
          <div className="card__flow strategy-card__body">
            <div className="strategy-form">
              <Field label="触发比例（窗口 %）" hint="上下文达到模型窗口的该比例时先压缩">
                <input
                  className="input mono"
                  type="number"
                  min={5}
                  max={95}
                  value={Math.round(s.global.percent * 100)}
                  onChange={(e) => updateGlobal({ percent: Number(e.target.value) / 100 })}
                />
              </Field>
              <Field label="最小触发 tokens" hint="低于该值不压缩，避免小会话频繁摘要">
                <input
                  className="input mono"
                  type="number"
                  min={0}
                  value={s.global.minTokens}
                  onChange={(e) => updateGlobal({ minTokens: Number(e.target.value) })}
                />
              </Field>
            </div>
          </div>
        </div>

        <div className={`card strategy-card${s.scheduledHeuristic.enabled ? " is-on" : ""}`}>
          <div className="card__head">
            <div>
              <div className="card__title">
                <span className="strategy-priority">2</span>定时任务增量启发式
              </div>
              <div className="card__sub">仅定时任务 · 按最近几次 run 的上下文净增预测</div>
            </div>
            <label className="toggle">
              <input
                type="checkbox"
                className="toggle__input"
                checked={s.scheduledHeuristic.enabled}
                onChange={(e) => updateHeuristic({ enabled: e.target.checked })}
              />
              <span className="toggle__track" />
              <span className="toggle__label">{s.scheduledHeuristic.enabled ? "启用" : "停用"}</span>
            </label>
          </div>
          <div className="card__flow strategy-card__body">
            <div className="strategy-form">
              <Field label="采样次数 N" hint="最近 N 次 run 的 context 净增量（N 个点算 N-1 个增量）">
                <input
                  className="input mono"
                  type="number"
                  min={2}
                  max={20}
                  value={s.scheduledHeuristic.sampleSize}
                  onChange={(e) => updateHeuristic({ sampleSize: Number(e.target.value) })}
                />
              </Field>
              <Field label="倍数" hint="平均增量 × 倍数 = 触发阈值">
                <input
                  className="input mono"
                  type="number"
                  min={1}
                  max={20}
                  value={s.scheduledHeuristic.multiplier}
                  onChange={(e) => updateHeuristic({ multiplier: Number(e.target.value) })}
                />
              </Field>
              <Field label="无历史回退 tokens" hint="首次运行或历史不足时使用">
                <input
                  className="input mono"
                  type="number"
                  min={1024}
                  value={s.scheduledHeuristic.fallbackTokens}
                  onChange={(e) => updateHeuristic({ fallbackTokens: Number(e.target.value) })}
                />
              </Field>
              <Field label="最小触发 tokens">
                <input
                  className="input mono"
                  type="number"
                  min={0}
                  value={s.scheduledHeuristic.minTokens}
                  onChange={(e) => updateHeuristic({ minTokens: Number(e.target.value) })}
                />
              </Field>
              <div className="strategy-form__span">
                <Field label="不超过窗口比例（%）" hint="小窗口模型会被该比例夹住">
                  <input
                    className="input mono"
                    type="number"
                    min={5}
                    max={95}
                    value={Math.round(s.scheduledHeuristic.maxPercentOfWindow * 100)}
                    onChange={(e) => updateHeuristic({ maxPercentOfWindow: Number(e.target.value) / 100 })}
                  />
                </Field>
              </div>
            </div>
          </div>
        </div>

        <div className={`card strategy-card${s.fixed.enabled ? " is-on" : ""}`}>
          <div className="card__head">
            <div>
              <div className="card__title">
                <span className="strategy-priority">3</span>固定 token 上限
              </div>
              <div className="card__sub">补充模式 · 窗口未知或明确预算时使用</div>
            </div>
            <label className="toggle">
              <input
                type="checkbox"
                className="toggle__input"
                checked={s.fixed.enabled}
                onChange={(e) => updateFixed({ enabled: e.target.checked })}
              />
              <span className="toggle__track" />
              <span className="toggle__label">{s.fixed.enabled ? "启用" : "停用"}</span>
            </label>
          </div>
          <div className="card__flow strategy-card__body">
            <div className="strategy-form">
              <Field label="触发阈值 tokens">
                <input
                  className="input mono"
                  type="number"
                  min={1024}
                  value={s.fixed.tokens}
                  onChange={(e) => updateFixed({ tokens: Number(e.target.value) })}
                />
              </Field>
              <Field label="最小触发 tokens">
                <input
                  className="input mono"
                  type="number"
                  min={0}
                  value={s.fixed.minTokens}
                  onChange={(e) => updateFixed({ minTokens: Number(e.target.value) })}
                />
              </Field>
              <div className="strategy-form__span">
                <Field label="作用范围">
                  <select
                    className="select"
                    value={s.fixed.scope}
                    onChange={(e) => updateFixed({ scope: e.target.value as ContextPolicy["strategies"]["fixed"]["scope"] })}
                  >
                    <option value="all">全部会话</option>
                    <option value="normal">仅普通会话</option>
                    <option value="scheduled">仅定时任务</option>
                  </select>
                </Field>
              </div>
            </div>
          </div>
        </div>

        <div className={`card strategy-card${s.idle.enabled ? " is-on" : ""}`}>
          <div className="card__head">
            <div>
              <div className="card__title">
                <span className="strategy-priority">4</span>空闲超时
              </div>
              <div className="card__sub">仅普通会话 · 间隔太久先压缩再继续</div>
            </div>
            <label className="toggle">
              <input
                type="checkbox"
                className="toggle__input"
                checked={s.idle.enabled}
                onChange={(e) => updateIdle({ enabled: e.target.checked })}
              />
              <span className="toggle__track" />
              <span className="toggle__label">{s.idle.enabled ? "启用" : "停用"}</span>
            </label>
          </div>
          <div className="card__flow strategy-card__body">
            <div className="strategy-form">
              <Field label="距上一轮超过（小时）" hint="上一轮结束时间到本轮开始">
                <input
                  className="input mono"
                  type="number"
                  min={1}
                  max={8760}
                  value={s.idle.idleHours}
                  onChange={(e) => updateIdle({ idleHours: Number(e.target.value) })}
                />
              </Field>
              <Field label="最小触发 tokens" hint="低于该值不压缩，避免空会话摘要">
                <input
                  className="input mono"
                  type="number"
                  min={0}
                  value={s.idle.minTokens}
                  onChange={(e) => updateIdle({ minTokens: Number(e.target.value) })}
                />
              </Field>
            </div>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card__head">
          <div>
            <div className="card__title">高级</div>
            <div className="card__sub">全局 keepRecent / 估算安全垫 / 保留期</div>
          </div>
        </div>
        <div className="card__flow grid grid--3">
          <Field label="估算安全垫 tokens" hint="为 system prompt / 工具 schema 预留">
            <input
              className="input mono"
              type="number"
              min={0}
              value={draft.safetyTokens}
              onChange={(e) => update({ safetyTokens: Number(e.target.value) })}
            />
          </Field>
          <Field label="keepRecent 上限" hint="框架全局值；按所有已启用策略的最低阈值 40% 约束">
            <input
              className="input mono"
              type="number"
              min={1024}
              value={draft.keepRecentCapTokens}
              onChange={(e) => update({ keepRecentCapTokens: Number(e.target.value) })}
            />
          </Field>
          <Field label="紧急兜底预留上限">
            <input
              className="input mono"
              type="number"
              min={1024}
              value={draft.emergencyReserveCapTokens}
              onChange={(e) => update({ emergencyReserveCapTokens: Number(e.target.value) })}
            />
          </Field>
          <Field label="压缩超时 (ms)">
            <input
              className="input mono"
              type="number"
              min={5000}
              step={1000}
              value={draft.timeoutMs}
              onChange={(e) => update({ timeoutMs: Number(e.target.value) })}
            />
          </Field>
          <Field label="聚合保留天数">
            <input
              className="input mono"
              type="number"
              min={1}
              value={draft.retentionDays}
              onChange={(e) => update({ retentionDays: Number(e.target.value) })}
            />
          </Field>
          <Field label="明细保留天数">
            <input
              className="input mono"
              type="number"
              min={1}
              value={draft.detailRetentionDays}
              onChange={(e) => update({ detailRetentionDays: Number(e.target.value) })}
            />
          </Field>
        </div>
        <div className="card__foot">
          <div className="cell-sub">
            models.dev 目录：
            {props.catalogFetchedAt ? fmtTime(props.catalogFetchedAt) : "尚未刷新"} · {props.models.length} 个模型
          </div>
          <div className="page__actions">
            <button className="btn btn--secondary btn--sm" type="button" disabled={props.refreshing} onClick={() => void props.refresh()}>
              <Icon name="refresh" /> {props.refreshing ? "刷新中…" : "刷新模型目录"}
            </button>
            <button className="btn btn--primary" type="button" disabled={props.saving} onClick={() => void props.save()}>
              {props.saving ? "保存中…" : "保存策略"}
            </button>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card__head">
          <div>
            <div className="card__title">有效阈值预览</div>
            <div className="card__sub">
              按当前模型窗口换算；定时增量阈值按会话历史动态计算，表中为无历史时的回退值
            </div>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Provider</th>
                <th>模型</th>
                <th>窗口</th>
                <th>全局阈值</th>
                <th>定时回退</th>
                <th>固定阈值</th>
                <th>keepRecent</th>
                <th>空闲</th>
              </tr>
            </thead>
            <tbody>
              {props.effective.map((m) => (
                <tr key={`${m.providerId}/${m.modelId}`}>
                  <td className="mono">{m.providerId}</td>
                  <td className="mono">{m.modelId}</td>
                  <td className="mono">{fmtTokens(m.contextWindow)}</td>
                  <td className="mono">
                    {s.global.enabled && m.globalThreshold ? fmtTokens(m.globalThreshold) : "—"}
                  </td>
                  <td className="mono">
                    {s.scheduledHeuristic.enabled && m.scheduledFallbackThreshold
                      ? fmtTokens(m.scheduledFallbackThreshold)
                      : "—"}
                  </td>
                  <td className="mono">
                    {s.fixed.enabled && m.fixedThreshold ? fmtTokens(m.fixedThreshold) : "—"}
                  </td>
                  <td className="mono">{fmtTokens(m.keepRecentTokens)}</td>
                  <td className="mono">{s.idle.enabled ? `${m.idleHours}h` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {warnModels.length > 0 && (
            <div className="cell-sub" style={{ color: "var(--warn)", padding: 8 }}>
              警告：{warnModels.length} 个模型的阈值接近窗口或 keepRecent 过大，可能无法有效压缩；请调低阈值或 keepRecent 上限。
            </div>
          )}
        </div>
      </div>
    </>
  );
}
