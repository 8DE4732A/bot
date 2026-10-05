import { api } from "../api";
import { Empty, Icon, fmtTime, useAsync } from "../components/ui";

/** 尝试把 details 字符串格式化为可读 JSON；失败则原样展示 */
function prettyDetails(raw: string): string {
  try {
    const obj = JSON.parse(raw);
    return JSON.stringify(obj, null, 2);
  } catch {
    return raw;
  }
}

export function AuditView() {
  const q = useAsync(() => api.listAuditLogs(), []);
  const logs = q.data ?? [];

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <div className="eyebrow">Sandbox Audit</div>
          <h1 className="page__title">沙盒审计日志</h1>
          <p className="page__desc">
            应用层路径拦截（越界读写、非法写入）与内核级 ASRT 沙盒事件的完整记录，最近 100 条。
          </p>
        </div>
        <div className="page__actions">
          <button className="btn btn--secondary" onClick={q.reload}>
            <Icon name="refresh" size={13} /> 刷新
          </button>
        </div>
      </div>

      {q.error ? (
        <Empty mark="ERROR" title="加载失败" desc={q.error} />
      ) : logs.length === 0 && !q.loading ? (
        <Empty
          mark="NO EVENTS"
          title="暂无审计事件"
          desc="沙盒拦截的每一次越界读取、非法写入与出网尝试都会记录在此。"
        />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th style={{ width: 140 }}>时间</th>
                <th style={{ width: 190 }}>事件类型</th>
                <th style={{ width: 150 }}>触发主体</th>
                <th>详情</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((l) => (
                <tr key={l.id}>
                  <td className="mono mono--plain">{fmtTime(l.createdAt)}</td>
                  <td>
                    <span className="badge badge--warn">{l.eventType}</span>
                  </td>
                  <td>
                    <div className="cell-main mono mono--plain">{l.agentId || "system"}</div>
                    {l.channelInstanceId ? (
                      <div className="cell-sub mono mono--plain">via {l.channelInstanceId}</div>
                    ) : null}
                  </td>
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
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
