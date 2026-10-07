import { loadOrCreateGatewayToken } from "../core/gateway-token.ts";

/**
 * TUI 的 gateway 客户端 (四期 M2, 设计 §4.1/§4.3):
 * WS = 同一 dispatch 的第二传输; 断线自动重连, 重连后 session.events.since
 * 补洞 (truncated → 全量重建)。Bun 原生 WebSocket 作客户端。
 */

export interface TuiEvent {
  sessionId: string;
  epoch: string;
  seq: number;
  kind: "turn_start" | "delta" | "tool" | "usage" | "turn_end" | "platform";
  data: any;
  ts: number;
}

export interface TurnUsageInfo {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  contextTokens: number;
  contextWindow: number;
  cacheHitRate?: number;
  costTotal: number;
  durationMs: number;
  reasoning?: number;
}

export interface GatewayClientOptions {
  host: string;
  port: number;
  token: string;
  agentId: string;
  sessionId: string;
}

export class GatewayClient {
  private ws?: WebSocket;
  private rpcId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private lastSeq = 0;
  private epoch?: string;
  private retry = 0;
  private closed = false;

  public agentId: string;
  public sessionId: string;

  constructor(private opts: GatewayClientOptions) {
    this.agentId = opts.agentId;
    this.sessionId = opts.sessionId;
  }

  public onEvent?: (e: TuiEvent) => void;
  public onStatus?: (status: "connecting" | "online" | "offline" | "reset") => void;
  public onTurnEnd?: () => void;

  public get connected(): boolean {
    return this.ws?.readyState === 1;
  }

  public connect(): void {
    if (this.closed) return;
    this.onStatus?.("connecting");
    const url = `ws://${this.opts.host}:${this.opts.port}/api/gateway/ws?token=${encodeURIComponent(this.opts.token)}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.retry = 0;
      this.onStatus?.("online");
      void this.resync();
    };
    ws.onmessage = (msg) => {
      let frame: any;
      try {
        frame = JSON.parse(String(msg.data));
      } catch {
        return;
      }
      if (frame.method === "event" && frame.params) {
        const e = frame.params as TuiEvent;
        // 乱序/重复丢弃 (seq 单调); seq=0 的事件帧 (命令回显) 恒放行
        if (e.seq > 0 && e.seq <= this.lastSeq) return;
        if (e.seq > 0) this.lastSeq = e.seq;
        if (e.kind === "turn_end") this.onTurnEnd?.();
        this.onEvent?.(e);
        return;
      }
      if (frame.id !== undefined && frame.id !== null) {
        const pending = this.pending.get(frame.id);
        if (pending) {
          this.pending.delete(frame.id);
          if (frame.error) pending.reject(new Error(frame.error));
          else pending.resolve(frame.result);
        }
      }
    };
    ws.onclose = () => {
      this.ws = undefined;
      if (this.closed) return;
      this.onStatus?.("offline");
      // 指数退避重连 (0.5s → 8s 封顶)
      const delay = Math.min(8000, 500 * 2 ** this.retry++);
      setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => {};
  }

  public close(): void {
    this.closed = true;
    try {
      this.ws?.close();
    } catch {}
  }

  /**
   * 连接建立后的会话重同步 (R1 评审 B8/B12: 此前恒 attach=replayAll 且
   * 追加渲染——断线重连必然重复 transcript, 断线事件超环容量时静默缺块):
   * - 首次连接: attach 全量;
   * - epoch 未变 (同一 gateway): events.since(lastSeq) 补洞, truncated=true
   *   时清屏全量重建 ("绝不信任有洞的 replay");
   * - epoch 变化 (gateway 重启): 清屏 + attach 全量。
   */
  private async resync(): Promise<void> {
    try {
      if (this.epoch === undefined) {
        const result = await this.rpc("session.attach", { agentId: this.agentId, sessionId: this.sessionId });
        this.epoch = result.epoch;
        for (const e of result.events as TuiEvent[]) {
          if (e.seq > this.lastSeq) {
            this.lastSeq = e.seq;
            this.onEvent?.(e);
          }
        }
        return;
      }
      const result = await this.rpc(
        "session.events.since",
        { agentId: this.agentId, sessionId: this.sessionId, lastSeq: this.lastSeq },
      );
      if (result.epoch !== this.epoch || result.truncated) {
        // 有洞 (断线期间事件超出重放环) 或 gateway 重启: 清屏全量重建
        this.lastSeq = 0;
        this.epoch = result.epoch;
        this.onStatus?.("reset");
        for (const e of result.events as TuiEvent[]) {
          this.lastSeq = Math.max(this.lastSeq, e.seq);
          this.onEvent?.(e);
        }
        return;
      }
      for (const e of result.events as TuiEvent[]) {
        if (e.seq > this.lastSeq) {
          this.lastSeq = e.seq;
          if (e.kind === "turn_end") this.onTurnEnd?.();
          this.onEvent?.(e);
        }
      }
    } catch {
      // 重同步失败不致命: 事件流继续, 下次重连再补
    }
  }

  /** /agent <id> 视图切换 (R1 评审 B10): 清屏重建 (R2 评审 B7——不触发
   *  reset 会让旧 agent transcript 与新 agent 事件混排), 再重同步 */
  public switchAgent(agentId: string): void {
    this.agentId = agentId;
    this.lastSeq = 0;
    this.epoch = undefined;
    this.onStatus?.("reset");
    if (this.connected) {
      void this.resync();
    }
  }

  public rpc(method: string, params: Record<string, unknown>, timeoutMs = 30_000): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.connected) {
        reject(new Error("gateway 未连接"));
        return;
      }
      const id = ++this.rpcId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC 超时: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ws!.send(JSON.stringify({ id, method, params }));
    });
  }

  public submit(message: string, mode?: "queue" | "interrupt"): Promise<{ accepted: string }> {
    return this.rpc("prompt.submit", {
      agentId: this.agentId,
      sessionId: this.sessionId,
      message,
      mode,
    });
  }

  public execCommand(input: string): Promise<{ handled: boolean; ok: boolean; content?: string; data?: unknown }> {
    // 命令可能重活 (/compact 大会话), 超时放宽且文案注明仍在执行 (R1 评审 M6)
    return this.rpc(
      "command.exec",
      { agentId: this.agentId, sessionId: this.sessionId, input },
      120_000,
    );
  }

  public cancel(): Promise<{ aborted: boolean }> {
    return this.rpc("session.cancel", { agentId: this.agentId, sessionId: this.sessionId });
  }

}

/** TUI 会话键: 复用终端主渠道语义 (terminal-main:local-user), 与既有会话历史连续 */
export const TUI_SESSION = "terminal-main:local-user";

/** 解析 TUI 的 agentId: terminal-main 渠道绑定 (与旧 REPL 同一绑定真相) */
export async function resolveTuiAgent(webPort: number, token: string): Promise<string> {
  try {
    const res = await fetch(`http://127.0.0.1:${webPort}/api/channels`, {
      headers: { "x-bot-token": token },
    });
    const channels = (await res.json()) as any[];
    const bound = channels.find((c) => c.id === "terminal-main")?.boundAgentId;
    if (bound) return bound;
  } catch {}
  return "agent-default";
}

export function makeTuiClient(webPort: number, cwd: string, agentId: string): GatewayClient {
  return new GatewayClient({
    host: "127.0.0.1",
    port: webPort,
    token: loadOrCreateGatewayToken(cwd),
    agentId,
    sessionId: TUI_SESSION,
  });
}
