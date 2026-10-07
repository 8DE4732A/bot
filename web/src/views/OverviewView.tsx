import { useEffect } from "react";

import { api, isGatewayEvent } from "../api";
import { Empty, Icon, KindBadge, fmtTime, fmtUptime, initials, useAsync } from "../components/ui";

export function OverviewView({ onNavigate }: { onNavigate: (v: string) => void }) {
  const statusQ = useAsync(() => api.status(), []);
  const agentsQ = useAsync(() => api.listAgents(), []);
  const providersQ = useAsync(() => api.listProviders(), []);
  const skillsQ = useAsync(() => api.listSkills(), []);
  const auditQ = useAsync(() => api.auditLogsFiltered({ limit: 50 }), []);

  // 事件流静默刷新 (§6.2): 审计落库/渠道状态变化即重拉, 无手动刷新按钮
  useEffect(() => {
    const onEvent = (e: Event) => {
      if (isGatewayEvent(e, "channel.status", "channel.health", "chat.turn")) {
        statusQ.reload();
      }
      if (isGatewayEvent(e, "audit.recorded")) {
        statusQ.reload();
        auditQ.reload();
      }
    };
    window.addEventListener("bot:event", onEvent);
    return () => window.removeEventListener("bot:event", onEvent);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const status = statusQ.data;
  const agents = agentsQ.data ?? [];
  const providers = providersQ.data ?? [];
  const skills = skillsQ.data ?? [];
  const audits = auditQ.data?.items ?? [];

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <div className="eyebrow">Overview</div>
          <h1 className="page__title">运行概览</h1>
          <p className="page__desc">
            {status ? (
              <>
                工作目录 <span className="mono">{status.cwd}</span> · 平台{" "}
                <span className="mono mono--plain">{status.platform}</span>
              </>
            ) : (
              "多 Agent 沙盒对话平台的运行状态总览。"
            )}
          </p>
        </div>
        <div className="page__actions">
          <button className="btn btn--primary" onClick={() => onNavigate("agents")}>
            <Icon name="plus" /> 新建 Agent
          </button>
        </div>
      </div>

      <div className="stat-strip">
        <div className="stat">
          <div className="stat__label">Agent</div>
          <div className="stat__val">{status?.stats.agentsCount ?? agents.length}</div>
        </div>
        <div className="stat">
          <div className="stat__label">模型服务商</div>
          <div className="stat__val">{status?.stats.providersCount ?? providers.length}</div>
        </div>
        <div className="stat">
          <div className="stat__label">对话渠道</div>
          <div className="stat__val">{status?.stats.channelsCount ?? "—"}</div>
        </div>
        <div className="stat">
          <div className="stat__label">沙盒拦截事件</div>
          <div className="stat__val">{status?.stats.auditCount ?? audits.length}</div>
        </div>
        <div className="stat">
          <div className="stat__label">运行时长</div>
          <div className="stat__val">
            {status ? fmtUptime(status.uptime) : "—"}
          </div>
        </div>
      </div>

      <div className="section-title">Agent 运行状态</div>
      {agents.length === 0 ? (
        <Empty
          mark="NO AGENTS"
          title="还没有 Agent"
          desc="新建 Agent 后，这里会展示每个实例的模型与沙盒状态。"
        />
      ) : (
        <div className="grid">
          {agents.map((a) => {
            const provName = providers.find((p) => p.id === a.model.provider)?.name ?? a.model.provider;
            return (
              <button
                key={a.id}
                className={`card card--rail ${a.sandbox.enabled ? "live" : "warn"}`}
                style={{ textAlign: "left", cursor: "pointer" }}
                onClick={() => onNavigate("agents")}
              >
                <div className="card__head">
                  <div className="card__ident">{initials(a.name)}</div>
                  <div className="card__title-wrap">
                    <div className="card__title">{a.name}</div>
                    <div className="card__sub mono mono--plain">{a.id}</div>
                  </div>
                  <span style={{ marginLeft: "auto" }}>
                    {a.sandbox.enabled ? (
                      <span className="badge badge--live">
                        <span className="dot" /> 沙盒开启
                      </span>
                    ) : (
                      <span className="badge badge--warn">沙盒关闭</span>
                    )}
                  </span>
                </div>
                <div className="meta-list">
                  <div className="meta-row">
                    <span className="meta-label">模型</span>
                    <span className="meta-val">
                      <span className="mono mono--plain">{provName}</span>
                      <span className="mono">{a.model.modelId}</span>
                    </span>
                  </div>
                  <div className="meta-row">
                    <span className="meta-label">技能</span>
                    <span className="meta-val">
                      {a.skills.length > 0 ? a.skills.length + " 项" : "—"}
                    </span>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}

      <div className="section-title" style={{ display: "flex" }}>
        最近沙盒事件
        {audits.length > 0 ? (
          <button
            className="btn btn--ghost btn--sm"
            style={{ marginLeft: "auto" }}
            onClick={() => onNavigate("audit")}
          >
            查看全部 →
          </button>
        ) : null}
      </div>
      {audits.length === 0 ? (
        <Empty mark="NO EVENTS" title="暂无拦截记录" desc="沙盒运行正常，尚无越界读取或非法出网被拦截。" />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th style={{ width: 130 }}>时间</th>
                <th style={{ width: 170 }}>事件</th>
                <th>主体</th>
                <th>详情</th>
              </tr>
            </thead>
            <tbody>
              {audits.slice(0, 5).map((l) => (
                <tr key={l.id}>
                  <td className="mono mono--plain">{fmtTime(l.createdAt)}</td>
                  <td>
                    <span className="badge badge--warn">{l.eventType}</span>
                  </td>
                  <td>
                    <span className="mono mono--plain">{l.agentId || "system"}</span>
                  </td>
                  <td className="mono mono--plain" style={{ maxWidth: 380, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {l.details}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="section-title">技能库 · {skills.length} 项</div>
      <div className="grid">
        {skills.map((s) => {
          const users = agents.filter((a) => a.skills.includes(s.id));
          return (
            <div key={s.id} className="card">
              <div className="card__head">
                <div className="card__title-wrap">
                  <div className="card__title">
                    {s.name}
                    <span className="mono mono--plain">{s.id}</span>
                  </div>
                  <div className="card__sub">{s.builtin ? "内置技能" : "本地扩展"}</div>
                </div>
                <KindBadge kind={s.kind} />
              </div>
              <div className="card__body">{s.description}</div>
              {s.warnings && s.warnings.length > 0 ? (
                <div className="card__body" style={{ color: "var(--warn, #b45309)", fontSize: "0.78rem" }}>
                  ⚠ {s.warnings.join("；")}
                </div>
              ) : null}
              <div className="meta-row">
                <span className="meta-label">已启用</span>
                <span className="meta-val">
                  {users.length > 0 ? (
                    users.map((a) => <span key={a.id} className="mono mono--plain">{a.name}</span>)
                  ) : (
                    <span className="field__hint">暂无 Agent 启用</span>
                  )}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
