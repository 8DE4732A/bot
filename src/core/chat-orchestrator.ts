import { ChannelManager } from "../channels/manager.ts";
import { setSlashFastPath } from "../channels/runtime/dispatch.ts";
import { DatabaseStore } from "../config/database-store.ts";
import { clearQueuedForSession, isDraining } from "../gateway/lifecycle.ts";
import { AgentManager } from "./agent-manager.ts";
import {
  commandRouter,
  type CommandChannel,
  type CommandContext,
  type CommandResult,
  type ParsedCommand,
} from "./commands.ts";
import { logger } from "../utils/logger.ts";

/**
 * ChatOrchestrator (四期 M0, 设计 §5.2): 统一入站入口。
 * - IM 渠道: 注册为 InboundPipeline 的 slash fast path (dedupe 后、媒体/防抖前);
 *   回复经 deliverOutbound 既有链路 (markdown 降级/分段/被动回复优先全部免费复用);
 * - Web / TUI: /api/chat (及后续 WS dispatch) 先过命令层再进 AgentManager.chat,
 *   修复 F3 (IM /status 直达 LLM) 的同时把 Web 从"绕过 ChannelManager 直连
 *   AgentManager"的旁路上拉回。
 */

export interface CommandInvocationInput {
  channel: CommandChannel;
  channelInstanceId: string;
  peerId: string;
  agentId: string;
  sessionId: string;
  /** 用户原始输入 (含斜杠) */
  input: string;
}

export interface CommandOutcome {
  /** true = 输入被命令层消费 (调用方不应再送 LLM) */
  handled: boolean;
  result?: CommandResult;
}

/**
 * 执行一次命令尝试。语义约定:
 * - 非命令输入: handled=false, 落回正常对话链路;
 * - 未知命令: terminal 返回 handled=false (终端保留未知斜杠当普通文本的自由),
 *   IM/Web/TUI fail-closed——显式回复"未知命令", 绝不送 LLM (LLM 会发明工具调用);
 * - busy: 按 busyPolicy——dispatch 放行 (读类命令), reject 提示稍后再试,
 *   interrupt-then-dispatch 先 abort 在飞生成 (截断类操作等生成完是浪费)。
 */
export async function tryCommand(inv: CommandInvocationInput): Promise<CommandOutcome> {
  // drain 统一闸 (R2 评审 B4: 单点覆盖 WS command.exec/prompt.submit 命令
  // 分支、IM slash fast path、terminal REPL、Web handleChatInbound——此前
  // 只拦了部分入口, /reset /cancel 等截断类命令会破坏"等在飞 turn 交付")
  if (isDraining()) {
    return {
      handled: true,
      result: { ok: false, content: "gateway 正在重启 (draining), 命令暂不受理; 请稍后重试" },
    };
  }
  const parsed = commandRouter.parse(inv.input);
  if (parsed.kind === "not-command") {
    return { handled: false };
  }
  if (parsed.kind === "unknown") {
    if (inv.channel === "terminal") return { handled: false };
    return {
      handled: true,
      result: {
        ok: false,
        content: `未知命令 /${parsed.name}。发送 /help 查看可用命令。`,
      },
    };
  }

  const agentManager = AgentManager.getInstance();
  const busy = agentManager.isBusy(inv.agentId, inv.sessionId);
  if (busy) {
    const policy = parsed.def.busyPolicy ?? "reject";
    if (policy === "reject") {
      return {
        handled: true,
        result: {
          ok: false,
          content: "当前正在生成回复, 请稍候再试 (可用 /cancel 中断)。",
        },
      };
    }
    if (policy === "interrupt-then-dispatch") {
      // 先中断在飞生成: 会话锁随生成失败/返回释放, handler 里的截断操作即刻生效
      await agentManager.abortSession(inv.agentId, inv.sessionId);
    }
  }

  const ctx: CommandContext = {
    agentId: inv.agentId,
    sessionId: inv.sessionId,
    channel: inv.channel,
    channelInstanceId: inv.channelInstanceId,
    peerId: inv.peerId,
    args: parsed.args,
    rest: parsed.rest,
  };
  const result = await commandRouter.execute(parsed.def, ctx);
  return { handled: true, result };
}

/** IM 渠道绑定解析 (校验收敛到 DatabaseStore.resolveBoundAgent, R8 simplify) */
function resolveImAgent(channelInstanceId: string): { agentId: string } | { error: string } {
  return new DatabaseStore().resolveBoundAgent(channelInstanceId);
}

/**
 * InboundPipeline 的 slash fast path (经 setSlashFastPath 接线):
 * 处理成功或产出显式回复均返回 true; 非命令返回 false 落回常规链路。
 */
export async function handleInboundCommand(message: InboundMessageLike, content: string): Promise<boolean> {
  const bound = resolveImAgent(message.channelInstanceId);
  const manager = ChannelManager.getInstance();
  const deliver = (text: string) =>
    manager
      .deliverOutbound(message.channelInstanceId, message.peerId, text, message.replyContext)
      .catch((err) => {
        logger.warn("ChatOrchestrator", `Command reply delivery failed for ${message.channelInstanceId}:${message.peerId}: ${err}`);
        return false;
      });

  if ("error" in bound) {
    // 渠道绑定坏了时命令也不该静默——但更不该把绑定错误伪装成命令结果,
    // 交给常规链路抛出统一错误 (dispatchInbound 的既有校验)
    return false;
  }

  const outcome = await tryCommand({
    channel: "im",
    channelInstanceId: message.channelInstanceId,
    peerId: message.peerId,
    agentId: bound.agentId,
    sessionId: `${message.channelInstanceId}:${message.peerId}`,
    input: content,
  });

  if (!outcome.handled) return false;
  const text = outcome.result?.content;
  if (text) await deliver(text);
  return true;
}

/** Web/TUI 入站 (设计 §5.2): 命令层优先, 未命中走 AgentManager.chat */
export async function handleChatInbound(opts: {
  channel: CommandChannel;
  channelInstanceId: string;
  peerId: string;
  agentId: string;
  sessionId: string;
  message: string;
  onChunk?: (chunk: { delta?: string }) => void;
}): Promise<{ handled: boolean; reply?: string; data?: unknown }> {
  // drain 统一闸 (非命令输入的拒绝路径; 命令路径由 tryCommand 内的闸覆盖)
  if (isDraining()) {
    return { handled: true, reply: "gateway 正在重启 (draining), 暂不接受新消息; 请稍后重发" };
  }
  const outcome = await tryCommand({
    channel: opts.channel,
    channelInstanceId: opts.channelInstanceId,
    peerId: opts.peerId,
    agentId: opts.agentId,
    sessionId: opts.sessionId,
    input: opts.message,
  });
  if (!outcome.handled) {
    const reply = await AgentManager.getInstance().chat(opts.agentId, opts.sessionId, opts.message, opts.onChunk as any);
    return { handled: false, reply };
  }
  const reply = outcome.result?.content ?? (outcome.result?.ok ? "(完成)" : "(命令执行失败)");
  return { handled: true, reply, data: outcome.result?.data };
}

/** 启动接线: 注册 IM 管道 fast path (cli/server 启动时调用) */
export function initCommandRouting(): void {
  setSlashFastPath(handleInboundCommand);
  logger.debug("ChatOrchestrator", "Slash command routing initialized");
}

type InboundMessageLike = {
  channelInstanceId: string;
  peerId: string;
  replyContext?: unknown;
};
