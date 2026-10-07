import { randomUUID } from "node:crypto";
import { AgentManager, type ChatChunk } from "../core/agent-manager.ts";
import { EventBus } from "../core/event-bus.ts";
import { logger } from "../utils/logger.ts";

/**
 * SessionHub (四期 M2, 设计 §4.2): 会话事件中枢——同一 dispatch 的第二传输。
 * - 全局单调 seq + 有界重放环 (512 事件): 客户端断线重连经 replaySince
 *   补洞, 绝不信任有洞的 replay (truncated=true 强制全量拉);
 * - replay_epoch (进程 UUID): 客户端检测服务端重启 → 重置 seq 水位
 *   (seq 计数器随进程消失, "events_since(97) 永远空回" 是实测事故形态);
 * - seq 是**进程级单调计数器** (R6 评审 B1): 环逐出/重建不可能重置单调性
 *   (R5 的 per-ring nextSeq + 墓碑方案受墓碑容量限制, 超限丢墓碑即回归;
 *   全局计数器从根上消除该类故障, truncated 判定 oldest > lastSeq+1 依然精确)。
 */

/** 重放环上限 (事件条数) */
const RING_CAPACITY = 512;
/** 活跃会话环上限 (LRU 逐出最久未更新的环; 逐出不重置 seq——
 * 重连 since 早于环存在时 truncated=true 全量拉) */
const MAX_SESSIONS = 64;

export type SessionEventKind =
  | "turn_start"
  | "delta"
  | "tool"
  | "usage"
  | "turn_end"
  | "platform";

export interface SessionEvent {
  seq: number;
  ts: number;
  kind: SessionEventKind;
  data: unknown;
}

interface SessionRing {
  events: SessionEvent[];
  lastActivity: number;
}

export interface ReplayResult {
  epoch: string;
  events: SessionEvent[];
  /** lastSeq 早于环最旧事件 → 有洞: 客户端必须全量拉 (events 已含全部环内事件) */
  truncated: boolean;
}

export class SessionHub {
  private static instance?: SessionHub;
  private rings = new Map<string, SessionRing>();
  /** 进程生命周期内恒定 (客户端据此识别 gateway 重启) */
  readonly epoch = randomUUID();
  private unsubscribe?: () => void;
  private unsubTurn?: () => void;

  public static getInstance(): SessionHub {
    if (!SessionHub.instance) {
      SessionHub.instance = new SessionHub();
    }
    return SessionHub.instance;
  }

  /** 事件推送回调 (WS 层注册; 返回订阅列表是否变化) */
  private sinks = new Set<(sessionKey: string, event: SessionEvent) => void>();

  public onEvent(sink: (sessionKey: string, event: SessionEvent) => void): () => void {
    this.sinks.add(sink);
    return () => {
      this.sinks.delete(sink);
    };
  }

  /** 进程级单调 seq 计数器 (R6 评审 B1, 见类注释) */
  private globalSeq = 0;
  /**
   * attach 状态 (key → 引用计数), **独立于环缓存** (R7 评审 B1: 此前 attach
   * 引用记在 ring.pinCount 上, 环被强逐时订阅状态一起消失——platform 事件
   * 对"仍在线但环被逐"的会话永久丢失)。evictOneRing 逐的是缓存, 订阅面
   * 不受影响; fanout 对 attached 但无环的 key 先 ensureRing 重建再投递。
   */
  private attachedKeys = new Map<string, number>();

  /** 接线 AgentManager turn 流 + EventBus turn 生命周期/平台事件 (进程启动时调用) */
  public start(): void {
    if (this.unsubscribe) return;
    this.unsubTurn = AgentManager.getInstance().onTurnEvent((agentId, sessionId, chunk) => {
      this.record(agentId, sessionId, chunk);
    });
    this.unsubscribe = EventBus.getInstance().subscribe((e) => {
      if (e.type === "chat.turn") {
        const kind: SessionEventKind = e.phase === "start" ? "turn_start" : "turn_end";
        this.record(e.agentId, e.sessionId, {
          kind,
          data: { phase: e.phase, durationMs: e.durationMs, error: e.error },
        } as any);
      } else if (e.type === "scheduler.completed") {
        // platform 事件 fanout 到该 Agent 的**全部**会话环 (R1 评审 B5/M11:
        // 此前记到 `agentId:scheduler:<taskId>` 环, TUI attach 的是
        // terminal-main 会话, 永远收不到——通知兜底 §4.4 断链)。
        // 离线忽略语义不变: 无活跃环即不积压。
        // ⚠️ 必须先复制 keys (R2 评审 B3): append 的 LRU 置顶会对当前 key
        // delete+reinsert, Map 迭代中修改顺序会导致同一 key 被无限重访 → 挂死
        let delivered = 0;
        // 投递面 = 环 + attached (R7 评审 B1: 环被强逐的在线会话先重建
        // 空环再投递——全局 seq 下新事件 watermark 正确, replay 可见)
        const targets = new Set<string>();
        for (const key of this.rings.keys()) {
          if (key.startsWith(`${e.agentId}:`)) targets.add(key);
        }
        for (const key of this.attachedKeys.keys()) {
          if (key.startsWith(`${e.agentId}:`)) targets.add(key);
        }
        for (const key of targets) {
          // recordRaw→append 对缺失 key 自建环 (不触碰 attachedKeys——R8 评审
          // B1: 内部重建绝不能虚增订阅计数), 前置 ensureRing 调用是 no-op 已删
          this.recordRaw(key, "platform", e);
          delivered++;
        }
        if (delivered === 0) {
          logger.debug("SessionHub", `Platform event for ${e.agentId} has no live session ring; dropped`);
        }
      }
    });
    logger.info("SessionHub", `SessionHub started (epoch ${this.epoch.slice(0, 8)})`);
  }

  public stop(): void {
    this.unsubTurn?.();
    this.unsubscribe?.();
    this.unsubTurn = undefined;
    this.unsubscribe = undefined;
  }

  /** AgentManager ChatChunk → 会话事件 */
  private record(agentId: string, sessionId: string, chunk: ChatChunk): void {
    const key = `${agentId}:${sessionId}`;
    if (chunk.delta !== undefined) this.append(key, "delta", { delta: chunk.delta });
    if (chunk.toolCall) this.append(key, "tool", chunk.toolCall);
    if (chunk.usage) this.append(key, "usage", chunk.usage);
    // 其余形态 (turn 生命周期) 经 EventBus 路径
    if (!chunk.delta && !chunk.toolCall && !chunk.usage) {
      const anyChunk = chunk as any;
      if (anyChunk.kind) this.append(key, anyChunk.kind, anyChunk.data);
    }
  }

  private recordRaw(key: string, kind: SessionEventKind, data: unknown): void {
    this.append(key, kind, data);
  }

  private append(key: string, kind: SessionEventKind, data: unknown): void {
    let ring = this.rings.get(key);
    if (!ring) {
      // Map 迭代序即插入序: LRU 触顶逐出最旧环 (跳过 pinned——attach 中的
      // 会话不逐出; 全部 pinned 触顶时按插入序兜底, R3 评审 M-6)
      while (this.rings.size >= MAX_SESSIONS) {
        this.evictOneRing();
      }
      ring = { events: [], lastActivity: Date.now() };
      this.rings.set(key, ring);
    }
    ring.lastActivity = Date.now();
    // LRU 置顶 (R1 评审 M3: append 需要 delete+set, 否则"逐出最旧"实际是
    // 逐出最早创建而非最久未更新)
    this.rings.delete(key);
    this.rings.set(key, ring);
    const event: SessionEvent = { seq: ++this.globalSeq, ts: Date.now(), kind, data };
    ring.events.push(event);
    if (ring.events.length > RING_CAPACITY) {
      ring.events.splice(0, ring.events.length - RING_CAPACITY);
    }
    for (const sink of this.sinks) {
      try {
        sink(key, event);
      } catch {}
    }
  }

  /** 补洞回放: lastSeq 之后的事件; 有洞 (被逐出) 时 truncated=true */
  public replaySince(sessionKey: string, lastSeq: number): ReplayResult {
    const ring = this.rings.get(sessionKey);
    if (!ring || ring.events.length === 0) {
      // 环不存在或为空 (ensureRing 建的挂机环, R3 评审 B3): events[0]! 会抛
      // TypeError——空环无历史可补, lastSeq>0 视为 truncated (客户端全量拉)
      return { epoch: this.epoch, events: [], truncated: lastSeq > 0 };
    }
    const oldest = ring.events[0]!.seq;
    const truncated = lastSeq > 0 && lastSeq + 1 < oldest;
    const events = ring.events.filter((e) => e.seq > lastSeq);
    return { epoch: this.epoch, events, truncated };
  }

  /**
   * 真实客户端 attach (R2 评审 N1: attach 即登记订阅——"TUI 在线"的准确定义
   * 是 attach 着, 而非环活跃; 空环无事件、重放为空, 无副作用)。
   * 登记订阅 + 建环 (R8 评审 B1: 与内部重建分离——fanout 重建不能虚增
   * 订阅计数, 否则客户端断开后留下幽灵订阅泄漏)。
   */
  public ensureRing(sessionKey: string): void {
    this.attachedKeys.set(sessionKey, (this.attachedKeys.get(sessionKey) ?? 0) + 1);
    if (this.rings.has(sessionKey)) {
      // 已有环置顶 (LRU 语义)
      const ring = this.rings.get(sessionKey)!;
      this.rings.delete(sessionKey);
      this.rings.set(sessionKey, ring);
      return;
    }
    while (this.rings.size >= MAX_SESSIONS) {
      this.evictOneRing();
    }
    this.rings.set(sessionKey, { events: [], lastActivity: Date.now() });
  }

  /** 客户端断开: attach 引用计数递减 (归零才失去逐出保护) */
  public unpinRing(sessionKey: string): void {
    const count = (this.attachedKeys.get(sessionKey) ?? 0) - 1;
    if (count <= 0) this.attachedKeys.delete(sessionKey);
    else this.attachedKeys.set(sessionKey, count);
  }

  /**
   * 逐出一个环腾位 (append/ensureRing 共用, R5 评审 C-M-2): 优先逐出
   * **无 attach 的环**; 全部 attached 时强逐最旧 (插入序头)——缓存有界优先,
   * 订阅状态在 attachedKeys 中不随逐出丢失 (R7 评审 B1), 逐出后该会话的
   * platform 事件经 ensureRing 重建环照常投递 (历史 delta 回放有损, 取舍
   * 记 CLAUDE.md backlog)。seq 为进程级单调——逐出无需任何记忆。
   */
  private evictOneRing(): void {
    let victim: string | undefined;
    for (const k of this.rings.keys()) {
      if (!this.attachedKeys.has(k)) {
        victim = k;
        break;
      }
    }
    if (!victim) {
      victim = this.rings.keys().next().value;
    }
    if (victim === undefined) return;
    this.rings.delete(victim);
  }

  /** 全量拉 (truncated 后客户端重建视图) */
  public replayAll(sessionKey: string): ReplayResult {
    const ring = this.rings.get(sessionKey);
    return { epoch: this.epoch, events: ring ? [...ring.events] : [], truncated: false };
  }

  /** 测试/诊断: 直接注入事件 */
  public emitForTest(key: string, kind: SessionEventKind, data: unknown): void {
    this.recordRaw(key, kind, data);
  }
}
