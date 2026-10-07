import type { WebSocket } from "ws";
import { WebSocketServer } from "ws";
import type { IncomingMessage, Server } from "node:http";
import { tokensEqual } from "../core/gateway-token.ts";
import { DatabaseStore } from "../config/database-store.ts";
import { isTrustedHostname } from "../utils/trusted-hosts.ts";
import { AgentManager } from "../core/agent-manager.ts";
import { EventBus } from "../core/event-bus.ts";
import { tryCommand } from "../core/chat-orchestrator.ts";
import { commandRouter } from "../core/commands.ts";
import { SessionHub, type SessionEvent } from "./session-hub.ts";
import { logger } from "../utils/logger.ts";

/**
 * WS 第二传输 (四期 M2, 设计 §4.1/§4.2): ws://…/api/gateway/ws?token=…
 * WS 不是第二套 API, 而是同一 dispatch 的第二传输——TUI 与 Web 看到同一套
 * 命令/事件面。协议 (每帧一 JSON):
 * - client→server 请求: {id, method, params} → 响应 {id, result|error}
 * - server→client 事件: {method:"event", params:{sessionId, epoch, seq, kind, data}}
 * 断开语义 = detach 而非销毁: 客户端断开不影响生成 (显式 session.cancel 才中止)。
 */

/** busy (生成中) 时 prompt.submit 的三模式 (设计 §4.2) */
type BusyMode = "queue" | "interrupt";

interface WsParams {
  agentId?: string;
  sessionId?: string;
  message?: string;
  input?: string;
  lastSeq?: number;
  mode?: BusyMode;
}

/** 服务端排队 (设计 §4.2: 会话锁天然串行, 队列只是触发时机: turn 结束事件
 *  驱动下一条出队)。队列本体在 lifecycle.ts (drain 清空需要访问, 避免环导)。
 *  R1 评审 B7/B9: 内存队列在 drain/崩溃时丢失——drain 时显式清空并经事件流
 *  告知客户端 (持久化队列记设计 §8-3 离线队列 backlog); cancel/reset 联动
 *  清队列 (R1 评审 M2)。 */
import { doCancel, doReset, isDraining, sessionQueues } from "./lifecycle.ts";

let queueDriverInstalled = false;

function installQueueDriver(store: DatabaseStore): void {
  if (queueDriverInstalled) return;
  queueDriverInstalled = true;
  // 启动恢复 (R2 评审 B6): 上次进程残留的持久化排队消息 (出队失败/崩溃
  // 遗留) 重新装入内存队列, 受理承诺跨进程成立
  try {
    const leftovers = store.listQueuedPrompts();
    const manager = AgentManager.getInstance();
    for (const row of leftovers) {
      const key = `${row.agentId}:${row.sessionId}`;
      const queue = sessionQueues.get(key) ?? [];
      queue.push({ dbId: row.id, agentId: row.agentId, sessionId: row.sessionId, message: row.message });
      sessionQueues.set(key, queue);
    }
    if (leftovers.length > 0) {
      logger.info("WsGateway", `Recovered ${leftovers.length} queued prompt(s) from previous run`);
    }
    // 自驱动 (R3 评审 B5/R4 评审 B2): 统一走 dispatchQueueFor——其内含
    // durable busy 判定, 不会与 harness 恢复任务并发
    for (const key of [...sessionQueues.keys()]) {
      void dispatchQueueFor(key);
    }
  } catch (err) {
    logger.warn("WsGateway", `Queued prompt recovery failed: ${err}`);
  }
  EventBus.getInstance().subscribe((e) => {
    if (e.type !== "chat.turn" || e.phase === "start") return;
    void dispatchQueueFor(`${e.agentId}:${e.sessionId}`);
  });
  // 周期轮询自驱动兜底 (R4 评审 B2/R3-B5): durable 恢复任务不发布 chat.turn,
  // 纯事件驱动会漏投——5s 轮询扫描全部队列, 对可用会话出队。inspect 结果
  // 每轮共享一次 (R8 simplify F1: harness.inspect 含两次 sqlite 扫描, N 个
  // 队列各自求值是纯浪费)
  setInterval(() => {
    if (isDraining()) return;
    void (async () => {
      let durable: number;
      try {
        durable = await AgentManager.getInstance().durableBusyCount();
      } catch {
        return; // fail-closed: 状态未知不投递, 等下轮
      }
      for (const key of [...sessionQueues.keys()]) {
        await dispatchQueueFor(key, durable);
      }
    })();
  }, 5_000).unref();
}

/** 出队一个会话的队头 (可用性判定: drain/busy/durable 恢复任务)。
 *  durable 可由调用方传入共享值 (轮询路径一次 inspect 服务全部队列); */
async function dispatchQueueFor(key: string, sharedDurable?: number): Promise<void> {
  if (isDraining()) return;
  const manager = AgentManager.getInstance();
  const head = sessionQueues.get(key)?.[0];
  if (!head) return;
  if (manager.isBusy(head.agentId, head.sessionId)) return;
  let durable: number;
  if (sharedDurable !== undefined) {
    durable = sharedDurable;
  } else {
    try {
      // durable 恢复任务全局闸 (R4 评审 B2): resume 的任务不在 busyTurns,
      // 计数 > 0 时不投递; inspect 失败时抛错
      durable = await manager.durableBusyCount();
    } catch {
      return; // fail-closed (R5 评审 B1): 状态未知不投递, 等下轮
    }
  }
  // await 后全量重校验 (R5 评审 B1: drain 可能在 inspect 期间清空队列/
  // 置位——沿用闭包里旧数组会绕过 drain 的清空与审计)
  if (isDraining()) return;
  const fresh = sessionQueues.get(key);
  if (!fresh || fresh[0] !== head) return;
  if ((manager.isBusy(head.agentId, head.sessionId)) || durable > 0) return;
  fresh.shift();
  if (fresh.length === 0) sessionQueues.delete(key);
  logger.debug("WsGateway", `Queued prompt dispatched for ${key} (${fresh.length} remaining)`);
  void manager
    .chat(head.agentId, head.sessionId, head.message)
    .then(() => {
      // 投递成功删持久化行 (失败保留, 重启后恢复重投)
      if (head.dbId) queueStore?.deleteQueuedPrompt(head.dbId);
    })
    .catch((err) => logger.warn("WsGateway", `Queued prompt failed: ${err}`));
}



export function attachWsGateway(server: Server, authToken: string | null): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
  queueStore = new DatabaseStore();
  installQueueDriver(queueStore);
  const hub = SessionHub.getInstance();
  hub.start();

  server.on("upgrade", (req: IncomingMessage, socket: any, head: Buffer) => {
    let url: URL;
    try {
      url = new URL(req.url || "/", "http://localhost");
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== "/api/gateway/ws") {
      socket.destroy();
      return;
    }
    // Origin 校验 (R2 评审 M-12, 与 HTTP 侧防线一致): 浏览器客户端的 Origin
    // 必须来自信任主机; 非浏览器客户端 (TUI) 不带 Origin, 放行
    const origin = req.headers.origin;
    if (origin) {
      try {
        const { hostname } = new URL(origin);
        if (!isTrustedHostname(hostname)) {
          socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
          socket.destroy();
          return;
        }
      } catch {
        socket.destroy();
        return;
      }
    }
    // 鉴权: gateway-token (文件 0600, TUI 同用户可读; 文件系统 ACL 即边界);
    // 常量时间比较 (R1 评审 M1/M2, 与 HTTP 侧一致)
    const provided = url.searchParams.get("token") ?? "";
    if (authToken && !(typeof provided === "string" && tokensEqual(provided, authToken))) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (client) => {
      void handleClient(client, hub);
    });
  });

  return wss;
}

/** 排队消息持久化 (attachWsGateway 时创建; handleClient 共享) */
let queueStore: DatabaseStore | undefined;

function send(client: WebSocket, payload: unknown): void {
  if (client.readyState === 1) {
    client.send(JSON.stringify(payload));
  }
}

async function handleClient(client: WebSocket, hub: SessionHub): Promise<void> {
  /** 该客户端 attach 的会话键集合 (事件按需转发) */
  const attached = new Set<string>();
  /** 已转发给该客户端的最大 seq (新事件只推增量) */
  const watermarks = new Map<string, number>();

  const unsubscribe = hub.onEvent((key, event) => {
    if (!attached.has(key)) return;
    const seen = watermarks.get(key) ?? 0;
    if (event.seq <= seen) return;
    watermarks.set(key, event.seq);
    send(client, {
      method: "event",
      params: { sessionId: key, epoch: hub.epoch, seq: event.seq, kind: event.kind, data: event.data, ts: event.ts },
    });
  });

  client.on("close", () => {
    unsubscribe();
    // detach 而非销毁 (设计 §4.1): 不 abort 生成, 不清会话;
    // 解除 pinned (先复制——clear 之后拿不到 keys)
    for (const key of [...attached]) hub.unpinRing(key);
    attached.clear();
    watermarks.clear();
  });
  client.on("error", () => {
    try {
      client.terminate();
    } catch {}
  });

  client.on("message", (raw: Buffer) => {
    // 单帧上限由 WebSocketServer maxPayload 在协议层拒绝 (超限触发 error
    // → terminate; R8 simplify: 删除 message 后才检查的双保险)
    void (async () => {
      let req: { id?: string | number; method?: string; params?: WsParams };
      try {
        req = JSON.parse(raw.toString("utf8"));
      } catch {
        send(client, { id: null, error: "invalid json" });
        return;
      }
      const id = req.id ?? null;
      const p = req.params ?? {};
      try {
        switch (req.method) {
          case "session.attach": {
            if (!p.agentId || !p.sessionId) throw new Error("agentId and sessionId are required");
            const key = `${p.agentId}:${p.sessionId}`;
            // attach 幂等 (R5 评审 M1: 重复 attach 只计一次——否则 pinCount
            // 虚增, close 时减不回去, 环永久免 LRU)
            if (!attached.has(key)) {
              attached.add(key);
              // 建环 (R2 评审 N1): attach 即视为"在线"——静默挂机的会话也
              // 要进 platform 事件的 fanout 面; 空环无事件无副作用
              hub.ensureRing(key);
            }
            const replay = hub.replayAll(key);
            for (const e of replay.events) watermarks.set(key, e.seq);
            send(client, { id, result: { sessionId: key, epoch: replay.epoch, events: replay.events, truncated: replay.truncated } });
            break;
          }
          case "session.events.since": {
            if (!p.agentId || !p.sessionId) throw new Error("agentId and sessionId are required");
            const key = `${p.agentId}:${p.sessionId}`;
            // 重建 attach 状态 (R3 评审 N1——关键修复): attached 随旧连接销毁,
            // 重连的 resync 走 since 分支, 若不重新 add 则此后全部实时事件
            // 被 sink 的 attached.has(key) 过滤掉 → 永久断流
            if (!attached.has(key)) {
              attached.add(key);
              hub.ensureRing(key);
            }
            const replay = hub.replaySince(key, p.lastSeq ?? 0);
            if (replay.truncated) {
              // 绝不信任有洞的 replay (设计 §4.2): 客户端应全量重建
              const full = hub.replayAll(key);
              for (const e of full.events) watermarks.set(key, e.seq);
              send(client, { id, result: { sessionId: key, epoch: full.epoch, events: full.events, truncated: true } });
              break;
            }
            for (const e of replay.events) watermarks.set(key, e.seq);
            send(client, { id, result: { sessionId: key, epoch: replay.epoch, events: replay.events, truncated: false } });
            break;
          }
          case "prompt.submit": {
            if (!p.agentId || !p.sessionId || !p.message) throw new Error("agentId, sessionId, and message are required");
            const key = `${p.agentId}:${p.sessionId}`;
            // drain 期间拒绝新任务 (R1 评审 B6/M6: 与 IM/Web 同一闸口)
            if (isDraining()) {
              throw new Error("gateway 正在重启 (draining), 暂不接受新消息; 请稍后重发");
            }
            const manager = AgentManager.getInstance();
            // 统一命令层 (R1 评审 B8): prompt 入口先过 tryCommand, 用返回的
            // handled 分流 (R8 simplify: 不再预先 parse 第二遍)——命令获得
            // 统一 busy 语义并回显结果; 非命令输入落回 busy queue/interrupt
            const outcome = await tryCommand({
              channel: "tui",
              channelInstanceId: "tui",
              peerId: p.sessionId,
              agentId: p.agentId,
              sessionId: p.sessionId,
              input: p.message,
            });
            if (outcome.handled) {
              const result = outcome.result;
              if (result?.content) {
                // 复用 SessionHub 通道回显命令输出 (客户端按 kind 渲染)
                send(client, {
                  method: "event",
                  params: {
                    sessionId: key,
                    epoch: hub.epoch,
                    seq: 0,
                    ts: Date.now(),
                    kind: "platform",
                    data: { commandEcho: p.message, text: result.content, ok: result.ok },
                  },
                });
              }
              send(client, { id, result: { accepted: "command", ok: result?.ok ?? false, data: result?.data } });
              break;
            }
            if (manager.isBusy(p.agentId, p.sessionId)) {
              const mode: BusyMode = p.mode === "interrupt" ? "interrupt" : "queue";
              if (mode === "interrupt") {
                await manager.abortSession(p.agentId, p.sessionId);
                void manager
                  .chat(p.agentId, p.sessionId, p.message)
                  .catch((err) => logger.warn("WsGateway", `Interrupt-submit failed: ${err}`));
                send(client, { id, result: { accepted: "interrupt" } });
              } else {
                // push 前二次校验 (R2 评审 B4: 检查与 push 之间有 await,
                // drain 可能在期间置位——入队的消息会随 drain 清空)
                if (isDraining()) throw new Error("gateway 正在重启 (draining), 暂不接受新消息; 请稍后重发");
                const queue = sessionQueues.get(key) ?? [];
                if (queue.length >= 16) throw new Error("queue full (16); wait for the current turn to finish");
                // 受理即落库 (R2 评审 B6): 持久化行随队列条目, 出队成功/清空删除
                const dbId = queueStore!.enqueueQueuedPrompt(p.agentId!, p.sessionId!, p.message);
                queue.push({ dbId, agentId: p.agentId!, sessionId: p.sessionId!, message: p.message });
                sessionQueues.set(key, queue);
                send(client, { id, result: { accepted: "queued", position: queue.length } });
              }
            } else {
              // 与 queue 分支同款二次校验 (R3 评审 C-M-4: await import 的
              // 微任务窗口内 drain 可能置位)
              if (isDraining()) throw new Error("gateway 正在重启 (draining), 暂不接受新消息; 请稍后重发");
              void manager
                .chat(p.agentId, p.sessionId, p.message)
                .catch((err) => logger.warn("WsGateway", `Prompt failed: ${err}`));
              send(client, { id, result: { accepted: "immediate" } });
            }
            break;
          }
          case "command.exec": {
            if (!p.agentId || !p.sessionId || !p.input) throw new Error("agentId, sessionId, and input are required");
            // drain 期间拒绝 (统一闸口)
            if (isDraining()) {
              throw new Error("gateway 正在重启 (draining), 暂不接受新命令; 请稍后重试");
            }
            const outcome = await tryCommand({
              channel: "tui",
              channelInstanceId: "tui",
              peerId: p.sessionId,
              agentId: p.agentId,
              sessionId: p.sessionId,
              input: p.input,
            });
            send(client, {
              id,
              result: {
                handled: outcome.handled,
                ok: outcome.result?.ok ?? false,
                content: outcome.result?.content,
                data: outcome.result?.data,
              },
            });
            break;
          }
          case "session.cancel": {
            if (!p.agentId || !p.sessionId) throw new Error("agentId and sessionId are required");
            // drain 闸 (R2 评审 B4: cancel 会截断在飞 turn, 与 drain 承诺矛盾);
            // 统一语义单元 (清队列 → abort, R8 simplify 收敛)
            if (isDraining()) throw new Error("gateway 正在重启 (draining), 暂不接受取消请求");
            const aborted = await doCancel(p.agentId, p.sessionId);
            send(client, { id, result: { aborted } });
            break;
          }
          case "session.reset": {
            if (!p.agentId || !p.sessionId) throw new Error("agentId and sessionId are required");
            // drain 闸 (R2 评审 B4: reset 的 interrupt 会截断在飞 turn);
            // 统一语义单元 (清队列 → abort → reset, R8 simplify 收敛)
            if (isDraining()) throw new Error("gateway 正在重启 (draining), 暂不接受重置请求");
            await doReset(p.agentId, p.sessionId);
            send(client, { id, result: { reset: true } });
            break;
          }
          case "session.status": {
            if (!p.agentId || !p.sessionId) throw new Error("agentId and sessionId are required");
            const manager = AgentManager.getInstance();
            send(client, {
              id,
              result: {
                busy: manager.isBusy(p.agentId, p.sessionId),
                queued: sessionQueues.get(`${p.agentId}:${p.sessionId}`)?.length ?? 0,
              },
            });
            break;
          }
          case "commands.list": {
            // 命令注册表快照 (TUI 补全 ghost text 数据源; 只列 tui 可见项)
            send(client, {
              id,
              result: commandRouter.listVisible("tui").map((d) => ({
                name: d.name,
                aliases: d.aliases ?? [],
                description: d.description,
                argsHint: d.argsHint,
              })),
            });
            break;
          }
          default:
            send(client, { id, error: `unknown method: ${String(req.method)}` });
        }
      } catch (err) {
        send(client, { id, error: err instanceof Error ? err.message : String(err) });
      }
    })().catch((err) => logger.warn("WsGateway", "WS message handling failed:", err));
  });
}

export type { SessionEvent };
