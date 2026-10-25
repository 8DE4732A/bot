import { EventBus } from "../core/event-bus.ts";
import type { SchedulerCompletedEvent } from "../core/events.ts";
import { ChannelManager } from "../channels/manager.ts";
import { DatabaseStore } from "../config/database-store.ts";
import { logger } from "../utils/logger.ts";

/** 推送到渠道的结果摘要截断长度 */
const NOTIFY_RESULT_MAX_CHARS = 600;
/** outbox 周期扫描（不依赖 EventBus 事件是否送达） */
const SCAN_INTERVAL_MS = 30_000;

interface NotificationPayload {
  runId: string;
  runNumber: number;
  taskId: string;
  taskName: string;
  agentId: string;
  status: "ok" | "error" | "done" | "aborted";
  source: "schedule" | "manual";
  result?: string;
  error?: string;
  target?: { channelInstanceId: string; peerId: string } | null;
}

/**
 * 平台通知分发器：
 * - 六期 durable 模式：消费 `scheduled_task_notifications` outbox（runId 唯一、
 *   claim_token 原子 claim、失败指数退避），EventBus 只作为进程内快速唤醒信号；
 * - polling 回滚模式：仍按事件直接投递（旧语义，无 outbox）；
 * - 寻址：任务记录的通知目标优先，fallback 到 Agent 绑定的终端类渠道。
 */
export class NotificationDispatcher {
  private static instance?: NotificationDispatcher;
  private readonly owner = `notifier-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  private unsubscribe?: () => void;
  private timer?: ReturnType<typeof setInterval>;
  private scanning = false;
  private lastPurgeAt = 0;

  public static getInstance(): NotificationDispatcher {
    if (!NotificationDispatcher.instance) {
      NotificationDispatcher.instance = new NotificationDispatcher();
    }
    return NotificationDispatcher.instance;
  }

  public init(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = EventBus.getInstance().subscribe((e) => {
      if (e.type !== "scheduler.completed") return;
      if (e.runId) {
        // outbox 是唯一投递真相；事件只触发一次即时扫描
        void this.scan();
      } else {
        // polling 回退路径（无 ledger/outbox）
        void this.handleLegacyCompleted(e);
      }
    });
    this.timer = setInterval(() => void this.scan(), SCAN_INTERVAL_MS);
    this.timer.unref?.();
    // 启动补发：等渠道适配器启动完成（CLI 在 dispatcher.init 之后 startAll）
    setTimeout(() => void this.scan(), 1_500).unref?.();
    logger.info("Notifications", "Notification dispatcher started (scheduled outbox)");
  }

  public stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** 扫描并投递 outbox（幂等、可重入保护） */
  public async scan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const store = new DatabaseStore();
      const now = Date.now();
      const claimed = store.claimScheduledNotifications(this.owner, now, 10);
      for (const { record, token } of claimed) {
        let payload: NotificationPayload;
        try {
          payload = JSON.parse(record.payload) as NotificationPayload;
        } catch (err) {
          store.markNotificationFailed(record.runId, token, Date.now(), `invalid payload: ${err}`, 3600_000);
          continue;
        }
        const result = await this.deliver(payload);
        if (result.delivered) {
          store.markNotificationDelivered(record.runId, token, Date.now());
        } else {
          const attempts = record.attempts + 1;
          const backoff = Math.min(3600_000, 10_000 * 2 ** Math.min(attempts, 8));
          store.markNotificationFailed(record.runId, token, Date.now(), result.error ?? "no channel", backoff);
        }
        store.recordAudit("scheduler.notified", {
          taskId: payload.taskId,
          runId: payload.runId,
          status: payload.status,
          delivered: result.delivered,
          deliveredChannel: result.channel,
          fallbackUsed: result.channel !== null && result.channel !== payload.target?.channelInstanceId,
          target: payload.target?.channelInstanceId ?? null,
        });
      }
      if (now - this.lastPurgeAt > 3600_000) {
        this.lastPurgeAt = now;
        store.purgeScheduledNotifications(now);
      }
    } catch (err) {
      logger.warn("Notifications", `Outbox scan failed: ${err}`);
    } finally {
      this.scanning = false;
    }
  }

  private async deliver(payload: NotificationPayload): Promise<{ delivered: boolean; channel: string | null; error?: string }> {
    const labels: Record<NotificationPayload["status"], string> = {
      error: "执行失败",
      done: "已完成 (一次性)",
      aborted: "已中止",
      ok: payload.source === "manual" ? "手动执行完成" : "执行完成",
    };
    const statusLabel = labels[payload.status];
    const body = (
      payload.status === "error" ? payload.error ?? payload.result ?? "" : payload.result ?? ""
    ).slice(0, NOTIFY_RESULT_MAX_CHARS);
    const content = `⏱ 定时任务「${payload.taskName}」第 ${payload.runNumber} 次触发${statusLabel}\n\n${body}`;
    const channelManager = ChannelManager.getInstance();

    if (payload.target?.channelInstanceId && payload.target.peerId) {
      try {
        const delivered = await channelManager.sendNotification(
          payload.target.channelInstanceId,
          payload.target.peerId,
          content,
        );
        if (delivered) return { delivered: true, channel: payload.target.channelInstanceId };
      } catch (err) {
        logger.warn(
          "Notifications",
          `Notify via '${payload.target.channelInstanceId}' failed: ${err}`,
        );
      }
    }

    const fallback = channelManager.findFallbackChannelForAgent(
      payload.agentId,
      (a) => a.type === "terminal",
    );
    if (fallback) {
      try {
        const delivered = await channelManager.sendNotification(
          fallback.id,
          "platform-notify",
          content,
        );
        if (delivered) return { delivered: true, channel: fallback.id };
      } catch (err) {
        logger.warn("Notifications", `Fallback notify via '${fallback.id}' failed: ${err}`);
      }
    }
    return { delivered: false, channel: null, error: "no channel available" };
  }

  /** polling 回滚路径：无 outbox 的旧事件直接投递 */
  private async handleLegacyCompleted(e: SchedulerCompletedEvent): Promise<void> {
    const store = new DatabaseStore();
    const task = store.getScheduledTask(e.taskId);
    if (!task) return;
    if (!task.notifyEnabled) return;
    const delivered = await this.deliver({
      runId: `legacy:${e.taskId}:${e.runNumber}`,
      runNumber: e.runNumber,
      taskId: e.taskId,
      taskName: e.taskName,
      agentId: e.agentId,
      status: e.status === "error" ? "error" : e.status === "done" ? "done" : "ok",
      source: "schedule",
      result: e.result,
      error: e.error,
      target:
        task.notifyChannelInstanceId && task.notifyPeerId
          ? {
              channelInstanceId: task.notifyChannelInstanceId,
              peerId: task.notifyPeerId,
            }
          : null,
    });
    if (!delivered.delivered) {
      logger.debug("Notifications", `Task '${e.taskId}' completed but no channel available; result kept on task record`);
    }
  }
}
