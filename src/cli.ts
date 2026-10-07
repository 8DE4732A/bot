#!/usr/bin/env bun
import { DatabaseStore } from "./config/database-store.ts";
import { ensureBotDirectories, getBotPaths } from "./config/env-paths.ts";
import { ChannelManager } from "./channels/manager.ts";
import { TerminalChannel } from "./channels/terminal/index.ts";
import { AgentManager } from "./core/agent-manager.ts";
import { ModelFactory } from "./core/model-factory.ts";
import { initCommandRouting } from "./core/chat-orchestrator.ts";
import { loadOrCreateGatewayToken } from "./core/gateway-token.ts";
import { DatabaseManager } from "./database/index.ts";
import { AdminWebServer } from "./server/server.ts";
import { loadCustomSkills } from "./skills/loader.ts";
import { McpBridge } from "./skills/mcp/bridge.ts";
import { SchedulerManager } from "./scheduler/index.ts";
import { NotificationDispatcher } from "./notifications/dispatcher.ts";
import { logger } from "./utils/logger.ts";
import {
  EXIT_CONFIG_ERROR,
  EXIT_RESTART,
  acquireGatewayLock,
  drainInFlight,
  gatewayInstall,
  gatewayRestart,
  gatewayStart,
  gatewayStatus,
  gatewayStop,
  gatewayUninstall,
  isDraining,
  releaseGatewayLock,
  renderStatusReport,
  writePidFile,
  clearPidFile,
} from "./gateway/lifecycle.ts";
import { gatewayInstance, resolveGatewayProgram } from "./gateway/service-defs.ts";
import { makeControlHandlers, probeGateway, probeLiveGateway, startControlSocket } from "./gateway/control-socket.ts";
import { existsSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { BOT_VERSION } from "./version.ts";
import { join } from "node:path";
import { spawn } from "node:child_process";

async function main() {
  const args = process.argv.slice(2);
  // The command is the first positional argument; flags like --port default to "start".
  const firstPositional = args.find((a) => !a.startsWith("-"));
  const command = firstPositional || "start";
  const sub = command === "gateway" ? (args.find((a, i) => i > args.indexOf("gateway") && !a.startsWith("-")) || "help") : undefined;

  // Ensure .bot layout under current working directory
  const cwd = process.cwd();
  const paths = ensureBotDirectories(cwd);
  logger.init(cwd);

  // Initialize SQLite database
  const db = DatabaseManager.getInstance(paths.dbFile);
  const store = new DatabaseStore(db);

  // bot --version / bot version: 版本随构建注入 (git tag 单一真相源)
  if (command === "version" || args.includes("--version")) {
    console.log(BOT_VERSION);
    process.exit(0);
  }

  // ── gateway 生命周期命令族 (四期 M1): 不启动平台组件, 只操作服务/探测 ──
  if (command === "gateway" && sub !== "start") {
    await gatewayLifecycleCommand(sub!, args, store);
    return; // gatewayLifecycleCommand 内部自行 exit
  }

  // ── 优雅退出 handler (注册提前到组件启动前, 四期 §3.5) ──
  let isShuttingDown = false;
  let exitCode = 0;
  const shutdownHandlers: (() => Promise<void>)[] = [];
  const cleanup = async (code?: number) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    if (code !== undefined) exitCode = code;
    logger.info("CLI", "Shutting down...");
    for (const h of shutdownHandlers) {
      try {
        await Promise.race([h(), new Promise((r) => setTimeout(r, 800))]);
      } catch {}
    }
    try {
      db.close();
    } catch {}
    process.exit(exitCode);
  };
  process.on("SIGINT", () => void cleanup());
  process.on("SIGTERM", () => {
    // SIGTERM 来自服务管理器 (launchd bootout / systemd stop): 先 drain 再退,
    // 在飞 turn 与调度任务交付完毕才走组件停机 (R2 评审 B5: 此前 800ms race
    // 会截断 AgentManager.shutdown 与在飞生成)。SIGINT 是交互中断, 保持快速退出
    void (async () => {
      try {
        await Promise.race([drainInFlight(), new Promise((r) => setTimeout(r, 55_000))]);
      } catch {}
      await cleanup(0);
    })();
  });

  if (command === "status") {
    printConfigStatus(cwd, paths, store);
    process.exit(0);
  }

  if (command === "admin") {
    const port = store.getConfig("web_port", "3000");
    const host = store.getConfig("web_host", "127.0.0.1");
    console.log(`\n\x1b[36mWeb Admin URL: \x1b[4mhttp://${host}:${port}\x1b[0m\n`);
    process.exit(0);
  }

  // bot / bot tui: 连接 gateway 进 TUI (M2); 这里先做探测与引导
  if (command === "tui") {
    await tuiEntry(args, store);
    return;
  }

  // bot (裸命令) = TUI; bot start/run = 前台平台 (gateway start --foreground 别名)
  if (firstPositional === undefined) {
    await tuiEntry([], store);
    return;
  }

  if (command === "start" || command === "run") {
    // 保留别名 = gateway start --foreground (带终端 REPL; 兼容现有习惯与 dev 脚本)
    const opts = parseStartOptions(args, { noTerminal: false, supervised: false });
    await runPlatform(cwd, opts, shutdownHandlers, cleanup, { interactiveTerminal: !opts.noTerminal });
    return;
  }

  if (command === "gateway" && sub === "start") {
    const foreground = args.includes("--foreground");
    const supervised = args.includes("--supervised");
    if (foreground) {
      // bootstrap-guard (§3.2): 上次 exit 78 的配置错标记 → 本次 exit 0,
      // KeepAlive {SuccessfulExit:false} 链条终止 (防配置错死循环复活);
      // 手动运行 (--supervised 缺省) 清标记照常启动, 供用户修复后调试
      const instance = gatewayInstance(cwd);
      if (supervised && existsSync(instance.configErrorMarker)) {
        logger.error("CLI", "上次启动因配置错误失败 (gateway.config-error 标记存在); 本次退出不再重启。修复配置后运行 `bot gateway start --foreground` 或删除标记文件");
        process.exit(0);
      }
      if (existsSync(instance.configErrorMarker)) {
        try {
          unlinkSync(instance.configErrorMarker);
        } catch {}
      }
      await runPlatform(cwd, parseStartOptions(args, { noTerminal: true, supervised }), shutdownHandlers, cleanup, { interactiveTerminal: false });
      return;
    }
    // 无 --foreground: daemon 化 (spawn detached + 日志重定向), 父进程即退
    await daemonizeGateway(cwd);
    return;
  }

  console.log(
    [
      "Usage:",
      "  bot                              # 连接 gateway 进入 TUI (未运行时提示安装)",
      "  bot tui                          # 同上",
      "  bot start [--port N] [--host A] [--no-terminal|--daemon]  # 前台运行 (= gateway start --foreground)",
      "  bot status | admin               # 配置状态 / 管理后台地址",
      "  bot gateway install [--start-now]   # 注册 launchd/systemd 服务",
      "  bot gateway uninstall            # 卸载服务 (保留 .bot 数据)",
      "  bot gateway start [--foreground] # 启动 (默认 daemon 化)",
      "  bot gateway stop | restart       # 经服务管理器停止/重启 (drain 协议)",
      "  bot gateway status [--deep]      # 运行状态三源合一",
      "  bot gateway service              # 服务管理器视角 (JSON)",
    ].join("\n"),
  );
  process.exit(command === "help" ? 0 : 1);
}

// ── 平台运行时 (gateway foreground 与 bot start 共用) ──

interface StartOptions {
  port?: number;
  host?: string;
  noTerminal: boolean;
  supervised: boolean;
}

function parseStartOptions(args: string[], base: { noTerminal: boolean; supervised: boolean }): StartOptions {
  const opts: StartOptions = { ...base };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && args[i + 1]) opts.port = parseInt(args[i + 1], 10);
    if (args[i] === "--host" && args[i + 1]) opts.host = args[i + 1];
    if (args[i] === "--no-terminal" || args[i] === "--daemon") opts.noTerminal = true;
  }
  return opts;
}

async function runPlatform(
  cwd: string,
  opts: StartOptions,
  shutdownHandlers: (() => Promise<void>)[],
  cleanup: (code?: number) => Promise<void>,
  extra: { interactiveTerminal: boolean },
): Promise<void> {
  const paths = getBotPaths(cwd);
  const store = new DatabaseStore();
  const instance = gatewayInstance(cwd);

  // 双 gateway 防护前置 (R1 评审 B2/B3): runPlatform 此前无任何 probe,
  // startControlSocket 的无条件 unlink 会偷走运行中 gateway 的 socket,
  // 端口不冲突时更是完整双实例并存 (双调度器/双长连接/SQLite 双写)
  const live = await probeLiveGateway(instance.socketFile, instance.cwd).catch(() => undefined);
  if (live) {
    logger.error("CLI", `gateway 已在运行 (pid ${live.pid}); 拒绝重复启动。管理台: bot admin`);
    process.exit(opts.supervised ? 0 : 1);
  }
  if (!acquireGatewayLock(instance)) {
    // acquire 内部已打印存活实例信息; supervised 下按配置错处理 (不重启)
    process.exit(opts.supervised ? EXIT_CONFIG_ERROR : 1);
  }

  let port = opts.port ?? parseInt(store.getConfig("web_port", "3000"), 10);
  let host = opts.host ?? store.getConfig("web_host", "127.0.0.1");

  logger.info("CLI", `Starting Bot platform at ${cwd} (port: ${port})...`);

  // 2. Load custom skills (工具型 index.ts + 文档型 SKILL.md)
  await loadCustomSkills(cwd);

  // 2b. 统一命令路由接线 (四期 M0): IM 管道 slash fast path + Web/TUI 统一入口
  initCommandRouting();

  // 3. Initialize Agent Harness
  await AgentManager.getInstance().init(cwd);

  // 3b. Bridge configured MCP servers into the registry (连接失败不阻塞启动;
  //     失败的 server 由低频重试循环自动恢复)
  await McpBridge.getInstance().sync(store);
  McpBridge.getInstance().startRetryLoop(store);

  // 3c. Start the scheduler (due 任务的 catch-up 由轮询天然覆盖)
  SchedulerManager.getInstance().start();

  // 3d. Subscribe platform events → channel notifications (定时任务结果推送等)
  NotificationDispatcher.getInstance().init();

  // 3e. Gateway 控制套接字 (§3.3): 可连接 + 合法 identify 应答 = liveness
  const isSupervised = opts.supervised;
  const controlServer = await startControlSocket(
    instance.socketFile,
    makeControlHandlers({
      cwd,
      isDraining,
      onDrain: async (mode, notifyDone, notifyError) => {
        // drain 完成后才通知 CLI 侧 (R3 评审 B4: 应答即完成的假象会让
        // restart 在 drain 进行中就触发 kickstart/SIGTERM 截断在飞 turn);
        // drain 异常走协议 error 应答 (R6/R7 评审 M1)
        try {
          await drainInFlight();
        } catch (err) {
          notifyError(String(err));
          await cleanup(1);
          return;
        }
        notifyDone();
        // restart = exit 75 (监管者复活); stop = 干净退出 0 (KeepAlive 不复活)
        await cleanup(mode === "stop" ? 0 : EXIT_RESTART);
      },
      listChannels: () => ChannelManager.getInstance().listAdapters().map((a) => ({
        id: a.id,
        type: a.type,
        name: a.name,
      })),
    }),
  ).catch((err) => {
    // lock 已保证互斥, bind 失败只剩文件系统异常等真实错误
    logger.error("CLI", "Failed to bind control socket:", err);
    process.exit(isSupervised ? EXIT_CONFIG_ERROR : 1);
  });

  // 4 & 5. Start Web Server and configured channels (渠道先启动、Web 后开,
  // 共享生命周期状态防双连接泄漏——三期既有时序)
  const channelManager = ChannelManager.getInstance();
  // gateway/daemon 模式不创建终端 REPL: readline 会试图读取 stdin (SIGTTIN 风险)
  const terminalChannel = extra.interactiveTerminal ? new TerminalChannel() : undefined;
  if (terminalChannel) channelManager.register(terminalChannel);
  const webServer = new AdminWebServer(port, host, {
    // 注入式 token (四期 §6.1): 浏览器经 HTML 注入/bootstrap 无感携带;
    // 管理台与 gateway 共用同一 token
    authToken: loadOrCreateGatewayToken(cwd),
  });
  await channelManager.startAll();
  try {
    await webServer.start();
  } catch (err) {
    // 端口占用等 = 致命配置错 (§3.2): supervised 下 exit 78 + 标记,
    // bootstrap-guard 在下次重启时终止 KeepAlive 链条
    logger.error("CLI", "Web server failed to start:", err);
    if (isSupervised) {
      writeFileSync(instance.configErrorMarker, new Date().toISOString());
      await cleanup(EXIT_CONFIG_ERROR);
      return;
    }
    await cleanup(1);
    return;
  }

  // 启动成功: 清配置错标记 (bootstrap-guard 解除) + 释放锁的钩子注册
  try {
    unlinkSync(instance.configErrorMarker);
  } catch {}
  writePidFile(instance);
  shutdownHandlers.push(() => {
    releaseGatewayLock(instance);
    return Promise.resolve();
  });
  process.on("SIGUSR1", () => {
    // drain 协议 (§3.4): SIGUSR1 = drain-and-restart, systemd reload 同路
    void (async () => {
      await drainInFlight();
      await cleanup(EXIT_RESTART);
    })();
  });

  // 组件收尾注册到早建的 shutdown 管线; 每步独立限时, 单点挂死不阻塞整体退出
  shutdownHandlers.push(async () => {
    try {
      await terminalChannel?.stop();
    } catch {}
    await Promise.race([
      Promise.all([channelManager.stopAll(), webServer.stop()]),
      new Promise((r) => setTimeout(r, 800)),
    ]);
    try {
      controlServer.close();
    } catch {}
    clearPidFile(instance);
  });
  shutdownHandlers.push(async () => {
    // 会话库 WAL checkpoint (pi-durable storage close), 尽量在进程退出前收敛
    await AgentManager.getInstance().shutdown();
  });
  shutdownHandlers.push(async () => {
    SchedulerManager.getInstance().stop();
    NotificationDispatcher.getInstance().stop();
    // MCP stdio 子进程回收
    await McpBridge.getInstance().closeAll();
  });

  logger.info(
    "CLI",
    `Platform started: web http://${host}:${port} · gateway.sock ${instance.socketFile}${isSupervised ? " (supervised)" : ""}`,
  );

  if (extra.interactiveTerminal && terminalChannel) {
    // Start interactive terminal channel (bot start 前台模式)
    await terminalChannel.start();
  } else {
    logger.info("CLI", "Gateway mode enabled. Running until stopped…");
    // Keep process alive
    await new Promise(() => {});
  }
}

// ── gateway 生命周期子命令 ──

async function gatewayLifecycleCommand(
  sub: string,
  args: string[],
  _store: DatabaseStore,
): Promise<void> {
  const instance = gatewayInstance();
  try {
    switch (sub) {
      case "install": {
        const result = await gatewayInstall(instance, { startNow: args.includes("--start-now") });
        console.log(`✅ gateway 服务${result.action === "created" ? "安装" : result.action === "updated" ? "定义更新" : "已安装 (定义一致)"}: ${result.definitionPath}`);
        console.log(`   ${result.message}`);
        process.exit(0);
      }
      case "uninstall": {
        console.log(await gatewayUninstall(instance, { purge: args.includes("--purge") }));
        process.exit(0);
      }
      // case "start" 已并入 main 的分流 (带 --foreground 走 runPlatform,
      // 不带 --foreground 走 daemonizeGateway)——此处不可达, 不设分支
      case "stop": {
        await gatewayStop(instance);
        console.log("✅ gateway 已停止");
        process.exit(0);
      }
      case "restart": {
        const { oldPid, newPid } = await gatewayRestart(instance);
        console.log(`✅ gateway 已重启 (观测到新 pid: ${oldPid ?? "-"} → ${newPid})`);
        process.exit(0);
      }
      case "status": {
        const report = await gatewayStatus(instance, { deep: args.includes("--deep") });
        console.log(renderStatusReport(report));
        process.exit(0);
      }
      case "service": {
        const { serviceState } = await import("./gateway/lifecycle.ts");
        const { probeGateway } = await import("./gateway/control-socket.ts");
        const state = await serviceState(instance);
        const live = await probeGateway(instance.socketFile, "identify", 2000).catch(() => undefined);
        console.log(
          JSON.stringify(
            {
              instance: instance.label,
              platform: state.platform,
              installed: state.installed,
              managerState: state.managerState,
              running: Boolean(live),
              pid: live?.pid,
              uptime: live?.uptime,
              cwd: instance.cwd,
            },
            null,
            2,
          ),
        );
        process.exit(0);
      }
      default: {
        console.log("Usage: bot gateway <install|uninstall|start|stop|restart|status|service> [--foreground|--start-now|--deep]");
        process.exit(sub === "help" ? 0 : 1);
      }
    }
  } catch (err) {
    console.error(`\x1b[31mError: ${err instanceof Error ? err.message : err}\x1b[0m`);
    process.exit(1);
  }
}

/** daemon 化: spawn detached 子进程 (foreground), 日志重定向, 父进程即退 */
async function daemonizeGateway(cwd: string): Promise<void> {
  const instance = gatewayInstance(cwd);
  // 已在运行则不重复拉起 (双 gateway = 调度竞态 + 重复渠道连接;
  // probeLiveGateway 含 cwd 归属校验, R8 simplify I#9 与 runPlatform 同一判定)
  const live = await probeLiveGateway(instance.socketFile, instance.cwd, 1500).catch(() => undefined);
  if (live) {
    console.log(`gateway 已在运行 (pid ${live.pid}); 管理台: bot admin`);
    process.exit(0);
  }
  const program = resolveGatewayProgram(cwd);
  const out = openSync(instance.logFile, "a");
  const errFd = openSync(instance.errorLogFile, "a");
  const child = spawn(program[0]!, program.slice(1), {
    cwd,
    detached: true,
    stdio: ["ignore", out, errFd],
    env: process.env,
  });
  child.unref();
  console.log(`gateway daemon 已拉起 (pid ${child.pid}); 日志: ${instance.logFile}`);
  // 等控制 socket 应答确认启动 (最多 20s; launchd 语境不存在, 直接观测)
  const { waitForGateway } = await import("./gateway/lifecycle.ts");
  try {
    const answer = await waitForGateway(instance, 20_000);
    console.log(`✅ gateway 在线 (pid ${answer.pid}); 管理台: bot admin`);
  } catch {
    console.log("⚠ gateway 未在 20s 内应答; 查看 `bot gateway status --deep` 与日志");
    process.exitCode = 1;
  }
}

// ── TUI 入口 (M2) ──

async function tuiEntry(args: string[], store: DatabaseStore): Promise<void> {
  const instance = gatewayInstance();
  const live = await probeGateway(instance.socketFile, "identify", 2000).catch(() => undefined);
  if (!live) {
    const { serviceState } = await import("./gateway/lifecycle.ts");
    const state = await serviceState(instance);
    console.log("\ngateway 未运行。");
    if (state.installed) {
      console.log(`  服务已注册 (${state.managerState}); 启动: \x1b[36mbot gateway start\x1b[0m`);
    } else {
      console.log("  后台持久服务: \x1b[36mbot gateway install --start-now\x1b[0m");
      console.log("  前台开发模式: \x1b[36mbot start\x1b[0m");
    }
    console.log("");
    process.exit(1);
  }
  const { runTui } = await import("./tui/index.tsx");
  await runTui({ webPort: store.getConfig("web_port", "3000") });
}

function printConfigStatus(cwd: string, paths: ReturnType<typeof getBotPaths>, store: DatabaseStore): void {
  const agents = store.listAgents();
  const channels = store.listChannels();
  const port = store.getConfig("web_port", "3000");
  const host = store.getConfig("web_host", "127.0.0.1");

  console.log("\n\x1b[1m=== Bot Agent Status ===\x1b[0m");
  console.log(`  工作目录 (cwd):      ${cwd}`);
  console.log(`  业务数据库:          ${paths.dbFile}`);
  console.log(`  会话数据库:          ${paths.conversationsDbFile}`);
  console.log(`  日志目录:            ${paths.logsDir}`);
  console.log(`  工作空间根目录:      ${paths.workspacesDir}`);
  console.log(`  Web 管理后台:        http://${host}:${port}`);
  console.log(`  已配置 Agent 数量:   ${agents.length}`);
  for (const a of agents) {
    console.log(`    - [${a.id}] ${a.name} (${a.model.provider}/${a.model.modelId})`);
  }
  console.log(`  已配置渠道数量:      ${channels.length}`);
  for (const c of channels) {
    console.log(`    - [${c.id}] ${c.name} (${c.type}) -> Agent: ${c.boundAgentId}`);
  }
  console.log("");
}

// ── fs helpers 已并入顶部 import ──

main().catch((err) => {
  logger.error("CLI", "Fatal startup error:", err);
  // supervised 下一切启动 fatal 都是配置/环境错: exit 78 + 标记, bootstrap-guard
  // 终止 launchd KeepAlive 链条 (R1 评审 M15: 坏 skill/数据库错不应 30s 重启循环)
  if (process.argv.includes("--supervised")) {
    try {
      writeFileSync(join(gatewayInstance().cwd, ".bot", "gateway.config-error"), new Date().toISOString());
    } catch {}
    process.exit(EXIT_CONFIG_ERROR);
  }
  process.exit(1);
});
