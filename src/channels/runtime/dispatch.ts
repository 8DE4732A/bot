import { DatabaseStore } from "../../config/database-store.ts";
import { logger } from "../../utils/logger.ts";
import type { InboundMessage } from "../base.ts";
import { MessageDeduplicator } from "./dedupe.ts";
import { downloadMedia } from "./media-cache.ts";
import { LoopGuard } from "./loop-guard.ts";
import { MessageCoalescer } from "./coalesce.ts";

export interface InboundPipelineOptions {
  channelId: string;
  /** 管道终点: 渠道管理器的 dispatchAndReply */
  dispatch: (msg: InboundMessage) => Promise<void>;
  /** 处理期间 typing 心跳; 返回停止函数 (回复落地/失败时调用) */
  startTyping?: (peerId: string) => () => void;
  /** 是否启用防抖合并 (终端等直连渠道关闭) */
  enableCoalesce?: boolean;
  coalesceQuietMs?: number;
  loopGuard?: { windowMs?: number; maxEvents?: number };
}

/**
 * slash 命令 fast path (四期 M0, 设计 §5.2): 由 ChatOrchestrator 注册。
 * 拦截位置在 dedupe/访问策略/限流之后、媒体下载与防抖之前——命令必须即时
 * 响应, 不能被 5s 防抖合并, 更不能等媒体下载。返回 true = 已处理 (回复已投递)。
 */
export type SlashFastPath = (message: InboundMessage, content: string) => Promise<boolean>;

let slashFastPath: SlashFastPath | undefined;

/** 函数注入而非 import: dispatch 处于 manager→factory→adapters 的依赖下游,
 * 反向 import 会成环; 由 cli/server 启动时调 initCommandRouting() 接线。 */
export function setSlashFastPath(fn: SlashFastPath | undefined): void {
  slashFastPath = fn;
}

/**
 * 统一入站管道 (M0 渠道运行时): 去重 → 访问策略 → 媒体入站下载 →
 * 防抖合并 → (派发时) 防自循环熔断 → dispatch。每个渠道 adapter 一个实例。
 * 管道内一切失败只记录不抛出——adapter 的平台事件回调绝不能被网关侧错误杀死。
 *
 * 计数语义: loop-guard 统计的是**派发次数** (防抖后), 不是入站事件数——
 * 用户连发 9 条短消息会被防抖合并为 1 次派发, 不应触发熔断。
 */
export class InboundPipeline {
  private readonly dedupe = new MessageDeduplicator();
  private readonly loopGuard: LoopGuard;
  private readonly coalescer?: MessageCoalescer<string, InboundMessage>;
  private readonly store = new DatabaseStore();
  /** pre-coalesce 限流: 入站事件滑动窗 (per-peer)——防抖前的洪水第一道闸 */
  private inboundEvents = new Map<string, number[]>();
  private lastRateSweep = 0;

  constructor(private readonly options: InboundPipelineOptions) {
    this.loopGuard = new LoopGuard(options.loopGuard);
    if (options.enableCoalesce !== false) {
      this.coalescer = new MessageCoalescer<string, InboundMessage>(
        {
          quietMs: options.coalesceQuietMs,
          // 合并组元数据归并: replyContext/凭据取最新 (新者为准), 附件做并集
          // (用户先发图后发字 → 合并派发两张信息都带到)
          metaMerge: (prev, next) => ({
            ...next,
            // 附件并集有上限 (配合入站限流防洪水撑大合并组)
            attachments: [
              ...(prev.attachments ?? []),
              ...(next.attachments ?? []),
            ].slice(0, 8),
          }),
        },
        async (_key, merged, latest) => {
          await this.dispatchOne(latest, merged);
        },
      );
    }
  }

  /** 入口: adapter 收到平台消息后调用 (去重/策略拒绝的消息被静默丢弃) */
  public async submit(message: InboundMessage): Promise<void> {
    try {
      if (this.dedupe.isDuplicate(message.messageId)) {
        logger.debug("ChannelPipeline", `[${this.options.channelId}] Dropped duplicate message ${message.messageId}`);
        return;
      }
      if (!this.accessAllowed(message)) return;
      // 入站限流 (设计 §6.4 per-peer 限流): 媒体下载之前——防止洪水触发
      // 大量下载/防抖缓冲膨胀; 与 loop-guard (派发计数) 职责不同
      if (!this.inboundAllowed(message.peerId)) {
        logger.warn("ChannelPipeline", `[${this.options.channelId}] Peer ${message.peerId} exceeded inbound rate limit; dropped`);
        return;
      }

      // slash fast path (设计 §5.2): 命令即时响应, 不进媒体下载/防抖/会话生成。
      // 最小判定 (startsWith("/")) 在此, 完整解析与"是否真是命令"交给注册表——
      // false (路径/普通文本) 落回常规链路。
      if (slashFastPath && message.content.startsWith("/")) {
        try {
          if (await slashFastPath(message, message.content)) return;
        } catch (err) {
          logger.error("ChannelPipeline", `[${this.options.channelId}] Slash fast path error:`, err);
        }
      }

      // 媒体入站即下载 (设计 §3.1): 失败的附件丢弃并注明, 不阻断文本
      const attachments = await this.resolveAttachments(message);
      const content = this.composeContent(message.content, attachments);
      const effective: InboundMessage = {
        ...message,
        content,
        ...(attachments.length > 0 ? { attachments } : {}),
      };

      if (this.coalescer) {
        // 元数据取最新一条 + 附件并集 (coalescer metaMerge): 合并派发不丢附件
        this.coalescer.submit(message.peerId, content, effective);
      } else {
        await this.dispatchOne(effective, content);
      }
    } catch (err) {
      logger.error("ChannelPipeline", `[${this.options.channelId}] Inbound pipeline error:`, err);
    }
  }

  /** 优雅停机: 冲刷防抖缓冲 */
  public async stop(): Promise<void> {
    await this.coalescer?.stop();
  }

  /** 入站滑动窗限流: 同 peer 60s 内最多 MAX_INBOUND_PER_WINDOW 条 (超限丢弃) */
  private static readonly RATE_WINDOW_MS = 60_000;
  private static readonly MAX_INBOUND_PER_WINDOW = 30;

  /** Map 容量上限 (唯一 peer 洪水 60s 内可制造 10 万条目 → OOM; 逐插守护非定时 sweep) */
  private static readonly RATE_MAP_CAP = 2048;

  private inboundAllowed(peerId: string): boolean {
    const now = Date.now();
    if (now - this.lastRateSweep > 60_000) {
      this.lastRateSweep = now;
      for (const [k, list] of this.inboundEvents) {
        if (list.every((t) => now - t >= InboundPipeline.RATE_WINDOW_MS)) this.inboundEvents.delete(k);
      }
    }
    const list = (this.inboundEvents.get(peerId) ?? []).filter((t) => now - t < InboundPipeline.RATE_WINDOW_MS);
    if (list.length >= InboundPipeline.MAX_INBOUND_PER_WINDOW) {
      this.inboundEvents.set(peerId, list);
      return false;
    }
    list.push(now);
    // 容量守护: 超限逐出最旧条目 (Map 插入序), 不整体 clear (会重置在流 peer 的窗口)
    while (this.inboundEvents.size >= InboundPipeline.RATE_MAP_CAP) {
      const oldest = this.inboundEvents.keys().next().value;
      if (oldest === undefined) break;
      this.inboundEvents.delete(oldest);
    }
    this.inboundEvents.set(peerId, list);
    return true;
  }

  private async dispatchOne(message: InboundMessage, content: string): Promise<void> {
    // 防自循环按派发计数 (防抖合并后), 超限熔断并审计
    const verdict = this.loopGuard.check(this.options.channelId, message.peerId);
    if (!verdict.allowed) {
      logger.warn("ChannelPipeline", `[${this.options.channelId}] ${verdict.reason}`);
      return;
    }
    const stopTyping = this.options.startTyping?.(message.peerId);
    try {
      await this.options.dispatch({ ...message, content });
    } finally {
      stopTyping?.();
    }
  }

  /**
   * 访问策略 (设计 §6.3): credentials.allowFrom = peerId 白名单。
   * - 非空: 严格白名单, 只匹配 peerId——各渠道的不可变 id (open_id/openid/
   *   userid/chat_id); 绝不匹配 senderName (昵称可随意改名, 匹配即可被绕过);
   * - 未配置: 放行——群消息仅在 @ 机器人时才会送达 (平台事件订阅层已过滤),
   *   陌生人成本防护由 loop-guard 熔断兜底; 需要强隔离时配置 allowFrom。
   */
  private accessAllowed(message: InboundMessage): boolean {
    let allowFrom: unknown;
    try {
      const config = this.store.getChannel(this.options.channelId);
      allowFrom = config?.credentials?.allowFrom;
    } catch {
      return true; // 配置读取失败不放大为吞消息 (终端等本地渠道无 credentials)
    }
    if (Array.isArray(allowFrom) && allowFrom.length > 0) {
      if (allowFrom.map((v) => String(v)).includes(message.peerId)) return true;
      logger.debug("ChannelPipeline", `[${this.options.channelId}] Peer ${message.peerId} not in allowFrom; dropped`);
      return false;
    }
    return true;
  }

  private async resolveAttachments(message: InboundMessage): Promise<MediaAttachmentResolved[]> {
    const resolved: MediaAttachmentResolved[] = [];
    for (const att of message.attachments ?? []) {
      if (att.localPath || !att.url) {
        resolved.push(att);
        continue;
      }
      try {
        const { localPath, sizeBytes } = await downloadMedia(this.options.channelId, att.url, {
          filename: att.filename,
          mimeType: att.mimeType,
        });
        resolved.push({ ...att, localPath, sizeBytes });
      } catch (err) {
        logger.warn("ChannelPipeline", `[${this.options.channelId}] Media download failed (${att.kind}): ${err}`);
      }
    }
    return resolved;
  }

  /** 附件以文件引用的形式并入 prompt 文本 (agent 在沙盒内可 read) */
  private composeContent(content: string, attachments: MediaAttachmentResolved[]): string {
    if (attachments.length === 0) return content;
    const refs = attachments.map((a, i) => {
      const meta = [a.mimeType, a.sizeBytes != null ? `${(a.sizeBytes / 1024).toFixed(1)}KB` : null]
        .filter(Boolean)
        .join(", ");
      return `[附件 #${i + 1}: ${a.kind}${a.filename ? ` ${a.filename}` : ""}${meta ? ` (${meta})` : ""} → ${a.localPath}]`;
    });
    return [content, ...refs].filter(Boolean).join("\n\n");
  }
}

type MediaAttachmentResolved = InboundMessage["attachments"] extends (infer T)[] | undefined ? T : never;
