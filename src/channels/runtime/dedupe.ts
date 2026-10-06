/**
 * 入站消息去重 (对齐 hermes MessageDeduplicator):
 * 平台事件重推 / 长轮询重连双投防御。TTL 过期自动清理。
 * 无 messageId 的消息不参与去重 (始终视为新消息)。
 */
export class MessageDeduplicator {
  private seen = new Map<string, number>();
  private lastSweep = 0;

  constructor(
    private readonly ttlMs = 300_000,
    private readonly maxEntries = 10_000,
  ) {}

  /** 返回 true 表示重复 (已处理过, 应丢弃) */
  public isDuplicate(messageId: string | undefined): boolean {
    if (!messageId) return false;
    this.sweepIfNeeded();
    const now = Date.now();
    const prev = this.seen.get(messageId);
    if (prev !== undefined && now - prev < this.ttlMs) return true;
    this.seen.set(messageId, now);
    if (this.seen.size > this.maxEntries) {
      // 容量兜底: 淘汰最旧的一半 (正常情况下 TTL sweep 已足够)
      const entries = [...this.seen.entries()].sort((a, b) => a[1] - b[1]);
      for (const [k] of entries.slice(0, Math.floor(this.maxEntries / 2))) {
        this.seen.delete(k);
      }
    }
    return false;
  }

  private sweepIfNeeded(): void {
    const now = Date.now();
    if (now - this.lastSweep < 30_000) return;
    this.lastSweep = now;
    for (const [key, ts] of this.seen) {
      if (now - ts >= this.ttlMs) this.seen.delete(key);
    }
  }
}
