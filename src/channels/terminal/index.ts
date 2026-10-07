import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { DatabaseStore } from "../../config/database-store.ts";
import { tryCommand } from "../../core/chat-orchestrator.ts";
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
    const op = cmd.split(/\s+/)[0].toLowerCase();

    // 本地命令双表分治 (设计 §4.3): 只影响本进程, 不经注册表
    if (op === "/exit" || op === "/quit") {
      console.log("Exiting Bot console...");
      this.running = false;
      // 走全局 cleanup (storage checkpoint / channel stop / db.close), 不硬退
      process.kill(process.pid, "SIGTERM");
      return;
    }
    // 本地可观测面板 (三期特性: 进程内 totals + renderStatusPanel)——
    // 保留终端特色; 其余 /status 语义由注册表统一
    if (op === "/status") {
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
      return;
    }

    // 统一命令层 (四期 R1 评审 B9: REPL 不再有私有命令表——/reset /compact
    // /agent /tasks /cancel /help 与 IM/Web/TUI 同一注册表、同一 busy 语义;
    // /agent 按设计 F5 修正为视图语义, 不再写 terminal-main 渠道绑定)
    const outcome = await tryCommand({
      channel: "terminal",
      channelInstanceId: this.id,
      peerId: "local-user",
      agentId: this.activeAgentId,
      sessionId: `${this.id}:local-user`,
      input: cmd,
    });
    if (outcome.handled) {
      // /agent <id> 的视图切换 (R2 评审 N2: REPL 的 activeAgentId 就是
      // 客户端视图——必须消费 switchTo, 否则命令谎报成功而实际不生效)
      const target = (outcome.result?.data as { switchTo?: string } | undefined)?.switchTo;
      if (target) {
        this.activeAgentId = target;
        this.totals = createTotals(); // 统计随 agent 切换重置
        this.cachedModelId = "?";
      }
      if (outcome.result?.content) console.log(outcome.result.content);
      return;
    }
    // 未知斜杠保留旧自由: 打印帮助而非送 LLM
    this.printHelp();
  }

  private printHelp(): void {
    console.log("\n\x1b[1mAvailable Commands:\x1b[0m");
    console.log("  /agent           - 列出所有已配置的 Agent (绑定在管理台「渠道」页修改)");
    console.log("  /reset           - 重置当前 Agent 的对话上下文 (/new 别名)");
    console.log("  /compact         - 压缩当前对话历史 (释放 Token)");
    console.log("  /tasks           - 列出本 Agent 的定时任务");
    console.log("  /cancel          - 中断当前正在进行的生成");
    console.log("  /status          - 查看运行状态与可观测统计 (token/缓存/上下文)");
    console.log("  /admin           - 查看管理后台 Web 访问地址");
    console.log("  /exit            - 退出终端\n");
    console.log("  提示: prompt 中实时显示上下文占用 (ctx %), 每轮回复后显示");
    console.log("  ↑输入 ↓输出 R缓存读 W缓存写 CH命中率 $花费 与耗时。\n");
  }
}
