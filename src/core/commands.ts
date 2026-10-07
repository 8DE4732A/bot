import { DatabaseStore } from "../config/database-store.ts";
import { AgentManager } from "./agent-manager.ts";
import { doCancel, doReset } from "../gateway/lifecycle.ts";
import { formatTokens } from "../channels/terminal/stats.ts";
import { logger } from "../utils/logger.ts";

/** usage 数值人话格式化 (复用 terminal/stats 的 formatTokens, R8 simplify:
 *  同一 usage 数字在 /status 与终端 footer 口径一致) */
const fmtTokens = (n: number): string => formatTokens(n);

/**
 * 统一 slash command 层 (四期 M0, 设计 §5):
 * CommandDef 注册表是全部渠道命令的单一真相源——终端/IM/Web/TUI 共用
 * 同一套定义、帮助文案与 busy 语义。拦截位置:
 * - IM: InboundPipeline 的 dedupe 之后、媒体/防抖之前的 fast path;
 * - Web/TUI: /api/chat (及 WS dispatch) 统一经 ChatOrchestrator 进入。
 *
 * 健壮性约定 (hermes event.py 同款): /cmd@botname 剥离; 首词含第二个 /
 * 判定为路径形态不拦截; 未识别命令显式回复绝不送 LLM (终端 REPL 例外——
 * 保留未知斜杠当普通文本的自由)。
 */

export type CommandChannel = "terminal" | "tui" | "im" | "web";

export type CommandVisibility = "all" | "terminal-only" | CommandChannel[];

/** busy (生成中) 时命令的语义——每条命令的必答题, 缺省 reject */
export type BusyPolicy = "dispatch" | "reject" | "interrupt-then-dispatch";

export interface CommandContext {
  agentId: string;
  /** 会话键 (channelInstanceId:peerId 或 web-playground:<agentId>) */
  sessionId: string;
  channel: CommandChannel;
  channelInstanceId: string;
  peerId: string;
  /** 分词后的参数 (不含命令名) */
  args: string[];
  /** 命令名之后的原始文本 */
  rest: string;
}

export interface CommandResult {
  ok: boolean;
  /** 渠道回复文本 (IM 走 deliverOutbound 降级/分段链; Web/TUI 直接展示) */
  content?: string;
  /** 结构化数据 (TUI/Web 渲染卡片) */
  data?: unknown;
}

export interface CommandDef {
  /** canonical 名, 不带斜杠, 小写 */
  name: string;
  aliases?: string[];
  description: string;
  category: "Session" | "Info" | "Config" | "Exit";
  argsHint?: string;
  /** 可见渠道: all / terminal-only / 明确枚举 (帮助与菜单只广告可达的命令) */
  visibility: CommandVisibility;
  busyPolicy?: BusyPolicy;
  handler(ctx: CommandContext): Promise<CommandResult>;
}

export type ParsedCommand =
  | { kind: "not-command" }
  | { kind: "unknown"; name: string }
  | { kind: "command"; def: CommandDef; name: string; args: string[]; rest: string };

export class CommandRouter {
  private defs = new Map<string, CommandDef>();
  private aliases = new Map<string, CommandDef>();

  public register(def: CommandDef): void {
    if (this.defs.has(def.name)) {
      throw new Error(`command '/${def.name}' already registered`);
    }
    this.defs.set(def.name, def);
    for (const alias of def.aliases ?? []) {
      this.aliases.set(alias, def);
    }
  }

  public resolve(name: string): CommandDef | undefined {
    return this.defs.get(name) ?? this.aliases.get(name);
  }

  /** 帮助/补全/菜单的可见过滤: 不向将被拒的渠道广告会被拒的命令 */
  public listVisible(channel: CommandChannel): CommandDef[] {
    return [...this.defs.values()].filter((d) => this.isVisible(d, channel));
  }

  public isVisible(def: CommandDef, channel: CommandChannel): boolean {
    if (def.visibility === "all") return true;
    if (def.visibility === "terminal-only") return channel === "terminal";
    return def.visibility.includes(channel);
  }

  /**
   * 命令解析 (设计 §5.2 健壮性):
   * - 首词 @botname 后缀剥离 (Telegram 群 /cmd@mybot);
   * - 首词含第二个 `/` → 路径形态 (/Users/x/file.md), 不拦截;
   * - 首词含合法字符之外的内容 (如 "/1.5" "/你好世界" 中带标点) → 不拦截,
   *   交给 LLM (自然语言里的斜杠引用); 纯中文命令名默认不注册。
   */
  public parse(input: string): ParsedCommand {
    const trimmed = input.trim();
    if (!trimmed.startsWith("/")) return { kind: "not-command" };
    const firstTokenRaw = trimmed.slice(1).split(/\s+/, 1)[0] ?? "";
    if (!firstTokenRaw) return { kind: "not-command" };
    if (firstTokenRaw.includes("/")) return { kind: "not-command" };
    // @botname 剥离 (Telegram 群聊寻址形态)
    const at = firstTokenRaw.indexOf("@");
    const firstToken = at >= 0 ? firstTokenRaw.slice(0, at) : firstTokenRaw;
    if (!firstToken || !/^[A-Za-z0-9_-]+$/.test(firstToken)) return { kind: "not-command" };

    const name = firstToken.toLowerCase();
    const rest = trimmed.slice(1 + firstTokenRaw.length).trim();
    const args = rest ? rest.split(/\s+/) : [];
    const def = this.resolve(name);
    return def ? { kind: "command", def, name, args, rest } : { kind: "unknown", name };
  }

  /** 执行命令: handler 异常收敛为 ok:false 结果 (绝不冒泡到管道/请求层) */
  public async execute(def: CommandDef, ctx: CommandContext): Promise<CommandResult> {
    try {
      return await def.handler(ctx);
    } catch (err) {
      logger.warn("CommandRouter", `Command /${def.name} failed: ${err}`);
      return { ok: false, content: `命令 /${def.name} 执行失败: ${err instanceof Error ? err.message : err}` };
    }
  }
}

/** 全局命令路由单例 (内置命令在模块加载时注册) */
export const commandRouter = new CommandRouter();

// ── 内置命令 ──

const listAgentsText = (currentAgentId: string): string => {
  const store = new DatabaseStore();
  const agents = store.listAgents();
  const lines = agents.map((a) => {
    const cur = a.id === currentAgentId ? "  ← 当前" : "";
    return `  /agent ${a.id}  —  ${a.name} [${a.model.provider}/${a.model.modelId}]${cur}`;
  });
  return ["可用 Agent:", ...lines, "", "渠道绑定的 Agent 请在管理台修改; /agent <id> 仅切换当前视图。"].join("\n");
};

const statusText = (ctx: CommandContext): string => {
  const store = new DatabaseStore();
  const agent = store.getAgent(ctx.agentId);
  if (!agent) return `Agent 不存在: ${ctx.agentId}`;
  const tasks = store.listScheduledTasks().filter((t) => t.agentId === ctx.agentId && !t.deletedAt);
  const activeTasks = tasks.filter((t) => t.enabled).length;
  const lines = [
    `🤖 Agent: ${agent.name} [${agent.id}]`,
    `模型: ${agent.model.provider}/${agent.model.modelId}`,
    `工作区: ${agent.workspaceDir}`,
    `沙盒: ${agent.sandbox?.enabled ? "启用" : "关闭"}`,
    `技能: ${agent.skills.length ? agent.skills.join(", ") : "(无)"}`,
    `会话: ${ctx.sessionId}`,
    `定时任务: ${tasks.length} 个 (${activeTasks} 个启用)`,
  ];

  // 会话上下文信息 (跨轮累计, 进程内; 会话重置即清零——与终端 /stats 同边界)
  const stats = AgentManager.getInstance().getUsageStats(ctx.agentId, ctx.sessionId);
  lines.push("");
  if (!stats) {
    lines.push("会话上下文: 本进程内尚无生成记录 (重启后统计从零开始)");
  } else {
    const ctxPct =
      stats.contextWindow > 0 ? ` · 占窗口 ${Math.min(100, ((stats.contextTokens / stats.contextWindow) * 100)).toFixed(1)}%` : "";
    lines.push(
      `📊 会话上下文 (本进程内累计 · ${stats.turns} 轮):`,
      `  当前上下文: ${fmtTokens(stats.contextTokens)} tok${ctxPct}`,
      `  最近一轮缓存命中率: ${stats.cacheHitRate !== undefined ? `${stats.cacheHitRate.toFixed(1)}%` : "—"}`,
      `  累计消耗: ↑${fmtTokens(stats.totalInput)} ↓${fmtTokens(stats.totalOutput)} · R(缓存读) ${fmtTokens(stats.totalCacheRead)} · W(缓存写) ${fmtTokens(stats.totalCacheWrite)}`,
      `  累计费用: $${stats.totalCost.toFixed(4)} · 最近一轮耗时 ${(stats.lastDurationMs / 1000).toFixed(1)}s`,
    );
  }
  return lines.join("\n");
};

function registerBuiltinCommands(): void {
  commandRouter.register({
    name: "help",
    description: "显示可用命令",
    category: "Info",
    visibility: "all",
    busyPolicy: "dispatch",
    handler: async (ctx) => {
      const visible = commandRouter.listVisible(ctx.channel);
      const byCategory = new Map<string, CommandDef[]>();
      for (const d of visible) {
        const list = byCategory.get(d.category) ?? [];
        list.push(d);
        byCategory.set(d.category, list);
      }
      const lines: string[] = ["可用命令:"];
      for (const [category, defs] of byCategory) {
        lines.push("");
        lines.push(`[${category}]`);
        for (const d of defs) {
          const alias = d.aliases?.length ? ` (/${d.aliases.join(" /")})` : "";
          const hint = d.argsHint ? ` ${d.argsHint}` : "";
          lines.push(`  /${d.name}${hint}${alias}  —  ${d.description}`);
        }
      }
      return { ok: true, content: lines.join("\n") };
    },
  });

  commandRouter.register({
    name: "status",
    description: "查看当前 Agent 与会话状态",
    category: "Info",
    visibility: "all",
    // busy 也放行 (hermes pre-gate 语义): 状态查询不能被生成阻塞
    busyPolicy: "dispatch",
    handler: async (ctx) => ({ ok: true, content: statusText(ctx) }),
  });

  commandRouter.register({
    name: "reset",
    aliases: ["new"],
    description: "重置当前会话上下文",
    category: "Session",
    visibility: "all",
    // 截断类操作: 先中断在飞生成再执行 (上下文已作废, 等生成完是浪费)
    busyPolicy: "interrupt-then-dispatch",
    handler: async (ctx) => {
      // 统一语义单元 (清队列 → abort → reset, R8 simplify 收敛)
      await doReset(ctx.agentId, ctx.sessionId);
      return { ok: true, content: "✅ 会话上下文已重置, 下一条消息从全新对话开始。", data: { reset: true } };
    },
  });

  commandRouter.register({
    name: "compact",
    description: "压缩当前对话历史 (释放 Token)",
    category: "Session",
    visibility: "all",
    busyPolicy: "interrupt-then-dispatch",
    handler: async (ctx) => {
      await AgentManager.getInstance().compactSession(ctx.agentId, ctx.sessionId);
      return { ok: true, content: "✅ 对话历史已压缩。", data: { compacted: true } };
    },
  });

  commandRouter.register({
    name: "agent",
    argsHint: "[id]",
    description: "列出 Agent; 带参数查看/切换当前视图的 Agent",
    category: "Config",
    visibility: "all",
    busyPolicy: "dispatch",
    handler: async (ctx) => {
      if (!ctx.args[0]) {
        return { ok: true, content: listAgentsText(ctx.agentId) };
      }
      const store = new DatabaseStore();
      const target = store.getAgent(ctx.args[0]);
      if (!target) {
        return { ok: false, content: `Agent 不存在: ${ctx.args[0]} (用 /agent 查看列表)` };
      }
      // 语义修正 (四期 F5): 命令只报告/影响客户端视图选择; 渠道级绑定是管理台动作。
      // IM 渠道不接受切换 (绑定在渠道实例上), TUI/Web 的视图切换由客户端自行处理。
      if (ctx.channel === "im") {
        return {
          ok: true,
          content:
            `当前渠道绑定: ${target.id === ctx.agentId ? "即本 Agent" : `${target.name} [${target.id}] (仅查看)`}\n` +
            "IM 渠道的 Agent 绑定请在管理台「渠道」页修改。",
        };
      }
      return { ok: true, data: { switchTo: target.id }, content: `视图 Agent: ${target.name} [${target.id}]` };
    },
  });

  commandRouter.register({
    name: "tasks",
    description: "列出本 Agent 的定时任务",
    category: "Info",
    visibility: "all",
    busyPolicy: "dispatch",
    handler: async (ctx) => {
      const store = new DatabaseStore();
      const tasks = store.listScheduledTasks().filter((t) => t.agentId === ctx.agentId && !t.deletedAt);
      if (tasks.length === 0) {
        return { ok: true, content: "当前 Agent 没有定时任务。对话中说「每天 xx 点帮我做 xx」即可创建。" };
      }
      const lines = tasks.map((t) => {
        const next = t.nextRunAt ? new Date(t.nextRunAt).toLocaleString("zh-CN") : "—";
        const last = t.lastStatus ? `上次: ${t.lastStatus}` : "未运行";
        return `  • ${t.name}${t.enabled ? "" : " (已停用)"} — 下次: ${next} · ${last}`;
      });
      return { ok: true, content: ["⏱ 定时任务:", ...lines].join("\n") };
    },
  });

  commandRouter.register({
    name: "admin",
    description: "查看管理后台访问地址",
    category: "Info",
    visibility: "all",
    busyPolicy: "dispatch",
    handler: async () => {
      const store = new DatabaseStore();
      const host = store.getConfig("web_host", "127.0.0.1");
      const port = store.getConfig("web_port", "3000");
      return { ok: true, content: `管理后台: http://${host}:${port}` };
    },
  });

  commandRouter.register({
    name: "cancel",
    description: "中断当前正在进行的生成",
    category: "Session",
    visibility: "all",
    busyPolicy: "dispatch",
    handler: async (ctx) => {
      // 统一语义单元 (清队列 → abort, R8 simplify 收敛)
      const aborted = await doCancel(ctx.agentId, ctx.sessionId);
      return {
        ok: true,
        content: aborted ? "⛔ 已请求中断当前生成。" : "当前没有正在进行的生成。",
      };
    },
  });
}

registerBuiltinCommands();
