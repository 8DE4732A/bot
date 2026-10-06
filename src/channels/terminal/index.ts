import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { DatabaseStore } from "../../config/database-store.ts";
import { AgentManager } from "../../core/agent-manager.ts";
import { logger } from "../../utils/logger.ts";
import type { ChannelAdapter } from "../base.ts";
import { ChannelManager } from "../manager.ts";
import {
  addTurn,
  buildPrompt,
  createTotals,
  renderStatusPanel,
  renderTurnStats,
} from "./stats.ts";

export class TerminalChannel implements ChannelAdapter {
  readonly id = "terminal-main";
  readonly type = "terminal" as const;
  readonly name = "本地终端交互通道";

  private running = false;
  private rl?: readline.Interface;
  private activeAgentId = "agent-default";
  private store = new DatabaseStore();
  /** 会话可观测累计 (进程生命周期内, 随 /agent 切换重置) */
  private totals = createTotals();
  /** 当前 Agent 的 modelId 缓存 (prompt 每次渲染都用, 避免逐次查库; /agent 切换时刷新) */
  private cachedModelId = "?";

  public async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Load initial bound agent
    const cfg = this.store.getChannel(this.id);
    if (cfg?.boundAgentId) {
      this.activeAgentId = cfg.boundAgentId;
    }

    this.printBanner();
    this.startLoop();
  }

  public async stop(): Promise<void> {
    this.running = false;
    if (this.rl) {
      this.rl.close();
      this.rl = undefined;
    }
  }

  /**
   * 主动推送 (平台通知: 定时任务结果等): REPL 等待输入时也能送达。
   * 输出后重绘 prompt, 避免通知文本与输入行交叠。
   */
  public async sendMessage(peerId: string, content: string): Promise<void> {
    const lines = content.split("\n").join("\n  ");
    process.stdout.write(`\n\x1b[36m┌─\x1b[0m \x1b[1m📢 平台通知\x1b[0m\x1b[90m (${peerId})\x1b[0m\n  ${lines}\n\x1b[36m└─\x1b[0m\n`);
    if (this.rl) {
      // 通知插在 prompt 之上; 重绘后用户输入行不受影响
      this.rl.prompt(true);
    }
  }

  private printBanner(): void {
    const agent = this.store.getAgent(this.activeAgentId);
    const webHost = this.store.getConfig("web_host", "127.0.0.1");
    const webPort = this.store.getConfig("web_port", "3000");

    console.log("\n\x1b[36m┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓\x1b[0m");
    console.log("\x1b[36m┃\x1b[0m  🤖 \x1b[1mBot Agent Console\x1b[0m (轻量级多 Agent 终端)         \x1b[36m┃\x1b[0m");
    console.log(`\x1b[36m┃\x1b[0m  当前 Agent: \x1b[33m${agent?.name || "默认助手"} [${this.activeAgentId}]\x1b[0m`);
    console.log(`\x1b[36m┃\x1b[0m  生效模型:   \x1b[35m${agent?.model.provider}/${agent?.model.modelId}\x1b[0m`);
    console.log(`\x1b[36m┃\x1b[0m  管理后台:   \x1b[4mhttp://${webHost}:${webPort}\x1b[0m`);
    console.log("\x1b[36m┃\x1b[0m  可用命令:   /agent, /reset, /compact, /status, /exit   \x1b[36m┃\x1b[0m");
    console.log("\x1b[36m┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛\x1b[0m\n");
  }

  private async startLoop(): Promise<void> {
    this.rl = readline.createInterface({ input, output });

    this.rl.on("SIGINT", () => {
      this.running = false;
      console.log("\n已接收中断信号，正在退出 Bot 控制台...");
      // 交给 CLI 的全局 cleanup (storage checkpoint / channel stop / db.close) 完成退出
      process.kill(process.pid, "SIGTERM");
    });

    this.rl.on("close", () => {
      this.running = false;
    });

    while (this.running) {
      try {
        const prompt = buildPrompt(this.activeAgentId, this.currentModelId(), this.totals);
        const line = await this.rl.question(prompt);
        if (line === null || line === undefined) {
          this.running = false;
          break;
        }

        const trimmed = line.trim();
        if (!trimmed) continue;

        if (trimmed.startsWith("/")) {
          await this.handleCommand(trimmed);
          continue;
        }

        // Process message through ChannelManager
        process.stdout.write("\x1b[32mAgent: \x1b[0m");
        let hasStreamed = false;
        let turnUsageLine: string | undefined;

        const answer = await ChannelManager.getInstance().dispatchInbound(
          {
            channelInstanceId: this.id,
            peerId: "local-user",
            content: trimmed,
          },
          (chunk) => {
            if (chunk.toolCall) {
              process.stdout.write(`\n\x1b[90m  🔧 [Tool: ${chunk.toolCall.name}] ${chunk.toolCall.status}...\x1b[0m\n\x1b[32mAgent: \x1b[0m`);
            }
            if (chunk.delta) {
              process.stdout.write(chunk.delta);
              hasStreamed = true;
            }
            if (chunk.usage) {
              addTurn(this.totals, chunk.usage);
              turnUsageLine = renderTurnStats(chunk.usage);
            }
          },
        );

        if (!hasStreamed && answer) {
          process.stdout.write(answer);
        }
        console.log("\n");
        if (turnUsageLine) {
          console.log(turnUsageLine);
          console.log("");
        }
      } catch (err: any) {
        const msg = String(err?.message || err);
        if (
          !this.running ||
          err?.code === "ERR_USE_AFTER_CLOSE" ||
          msg.includes("readline was closed") ||
          err?.name === "AbortError"
        ) {
          this.running = false;
          break;
        }
        console.error(`\n\x1b[31mError: ${msg}\x1b[0m\n`);
      }
    }
  }

  private currentModelId(): string {
    if (this.cachedModelId === "?") {
      this.cachedModelId = this.store.getAgent(this.activeAgentId)?.model.modelId ?? "?";
    }
    return this.cachedModelId;
  }

  private async handleCommand(cmd: string): Promise<void> {
    const parts = cmd.split(/\s+/);
    const op = parts[0].toLowerCase();

    switch (op) {
      case "/exit":
      case "/quit": {
        console.log("Exiting Bot console...");
        this.running = false;
        // 走全局 cleanup (storage checkpoint / channel stop / db.close), 不硬退
        process.kill(process.pid, "SIGTERM");
        break;
      }
      case "/agent": {
        if (parts.length > 1) {
          const targetId = parts[1];
          const targetAgent = this.store.getAgent(targetId);
          if (!targetAgent) {
            console.log(`\x1b[31mAgent not found: ${targetId}\x1b[0m`);
          } else {
            this.activeAgentId = targetId;
            this.totals = createTotals(); // 统计随 agent 切换重置
            this.cachedModelId = "?";
            const chan = this.store.getChannel(this.id);
            if (chan) {
              chan.boundAgentId = targetId;
              this.store.saveChannel(chan);
            }
            console.log(`\x1b[32mSwitched active agent to: ${targetAgent.name} [${targetId}]\x1b[0m\n`);
          }
        } else {
          const agents = this.store.listAgents();
          console.log("\n\x1b[1mAvailable Agents:\x1b[0m");
          for (const a of agents) {
            const currentTag = a.id === this.activeAgentId ? "\x1b[32m(active)\x1b[0m" : "";
            console.log(`  - \x1b[33m${a.id}\x1b[0m: ${a.name} [${a.model.provider}/${a.model.modelId}] ${currentTag}`);
          }
          console.log(`\nUse \x1b[36m/agent <id>\x1b[0m to switch.\n`);
        }
        break;
      }
      case "/reset": {
        await AgentManager.getInstance().resetSession(this.activeAgentId, `${this.id}:local-user`);
        console.log(`\x1b[32mConversation context for ${this.activeAgentId} has been reset.\x1b[0m\n`);
        break;
      }
      case "/compact": {
        await AgentManager.getInstance().compactSession(this.activeAgentId, `${this.id}:local-user`);
        console.log(`\x1b[32mConversation context for ${this.activeAgentId} has been compacted.\x1b[0m\n`);
        break;
      }
      case "/status": {
        const agent = this.store.getAgent(this.activeAgentId);
        console.log("\n\x1b[1mSystem Status:\x1b[0m");
        console.log(`  Agent ID:      ${this.activeAgentId}`);
        console.log(`  Agent Name:    ${agent?.name}`);
        console.log(`  Model:         ${agent?.model.provider}/${agent?.model.modelId}`);
        console.log(`  Workspace:     ${agent?.workspaceDir}`);
        console.log(`  Sandbox:       ${agent?.sandbox.enabled ? "\x1b[32mEnabled\x1b[0m" : "\x1b[31mDisabled\x1b[0m"}`);
        console.log(`  Skills:        ${agent?.skills.join(", ")}`);
        console.log("");
        console.log(`\x1b[1mSession Usage (本进程内 · ${this.activeAgentId}):\x1b[0m`);
        console.log(renderStatusPanel(
          agent?.name ?? "?",
          this.activeAgentId,
          agent?.model.provider ?? "?",
          agent?.model.modelId ?? "?",
          this.totals,
        ));
        console.log("");
        break;
      }
      case "/admin": {
        const host = this.store.getConfig("web_host", "127.0.0.1");
        const port = this.store.getConfig("web_port", "3000");
        console.log(`\nWeb Admin URL: \x1b[4mhttp://${host}:${port}\x1b[0m\n`);
        break;
      }
      case "/help":
      default: {
        console.log("\n\x1b[1mAvailable Commands:\x1b[0m");
        console.log("  /agent           - 列出所有已配置的 Agent");
        console.log("  /agent <id>      - 切换当前终端绑定的 Agent");
        console.log("  /reset           - 重置当前 Agent 的对话上下文");
        console.log("  /compact         - 压缩当前对话历史 (释放 Token)");
        console.log("  /status          - 查看运行状态与可观测统计 (token/缓存/上下文)");
        console.log("  /admin           - 查看管理后台 Web 访问地址");
        console.log("  /exit            - 退出终端\n");
        console.log("  提示: prompt 中实时显示上下文占用 (ctx %), 每轮回复后显示");
        console.log("  ↑输入 ↓输出 R缓存读 W缓存写 CH命中率 $花费 与耗时。\n");
        break;
      }
    }
  }
}
