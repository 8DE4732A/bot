import { defineTask } from "@earendil-works/pi-durable";
import type { TaskRuntime } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { DatabaseStore } from "../config/database-store.ts";
import type { CancelChatResult } from "./contracts.ts";
import {
  ConversationPoisoned,
  LeaseLost,
  RunFinalizeError,
  SchedulerBusy,
  SchedulerNotReady,
} from "./contracts.ts";

/**
 * 六期核心任务：1 个业务 scheduled_task ↔ 1 个 durable task。
 * - wait phase 精确 sleepUntil(next_run_at)，每次唤醒重读业务库；
 * - 触发点身份先落 checkpoint（runKey = taskId + scheduleVersion + scheduledFor），
 *   再进入 run phase 调宿主 runner（双库半提交的核心顺序，设计 §5.1/§5.2）；
 * - runner 不接收 framework signal，避免 phase 结束误取消已提交的生成。
 */

export const SCHEDULED_PROMPT_TASK = "bot.scheduled-prompt";

export type ScheduledPromptInput = { scheduledTaskId: string };

export type ScheduledPromptCheckpoint =
  | { phase: "wait" }
  | {
      phase: "run";
      scheduleVersion: number;
      runKey: string;
      scheduledFor: number;
      /** 取消 chat 的重试计数；按 (runKey, lease_fence) 独立计数 */
      cancelAttempts?: number;
      cancelFence?: number;
    };

export type ScheduledPromptResult = {
  reason: "deleted" | "disabled" | "done" | "superseded";
};

export type SchedulerRunOutcome =
  | { kind: "completed"; runId: string; answer: string }
  | { kind: "already-done"; runId: string; answer: string }
  | { kind: "superseded" };

/** 宿主 runner：由 SchedulerRuntime 注入，phase 只依赖该接口。 */
export interface SchedulerRunner {
  runScheduledPrompt(input: {
    taskId: string;
    runKey: string;
    scheduledFor: number;
    scheduleVersion: number;
    durableTaskId?: string;
  }): Promise<SchedulerRunOutcome>;
  currentRunFence(taskId: string, runKey: string): Promise<number | undefined>;
  cancelChatForTask(
    taskId: string,
    timeoutMs: number,
    expectedRunKey?: string | string[],
    options?: {
      expectedLeaseFence?: number;
      expectedOwner?: string;
      allowConversationAbortForStaleOwner?: string;
    },
  ): Promise<CancelChatResult>;
  markConversationPoisoned(input: {
    taskId: string;
    runKey: string;
    fence: number;
    scheduleVersion: number;
  }): Promise<void>;
  /** 确认旧 chat 已退出且 conversation idle 后，显式交回 lease（允许重试接管） */
  releaseRunLease(taskId: string, runKey: string, fence?: number): Promise<void>;
  isReady(): boolean;
}

let runner: SchedulerRunner | undefined;

export function setSchedulerRunner(value: SchedulerRunner | undefined): void {
  runner = value;
}

function requireRunner(): SchedulerRunner {
  if (!runner) throw new SchedulerNotReady("Scheduler runner is not installed");
  return runner;
}

async function terminal(
  runtime: TaskRuntime<ScheduledPromptInput, ScheduledPromptCheckpoint, ScheduledPromptResult, object>,
  context: Context,
  reason: ScheduledPromptResult["reason"],
): Promise<void> {
  await runtime.commit(
    () => ({
      status: "terminal",
      outcome: { status: "completed", result: { reason } },
    }),
    context,
  );
}

async function failTerminal(
  runtime: TaskRuntime<ScheduledPromptInput, ScheduledPromptCheckpoint, ScheduledPromptResult, object>,
  context: Context,
  message: string,
): Promise<void> {
  await runtime.commit(
    () => ({
      status: "terminal",
      outcome: { status: "failed", error: { message } },
    }),
    context,
  );
}

export const ScheduledPromptTask = defineTask<
  ScheduledPromptInput,
  ScheduledPromptCheckpoint,
  ScheduledPromptResult
>({
  name: SCHEDULED_PROMPT_TASK,
  version: 1,
  initial: () => ({ phase: "wait" }),
  phases: {
    async wait(task, runtime, context) {
      const store = new DatabaseStore();
      const row = store.getScheduledTaskRaw(task.input.scheduledTaskId);
      if (!row || row.deletedAt) return terminal(runtime, context, "deleted");
      if (!row.enabled) return terminal(runtime, context, "disabled");

      const next = row.nextRunAt;
      if (next === undefined) return terminal(runtime, context, "done");
      if (next > runtime.now()) {
        return runtime.sleepUntil(next, { phase: "wait" }, context);
      }

      // 关键顺序：先把触发点 identity 写入 durable checkpoint，再进入 run。
      // 即使业务 reserve 前后崩溃，重放也能从 checkpoint 重建 runKey。
      const runKey = `schedule:${task.input.scheduledTaskId}:${row.scheduleVersion}:${next}`;
      await runtime.commit(
        () => ({
          status: "running",
          checkpoint: {
            phase: "run",
            scheduleVersion: row.scheduleVersion,
            runKey,
            scheduledFor: next,
          },
        }),
        context,
      );
    },

    async run(task, runtime, context) {
      const cp = task.state.checkpoint;
      if (cp.phase !== "run") {
        // 防御：checkpoint/phase 不一致时退回 wait（正常不可达）
        return runtime.sleepUntil(runtime.now() + 1_000, { phase: "wait" }, context);
      }
      const activeRunner = requireRunner();

      try {
        const outcome = await activeRunner.runScheduledPrompt({
          taskId: task.input.scheduledTaskId,
          runKey: cp.runKey,
          scheduledFor: cp.scheduledFor,
          scheduleVersion: cp.scheduleVersion,
          durableTaskId: String(task.id),
        });
        if (outcome.kind === "superseded") {
          return terminal(runtime, context, "superseded");
        }
      } catch (err) {
        // 启动 gate 未就绪：保留同一 checkpoint，1s 后重试
        if (err instanceof SchedulerNotReady) {
          return runtime.sleepUntil(runtime.now() + 1_000, cp, context);
        }
        // 同一任务已有 manual/其他 run：让路，稍后重试同一 checkpoint
        if (err instanceof SchedulerBusy) {
          return runtime.sleepUntil(runtime.now() + 5_000, cp, context);
        }
        // poisoned 是 fail-closed：不 cancel、不累计 attempts、不重试
        if (err instanceof ConversationPoisoned) {
          runtime.report(err);
          try {
            await activeRunner.markConversationPoisoned({
              taskId: task.input.scheduledTaskId,
              runKey: cp.runKey,
              fence: cp.cancelFence ?? 0,
              scheduleVersion: cp.scheduleVersion,
            });
          } catch (poisonErr) {
            runtime.report(poisonErr);
          }
          return failTerminal(runtime, context, "conversation_poisoned");
        }
        // lease/fence 已丢失：旧 owner 不得再写终态（runner 已取消 chat）
        if (err instanceof LeaseLost || err instanceof RunFinalizeError) {
          runtime.report(err);
          return failTerminal(runtime, context, err.name);
        }

        runtime.report(err);
        // 进入取消前先读取当前 run 的 fence（按 runKey 精确读取）
        let fence: number | undefined;
        try {
          fence = await activeRunner.currentRunFence(task.input.scheduledTaskId, cp.runKey);
        } catch (fenceErr) {
          runtime.report(fenceErr);
        }
        // phase 内只取消并等待 chat，不调用 abortTask（避免 phase 等自己）
        const cancelled = await activeRunner.cancelChatForTask(
          task.input.scheduledTaskId,
          30_000,
          cp.runKey,
          fence !== undefined ? { expectedLeaseFence: fence } : undefined,
        );
        if (cancelled.chatExited && cancelled.idle) {
          // 旧 chat 已确认退出：显式释放 lease，下一次重放才允许接管；
          // 未确认退出时保持原租约（等自然过期），绝不二次 chat。
          await activeRunner
            .releaseRunLease(task.input.scheduledTaskId, cp.runKey, fence)
            .catch((releaseErr) => runtime.report(releaseErr));
          // 成功取消后清零计数，避免下一次失败继承旧 attempts
          return runtime.sleepUntil(
            runtime.now() + 30_000,
            { ...cp, cancelFence: fence, cancelAttempts: 0 },
            context,
          );
        }
        // cancelAttempts 必须绑定当前 lease_fence；接管后 fence 变化则从 0 计数
        const base = fence !== undefined && cp.cancelFence === fence ? (cp.cancelAttempts ?? 0) : 0;
        const attempts = base + 1;
        if (attempts >= 5) {
          // 持续无法确认 chat 退出：标记 conversation poisoned，禁止复用/自动重建
          if (fence !== undefined) {
            await activeRunner
              .markConversationPoisoned({
                taskId: task.input.scheduledTaskId,
                runKey: cp.runKey,
                fence,
                scheduleVersion: cp.scheduleVersion,
              })
              .catch((poisonErr) => runtime.report(poisonErr));
          }
          return failTerminal(runtime, context, "chat_cancel_timeout");
        }
        return runtime.sleepUntil(
          runtime.now() + 30_000,
          { ...cp, cancelFence: fence, cancelAttempts: attempts },
          context,
        );
      }

      const store = new DatabaseStore();
      const row = store.getScheduledTaskRaw(task.input.scheduledTaskId);
      if (!row || row.deletedAt) return terminal(runtime, context, "deleted");
      // 编辑代际已变化：旧 task 不再负责新的触发点
      if (row.scheduleVersion !== cp.scheduleVersion) {
        return terminal(runtime, context, "superseded");
      }
      // once 完成：reserve 已置空 next_run_at，但 enabled 的关闭由 finishRun 负责。
      // 必须先判断 done，再判断 disabled，否则会把 done 误报为 disabled。
      if (row.nextRunAt === undefined) return terminal(runtime, context, "done");
      if (!row.enabled) return terminal(runtime, context, "disabled");

      const next = row.nextRunAt;
      if (next > runtime.now()) {
        return runtime.sleepUntil(next, { phase: "wait" }, context);
      }
      // next_run_at 仍在过去（例如执行期间被编辑）：先退避，避免热循环
      return runtime.sleepUntil(runtime.now() + 60_000, { phase: "wait" }, context);
    },
  },

  async abort(task, runtime, context) {
    await runtime.commit(
      () => ({ status: "terminal", outcome: { status: "aborted", reason: "aborted" } }),
      context,
    );
  },
});
