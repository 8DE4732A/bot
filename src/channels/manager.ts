import { DatabaseStore } from "../config/database-store.ts";
import { AgentManager, type ChatChunk } from "../core/agent-manager.ts";
import { logger } from "../utils/logger.ts";
import type { ChannelAdapter, InboundMessage } from "./base.ts";
import { createChannelAdapter } from "./factory.ts";

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
   * 主动推送 (定时任务通知等平台事件): 渠道层寻址 (channelInstanceId+peerId),
   * 与会话无关——会话重置不影响通知投递。目标渠道未注册/未启用返回 false。
   */
  public async sendNotification(channelInstanceId: string, peerId: string, content: string): Promise<boolean> {
    const adapter = this.adapters.get(channelInstanceId);
    if (!adapter) return false;
    const config = this.store.getChannel(channelInstanceId);
    if (config && !config.enabled) return false;
    await adapter.sendMessage(peerId, content);
    return true;
  }

  /**
   * 通知兜底: 找该 Agent 绑定的启用渠道实例 (按更新时间取最新)。
   * 用于任务未记录通知目标或目标渠道已不可用的场景。
   */
  public findFallbackChannelForAgent(agentId: string): ChannelAdapter | undefined {
    const bound = this.store
      .listChannels()
      .filter((c) => c.enabled && c.boundAgentId === agentId)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    for (const config of bound) {
      const adapter = this.adapters.get(config.id);
      if (adapter) return adapter;
    }
    return undefined;
  }
}
