import { randomBytes } from "node:crypto";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import type { ScheduleType, ScheduledTaskDefinition } from "../config/database-store.ts";
import { DatabaseStore } from "../config/database-store.ts";
import { AgentManager } from "../core/agent-manager.ts";
import { MIN_INTERVAL_SECONDS, computeNextRunAt, validateCronExpr } from "./schedule.ts";

/**
 * 系统级定时任务工具组 (呈现为技能 scheduler, 无需外部 MCP server):
 * - 任务归属创建它的 Agent——归属由宿主从 conversationId 反查 (fail-closed),
 *   模型无法伪造; list/update/delete 只作用于本 Agent 的任务;
 * - 触发时由 SchedulerManager 以创建任务的 Agent 跑任务会话,
 *   sessionKey = `scheduler:<taskId>`——重复触发复用同一会话 (上下文连续);
 * - 删除为逻辑删除 (deleted_at 置位), 记录保留。
 */

/** 归属解析: 会话 → Agent (拿不到即拒绝——归属不明的会话不得创建任务) */
function resolveAgentId(api: ToolExecutionApi): string {
  const agentId = AgentManager.getInstance().getAgentIdForConversation(String(api.conversationId));
  if (!agentId) {
    throw new Error("Unable to resolve the calling agent for this conversation; task refused");
  }
  return agentId;
}

const SCHEDULE_DESC = {
  runAt: Type.Optional(
    Type.String({ description: 'For scheduleType "once": trigger time as ISO 8601 (e.g. "2026-10-05T09:00:00" local time or with Z)' }),
  ),
  intervalSeconds: Type.Optional(
    Type.Number({ description: `For scheduleType "every": repeat interval in seconds (minimum ${MIN_INTERVAL_SECONDS})` }),
  ),
  cronExpr: Type.Optional(
    Type.String({ description: 'For scheduleType "cron": standard 5-field cron expression in local time (e.g. "0 9 * * *" = daily 09:00)' }),
  ),
};

function parseRunAt(input: string): number | undefined {
  const ts = new Date(input).getTime();
  return Number.isFinite(ts) ? ts : undefined;
}

/** 校验并归一化调度参数; 返回错误消息或 undefined */
function validateSchedule(
  scheduleType: ScheduleType,
  runAt?: string,
  intervalSeconds?: number,
  cronExpr?: string,
): string | undefined {
  switch (scheduleType) {
    case "once":
      if (!runAt) return '"once" requires runAt (ISO 8601)';
      if (!parseRunAt(runAt)) return `runAt is not a valid ISO date: ${runAt}`;
      // 过期 once 任务永不触发 (nextRunAt=null 却 enabled)——直接拒绝, 模型需给出未来时间
      if ((parseRunAt(runAt) ?? 0) <= Date.now() + 1000) {
        return `runAt is in the past: ${runAt}. Provide a future time (check current time first)`;
      }
      return undefined;
    case "every":
      if (intervalSeconds === undefined) return '"every" requires intervalSeconds';
      if (intervalSeconds < MIN_INTERVAL_SECONDS)
        return `intervalSeconds must be >= ${MIN_INTERVAL_SECONDS}`;
      return undefined;
    case "cron":
      if (!cronExpr) return '"cron" requires cronExpr';
      return validateCronExpr(cronExpr);
    default:
      return `Unknown scheduleType: ${scheduleType}`;
  }
}

function buildScheduleFields(
  scheduleType: ScheduleType,
  runAt?: string,
  intervalSeconds?: number,
  cronExpr?: string,
) {
  return {
    scheduleType,
    runAt: scheduleType === "once" ? parseRunAt(runAt!) : undefined,
    intervalSeconds: scheduleType === "every" ? intervalSeconds : undefined,
    cronExpr: scheduleType === "cron" ? cronExpr : undefined,
  };
}

function taskSummary(t: ScheduledTaskDefinition) {
  return {
    id: t.id,
    name: t.name,
    prompt: t.prompt,
    scheduleType: t.scheduleType,
    schedule:
      t.scheduleType === "once"
        ? `once at ${new Date(t.runAt ?? 0).toISOString()}`
        : t.scheduleType === "every"
          ? `every ${t.intervalSeconds}s`
          : `cron "${t.cronExpr}"`,
    enabled: t.enabled,
    nextRunAt: t.nextRunAt ? new Date(t.nextRunAt).toISOString() : null,
    lastRunAt: t.lastRunAt ? new Date(t.lastRunAt).toISOString() : null,
    lastStatus: t.lastStatus ?? null,
    lastResult: t.lastResult ?? null,
    runCount: t.runCount,
    notify: {
      enabled: t.notifyEnabled,
      target: t.notifyChannelInstanceId ? `${t.notifyChannelInstanceId}:${t.notifyPeerId}` : null,
    },
  };
}

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });

const createTaskTool = defineTool({
  name: "schedule_create",
  description:
    "Create a scheduled task. When it triggers, your agent receives the prompt in a dedicated task session (recurring triggers reuse the same session); the result is pushed back to the channel where the task was created. Returns the created task.",
  parameters: Type.Object({
    name: Type.String({ description: "Short human-readable task name" }),
    prompt: Type.String({ description: "Message sent to the agent on every trigger (self-contained instructions)" }),
    scheduleType: Type.Union([Type.Literal("once"), Type.Literal("every"), Type.Literal("cron")], {
      description: '"once" = one-off at runAt; "every" = fixed interval; "cron" = cron expression',
    }),
    ...SCHEDULE_DESC,
    enabled: Type.Optional(Type.Boolean({ description: "Default true; false creates the task paused" })),
    notifyEnabled: Type.Optional(
      Type.Boolean({ description: "Default true; push each run's result to the channel where this task was created" }),
    ),
  }),
  async execute(args, api) {
    const agentId = resolveAgentId(api);
    const error = validateSchedule(args.scheduleType, args.runAt, args.intervalSeconds, args.cronExpr);
    if (error) return text({ error });
    const store = new DatabaseStore();
    const now = Date.now();
    // 通知目标 = 创建任务的会话所在渠道 (渠道层寻址, 会话重置不影响投递)
    const originSession = store.getSessionByConversation(String(api.conversationId));
    const task: ScheduledTaskDefinition = {
      id: `task-${now.toString(36)}-${randomBytes(3).toString("hex")}`,
      agentId,
      name: args.name.trim() || "unnamed task",
      prompt: args.prompt,
      ...buildScheduleFields(args.scheduleType, args.runAt, args.intervalSeconds, args.cronExpr),
      enabled: args.enabled !== false,
      notifyChannelInstanceId: originSession?.channelInstanceId,
      notifyPeerId: originSession?.peerId,
      notifyEnabled: args.notifyEnabled !== false,
      runCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    task.nextRunAt = computeNextRunAt(task, now);
    store.saveScheduledTask(task);
    store.recordAudit("scheduler.task_created", {
      taskId: task.id,
      agentId,
      scheduleType: task.scheduleType,
      notifyTarget: originSession ? `${originSession.channelInstanceId}:${originSession.peerId}` : null,
    });
    return text({ task: taskSummary(task) });
  },
});

const listTasksTool = defineTool({
  name: "schedule_list",
  description: "List your agent's scheduled tasks (including deleted=false only).",
  parameters: Type.Object({}),
  async execute(_args, api) {
    const agentId = resolveAgentId(api);
    const tasks = new DatabaseStore().listScheduledTasks(agentId);
    return text({ tasks: tasks.map(taskSummary) });
  },
});

const updateTaskTool = defineTool({
  name: "schedule_update",
  description:
    "Update one of your scheduled tasks (only fields provided change). Changing the schedule recomputes the next run time from now.",
  parameters: Type.Object({
    taskId: Type.String({ description: "Task id from schedule_create / schedule_list" }),
    name: Type.Optional(Type.String()),
    prompt: Type.Optional(Type.String()),
    scheduleType: Type.Optional(Type.Union([Type.Literal("once"), Type.Literal("every"), Type.Literal("cron")])),
    ...SCHEDULE_DESC,
    enabled: Type.Optional(Type.Boolean({ description: "Pause (false) or resume (true) the task" })),
    notifyEnabled: Type.Optional(Type.Boolean({ description: "Enable/disable pushing run results to the origin channel" })),
  }),
  async execute(args, api) {
    const agentId = resolveAgentId(api);
    const store = new DatabaseStore();
    const task = store.getScheduledTask(args.taskId);
    if (!task) return text({ error: `Task not found: ${args.taskId}` });
    if (task.agentId !== agentId) return text({ error: `Task '${args.taskId}' belongs to another agent` });

    const scheduleType = (args.scheduleType ?? task.scheduleType) as ScheduleType;
    // 未提供的字段沿用任务现值参与校验
    const effectiveRunAt = args.scheduleType || args.runAt ? args.runAt : task.runAt ? new Date(task.runAt).toISOString() : undefined;
    const effectiveInterval = args.scheduleType || args.intervalSeconds !== undefined ? args.intervalSeconds : task.intervalSeconds;
    const effectiveCron = args.scheduleType || args.cronExpr ? args.cronExpr : task.cronExpr;
    // 只在调度字段被触碰 (或恢复启用) 时校验——已过期 once 任务仅改 name 不应误伤
    const resumed = args.enabled === true && !task.enabled;
    if (args.scheduleType !== undefined || args.runAt !== undefined || args.intervalSeconds !== undefined || args.cronExpr !== undefined || resumed) {
      const error = validateSchedule(scheduleType, effectiveRunAt, effectiveInterval, effectiveCron);
      if (error) return text({ error });
    }

    // 调度字段的最终形态 (一次构建, 校验/变化判定/重算共用)
    const scheduleFields = buildScheduleFields(scheduleType, effectiveRunAt, effectiveInterval, effectiveCron);
    const scheduleChanged =
      scheduleFields.scheduleType !== task.scheduleType ||
      scheduleFields.runAt !== task.runAt ||
      scheduleFields.intervalSeconds !== task.intervalSeconds ||
      scheduleFields.cronExpr !== task.cronExpr;

    const updated: ScheduledTaskDefinition = {
      ...task,
      name: args.name?.trim() || task.name,
      prompt: args.prompt ?? task.prompt,
      ...scheduleFields,
      enabled: args.enabled ?? task.enabled,
      notifyEnabled: args.notifyEnabled ?? task.notifyEnabled,
      // 调度变化 (或恢复启用) 时从现在起重算下次触发; 只改 name/prompt 保留原触发点
      nextRunAt: scheduleChanged || resumed ? computeNextRunAt({ ...task, ...scheduleFields }, Date.now()) : task.nextRunAt,
      updatedAt: Date.now(),
    };
    // once 任务被恢复/改期后重新启用占位
    if (scheduleType === "once" && updated.nextRunAt) updated.enabled = true;
    store.saveScheduledTask(updated);
    store.recordAudit("scheduler.task_updated", { taskId: updated.id, agentId, changes: Object.keys(args) });
    return text({ task: taskSummary(updated) });
  },
});

const deleteTaskTool = defineTool({
  name: "schedule_delete",
  description: "Delete one of your scheduled tasks (soft delete: the task stops triggering, the record is kept).",
  parameters: Type.Object({
    taskId: Type.String({ description: "Task id from schedule_create / schedule_list" }),
  }),
  async execute(args, api) {
    const agentId = resolveAgentId(api);
    const store = new DatabaseStore();
    try {
      const ok = store.softDeleteScheduledTask(args.taskId, agentId);
      if (!ok) return text({ error: `Task not found: ${args.taskId}` });
    } catch (err) {
      return text({ error: err instanceof Error ? err.message : String(err) });
    }
    store.recordAudit("scheduler.task_deleted", { taskId: args.taskId, agentId });
    return text({ deleted: args.taskId });
  },
});

export const SchedulerTools = defineExtension({
  name: "scheduler",
  tools: [createTaskTool, listTasksTool, updateTaskTool, deleteTaskTool],
});
