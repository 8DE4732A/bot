import { useEffect, useState } from "react";

import { api, isGatewayEvent } from "../api";
import { ConfirmButton, Empty, Field, Icon, Modal, fmtTime, useAsync, useToast } from "../components/ui";
import type { Agent, ScheduledTask } from "../types";

/**
 * 定时任务 2.0 (四期 §6.2 #5): 人话编辑器 (五模式平级, 模式切换保留已填
 * 状态——hermes ScheduleBuilder 映射 bot 的 once/every/cron 三类型) +
 * 手动触发 (防连点) + 下次运行倒计时 + SSE 静默刷新。
 */

type BuilderMode = "interval" | "daily" | "weekly" | "monthly" | "once" | "custom";

const MODE_LABELS: Record<BuilderMode, string> = {
  interval: "固定间隔",
  daily: "每天",
  weekly: "每周",
  monthly: "每月",
  once: "一次性",
  custom: "自定义 cron",
};

const WEEKDAYS = [
  { v: 1, label: "一" },
  { v: 2, label: "二" },
  { v: 3, label: "三" },
  { v: 4, label: "四" },
  { v: 5, label: "五" },
  { v: 6, label: "六" },
  { v: 0, label: "日" },
];

interface TaskForm {
  id?: string;
  agentId: string;
  name: string;
  prompt: string;
  mode: BuilderMode;
  intervalSeconds: number;
  time: string; // HH:MM (daily/weekly/monthly)
  weekday: number;
  monthDay: number;
  runAtLocal: string; // datetime-local (once)
  cronExpr: string;
  enabled: boolean;
  notifyEnabled: boolean;
}

function formFromTask(t: ScheduledTask): TaskForm {
  let mode: BuilderMode = "custom";
  let time = "09:00";
  let weekday = 1;
  let monthDay = 1;
  if (t.scheduleType === "every") mode = "interval";
  else if (t.scheduleType === "once") mode = "once";
  else if (t.cronExpr) {
    // 严格逆向 (R1 评审 B17): 五字段必须全为纯数字/单个 * 才映射人话模式——
    // */15、9-17、列表等复杂形态保持 custom, 否则保存时会被静默重写
    const parts = t.cronExpr.trim().split(/\s+/);
    const isPlainNum = (v: string) => /^\d{1,2}$/.test(v);
    if (parts.length === 5 && isPlainNum(parts[0]) && isPlainNum(parts[1])) {
      const [m, h, dom, mon, dow] = parts;
      if (dom === "*" && dow === "*" && mon === "*") {
        mode = "daily";
        time = `${h.padStart(2, "0")}:${m.padStart(2, "0")}`;
      } else if (dom === "*" && mon === "*" && isPlainNum(dow)) {
        mode = "weekly";
        time = `${h.padStart(2, "0")}:${m.padStart(2, "0")}`;
        weekday = Number(dow);
      } else if (dow === "*" && mon === "*" && isPlainNum(dom)) {
        mode = "monthly";
        time = `${h.padStart(2, "0")}:${m.padStart(2, "0")}`;
        monthDay = Number(dom);
      }
    }
  }
  return {
    id: t.id,
    agentId: t.agentId,
    name: t.name,
    prompt: t.prompt,
    mode,
    intervalSeconds: t.intervalSeconds ?? 3600,
    time,
    weekday,
    monthDay,
    runAtLocal: t.runAt ? new Date(t.runAt - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : "",
    cronExpr: t.cronExpr ?? "",
    enabled: t.enabled,
    notifyEnabled: t.notifyEnabled,
  };
}

function buildPayload(form: TaskForm): Record<string, unknown> {
  const [hh, mm] = form.time.split(":").map((x) => parseInt(x, 10) || 0);
  switch (form.mode) {
    case "interval":
      return { scheduleType: "every", intervalSeconds: form.intervalSeconds };
    case "daily":
      return { scheduleType: "cron", cronExpr: `${mm} ${hh} * * *` };
    case "weekly":
      return { scheduleType: "cron", cronExpr: `${mm} ${hh} * * ${form.weekday}` };
    case "monthly":
      return { scheduleType: "cron", cronExpr: `${mm} ${hh} ${form.monthDay} * *` };
    case "once": {
      const ts = form.runAtLocal ? new Date(form.runAtLocal).getTime() : 0;
      return { scheduleType: "once", runAt: ts };
    }
    case "custom":
      return { scheduleType: "cron", cronExpr: form.cronExpr };
  }
}

/** 下次运行倒计时 (分钟粒度, 每 30s 刷新) */
function useCountdown() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return (ts?: number): string => {
    if (!ts) return "—";
    const diff = ts - now;
    if (diff <= 0) return "即将触发";
    const min = Math.floor(diff / 60_000);
    if (min < 60) return `${min} 分钟后`;
    const h = Math.floor(min / 60);
    if (h < 48) return `${h} 小时 ${min % 60} 分后`;
    return `${Math.floor(h / 24)} 天后`;
  };
}

function TaskEditor({ agents, initial, onClose, onSaved }: {
  agents: Agent[];
  initial: TaskForm;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<TaskForm>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const set = (patch: Partial<TaskForm>) => setForm((f) => ({ ...f, ...patch }));

  const save = async () => {
    if (!form.name.trim() || !form.prompt.trim()) {
      setError("任务名与提示词必填");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const schedule = buildPayload(form);
      await api.saveScheduledTask({
        ...(form.id ? { id: form.id } : {}),
        agentId: form.agentId,
        name: form.name,
        prompt: form.prompt,
        enabled: form.enabled,
        notifyEnabled: form.notifyEnabled,
        ...schedule,
      } as any);
      toast(form.id ? "任务已更新" : "任务已创建");
      onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={form.id ? "编辑定时任务" : "新建定时任务"}
      onClose={onClose}
      foot={
        <>
          <span className="field__hint" style={{ flex: 1, color: "var(--risk)" }}>{error}</span>
          <button className="btn btn--secondary" onClick={onClose} disabled={saving}>取消</button>
          <button className="btn btn--primary" onClick={save} disabled={saving}>
            {saving ? "保存中…" : "保存"}
          </button>
        </>
      }
    >
      <Field label="任务名">
        <input className="input" value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="如: 每日站会摘要" />
      </Field>
      <Field label="执行 Agent">
        <select className="select" value={form.agentId} onChange={(e) => set({ agentId: e.target.value })}>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} ({a.id})
            </option>
          ))}
        </select>
      </Field>
      <Field label="提示词 (触发时发送给 Agent)">
        <textarea className="input" rows={3} value={form.prompt} onChange={(e) => set({ prompt: e.target.value })} />
      </Field>
      <Field label="调度模式" hint="模式切换保留已填状态; interval 最小 60s">
        <div className="chips">
          {(Object.keys(MODE_LABELS) as BuilderMode[]).map((m) => (
            <button
              key={m}
              className={`chip-btn${form.mode === m ? " is-active" : ""}`}
              onClick={() => set({ mode: m })}
              type="button"
            >
              {MODE_LABELS[m]}
            </button>
          ))}
        </div>
      </Field>

      {form.mode === "interval" && (
        <Field label="间隔 (秒)">
          <input
            className="input mono"
            type="number"
            min={60}
            value={form.intervalSeconds}
            onChange={(e) => set({ intervalSeconds: Number(e.target.value) })}
          />
        </Field>
      )}
      {(form.mode === "daily" || form.mode === "weekly" || form.mode === "monthly") && (
        <Field label="触发时间">
          <input className="input mono" style={{ width: 120 }} type="time" value={form.time} onChange={(e) => set({ time: e.target.value })} />
        </Field>
      )}
      {form.mode === "weekly" && (
        <Field label="星期">
          <div className="chips">
            {WEEKDAYS.map((w) => (
              <button key={w.v} type="button" className={`chip-btn${form.weekday === w.v ? " is-active" : ""}`} onClick={() => set({ weekday: w.v })}>
                {w.label}
              </button>
            ))}
          </div>
        </Field>
      )}
      {form.mode === "monthly" && (
        <Field label="日期 (几号)">
          <input className="input mono" style={{ width: 100 }} type="number" min={1} max={31} value={form.monthDay} onChange={(e) => set({ monthDay: Number(e.target.value) })} />
        </Field>
      )}
      {form.mode === "once" && (
        <Field label="触发时间">
          <input className="input mono" type="datetime-local" value={form.runAtLocal} onChange={(e) => set({ runAtLocal: e.target.value })} />
        </Field>
      )}
      {form.mode === "custom" && (
        <Field label="cron 表达式" hint="标准 5 字段 (本地时区): 分 时 日 月 星期">
          <input className="input mono" value={form.cronExpr} onChange={(e) => set({ cronExpr: e.target.value })} placeholder="0 9 * * 1-5" />
        </Field>
      )}

      <Field label="完成通知" hint="结果推送到创建会话所在渠道; 无渠道时兜底到 Agent 绑定渠道">
        <label className="switch">
          <input type="checkbox" checked={form.notifyEnabled} onChange={(e) => set({ notifyEnabled: e.target.checked })} />
          <span>{form.notifyEnabled ? "开启" : "关闭"}</span>
        </label>
      </Field>
    </Modal>
  );
}

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
  const agentsQ = useAsync(() => api.listAgents(), []);
  const toast = useToast();
  const countdown = useCountdown();
  const [editing, setEditing] = useState<TaskForm | null>(null);
  const [triggering, setTriggering] = useState<string | null>(null);

  const tasks = tasksQ.data ?? [];
  const agents = agentsQ.data ?? [];

  useEffect(() => {
    const onEvent = (e: Event) => {
      if (isGatewayEvent(e, "scheduler.completed", "task.updated")) tasksQ.reload();
    };
    window.addEventListener("bot:event", onEvent);
    return () => window.removeEventListener("bot:event", onEvent);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const remove = async (t: ScheduledTask) => {
    try {
      await api.deleteScheduledTask(t.id);
      toast(`已删除任务「${t.name}」`);
      tasksQ.reload();
    } catch (e) {
      toast(`删除失败: ${(e as Error).message}`, "risk");
    }
  };

  const trigger = async (t: ScheduledTask) => {
    if (triggering) return; // 防连点
    setTriggering(t.id);
    try {
      await api.triggerScheduledTask(t.id);
      toast(`已触发「${t.name}」, 结果稍后回填`);
      tasksQ.reload();
    } catch (e) {
      toast(`触发失败: ${(e as Error).message}`, "risk");
    } finally {
      setTriggering(null);
    }
  };

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <div className="eyebrow">Scheduler</div>
          <h1 className="page__title">定时任务</h1>
          <p className="page__desc">
            Agent 经 <span className="mono mono--plain">schedule_create</span> 创建, 或在此手动创建/编辑。
            触发时以所属 Agent 在专属任务会话中执行。删除为逻辑删除。
          </p>
        </div>
        <div className="page__actions">
          {agents.length > 0 && (
            <button
              className="btn btn--primary"
              onClick={() =>
                setEditing({
                  agentId: agents[0].id,
                  name: "",
                  prompt: "",
                  mode: "daily",
                  intervalSeconds: 3600,
                  time: "09:00",
                  weekday: 1,
                  monthDay: 1,
                  runAtLocal: "",
                  cronExpr: "",
                  enabled: true,
                  notifyEnabled: true,
                })
              }
            >
              <Icon name="plus" size={13} /> 新建任务
            </button>
          )}
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
          desc="给 Agent 选配「定时任务」技能让它自主创建, 或点击右上角手动新建。"
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
                  <span className="meta-val">
                    <span className="mono mono--plain">{t.nextRunAt ? fmtTime(t.nextRunAt) : "—"}</span>
                    {t.enabled && t.nextRunAt ? <span className="field__hint">{countdown(t.nextRunAt)}</span> : null}
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
                <div className="chips">
                  <button className="btn btn--secondary btn--sm" onClick={() => void trigger(t)} disabled={triggering === t.id}>
                    {triggering === t.id ? "触发中…" : "立即运行"}
                  </button>
                  <button className="btn btn--secondary btn--sm" onClick={() => setEditing(formFromTask(t))}>
                    <Icon name="pencil" size={11} /> 编辑
                  </button>
                </div>
                <ConfirmButton onConfirm={() => remove(t)} />
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <TaskEditor
          agents={agents}
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={() => tasksQ.reload()}
        />
      )}
    </div>
  );
}
