/** 平台事件类型 (进程内 pub/sub, 渠道通知等消费方订阅) */

export interface SchedulerCompletedEvent {
  type: "scheduler.completed";
  taskId: string;
  taskName: string;
  agentId: string;
  /** ok | error | done (done = once 任务完成) */
  status: string;
  runNumber: number;
  /** 执行结果全文 (调度器已截断入库的那份) */
  result: string;
  error?: string;
}

export type PlatformEvent = SchedulerCompletedEvent | SandboxViolationEvent;

/** 内核沙盒违规 (Seatbelt/seccomp/代理拒绝, 经 SandboxViolationStore 订阅转发) */
export interface SandboxViolationEvent {
  type: "sandbox.violation";
  agentId: string | null;
  /** ASRT 违规行 (如 "deny(1) file-read* ..." ) */
  line: string;
  command?: string;
  timestamp: number;
}
