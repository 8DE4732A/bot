import { logger } from "../../utils/logger.ts";
import { DatabaseStore } from "../../config/database-store.ts";

export interface LoopGuardOptions {
  /** 滑动窗口时长 */
  windowMs?: number;
  /** 窗口内允许的最大派发次数 (超限熔断) */
  maxEvents?: number;
}

export interface LoopGuardVerdict {
  allowed: boolean;
  /** 熔断时给管理台/审计看的说明 */
  reason?: string;
}

/**
 * 群聊防自循环 (对齐 hermes bot_loop_guard):
 * agent 回复触发平台上另一条 @ 消息再触发 agent 的回环。滑动窗口内
 * 同 peer 派发次数超限即熔断 (拒绝派发并审计), 需要人工介入排查。
 * 过期条目懒清扫 (不为清理建常驻定时器); 审计写入按熔断持续期节流
 * (每窗口最多一条), 防止被熔断的 peer 刷爆审计表。
 */
export class LoopGuard {
  private readonly windowMs: number;
  private readonly maxEvents: number;
  private events = new Map<string, number[]>();
  /** 每 peer 上次写熔断审计的时间 (审计节流) */
  private lastAuditAt = new Map<string, number>();
  private store = new DatabaseStore();

  constructor(options: LoopGuardOptions = {}) {
    this.windowMs = options.windowMs ?? 60_000;
    this.maxEvents = options.maxEvents ?? 8;
  }

  public check(channelId: string, peerId: string): LoopGuardVerdict {
    const now = Date.now();
    const key = `${channelId}:${peerId}`;
    this.sweepExpired(now);
    const list = (this.events.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length >= this.maxEvents) {
      this.events.set(key, list);
      // 审计节流: 同 peer 每 5 分钟最多一条 (熔断持续期内的请求都会被拒绝,
      // 全量审计会让被熔断的 peer 刷爆 audit_logs)
      const lastAudit = this.lastAuditAt.get(key) ?? 0;
      if (now - lastAudit > 300_000) {
        this.lastAuditAt.set(key, now);
        const reason = `loop-guard tripped: ${list.length} dispatches from ${key} within ${this.windowMs / 1000}s`;
        logger.warn("LoopGuard", reason);
        try {
          this.store.recordAudit("channel.loop_guard", { key, events: list.length, windowMs: this.windowMs });
        } catch {
          // 审计失败不阻断判定
        }
        return { allowed: false, reason };
      }
      return { allowed: false, reason: `loop-guard active for ${key}` };
    }
    list.push(now);
    this.events.set(key, list);
    return { allowed: true };
  }

  /** 懒清扫: 全部时间戳过期的 peer 条目释放 (Map 不随陌生 peer 无界增长) */
  private sweepExpired(now: number): void {
    if (this.events.size < 256) return;
    for (const [key, list] of this.events) {
      const latest = list[list.length - 1];
      if (latest !== undefined && now - latest >= this.windowMs) {
        this.events.delete(key);
        this.lastAuditAt.delete(key);
      }
    }
  }

  /** 人工确认排除故障后重置某 peer (管理台预留) */
  public reset(channelId: string, peerId: string): void {
    this.events.delete(`${channelId}:${peerId}`);
    this.lastAuditAt.delete(`${channelId}:${peerId}`);
  }
}
