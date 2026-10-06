import { logger } from "../../utils/logger.ts";

/**
 * 入站防抖合并 (对齐 hermes webhook_coalesce, 时间窗按 IM 打字节奏调小):
 * 用户连发多条 → 同 peer 在 quiet window 内只派发一次, 文本以 "\n" 合并;
 * maxWait 自首条起算, 防止持续短消息导致饿死。
 * 定时器经 unref 允许进程正常退出; stop() 强制冲刷剩余消息。
 *
 * 元数据语义: 合并组的消息级元数据 (attachments/replyContext 等) 取**最新**
 * 一条——合并派发代表的是该 peer 的最新状态, 被动回复凭据/附件以新者为准。
 * 派发回调在定时器上下文执行, 失败只记录日志 (fire-and-forget,
 * 绝不让 rejection 冒泡成 unhandled rejection 杀进程)。
 */
export interface CoalesceOptions<TMeta> {
  /** 静默窗: 每条新消息重置计时, 窗满派发 */
  quietMs?: number;
  /** 最大等待: 自首条起算, 到期强制派发 */
  maxWaitMs?: number;
  /**
   * 元数据合并策略 (默认取最新)。合并组内各消息的元数据如何归并:
   * 默认"新者为准"适合 replyContext; 附件类元数据应做并集 (防前条附件丢失)。
   */
  metaMerge?: (prev: TMeta, next: TMeta) => TMeta;
}

export class MessageCoalescer<TKey, TMeta> {
  private readonly quietMs: number;
  private readonly maxWaitMs: number;
  private buffers = new Map<
    string,
    {
      parts: string[];
      meta: TMeta;
      firstAt: number;
      timer: ReturnType<typeof setTimeout>;
      maxTimer: ReturnType<typeof setTimeout>;
    }
  >();

  private readonly metaMerge?: (prev: TMeta, next: TMeta) => TMeta;

  constructor(
    options: CoalesceOptions<TMeta> = {},
    private readonly dispatch: (key: string, merged: string, meta: TMeta) => Promise<void>,
  ) {
    this.quietMs = options.quietMs ?? 5_000;
    this.maxWaitMs = options.maxWaitMs ?? 30_000;
    this.metaMerge = options.metaMerge;
  }

  /** 提交一条消息; 到期后以合并文本 + 最新元数据回调 (每个 key 串行) */
  public submit(key: string, text: string, meta: TMeta): void {
    const existing = this.buffers.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      existing.parts.push(text);
      existing.meta = this.metaMerge ? this.metaMerge(existing.meta, meta) : meta;
      existing.timer = this.scheduleQuiet(key);
      return;
    }
    const entry = {
      parts: [text],
      meta,
      firstAt: Date.now(),
      timer: this.scheduleQuiet(key),
      maxTimer: setTimeout(() => void this.flush(key), this.maxWaitMs),
    };
    entry.maxTimer.unref?.();
    this.buffers.set(key, entry);
  }

  private scheduleQuiet(key: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => void this.flush(key), this.quietMs);
    timer.unref?.();
    return timer;
  }

  /** 派发失败只记录 (定时器上下文的 rejection 无人能接, 冒泡即 unhandled → 杀进程) */
  private async flush(key: string): Promise<void> {
    const entry = this.buffers.get(key);
    if (!entry) return;
    this.buffers.delete(key);
    clearTimeout(entry.timer);
    clearTimeout(entry.maxTimer);
    try {
      await this.dispatch(key, entry.parts.join("\n"), entry.meta);
    } catch (err) {
      logger.error("Coalescer", `Dispatch failed for ${key}: ${err instanceof Error ? err.stack || err.message : err}`);
    }
  }

  /** 优雅停机: 冲刷全部未派发消息 (等待派发完成) */
  public async stop(): Promise<void> {
    const keys = [...this.buffers.keys()];
    await Promise.allSettled(keys.map((k) => this.flush(k)));
  }
}
