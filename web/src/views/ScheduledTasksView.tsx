import { api } from "../api";
import { ConfirmButton, Empty, Icon, fmtTime, useAsync, useToast } from "../components/ui";
import type { ScheduledTask } from "../types";

/** 调度的人话描述 */
function scheduleLabel(t: ScheduledTask): string {
  if (t.scheduleType === "once") return t.runAt ? `一次性 · ${fmtTime(t.runAt)}` : "一次性";
  if (t.scheduleType === "every") return `每 ${t.intervalSeconds}s`;
  return `cron · ${t.cronExpr}`;
}

const STATUS_BADGE: Record<string, string> = {
  ok: "badge badge--live",
  done: "badge badge--live",
  error: "badge badge--warn",
};

export function ScheduledTasksView() {
  const tasksQ = useAsync(() => api.listScheduledTasks(), []);
  const toast = useToast();

  const tasks = tasksQ.data ?? [];

  const remove = async (t: ScheduledTask) => {
    try {
      await api.deleteScheduledTask(t.id);
      toast(`已删除任务「${t.name}」`);
      tasksQ.reload();
    } catch (e) {
      toast(`删除失败: ${(e as Error).message}`, "risk");
    }
  };

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <div className="eyebrow">Scheduler</div>
          <h1 className="page__title">定时任务</h1>
          <p className="page__desc">
            由 Agent 经 <span className="mono">schedule_create</span> 工具创建。任务触发时以创建它的
            Agent 在专属任务会话中执行 prompt——重复触发复用同一会话。删除为逻辑删除。
          </p>
        </div>
        <div className="page__actions">
          <button className="btn btn--secondary" onClick={tasksQ.reload}>
            <Icon name="refresh" /> 刷新
          </button>
        </div>
      </div>

      {tasksQ.error ? (
        <Empty mark="ERROR" title="加载失败" desc={tasksQ.error} />
      ) : tasks.length === 0 && !tasksQ.loading ? (
        <Empty
          mark="NO TASKS"
          title="尚无定时任务"
          desc="给 Agent 选配「定时任务」技能后，它可以用 schedule_create 创建任务。"
        />
      ) : (
        <div className="grid">
          {tasks.map((t) => (
            <div key={t.id} className={`card card--rail ${t.enabled ? "live" : "warn"}`}>
              <div className="card__head">
                <div className="card__ident mono mono--plain">⏱</div>
                <div className="card__title-wrap">
                  <div className="card__title">
                    {t.name}
                    <span className="mono mono--plain">{t.id}</span>
                  </div>
                  <div className="card__sub">
                    Agent <span className="mono mono--plain">{t.agentId}</span> · 已执行 {t.runCount} 次
                  </div>
                </div>
              </div>

              <div className="card__body">{t.prompt}</div>

              <div className="meta-list">
                <div className="meta-row">
                  <span className="meta-label">调度</span>
                  <span className="meta-val">
                    <span className="mono mono--plain">{scheduleLabel(t)}</span>
                    {t.enabled ? (
                      <span className="badge badge--live">
                        <span className="dot" /> 启用
                      </span>
                    ) : (
                      <span className="badge badge--warn">停用</span>
                    )}
                  </span>
                </div>
                <div className="meta-row">
                  <span className="meta-label">下次触发</span>
                  <span className="meta-val mono mono--plain">
                    {t.nextRunAt ? fmtTime(t.nextRunAt) : "—"}
                  </span>
                </div>
                <div className="meta-row">
                  <span className="meta-label">最近执行</span>
                  <span className="meta-val">
                    <span className="mono mono--plain">{t.lastRunAt ? fmtTime(t.lastRunAt) : "—"}</span>
                    {t.lastStatus ? (
                      <span className={`badge ${STATUS_BADGE[t.lastStatus] ?? "badge"}`}>{t.lastStatus}</span>
                    ) : null}
                  </span>
                </div>
                {t.lastResult ? (
                  <div className="meta-row">
                    <span className="meta-label">结果</span>
                    <span
                      className="meta-val mono mono--plain"
                      style={{ maxWidth: 420, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                      title={t.lastResult}
                    >
                      {t.lastResult}
                    </span>
                  </div>
                ) : null}
                <div className="meta-row">
                  <span className="meta-label">通知</span>
                  <span className="meta-val">
                    {t.notifyEnabled && t.notifyChannelInstanceId ? (
                      <span className="mono mono--plain">
                        {t.notifyChannelInstanceId} : {t.notifyPeerId}
                      </span>
                    ) : t.notifyEnabled ? (
                      <span className="field__hint">Agent 绑定渠道兜底</span>
                    ) : (
                      <span className="field__hint">已关闭</span>
                    )}
                  </span>
                </div>
              </div>

              <div className="card__foot">
                <div />
                <ConfirmButton onConfirm={() => remove(t)} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
