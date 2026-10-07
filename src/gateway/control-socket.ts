import { createServer, connect, type Server, type Socket } from "node:net";
import { chmodSync, unlinkSync } from "node:fs";
import { AgentManager } from "../core/agent-manager.ts";
import { SchedulerManager } from "../scheduler/index.ts";
import { DatabaseStore } from "../config/database-store.ts";
import { BOT_VERSION } from "../version.ts";
import { logger } from "../utils/logger.ts";

/**
 * Gateway 控制 socket (四期 M1, 设计 §3.3):
 * <cwd>/.bot/gateway.sock (0600, unix domain), 换行分隔 JSON 协议。
 *
 * liveness 判据 (hermes 不变量 4): "可连接 + 合法 identify 应答 = 活着"——
 * 绝不用 PID 文件 / 端口探测 (PID 复用与端口误判都出过事故)。
 * 文件系统 ACL (0600 + 同用户) 即鉴权边界。
 */

export const GATEWAY_VERSION = BOT_VERSION;

export interface GatewayStatusPayload {
  version: string;
  cwd: string;
  pid: number;
  uptime: number;
  draining: boolean;
  activeTurns: number;
  scheduler: { started: boolean; inFlight: number };
  channels: { id: string; type: string; name: string }[];
  webPort: string;
}

interface ControlHandlers {
  identify(): { version: string; cwd: string; pid: number; uptime: number };
  status(): Promise<GatewayStatusPayload>;
  /**
   * drain-and-exit (R3 评审 B4): "restart" = 等在飞 turn 后 exit 75 (监管者复活);
   * "stop" = drain 后干净退出 0 (KeepAlive 不复活)——bootout 硬停会截断在飞 turn。
   * notifyDone 必须在 **drain 实际完成**后调用 (此前"先应答再 drain"会让 CLI
   * 在 3ms 内误认为 drain 完成, 随即触发服务管理器动作截断在飞 turn)。
   */
  drain(mode: "restart" | "stop", notifyDone: () => void, notifyError: (err: string) => void): void;
}

export function startControlSocket(socketFile: string, handlers: ControlHandlers): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer((socket: Socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        // 单行上限 (R1 评审 M18): 防无换行大流撑内存; 超限断开
        if (buffer.length > MAX_CONTROL_LINE_BYTES) {
          socket.destroy();
          return;
        }
        let sep: number;
        while ((sep = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 1);
          if (!line.trim()) continue;
          void handleLine(socket, line, handlers).catch((err) => {
            logger.warn("GatewayControl", "Control request failed:", err);
          });
        }
      });
      socket.on("error", () => {});
    });

    server.on("error", reject);
    // 残留 socket 文件仅在确认无活 gateway 时清理 (R1 评审 B2/B3: 无条件
    // unlink 会偷走运行中 gateway 的 socket——先 connect 探测, 连不上
    // (ECONNREFUSED/ENOENT) 才是死文件)
    try {
      unlinkSync(socketFile);
    } catch {}
    server.listen(socketFile, () => {
      // 0600: 文件系统 ACL 即鉴权边界
      try {
        chmodSync(socketFile, 0o600);
      } catch {}
      resolve(server);
    });
  });
}

/** 控制协议单行上限 (防内存放大) */
const MAX_CONTROL_LINE_BYTES = 64 * 1024;

/**
 * 探测 socket 路径上是否有活 gateway 且归属本项目 (identify.cwd 校验,
 * R1 评审 M17)。返回 identify 应答; 连不上/应答不合法返回 undefined。
 */
export async function probeLiveGateway(
  socketFile: string,
  expectCwd: string,
  timeoutMs = 1500,
): Promise<IdentifyAnswer | undefined> {
  try {
    const answer = (await probeGateway(socketFile, "identify", timeoutMs)) as IdentifyAnswer;
    if (answer?.cwd !== expectCwd || typeof answer?.pid !== "number") return undefined;
    return answer;
  } catch {
    return undefined;
  }
}

async function handleLine(socket: Socket, line: string, handlers: ControlHandlers): Promise<void> {
  let req: { id?: string | number; verb?: string };
  try {
    req = JSON.parse(line);
  } catch {
    write(socket, { id: null, ok: false, error: "invalid json" });
    return;
  }
  const id = req.id ?? null;
  try {
    switch (req.verb) {
      case "identify":
        write(socket, { id, ok: true, data: handlers.identify() });
        break;
      case "status":
        write(socket, { id, ok: true, data: await handlers.status() });
        break;
      case "drain":
      case "drain-stop": {
        // drain 完成后才应答 (R3 评审 B4): handler 调 notifyDone 时已排空
        // 在飞 turn/调度任务——CLI 侧此刻才能安全触发服务管理器动作
        const mode = req.verb === "drain-stop" ? "stop" : "restart";
        try {
          handlers.drain(
            mode,
            () => {
              write(socket, { id, ok: true, data: { draining: true, mode, done: true } });
            },
            (err) => {
              // async rejection 的协议应答 (R6 评审 M1: 只写日志会让 CLI 等 65s 超时)
              write(socket, { id, ok: false, error: err });
            },
          );
        } catch (err) {
          // 同步抛错也要应答 (R5 评审 M5: 否则 CLI 等 65s 超时)
          write(socket, { id, ok: false, error: String(err) });
        }
        break;
      }
      default:
        write(socket, { id, ok: false, error: `unknown verb: ${String(req.verb)}` });
    }
  } catch (err) {
    write(socket, { id, ok: false, error: String(err) });
  }
}

function write(socket: Socket, payload: unknown): void {
  try {
    socket.write(`${JSON.stringify(payload)}\n`);
  } catch {}
}

// ── CLI 侧探针 ──

export interface IdentifyAnswer {
  version: string;
  cwd: string;
  pid: number;
  uptime: number;
}

/**
 * 探测 gateway: 连接 + 发 verb + 等应答。任何一步失败 = gateway 不在
 * (liveness 判据)。超时 3s (socket 存在但进程僵死视为不在)。
 */
export async function probeGateway(
  socketFile: string,
  verb: "identify" | "status" | "drain" | "drain-stop",
  timeoutMs = 3000,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketFile);
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("control socket timeout"));
    }, timeoutMs);

    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id: 1, verb })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const sep = buffer.indexOf("\n");
      if (sep === -1) return;
      clearTimeout(timer);
      socket.destroy();
      try {
        const resp = JSON.parse(buffer.slice(0, sep));
        if (resp.ok) resolve(resp.data);
        else reject(new Error(resp.error || "gateway error"));
      } catch (err) {
        reject(err);
      }
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** 进程内 handler 组装 (cli 启动 gateway 时使用) */
export function makeControlHandlers(opts: {
  cwd: string;
  isDraining: () => boolean;
  onDrain: (mode: "restart" | "stop", notifyDone: () => void, notifyError: (err: string) => void) => Promise<void>;
  listChannels: () => { id: string; type: string; name: string }[];
}): ControlHandlers {
  return {
    identify: () => ({
      version: GATEWAY_VERSION,
      cwd: opts.cwd,
      pid: process.pid,
      uptime: Math.floor(process.uptime()),
    }),
    status: async () => {
      const manager = AgentManager.getInstance();
      const scheduler = SchedulerManager.getInstance();
      const store = new DatabaseStore();
      return {
        version: GATEWAY_VERSION,
        cwd: opts.cwd,
        pid: process.pid,
        uptime: Math.floor(process.uptime()),
        draining: opts.isDraining(),
        activeTurns: manager.activeTurnCount(),
        scheduler: { started: scheduler.isStarted, inFlight: scheduler.inFlightCount },
        channels: opts.listChannels(),
        webPort: store.getConfig("web_port", "3000"),
      };
    },
    drain: (mode, notifyDone, notifyError) => {
      // async rejection 走协议应答 (R6/R7 评审 M1: 只写日志会让 CLI 等
      // 65s 超时); done/error 只 settle 一次
      let settled = false;
      const ok = () => {
        if (!settled) {
          settled = true;
          notifyDone();
        }
      };
      const fail = (err: unknown) => {
        if (!settled) {
          settled = true;
          notifyError(String(err));
        }
      };
      opts.onDrain(mode, ok, fail).catch(fail);
    },
  };
}
