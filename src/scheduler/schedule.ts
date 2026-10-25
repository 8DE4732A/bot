import { Cron } from "croner";
import type { ScheduledTaskDefinition } from "../config/database-store.ts";

/**
 * 调度纯计算 (无项目内依赖): 独立成模块以斩断
 * tools → index → agent-manager → skills/registry → tools 的循环依赖——
 * tools 顶层求值 (SCHEDULE_DESC) 需要 MIN_INTERVAL_SECONDS 已初始化。
 */

/** 每周期任务的最小间隔秒 (防 agent 配置出高频率烧 token) */
export const MIN_INTERVAL_SECONDS = 60;

/** 最近一次执行结果入库的截断长度 */
export const LAST_RESULT_MAX_CHARS = 800;

/**
 * 计算任务的下次触发时间; 不可触发返回 undefined。
 * from 为基准时刻 (创建/更新/刚触发之后)。
 */
export function computeNextRunAt(task: ScheduledTaskDefinition, from = Date.now()): number | undefined {
  switch (task.scheduleType) {
    case "once":
      // 尚未到点的 once 才有 next; 已过期由 catch-up 决定 (调用方处理)
      return task.runAt && task.runAt > from ? task.runAt : undefined;
    case "every": {
      const interval = (task.intervalSeconds ?? 0) * 1000;
      if (interval < MIN_INTERVAL_SECONDS * 1000) return undefined;
      return from + interval;
    }
    case "cron": {
      if (!task.cronExpr) return undefined;
      try {
        const job = new Cron(task.cronExpr);
        return job.nextRun(new Date(from))?.getTime() ?? undefined;
      } catch {
        return undefined;
      }
    }
    default:
      return undefined;
  }
}

/** 校验 cron 表达式 (返回错误消息, 合法返回 undefined) */
export function validateCronExpr(expr: string): string | undefined {
  try {
    new Cron(expr);
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** 触发消息统一模板（durable / polling / 手动触发共用，保证模型侧格式一致） */
export function buildTriggerMessage(input: {
  name: string;
  prompt: string;
  scheduledFor: number;
  runNumber?: number;
  manual?: boolean;
}): string {
  const label = input.manual ? "手动触发" : `第 ${input.runNumber} 次触发`;
  return `[定时任务「${input.name}」${label} · ${new Date(input.scheduledFor).toISOString()}]\n\n${input.prompt}`;
}
