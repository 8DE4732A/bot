import type { ScheduledTaskDefinition } from "../config/database-store.ts";
import { DatabaseStore } from "../config/database-store.ts";
import { AgentManager } from "../core/agent-manager.ts";
import { EventBus } from "../core/event-bus.ts";
import { buildTriggerMessage, computeNextRunAt, LAST_RESULT_MAX_CHARS } from "./schedule.ts";
import { logger } from "../utils/logger.ts";
import { SchedulerRuntime } from "./durable-runtime.ts";

/** 调度循环轮询周期（仅 polling 回滚模式） */
const TICK_MS = 1000;

export type SchedulerMode = "durable" | "polling";

/**
 * 系统级定时任务调度器启动/生命周期。
 *
 * 六期默认走 durable 模式（每业务任务一个 durable task，精确 sleepUntil，无 1s 轮询）：
 *   start = SchedulerRuntime.init → reconcile → markReady
 * polling 模式保留为 `system_config.scheduler_durable_enabled=0` 的回滚路径；
 * 模式只在启动时决定，进程内不切换（1.4.0 没有 pause/stop scheduler API）。
 */
export class SchedulerManager {
  private static instance?: SchedulerManager;
  private timer?: ReturnType<typeof setInterval>;
  /** 正在执行的任务: 同一任务不并发 (polling 模式的第二道防线) */
  private inFlight = new Set<string>();
  private started = false;
  private mode?: SchedulerMode;
  private startPromise?: Promise<void>;

  public static getInstance(): SchedulerManager {
    if (!SchedulerManager.instance) {
      SchedulerManager.instance = new SchedulerManager();
    }
    return SchedulerManager.instance;
  }

  public async start(): Promise<void> {
    if (this.started) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.doStart();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = undefined;
    }
  }

  private async doStart(): Promise<void> {
    const store = new DatabaseStore();
    const durableEnabled = store.getConfig("scheduler_durable_enabled", "1") !== "0";
    const harnessReady = Boolean(AgentManager.getInstance().getHarness());
    if (durableEnabled && harnessReady) {
      const runtime = SchedulerRuntime.getInstance();
      await runtime.init();
      await runtime.reconcile();
      runtime.markReady();
      this.mode = "durable";
      this.started = true;
      logger.info("Scheduler", "Durable scheduler started (per-task durable sleeps)");
      return;
    }
    if (durableEnabled && !harnessReady) {
      logger.warn(
        "Scheduler",
        "AgentManager Harness is not initialized; falling back to polling scheduler",
      );
    }
    this.mode = "polling";
    this.started = true;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    logger.info("Scheduler", "Scheduler started (polling every 1s; durable disabled)");
  }

  /** 唯一就绪状态：durable 模式读 runtime gate；polling 模式读 started */
  public get isReady(): boolean {
    return this.mode === "durable" ? SchedulerRuntime.getInstance().isReady() : this.started;
  }

  public get inFlightCount(): number {
    return this.inFlight.size + SchedulerRuntime.getInstance().inFlightCount;
  }

  /**
   * drain 兼容计数：stop() 后 started=false（不再有新 run），仍等待 in-flight；
   * durable gate 尚未 ready（启动中）时保守计 1。
   */
  public get drainPendingCount(): number {
    if (this.started && this.mode === "durable" && !SchedulerRuntime.getInstance().isReady()) {
      return 1;
    }
    return this.inFlightCount;
  }

  public async status(): Promise<{
    mode?: SchedulerMode;
    started: boolean;
    ready: boolean;
    inFlight: number;
    nextWakeAt?: number;
    tasksActive: number;
    tasksBlocked: number;
  }> {
    if (this.mode === "durable") {
      const runtime = await SchedulerRuntime.getInstance().status();
      return {
        mode: "durable",
        started: runtime.started,
        ready: runtime.ready,
        inFlight: this.inFlightCount,
        nextWakeAt: runtime.nextWakeAt,
        tasksActive: runtime.tasksActive,
        tasksBlocked: runtime.tasksBlocked,
      };
    }
    return {
      mode: this.mode,
      started: this.started,
      ready: this.started,
      inFlight: this.inFlightCount,
      tasksActive: 0,
      tasksBlocked: 0,
    };
  }

  public stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.mode === "durable") {
      SchedulerRuntime.getInstance().stop();
    }
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
      const triggerMessage = buildTriggerMessage({
        name: task.name,
        prompt: task.prompt,
        scheduledFor: startedAt,
        runNumber,
      });
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
