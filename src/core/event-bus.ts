import type { PlatformEvent } from "./events.ts";
import { logger } from "../utils/logger.ts";

/**
 * 平台事件总线 (进程内 pub/sub): 渠道通知、未来 webhook 推送等消费方
 * 在此订阅, 事件源 (调度器/渠道/审计) 只发布事实, 不关心谁消费。
 * 订阅者抛错不影响其他订阅者与发布方。
 */
export class EventBus {
  private static instance?: EventBus;
  private handlers: ((e: PlatformEvent) => void | Promise<void>)[] = [];

  public static getInstance(): EventBus {
    if (!EventBus.instance) {
      EventBus.instance = new EventBus();
    }
    return EventBus.instance;
  }

  public subscribe(handler: (e: PlatformEvent) => void | Promise<void>): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  public publish(event: PlatformEvent): void {
    for (const handler of [...this.handlers]) {
      try {
        // async handler 的 rejection 也要兜住: 同步 try/catch 捕不到 rejected promise,
        // 未处理的 rejection 会直接杀掉宿主进程 (实测 Bun exit 1)
        void Promise.resolve(handler(event)).catch((err) => {
          logger.warn("EventBus", `Event handler for '${event.type}' failed: ${err}`);
        });
      } catch (err) {
        logger.warn("EventBus", `Event handler for '${event.type}' failed: ${err}`);
      }
    }
  }
}
