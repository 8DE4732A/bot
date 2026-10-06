import { DatabaseStore } from "../config/database-store.ts";
import { AgentManager, type ChatChunk } from "../core/agent-manager.ts";
import { logger } from "../utils/logger.ts";
import type { ChannelAdapter, InboundMessage } from "./base.ts";
import { createChannelAdapter } from "./factory.ts";
import { downgradeMarkdown } from "./runtime/markdown.ts";
import { splitMessage } from "./runtime/segmenter.ts";

/** 多段连发间隔 (防平台风控, 对齐设计 §3.2) */
const SEGMENT_GAP_MS = 300;
/** 单次回复最大段数: 超出截断 (防超长回复灌爆平台风控/配额) */
const MAX_OUTBOUND_SEGMENTS = 10;
/** 截断提示 (UTF-8 字节) */
const TRUNCATION_NOTICE = "\n\n…(内容过长, 已截断)";

function truncateToByteLimit(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
  const buf = Buffer.from(s, "utf8");
  let cut = Math.max(0, maxBytes);
  while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut--;
  return buf.subarray(0, cut).toString("utf8");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ChannelManager {
  private static instance?: ChannelManager;
  private adapters = new Map<string, ChannelAdapter>();
  private store: DatabaseStore;

  constructor() {
    this.store = new DatabaseStore();
  }

  public static getInstance(): ChannelManager {
    if (!ChannelManager.instance) {
      ChannelManager.instance = new ChannelManager();
    }
    return ChannelManager.instance;
  }

  public register(adapter: ChannelAdapter) {
    this.adapters.set(adapter.id, adapter);
    logger.debug("ChannelManager", `Registered adapter: ${adapter.id} (${adapter.name})`);
  }

  public unregister(id: string) {
    this.adapters.delete(id);
  }

  public async startAll(): Promise<void> {
    const channelConfigs = this.store.listChannels();
    for (const config of channelConfigs) {
      if (!config.enabled) continue;

      // 显式注册的优先 (如 CLI 的 terminal); 其余按配置经工厂实例化
      let adapter = this.adapters.get(config.id);
      if (!adapter) {
        if (config.type === "terminal") {
          // terminal 由 CLI 特殊管理 (daemon 模式不创建), 不是配置损坏
          logger.debug("ChannelManager", `Channel '${config.id}' is terminal type; managed by CLI`);
          continue;
        }
        const created = createChannelAdapter(config);
        if (!created) continue; // 未知类型已 warn
        adapter = created;
        this.adapters.set(config.id, adapter);
        logger.info("ChannelManager", `Instantiated adapter from config: ${config.id} (${config.type})`);
      }
      try {
        await adapter.start();
        logger.info("ChannelManager", `Started channel: ${adapter.id}`);
      } catch (err) {
        // 启动失败不留注册 (健康检查/通知寻址都依赖 adapters 表)
        this.adapters.delete(config.id);
        logger.error("ChannelManager", `Failed to start channel ${adapter.id}:`, err);
      }
    }
  }

  public async stopAll(): Promise<void> {
    for (const [id, adapter] of this.adapters.entries()) {
      try {
        await adapter.stop();
        logger.info("ChannelManager", `Stopped channel: ${id}`);
      } catch (err) {
        logger.warn("ChannelManager", `Error stopping channel ${id}: ${err}`);
      }
    }
  }

  public async dispatchInbound(
    message: InboundMessage,
    onChunk?: (chunk: ChatChunk) => void,
  ): Promise<string> {
    const channelConfig = this.store.getChannel(message.channelInstanceId);
    // 停用渠道的 WS/长轮询可能尚未停止 (重启竞态), 入站消息直接拒绝
    if (channelConfig && !channelConfig.enabled) {
      throw new Error(`Channel '${message.channelInstanceId}' is disabled`);
    }
    const agentId = channelConfig?.boundAgentId;
    // 绑定缺失/悬空时显式失败, 静默改投默认 Agent 会造成跨 Agent 上下文串扰
    if (!agentId || !this.store.getAgent(agentId)) {
      throw new Error(
        `Channel '${message.channelInstanceId}' has no valid bound agent; fix the binding before sending messages`,
      );
    }

    logger.debug(
      "ChannelManager",
      `Dispatching inbound message from ${message.channelInstanceId}:${message.peerId} to Agent: ${agentId}`,
    );

    // AgentManager 从 sessionId 首段解析渠道身份并写映射行 (通知寻址用)
    return AgentManager.getInstance().chat(
      agentId,
      `${message.channelInstanceId}:${message.peerId}`,
      message.content,
      onChunk,
    );
  }

  /** 查找已注册 (含 startAll 实例化) 的适配器, 供 webhook 分发等外部入口使用 */
  public getAdapter(id: string): ChannelAdapter | undefined {
    return this.adapters.get(id);
  }

  /**
   * 一体化入站端点 (IM adapter 的管道终点): dispatchInbound 拿到 agent 完整
   * 回复后, 经 deliverOutbound 投回渠道 (markdown 降级 → 分段 → 被动回复优先)。
   */
  public async dispatchAndReply(
    message: InboundMessage,
    onChunk?: (chunk: ChatChunk) => void,
  ): Promise<void> {
    const answer = await this.dispatchInbound(message, onChunk);
    if (answer) {
      await this.deliverOutbound(message.channelInstanceId, message.peerId, answer, message.replyContext);
    }
  }

  /**
   * 出站投递 (设计 §3.2): markdownMode 降级 → maxMessageBytes 分段逐条发 →
   * 有 replyContext 且 adapter 支持被动回复时 sendReply 优先, 超窗/失败回退
   * sendMessage。平台回复窗口差异全部封装在 adapter 内 (sendReply 返回 false)。
   * 返回 false = 渠道未注册或已停用 (调用方走 fallback 或记录失败)。
   */
  public async deliverOutbound(
    channelInstanceId: string,
    peerId: string,
    content: string,
    replyContext?: unknown,
  ): Promise<boolean> {
    const adapter = this.adapters.get(channelInstanceId);
    if (!adapter) return false;
    const config = this.store.getChannel(channelInstanceId);
    if (config && !config.enabled) return false;

    const downgraded = downgradeMarkdown(content, adapter.markdownMode ?? "full");
    let segments = splitMessage(downgraded, adapter.maxMessageBytes);
    if (segments.length > MAX_OUTBOUND_SEGMENTS) {
      // 末段预算内截断并追加提示 (提示+围栏补全都计入预算, 否则末段超上限)
      const noticeBytes = Buffer.byteLength(TRUNCATION_NOTICE, "utf8");
      segments = segments.slice(0, MAX_OUTBOUND_SEGMENTS);
      // 围栏补全预留: 开围栏标记可能长达 6+ 字符 (````/~~~~~~), 预留 8 字节
      const fenceReserve = 8;
      let last = truncateToByteLimit(
        segments[MAX_OUTBOUND_SEGMENTS - 1],
        (adapter.maxMessageBytes ?? Infinity) - noticeBytes - fenceReserve,
      );
      // 截断可能切掉 closing fence: 补段首的开围栏标记 (嵌套代码块时内部
      // 标记不是边界, 只有外层 opening fence 能闭合整段; ````/~~~ 同样支持)
      const openMarker = last.match(/^[ \t]*(`{3,}|~{3,})/m)?.[1];
      if (openMarker && (last.split(openMarker).length - 1) % 2 === 1) {
        last += "\n" + openMarker;
      }
      segments[MAX_OUTBOUND_SEGMENTS - 1] = last + TRUNCATION_NOTICE;
    }
    // 被动回复窗口语义: sendReply 一旦失败 (超窗/拒收) 即对剩余段全部回退
    // 主动发送——不做每段一次注定失败的尝试
    let useReply = replyContext !== undefined && typeof adapter.sendReply === "function";
    for (let i = 0; i < segments.length; i++) {
      if (i > 0) await sleep(SEGMENT_GAP_MS);
      const segment = segments[i];
      if (useReply && adapter.sendReply) {
        const replied = await adapter.sendReply(peerId, segment, replyContext).catch(() => false);
        if (replied) continue;
        useReply = false;
      }
      await adapter.sendMessage(peerId, segment);
    }
    return true;
  }

  /**
   * 主动推送 (定时任务通知等平台事件): 渠道层寻址 (channelInstanceId+peerId),
   * 与会话无关——会话重置不影响通知投递。目标渠道未注册/未启用返回 false。
   * 经 deliverOutbound 复用降级/分段 (无 replyContext, 全走主动发送)。
   */
  public async sendNotification(channelInstanceId: string, peerId: string, content: string): Promise<boolean> {
    return this.deliverOutbound(channelInstanceId, peerId, content);
  }

  /**
   * 通知兜底: 找该 Agent 绑定的启用渠道实例 (按更新时间取最新)。
   * 用于任务未记录通知目标或目标渠道已不可用的场景。
   * filter 可限定候选形态 (如通知兜底仅终端类渠道——IM 渠道无真实 peer)。
   */
  public findFallbackChannelForAgent(
    agentId: string,
    filter?: (adapter: ChannelAdapter) => boolean,
  ): ChannelAdapter | undefined {
    const bound = this.store
      .listChannels()
      .filter((c) => c.enabled && c.boundAgentId === agentId)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    for (const config of bound) {
      const adapter = this.adapters.get(config.id);
      if (adapter && (!filter || filter(adapter))) return adapter;
    }
    return undefined;
  }
}
