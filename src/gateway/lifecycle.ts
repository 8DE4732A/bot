import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, openSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { AgentManager } from "../core/agent-manager.ts";
import { SchedulerManager } from "../scheduler/index.ts";
import { DatabaseStore } from "../config/database-store.ts";
import { logger } from "../utils/logger.ts";
import {
  EXIT_CONFIG_ERROR,
  EXIT_RESTART,
  gatewayInstance,
  generateLaunchdPlist,
  generateSystemdUnit,
  isTempCwd,
  launchdPlistPath,
  normalizeDefinition,
  systemdUnitPath,
  type GatewayInstance,
} from "./service-defs.ts";
import { probeGateway, probeLiveGateway } from "./control-socket.ts";

/**
 * Gateway 生命周期命令实现 (四期 M1, 设计 §3.3/§3.4):
 * - liveness 三源合一: socket identify (判据) + 服务管理器状态 (安装/注册态)
 *   + 日志 tail (--deep);
 * - restart = drain 协议经服务管理器 (kickstart -k / systemctl restart),
 *   成功判据 = 观测到新 PID (identify 应答变化), 绝不信命令退出码;
 * - install 幂等: 定义文本归一化一致即跳过, 过期重写 + reload。
 */

const exec = promisify(execFile);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run(cmd: string, args: string[], timeoutMs = 20_000): Promise<string> {
  const { stdout } = await exec(cmd, args, { timeout: timeoutMs, encoding: "utf8" });
  return stdout;
}

function isDarwin(): boolean {
  return process.platform === "darwin";
}

function isLinux(): boolean {
  return process.platform === "linux";
}

/** 静默执行 (失败返回 null——探测类调用) */
async function tryRun(cmd: string, args: string[], timeoutMs = 20_000): Promise<string | null> {
  try {
    return await run(cmd, args, timeoutMs);
  } catch {
    return null;
  }
}

// ── PID 文件 (仅 status 展示, 绝不作为 liveness 判据) ──

export function writePidFile(instance: GatewayInstance): void {
  const payload = JSON.stringify({
    pid: process.pid,
    argv: process.argv,
    cwd: instance.cwd,
    startTime: Date.now(),
  });
  // 并发启动的真实互斥在 gateway.lock (acquireGatewayLock); PID 文件仅
  // 展示用——已存在时覆盖写 (残留自愈), 无互斥语义 (R2 评审 M-3: 旧注释
  // 声称 O_EXCL 互斥与行为不符)
  try {
    const fd = openSync(instance.pidFile, "wx");
    writeFileSync(fd, payload);
  } catch {
    writeFileSync(instance.pidFile, payload);
  }
}

export function readPidFile(instance: GatewayInstance): { pid: number; startTime: number } | undefined {
  try {
    const raw = JSON.parse(readFileSync(instance.pidFile, "utf8"));
    return { pid: Number(raw.pid), startTime: Number(raw.startTime) };
  } catch {
    return undefined;
  }
}

export function clearPidFile(instance: GatewayInstance): void {
  try {
    unlinkSync(instance.pidFile);
  } catch {}
}

// ── 服务管理器操作 ──

function launchdDomain(): string {
  return `gui/${process.getuid?.() ?? 501}`;
}

/** launchd job 是否已 boot 进 domain (与磁盘定义存在性分离) */
async function launchdLoaded(instance: GatewayInstance): Promise<boolean> {
  const out = await tryRun("launchctl", ["print", `${launchdDomain()}/${instance.label}`], 10_000);
  return out !== null;
}

export interface ServiceState {
  platform: "launchd" | "systemd" | "unsupported";
  /** 定义文件在盘 (R1 评审 B4: stop=bootout 后 launchd 已卸载但 plist 仍在,
   *  installed 必须以磁盘为准——否则 start 会误报"未安装") */
  installed: boolean;
  /** 服务管理器里已 boot/loaded (启动动作前需要 bootstrap) */
  loaded: boolean;
  /** 服务管理器视角: running / exited / failed / inactive / unknown */
  managerState: string;
}

export async function serviceState(instance: GatewayInstance): Promise<ServiceState> {
  if (isDarwin()) {
    const defPath = launchdPlistPath(instance);
    const installed = existsSync(defPath);
    const booted = await launchdLoaded(instance);
    let managerState = "unknown";
    if (booted) {
      const out = await tryRun("launchctl", ["print", `${launchdDomain()}/${instance.label}`], 10_000);
      if (out) {
        managerState = /state = running/.test(out) ? "running" : /state = waiting/.test(out) ? "waiting" : out.match(/state = (\w+)/)?.[1] ?? "unknown";
      }
    }
    return { platform: "launchd", installed, loaded: booted, managerState };
  }
  if (isLinux()) {
    const installed = existsSync(systemdUnitPath(instance));
    const out = await tryRun("systemctl", ["--user", "show", `${instance.unitName}.service`, "--property=ActiveState", "--value"], 10_000);
    const managerState = out?.trim() || "unknown";
    return { platform: "systemd", installed, loaded: managerState !== "unknown" && managerState !== "inactive", managerState };
  }
  return { platform: "unsupported", installed: false, loaded: false, managerState: "unknown" };
}

// ── install / uninstall ──

export interface InstallOptions {
  startNow?: boolean;
}

export interface InstallResult {
  action: "created" | "updated" | "unchanged";
  definitionPath: string;
  running: boolean;
  message: string;
}

export async function gatewayInstall(instance: GatewayInstance, opts: InstallOptions = {}): Promise<InstallResult> {
  if (isTempCwd(instance.cwd)) {
    throw new Error("临时目录下的项目不能安装 gateway 服务 (临时目录清理会连带杀死服务); 请在持久目录运行");
  }

  // 双 gateway 防护 (设计 §3.2): 已有本项目的 gateway 在跑则拒绝安装
  // (两个进程共享 SQLite 但各持 ChannelManager/Scheduler → 重复长连接 + 调度竞态)
  const live = await probeLiveGateway(instance.socketFile, instance.cwd, 1500).catch(() => undefined);
  if (live) {
    throw new Error(
      `gateway 已在运行 (pid ${live.pid}); 如需重装请先 \`bot gateway stop\`。两个 gateway 共享同一 .bot 会产生调度竞态与重复渠道连接`,
    );
  }

  const state = await serviceState(instance);
  const defPath = isDarwin() ? launchdPlistPath(instance) : systemdUnitPath(instance);
  const expected = isDarwin() ? generateLaunchdPlist(instance) : generateSystemdUnit(instance);

  // bootstrap-guard 标记: uninstall/重装路径清掉旧标记 (R1 评审 M8——
  // 否则 supervised 启动见旧标记 exit 0, 服务注册了却永不启动)
  try {
    unlinkSync(instance.configErrorMarker);
  } catch {}

  let action: InstallResult["action"] = "created";
  if (state.installed) { // installed 本就 = existsSync(defPath), 单一判定
    if (normalizeDefinition(readFileSync(defPath, "utf8")) === normalizeDefinition(expected)) {
      action = "unchanged";
    } else {
      action = "updated"; // 定义过期: 重写 + reload (hermes staleness 自愈)
    }
  }

  if (action !== "unchanged") {
    mkdirSync(defPath.slice(0, defPath.lastIndexOf("/")), { recursive: true });
    writeFileSync(defPath, expected);
  }

  if (!state.loaded || action === "updated") {
    // launchd: 已 boot 的服务更新定义必须 bootout+bootstrap (R1 评审 B5:
    // launchd 用内存中的 ProgramArguments, 只写文件 + kickstart 跑的还是旧入口)
    if (isDarwin()) {
      if (state.loaded) {
        await tryRun("launchctl", ["bootout", `${launchdDomain()}/${instance.label}`], 20_000);
      }
      const ok = await tryRun("launchctl", ["bootstrap", launchdDomain(), defPath], 15_000);
      if (ok === null) {
        await run("launchctl", ["load", "-w", defPath]);
      }
    } else if (isLinux()) {
      await run("systemctl", ["--user", "daemon-reload"]);
      await run("systemctl", ["--user", "enable", `${instance.unitName}.service`]);
    } else {
      throw new Error(`unsupported platform: ${process.platform} (服务化仅支持 macOS launchd / Linux systemd)`);
    }
  }

  if (opts.startNow) {
    await gatewayStart(instance);
  }

  const after = await probeGateway(instance.socketFile, "identify", 8000).catch(() => undefined);
  return {
    action,
    definitionPath: defPath,
    running: Boolean(after),
    message: after
      ? `gateway 已运行 (pid ${after.pid})`
      : opts.startNow
        ? "服务已注册但进程尚未应答 (launchd ThrottleInterval 内可能有延迟; 用 bot gateway status 观察)"
        : "服务已注册 (RunAtLoad: 重启机器自愈拉起)",
  };
}

export async function gatewayUninstall(instance: GatewayInstance, opts: { purge?: boolean } = {}): Promise<string> {
  const state = await serviceState(instance);
  if (state.platform === "unsupported") {
    throw new Error(`unsupported platform: ${process.platform}`);
  }
  if (state.installed) {
    if (isDarwin()) {
      // bootout = 停止 + 注销 (KeepAlive 不再复活)
      await tryRun("launchctl", ["bootout", `${launchdDomain()}/${instance.label}`], 20_000);
    } else {
      await tryRun("systemctl", ["--user", "stop", `${instance.unitName}.service`], 20_000);
      await tryRun("systemctl", ["--user", "disable", `${instance.unitName}.service`], 20_000);
    }
  }
  const defPath = isDarwin() ? launchdPlistPath(instance) : systemdUnitPath(instance);
  try {
    unlinkSync(defPath);
  } catch {}
  if (isLinux()) await tryRun("systemctl", ["--user", "daemon-reload"]);
  // 清 bootstrap-guard 标记与启动锁 (R1 评审 M8: 旧标记会让重装后的
  // supervised 启动 exit 0, 服务注册了却永不启动)
  try {
    unlinkSync(instance.configErrorMarker);
  } catch {}
  // uninstall 是独立 CLI 进程, pid 恒不等于 gateway——无条件清锁
  // (活进程由 acquireGatewayLock 的 stale 检测保护, R2 评审 C-M-8)
  try {
    unlinkSync(join(instance.cwd, ".bot", "gateway.lock"));
  } catch {}
  if (opts.purge) {
    throw new Error("--purge 数据清除需显式删除 <cwd>/.bot/ (包含会话与凭据, 不由 uninstall 代劳)");
  }
  return `服务已卸载 (定义: ${defPath}); .bot/ 数据已保留`;
}

// ── start / stop / restart ──

export async function gatewayStart(instance: GatewayInstance): Promise<void> {
  const state = await serviceState(instance);
  if (!state.installed) {
    throw new Error("gateway 服务未安装; 先运行 `bot gateway install`");
  }
  // 磁盘有定义但 launchd 未 boot (如 stop=bootout 后): 先 bootstrap 再启动
  // (R1 评审 B4——bootout 后 installed 语义改磁盘, start 必须能自愈)
  if (isDarwin() && !state.loaded) {
    const defPath = launchdPlistPath(instance);
    const ok = await tryRun("launchctl", ["bootstrap", launchdDomain(), defPath], 15_000);
    if (ok === null) {
      await tryRun("launchctl", ["load", "-w", defPath], 15_000);
    }
  }
  if (isDarwin()) {
    await run("launchctl", ["kickstart", `${launchdDomain()}/${instance.label}`]);
  } else {
    await run("systemctl", ["--user", "start", `${instance.unitName}.service`]);
  }
  // 成功判据 = identify 应答, 非 kickstart 退出码
  await waitForGateway(instance, 15_000);
}

export async function gatewayStop(instance: GatewayInstance): Promise<void> {
  const state = await serviceState(instance);
  if (!state.installed) {
    // 未安装但可能有裸进程 (foreground 开发模式): 直接触发 drain socket
    await tryDrainViaSocket(instance);
    return;
  }
  // drain 先行 (R1 评审 M7): bootout 是 SIGTERM 硬停, 破坏"等在飞 turn 交付"
  // 的优雅语义——先经控制 socket 走 drain 协议 (活着才有 drain 可言)
  await tryDrainViaSocket(instance);
  if (isDarwin()) {
    await run("launchctl", ["bootout", `${launchdDomain()}/${instance.label}`], 30_000);
  } else {
    await run("systemctl", ["--user", "stop", `${instance.unitName}.service`], 30_000);
  }
  // drain 后 socket 应消失 (或不可连接)
  await sleep(500);
  const still = await probeGateway(instance.socketFile, "identify", 1500).catch(() => undefined);
  if (still) throw new Error("stop 已下发但 gateway 仍应答; 稍后用 status 复查");
}

/** restart = drain 协议优先 + 新 PID 观测 (设计 §3.4; R2 评审 B5:
 *  此前直接 kickstart -k = SIGTERM 硬截断在飞 turn) */
export async function gatewayRestart(instance: GatewayInstance): Promise<{ oldPid?: number; newPid: number }> {
  const before = await probeGateway(instance.socketFile, "identify", 2000).catch(() => undefined);
  const oldPid = before?.pid;

  if (oldPid === undefined) {
    // 未运行: 直接启动
    await gatewayStart(instance);
    const after = await probeGateway(instance.socketFile, "identify", 5000);
    return { oldPid: undefined, newPid: after.pid };
  }

  // 首选: 经控制 socket 走 drain (exit 75 → 服务管理器 KeepAlive/Restart 复活),
  // 在飞 turn 与调度任务交付完毕才退出 (drain 内含 WS 队列清空审计)
  const drained = await tryDrainViaSocket(instance, "restart");
  if (drained) {
    // drain 自身即重启机制 (75 → 复活); 监管者侧 kickstart 只是兜底触发器
    if (isDarwin()) {
      await tryRun("launchctl", ["kickstart", `${launchdDomain()}/${instance.label}`], 30_000);
    } else if (isLinux()) {
      await tryRun("systemctl", ["--user", "restart", `${instance.unitName}.service`], 30_000);
    }
  } else {
    // drain 不可用 (socket 失联但进程可能还活着): 硬重启 fallback
    if (isDarwin()) {
      await run("launchctl", ["kickstart", "-k", `${launchdDomain()}/${instance.label}`], 30_000);
    } else if (isLinux()) {
      await run("systemctl", ["--user", "restart", `${instance.unitName}.service`], 30_000);
    } else {
      throw new Error(`unsupported platform: ${process.platform}`);
    }
  }

  // 成功判据 = 观测到新 PID (identify 应答变化), 15s 轮询; 未出现则强制重建
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const now = await probeGateway(instance.socketFile, "identify", 2000).catch(() => undefined);
    if (now && now.pid !== oldPid) return { oldPid, newPid: now.pid };
    await sleep(500);
  }
  // 强制: stop + start (systemd: restart 再来一次)。观测窗短于 drain +
  // ThrottleInterval 时会常态走到这里, 而服务实际正被 launchd 自愈拉起——
  // stop 的 bootout 对已退出进程会报错 (R3 评审 C-M-2), 容错不误导用户
  logger.warn("Gateway", "restart 未观测到新 PID, 强制重建服务");
  try {
    await gatewayStop(instance);
  } catch (err) {
    logger.warn("Gateway", `restart fallback stop failed (服务可能已被监管者拉起): ${err}`);
  }
  await gatewayStart(instance);
  const forced = await probeGateway(instance.socketFile, "identify", 5000);
  return { oldPid, newPid: forced.pid };
}

async function tryDrainViaSocket(instance: GatewayInstance, mode: "restart" | "stop" = "stop"): Promise<boolean> {
  try {
    // 复用 control-socket 的协议客户端 (R8 simplify: probeGatewayDrain 是
    // probeGateway 的整段重写); drain 完成时服务端才应答 (R3 评审 B4)
    const verb = mode === "stop" ? "drain-stop" : "drain";
    await probeGateway(instance.socketFile, verb, 65_000); // drain 上限 50s + 余量
    return true;
  } catch {
    return false;
  }
}

export async function waitForGateway(instance: GatewayInstance, timeoutMs: number): Promise<{ pid: number }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const answer = await probeGateway(instance.socketFile, "identify", 2000).catch(() => undefined);
    if (answer) return answer;
    await sleep(500);
  }
  throw new Error(`gateway ${Math.round(timeoutMs / 1000)}s 内未应答 (bot gateway status 查看日志)`);
}

// ── status (三源合一) ──

export interface GatewayStatusReport {
  instance: GatewayInstance;
  service: ServiceState;
  /** socket identify 应答 (undefined = 不可连接 = 不在运行) */
  live?: { version: string; pid: number; uptime: number };
  pidFile?: { pid: number; startTime: number };
  logTail?: string[];
  managerDetail?: string;
}

export async function gatewayStatus(instance: GatewayInstance, opts: { deep?: boolean } = {}): Promise<GatewayStatusReport> {
  const service = await serviceState(instance);
  const live = await probeGateway(instance.socketFile, "identify", 2000).catch(() => undefined);
  const pidFile = readPidFile(instance);
  const report: GatewayStatusReport = { instance, service, live, pidFile };

  if (opts.deep) {
    if (isDarwin()) {
      report.managerDetail = (await tryRun("launchctl", ["print", `${launchdDomain()}/${instance.label}`], 10_000)) ?? undefined;
    } else if (isLinux()) {
      report.managerDetail = (await tryRun("systemctl", ["--user", "status", `${instance.unitName}.service`, "--no-pager", "-l"], 10_000)) ?? undefined;
    }
    try {
      const text = readFileSync(instance.logFile, "utf8");
      report.logTail = text.split("\n").slice(-20);
    } catch {}
  }
  return report;
}

export function renderStatusReport(report: GatewayStatusReport): string {
  const { instance, service, live, pidFile } = report;
  const lines: string[] = [];
  lines.push(`\n\x1b[1m=== Bot Gateway (${instance.cwd}) ===\x1b[0m`);
  lines.push(`  实例:       ${instance.label}`);
  lines.push(`  平台:       ${service.platform}`);
  lines.push(`  服务注册:   ${service.installed ? "已安装" : "未安装"}`);
  lines.push(`  管理器状态: ${service.managerState}`);
  if (live) {
    lines.push(`  运行状态:   \x1b[32m● 在线\x1b[0m (pid ${live.pid}, uptime ${Math.floor(live.uptime / 60)}m ${live.uptime % 60}s, v${live.version})`);
  } else {
    lines.push(`  运行状态:   \x1b[31m○ 离线\x1b[0m (socket 无应答)`);
    if (pidFile) lines.push(`  PID 文件:   残留 pid ${pidFile.pid} (非 liveness 判据, 仅供诊断)`);
  }
  lines.push(`  控制套接字: ${instance.socketFile}`);
  lines.push(`  日志:       ${instance.logFile}`);
  if (report.logTail?.length) {
    lines.push("", "\x1b[1m最近日志:\x1b[0m");
    for (const l of report.logTail) lines.push(`  ${l}`);
  }
  lines.push("");
  return lines.join("\n");
}

// ── WS 排队消息 (ws-gateway 共享; 队列机制见该文件注释) ──

export interface QueuedPrompt {
  /** 持久化行 id (R2 评审 B6: 受理即落库, 出队/清空时删行) */
  dbId?: number;
  agentId: string;
  sessionId: string;
  message: string;
}

export const sessionQueues = new Map<string, QueuedPrompt[]>();

/** 清空会话队列 (drain/cancel/reset 联动), 返回丢弃条数 */
export function clearSessionQueue(key: string): number {
  const queue = sessionQueues.get(key);
  sessionQueues.delete(key);
  return queue?.length ?? 0;
}

/**
 * 取消的统一语义单元 (R8 simplify: 此前 6 个入口各自手拼"清队列 + abort",
 * ws 侧漂移成绕过 helper 的裸原语组合)。权威顺序: 清队列 (内存+持久行) → abort。
 * 全部 cancel 入口 (命令 /cancel、WS session.cancel、HTTP cancel) 一行调用。
 */
export async function doCancel(agentId: string, sessionId: string): Promise<boolean> {
  clearQueuedForSession(agentId, sessionId);
  return AgentManager.getInstance().abortSession(agentId, sessionId);
}

/**
 * 重置的统一语义单元: 清队列 → abort (截断类不等待在飞生成) → reset。
 * 全部 reset 入口 (命令 /reset、WS session.reset、HTTP /api/chat/reset) 一行调用。
 */
export async function doReset(agentId: string, sessionId: string): Promise<void> {
  clearQueuedForSession(agentId, sessionId);
  await AgentManager.getInstance().abortSession(agentId, sessionId);
  await AgentManager.getInstance().resetSession(agentId, sessionId);
}

/** 取消/重置的统一队列清理 (R3 评审 B6: 内存队列 + 持久化行必须同清——
 *  此前 /cancel 与 HTTP cancel/reset 只 abort 不清队列, turn error 后
 *  queue driver 把旧排队消息继续投出)。全部 cancel/reset 入口都走这里。 */
export function clearQueuedForSession(agentId: string, sessionId: string): number {
  const dropped = clearSessionQueue(`${agentId}:${sessionId}`);
  try {
    return dropped + new DatabaseStore().clearQueuedPrompts(agentId, sessionId);
  } catch {
    return dropped;
  }
}

// ── 启动互斥锁 (R1 评审 B2/B3: probe 与 bind 之间的 TOCTOU 封堵) ──

/** 尝试获取 gateway 启动锁: O_EXCL 原子创建; 已存在时按 pid 探测 stale。
 *  局限 (R2 评审 M-2): pid 被无关进程复用时会误拒启动 (概率极低, 手删
 *  gateway.lock 可恢复)——未比对进程启动时间, flock 是更彻底的方案。 */
export function acquireGatewayLock(instance: GatewayInstance): boolean {
  const lockFile = join(instance.cwd, ".bot", "gateway.lock");
  const payload = JSON.stringify({ pid: process.pid, startTime: Date.now() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockFile, "wx");
      writeFileSync(fd, payload);
      return true;
    } catch {
      // 已存在: 读 pid 判断是否 stale (持有进程已死 → 移除重试)
      try {
        const raw = JSON.parse(readFileSync(lockFile, "utf8")) as { pid?: number };
        if (raw?.pid && raw.pid !== process.pid) {
          try {
            process.kill(raw.pid, 0); // 活着 → 真实并存, 拒绝启动
            logger.error("Gateway", `另一 gateway 正在运行 (pid ${raw.pid}), 拒绝重复启动`);
            return false;
          } catch {
            // pid 已死 → stale lock
          }
        }
      } catch {}
      try {
        unlinkSync(lockFile);
      } catch {
        return false;
      }
    }
  }
  return false;
}

export function releaseGatewayLock(instance: GatewayInstance): void {
  try {
    const lockFile = join(instance.cwd, ".bot", "gateway.lock");
    const raw = JSON.parse(readFileSync(lockFile, "utf8")) as { pid?: number };
    if (raw?.pid === process.pid) unlinkSync(lockFile); // 只清自己的锁
  } catch {}
}

// ── drain 协议 (gateway 进程内, 设计 §3.4) ──

let draining = false;

export function isDraining(): boolean {
  return draining;
}

/**
 * drain-and-exit: 置 draining 拒新任务 → 停调度器 → 清 WS 排队消息 →
 * 等在飞 turn 与调度器在飞任务交付 (上限 50s; "被中断的定时任务是永久
 * 失败", Scheduler drain 下限单列——R1 评审 B6) → 返回后由调用方完成
 * 组件停机并按 mode 退出 (75 = 复活 / 0 = 干净停止)。
 */
let drainPromise: Promise<void> | undefined;

export async function drainInFlight(): Promise<void> {
  // 幂等且可等待 (R3 评审 B4: 此前 draining=true 直接 return——SIGTERM
  // handler 的 drain 立即返回并开始 cleanup, 绕过仍在进行的第一次 drain;
  // 现在重复调用 await 同一 promise)
  if (drainPromise) return drainPromise;
  draining = true;
  drainPromise = doDrain();
  return drainPromise;
}

async function doDrain(): Promise<void> {
  logger.info("Gateway", "Draining: refusing new work, stopping scheduler…");
  try {
    SchedulerManager.getInstance().stop();
  } catch {}
  // WS 排队消息: 内存队列随进程蒸发 (R1 评审 B7/B9)——显式清空并审计,
  // 不给"已受理"的假象留静默丢失的空间; 持久化队列记设计 §8-3 backlog
  let droppedTotal = 0;
  for (const [key, queue] of [...sessionQueues]) {
    droppedTotal += queue.length;
    clearSessionQueue(key);
    // 持久化行同步清除 (受理即落库的删除侧, R2 评审 B6)
    if (queue[0]?.agentId && queue[0]?.sessionId) {
      try {
        new DatabaseStore().clearQueuedPrompts(queue[0].agentId, queue[0].sessionId);
      } catch {}
    }
  }
  if (droppedTotal > 0) {
    logger.warn("Gateway", `Drain dropped ${droppedTotal} queued prompt(s)`);
    try {
      new DatabaseStore().recordAudit("gateway.drain_dropped_queue", { dropped: droppedTotal });
    } catch {}
  }
  const agentManager = AgentManager.getInstance();
  const scheduler = SchedulerManager.getInstance();
  const deadline = Date.now() + 50_000;
  const pending = async (): Promise<{ turns: number; durable: number }> => ({
    turns: agentManager.activeTurnCount(),
    // inspect 失败 fail-closed (R5 评审 B1): 按"仍有 durable 工作"继续等
    durable: await agentManager.durableBusyCount().catch(() => 1),
  });
  // 等待面 = 在飞 chat turn + 调度器在飞任务 + durable 恢复任务 (R4 评审 B2:
  // harness.resume() 重放的 running/ready 任务不在 busyTurns, 不计入会截断)
  let last = await pending();
  while (
    (last.turns > 0 || last.durable > 0 || scheduler.inFlightCount > 0) &&
    Date.now() < deadline
  ) {
    logger.debug(
      "Gateway",
      `Drain: waiting for ${last.turns} turn(s), ${last.durable} durable task(s), ${scheduler.inFlightCount} scheduler task(s)…`,
    );
    await sleep(300);
    last = await pending();
  }
  if (last.turns > 0 || last.durable > 0 || scheduler.inFlightCount > 0) {
    logger.warn(
      "Gateway",
      `Drain deadline reached with ${last.turns} turn(s), ${last.durable} durable task(s), ${scheduler.inFlightCount} task(s); proceeding to exit`,
    );
  } else {
    logger.info("Gateway", "Drain complete: all in-flight work delivered");
  }
}

export { EXIT_RESTART, EXIT_CONFIG_ERROR };
