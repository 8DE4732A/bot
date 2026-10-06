#!/usr/bin/env bun
import { DatabaseStore } from "./config/database-store.ts";
import { ensureBotDirectories, getBotPaths } from "./config/env-paths.ts";
import { ChannelManager } from "./channels/manager.ts";
import { TerminalChannel } from "./channels/terminal/index.ts";
import { AgentManager } from "./core/agent-manager.ts";
import { ModelFactory } from "./core/model-factory.ts";
import { DatabaseManager } from "./database/index.ts";
import { AdminWebServer } from "./server/server.ts";
import { loadCustomSkills } from "./skills/loader.ts";
import { McpBridge } from "./skills/mcp/bridge.ts";
import { SchedulerManager } from "./scheduler/index.ts";
import { NotificationDispatcher } from "./notifications/dispatcher.ts";
import { logger } from "./utils/logger.ts";

async function main() {
  const args = process.argv.slice(2);
  // The command is the first positional argument; flags like --port default to "start".
  const firstPositional = args.find((a) => !a.startsWith("-"));
  const command = firstPositional || "start";

  // Ensure .bot layout under current working directory
  const cwd = process.cwd();
  const paths = ensureBotDirectories(cwd);
  logger.init(cwd);

  // Initialize SQLite database
  const db = DatabaseManager.getInstance(paths.dbFile);
  const store = new DatabaseStore(db);

  if (command === "status") {
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
    process.exit(0);
  }

  if (command === "admin") {
    const port = store.getConfig("web_port", "3000");
    const host = store.getConfig("web_host", "127.0.0.1");
    console.log(`\n\x1b[36mWeb Admin URL: \x1b[4mhttp://${host}:${port}\x1b[0m\n`);
    process.exit(0);
  }

  if (command === "start" || command === "run") {
    let port = parseInt(store.getConfig("web_port", "3000"), 10);
    let host = store.getConfig("web_host", "127.0.0.1");
    let noTerminal = false;

    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--port" && args[i + 1]) {
        port = parseInt(args[i + 1], 10);
      }
      if (args[i] === "--host" && args[i + 1]) {
        host = args[i + 1];
      }
      if (args[i] === "--no-terminal" || args[i] === "--daemon") {
        noTerminal = true;
      }
    }

    logger.info("CLI", `Starting Bot platform at ${cwd} (port: ${port})...`);

    // 2. Load custom skills (工具型 index.ts + 文档型 SKILL.md)
    await loadCustomSkills(cwd);

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

    // 4 & 5. Start Web Server and configured channels in parallel (互不依赖)
    const channelManager = ChannelManager.getInstance();
    // daemon 模式不创建终端 REPL: readline 会试图读取 stdin (banner 噪音 / SIGTTIN 风险)
    const terminalChannel = noTerminal ? undefined : new TerminalChannel();
    if (terminalChannel) channelManager.register(terminalChannel);
    const webServer = new AdminWebServer(port, host);
    await Promise.all([webServer.start(), channelManager.startAll()]);

    // Handle graceful shutdown
    let isShuttingDown = false;
    const cleanup = async () => {
      if (isShuttingDown) return;
      isShuttingDown = true;
      logger.info("CLI", "Shutting down...");
      try {
        await terminalChannel?.stop();
      } catch {}
      try {
        await Promise.race([
          Promise.all([channelManager.stopAll(), webServer.stop()]),
          new Promise((r) => setTimeout(r, 800)),
        ]);
      } catch {}
      // 会话库 WAL checkpoint (pi-durable storage close), 尽量在进程退出前收敛
      try {
        await Promise.race([
          AgentManager.getInstance().shutdown(),
          new Promise((r) => setTimeout(r, 500)),
        ]);
      } catch {}
      SchedulerManager.getInstance().stop();
      NotificationDispatcher.getInstance().stop();
      // MCP stdio 子进程回收
      try {
        await Promise.race([
          McpBridge.getInstance().closeAll(),
          new Promise((r) => setTimeout(r, 500)),
        ]);
      } catch {}
      try {
        db.close();
      } catch {}
      process.exit(0);
    };

    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);

    if (noTerminal) {
      logger.info("CLI", "Daemon mode enabled. Running in background...");
      // Keep process alive
      await new Promise(() => {});
    } else if (terminalChannel) {
      // Start interactive terminal channel
      await terminalChannel.start();
    }
  } else {
    console.log("Usage: bot [start|status|admin] [--port <number>] [--host <address>] [--no-terminal]");
    process.exit(1);
  }
}

main().catch((err) => {
  logger.error("CLI", "Fatal startup error:", err);
  process.exit(1);
});
