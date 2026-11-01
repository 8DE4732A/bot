import { DatabaseStore, type ChannelInstanceConfig } from "../config/database-store.ts";
import { DatabaseManager } from "../database/index.ts";
import { dirname } from "node:path";
import { AgentManager, type ChatChunk } from "../core/agent-manager.ts";
import { EventBus } from "../core/event-bus.ts";
import { isDraining } from "../gateway/lifecycle.ts";
import { logger } from "../utils/logger.ts";
import type { ChannelAdapter, ChannelHealth, InboundMessage, OutboundMedia } from "./base.ts";
import type { ChannelDispatchRuntime, DeliverOutboundOptions } from "./descriptor.ts";
import { getChannelType, createChannelAdapter } from "./registry.ts";
import { downgradeMarkdown } from "./runtime/markdown.ts";
import { clearMediaCache } from "./runtime/media-cache.ts";
import {
  MAX_TOTAL_OUTBOUND_MEDIA_BYTES,
  createOutboundMediaResolver,
  extractMediaMarkers,
} from "./runtime/media-outbound.ts";
import { splitMessage } from "./runtime/segmenter.ts";
import { planVisionInput } from "./runtime/vision-input.ts";
import { resolveModelMetadata } from "../core/model-metadata.ts";

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

interface ChannelStats {
  lastInboundAt?: number;
  lastSendAt?: number;
}

/**
 * 渠道运行时与生命周期单例。
 *
 * - 实现 ChannelDispatchRuntime 并注入 adapter（消除 adapter → manager 循环依赖）
 * - 实例化/热重启/删除/健康检查集中在此处；server 只做 HTTP 参数校验
 * - per-channel 串行锁保证保存、扫码确认、删除互斥
 */
export class ChannelManager implements ChannelDispatchRuntime {
  private static instance?: ChannelManager;
  private adapters = new Map<string, ChannelAdapter>();
  private store: DatabaseStore;
  private locks = new Map<string, Promise<void>>();
  private stats = new Map<string, ChannelStats>();

  constructor() {
    this.store = new DatabaseStore();
  }

  public static getInstance(): ChannelManager {
    if (!ChannelManager.instance) {
      ChannelManager.instance = new ChannelManager();
    }
    return ChannelManager.instance;
  }

  // ── 注册表（测试/CLI 显式注册） ──

  public register(adapter: ChannelAdapter) {
    this.adapters.set(adapter.id, adapter);
    logger.debug("ChannelManager", `Registered adapter: ${adapter.id} (${adapter.name})`);
  }

  public unregister(id: string) {
    this.adapters.delete(id);
  }

  public getAdapter(id: string): ChannelAdapter | undefined {
    return this.adapters.get(id);
  }

  public listAdapters(): ChannelAdapter[] {
    return [...this.adapters.values()];
  }

  // ── 生命周期 ──

  public async startAll(): Promise<void> {
    const configs = this.store.listChannels();
    for (const config of configs) {
      if (!config.enabled) continue;
      try {
        await this.startChannel(config.id);
      } catch (err) {
        // startChannel 已发布 error/审计；启动失败不应阻断其他渠道
        logger.error("ChannelManager", `Failed to start channel ${config.id}:`, err);
      }
    }
  }

  public async stopAll(): Promise<void> {
    for (const [id, adapter] of this.adapters.entries()) {
      try {
        await adapter.stop();
        logger.info("ChannelManager", `Stopped channel: ${id}`);
        this.publishStatus(id, "stopped");
      } catch (err) {
        logger.warn("ChannelManager", `Error stopping channel ${id}: ${err}`);
      }
    }
    this.adapters.clear();
  }

  public async withChannelLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const chain = prev.then(() => gate);
    this.locks.set(id, chain);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      // 清理已完成的链条，避免长期保存的 promise 泄漏
      if (this.locks.get(id) === chain) this.locks.delete(id);
    }
  }

  public async startChannel(id: string): Promise<void> {
    await this.withChannelLock(id, async () => {
      const config = this.store.getChannel(id);
      if (!config) return;
      await this.startChannelUnlocked(config);
    });
  }

  /** 锁内启动（调用方已持锁或处于 startAll 单线程阶段） */
  private async startChannelUnlocked(config: ChannelInstanceConfig): Promise<void> {
    await this.stopChannelUnlocked(config.id);
    if (!config.enabled) return;

    const descriptor = getChannelType(config.type);
    if (descriptor?.managedBy === "cli") {
      // CLI 预注册的实例（terminal）由 manager 负责 start，CLI 随后再 start 是幂等的
      const existing = this.adapters.get(config.id);
      if (!existing) return; // daemon 模式没有交互终端，跳过是正确的
      try {
        await existing.start();
        this.publishStatus(config.id, "started");
      } catch (err) {
        logger.error("ChannelManager", `Failed to start CLI-managed channel ${config.id}:`, err);
        this.publishStatus(config.id, "error", String(err));
        throw err;
      }
      return;
    }

    let adapter: ChannelAdapter | null;
    try {
      // registry 负责 unknown / managedBy=cli / 无 create 的判定并记录日志
      adapter = createChannelAdapter(config, { runtime: this });
    } catch (err) {
      logger.error("ChannelManager", `Failed to construct channel ${config.id}:`, err);
      this.publishStatus(config.id, "error", String(err));
      throw err;
    }
    if (!adapter) return;
    this.adapters.set(config.id, adapter);
    try {
      await adapter.start();
      logger.info("ChannelManager", `Started channel: ${adapter.id}`);
      this.publishStatus(adapter.id, "started");
    } catch (err) {
      // 启动失败不留注册 (健康检查/通知寻址都依赖 adapters 表)，并尽量回收半启动资源
      this.adapters.delete(config.id);
      await adapter.stop().catch(() => {});
      logger.error("ChannelManager", `Failed to start channel ${adapter.id}:`, err);
      this.publishStatus(adapter.id, "error", String(err));
      throw err;
    }
  }

  public async stopChannel(id: string): Promise<void> {
    await this.withChannelLock(id, () => this.stopChannelUnlocked(id));
  }

  private async stopChannelUnlocked(id: string): Promise<void> {
    const adapter = this.adapters.get(id);
    if (!adapter) return;
    const descriptor = getChannelType(adapter.type);
    if (descriptor?.managedBy === "cli") return;
    try {
      await adapter.stop();
    } catch (err) {
      logger.warn("ChannelManager", `Error stopping channel ${id}: ${err}`);
    }
    this.adapters.delete(id);
    this.publishStatus(id, "stopped");
  }

  public async restartChannel(id: string): Promise<void> {
    await this.withChannelLock(id, () => this.restartChannelLocked(id));
  }

  /** 调用方必须已持有该渠道锁（QR 确认/保存等复合流程） */
  public async restartChannelLocked(id: string): Promise<void> {
    const config = this.store.getChannel(id);
    if (!config) return;
    await this.startChannelUnlocked(config);
  }

  /**
   * 锁内重读 → 生成最终配置 → 落库 → 按 enabled 启动/停止。
   * build 返回 null = 放弃本次保存（渠道已删除等）。
   */
  public async saveAndRestart(
    id: string,
    build: (fresh: ChannelInstanceConfig | undefined) => ChannelInstanceConfig | null,
  ): Promise<void> {
    await this.withChannelLock(id, async () => {
      const fresh = this.store.getChannel(id);
      const next = build(fresh);
      if (!next) return;
      if (fresh && next.type !== fresh.type) {
        throw new Error(`channel '${id}' type cannot be changed (${fresh.type} → ${next.type})`);
      }
      this.store.saveChannel(next);
      if (fresh) {
        try {
          // 凭据落库后、启动前执行清理（账号切换等），启动失败也不漏清理
          await getChannelType(next.type)?.onCredentialsChanged?.(fresh, next.credentials);
        } catch (err) {
          logger.warn("ChannelManager", `Channel '${id}' credential cleanup failed: ${err}`);
        }
      }
      await this.startChannelUnlocked(next);
    });
  }

  public async deleteChannel(id: string): Promise<void> {
    await this.withChannelLock(id, async () => {
      const config = this.store.getChannel(id);
      if (!config) return;
      const descriptor = getChannelType(config.type);
      if (descriptor?.managedBy === "cli" || descriptor?.deletable === false) {
        throw new Error(`channel type '${config.type}' cannot be deleted via API`);
      }
      await this.stopChannelUnlocked(id);
      await clearMediaCache(id);
      try {
        await descriptor?.onDelete?.(config);
      } catch (err) {
        logger.warn("ChannelManager", `Channel '${id}' cleanup failed: ${err}`);
      }
      this.store.deleteChannel(id);
      this.stats.delete(id);
      this.store.recordAudit("channel.deleted", { channelId: id });
    });
  }

  public async getHealth(id: string): Promise<ChannelHealth> {
    const config = this.store.getChannel(id);
    if (!config) return { ok: false, detail: `channel '${id}' not found` };
    const descriptor = getChannelType(config.type);
    const adapter = this.adapters.get(id);
    let base: ChannelHealth;
    if (descriptor?.managedBy === "cli") {
      // CLI 托管渠道无远端连接；daemon 模式下未 attach 也不应显示异常
      base = {
        ok: true,
        detail: adapter ? descriptor.label : `${descriptor.label} (not attached in daemon mode)`,
      };
    } else if (!adapter) {
      base = { ok: false, detail: "not running (启动失败或已停止)" };
    } else if (adapter.healthCheck) {
      try {
        base = await adapter.healthCheck();
      } catch (err) {
        base = { ok: false, detail: String(err) };
      }
    } else {
      base = { ok: false, detail: "unknown (no health check implemented)" };
    }
    const stats = this.stats.get(id) ?? {};
    return {
      ...base,
      lastInboundAt: base.lastInboundAt ?? stats.lastInboundAt,
      lastSendAt: base.lastSendAt ?? stats.lastSendAt,
    };
  }

  private publishStatus(id: string, state: "started" | "stopped" | "error", detail?: string): void {
    EventBus.getInstance().publish({
      type: "channel.status",
      channelId: id,
      state,
      ...(detail ? { detail } : {}),
    });
  }

  // ── 入站派发 (ChannelDispatchRuntime) ──

  public async dispatchInbound(
    message: InboundMessage,
    onChunk?: (chunk: ChatChunk) => void,
  ): Promise<string> {
    // drain 协议 (四期 §3.4): 重启在即时拒绝新任务——在飞 turn 保持运行
    if (isDraining()) {
      throw new Error("gateway 正在重启 (draining), 暂不接受新消息; 请稍后重发");
    }
    this.stats.set(message.channelInstanceId, {
      ...this.stats.get(message.channelInstanceId),
      lastInboundAt: message.receivedAt ?? Date.now(),
    });

    const bound = this.store.resolveBoundAgent(message.channelInstanceId);
    if ("error" in bound) {
      throw new Error(bound.error);
    }
    const agentId = bound.agentId;

    logger.debug(
      "ChannelManager",
      `Dispatching inbound message from ${message.channelInstanceId}:${message.peerId} to Agent: ${agentId}`,
    );

    // 图片输入能力分流：支持视觉的模型直接附加图片；明确不支持的模型
    // 不调用 LLM 直接回复；目录 fallback（模态未知）保留路径引用让模型 read。
    const agent = this.store.getAgent(agentId);
    const provider = agent ? this.store.getModelProvider(agent.model.provider) : undefined;
    const metadata = agent && provider ? resolveModelMetadata(provider, agent.model.modelId, this.store) : undefined;
    const visionPlan = await planVisionInput(
      message.content,
      message.attachments,
      agent && metadata
        ? {
            provider: agent.model.provider,
            modelId: agent.model.modelId,
            inputModalities: metadata.inputModalities,
            known: metadata.source !== "fallback",
          }
        : undefined,
    );
    if (visionPlan.mode === "reject") {
      this.store.recordAudit("channel.image_unsupported", {
        agentId,
        model: agent ? `${agent.model.provider}/${agent.model.modelId}` : undefined,
        images: (message.attachments ?? []).filter((attachment) => attachment.kind === "image").length,
      });
      logger.info("ChannelManager", `Rejected image input for agent ${agentId}: unsupported model`);
      return visionPlan.message;
    }

    return AgentManager.getInstance().chat(
      agentId,
      `${message.channelInstanceId}:${message.peerId}`,
      visionPlan.text,
      onChunk,
      {
        ...(visionPlan.mode === "attach" ? { userContent: visionPlan.content } : {}),
        messageTime: message.receivedAt ?? Date.now(),
      },
    );
  }

  public async dispatchAndReply(
    message: InboundMessage,
    onChunk?: (chunk: ChatChunk) => void,
  ): Promise<void> {
    const answer = await this.dispatchInbound(message, onChunk);
    if (answer) {
      await this.deliverOutbound(
        message.channelInstanceId,
        message.peerId,
        answer,
        message.replyContext,
      );
    }
  }

  // ── 出站投递 ──

  /**
   * 出站投递 (设计 §3.2): formatOutbound → markdown 降级 → maxMessageBytes 分段 →
   * 有 replyContext 且 adapter 支持被动回复时 sendReply 优先, 超窗/失败回退
   * sendMessage。平台回复窗口差异全部封装在 adapter 内 (sendReply 返回 false)。
   * 返回 false = 渠道未注册或已停用 (调用方走 fallback 或记录失败)。
   */
  public async deliverOutbound(
    channelInstanceId: string,
    peerId: string,
    content: string,
    replyContext?: unknown,
    options?: DeliverOutboundOptions,
  ): Promise<boolean> {
    const adapter = this.adapters.get(channelInstanceId);
    if (!adapter) return false;
    const config = this.store.getChannel(channelInstanceId);
    if (config && !config.enabled) return false;

    // 出站媒体：只有声明了 sendMedia 的渠道才解析 MEDIA: 标记；
    // 主动通知可显式 allowMedia=false（默认仍允许，路径校验不放宽）
    let text = content;
    const media: OutboundMedia[] = [];
    const rejected: string[] = [];
    if (adapter.sendMedia && options?.allowMedia !== false) {
      const { text: stripped, refs } = extractMediaMarkers(content);
      text = stripped;
      if (refs.length > 0) {
        const agentId = options?.agentId ?? config?.boundAgentId;
        const workspaceDir = agentId ? this.store.getAgent(agentId)?.workspaceDir : undefined;
        if (!workspaceDir) {
          rejected.push(...refs.map(() => "渠道未绑定 Agent，无法校验媒体路径"));
        } else {
          const dotBotDir = dirname(DatabaseManager.getInstance().dbPath);
          try {
            const budget = { remaining: MAX_TOTAL_OUTBOUND_MEDIA_BYTES };
            const resolve = createOutboundMediaResolver({ workspaceDir, dotBotDir, budget });
            for (const ref of refs) {
              try {
                media.push(await resolve(ref));
              } catch (err) {
                const reason = err instanceof Error ? err.message : String(err);
                logger.warn("ChannelManager", `Rejected outbound media (${channelInstanceId}): ${reason}`);
                this.store.recordAudit("channel.media_rejected", {
                  channelId: channelInstanceId,
                  reason,
                });
                rejected.push("附件未发送（路径不在 Agent 工作区内或文件不合法）");
              }
            }
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            logger.warn("ChannelManager", `Cannot resolve agent workspace for media: ${reason}`);
            rejected.push("附件未发送（Agent 工作区不可用）");
          }
        }
      }
    }
    if (rejected.length > 0) {
      const notice = [...new Set(rejected)].join("\n");
      text = text ? `${text}\n\n${notice}` : notice;
    }

    const formatted = adapter.formatOutbound ? adapter.formatOutbound(text) : text;
    const downgraded = downgradeMarkdown(formatted, adapter.markdownMode ?? "full");
    let segments = downgraded.trim() ? splitMessage(downgraded, adapter.maxMessageBytes) : [];
    if (segments.length > MAX_OUTBOUND_SEGMENTS) {
      const noticeBytes = Buffer.byteLength(TRUNCATION_NOTICE, "utf8");
      segments = segments.slice(0, MAX_OUTBOUND_SEGMENTS);
      const fenceReserve = 8;
      let last = truncateToByteLimit(
        segments[MAX_OUTBOUND_SEGMENTS - 1],
        (adapter.maxMessageBytes ?? Infinity) - noticeBytes - fenceReserve,
      );
      const openMarker = last.match(/^[ \t]*(`{3,}|~{3,})/m)?.[1];
      if (openMarker && (last.split(openMarker).length - 1) % 2 === 1) {
        last += "\n" + openMarker;
      }
      segments[MAX_OUTBOUND_SEGMENTS - 1] = last + TRUNCATION_NOTICE;
    }
    // 被动回复窗口语义: sendReply 一旦失败 (超窗/拒收) 即对剩余段全部回退
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

    // 媒体在文本之后发送；单个失败不回滚已送达的文本
    let mediaSent = 0;
    let noticeSent = false;
    if (media.length > 0 && adapter.sendMedia) {
      let failed = 0;
      for (const item of media) {
        const ok = await adapter
          .sendMedia(peerId, item, replyContext)
          .catch((err) => {
            logger.warn("ChannelManager", `sendMedia failed (${channelInstanceId}): ${err}`);
            return false;
          });
        if (ok) mediaSent++;
        else failed++;
      }
      if (failed > 0) {
        // 有正文时也必须告知附件失败，不能让用户以为文件已送达
        this.store.recordAudit("channel.media_send_failed", {
          channelId: channelInstanceId,
          failed,
        });
        noticeSent = await adapter
          .sendMessage(peerId, `附件发送失败（${failed} 个）`)
          .then(() => true)
          .catch(() => false);
      }
    }

    if (segments.length > 0 || media.length > 0) {
      this.stats.set(channelInstanceId, {
        ...this.stats.get(channelInstanceId),
        lastSendAt: Date.now(),
      });
    }
    return segments.length > 0 || mediaSent > 0 || noticeSent;
  }

  /**
   * 主动推送 (定时任务通知等平台事件): 渠道层寻址 (channelInstanceId+peerId),
   * 与会话无关——会话重置不影响通知投递。目标渠道未注册/未启用返回 false。
   */
  public async sendNotification(
    channelInstanceId: string,
    peerId: string,
    content: string,
    options?: DeliverOutboundOptions,
  ): Promise<boolean> {
    return this.deliverOutbound(channelInstanceId, peerId, content, undefined, options);
  }

  /**
   * 通知兜底: 找该 Agent 绑定的启用渠道实例 (按更新时间取最新)。
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
