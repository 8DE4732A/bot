import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { DatabaseStore } from "../../config/database-store.ts";
import { AgentManager } from "../../core/agent-manager.ts";
import { logger } from "../../utils/logger.ts";
import type { ChannelAdapter } from "../base.ts";
import { ChannelManager } from "../manager.ts";

export class TerminalChannel implements ChannelAdapter {
  readonly id = "terminal-main";
  readonly type = "terminal" as const;
  readonly name = "本地终端交互通道";

  private running = false;
  private rl?: readline.Interface;
  private activeAgentId = "agent-default";
  private store = new DatabaseStore();

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

  public async sendMessage(peerId: string, content: string): Promise<void> {
    console.log(`\n\x1b[32mAgent:\x1b[0m ${content}\n`);
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
        const prompt = `\x1b[1;34m[${this.activeAgentId}] > \x1b[0m`;
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
          },
        );

        if (!hasStreamed && answer) {
          process.stdout.write(answer);
        }
        console.log("\n");
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
        console.log("  /status          - 查看当前 Agent 运行状态与工作空间");
        console.log("  /admin           - 查看管理后台 Web 访问地址");
        console.log("  /exit            - 退出终端\n");
        break;
      }
    }
  }
}
