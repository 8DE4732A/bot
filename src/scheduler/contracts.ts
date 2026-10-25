/**
 * 六期调度器与 AgentManager 之间的稳定契约（错误类型 + runner 接口）。
 * 独立成模块以避免 durable-runtime ↔ agent-manager 的循环依赖。
 */

/** 调度错误基类：name 恒等于具体错误类名（instanceof/日志归因都依赖它） */
abstract class SchedulerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** 启动 gate 未就绪：保留同一 checkpoint，1s 后重试。 */
export class SchedulerNotReady extends SchedulerError {
  constructor(message = "Scheduler is not ready") {
    super(message);
  }
}

/** 会话已被 poison：fail-closed，不自动复用/重建，只能人工 reset。 */
export class ConversationPoisoned extends SchedulerError {
  constructor(message = "Scheduler conversation is poisoned") {
    super(message);
  }
}

/** 任务声明的 conversation 已不存在：fail-closed，绝不静默新建（否则 requestId 去重失效）。 */
export class ConversationMissing extends SchedulerError {
  constructor(message = "Scheduler conversation is missing") {
    super(message);
  }
}

/** lease/fence 已被接管：旧 owner 必须立即取消当前 run，不得继续提交/通知。 */
export class LeaseLost extends SchedulerError {
  constructor(message = "Scheduled run lease was lost") {
    super(message);
  }
}

/** 同一任务已有另一个 running run：本次触发让路（scheduled 退避重试 / manual 409）。 */
export class SchedulerBusy extends SchedulerError {
  constructor(message = "Scheduled task already has an active run") {
    super(message);
  }
}

/** 同一任务已有 active run：手动触发明确冲突，不能并发第二个 run。 */
export class RunBusy extends SchedulerError {
  constructor(message = "Scheduled task already has an active run") {
    super(message);
  }
}

/** ledger 终态写入失败（运维可见的明确错误，而不是静默悬挂）。 */
export class RunFinalizeError extends SchedulerError {
  constructor(message = "Failed to finalize scheduled run") {
    super(message);
  }
}

/** cancelChat 的结构化结果：调用方逐项检查，不用单一 boolean 误判 */
export interface CancelChatResult {
  chatExited: boolean;
  idle: boolean;
  reason:
    | "no_active_chat"
    | "aborted"
    | "already_placed"
    | "timeout"
    | "conversation_missing"
    | "run_mismatch"
    | "error";
}
