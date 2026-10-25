import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, TaskId } from "@earendil-works/pi-durable";
import {
  DatabaseStore,
  type ScheduledTaskDefinition,
  type ScheduledTaskDurableState,
  type ScheduledTaskRunRecord,
} from "../config/database-store.ts";
import { AgentManager } from "../core/agent-manager.ts";
import { EventBus } from "../core/event-bus.ts";
import { logger } from "../utils/logger.ts";
import { buildTriggerMessage, computeNextRunAt, LAST_RESULT_MAX_CHARS } from "./schedule.ts";
import type { CancelChatResult } from "./contracts.ts";
import {
  ConversationMissing,
  ConversationPoisoned,
  LeaseLost,
  RunBusy,
  RunFinalizeError,
  SchedulerBusy,
  SchedulerNotReady,
} from "./contracts.ts";
import {
  ScheduledPromptTask,
  setSchedulerRunner,
  type SchedulerRunOutcome,
} from "./durable-task.ts";

/** lease 时长 / 续租周期（设计 §5.2） */
const LEASE_MS = 120_000;
const RENEW_MS = 30_000;
/** 取消 chat 的等待上限（phase catch / 外部 cancelRun 共用） */
const CANCEL_TIMEOUT_MS = 30_000;
/** durable task 终态等待上限 */
const TASK_TERMINAL_TIMEOUT_MS = 30_000;
/** 单任务锁内允许的最长等待 */
const OWNER_CONFIG_KEY = "scheduler_owner_conversation_id";
const MAX_TASKS_PER_INSTANCE = 1_000;

export interface SchedulerRuntimeStatus {
  started: boolean;
  ready: boolean;
  nextWakeAt?: number;
  tasksActive: number;
  tasksBlocked: number;
}

interface CancelRunResult {
  chatExited: boolean;
  idle: boolean;
  taskTerminal: boolean;
  /** any 门槛未达成 → 调用方保留 aborting，不重建 */
  ok: boolean;
  reason: CancelChatResult["reason"];
}

/**
 * 六期 durable 调度运行时（方案 B：每业务任务一个 durable task）。
 *
 * 职责：
 * - owner conversation 初始化 / reconcile / ready gate；
 * - 每个 scheduled_task 的 durable task 创建、取消、重建；
 * - 幂等 trigger runner（run ledger + lease/fence + requestId + outbox）。
 *
 * 不直接发送通知——outbox 由 NotificationDispatcher 消费。
 */
export class SchedulerRuntime {
  private static instance?: SchedulerRuntime;
  private ready = false;
  private stopped = false;
  private ownerConversationId?: string;
  /** 每次 init 重新生成：进程重启/重开 Harness 不再复用旧 owner 身份 */
  private instanceId = randomUUID();
  private readonly inFlight = new Set<string>();
  private readonly taskLocks = new Map<string, Promise<unknown>>();
  /** 同一任务的 run 串行：避免 manual/scheduled 并发时 activeChats 取消键互相覆盖 */
  private readonly runLocks = new Map<string, Promise<unknown>>();
  /** 本进程内正在执行的 run id：同 owner 重放必须去重，不能当作 takeover */
  private readonly activeRunIds = new Set<string>();
  private reconcilePromise?: Promise<void>;

  public static getInstance(): SchedulerRuntime {
    if (!SchedulerRuntime.instance) SchedulerRuntime.instance = new SchedulerRuntime();
    return SchedulerRuntime.instance;
  }

  public isReady(): boolean {
    return this.ready && !this.stopped;
  }

  public get inFlightCount(): number {
    return this.inFlight.size;
  }

  /** 安装 runner + owner conversation（不做 reconcile）。 */
  public async init(): Promise<void> {
    const agentManager = AgentManager.getInstance();
    if (!agentManager.getHarness()) {
      throw new Error("SchedulerRuntime.init requires AgentManager to be initialized");
    }
    this.instanceId = randomUUID();
    setSchedulerRunner(this);
    this.ownerConversationId = await this.ensureOwnerConversation();
    this.stopped = false;
    logger.info(
      "SchedulerRuntime",
      `Initialized (instance ${this.instanceId.slice(0, 8)}, owner conversation ${this.ownerConversationId})`,
    );
  }

  public markReady(): void {
    this.ready = true;
    this.stopped = false;
  }

  public stop(): void {
    this.ready = false;
    this.stopped = true;
    logger.info("SchedulerRuntime", "Scheduler runtime stopped (sleeping tasks remain durable)");
  }

  /** 模式判定唯一入口：durable 配置开启且 Harness 已初始化（否则回退 polling） */
  public static isDurableActive(): boolean {
    const store = new DatabaseStore();
    return (
      store.getConfig("scheduler_durable_enabled", "1") !== "0" &&
      Boolean(AgentManager.getInstance().getHarness())
    );
  }

  public async status(): Promise<SchedulerRuntimeStatus> {
    const counts = new DatabaseStore().countScheduledTaskStates();
    let nextWakeAt: number | undefined;
    try {
      nextWakeAt = AgentManager.getInstance().getHarness()?.wake().at;
    } catch {
      nextWakeAt = undefined;
    }
    return {
      started: this.ready,
      ready: this.isReady(),
      nextWakeAt,
      tasksActive: counts.active,
      tasksBlocked: counts.blocked,
    };
  }

  // ── 创建 / 编辑 / 删除 ──

  public withTaskLock<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    return this.withKeyedLock(this.taskLocks, taskId, fn);
  }

  /** 按 key 串行化（前序失败不阻塞后续；尾部清理做身份校验） */
  private withKeyedLock<T>(
    locks: Map<string, Promise<unknown>>,
    key: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const prev = locks.get(key) ?? Promise.resolve();
    const run = prev.then(fn);
    const stored = run.catch(() => {});
    locks.set(key, stored);
    void stored.finally(() => {
      if (locks.get(key) === stored) locks.delete(key);
    });
    return run;
  }

  /**
   * 创建/编辑统一入口：
   * - 调度字段或 enabled 变化才递增 schedule_version，取消旧任务后重建；
   * - name/prompt/notify 编辑不重建（phase 每次读最新业务行）。
   */
  public async saveTaskDefinition(
    task: ScheduledTaskDefinition,
    change: { scheduleChanged: boolean; enabledChanged: boolean },
  ): Promise<{ task: ScheduledTaskDefinition; aborting: boolean }> {
    return this.withTaskLock(task.id, async () => {
      const store = new DatabaseStore();
      const prev = store.getScheduledTaskRaw(task.id);
      if (prev?.conversationPoisoned) {
        throw new ConversationPoisoned(
          `Task '${task.id}' conversation is poisoned; reset the conversation before editing`,
        );
      }
      if (!prev) {
        if (store.countScheduledTasks() >= MAX_TASKS_PER_INSTANCE) {
          throw new Error(`Scheduled task limit reached (${MAX_TASKS_PER_INSTANCE})`);
        }
        task.scheduleVersion = 0;
        task.durableState = task.enabled ? "pending" : "disabled";
        store.saveScheduledTask(task);
        const result = await this.ensureDurableTaskLocked(task.id, store);
        return { task: store.getScheduledTaskRaw(task.id) ?? task, aborting: result.aborting };
      }

      const structural = change.scheduleChanged || change.enabledChanged;
      if (structural) {
        task.scheduleVersion = prev.scheduleVersion + 1;
        if (task.enabled && task.nextRunAt === undefined) {
          task.nextRunAt = computeNextRunAt(task, Date.now());
        }
        if (!task.enabled && task.scheduleType !== "once") task.nextRunAt = undefined;
        store.saveScheduledTaskConfig(task);
        const cancel = await this.cancelRunLocked(task.id, prev.durableTaskId);
        if (!cancel.ok) {
          store.setScheduledTaskDurable(task.id, prev.durableTaskId, "aborting");
          return { task: store.getScheduledTaskRaw(task.id) ?? task, aborting: true };
        }
        if (task.enabled) {
          store.setScheduledTaskDurable(task.id, undefined, "pending");
          const ensured = await this.ensureDurableTaskLocked(task.id, store);
          return {
            task: store.getScheduledTaskRaw(task.id) ?? task,
            aborting: ensured.aborting,
          };
        }
        store.setScheduledTaskDurable(task.id, undefined, "disabled");
        return { task: store.getScheduledTaskRaw(task.id) ?? task, aborting: false };
      }

      // 非结构性编辑：只更新定义字段，绝不覆盖并发 run 的 last_*/run_count
      store.saveScheduledTaskConfig(task);
      if (task.enabled && !prev.durableTaskId) {
        const ensured = await this.ensureDurableTaskLocked(task.id, store);
        return { task: store.getScheduledTaskRaw(task.id) ?? task, aborting: ensured.aborting };
      }
      return {
        task: store.getScheduledTaskRaw(task.id) ?? task,
        aborting: prev.durableState === "aborting",
      };
    });
  }

  public async deleteTask(
    taskId: string,
    agentId?: string,
  ): Promise<{ deleted: boolean; aborting: boolean }> {
    return this.withTaskLock(taskId, async () => {
      const store = new DatabaseStore();
      const row = store.getScheduledTaskRaw(taskId);
      if (!row || row.deletedAt) return { deleted: false, aborting: false };
      // 用户意图先落库，abort 后置：reconcile 绝不会复活已删除任务
      store.markScheduledTaskDeleted(taskId, agentId);
      const cancel = await this.cancelRunLocked(taskId, row.durableTaskId);
      if (cancel.ok) {
        store.setScheduledTaskDurable(taskId, undefined, "deleted");
        return { deleted: true, aborting: false };
      }
      // 删除优先级最高：deleted_at 已置位；旧 task 由 reconcile 清理
      store.setScheduledTaskDurable(taskId, row.durableTaskId, "deleted");
      return { deleted: true, aborting: true };
    });
  }

  private async ensureDurableTaskLocked(
    taskId: string,
    store: DatabaseStore,
  ): Promise<{ aborting: boolean }> {
    const row = store.getScheduledTaskRaw(taskId);
    if (!row || row.deletedAt || !row.enabled || row.conversationPoisoned) {
      return { aborting: false };
    }
    const agentManager = AgentManager.getInstance();
    if (!agentManager.getHarness()) {
      // 进程尚未初始化 Harness（测试/纯 API 进程）：保留任务，启动对账会重试创建
      store.setScheduledTaskDurable(taskId, undefined, "failed");
      return { aborting: false };
    }

    if (row.durableTaskId) {
      const live = await agentManager.inspectDurableTask(row.durableTaskId).catch(() => undefined);
      if (live && row.durableState === "aborting") {
        // 上次取消超时：reconcile/ensure 继续清理，绝不复用旧 task
        const cancel = await this.cancelRunLocked(taskId, row.durableTaskId);
        if (!cancel.ok) {
          store.setScheduledTaskDurable(taskId, row.durableTaskId, "aborting");
          return { aborting: true };
        }
        store.setScheduledTaskDurable(taskId, undefined, "pending");
      } else if (live) {
        if (live.state.kind === "blocked" && live.state.reason === "restart_limit") {
          store.setScheduledTaskDurable(taskId, row.durableTaskId, "blocked");
          return { aborting: false };
        }
        if (live.state.kind !== "blocked") {
          store.setScheduledTaskDurable(taskId, row.durableTaskId, "active");
          return { aborting: false };
        }
        // blocked (missing_task/task_too_old/migration_failed)：清理后重建
        const cancel = await this.cancelRunLocked(taskId, row.durableTaskId);
        if (!cancel.ok) {
          store.setScheduledTaskDurable(taskId, row.durableTaskId, "aborting");
          return { aborting: true };
        }
      }
      store.setScheduledTaskDurable(taskId, undefined, "pending");
    }

    try {
      const owner = await this.ensureOwnerConversation();
      const harness = agentManager.getHarness()!;
      const durableId = await harness.commit(
        (tx) =>
          tx.createTask(
            ScheduledPromptTask,
            { scheduledTaskId: taskId },
            {
              ownership: { kind: "conversation" },
              conversationId: Number(owner) as ConversationId,
              background: true,
            },
          ),
        BACKGROUND_CONTEXT,
      );
      store.setScheduledTaskDurable(taskId, String(durableId), "active");
      store.recordAudit("scheduler.durable_created", {
        taskId,
        durableTaskId: String(durableId),
        ownerConversationId: owner,
      });
      return { aborting: false };
    } catch (err) {
      store.setScheduledTaskDurable(taskId, undefined, "failed");
      store.recordAudit("scheduler.durable_create_failed", {
        taskId,
        error: err instanceof Error ? err.message : String(err),
      });
      logger.warn("SchedulerRuntime", `Failed to create durable task for '${taskId}': ${err}`);
      return { aborting: false };
    }
  }

  // ── 启动对账 ──

  public async reconcile(): Promise<void> {
    if (this.reconcilePromise) return this.reconcilePromise;
    this.reconcilePromise = this.doReconcile();
    try {
      await this.reconcilePromise;
    } finally {
      this.reconcilePromise = undefined;
    }
  }

  private async doReconcile(): Promise<void> {
    const store = new DatabaseStore();
    const summary = { created: 0, aborted: 0, blocked: 0, failed: 0, poisoned: 0, adopted: 0 };

    // 1. owner conversation 由 init 保证；这里只兜底（重启/配置丢失）
    this.ownerConversationId = await this.ensureOwnerConversation();

    // 2. 接管/收尾上次进程遗留的 running lease。未能确认 chat 退出或条件接管
    //    失败时启动阶段有界重试；仍不收敛则拒绝启动（不 markReady）。
    let unresolved = new Set<string>();
    for (let attempt = 0; attempt < 3; attempt++) {
      unresolved = new Set<string>();
      for (const run of store.listRunningScheduledRuns()) {
        const task = store.getScheduledTaskRaw(run.taskId);
        const live = task?.durableTaskId
          ? await AgentManager.getInstance()
              .inspectDurableTask(task.durableTaskId)
              .catch(() => undefined)
          : undefined;
        if (run.leaseOwner === this.instanceId) continue;
        // 该 ledger 必须能被当前 live durable task 的同一 checkpoint 重放
        const replayable = Boolean(
          task &&
            live &&
            !task.deletedAt &&
            task.enabled &&
            !task.conversationPoisoned &&
            run.durableTaskId === task.durableTaskId &&
            run.scheduleVersion === task.scheduleVersion,
        );
        const cancelled = await AgentManager.getInstance()
          .cancelChatForTask(run.taskId, 5_000, run.runKey, {
            expectedLeaseFence: run.leaseFence,
            expectedOwner: run.leaseOwner ?? undefined,
            allowConversationAbortForStaleOwner: this.instanceId,
          })
          .catch(() => ({ chatExited: false, idle: false, reason: "error" as const }));
        if (!cancelled.chatExited || !cancelled.idle) {
          unresolved.add(run.taskId);
          continue;
        }
        if (!replayable) {
          // 不可重放：确认 chat 退出后条件终结 ledger（不动用户已改的业务行）
          if (
            store.forceAbortScheduledRun(run.id, "restart_superseded", Date.now(), {
              owner: run.leaseOwner ?? null,
              fence: run.leaseFence,
            })
          ) {
            summary.aborted += 1;
          } else {
            unresolved.add(run.taskId);
          }
          continue;
        }
        if (
          !store.takeoverScheduledRunIf(
            run.id,
            run.leaseOwner ?? null,
            run.leaseFence,
            this.instanceId,
            0,
          )
        ) {
          unresolved.add(run.taskId);
          continue;
        }
        summary.adopted += 1;
      }
      if (unresolved.size === 0) break;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 1_000 * (attempt + 1)));
    }
    if (unresolved.size > 0) {
      summary.failed = unresolved.size;
      throw new Error(
        `Scheduler reconcile could not resolve running run(s) for task(s): ${[...unresolved].join(", ")}`,
      );
    }

    // 3. 逐任务对账（含 deleted 行）
    for (const row of store.listScheduledTasksRaw()) {
      try {
        if (row.conversationPoisoned) {
          store.setScheduledTaskDurable(row.id, row.durableTaskId, "poisoned");
          // poisoned 的遗留 running run 统一写 error，绝不重建/重试
          for (const run of store.listRunningScheduledRuns(row.id)) {
            store.finishScheduledRun({
              runId: run.id,
              owner: run.leaseOwner ?? this.instanceId,
              fence: run.leaseFence,
              status: "error",
              error: "conversation_poisoned",
              now: Date.now(),
            });
          }
          summary.poisoned += 1;
          continue;
        }
        if (row.deletedAt || !row.enabled) {
          const terminalState: ScheduledTaskDurableState = row.deletedAt
            ? "deleted"
            : row.durableState === "failed" || row.durableState === "done"
              ? row.durableState
              : "disabled";
          if (row.durableTaskId) {
            const cancel = await this.cancelRunLocked(row.id, row.durableTaskId);
            if (cancel.ok) {
              store.setScheduledTaskDurable(row.id, undefined, terminalState);
              summary.aborted += 1;
            } else {
              store.setScheduledTaskDurable(row.id, row.durableTaskId, "aborting");
            }
          } else {
            store.setScheduledTaskDurable(row.id, undefined, terminalState);
          }
          continue;
        }

        await this.withTaskLock(row.id, async () => {
          const fresh = store.getScheduledTaskRaw(row.id);
          if (!fresh || fresh.deletedAt || !fresh.enabled) return;
          if (fresh.durableTaskId) {
            const live = await AgentManager.getInstance()
              .inspectDurableTask(fresh.durableTaskId)
              .catch(() => undefined);
            if (live?.state.kind === "blocked" && live.state.reason === "restart_limit") {
              store.setScheduledTaskDurable(row.id, fresh.durableTaskId, "blocked");
              summary.blocked += 1;
              return;
            }
          }
          const result = await this.ensureDurableTaskLocked(row.id, store);
          if (result.aborting) summary.failed += 1;
          else summary.created += 1;
        });
      } catch (err) {
        summary.failed += 1;
        logger.warn("SchedulerRuntime", `Reconcile failed for task '${row.id}': ${err}`);
      }
    }

    store.recordAudit("scheduler.reconcile", summary);
    logger.info("SchedulerRuntime", `Reconcile complete: ${JSON.stringify(summary)}`);
  }

  // ── runner（phase 调用） ──

  public async runScheduledPrompt(input: {
    taskId: string;
    runKey: string;
    scheduledFor: number;
    scheduleVersion: number;
    durableTaskId?: string;
  }): Promise<SchedulerRunOutcome> {
    if (!this.isReady()) throw new SchedulerNotReady();
    const store = new DatabaseStore();

    type ReserveAttempt =
      | { kind: "reserve"; reserved: ReturnType<DatabaseStore["reserveScheduledRun"]> }
      | { kind: "already"; runId: string; answer: string };
    const now = Date.now();

    // 不使用 task 锁：phase 在 run 期间可能被 edit/delete 的 cancel 等待，
    // 若这里排队等锁会与 cancel 形成 30s 自等待。并发仲裁由 reserve 事务内的
    // “同 runKey / 同任务其他 running run / schedule_version”检查完成。
    const attempt = await (async (): Promise<ReserveAttempt> => {
      const latest = store.getScheduledTaskRaw(input.taskId);
      if (!latest || latest.deletedAt) {
        return { kind: "reserve", reserved: { kind: "superseded", reason: "deleted" } };
      }
      if (latest.conversationPoisoned) throw new ConversationPoisoned();
      if (latest.scheduleVersion !== input.scheduleVersion) {
        return { kind: "reserve", reserved: { kind: "superseded", reason: "schedule_version" } };
      }
      if (!latest.enabled) {
        return { kind: "reserve", reserved: { kind: "superseded", reason: "disabled" } };
      }
      // 同一 owner 已在本进程执行同一 run：重复唤醒/并发调用直接收敛，
      // 绝不递增 fence 或二次提交（R9-B1）。
      const current = store.getScheduledRunByKey(input.taskId, input.runKey);
      if (
        current?.status === "running" &&
        current.leaseOwner === this.instanceId &&
        this.activeRunIds.has(current.id)
      ) {
        return { kind: "already", runId: current.id, answer: current.result ?? "" };
      }
      const allowSelfTakeover =
        current?.status === "running" &&
        current.leaseOwner === this.instanceId &&
        !this.activeRunIds.has(current.id);
      const nextRunAt =
        latest.scheduleType === "once"
          ? undefined
          : nextRunAfter(latest, input.scheduledFor, now);
      return {
        kind: "reserve",
        reserved: store.reserveScheduledRun({
          taskId: input.taskId,
          runKey: input.runKey,
          scheduledFor: input.scheduledFor,
          scheduleVersion: input.scheduleVersion,
          now,
          leaseOwner: this.instanceId,
          leaseMs: LEASE_MS,
          durableTaskId: input.durableTaskId,
          advanceSchedule: true,
          nextRunAt,
          allowSelfTakeover,
        }),
      };
    })();
    if (attempt.kind === "already") {
      return { kind: "already-done", runId: attempt.runId, answer: attempt.answer };
    }
    const reserved = attempt.reserved;
    if (reserved.kind === "superseded") return { kind: "superseded" };
    if (reserved.kind === "busy") throw new SchedulerBusy();
    if (reserved.kind === "existing") {
      if (reserved.run.status !== "running") {
        return {
          kind: "already-done",
          runId: reserved.run.id,
          answer: reserved.run.result ?? "",
        };
      }
      if (reserved.active) {
        // 另一个 live owner 仍在执行：保留 checkpoint 让路，等 lease 过期/释放后
        // 再接管；不能返回 already-done 让 ledger 悬挂（R11-B1）。
        throw new SchedulerBusy();
      }
      // lease 已被本调用接管（崩溃恢复/自身重入）：继续执行同一 run
      return this.runReserved(reserved.task, reserved.run);
    }

    return this.runReserved(reserved.task, reserved.run);
  }

  /**
   * 手动触发（管理台）：先做 conversation 可用性检查（poisoned 409 语义），
   * 走同一 reserve/lease/ledger/outbox，advanceSchedule=false。
   */
  public async triggerManual(taskId: string): Promise<{ runId: string; runNumber: number }> {
    if (!this.isReady()) throw new SchedulerNotReady();
    const store = new DatabaseStore();
    const runKey = `manual:${randomUUID()}`;
    // 与 scheduled/编辑/删除共用 task 锁：检查 active run 与 reserve 原子化，
    // 已有 running run 时明确冲突
    const result = await this.withTaskLock(taskId, async () => {
      const now = Date.now();
      {
        if (
          this.inFlight.has(taskId) ||
          store.listRunningScheduledRuns(taskId).length > 0
        ) {
          throw new RunBusy(`Task '${taskId}' already has an active run`);
        }
        await this.assertConversationUsable(taskId);
        const row = store.getScheduledTaskRaw(taskId);
        if (!row) throw new Error(`Task not found: ${taskId}`);
        const reserved = store.reserveScheduledRun({
          taskId,
          runKey,
          scheduledFor: now,
          scheduleVersion: row.scheduleVersion,
          now,
          leaseOwner: this.instanceId,
          leaseMs: LEASE_MS,
          advanceSchedule: false,
        });
        if (reserved.kind === "reserved") {
          // 必须在释放 task 锁前登记 activeRunIds（runReserved 同步登记）
          void this.runReserved(row, reserved.run).catch((err) => {
            logger.warn("SchedulerRuntime", `Manual run '${reserved.run.id}' failed: ${err}`);
            this.finalizeRunOnFailure(reserved.run, err);
          });
        }
        return reserved;
      }
    });
    if (result.kind === "superseded") {
      throw new Error(`Task '${taskId}' is not runnable`);
    }
    if (result.kind === "busy") {
      throw new RunBusy(`Task '${taskId}' already has an active run`);
    }
    return { runId: result.run.id, runNumber: result.run.runNumber };
  }

  /** manual runner 启动/执行异常兜底：ledger 不得停留在 running（R10-B4） */
  private finalizeRunOnFailure(run: ScheduledTaskRunRecord, err: unknown): void {
    try {
      const store = new DatabaseStore();
      const current = store.getScheduledRun(run.id);
      if (
        current?.status === "running" &&
        current.leaseOwner === this.instanceId &&
        current.leaseFence === run.leaseFence
      ) {
        const message = err instanceof Error ? err.message : String(err);
        store.finishScheduledRun({
          runId: run.id,
          owner: this.instanceId,
          fence: run.leaseFence,
          status: "error",
          error: message,
          now: Date.now(),
        });
        store.recordAudit("scheduler.error", {
          taskId: run.taskId,
          runKey: run.runKey,
          error: message,
        });
      } else if (
        current?.status === "running" &&
        (current.leaseUntil ?? 0) < Date.now()
      ) {
        // lease 已被接管但接管者也没有续租：按过期 orphan 收尾
        store.forceAbortScheduledRun(run.id, "orphaned_after_manual_failure", Date.now());
      }
    } catch (finalizeErr) {
      logger.warn("SchedulerRuntime", `Failed to finalize manual run '${run.id}': ${finalizeErr}`);
    }
  }

  private async runReserved(
    task: ScheduledTaskDefinition,
    run: ScheduledTaskRunRecord,
  ): Promise<SchedulerRunOutcome> {
    this.activeRunIds.add(run.id);
    this.inFlight.add(task.id);
    return this.withRunLock(task.id, () => this.runReservedLocked(task, run)).finally(() => {
      this.activeRunIds.delete(run.id);
      this.inFlight.delete(task.id);
      // 注意：不在这里释放 lease。只有 phase 确认旧 chat 退出且 conversation
      // idle 后，才通过 releaseRunLease() 显式交接（R11-B1）。
    });
  }

  private withRunLock<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    return this.withKeyedLock(this.runLocks, taskId, fn);
  }

  private async runReservedLocked(
    task: ScheduledTaskDefinition,
    run: ScheduledTaskRunRecord,
  ): Promise<SchedulerRunOutcome> {
    const store = new DatabaseStore();
    const agentManager = AgentManager.getInstance();
    const taskId = task.id;
    // 排队进入时重新校验 ledger 归属/代际：等待期间可能被 cancel 强制终态或接管
    const dbRun = store.getScheduledRun(run.id);
    if (!dbRun || dbRun.status !== "running") {
      return { kind: "already-done", runId: run.id, answer: dbRun?.result ?? "" };
    }
    if (dbRun.leaseOwner !== this.instanceId || dbRun.leaseFence !== run.leaseFence) {
      throw new LeaseLost(`Run '${run.id}' lease changed while queued`);
    }
    let leaseLost = false;
    let stopped = false;
    const timer = setInterval(() => {
      if (stopped) return;
      const state = store.renewScheduledRunLease(
        run.id,
        this.instanceId,
        run.leaseFence,
        Date.now() + LEASE_MS,
      );
      if (state === "lost" && !leaseLost) {
        leaseLost = true;
        void agentManager
          .cancelChatForTask(taskId, CANCEL_TIMEOUT_MS, run.runKey, {
            expectedLeaseFence: run.leaseFence,
            expectedOwner: this.instanceId,
          })
          .catch(() => undefined);
        logger.warn("SchedulerRuntime", `Lease lost for '${taskId}'/${run.runKey}; cancelling chat`);
      }
    }, RENEW_MS);
    timer.unref?.();

    let answer = "";
    try {
      // reserve 后、提交 chat 前二次校验（编辑/删除可能在此窗口到达）
      const fresh = store.getScheduledTaskRaw(taskId);
      if (!fresh || fresh.deletedAt) {
        // 任务已删除/行消失：ledger 必须当下收尾，不能留给下次启动
        this.finishOrThrow(run, "aborted", undefined, "deleted");
        return { kind: "superseded" };
      }
      if (fresh.conversationPoisoned) {
        this.finishOrThrow(run, "error", undefined, "conversation_poisoned");
        throw new ConversationPoisoned();
      }
      if (fresh.scheduleVersion !== run.scheduleVersion) {
        this.finishOrThrow(run, "aborted", undefined, "superseded");
        return { kind: "superseded" };
      }
      if (!fresh.enabled) {
        this.finishOrThrow(run, "aborted", undefined, "disabled");
        return { kind: "superseded" };
      }
      const agent = store.getAgent(fresh.agentId);
      if (!agent) {
        this.finishOrThrow(run, "error", undefined, `Agent not found: ${fresh.agentId}`);
        return { kind: "completed", runId: run.id, answer: "" };
      }

      const triggerMessage = buildTriggerMessage({
        name: fresh.name,
        prompt: fresh.prompt,
        scheduledFor: run.scheduledFor,
        runNumber: run.runNumber,
        manual: run.runKey.startsWith("manual:"),
      });
      store.recordAudit("scheduler.trigger", {
        taskId,
        name: fresh.name,
        agentId: fresh.agentId,
        runNumber: run.runNumber,
        runKey: run.runKey,
      });

      answer = await agentManager.chat(
        fresh.agentId,
        `scheduler:${taskId}`,
        triggerMessage,
        undefined,
        {
          requestId: run.requestId,
          schedulerTaskId: taskId,
          runKey: run.runKey,
          leaseFence: run.leaseFence,
          owner: this.instanceId,
          conversationId: fresh.conversationId,
        },
      );
      if (leaseLost) {
        throw new LeaseLost(`Lease lost while running '${taskId}'/${run.runKey}`);
      }
      const status = fresh.scheduleType === "once" && run.runKey.startsWith("schedule:") ? "done" : "ok";
      const finished = store.finishScheduledRun({
        runId: run.id,
        owner: this.instanceId,
        fence: run.leaseFence,
        status,
        result: answer.slice(0, LAST_RESULT_MAX_CHARS),
        now: Date.now(),
      });
      if (!finished.ok) {
        if (finished.reason === "fence_lost") {
          throw new LeaseLost(`Lease fence changed while finalizing '${taskId}'/${run.runKey}`);
        }
        throw new RunFinalizeError(
          `Run '${run.id}' was already settled before finalize (${finished.reason})`,
        );
      }
      this.publishCompleted(fresh, run, status === "done" ? "done" : "ok", answer);
      return { kind: "completed", runId: run.id, answer };
    } catch (err) {
      if (err instanceof ConversationPoisoned) {
        // 不再复用该会话；ledger 用当前 fence 收尾，避免悬挂 running
        try {
          this.finishOrThrow(run, "error", undefined, "conversation_poisoned");
        } catch {
          /* 已由并发方收尾/lease 已丢：交给 reconcile */
        }
        throw err;
      }
      if (err instanceof LeaseLost) {
        throw err;
      }
      if (leaseLost) {
        throw new LeaseLost(`Lease lost while running '${taskId}'/${run.runKey}`);
      }
      // 用户删除/禁用/编辑打断 chat：ledger 写 aborted（用户意图优先），不是 error
      const latest = store.getScheduledTaskRaw(taskId);
      const userCancelled =
        !latest || latest.deletedAt || !latest.enabled || latest.scheduleVersion !== run.scheduleVersion;
      if (userCancelled) {
        const ledgerError = latest?.deletedAt
          ? "deleted"
          : !latest?.enabled
            ? "disabled"
            : "superseded";
        this.finishOrThrow(run, "aborted", undefined, ledgerError);
        return { kind: "completed", runId: run.id, answer: "" };
      }
      if (err instanceof ConversationMissing) {
        this.finishOrThrow(run, "error", undefined, err.message);
        throw new RunFinalizeError(err.message);
      }
      const message = err instanceof Error ? err.message : String(err);
      logger.warn("SchedulerRuntime", `Run '${taskId}'/${run.runKey} failed: ${message}`);
      store.recordAudit("scheduler.error", { taskId, runKey: run.runKey, error: message });
      this.finishOrThrow(run, "error", undefined, message);
      this.publishCompleted(freshTask(store, taskId) ?? task, run, "error", "", message);
      return { kind: "completed", runId: run.id, answer: "" };
    } finally {
      stopped = true;
      clearInterval(timer);
    }
  }

  private finishOrThrow(
    run: ScheduledTaskRunRecord,
    status: "ok" | "error" | "done" | "aborted",
    result: string | undefined,
    error: string | undefined,
  ) {
    const finished = new DatabaseStore().finishScheduledRun({
      runId: run.id,
      owner: this.instanceId,
      fence: run.leaseFence,
      status,
      result,
      error,
      now: Date.now(),
    });
    if (!finished.ok) {
      if (finished.reason === "fence_lost") {
        throw new LeaseLost(`Lease fence changed while finalizing '${run.taskId}'/${run.runKey}`);
      }
      throw new RunFinalizeError(
        `Run '${run.id}' was already settled (${finished.reason})`,
      );
    }
    return finished;
  }

  private publishCompleted(
    task: ScheduledTaskDefinition,
    run: ScheduledTaskRunRecord,
    status: "ok" | "error" | "done",
    result: string,
    error?: string,
  ): void {
    EventBus.getInstance().publish({
      type: "scheduler.completed",
      taskId: task.id,
      taskName: task.name,
      agentId: task.agentId,
      status,
      runNumber: run.runNumber,
      result,
      error,
      runId: run.id,
      source: run.runKey.startsWith("manual:") ? "manual" : "schedule",
      scheduledFor: run.scheduledFor,
    });
  }

  // ── 取消 / poisoned ──

  public async currentRunFence(taskId: string, runKey: string): Promise<number | undefined> {
    return new DatabaseStore().currentRunFence(taskId, runKey);
  }

  public async cancelChatForTask(
    taskId: string,
    timeoutMs: number,
    expectedRunKey?: string | string[],
    options?: {
      expectedLeaseFence?: number;
      expectedOwner?: string;
      allowConversationAbortForStaleOwner?: string;
    },
  ): Promise<CancelChatResult> {
    const bound = options
      ? { ...options, expectedOwner: options.expectedOwner ?? this.instanceId }
      : undefined;
    return AgentManager.getInstance().cancelChatForTask(
      taskId,
      timeoutMs,
      expectedRunKey,
      bound,
    );
  }

  public async markConversationPoisoned(input: {
    taskId: string;
    runKey: string;
    fence: number;
    scheduleVersion: number;
    expectedOwner?: string;
  }): Promise<void> {
    const store = new DatabaseStore();
    const written = store.markConversationPoisoned(
      input.taskId,
      input.runKey,
      input.fence,
      input.scheduleVersion,
      input.expectedOwner ?? this.instanceId,
    );
    if (written) {
      store.recordAudit("scheduler.conversation_poisoned", {
        taskId: input.taskId,
        runKey: input.runKey,
        fence: input.fence,
      });
    }
    // canonical poison 与 ledger 终态同源：不能留下永远 running 的 run
    const run = store.getScheduledRunByKey(input.taskId, input.runKey);
    if (run && run.status === "running" && run.leaseFence === input.fence) {
      store.finishScheduledRun({
        runId: run.id,
        owner: run.leaseOwner ?? this.instanceId,
        fence: run.leaseFence,
        status: "error",
        error: "conversation_poisoned",
        now: Date.now(),
      });
    }
  }

  /**
   * orphan running ledger 清理：本进程 activeRunIds 不含、且（owner 是本实例
   * 或 lease 已过期）的 run 已不可能再推进 → 写 aborted。
   * 仅用于让同一 task 的后续触发/手动重试可以继续；不会清理其他 live owner
   * 仍持有有效 lease 的 run（由 SchedulerBusy 让路）。
   */
  /** phase 确认旧 chat 退出 + idle 后调用：把未终结 run 的 lease 清零供重试接管 */
  public async releaseRunLease(taskId: string, runKey: string, fence?: number): Promise<void> {
    const store = new DatabaseStore();
    const run = store.getScheduledRunByKey(taskId, runKey);
    if (!run || run.status !== "running" || run.leaseOwner !== this.instanceId) return;
    if (fence !== undefined && run.leaseFence !== fence) return;
    if (store.releaseScheduledRunLease(run.id, this.instanceId, run.leaseFence)) {
      store.recordAudit("scheduler.lease_released", {
        taskId,
        runKey,
        fence: run.leaseFence,
        reason: "chat_confirmed_idle",
      });
    }
  }

  private async cancelRunLocked(
    taskId: string,
    durableTaskId?: string,
  ): Promise<CancelRunResult> {
    const store = new DatabaseStore();
    const agentManager = AgentManager.getInstance();
    const runs = store.listRunningScheduledRuns(taskId);
    // 每个 run 都按 (runKey, owner, fence) 逐项取消；禁止 taskId 级泛取消
    const chatResults: CancelChatResult[] = [];
    if (runs.length === 0) {
      chatResults.push(await agentManager.cancelChatForTask(taskId, CANCEL_TIMEOUT_MS, []));
    } else {
      for (const run of runs) {
        chatResults.push(
          await agentManager.cancelChatForTask(taskId, CANCEL_TIMEOUT_MS, run.runKey, {
            expectedLeaseFence: run.leaseFence,
            expectedOwner: run.leaseOwner ?? undefined,
          }),
        );
      }
    }
    const chat =
      chatResults.find((r) => r.chatExited || r.reason !== "run_mismatch") ?? chatResults[0];
    let taskTerminal = true;
    if (durableTaskId) {
      // 先发出 abort（不等待），与 chat 取消并行
      const abortPromise = agentManager
        .abortDurableTask(durableTaskId)
        .catch(() => "missing" as const);
      const waitPromise = agentManager.waitForDurableTask(durableTaskId, TASK_TERMINAL_TIMEOUT_MS);
      const [abort, waited] = await Promise.all([abortPromise, waitPromise]);
      taskTerminal = abort === "missing" || waited;
      // abortTask 返回 marked 不代表 abort handler 已 terminal；以 inspect 为准
      if (!taskTerminal) {
        const live = await agentManager.inspectDurableTask(durableTaskId).catch(() => undefined);
        taskTerminal = !live;
      }
    }
    const idle = chat.idle;
    const ok = chat.chatExited && idle && taskTerminal;
    if (ok) {
      // 只终结各自快照身份上的 running ledger（条件 owner+fence）
      for (const run of runs) {
        store.forceAbortScheduledRun(run.id, "cancelled", Date.now(), {
          owner: run.leaseOwner ?? null,
          fence: run.leaseFence,
        });
      }
    }
    return { chatExited: chat.chatExited, idle, taskTerminal, ok, reason: chat.reason };
  }

  public async assertConversationUsable(taskId: string): Promise<void> {
    const store = new DatabaseStore();
    const row = store.getScheduledTaskRaw(taskId);
    if (!row || row.deletedAt) throw new Error(`Task not found: ${taskId}`);
    if (!row.enabled) throw new Error(`Task '${taskId}' is disabled`);
    if (row.conversationPoisoned) throw new ConversationPoisoned();
    if (!row.conversationId) return;
    if (store.isRetiredSchedulerConversation(row.conversationId)) {
      throw new ConversationMissing(`Scheduled conversation ${row.conversationId} is retired`);
    }
    const conv = await AgentManager.getInstance().openConversationById(row.conversationId);
    if (!conv) {
      throw new ConversationMissing(
        `Scheduled conversation ${row.conversationId} for '${taskId}' is missing`,
      );
    }
    const mapping = store.getSession("channel_session", `scheduler:${taskId}`);
    if (mapping && mapping.conversationId !== row.conversationId) {
      throw new ConversationMissing(
        `Task '${taskId}' conversation binding mismatch (task=${row.conversationId}, mapping=${mapping.conversationId})`,
      );
    }
  }

  /** 人工 reset poisoned conversation（设计 §5.8） */
  public async resetConversation(taskId: string): Promise<{ conversationId: string }> {
    return this.withTaskLock(taskId, async () => {
      const store = new DatabaseStore();
      const row = store.getScheduledTaskRaw(taskId);
      if (!row || row.deletedAt) throw new Error(`Task not found: ${taskId}`);
      if (!row.conversationPoisoned) {
        throw new Error(`Task '${taskId}' is not poisoned`);
      }
      const oldConversation = row.conversationId;
      const cancel = await this.cancelRunLocked(taskId, row.durableTaskId);
      if (!cancel.ok) {
        throw new Error("Old scheduler conversation is still busy; refusing to reset");
      }
      AgentManager.getInstance().forgetSchedulerConversation(taskId, oldConversation);
      if (oldConversation) store.retireSchedulerConversation(oldConversation);
      const agent = store.getAgent(row.agentId);
      if (!agent) throw new Error(`Agent not found: ${row.agentId}`);
      const fresh = await AgentManager.getInstance().createFreshSchedulerConversation(
        row.agentId,
        taskId,
      );
      store.resetScheduledConversation(taskId, String(fresh.id), row.agentId);
      store.recordAudit("scheduler.conversation_reset", {
        taskId,
        oldConversationId: oldConversation ?? null,
        newConversationId: String(fresh.id),
      });
      await this.ensureDurableTaskLocked(taskId, store);
      return { conversationId: String(fresh.id) };
    });
  }

  // ── Agent 删除 / 全量清理 ──

  public async abortForAgent(agentId: string): Promise<void> {
    const store = new DatabaseStore();
    const tasks = store.listScheduledTasks(agentId);
    // 1. 用户意图先落库（批量标记）
    for (const task of tasks) {
      store.markScheduledTaskDeleted(task.id, agentId);
    }
    // 2. 再逐个取消 durable task（可重试）
    for (const task of tasks) {
      await this.withTaskLock(task.id, async () => {
        const cancel = await this.cancelRunLocked(task.id, task.durableTaskId);
        if (cancel.ok) store.setScheduledTaskDurable(task.id, undefined, "deleted");
      });
    }
    store.recordAudit("scheduler.agent_tasks_aborted", { agentId, count: tasks.length });
  }

  // ── owner conversation ──

  private async ensureOwnerConversation(): Promise<string> {
    if (this.ownerConversationId) return this.ownerConversationId;
    const store = new DatabaseStore();
    const agentManager = AgentManager.getInstance();
    const harness = agentManager.getHarness();
    if (!harness) throw new Error("AgentManager is not initialized");

    const configured = store.getConfig(OWNER_CONFIG_KEY, "");
    if (configured) {
      const existing = await harness.conversation(Number(configured) as ConversationId, BACKGROUND_CONTEXT);
      if (existing) {
        this.ownerConversationId = configured;
        return configured;
      }
      logger.warn(
        "SchedulerRuntime",
        `Configured scheduler owner conversation ${configured} is missing; creating a new owner and re-keying durable tasks`,
      );
      // 旧 owner 不再存在：清空各任务的 durable id，避免挂在不可用 owner 上
      for (const task of store.listScheduledTasksRaw()) {
        if (task.durableTaskId) store.setScheduledTaskDurable(task.id, undefined, "pending");
      }
    }

    const conv = await harness.createConversation(
      { ownership: { kind: "ownerless" } },
      BACKGROUND_CONTEXT,
    );
    const id = String(conv.id);
    this.ownerConversationId = id;
    store.setConfig(OWNER_CONFIG_KEY, id);
    store.recordAudit("scheduler.owner_conversation", { conversationId: id, replaced: configured || null });
    return id;
  }
}

/** 计算下一次调度时间：every/cron 从 scheduledFor 起算，跳过已经过去的触发点 */
function nextRunAfter(
  task: ScheduledTaskDefinition,
  scheduledFor: number,
  now: number,
): number | undefined {
  let from = scheduledFor;
  let next = computeNextRunAt(task, from);
  for (let i = 0; next !== undefined && next <= now && i < 1_000; i++) {
    from = next;
    next = computeNextRunAt(task, from);
  }
  // 长时间停机（错过 >1000 个 cron 点）：直接以当前时刻为基准跳到下一次
  if (next === undefined || next <= now) next = computeNextRunAt(task, now);
  return next;
}

function freshTask(store: DatabaseStore, taskId: string): ScheduledTaskDefinition | undefined {
  return store.getScheduledTaskRaw(taskId);
}

