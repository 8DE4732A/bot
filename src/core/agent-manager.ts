import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  AssistantEntry,
  createRegistry,
  Harness,
  watchEvents,
} from "@earendil-works/pi-durable";
import type {
  AgentEventStream,
  CompactionPolicy,
  Conversation,
  ConversationId,
  Extension,
  Harness as HarnessType,
  HarnessSettings,
  ReportInfo,
  TaskId,
  TaskInspection,
} from "@earendil-works/pi-durable";
import type { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { DatabaseStore, type AgentDefinition } from "../config/database-store.ts";
import type { CancelChatResult } from "../scheduler/contracts.ts";
import { ConversationMissing, ConversationPoisoned } from "../scheduler/contracts.ts";
import { getBotPaths } from "../config/env-paths.ts";
import { detectWorkspaceConflicts } from "../config/workspace-conflicts.ts";
import { EventBus } from "./event-bus.ts";
import { SandboxedExecutionEnv } from "../sandbox/execution-env.ts";
import { SkillsCatalog } from "../skills/builtin/skills-catalog.ts";
import { WorkspaceContext } from "../skills/builtin/workspace-context.ts";
import { setAgentIdResolver } from "../skills/agent-scope.ts";
import { purgeWorkspaceSkills } from "../skills/workspace.ts";
import { SkillRegistry } from "../skills/registry.ts";
import { logger } from "../utils/logger.ts";
import { ModelFactory } from "./model-factory.ts";
import { BOT_VERSION } from "../version.ts";
import { SchedulerSystemExtension } from "../scheduler/system-extension.ts";

import type { MutableModels } from "@earendil-works/pi-ai/models";

/** 一轮对话的可观测统计 (对齐 pi coding-agent footer 语义) */
export interface TurnUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  /** 最近一轮 prompt tokens ≈ 当前上下文大小 */
  contextTokens: number;
  /** 模型上下文窗口 (BYOK 未知时为 0, 前端显示 tokens 不显示百分比) */
  contextWindow: number;
  /** 缓存命中率 = cacheRead / (input + cacheRead + cacheWrite) */
  cacheHitRate?: number;
  costTotal: number;
  durationMs: number;
  /** 推理 token (provider 报告时) */
  reasoning?: number;
}

export interface ChatChunk {
  delta?: string;
  toolCall?: {
    name: string;
    status: string;
  };
  usage?: TurnUsage;
}

/**
 * 会话 usage 快照 (四期: /status 命令的会话上下文信息源)。
 * 跨轮累计、进程生命周期内——会话重置即清零; 重启后从零开始累计
 * (与终端 stats 同一语义边界)。
 */
export interface SessionUsageStats {
  turns: number;
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  totalCost: number;
  /** 最近一轮的上下文侧 (prompt tokens ≈ 当前上下文大小) */
  contextTokens: number;
  /** 模型上下文窗口 (BYOK 未知时 0) */
  contextWindow: number;
  /** 最近一轮缓存命中率 = cacheRead/(input+cacheRead+cacheWrite) */
  cacheHitRate?: number;
  lastTurnAt: number;
  lastDurationMs: number;
}

/**
 * 会话 turn 事件监听 (四期 M2, SessionHub 数据源): 流式 delta/工具轨迹/
 * usage 逐 chunk 同步广播——订阅方 (WS 第二传输) 据此给 TUI/Web 客户端
 * 回放与直播同一会话流。
 */
export type TurnListener = (agentId: string, sessionId: string, chunk: ChatChunk) => void;

/** 内存中缓存的会话数上限 (LRU 淘汰, 淘汰后下次访问从存储恢复) */
const MAX_CACHED_CONVERSATIONS = 100;

/** AgentManager 的会话映射复用 channel_sessions 表时的渠道哨兵 (非真实渠道) */
const MAPPING_CHANNEL = "channel_session";

const sessionKey = (agentId: string, sessionId: string) => `${agentId}:${sessionId}`;
const agentIdOf = (key: string) => key.split(":")[0];

interface ConvCache {
  conv: Conversation;
  /** 上次 configure 的 agent 配置指纹, 未变化则跳过重复提交 */
  configFp: string;
}

/** 六期：chat() 的稳定在飞登记（取消不依赖 busyTurns 的会话键） */
interface ActiveChat {
  key: string;
  agentId: string;
  sessionId: string;
  controller: AbortController;
  /** chatLocked 完成（成功/失败/取消）时 settle */
  done: Promise<void>;
  resolveDone: () => void;
  conv?: Conversation;
  submissionId?: string;
  /** 调度 run 身份：取消时区分同一 task 的不同 run */
  runKey?: string;
  /** 调度 lease fence：与 runKey 一起构成 run 实例身份 */
  leaseFence?: number;
  /** 调度 lease owner：取消时绑定具体执行实例 */
  owner?: string;
}

/** chat() 可选参数（六期：scheduler requestId / conversation 绑定） */
export interface ChatOptions {
  requestId?: string;
  conversationId?: string;
  /** 调度触发：activeChats 使用稳定 taskId 作为取消键 */
  schedulerTaskId?: string;
  /** 调度 runKey：取消时避免误伤同一 task 的其他 run */
  runKey?: string;
  /** 调度 lease fence：与 runKey 一起构成 run 实例身份 */
  leaseFence?: number;
  /** 调度 lease owner：取消时绑定具体执行实例 */
  owner?: string;
}

const configFingerprint = (a: AgentDefinition) =>
  [
    a.model.provider,
    a.model.modelId,
    a.model.thinkingLevel,
    a.instructions,
    a.workspaceDir,
    [...a.skills].sort().join(","),
  ].join("|");

/** durable 任务是否应阻塞队列投递/drain；sleeping/blocked 可跨进程存活，不阻塞。 */
export function isDurableTaskPending(task: TaskInspection): boolean {
  return task.state.kind !== "sleeping" && task.state.kind !== "blocked";
}

/**
 * 六期：全局 durable busy 判定（设计 §5.5）。
 * 调度任务本身与调度 conversation 下的 generation/tool 都属于 scheduler 工作面，
 * 不能阻塞普通 WS 队列/drain。
 */
export function countsTowardGlobalDurableBusy(
  task: TaskInspection,
  schedulerConversations: Set<string>,
): boolean {
  if (task.record.background) return false;
  if (schedulerConversations.has(String(task.record.conversationId))) return false;
  return isDurableTaskPending(task);
}

export interface DurableTaskStateInfo {
  kind: "running" | "ready" | "waiting" | "sleeping" | "completing" | "blocked";
  migrates?: boolean;
  on?: string[];
  until?: number;
  reason?: string;
}

export interface DurableTaskInfo {
  id: string;
  kind: string;
  conversationId: string;
  agentId?: string;
  state: DurableTaskStateInfo;
  restarts: number;
  startedAt?: number;
}

/** 管理台展示用的稳定状态摘要（不把框架内部字段直接透出）。 */
export function describeDurableState(state: TaskInspection["state"]): DurableTaskStateInfo {
  switch (state.kind) {
    case "running":
      return { kind: "running" };
    case "ready":
      return { kind: "ready", migrates: state.migrates };
    case "waiting":
      return { kind: "waiting", on: state.on.map(String) };
    case "sleeping":
      return { kind: "sleeping", until: state.until };
    case "completing":
      return { kind: "completing" };
    case "blocked":
      return { kind: "blocked", reason: state.reason };
  }
}

export class AgentManager {
  private static instance?: AgentManager;
  private harness?: HarnessType;
  private models?: MutableModels;
  private storage?: SqliteStorage;
  private registry?: ReturnType<typeof createRegistry>;
  private store: DatabaseStore;
  private conversations = new Map<string, ConvCache>();
  private conversationToAgent = new Map<string, string>();
  /** 同一会话的互斥队列: 保证串行处理, 避免 watch 流回调互踩与会话双重创建 */
  private sessionLocks = new Map<string, Promise<unknown>>();
  /** 正在生成中的会话 → conversation 引用 (busy 判定 / cancel / drain 用;
   *  存引用而非二次查缓存——会话被 LRU 逐出后 cancel 仍可中止, R1 评审 M10) */
  private busyTurns = new Map<string, Conversation>();
  /** 六期：进入 chat 即注册的取消登记（含 chatLocked 之前/之后两个阶段） */
  private activeChats = new Map<string, ActiveChat>();
  /** turn 事件监听 (SessionHub / 未来订阅方) */
  private turnListeners = new Set<TurnListener>();
  /** 会话 usage 快照 (跨轮累计, /status 与订阅方读取) */
  private usageStats = new Map<string, SessionUsageStats>();
  /** 删除/改配置时在飞 turn 尚未收尾的 Agent：turn 结束后再清该代际缓存 */
  private pendingPurge = new Set<string>();
  /** 历史 workspaceDir 冲突缓存（保存/删除 Agent 时失效，避免每轮 chat 全表重算） */
  private workspaceConflicts?: Map<string, string>;
  /** init() 已完成；会话库故障后允许懒重建 harness */
  private initialized = false;
  /** 首次 init 的 cwd：故障重建仍指向同一 .bot */
  private cwd = process.cwd();
  private recovery?: Promise<void>;
  /** 持久故障的重试冷却，避免每条消息/队列轮询都同步重建 */
  private recoveryRetryAt = 0;
  /** settings 派生缓存：models 原子替换后自动失效 */
  private settingsFor?: { models: MutableModels; value: HarnessSettings };
  /** 宿主是否已放行 resume；故障重建的新 Harness 沿用该意图 */
  private autoResume = true;
  /** 当前 harness 是否已 resume（避免重复调用/观测） */
  private resumed = false;

  constructor(store?: DatabaseStore) {
    this.store = store ?? new DatabaseStore();
  }

  public static getInstance(): AgentManager {
    if (!AgentManager.instance) {
      AgentManager.instance = new AgentManager();
    }
    return AgentManager.instance;
  }

  public reloadModels(): void {
    if (!this.models) return;
    // 1.4.0: HarnessOptions.models 支持函数。构建完整的新目录后原子替换，
    // in-flight 请求不会看到 clearProviders() 的中间态。
    this.models = ModelFactory.createConfiguredModels();
    this.settingsFor = undefined;
    logger.info(
      "AgentManager",
      `Reloaded BYOK model catalog (${this.models.getProviders().length} provider(s))`,
    );
  }

  /**
   * 运行期安装/卸载扩展 (MCP 桥接热更新用)。pi-durable 会话按名字解析扩展,
   * registry 同名 install 即刻替换, 已有会话的下一条消息自动生效, 无需 reconfigure。
   */
  public installExtension(extension: Extension): void {
    if (!this.registry) return;
    this.registry.install(extension);
  }

  public uninstallExtension(name: string): void {
    if (!this.registry) return;
    this.registry.uninstall({ name });
  }

  /** 会话归属反查 (工具执行时确定调用方 Agent; fail-closed): 内存映射 → channel_sessions 表 */
  public getAgentIdForConversation(conversationId: string): string | undefined {
    const mapped = this.conversationToAgent.get(conversationId);
    if (mapped) return mapped;
    const agentId = this.store.getAgentIdByConversation(conversationId);
    if (agentId) this.conversationToAgent.set(conversationId, agentId);
    return agentId;
  }

  /**
   * 删除 Agent / 配置变更时的进程内清理：
   * 工作区技能注册表分区与扫描缓存立即清；会话缓存/映射若有在飞 turn，
   * 延迟到 turn 收尾（避免工具调用归属解析断链或复用旧代际的 conversation）。
   */
  public purgeAgent(agentId: string): void {
    purgeWorkspaceSkills(agentId);
    this.workspaceConflicts = undefined;
    this.pendingPurge.add(agentId);
    if (!this.hasBusyTurn(agentId)) this.finishPendingPurge(agentId);
  }

  /** 历史 workspaceDir 冲突映射；保存/删除 Agent 经 purgeAgent 失效。 */
  private getWorkspaceConflicts(): Map<string, string> {
    if (!this.workspaceConflicts) {
      this.workspaceConflicts = detectWorkspaceConflicts(this.store.listAgents());
    }
    return this.workspaceConflicts;
  }

  /** 是否有该 Agent 的在飞 turn（busyTurns 的 key 格式由 sessionKey 统一派生）。 */
  private hasBusyTurn(agentId: string): boolean {
    const prefix = `${agentId}:`;
    for (const key of this.busyTurns.keys()) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }

  private finishPendingPurge(agentId: string): void {
    const prefix = `${agentId}:`;
    for (const key of [...this.conversations.keys()]) {
      if (key.startsWith(prefix)) this.conversations.delete(key);
    }
    for (const [convId, owner] of [...this.conversationToAgent.entries()]) {
      if (owner === agentId) this.conversationToAgent.delete(convId);
    }
    for (const key of [...this.usageStats.keys()]) {
      if (key.startsWith(prefix)) this.usageStats.delete(key);
    }
    this.pendingPurge.delete(agentId);
  }

  public async init(cwd: string = process.cwd(), options?: { resume?: boolean }): Promise<void> {
    if (this.harness) return;
    this.cwd = cwd;
    this.autoResume = options?.resume !== false;

    const paths = getBotPaths(cwd);
    logger.info("AgentManager", `Initializing Agent Harness with conversations DB at ${paths.conversationsDbFile}`);

    // models/registry 与 Harness 生命周期无关：Session 故障重建时复用，
    // 不重新创建 provider 实例、也不重装全部技能扩展。
    this.models ??= ModelFactory.createConfiguredModels();
    if (!this.registry) {
      const registry = createRegistry();
      this.registry = registry;
      // 五期: 会话 → Agent 归属解析（工作区技能/记忆注入用）；fail-closed
      setAgentIdResolver((conversationId) =>
        this.getAgentIdForConversation(conversationId),
      );
      for (const skill of SkillRegistry.getInstance().listSkills()) {
        registry.install(skill.extension);
      }
      // skills-catalog / workspace-context 不进 SkillRegistry (避免出现在选配列表),
      // 但必须 install: 会话按名字解析扩展, 选配数组里没有同名注册物会被丢弃
      registry.install(SkillsCatalog);
      registry.install(WorkspaceContext);
      // 六期：durable 模式安装调度任务定义；polling 回滚模式不安装，
      // 遗留 bot.scheduled-prompt 会以 missing_task 停在 blocked，不会执行
      if (this.store.getConfig("scheduler_durable_enabled", "1") !== "0") {
        registry.install(SchedulerSystemExtension);
      }
    }

    await this.openHarness();
    this.initialized = true;
    logger.info(
      "AgentManager",
      this.resumed
        ? "Agent Harness successfully initialized and resumed"
        : "Agent Harness initialized (resume deferred to scheduler gate)",
    );
  }

  /** 启动 gate 开启后恢复 durable 调度（六期启动顺序：init→scheduler.start→resume）。 */
  public resume(): void {
    // 先记录宿主动作：即使此刻 harness 正在故障重建，新实例也必须恢复，
    // 不能把启动期的 resume=false 永久沿用到重建后的 Harness。
    this.autoResume = true;
    if (!this.harness || this.resumed) return;
    this.harness.resume();
    this.resumed = true;
    logger.info("AgentManager", "Agent Harness resumed");
  }

  public getHarness(): HarnessType | undefined {
    return this.harness;
  }

  /** 打开 conversations 存储与 Harness（首次启动与会话故障重建共用）。 */
  private async openHarness(): Promise<void> {
    if (!this.models || !this.registry) {
      throw new Error("AgentManager bootstrap is incomplete");
    }
    const storage = await openNodeSqliteStorage(getBotPaths(this.cwd).conversationsDbFile);
    let harness: HarnessType;
    try {
      harness = await Harness.open(
        storage,
        {
          // 函数形态: reloadModels() 原子替换 this.models 后，下一次使用即生效
          models: () => this.models!,
          // 统一模型请求的 UA/版本 (pi-ai 1.4.0 ClientIdentity)
          identity: { userAgent: "detailed", version: BOT_VERSION },
          // 函数形态: 压缩阈值按模型窗口派生，配置热更新无需重开 Harness
          settings: () => this.buildHarnessSettings(),
          // 1.4.0 ReportInfo: Session/任务/扩展/host/listener 失败统一归因
          onReport: (err, info) => this.handleReport(err, info),
          registry: this.registry,
          env: (target) => {
            const convId = String(target.conversationId);
            let agentId = this.conversationToAgent.get(convId);
            if (!agentId) {
              // 内存映射缺失 (进程重启后 resume / 后台任务): 从持久化会话映射反查
              agentId = this.store.getAgentIdByConversation(convId);
              if (agentId) this.conversationToAgent.set(convId, agentId);
            }
            if (!agentId) {
              // fail-closed: 归属不明的会话拒绝提供执行环境, 绝不回退到默认 Agent 的沙盒
              throw new Error(`No agent mapping for conversation ${convId}; refusing to provide execution env`);
            }
            const agent = this.store.getAgent(agentId);
            if (!agent) throw new Error(`Agent not found: ${agentId}`);
            const workspace = target.cwd ?? agent.workspaceDir;

            return new SandboxedExecutionEnv({
              cwd: workspace,
              agentId: agent.id,
              sandboxConfig: agent.sandbox,
            });
          },
        },
        BACKGROUND_CONTEXT,
      );
    } catch (err) {
      await storage.close(BACKGROUND_CONTEXT).catch(() => {});
      throw err;
    }
    // 新 Harness 尚未 resume；旧实例的 resumed 状态不能泄漏到这一代。
    this.resumed = false;
    // 先挂监听再 resume：open/resume 期间失败同样能被观察到
    this.watchSessionFailure(harness);
    try {
      if (this.autoResume) {
        harness.resume();
        this.resumed = true;
      }
    } catch (err) {
      await storage.close(BACKGROUND_CONTEXT).catch(() => {});
      throw err;
    }
    this.storage = storage;
    this.harness = harness;
  }

  /** 1.4.0 settings 函数：按当前模型目录派生压缩阈值；models 替换后缓存失效。 */
  private buildHarnessSettings(): HarnessSettings {
    if (this.models && this.settingsFor?.models === this.models) {
      return this.settingsFor.value;
    }
    const overrides: Record<string, Partial<CompactionPolicy>> = {};
    for (const model of this.models?.getModels() ?? []) {
      const window = model.contextWindow;
      if (!window || window <= 0) continue;
      overrides[`${model.provider}/${model.id}`] = {
        // 给回答留 ~10%，保留最近 ~20% 原文；按窗口缩放，避免小窗口被固定默认值压死
        reserveTokens: Math.min(16_384, Math.max(512, Math.floor(window * 0.1))),
        keepRecentTokens: Math.min(32_768, Math.max(1_024, Math.floor(window * 0.2))),
        backgroundTokens: Math.min(16_384, Math.floor(window * 0.1)),
      };
    }
    const value: HarnessSettings = { compaction: { modelOverrides: overrides } };
    if (this.models) this.settingsFor = { models: this.models, value };
    return value;
  }

  /** 1.4.0 ReportInfo：Session/任务/扩展/host/listener 失败统一记录审计。 */
  private handleReport(error: unknown, info: ReportInfo): void {
    const conversationId =
      "task" in info && info.task
        ? String(info.task.conversationId)
        : "conversationId" in info && info.conversationId
          ? String(info.conversationId)
          : undefined;
    let agentId: string | undefined;
    if (conversationId) {
      try {
        agentId = this.getAgentIdForConversation(conversationId);
      } catch {
        /* 归属不明时只记全局审计 */
      }
    }
    const detail: Record<string, unknown> = { type: info.type };
    if ("extension" in info && info.extension) detail.extension = info.extension;
    if ("task" in info && info.task) {
      detail.taskId = String(info.task.id);
      detail.taskKind = info.task.kind;
    }
    if (info.type === "task_faulted") detail.reason = info.reason;
    if (info.type === "host_error") detail.callback = info.callback;
    try {
      this.store.recordAudit("agent.report", detail, agentId);
    } catch (auditErr) {
      logger.warn("AgentManager", `Failed to record durable report: ${auditErr}`);
    }
    const message = error instanceof Error ? error.message : String(error);
    const severe =
      info.type === "session_failed" ||
      info.type === "task_faulted" ||
      info.type === "task_parked" ||
      info.type === "migration_failed";
    if (severe) logger.error("AgentManager", `durable report ${info.type}: ${message}`);
    else logger.warn("AgentManager", `durable report ${info.type}: ${message}`);
  }

  /**
   * conversations.sqlite 的存储错误会让整个 Session 自关 (1.2.0 语义)；
   * 记录故障并清会话缓存，下一次请求经 ensureHarness() 懒重建。
   */
  private watchSessionFailure(harness: HarnessType): void {
    void harness.closed.then((end) => {
      // 旧 harness 的 closed 可能在重建后才 settle；不能让它标记新会话失败
      if (this.harness === harness && end.reason === "failed") {
        this.handleSessionFailure(end.error);
      }
    });
  }

  private handleSessionFailure(err: unknown): void {
    if (!this.harness) return;
    logger.error(
      "AgentManager",
      `Conversation session failed; harness will be reopened on next request: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    // Conversation 句柄绑定在已失败的 Session 上，不能继续复用；
    // conversationToAgent 来自业务库，跨 Session 重建仍然有效。
    this.harness = undefined;
    this.resumed = false;
    this.conversations.clear();
  }

  /** harness 可用则直接返回；会话库故障/已关闭时串行重建一次。 */
  private async ensureHarness(): Promise<void> {
    if (!this.initialized) throw new Error("AgentManager is not initialized");
    if (this.harness) return;
    if (this.recovery) return this.recovery;
    if (Date.now() < this.recoveryRetryAt) {
      throw new Error("Conversation storage is unavailable; retry shortly");
    }
    this.recovery = (async () => {
      const oldStorage = this.storage;
      this.storage = undefined;
      await oldStorage?.close(BACKGROUND_CONTEXT);
      await this.openHarness();
      this.recoveryRetryAt = 0;
    })()
      .catch((err) => {
        this.recoveryRetryAt = Date.now() + 5000;
        throw err;
      })
      .finally(() => {
        this.recovery = undefined;
      });
    return this.recovery;
  }

  /** 进程退出前收尾: 先 join 运行中的 Harness 任务再 checkpoint 会话库 (WAL 收敛)。 */
  public async shutdown(): Promise<void> {
    // 先关闸：shutdown 期间的新请求不再触发重建
    this.initialized = false;
    try {
      // 重建可能正在进行：等它落地后再关闭，避免关闭后又被重新打开
      if (this.recovery) await this.recovery.catch(() => {});
      if (this.harness) {
        await this.harness.close(BACKGROUND_CONTEXT);
        logger.info("AgentManager", "Harness closed (tasks joined)");
      }
      await this.storage?.close(BACKGROUND_CONTEXT);
      logger.info("AgentManager", "Conversations storage closed (WAL checkpointed)");
    } catch (err) {
      logger.warn("AgentManager", `Failed to close conversations storage: ${err}`);
    } finally {
      this.storage = undefined;
      this.harness = undefined;
      this.resumed = false;
      this.autoResume = false;
      this.activeChats.clear();
    }
  }

  /**
   * 同一会话串行化: 前一条消息完全处理完 (含提交) 之后才处理下一条。
   * 前序失败不阻塞后续。
   */
  private withSessionLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.sessionLocks.get(key) ?? Promise.resolve();
    const run = prev.then(fn);
    const stored = run.catch(() => {});
    this.sessionLocks.set(key, stored);
    void stored.finally(() => {
      if (this.sessionLocks.get(key) === stored) this.sessionLocks.delete(key);
    });
    return run;
  }

  private cacheConversation(key: string, conv: Conversation, configFp: string): void {
    // Map 迭代序即插入序: 先删后插实现 LRU 置顶
    this.conversations.delete(key);
    this.conversations.set(key, { conv, configFp });
    this.conversationToAgent.set(String(conv.id), agentIdOf(key));

    while (this.conversations.size > MAX_CACHED_CONVERSATIONS) {
      const oldestKey = this.conversations.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.conversations.get(oldestKey);
      this.conversations.delete(oldestKey);
      // conversationToAgent 反查映射保留 (条目极小): 逐出后的工具调用仍需正确归因沙盒
      if (oldest) logger.debug("AgentManager", `Evicted conversation cache: ${oldestKey}`);
    }
  }

  public async getOrCreateConversation(
    agentId: string,
    sessionId: string,
  ): Promise<Conversation> {
    let harness = this.harness;
    if (!harness) {
      await this.ensureHarness();
      harness = this.harness;
    }
    if (!harness) throw new Error("AgentManager is not initialized");

    const cacheKey = sessionKey(agentId, sessionId);
    let cached = this.conversations.get(cacheKey);

    const agent = this.store.getAgent(agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);

    // 历史重叠 workspaceDir 无法在 platformDenyRead 中互相隔离：fail-closed
    const workspaceConflict = this.getWorkspaceConflicts().get(agentId);
    if (workspaceConflict) {
      throw new Error(
        `Agent '${agentId}' workspace conflict: ${workspaceConflict}; fix workspaceDir before chatting`,
      );
    }

    // 配置变更/删除的 pending purge 期间：不复用旧代际的 conversation 缓存，
    // 让新请求按最新 Agent 配置重建（同会话仍由 sessionLock 串行）
    if (cached && this.pendingPurge.has(agentId)) {
      this.conversations.delete(cacheKey);
      cached = undefined;
    }

    // skills-catalog / workspace-context 常驻: 前者渲染技能目录，后者注入工作区记忆
    const agentSkills = [
      ...SkillRegistry.getInstance().resolveExtensions(agent.skills),
      SkillsCatalog,
      WorkspaceContext,
    ];

    if (!cached) {
      // Check if session mapping exists
      const sessionRecord = this.store.getSession(MAPPING_CHANNEL, cacheKey);

      if (sessionRecord) {
        // 框架契约: conversation 对不存在的记录返回 undefined (而非抛错)。
        // undefined → 映射失效 (如会话库被重置), 新建会话并覆盖映射, 可自愈;
        // 抛错则是瞬时/底层存储错误, 不能静默新建覆盖用户历史, 直接上抛。
        const existing = await harness.conversation(
          Number(sessionRecord.conversationId) as ConversationId,
          BACKGROUND_CONTEXT,
        );
        if (existing) {
          // configFp 置空: 恢复的旧会话无法得知其冻结的扩展名单是否落后于当前
          // agent 配置 (如新增技能/MCP), 必须强制一次 configure 同步——否则名单
          // 永远冻结在会话创建时刻 (实测: 重启后旧终端会话看不到新挂的 MCP 工具)
          cached = { conv: existing, configFp: "" };
        } else {
          logger.warn("AgentManager", `Conversation ${sessionRecord.conversationId} no longer exists; recreating session ${cacheKey}`);
          cached = { conv: await this.createNewConversation(agent, agentSkills), configFp: configFingerprint(agent) };
        }
      } else {
        cached = { conv: await this.createNewConversation(agent, agentSkills), configFp: configFingerprint(agent) };
      }

      this.cacheConversation(cacheKey, cached.conv, cached.configFp);

      // Save session mapping
      this.store.saveSession({
        channelInstanceId: MAPPING_CHANNEL,
        peerId: cacheKey,
        agentId: agent.id,
        conversationId: String(cached.conv.id),
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      });
    }

    // Sync agent settings only when they actually changed (configure 是一次事务提交);
    // extensions 也同步: 会话创建时冻结的技能集无法反映管理页的勾选变更
    const fp = configFingerprint(agent);
    if (cached.configFp !== fp) {
      try {
        await cached.conv.configure(
          {
            model: {
              provider: agent.model.provider as any,
              modelId: agent.model.modelId,
            },
            thinkingLevel: agent.model.thinkingLevel,
            instructions: agent.instructions,
            cwd: agent.workspaceDir,
            extensions: agentSkills,
          },
          BACKGROUND_CONTEXT,
        );
        cached.configFp = fp;
      } catch (err) {
        logger.warn("AgentManager", `Failed to sync latest agent configuration to conversation: ${err}`);
      }
    }

    return cached.conv;
  }

  private async createNewConversation(
    agent: AgentDefinition,
    extensions: any[],
  ): Promise<Conversation> {
    const conv = await this.harness!.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: {
          model: {
            provider: agent.model.provider as any,
            modelId: agent.model.modelId,
          },
          thinkingLevel: agent.model.thinkingLevel,
          instructions: agent.instructions,
          cwd: agent.workspaceDir,
          extensions,
        },
      },
      BACKGROUND_CONTEXT,
    );
    return conv;
  }

  /** 会话扩展集合（skills-catalog / workspace-context 常驻） */
  private extensionsFor(agent: AgentDefinition): any[] {
    return [
      ...SkillRegistry.getInstance().resolveExtensions(agent.skills),
      SkillsCatalog,
      WorkspaceContext,
    ];
  }

  /**
   * 六期：调度会话绑定。调度路径**不得**调用会自动重建的 getOrCreateConversation：
   * - 任务已有 conversation_id / mapping：exact 打开，缺失 fail-closed；
   * - 两者不一致 fail-closed；
   * - 都没有时才允许创建一次并写回 mapping + task.conversation_id。
   */
  public async openSchedulerConversation(
    agentId: string,
    taskId: string,
    conversationId?: string,
  ): Promise<Conversation> {
    let harness = this.harness;
    if (!harness) {
      await this.ensureHarness();
      harness = this.harness;
    }
    if (!harness) throw new Error("AgentManager is not initialized");

    const task = this.store.getScheduledTaskRaw(taskId);
    if (!task || task.deletedAt) {
      throw new ConversationMissing(`Scheduled task '${taskId}' no longer exists`);
    }
    if (task.conversationPoisoned) {
      throw new ConversationPoisoned(`Scheduled task '${taskId}' conversation is poisoned`);
    }

    const peerId = `scheduler:${taskId}`;
    const mapping = this.store.getSession(MAPPING_CHANNEL, peerId);
    if (conversationId && mapping && mapping.conversationId !== conversationId) {
      throw new ConversationMissing(
        `Session mapping for '${taskId}' points at ${mapping.conversationId}, not ${conversationId}`,
      );
    }
    if (conversationId && task.conversationId && task.conversationId !== conversationId) {
      throw new ConversationMissing(
        `Task '${taskId}' is bound to ${task.conversationId}, not ${conversationId}`,
      );
    }
    if (mapping && task.conversationId && mapping.conversationId !== task.conversationId) {
      throw new ConversationMissing(
        `Task '${taskId}' conversation binding mismatch (task=${task.conversationId}, mapping=${mapping.conversationId})`,
      );
    }

    const agent = this.store.getAgent(agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);
    const agentSkills = this.extensionsFor(agent);
    const cacheKey = sessionKey(agentId, `scheduler:${taskId}`);

    let conv: Conversation | undefined;
    const effective = conversationId ?? task.conversationId ?? mapping?.conversationId;
    if (effective && this.store.isRetiredSchedulerConversation(effective)) {
      throw new ConversationMissing(
        `Scheduled conversation ${effective} for '${taskId}' is retired; reset the conversation`,
      );
    }
    if (effective) {
      conv = await harness.conversation(Number(effective) as ConversationId, BACKGROUND_CONTEXT);
      if (!conv) {
        throw new ConversationMissing(
          `Scheduled conversation ${effective} for '${taskId}' no longer exists; refusing to recreate automatically`,
        );
      }
      if (!mapping || task.conversationId !== effective) {
        // backfill：conversation 存在时补齐 mapping/task 字段（不是新建）
        this.store.bindSchedulerConversation(taskId, effective, agentId);
      }
    } else {
      conv = await this.createNewConversation(agent, agentSkills);
      this.store.bindSchedulerConversation(taskId, String(conv.id), agentId);
    }

    const cached = this.conversations.get(cacheKey);
    const fp = configFingerprint(agent);
    if (!cached || cached.conv.id !== conv.id) {
      this.cacheConversation(cacheKey, conv, fp);
    }
    if (!cached || cached.conv.id !== conv.id || cached.configFp !== fp) {
      await conv.configure(
        {
          model: {
            provider: agent.model.provider as any,
            modelId: agent.model.modelId,
          },
          thinkingLevel: agent.model.thinkingLevel,
          instructions: agent.instructions,
          cwd: agent.workspaceDir,
          extensions: agentSkills,
        },
        BACKGROUND_CONTEXT,
      );
      this.conversations.set(cacheKey, { conv, configFp: fp });
    }
    this.conversationToAgent.set(String(conv.id), agentId);
    return conv;
  }

  /** reset-conversation 用：创建新会话但不写 mapping（由 runtime 在同一业务事务绑定） */
  public async createFreshSchedulerConversation(agentId: string, taskId: string): Promise<Conversation> {
    let harness = this.harness;
    if (!harness) {
      await this.ensureHarness();
      harness = this.harness;
    }
    if (!harness) throw new Error("AgentManager is not initialized");
    const agent = this.store.getAgent(agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);
    const conv = await this.createNewConversation(agent, this.extensionsFor(agent));
    this.cacheConversation(
      sessionKey(agentId, `scheduler:${taskId}`),
      conv,
      configFingerprint(agent),
    );
    return conv;
  }

  /** reset-conversation：清掉该任务的会话缓存/归属/busy/activeChats 旧项 */
  public forgetSchedulerConversation(taskId: string, conversationId?: string): void {
    const suffix = `:scheduler:${taskId}`;
    for (const key of [...this.conversations.keys()]) {
      if (key.endsWith(suffix)) this.conversations.delete(key);
    }
    for (const key of [...this.busyTurns.keys()]) {
      if (key.endsWith(suffix)) this.busyTurns.delete(key);
    }
    for (const key of [...this.usageStats.keys()]) {
      if (key.endsWith(suffix)) this.usageStats.delete(key);
    }
    if (conversationId) this.conversationToAgent.delete(conversationId);
    const active = this.activeChats.get(`task:${taskId}`);
    if (active) {
      active.controller.abort();
      this.activeChats.delete(`task:${taskId}`);
    }
  }

  public async openConversationById(id: string): Promise<Conversation | undefined> {
    if (!this.harness) return undefined;
    return this.harness.conversation(Number(id) as ConversationId, BACKGROUND_CONTEXT);
  }

  /** 该 conversation 是否仍有调度生成/工具任务或未结算 submission（R7-M4 精确谓词） */
  public async conversationIdle(conversationId: string): Promise<boolean> {
    if (!this.harness) return true;
    const inspection = await this.harness.inspect(BACKGROUND_CONTEXT);
    const busyTask = inspection.tasks.some((t) => {
      if (String(t.record.conversationId) !== conversationId) return false;
      if (t.record.kind !== "pi.generation" && t.record.kind !== "pi.tool") return false;
      return isDurableTaskPending(t);
    });
    const busySubmission = inspection.submissions.some(
      (s) => String(s.conversationId) === conversationId && (s.status === "queued" || s.status === "placed"),
    );
    return !busyTask && !busySubmission;
  }

  /** 等待 activeChats 中的调度 run 结束（不发起取消） */
  public async waitForChat(taskId: string, timeoutMs: number): Promise<boolean> {
    const entry = this.activeChats.get(`task:${taskId}`);
    if (!entry) return true;
    return raceTimeout(entry.done.then(() => true), timeoutMs, false);
  }

  /**
   * 六期：取消调度 run 的聊天生成（可重入）。
   * - `submission.abort` 只对 queued 有效；placed 返回 already_placed，必须走
   *   `conv.abort({background:true})` + waitForIdle；
   * - 没有内存登记时（崩溃恢复）按任务绑定的 conversation 做同样的 abort。
   */
  public async cancelChatForTask(
    taskId: string,
    timeoutMs: number,
    expectedRunKey?: string | string[],
    options?: {
      expectedLeaseFence?: number;
      expectedOwner?: string;
      /** 仅启动 reconcile：允许在“所有 running run 都属于旧 owner”时做一次受控 conversation abort */
      allowConversationAbortForStaleOwner?: string;
    },
  ): Promise<CancelChatResult> {
    const entry = this.activeChats.get(`task:${taskId}`);
    const expectedKeys =
      expectedRunKey === undefined
        ? undefined
        : new Set(Array.isArray(expectedRunKey) ? expectedRunKey : [expectedRunKey]);
    if (expectedKeys && entry) {
      // 调度 chat 必须带 runKey；不匹配/缺失一律 fail-closed，绝不按 taskId 误取消
      if (!entry.runKey || !expectedKeys.has(entry.runKey)) {
        return { chatExited: false, idle: false, reason: "run_mismatch" };
      }
      if (
        options?.expectedLeaseFence !== undefined &&
        entry.leaseFence !== options.expectedLeaseFence
      ) {
        return { chatExited: false, idle: false, reason: "run_mismatch" };
      }
      if (
        options?.expectedOwner !== undefined &&
        entry.owner !== options.expectedOwner
      ) {
        return { chatExited: false, idle: false, reason: "run_mismatch" };
      }
    }
    let conversation: Conversation | undefined = entry?.conv;
    let submissionId = entry?.submissionId;
    let reason: CancelChatResult["reason"] = "no_active_chat";
    const harness = this.harness;
    let conversationMissing = false;
    let taskConversationId: string | undefined;

    if (entry) {
      reason = "aborted";
      entry.controller.abort();
      submissionId = entry.submissionId;
    }

    if (!conversation) {
      const task = this.store.getScheduledTaskRaw(taskId);
      taskConversationId = task?.conversationId;
      if (taskConversationId && harness) {
        conversation = await harness
          .conversation(Number(taskConversationId) as ConversationId, BACKGROUND_CONTEXT)
          .catch(() => undefined);
        // 会话记录不存在不能直接当作 idle（R9-B2）：必须在下面用 inspect
        // 精确确认该 conversation 没有 generation/tool 或 queued/placed submission
        if (!conversation) conversationMissing = true;
      }
    }

    // 无 active entry 但带 run 归属：无法把 conversation 残留精确归属到该 run，
    // 一律 fail-closed，绝不做 conversation 级 abort（R17-B1）。
    if (expectedKeys && !entry) {
      const target = conversation ? String(conversation.id) : taskConversationId;
      if (target) {
        const idleNow = await this.conversationIdle(target).catch(() => false);
        if (idleNow) return { chatExited: true, idle: true, reason: "no_active_chat" };
        // 停机后恢复：old generation 没有 active entry。只有“本任务所有 running
        // run 都是旧 owner 且全部在 expectedKeys 内”时才允许一次受控
        // conversation.abort（新 run 必然带当前 instance owner，会被拒绝）。
        const running = this.store
          .listRunningScheduledRuns()
          .filter((r) => r.taskId === taskId);
        const currentOwner = options?.allowConversationAbortForStaleOwner;
        const staleOnly =
          currentOwner !== undefined &&
          running.length > 0 &&
          running.every(
            (r) => r.leaseOwner !== currentOwner && expectedKeys.has(r.runKey),
          );
        if (!staleOnly) {
          return { chatExited: false, idle: false, reason: "run_mismatch" };
        }
      }
    }

    if (conversation && harness) {
      if (submissionId) {
        const abortResult = await harness
          .abortSubmission(Number(submissionId) as any, BACKGROUND_CONTEXT, conversation.id)
          .catch(() => "not_found" as const);
        if (abortResult === "already_placed") {
          reason = "already_placed";
          const completed = await raceTimeout(
            conversation.abort(BACKGROUND_CONTEXT, { background: true }).then(() => true).catch(() => false),
            timeoutMs,
            false,
          );
          if (!completed) {
            logger.warn("AgentManager", `Conversation abort timed out for scheduler task ${taskId}`);
            reason = "timeout";
          }
        }
      } else {
        const completed = await raceTimeout(
          conversation.abort(BACKGROUND_CONTEXT, { background: true }).then(() => true).catch(() => false),
          timeoutMs,
          false,
        );
        if (!completed) {
          logger.warn("AgentManager", `Conversation abort timed out for scheduler task ${taskId}`);
          reason = "timeout";
        }
      }
    }

    const chatExited = entry ? await this.waitForChat(taskId, timeoutMs) : true;
    let idle = true;
    const idleConversationId = conversation ? String(conversation.id) : conversationMissing ? taskConversationId : undefined;
    if (idleConversationId) {
      const deadline = Date.now() + Math.min(timeoutMs, 5_000);
      idle = false;
      while (Date.now() < deadline) {
        if (await this.conversationIdle(idleConversationId).catch(() => false)) {
          idle = true;
          break;
        }
        await sleep(250);
      }
      if (!idle) {
        logger.warn("AgentManager", `Scheduler conversation ${idleConversationId} did not become idle`);
      }
    }
    if (conversationMissing) reason = "conversation_missing";
    if (!chatExited) reason = "timeout";
    return { chatExited, idle, reason };
  }

  /** 六期：按 id 查询 durable task 的 live inspection（不存在返回 undefined） */
  public async inspectDurableTask(id: string): Promise<TaskInspection | undefined> {
    if (!this.harness) return undefined;
    const inspection = await this.harness.inspect(BACKGROUND_CONTEXT);
    return inspection.tasks.find((t) => String(t.record.id) === id);
  }

  public async abortDurableTask(id: string): Promise<"marked" | "terminal" | "missing"> {
    if (!this.harness) return "missing";
    const task = await this.inspectDurableTask(id);
    if (!task) return "missing";
    return this.harness.abortTask(Number(id) as TaskId, BACKGROUND_CONTEXT);
  }

  public async waitForDurableTask(id: string, timeoutMs: number): Promise<boolean> {
    if (!this.harness) return true;
    const task = await this.inspectDurableTask(id);
    if (!task) return true;
    return raceTimeout(
      this.harness.waitForTask(Number(id) as TaskId, BACKGROUND_CONTEXT).then(() => true),
      timeoutMs,
      false,
    );
  }


  public async chat(
    agentId: string,
    sessionId: string,
    userMessage: string,
    onChunk?: (chunk: ChatChunk) => void,
    options?: ChatOptions,
  ): Promise<string> {
    const activeKey = options?.schedulerTaskId ? `task:${options.schedulerTaskId}` : `${agentId}:${sessionId}`;
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const entry: ActiveChat = {
      key: activeKey,
      agentId,
      sessionId,
      controller: new AbortController(),
      done,
      resolveDone,
      runKey: options?.runKey,
      leaseFence: options?.leaseFence,
      owner: options?.owner,
    };
    this.activeChats.set(activeKey, entry);

    if (entry.controller.signal.aborted) {
      entry.resolveDone();
      this.activeChats.delete(activeKey);
      throw new Error("Chat cancelled before start");
    }

    const run = this.withSessionLock(`${agentId}:${sessionId}`, () =>
      this.chatLocked(agentId, sessionId, userMessage, onChunk, options, entry),
    );
    return run.finally(() => {
      entry.resolveDone();
      if (this.activeChats.get(activeKey) === entry) this.activeChats.delete(activeKey);
    });
  }

  /** 会话是否正在生成 (TUI busy 提示 / cancel / 命令 busyPolicy 判定) */
  public isBusy(agentId: string, sessionId: string): boolean {
    return this.busyTurns.has(`${agentId}:${sessionId}`);
  }

  /** 全进程在飞生成数 (gateway drain 协议的等待判据) */
  public activeTurnCount(): number {
    return this.busyTurns.size;
  }

  /** 会话 usage 快照 (跨轮累计; 无记录返回 undefined) */
  public getUsageStats(agentId: string, sessionId: string): SessionUsageStats | undefined {
    return this.usageStats.get(`${agentId}:${sessionId}`);
  }

  /** 轮完成时累计快照 (调用方已算好 contextWindow/cacheHitRate) */
  private recordUsageStats(
    key: string,
    data: {
      contextTokens: number;
      contextWindow: number;
      cacheHitRate?: number;
      turnAgg: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
      durationMs: number;
    },
  ): void {
    const prev = this.usageStats.get(key);
    const next: SessionUsageStats = {
      turns: (prev?.turns ?? 0) + 1,
      totalInput: (prev?.totalInput ?? 0) + data.turnAgg.input,
      totalOutput: (prev?.totalOutput ?? 0) + data.turnAgg.output,
      totalCacheRead: (prev?.totalCacheRead ?? 0) + data.turnAgg.cacheRead,
      totalCacheWrite: (prev?.totalCacheWrite ?? 0) + data.turnAgg.cacheWrite,
      totalCost: (prev?.totalCost ?? 0) + data.turnAgg.cost,
      contextTokens: data.contextTokens,
      contextWindow: data.contextWindow,
      cacheHitRate: data.cacheHitRate,
      lastTurnAt: Date.now(),
      lastDurationMs: data.durationMs,
    };
    // Map 迭代序即插入序: LRU 触顶逐出最旧 (与会话缓存同量级)
    this.usageStats.delete(key);
    this.usageStats.set(key, next);
    while (this.usageStats.size > MAX_CACHED_CONVERSATIONS) {
      const oldest = this.usageStats.keys().next().value;
      if (oldest === undefined) break;
      this.usageStats.delete(oldest);
    }
  }

  /**
   * durable 层在飞任务数 (R4 评审 B2): harness.resume() 恢复的 running/ready
   * 任务不在 busyTurns (那是本进程 chat 路径的登记)——drain 等待面与恢复
   * 队列自驱动必须把这部分计入, 否则 crash 后恢复中的任务会被截断/并发投递。
   */
  public async durableBusyCount(): Promise<number> {
    if (!this.harness) return 0;
    // inspect 的 tasks 即全部 live work；1.4.0 新增 sleeping/blocked：
    // 两者都能跨进程存活（sleeping 到点续跑、blocked 等手动 retry），
    // 不应阻塞队列投递或 drain。
    // 六期：调度 durable task 与调度 conversation 下的 generation/tool 属于
    // scheduler 工作面，不得全局阻塞 WS 队列（设计 §5.5）。
    const inspection = await this.harness.inspect(BACKGROUND_CONTEXT);
    const schedulerConversations = this.store.listSchedulerConversationIds();
    return inspection.tasks.filter((task) =>
      countsTowardGlobalDurableBusy(task, schedulerConversations),
    ).length;
  }

  /** 管理台：当前 durable 任务及 blocked/sleeping 诊断。 */
  public async listDurableTasks(): Promise<DurableTaskInfo[]> {
    if (!this.harness) return [];
    const inspection = await this.harness.inspect(BACKGROUND_CONTEXT);
    return inspection.tasks.map((task) => {
      const conversationId = String(task.record.conversationId);
      let agentId: string | undefined;
      try {
        agentId = this.getAgentIdForConversation(conversationId);
      } catch {
        /* 归属不明时仍展示任务 */
      }
      return {
        id: String(task.record.id),
        kind: task.record.kind,
        conversationId,
        agentId,
        state: describeDurableState(task.state),
        restarts: task.record.restarts ?? 0,
        startedAt: task.record.startedAt,
      };
    });
  }

  /** 重跑被 crash-loop guard park 的任务（1.4.0 Harness.retryTask）。 */
  public async retryDurableTask(id: string): Promise<boolean> {
    const task = await this.inspectDurableTask(id);
    if (!task) return false;
    await this.harness!.retryTask(task.record.id, BACKGROUND_CONTEXT);
    return true;
  }

  /** 订阅全进程 turn 事件 (SessionHub); 返回退订函数 */
  public onTurnEvent(listener: TurnListener): () => void {
    this.turnListeners.add(listener);
    return () => {
      this.turnListeners.delete(listener);
    };
  }


  private async chatLocked(
    agentId: string,
    sessionId: string,
    userMessage: string,
    onChunk?: (chunk: ChatChunk) => void,
    options?: ChatOptions,
    activeChat?: ActiveChat,
  ): Promise<string> {
    const turnStartedAt = Date.now();
    EventBus.getInstance().publish({ type: "chat.turn", agentId, sessionId, phase: "start" });
    try {
      const answer = await this.chatTurn(agentId, sessionId, userMessage, onChunk, options, activeChat);
      EventBus.getInstance().publish({
        type: "chat.turn",
        agentId,
        sessionId,
        phase: "completed",
        durationMs: Date.now() - turnStartedAt,
      });
      return answer;
    } catch (err) {
      EventBus.getInstance().publish({
        type: "chat.turn",
        agentId,
        sessionId,
        phase: "error",
        durationMs: Date.now() - turnStartedAt,
        error: String(err),
      });
      throw err;
    } finally {
      this.busyTurns.delete(`${agentId}:${sessionId}`);
      // 删除/改配置请求可能在 turn 在飞时到达；最后一个 turn 收尾后再清代际缓存
      if (this.pendingPurge.has(agentId) && !this.hasBusyTurn(agentId)) {
        this.finishPendingPurge(agentId);
      }
    }
  }

  private async chatTurn(
    agentId: string,
    sessionId: string,
    userMessage: string,
    onChunk?: (chunk: ChatChunk) => void,
    options?: ChatOptions,
    activeChat?: ActiveChat,
  ): Promise<string> {
    const conv = options?.schedulerTaskId
      ? await this.openSchedulerConversation(
          agentId,
          options.schedulerTaskId,
          options.conversationId,
        )
      : await this.getOrCreateConversation(agentId, sessionId);
    if (activeChat) {
      activeChat.conv = conv;
      if (activeChat.controller.signal.aborted) {
        throw new Error("Chat cancelled before submission");
      }
    }
    // busy 登记在拿到 conv 之后 (存引用: LRU 逐出后 cancel 仍可中止)
    this.busyTurns.set(`${agentId}:${sessionId}`, conv);
    const context = BACKGROUND_CONTEXT;
    const turnStartedAt = Date.now();

    // turn 事件 sink (四期 M2): 流式 chunk 同步广播给监听方 (SessionHub →
    // WS 第二传输), 再交给调用方回调。无调用方回调但有监听方时也挂 watch——
    // TUI/Web 观看 IM 等其他入口发起的会话需要同一事件流。
    const sink =
      onChunk || this.turnListeners.size > 0
        ? (chunk: ChatChunk) => {
            for (const listener of this.turnListeners) {
              try {
                listener(agentId, sessionId, chunk);
              } catch {
                // 订阅方异常不影响生成
              }
            }
            onChunk?.(chunk);
          }
        : undefined;

    // 真实渠道映射行 (通知寻址用): sessionId 首段即渠道实例 id, 渠道真实存在
    // 才写映射——terminal/web-playground/scheduler 的差异由存在性决定, 调用方
    // 无需 (也不可能传错) 重复编码渠道身份
    const channelInstanceId = sessionId.split(":")[0];
    if (channelInstanceId !== MAPPING_CHANNEL && this.store.getChannel(channelInstanceId)) {
      this.store.saveSession({
        channelInstanceId,
        peerId: sessionId.slice(channelInstanceId.length + 1),
        agentId,
        conversationId: String(conv.id),
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      });
    }

    // Attach the framework's typed event stream (watchEvents) for streaming output;
    // 不再读取 pi.live 内部文档结构, 框架升级时由编译期类型兜底
    let watch: AgentEventStream | undefined;
    let lastRenderedText = "";
    // 本轮消耗 = 轮内各 assistant 消息 usage 相加; 当前上下文 = 最后一条
    // assistant 消息的 prompt 侧 (工具调用轮的累计差值会把多条消息 prompt
    // 相加, 虚高于真实上下文——实测踩坑, 勿改回差值口径)
    const turnAgg = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, reasoning: 0, cost: 0 };
    let lastMsgUsage: { input: number; cacheRead: number; cacheWrite: number } | undefined;

    if (sink) {
      try {
        watch = await watchEvents(this.harness!, conv.id, context);
        let lastToolEvent = "";
        watch.start(async (events) => {
          for (const e of events) {
            if (e.type === "message_end") {
              // EntryRecord.model = 该条目贡献给模型上下文的消息数组;
              // assistant 消息的 usage 是本次请求的计量 (input=未命中, cacheRead=命中);
              // toolResult 消息可能带独立 usage (工具内部模型调用), 一并计入本轮消耗
              const msgs = (e.entry as any)?.model as any[] | undefined;
              for (const m of msgs ?? []) {
                const usage = m?.usage;
                if (!usage) continue;
                turnAgg.input += usage.input ?? 0;
                turnAgg.output += usage.output ?? 0;
                turnAgg.cacheRead += usage.cacheRead ?? 0;
                turnAgg.cacheWrite += usage.cacheWrite ?? 0;
                turnAgg.totalTokens += usage.totalTokens ?? 0;
                turnAgg.cost += usage.cost?.total ?? 0;
                if (typeof usage.reasoning === "number") turnAgg.reasoning += usage.reasoning;
                // 当前上下文取最后一条 assistant 消息的 prompt 侧 (含全部历史)
                if (m.role === "assistant") {
                  lastMsgUsage = { input: usage.input ?? 0, cacheRead: usage.cacheRead ?? 0, cacheWrite: usage.cacheWrite ?? 0 };
                }
              }
            } else if (e.type === "message_update") {
              for (const change of e.changes) {
                if (change.type === "text_delta") {
                  lastRenderedText += change.delta;
                  sink({ delta: change.delta });
                }
              }
            } else if (e.type === "tool_execution_start" || e.type === "tool_execution_update") {
              if (lastToolEvent !== `${e.toolName}:running`) {
                lastToolEvent = `${e.toolName}:running`;
                sink({ toolCall: { name: e.toolName, status: "running" } });
              }
            } else if (e.type === "tool_execution_end") {
              if (lastToolEvent !== `${e.toolName}:done`) {
                lastToolEvent = `${e.toolName}:done`;
                sink({ toolCall: { name: e.toolName, status: "done" } });
              }
            }
          }
        });
      } catch (e) {
        logger.warn("AgentManager", `Failed to attach streaming watch: ${e}`);
        watch = undefined;
      }
    }

    try {
      const submission = await conv.submit(
        { type: "input", content: userMessage, requestId: options?.requestId },
        context,
      );
      if (activeChat) {
        activeChat.submissionId = String(submission.id);
        if (activeChat.controller.signal.aborted) {
          const aborted = await submission.abort(context).catch(() => "settled" as const);
          if (aborted === "already_placed") {
            await conv.abort(context, { background: true }).catch(() => {});
          }
          throw new Error("Chat cancelled before submission settled");
        }
      }

      const settled = await submission.wait(context);

      if (settled.status === "done" && settled.type === "input") {
        const answer = await conv.commit(
          (tx) => tx.entry(AssistantEntry, settled.answer),
          context,
        );

        const assistantMsg = answer?.model?.[0];
        let fullText = "";
        if (assistantMsg && Array.isArray(assistantMsg.content)) {
          for (const part of assistantMsg.content) {
            if (part.type === "text") {
              fullText += part.text;
            }
          }
        }

        // 流式已发送的内容与最终回答不是前缀关系时 (多轮工具调用导致生成重置),
        // 不能按长度切片, 否则发出错位的中段子串——改为显式补发完整回答
        if (sink) {
          if (fullText.startsWith(lastRenderedText)) {
            if (fullText.length > lastRenderedText.length) {
              sink({ delta: fullText.slice(lastRenderedText.length) });
            }
          } else if (fullText) {
            sink({ delta: `\n${fullText}` });
          }
        }

        // 轮统计: 本轮消耗 = 轮内各 assistant 消息 usage 相加;
        // 当前上下文 = 最后一条 assistant 消息的 prompt 侧 (input+cacheRead+cacheWrite)
        // ——工具调用轮的"累计差值"会把多条消息 prompt 相加, 虚高于真实上下文 (实测踩坑)
        if (lastMsgUsage) {
          const contextTokens = lastMsgUsage.input + lastMsgUsage.cacheRead + lastMsgUsage.cacheWrite;
          const cacheHitRate = contextTokens > 0 ? (lastMsgUsage.cacheRead / contextTokens) * 100 : undefined;
          let contextWindow = 0;
          try {
            const agent = this.store.getAgent(agentId);
            if (agent) {
              // 目录未命中的自定义模型 → 0 (终端只显示 tokens, 不显示假百分比);
              // 目录命中优先 (如 deepseek-v4 = 1M, 厂商注册表不含这些 BYOK id)
              contextWindow = this.models?.getModel(agent.model.provider, agent.model.modelId)?.contextWindow ?? 0;
            }
          } catch { /* 未知模型不显示百分比 */ }
          const durationMs = Date.now() - turnStartedAt;

          // 会话 usage 快照 (跨轮累计): /status 命令与订阅方的会话上下文信息源。
          // 独立于 sink——即使无人观看 (IM 后台会话), 统计也持续累计
          this.recordUsageStats(`${agentId}:${sessionId}`, {
            contextTokens,
            contextWindow,
            cacheHitRate,
            turnAgg,
            durationMs,
          });

          if (sink) {
            sink({
              usage: {
                input: turnAgg.input,
                output: turnAgg.output,
                cacheRead: turnAgg.cacheRead,
                cacheWrite: turnAgg.cacheWrite,
                totalTokens: turnAgg.totalTokens,
                reasoning: turnAgg.reasoning || undefined,
                contextTokens,
                contextWindow,
                cacheHitRate,
                costTotal: turnAgg.cost,
                durationMs,
              },
            });
          }
        }

        return fullText || "(无返回内容)";
      } else {
        const reason = (settled as any).reason || "unknown";
        throw new Error(`Agent failed to answer: ${reason}`);
      }
    } finally {
      if (watch) {
        await watch.stop().catch(() => {});
      }
    }
  }

  /**
   * 中止该会话正在进行的生成 (SSE 客户端断开 / 用户取消)。
   * 返回 true = 该会话确实在生成中且已发出 abort; 会话未缓存或空闲则无事发生。
   */
  public async abortSession(agentId: string, sessionId: string): Promise<boolean> {
    const key = sessionKey(agentId, sessionId);
    if (!this.busyTurns.has(key)) return false;
    const conv = this.busyTurns.get(key)!;
    try {
      await conv.abort(BACKGROUND_CONTEXT);
      logger.info("AgentManager", `Aborted active generation for ${agentId}:${sessionId}`);
      return true;
    } catch (err) {
      logger.warn("AgentManager", `Abort failed for ${agentId}:${sessionId}: ${err}`);
      return false;
    }
  }

  public async resetSession(
    agentId: string,
    sessionId: string,
    handoffNote?: string,
  ): Promise<void> {
    await this.withSessionLock(`${agentId}:${sessionId}`, async () => {
      const conv = await this.getOrCreateConversation(agentId, sessionId);
      await conv.reset(handoffNote, BACKGROUND_CONTEXT);
      // 上下文已作废, usage 快照一并清零 (下次生成从新会话的第一轮起计)
      this.usageStats.delete(`${agentId}:${sessionId}`);
      logger.info("AgentManager", `Reset session for ${agentId}:${sessionId}`);
    });
  }

  public async compactSession(
    agentId: string,
    sessionId: string,
    instructions?: string,
  ): Promise<void> {
    await this.withSessionLock(`${agentId}:${sessionId}`, async () => {
      const conv = await this.getOrCreateConversation(agentId, sessionId);
      await conv.compact(instructions, BACKGROUND_CONTEXT);
      logger.info("AgentManager", `Compacted session for ${agentId}:${sessionId}`);
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function raceTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), Math.max(1, timeoutMs));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
