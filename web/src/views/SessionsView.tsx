import { useEffect, useRef, useState } from "react";

import { api, isGatewayEvent } from "../api";
import { Empty, Icon, fmtTime } from "../components/ui";
import type { SessionHistory, SessionRow } from "../types";

/**
 * 会话浏览页 (四期 §6.2 #1): channel_sessions 列表 → 只读时间线
 * (role 着色 + 工具调用折叠) + 全文搜索。来源渠道着色区分。
 */

const SOURCE_COLORS: Record<string, string> = {
  terminal: "#0e7a68",
  feishu: "#3370ff",
  qq: "#12b7f5",
  weixin: "#2aae67",
  wecom: "#0066ff",
  telegram: "#2ea6dd",
};

function sourceBadge(channelInstanceId: string): { label: string; color: string } {
  const type = channelInstanceId.split("-")[0] ?? channelInstanceId;
  return { label: channelInstanceId, color: SOURCE_COLORS[type] ?? "#8f929a" };
}

function fmtPeer(peerId: string): string {
  return peerId.length > 28 ? `${peerId.slice(0, 25)}…` : peerId;
}

function Timeline({ history }: { history: SessionHistory }) {
  if (history.messages.length === 0) {
    return (
      <div style={{ color: "var(--ink-3)", padding: "24px 0", textAlign: "center" }}>
        该会话暂无可读消息 (可能尚未对话, 或仅含压缩交接记录)
      </div>
    );
  }
  return (
    <div className="timeline">
      {history.truncated && (
        <div className="timeline__handoff">…更早的消息已截断 (只读预览保留最近一段)</div>
      )}
      {history.messages.map((m, i) => {
        if (m.role === "handoff") {
          return (
            <div key={i} className="timeline__handoff">
              ⇅ {m.text}
            </div>
          );
        }
        if (m.role === "user") {
          return (
            <div key={i} className="timeline__row timeline__row--user">
              <span className="timeline__who">用户</span>
              <div className="timeline__bubble timeline__bubble--user">{m.text}</div>
            </div>
          );
        }
        if (m.role === "assistant") {
          return (
            <div key={i} className="timeline__row timeline__row--agent">
              <span className="timeline__who">Agent</span>
              <div className="timeline__bubble timeline__bubble--agent">{m.text}</div>
            </div>
          );
        }
        // 工具调用: 折叠为 muted 行 (点击展开全文)
        return (
          <details key={i} className="timeline__tool">
            <summary>🔧 {m.toolName ?? "tool"}</summary>
            <pre className="timeline__tool-out">{m.text}</pre>
          </details>
        );
      })}
    </div>
  );
}

export function SessionsView() {
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<SessionRow | null>(null);
  const [history, setHistory] = useState<SessionHistory | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<{ conversationId: number; snippet: string }[] | null>(null);
  const detailRef = useRef<HTMLDivElement>(null);

  const load = () => {
    api
      .listSessions()
      .then((rows) => {
        setSessions(rows);
        setError(null);
      })
      .catch((e) => setError(String(e.message ?? e)));
  };

  useEffect(load, []);

  // SSE 静默刷新: chat.turn 完成即刷新列表 (跳 spinner 保滚动)
  useEffect(() => {
    const onEvent = (e: Event) => {
      if (isGatewayEvent(e, "chat.turn", "audit.recorded")) load();
    };
    window.addEventListener("bot:event", onEvent);
    return () => window.removeEventListener("bot:event", onEvent);
  }, []);

  const open = async (row: SessionRow) => {
    setSelected(row);
    setHistory(null);
    setHistoryLoading(true);
    try {
      setHistory(await api.sessionHistory(row.conversationId));
    } catch (e) {
      setHistory({ conversationId: Number(row.conversationId), messages: [], truncated: false });
    } finally {
      setHistoryLoading(false);
    }
  };

  // 历史加载完成后滚到最底 (会话可能很长, 最新消息在底部)
  useEffect(() => {
    if (history && !historyLoading) {
      requestAnimationFrame(() => {
        detailRef.current?.scrollTo({ top: detailRef.current.scrollHeight });
      });
    }
  }, [history, historyLoading, selected]);

  const search = async () => {
    const q = query.trim();
    if (!q) {
      setHits(null);
      return;
    }
    try {
      const result = await api.searchSessions(q);
      setHits(result);
      // 命中第一条自动打开
      if (result.length > 0) {
        const target = sessions?.find((s) => Number(s.conversationId) === result[0].conversationId);
        if (target) await open(target);
      }
    } catch {
      setHits([]);
    }
  };

  const error0 = error;
  return (
    <div className="page" style={{ maxWidth: 1180 }}>
      <div className="page__head">
        <div>
          <div className="eyebrow">Sessions</div>
          <h1 className="page__title">会话浏览</h1>
          <p className="page__desc">
            全渠道会话映射 (终端 / IM / Web / 调度) 与只读对话时间线。
            <span className="mono mono--plain">conversations.sqlite</span> 为框架专属库, 此处仅读不写。
          </p>
        </div>
        <div className="page__actions">
          <div className="searchbar">
            <Icon name="search" size={13} />
            <input
              className="searchbar__input"
              placeholder="全文搜索会话内容…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void search();
              }}
            />
          </div>
          <button className="btn btn--secondary" onClick={load}>
            <Icon name="refresh" size={13} /> 刷新
          </button>
        </div>
      </div>

      {hits !== null && (
        <div className="searchbar__hits">
          {hits.length === 0 ? (
            <span className="field__hint">无命中</span>
          ) : (
            hits.slice(0, 8).map((h) => (
              <button
                key={h.conversationId}
                className="searchbar__hit"
                onClick={() => {
                  const target = sessions?.find((s) => Number(s.conversationId) === h.conversationId);
                  if (target) void open(target);
                }}
              >
                会话 #{h.conversationId}: {h.snippet.slice(0, 80)}
              </button>
            ))
          )}
        </div>
      )}

      {error0 ? (
        <Empty mark="ERROR" title="加载失败" desc={error0} />
      ) : (
        <div className="sessions-layout">
          <div className="sessions-list">
            {(sessions ?? []).map((row) => {
              const badge = sourceBadge(row.channelInstanceId);
              const active = selected === row;
              return (
                <button
                  key={`${row.channelInstanceId}:${row.peerId}`}
                  className={`session-row${active ? " is-active" : ""}`}
                  onClick={() => void open(row)}
                >
                  <span className="session-row__dot" style={{ background: badge.color }} />
                  <span className="session-row__main">
                    <span className="session-row__peer mono mono--plain">{fmtPeer(row.peerId)}</span>
                    <span className="session-row__meta">
                      {badge.label} · {row.agentId}
                    </span>
                  </span>
                  <span className="session-row__time mono mono--plain">{fmtTime(row.lastActiveAt)}</span>
                </button>
              );
            })}
            {sessions?.length === 0 && (
              <Empty mark="NO SESSIONS" title="暂无会话" desc="与 Agent 对话后, 会话映射会出现在这里。" />
            )}
          </div>

          <div className="sessions-detail" ref={detailRef}>
            {selected ? (
              <>
                <div className="sessions-detail__head">
                  <span className="mono mono--plain">
                    {selected.channelInstanceId}:{selected.peerId}
                  </span>
                  <span className="field__hint">
                    conversation #{selected.conversationId} · agent {selected.agentId}
                  </span>
                </div>
                {historyLoading ? (
                  <div style={{ color: "var(--ink-3)", padding: 20 }}>加载中…</div>
                ) : history ? (
                  <Timeline history={history} />
                ) : null}
              </>
            ) : (
              <Empty mark="SELECT" title="选择左侧会话" desc="查看该会话的只读时间线 (对话、工具调用与压缩交接)。" />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
