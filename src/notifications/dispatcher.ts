import { EventBus } from "../core/event-bus.ts";
import type { SchedulerCompletedEvent } from "../core/events.ts";
import { ChannelManager } from "../channels/manager.ts";
import { DatabaseStore } from "../config/database-store.ts";
import { logger } from "../utils/logger.ts";

/** 推送到渠道的结果摘要截断长度 */
const NOTIFY_RESULT_MAX_CHARS = 600;

/**
 * 平台事件 → 渠道通知的分发器 (订阅 EventBus, 与事件源解耦):
 * - 首选任务记录的通知目标 (创建任务的会话所在渠道+peer, 渠道层寻址,
 *   会话重置不影响); 目标渠道不可用时 fallback 到该 Agent 绑定的启用渠道;
 * - notify_enabled=false 的任务不推送 (结果仍记录在任务与管理台);
 * - 未来 QQ/企微等渠道实现 sendMessage 后自动接入, 无需改动本模块。
 */
export class NotificationDispatcher {
  private static instance?: NotificationDispatcher;
  private unsubscribe?: () => void;

  public static getInstance(): NotificationDispatcher {
    if (!NotificationDispatcher.instance) {
      NotificationDispatcher.instance = new NotificationDispatcher();
    }
    return NotificationDispatcher.instance;
  }

  public init(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = EventBus.getInstance().subscribe((e) => {
      if (e.type === "scheduler.completed") {
        void this.handleSchedulerCompleted(e);
      }
    });
    logger.info("Notifications", "Notification dispatcher started");
  }

  public stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private async handleSchedulerCompleted(e: SchedulerCompletedEvent): Promise<void> {
    const store = new DatabaseStore();
    const task = store.getScheduledTask(e.taskId);
    if (!task) return;
    if (!task.notifyEnabled) return;

    const statusLabel = e.status === "error" ? "执行失败" : e.status === "done" ? "已完成 (一次性)" : "执行完成";
    const result = (e.status === "error" ? e.error ?? e.result : e.result).slice(0, NOTIFY_RESULT_MAX_CHARS);
    const content = `⏱ 定时任务「${e.taskName}」第 ${e.runNumber} 次触发${statusLabel}\n\n${result}`;

    const channelManager = ChannelManager.getInstance();
    let delivered = false;
    let deliveredChannel: string | null = null;

    // 首选: 任务记录的通知目标 (创建任务的会话所在渠道)
    if (task.notifyChannelInstanceId && task.notifyPeerId) {
      delivered = await channelManager.sendNotification(
        task.notifyChannelInstanceId,
        task.notifyPeerId,
        content,
      ).catch((err) => {
        logger.warn("Notifications", `Notify via '${task.notifyChannelInstanceId}' failed: ${err}`);
        return false;
      });
      if (delivered) deliveredChannel = task.notifyChannelInstanceId;
    }

    // 兜底: 该 Agent 绑定的启用渠道 (如 terminal)
    if (!delivered) {
      const fallback = channelManager.findFallbackChannelForAgent(e.agentId);
      if (fallback) {
        // peer 对通知型渠道无寻址意义 (终端单用户); IM 渠道的通知需要真实 peer, 由任务的目标列承担
        delivered = await channelManager.sendNotification(fallback.id, "platform-notify", content).catch(() => false);
        if (delivered) deliveredChannel = fallback.id;
      }
    }

    store.recordAudit("scheduler.notified", {
      taskId: e.taskId,
      status: e.status,
      delivered,
      deliveredChannel,
      fallbackUsed: deliveredChannel !== null && deliveredChannel !== task.notifyChannelInstanceId,
      target: task.notifyChannelInstanceId ?? null,
    });
    if (!delivered) {
      logger.debug("Notifications", `Task '${e.taskId}' completed but no channel available; result kept on task record`);
    }
  }
}
