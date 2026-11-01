import type {
  SpanAttributes,
  SpanOptions,
  SpanStatus,
  TelemetryCarrier,
  TelemetryContext,
  TelemetryPropagation,
  TelemetrySpan,
} from "@earendil-works/pi-telemetry";
import { DatabaseStore, type LlmRequestRecord, type ToolInvocationRecord } from "../config/database-store.ts";
import { logger } from "../utils/logger.ts";

interface SpanIdentity {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  conversationId?: string;
  turnId?: string;
  compactionId?: string;
  taskName?: string;
  taskId?: string;
}

type BufferedRecord =
  | { kind: "request"; row: LlmRequestRecord }
  | { kind: "tool"; row: ToolInvocationRecord };

const MAX_BUFFER = 5_000;
const MAX_ROWS_PER_TURN = 500;
const FLUSH_INTERVAL_MS = 2_000;

function attrString(attributes: SpanAttributes, key: string): string | undefined {
  const value = attributes[key];
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function attrNumber(attributes: SpanAttributes, key: string): number | undefined {
  const value = attributes[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function encodeCarrier(identity: SpanIdentity | undefined): TelemetryCarrier | undefined {
  if (!identity) return undefined;
  return {
    "bot.span": Buffer.from(
      JSON.stringify({
        t: identity.traceId,
        s: identity.spanId,
        c: identity.conversationId,
        u: identity.turnId,
        k: identity.compactionId,
        n: identity.taskName,
        i: identity.taskId,
      }),
      "utf8",
    ).toString("base64"),
  };
}

function decodeCarrier(carrier: TelemetryCarrier | undefined): Partial<SpanIdentity> | undefined {
  const raw = carrier?.["bot.span"];
  if (typeof raw !== "string") return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as Record<string, unknown>;
    if (typeof parsed.t !== "string" || typeof parsed.s !== "string") return undefined;
    return {
      traceId: parsed.t,
      spanId: parsed.s,
      conversationId: typeof parsed.c === "string" ? parsed.c : undefined,
      turnId: typeof parsed.u === "string" ? parsed.u : undefined,
      compactionId: typeof parsed.k === "string" ? parsed.k : undefined,
      taskName: typeof parsed.n === "string" ? parsed.n : undefined,
      taskId: typeof parsed.i === "string" ? parsed.i : undefined,
    };
  } catch {
    return undefined;
  }
}

/**
 * 七期：内容无关的进程内 telemetry 适配器。
 * - span 结束只入内存环形缓冲，不写 SQLite；flush 时批量落 llm_requests/tool_invocations。
 * - propagation carrier 带 conversation/turn/compaction，scheduler 恢复/异步任务也能归因。
 * - 只记录 pi.ai.request/poll、带 tool.name 的 pi.durable.phase；submit 仅做内存映射。
 */
export class ContextTelemetry implements TelemetryContext, TelemetryPropagation {
  readonly propagation: TelemetryPropagation = this;
  readonly metrics = undefined;
  private readonly identities = new WeakMap<object, SpanIdentity>();
  private readonly activeTurns = new Map<string, string>();
  private readonly activeCompactions = new Map<string, string>();
  private readonly submissionTrace = new Map<string, string>();
  private readonly turnTrace = new Map<string, string>();
  private readonly compactionTrace = new Map<string, string>();
  private readonly buffer: BufferedRecord[] = [];
  private readonly perTurnRows = new Map<string, number>();
  private readonly truncatedTurns = new Set<string>();
  private dropped = 0;
  private sequence = 0;
  private readonly scope = crypto.randomUUID();
  private timer?: ReturnType<typeof setInterval>;
  private flushChain: Promise<void> = Promise.resolve();
  private closed = false;

  constructor() {
    this.timer = setInterval(() => {
      void this.flush().catch(() => {});
    }, FLUSH_INTERVAL_MS);
    this.timer.unref?.();
  }

  beginTurn(conversationId: string, turnId: string): void {
    this.activeTurns.set(conversationId, turnId);
  }

  endTurn(conversationId: string, turnId?: string): void {
    if (turnId === undefined || this.activeTurns.get(conversationId) === turnId) {
      this.activeTurns.delete(conversationId);
    }
    if (turnId) {
      this.perTurnRows.delete(turnId);
      this.truncatedTurns.delete(turnId);
    }
  }

  beginCompaction(conversationId: string, compactionId: string): void {
    this.activeCompactions.set(conversationId, compactionId);
  }

  endCompaction(conversationId: string, compactionId?: string): void {
    if (compactionId === undefined || this.activeCompactions.get(conversationId) === compactionId) {
      this.activeCompactions.delete(conversationId);
    }
  }

  traceForSubmission(submissionId: string): string | undefined {
    return this.submissionTrace.get(submissionId);
  }

  traceForTurn(turnId: string): string | undefined {
    return this.turnTrace.get(turnId);
  }

  traceForCompaction(compactionId: string): string | undefined {
    return this.compactionTrace.get(compactionId);
  }

  wasTruncated(turnId: string): boolean {
    return this.truncatedTurns.has(turnId);
  }

  startSpan<T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
    return this.start(undefined, options, callback);
  }

  inject(context: TelemetryContext): TelemetryCarrier | undefined {
    return encodeCarrier(this.identities.get(context as object));
  }

  extract(carrier: TelemetryCarrier | undefined): TelemetryContext {
    const decoded = decodeCarrier(carrier);
    if (!decoded?.traceId || !decoded.spanId) return this;
    const remote = new RemoteSpanContext(this, {
      traceId: decoded.traceId,
      spanId: decoded.spanId,
      conversationId: decoded.conversationId,
      turnId: decoded.turnId,
      compactionId: decoded.compactionId,
      taskName: decoded.taskName,
      taskId: decoded.taskId,
    });
    this.identities.set(remote, {
      traceId: decoded.traceId,
      spanId: decoded.spanId,
      conversationId: decoded.conversationId,
      turnId: decoded.turnId,
      compactionId: decoded.compactionId,
      taskName: decoded.taskName,
      taskId: decoded.taskId,
    });
    return remote;
  }

  async start<T>(
    parent: SpanIdentity | undefined,
    options: SpanOptions,
    callback: (span: TelemetrySpan) => T | Promise<T>,
  ): Promise<T> {
    const attributes: SpanAttributes = { ...(options.attributes ?? {}) };
    const conversationId = parent?.conversationId ?? attrString(attributes, "conversation.id");
    const taskName = attrString(attributes, "task.name") ?? parent?.taskName;
    const taskId = attrString(attributes, "task.id") ?? parent?.taskId;
    const spanId = `${this.scope}:${++this.sequence}`;
    const identity: SpanIdentity = {
      traceId: parent?.traceId ?? spanId,
      spanId,
      parentSpanId: parent?.spanId,
      conversationId,
      turnId: parent?.turnId ?? (conversationId ? this.activeTurns.get(conversationId) : undefined),
      compactionId: parent?.compactionId ?? (conversationId ? this.activeCompactions.get(conversationId) : undefined),
      taskName,
      taskId,
    };
    const span = new LocalSpanContext(this, identity, attributes, options.name);
    this.identities.set(span, identity);
    if (options.name === "bot.compaction") {
      const compactionId = attrString(attributes, "bot.compaction.id");
      if (compactionId) this.remember(this.compactionTrace, compactionId, identity.traceId);
    }
    const startedMs = Date.now();
    let outcome: T | undefined;
    let failure: unknown;
    let failed = false;
    try {
      outcome = await callback(span);
      return outcome;
    } catch (err) {
      failed = true;
      failure = err;
      throw err;
    } finally {
      if (!this.closed) {
        this.finishSpan(span, identity, options.name, startedMs, failed, failure);
      }
    }
  }

  private finishSpan(
    span: LocalSpanContext,
    identity: SpanIdentity,
    name: string,
    startedMs: number,
    failed: boolean,
    failure: unknown,
  ): void {
    const endedMs = Date.now();
    const status: SpanStatus = failed
      ? { status: "error", error: { name: "error", message: String(failure).slice(0, 500) } }
      : span.status;
    const attributes = span.attributes;

    if (name === "pi.durable.submit") {
      const submissionId = attrString(attributes, "submission.id");
      if (submissionId) {
        this.remember(this.submissionTrace, submissionId, identity.traceId);
        if (identity.turnId) this.remember(this.turnTrace, identity.turnId, identity.traceId);
      }
      return;
    }

    if (name === "pi.ai.request" || name === "pi.ai.poll") {
      const event = span.events.find((e) => e.name === "pi.ai.first_chunk");
      const row: LlmRequestRecord = {
        spanId: identity.spanId,
        turnId: identity.turnId,
        conversationId: identity.conversationId,
        traceId: identity.traceId,
        parentSpanId: identity.parentSpanId,
        taskId: identity.taskId,
        kind: name === "pi.ai.poll" ? "poll" : "request",
        taskKind: taskKind(identity.taskName),
        compactionId: identity.compactionId,
        provider: attrString(attributes, "provider"),
        modelId: attrString(attributes, "model"),
        api: attrString(attributes, "api"),
        startedAt: startedMs,
        endedAt: endedMs,
        durationMs: Math.max(0, endedMs - startedMs),
        firstChunkMs: event ? Math.max(0, Math.round(event.timeMs)) : undefined,
        inputTokens: attrNumber(attributes, "usage.input") ?? 0,
        outputTokens: attrNumber(attributes, "usage.output") ?? 0,
        cacheRead: attrNumber(attributes, "usage.cache_read") ?? 0,
        cacheWrite: attrNumber(attributes, "usage.cache_write") ?? 0,
        reasoningTokens: 0,
        costUsd: attrNumber(attributes, "cost.total") ?? 0,
        stopReason: attrString(attributes, "stop"),
        status:
          attrString(attributes, "stop") === "aborted"
            ? "aborted"
            : status.status === "error"
              ? "error"
              : "ok",
        error: status.status === "error" ? status.error?.message?.slice(0, 500) : undefined,
      };
      this.push({ kind: "request", row });
      return;
    }

    if (name === "pi.durable.phase" && attrString(attributes, "tool.name")) {
      const toolCallId = attrString(attributes, "tool.call_id");
      const outcome = attrString(attributes, "outcome") ?? "";
      const row: ToolInvocationRecord = {
        turnId: identity.turnId,
        conversationId: identity.conversationId,
        traceId: identity.traceId,
        taskId: attrString(attributes, "task.id"),
        toolCallId,
        toolName: attrString(attributes, "tool.name")!,
        startedAt: startedMs,
        endedAt: endedMs,
        durationMs: Math.max(0, endedMs - startedMs),
        status:
          status.status === "error" || /fault|fail/.test(outcome)
            ? "error"
            : outcome === "aborted"
              ? "aborted"
              : "ok",
        error: status.status === "error" ? status.error?.message?.slice(0, 500) : undefined,
      };
      this.push({ kind: "tool", row });
    }
  }

  private remember(map: Map<string, string>, key: string, value: string): void {
    map.set(key, value);
    while (map.size > 1_000) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }

  private push(record: BufferedRecord): void {
    const turnId = record.row.turnId;
    if (turnId) {
      const count = this.perTurnRows.get(turnId) ?? 0;
      if (count >= MAX_ROWS_PER_TURN) {
        this.truncatedTurns.add(turnId);
        return;
      }
      this.perTurnRows.set(turnId, count + 1);
    }
    if (this.buffer.length >= MAX_BUFFER) {
      this.buffer.shift();
      this.dropped++;
    }
    this.buffer.push(record);
  }

  /** 批量落库；失败丢弃本批并保持会话不受影响。 */
  async flush(): Promise<void> {
    const run = this.flushChain.then(async () => {
      if (this.buffer.length === 0) return;
      const batch = this.buffer.splice(0, this.buffer.length);
      const requests = batch.filter((r): r is { kind: "request"; row: LlmRequestRecord } => r.kind === "request");
      const tools = batch.filter((r): r is { kind: "tool"; row: ToolInvocationRecord } => r.kind === "tool");
      try {
        const store = new DatabaseStore();
        if (requests.length > 0) store.insertLlmRequests(requests.map((r) => r.row));
        if (tools.length > 0) store.insertToolInvocations(tools.map((r) => r.row));
      } catch (err) {
        logger.warn("ContextTelemetry", `Failed to flush ${batch.length} span(s): ${err}`);
      }
    });
    this.flushChain = run.catch(() => {});
    await run;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.flush();
  }
}

function taskKind(taskName: string | undefined): LlmRequestRecord["taskKind"] {
  if (taskName === "pi.generation") return "generation";
  if (taskName === "pi.compaction") return "compaction";
  if (taskName === "pi.tool") return "tool";
  return undefined;
}

class LocalSpanContext implements TelemetrySpan {
  readonly metrics = undefined;
  readonly propagation: TelemetryPropagation;
  readonly attributes: SpanAttributes;
  readonly events: { name: string; timeMs: number; attributes: SpanAttributes }[] = [];
  status: SpanStatus = { status: "ok" };
  private readonly clock = performance.now();

  constructor(
    private readonly owner: ContextTelemetry,
    private readonly identity: SpanIdentity,
    initialAttributes: SpanAttributes,
    readonly name: string,
  ) {
    this.propagation = owner;
    this.attributes = { ...initialAttributes };
  }

  startSpan<T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
    return this.owner.start(this.identity, options, callback);
  }

  addLink(): void {
    /* content-free links not needed */
  }

  addEvent(name: string, attributes?: SpanAttributes): void {
    this.events.push({
      name,
      timeMs: performance.now() - this.clock,
      attributes: { ...(attributes ?? {}) },
    });
  }

  setAttributes(attributes: SpanAttributes): void {
    Object.assign(this.attributes, attributes);
  }

  setStatus(status: SpanStatus): void {
    this.status = status;
  }
}

class RemoteSpanContext implements TelemetrySpan {
  readonly metrics = undefined;
  readonly propagation: TelemetryPropagation;

  constructor(
    private readonly owner: ContextTelemetry,
    private readonly identity: SpanIdentity,
  ) {
    this.propagation = owner;
  }

  startSpan<T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
    return this.owner.start(this.identity, options, callback);
  }

  addLink(): void {}
  addEvent(): void {}
  setAttributes(): void {}
  setStatus(): void {}
}

let singleton: ContextTelemetry | undefined;

export function getContextTelemetry(): ContextTelemetry {
  if (!singleton) singleton = new ContextTelemetry();
  return singleton;
}

/** 测试用：替换/重置单例。 */
export function resetContextTelemetryForTests(instance?: ContextTelemetry): void {
  if (instance) {
    singleton = instance;
  } else {
    singleton = undefined;
  }
}
