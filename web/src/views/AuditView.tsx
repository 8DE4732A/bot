import { useEffect, useState } from "react";

import { api, isGatewayEvent } from "../api";
import { Empty, Icon, fmtTime } from "../components/ui";
import type { AuditLog, AuditPage } from "../types";

/**
 * 审计页 2.0 (四期 §6.2 #4): 事件类型 × Agent × 时间范围组合过滤 +
 * 分页 + 同型重复聚合 + 严重度着色。SSE 静默刷新 (audit.recorded)。
 */

const PAGE_SIZE = 50;

/** 严重度语义: risk=拦截/错误, warn=尝试/告警, ink=普通记录 */
function severityOf(eventType: string): { cls: string; label: string } {
  if (/blocked|denied|violation|error|refused|failed/.test(eventType)) return { cls: "badge badge--risk", label: "拦截" };
  if (/sandbox|warn|retry|timeout/.test(eventType)) return { cls: "badge badge--warn", label: "警告" };
  return { cls: "badge badge--ink", label: "记录" };
}

function prettyDetails(raw: string): string {
  try {
    const obj = JSON.parse(raw);
    return JSON.stringify(obj, null, 2);
  } catch {
    return raw;
  }
}

/** 连续同型事件聚合 (sysctl-read 噪音折叠 ×N): 窗口 60s 内同 event+agent 合并 */
interface Aggregated extends AuditLog {
  count: number;
}

function aggregate(logs: AuditLog[]): Aggregated[] {
  const out: Aggregated[] = [];
  for (const l of logs) {
    const last = out[out.length - 1];
    // DESC 序: last 是较新一条, l 是较旧一条——差值取绝对值 (R1 评审 B16:
    // 方向写反会让相隔数月的同类事件被错误折叠)
    if (last && last.eventType === l.eventType && last.agentId === l.agentId && Math.abs(l.createdAt - last.createdAt) <= 60_000) {
      last.count++;
      // last 保持较新时间 (DESC 序; R2 评审 M-8: 不向旧时间滚动)
    } else {
      out.push({ ...l, count: 1 });
    }
  }
  return out;
}

export function AuditView() {
  const [eventFilter, setEventFilter] = useState("");
  const [agentFilter, setAgentFilter] = useState("");
  const [hours, setHours] = useState(0); // 0 = 全部
  const [page, setPage] = useState(0);
  const [pageData, setPageData] = useState<AuditPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = (p = page) => {
    setLoading(true);
    api
      .auditLogsFiltered({
        event: eventFilter || undefined,
        agentId: agentFilter || undefined,
        since: hours > 0 ? Date.now() - hours * 3600_000 : undefined,
        limit: PAGE_SIZE,
        offset: p * PAGE_SIZE,
      })
      .then((data) => {
        setPageData(data);
        setError(null);
      })
      .catch((e) => setError(String(e.message ?? e)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load(0);
    setPage(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventFilter, agentFilter, hours]);

  // SSE 静默刷新: 仅在无过滤条件的第一页跟随 (有过滤/翻页时刷新会跳走用户视角)
  useEffect(() => {
    const onEvent = (e: Event) => {
      if (isGatewayEvent(e, "audit.recorded") && page === 0 && !eventFilter && !agentFilter && hours === 0) load(0);
    };
    window.addEventListener("bot:event", onEvent);
    return () => window.removeEventListener("bot:event", onEvent);
  }); // 每次渲染重挂 (捕获最新 page/过滤态)

  const logs = pageData?.items ?? [];
  const total = pageData?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <div className="eyebrow">Sandbox Audit</div>
          <h1 className="page__title">沙盒审计日志</h1>
          <p className="page__desc">
            应用层路径拦截、内核级 ASRT 沙盒事件与平台操作审计。共 <span className="mono mono--plain">{total}</span> 条
            (60s 内同型重复已折叠)。
          </p>
        </div>
        <div className="page__actions">
          <button className="btn btn--secondary" onClick={() => load()}>
            <Icon name="refresh" size={13} /> 刷新
          </button>
        </div>
      </div>

      <div className="audit-filters">
        <input
          className="input"
          style={{ width: 200 }}
          placeholder="事件类型前缀… (如 sandbox.)"
          value={eventFilter}
          onChange={(e) => setEventFilter(e.target.value)}
        />
        <input
          className="input"
          style={{ width: 180 }}
          placeholder="Agent id…"
          value={agentFilter}
          onChange={(e) => setAgentFilter(e.target.value)}
        />
        <select className="select" style={{ width: 150 }} value={hours} onChange={(e) => setHours(Number(e.target.value))}>
          <option value={0}>全部时间</option>
          <option value={1}>最近 1 小时</option>
          <option value={24}>最近 24 小时</option>
          <option value={168}>最近 7 天</option>
        </select>
      </div>

      {error ? (
        <Empty mark="ERROR" title="加载失败" desc={error} />
      ) : logs.length === 0 && !loading ? (
        <Empty mark="NO EVENTS" title="暂无审计事件" desc="调整过滤条件或等待新事件。" />
      ) : (
        <div className={`table-wrap${loading ? " is-refreshing" : ""}`}>
          <table>
            <thead>
              <tr>
                <th style={{ width: 140 }}>时间</th>
                <th style={{ width: 210 }}>事件类型</th>
                <th style={{ width: 150 }}>触发主体</th>
                <th style={{ width: 60 }}>次数</th>
                <th>详情</th>
              </tr>
            </thead>
            <tbody>
              {aggregate(logs).map((l) => {
                const sev = severityOf(l.eventType);
                return (
                  <tr key={l.id}>
                    <td className="mono mono--plain">{fmtTime(l.createdAt)}</td>
                    <td>
                      <span className={sev.cls}>{l.eventType}</span>
                    </td>
                    <td>
                      <div className="cell-main mono mono--plain">{l.agentId || "system"}</div>
                      {l.channelInstanceId ? (
                        <div className="cell-sub mono mono--plain">via {l.channelInstanceId}</div>
                      ) : null}
                    </td>
                    <td className="mono mono--plain">{l.count > 1 ? `×${l.count}` : "—"}</td>
                    <td>
                      <pre
                        className="mono mono--plain"
                        style={{
                          margin: 0,
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-all",
                          fontSize: "0.76rem",
                          color: "var(--ink-2)",
                        }}
                      >
                        {prettyDetails(l.details)}
                      </pre>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 && (
        <div className="pager">
          <button className="btn btn--secondary btn--sm" disabled={page === 0} onClick={() => { const p = page - 1; setPage(p); load(p); }}>
            上一页
          </button>
          <span className="mono mono--plain">
            {page + 1} / {totalPages}
          </span>
          <button
            className="btn btn--secondary btn--sm"
            disabled={page >= totalPages - 1}
            onClick={() => {
              const p = page + 1;
              setPage(p);
              load(p);
            }}
          >
            下一页
          </button>
        </div>
      )}
    </div>
  );
}
