import type { ScheduledTaskDefinition } from "../config/database-store.ts";
import { DatabaseStore } from "../config/database-store.ts";
import { AgentManager } from "../core/agent-manager.ts";
import { EventBus } from "../core/event-bus.ts";
import { computeNextRunAt, LAST_RESULT_MAX_CHARS } from "./schedule.ts";
import { logger } from "../utils/logger.ts";

/** 调度循环轮询周期 */
const TICK_MS = 1000;

/**
 * 系统级定时任务调度器 (宿主进程轮询 scheduled_tasks 表):
 * - 触发即执行: 以创建任务的 Agent 跑一个任务会话, sessionKey = `scheduler:<taskId>`;
 *   AgentManager 的会话恢复机制保证重复触发复用同一 conversation;
 * - 先占坑再执行: 触发前先推进 next_run_at, 执行慢/进程崩溃都不会同一点重复触发;
 * - catch-up: 重启后 next_run_at 已过期的任务补跑一次 (every 丢弃错过的周期, 不追发);
 * - once 任务触发后 next_run_at 置空并标记 done。
 */
export class SchedulerManager {
  private static instance?: SchedulerManager;
  private timer?: ReturnType<typeof setInterval>;
  /** 正在执行的任务: 同一任务不并发 (chat 的会话锁之外的第二道防线) */
  private inFlight = new Set<string>();
  private started = false;

  public static getInstance(): SchedulerManager {
    if (!SchedulerManager.instance) {
      SchedulerManager.instance = new SchedulerManager();
    }
    return SchedulerManager.instance;
  }

  public start(): void {
    if (this.started) return;
    this.started = true;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    logger.info("Scheduler", "Scheduler started (polling every 1s)");
  }

  /** gateway drain/status 观测用 (control-socket) */
  public get isStarted(): boolean {
    return this.started;
  }

  public get inFlightCount(): number {
    return this.inFlight.size;
  }

  public stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.started = false;
    logger.info("Scheduler", "Scheduler stopped");
  }

  private async tick(): Promise<void> {
    const store = new DatabaseStore();
    try {
      // 秒级轮询的绝大多数 tick 是空转: 先走覆盖索引探针 (命中才做全行查询)
      if (!store.hasDueScheduledTasks(Date.now())) return;
      const due = store.listDueScheduledTasks(Date.now());
      for (const task of due) {
        if (this.inFlight.has(task.id)) continue;
        // 先占坑: 推进 next_run_at / 置空 once, 再异步执行
        if (!this.reserve(task, store)) continue;
        void this.execute(task, store);
      }
    } catch (err) {
      logger.warn("Scheduler", `Tick failed: ${err}`);
    }
  }

  /** 触发前占坑, 返回 false 表示任务已不可触发 (并发下被他人处理/删除) */
  private reserve(task: ScheduledTaskDefinition, store: DatabaseStore): boolean {
    const fresh = store.getScheduledTask(task.id);
    if (!fresh || !fresh.enabled || fresh.deletedAt) return false;
    if (fresh.nextRunAt === undefined) return false;

    const next = computeNextRunAt(fresh, Date.now());
    const done = fresh.scheduleType === "once";
    store.saveScheduledTask({
      ...fresh,
      nextRunAt: done ? undefined : next,
      enabled: done ? false : fresh.enabled,
      updatedAt: Date.now(),
    });
    return true;
  }

  private async execute(task: ScheduledTaskDefinition, store: DatabaseStore): Promise<void> {
    this.inFlight.add(task.id);
    const startedAt = Date.now();
    // runCount 原子递增 (R1 评审 B18: 与手动触发并发时不再读-改-写覆盖);
    // 成功/失败都计一次 (触发即消耗一轮)
    const runNumber = store.incrementScheduledTaskRun(task.id);
    try {
      const triggerMessage =
        `[定时任务「${task.name}」第 ${runNumber} 次触发 · ${new Date(startedAt).toISOString()}]\n\n${task.prompt}`;
      logger.info("Scheduler", `Triggering task '${task.id}' (${task.name}) for agent ${task.agentId}`);
      store.recordAudit("scheduler.trigger", { taskId: task.id, name: task.name, agentId: task.agentId, runNumber });

      const answer = await AgentManager.getInstance().chat(
        task.agentId,
        `scheduler:${task.id}`,
        triggerMessage,
      );

      const runStatus = task.scheduleType === "once" ? "done" : "ok";
      // 执行期间任务可能已被删除 (soft delete): 静默丢弃结果, 不误记 error
      const fresh = store.getScheduledTask(task.id);
      if (!fresh) {
        logger.info("Scheduler", `Task '${task.id}' deleted during execution; dropping result`);
        return;
      }
      store.saveScheduledTask({
        ...fresh,
        lastRunAt: startedAt,
        lastStatus: runStatus,
        lastResult: answer.slice(0, LAST_RESULT_MAX_CHARS),
        runCount: fresh.runCount, // incrementScheduledTaskRun 已计入
        updatedAt: Date.now(),
      });
      EventBus.getInstance().publish({
        type: "scheduler.completed",
        taskId: task.id,
        taskName: task.name,
        agentId: task.agentId,
        status: runStatus,
        runNumber,
        result: answer,
      });
    } catch (err) {
      logger.warn("Scheduler", `Task '${task.id}' failed: ${err}`);
      const fresh = store.getScheduledTask(task.id);
      if (fresh) {
        store.saveScheduledTask({
          ...fresh,
          lastRunAt: startedAt,
          lastStatus: "error",
          lastResult: String(err).slice(0, LAST_RESULT_MAX_CHARS),
          runCount: fresh.runCount, // execute 开头已原子递增
          updatedAt: Date.now(),
        });
      }
      store.recordAudit("scheduler.error", { taskId: task.id, error: String(err) });
      EventBus.getInstance().publish({
        type: "scheduler.completed",
        taskId: task.id,
        taskName: task.name,
        agentId: task.agentId,
        status: "error",
        runNumber,
        result: "",
        error: String(err),
      });
      return;
    } finally {
      this.inFlight.delete(task.id);
    }
  }
}
