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

export type PlatformEvent =
  | SchedulerCompletedEvent
  | SandboxViolationEvent
  | ChatTurnEvent
  | ChannelStatusEvent
  | ChannelHealthEvent
  | TaskUpdatedEvent
  | AuditRecordedEvent;

/** 一轮对话的生命周期 (管理台事件流 / SessionHub 会话订阅的粒度锚点) */
export interface ChatTurnEvent {
  type: "chat.turn";
  agentId: string;
  /** 会话键 (channelInstanceId:peerId / web-playground:<agentId> / scheduler:<taskId>) */
  sessionId: string;
  phase: "start" | "completed" | "error";
  durationMs?: number;
  error?: string;
}

/** 渠道 adapter 生命周期 (管理台渠道卡片状态语义: enabled ≠ connected) */
export interface ChannelStatusEvent {
  type: "channel.status";
  channelId: string;
  state: "started" | "stopped" | "error";
  detail?: string;
}

/** 定时任务记录变化 (创建/触发/状态更新, 管理台任务页静默刷新) */
export interface TaskUpdatedEvent {
  type: "task.updated";
  taskId: string;
  agentId: string;
}

/** 审计记录落库 (管理台审计页静默刷新) */
export interface AuditRecordedEvent {
  type: "audit.recorded";
  event: string;
  agentId?: string;
}

/** 渠道健康探测结果 (gateway 周期 healthCheck → 渠道页徽章自动刷新) */
export interface ChannelHealthEvent {
  type: "channel.health";
  channelId: string;
  ok: boolean;
  detail?: string;
  checkedAt: number;
}

/** 内核沙盒违规 (Seatbelt/seccomp/代理拒绝, 经 SandboxViolationStore 订阅转发) */
export interface SandboxViolationEvent {
  type: "sandbox.violation";
  agentId: string | null;
  /** ASRT 违规行 (如 "deny(1) file-read* ..." ) */
  line: string;
  command?: string;
  timestamp: number;
}
