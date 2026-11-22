import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import {
  AssistantEntry,
  CompactionEntry,
  createRegistry,
  Harness,
  LiveDoc,
} from "@earendil-works/pi-durable";
import type {
  CompactionSettings,
  Conversation,
  ConversationId,
  ConversationView,
  Extension,
  Harness as HarnessType,
  HarnessSettings,
  Observation,
  Report,
  WatchCall,
  RunFailure,
  TaskId,
  TaskInspection,
  UserInput,
} from "@earendil-works/pi-durable";
import type { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
  DatabaseStore,
  INTERNAL_MAPPING_CHANNEL,
  type AgentDefinition,
  type LlmRequestRecord,
  type LlmTurnRecord,
  type SessionKind,
} from "../config/database-store.ts";
import type { CancelChatResult } from "../scheduler/contracts.ts";
import { ConversationMissing, ConversationPoisoned } from "../scheduler/contracts.ts";
import { getBotPaths } from "../config/env-paths.ts";
import { detectWorkspaceConflicts } from "../config/workspace-conflicts.ts";
import { EventBus } from "./event-bus.ts";
import { SandboxedExecutionEnv } from "../sandbox/execution-env.ts";
import { SkillsCatalog } from "../skills/builtin/skills-catalog.ts";
import { WorkspaceContext } from "../skills/builtin/workspace-context.ts";
import { ChannelContext } from "../channels/prompt-context.ts";
import { setAgentIdResolver } from "../skills/agent-scope.ts";
import { purgeWorkspaceSkills } from "../skills/workspace.ts";
import { SkillRegistry } from "../skills/registry.ts";
import { logger } from "../utils/logger.ts";
import { formatMessageContext, MessageContextHint, withMessageContext } from "./message-context.ts";
import { ModelFactory } from "./model-factory.ts";
import {
  buildCompactionSettings,
  buildConversationCompactionSettings,
  DEFAULT_CONTEXT_POLICY,
  loadContextPolicy,
  type ContextPolicy,
  type ContextSessionProfile,
} from "./context-policy.ts";
import { getContextTelemetry } from "./context-telemetry.ts";
import {
  compactConversationNow,
  estimateIncomingTokens,
  maybeCompactBeforeTurn,
  type CompactionOutcome,
} from "./context-compaction.ts";
import { diffUsageState, emptyUsageDiff, snapshotUsage } from "./context-usage.ts";
import {
  createTurnViewState,
  reduceTurnView,
  seedTurnView,
  type TurnViewChanges,
} from "./live-view.ts";
import { textOfContent } from "./message-content.ts";
import { BOT_VERSION } from "../version.ts";
import { SchedulerSystemExtension } from "../scheduler/system-extension.ts";
import { SCHEDULED_PROMPT_TASK } from "../scheduler/durable-task.ts";

import type { MutableModels } from "@earendil-works/pi-ai/models";

/**
 * 常驻扩展（每个会话都选中）：skills-catalog 渲染技能目录、workspace-context
 * 注入工作区记忆、channel-context 告知 IM 平台的排版能力与 MEDIA 出站约定、
 * message-context-hint 说明每条用户消息前置的 `<context>` 事实块。
 * 注意 `registry.install()` 只是「可被选择」，真正生效取决于会话
 * `configure({ extensions })` 的名单——漏加即整段 section 不渲染（实测：
 * channel-context 只 install 未选中，模型从未被告知如何发文件）。
 */
const BASE_EXTENSIONS = [SkillsCatalog, WorkspaceContext, ChannelContext, MessageContextHint];

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
  /**
   * 结构化用户输入（文本 + 图片 content blocks）。渠道层在模型支持视觉时
   * 直接附带图片；userMessage 文本仍用于 token 估算与日志。
   */
  userContent?: UserInput;
  /** 消息触发时间（epoch ms）；缺省为 chat() 受理时刻。 */
  messageTime?: number;
  /** 额外事实上下文（如未来位置），逐行并入 `<context>` 块。 */
  messageContextFacts?: Record<string, string>;
}

/** 估算本轮新输入：文本按框架估算，图片按固定开销近似（用于前置压缩判定）。 */
function estimateIncomingInput(content: string | UserInput): number {
  if (typeof content === "string") return estimateIncomingTokens(content);
  let text = "";
  let images = 0;
  for (const part of content) {
    if (part.type === "text") text += `${part.text}\n`;
    else if (part.type === "image") images++;
  }
  return estimateIncomingTokens(text) + images * 1_600;
}

/** system_config.agent_max_turns 解析：0/非法 = 关闭（官方默认不限制）。 */
export function parseConfiguredMaxTurns(value: string | undefined): number | undefined {
  const text = (value ?? "0").trim();
  // 严格十进制整数：parseInt("12abc")/Number("1e3") 都会放过手误配置
  if (!/^\d+$/.test(text)) return undefined;
  const raw = Number(text);
  return Number.isSafeInteger(raw) && raw >= 1 ? Math.min(raw, 1_000) : undefined;
}

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
  kind: "running" | "pending" | "waiting" | "sleeping" | "completing" | "blocked";
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
    case "pending":
      return { kind: "pending", migrates: state.migrates };
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

/** 1.5.0 restart-limit report 是否属于某个 bot.scheduled-prompt durable 任务。 */
export function restartLimitReportTaskId(report: Report): string | undefined {
  if (!("task" in report) || !report.task) return undefined;
  if (report.task.kind !== SCHEDULED_PROMPT_TASK) return undefined;
  if (report.kind !== "task_faulted" && report.kind !== "task_interrupted") return undefined;
  if (report.reason !== "restart_limit") return undefined;
  return String(report.task.id);
}

export interface RestartLimitBusinessStore {
  getScheduledTaskByDurableTaskId(
    durableTaskId: string,
  ): { id: string; agentId?: string } | undefined;
  markScheduledTaskBlockedIfDurable(id: string, durableTaskId: string): boolean;
  recordAudit(event: string, detail: Record<string, unknown>): void;
}

/**
 * 1.5.0: reconcile 在 resume 之前运行，会把即将 restart-limit 的任务先写成 active；
 * resume 后的首次 reservation 才把它 fault 成 terminal。onReport 到达时按
 * durable id 回写业务 blocked，UI 才会出现“重建任务”，且 reconcile 不会复活它。
 */
export function markRestartLimitedBusinessTask(
  store: RestartLimitBusinessStore,
  report: Report,
): string | undefined {
  const durableTaskId = restartLimitReportTaskId(report);
  if (!durableTaskId) return undefined;
  const business = store.getScheduledTaskByDurableTaskId(durableTaskId);
  if (!business) return undefined;
  // 条件更新：用户已禁用/poison 或并发重建换了 durable id 时不能覆盖
  if (!store.markScheduledTaskBlockedIfDurable(business.id, durableTaskId)) return undefined;
  store.recordAudit("scheduler.durable_blocked", {
    taskId: business.id,
    durableTaskId,
    reason: "restart_limit",
  });
  if (business.agentId) {
    EventBus.getInstance().publish({
      type: "task.updated",
      taskId: business.id,
      agentId: business.agentId,
    });
  }
  return business.id;
}

/**
 * 1.5.0 不再 park crash-loop 任务：达到 restartLimit 的自定义任务以
 * terminal(faulted) 结束，detail 为 `{ reason: "restart_limit" }`。
 * 调度器据此把业务行标记为 blocked，避免 reconcile 自动复活形成死循环。
 */
export function isRestartLimitedRecord(
  record: { readonly state: { readonly status: string; readonly outcome?: unknown } } | undefined,
): boolean {
  if (!record || record.state.status !== "terminal") return false;
  const outcome = record.state.outcome as
    | { readonly status?: string; readonly error?: { readonly detail?: unknown } }
    | undefined;
  if (outcome?.status !== "faulted" && outcome?.status !== "failed") return false;
  const detail = outcome.error?.detail;
  return Boolean(
    detail &&
      typeof detail === "object" &&
      (detail as { reason?: unknown }).reason === "restart_limit",
  );
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
  /** 七期：手动压缩在飞数（drain 等待面；pre-turn 压缩已被 busyTurns 覆盖） */
  private manualCompactions = 0;
  /** 历史 workspaceDir 冲突缓存（保存/删除 Agent 时失效，避免每轮 chat 全表重算） */
  private workspaceConflicts?: Map<string, string>;
  /** init() 已完成；会话库故障后允许懒重建 harness */
  private initialized = false;
  /** 首次 init 的 cwd：故障重建仍指向同一 .bot */
  private cwd = process.cwd();
  private recovery?: Promise<void>;
  /** 持久故障的重试冷却，避免每条消息/队列轮询都同步重建 */
  private recoveryRetryAt = 0;
  /** settings 派生缓存：models 原子替换或策略变更后自动失效 */
  private settingsFor?: { models: MutableModels; policyVersion: number; value: HarnessSettings };
  /** 七期：上下文策略（内存快照；settings 同步读取，不能查库） */
  private contextPolicy: ContextPolicy = structuredClone(DEFAULT_CONTEXT_POLICY);
  private policyVersion = 0;
  /** 模型目录代际：reloadModels() 递增，用于让会话重新下发压缩设置（窗口可能变化） */
  private modelsRevision = 0;
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
    this.modelsRevision++;
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
    this.contextPolicy = loadContextPolicy(this.store);
    this.policyVersion++;

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
      // 常驻扩展不进 SkillRegistry (避免出现在选配列表), 但必须 install:
      // 会话按名字解析扩展, 选配数组里没有同名注册物会被丢弃
      for (const extension of BASE_EXTENSIONS) registry.install(extension);
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
          // 七期: 内容无关的 span 遥测（request/tool 明细，供上下文观测页）
          telemetry: getContextTelemetry(),
          // 1.5.0 Report: Session/任务/扩展/host/listener 失败统一归因
          onReport: (report) => this.handleReport(report),
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

  /** 1.4.0 settings 函数：按当前模型目录 + 上下文策略派生压缩阈值；热更新无需重开 Harness。 */
  private buildHarnessSettings(): HarnessSettings {
    if (this.models && this.settingsFor?.models === this.models && this.settingsFor.policyVersion === this.policyVersion) {
      return this.settingsFor.value;
    }
    const entries = (this.models?.getModels() ?? []).map((model) => ({
      provider: model.provider,
      id: model.id,
      contextWindow: model.contextWindow,
    }));
    const value: HarnessSettings = {
      compaction: buildCompactionSettings(this.contextPolicy, entries),
    };
    if (this.models) this.settingsFor = { models: this.models, policyVersion: this.policyVersion, value };
    return value;
  }

  /** 七期：策略热更新（settings 函数下次读取即生效；不重开 Harness）。 */
  public applyContextPolicy(policy: ContextPolicy): void {
    this.contextPolicy = policy;
    this.policyVersion++;
    this.settingsFor = undefined;
    logger.info("AgentManager", "Context policy applied");
  }

  public getContextPolicy(): ContextPolicy {
    return this.contextPolicy;
  }

  /** 1.5.0 Report：Session/任务/扩展/host/listener 失败统一记录审计。 */
  private handleReport(report: Report): void {
    const task = "task" in report ? report.task : undefined;
    const conversationId = task
      ? String(task.conversationId)
      : report.kind === "extension_error" && report.conversationId
        ? String(report.conversationId)
        : undefined;
    let agentId: string | undefined;
    if (conversationId) {
      try {
        agentId = this.getAgentIdForConversation(conversationId);
      } catch {
        /* 归属不明时只记全局审计 */
      }
    }
    const detail: Record<string, unknown> = { kind: report.kind };
    if ("extension" in report && report.extension) detail.extension = report.extension;
    if (task) {
      detail.taskId = String(task.id);
      detail.taskKind = task.kind;
    }
    if (
      report.kind === "task_faulted" ||
      report.kind === "task_interrupted" ||
      report.kind === "task_outdated"
    ) {
      detail.reason = report.reason;
    }
    if (report.kind === "task_interrupted") detail.restarts = report.restarts;
    if (report.kind === "host_error") detail.callback = report.callback;
    try {
      this.store.recordAudit("agent.report", detail, agentId);
    } catch (auditErr) {
      logger.warn("AgentManager", `Failed to record durable report: ${auditErr}`);
    }

    // 1.5.0: restart-limit 的自定义任务在 resume() 的首次 reservation 才 fault，
    // 此时 SchedulerRuntime.reconcile 已经跑过并把业务行写成 active。这里按
    // durable task id 补写 blocked，否则 UI 不显示“重建任务”，任务也不再调度。
    try {
      markRestartLimitedBusinessTask(this.store, report);
    } catch (markErr) {
      logger.warn("AgentManager", `Failed to mark restart-limited task blocked: ${markErr}`);
    }

    const message = report.error instanceof Error ? report.error.message : String(report.error);
    const severe =
      report.kind === "storage_failed" ||
      report.kind === "task_faulted" ||
      report.kind === "task_interrupted" ||
      report.kind === "migration_failed";
    if (severe) logger.error("AgentManager", `durable report ${report.kind}: ${message}`);
    else logger.warn("AgentManager", `durable report ${report.kind}: ${message}`);
  }

  /**
   * conversations.sqlite 的存储错误会让整个 Session 自关 (1.2.0 语义)；
   * 记录故障并清会话缓存，下一次请求经 ensureHarness() 懒重建。
   */
  private watchSessionFailure(harness: HarnessType): void {
    void harness.closed.then((end) => {
      // 旧 harness 的 closed 可能在重建后才 settle；不能让它标记新会话失败
      if (this.harness === harness && end.kind === "failed") {
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
      await getContextTelemetry().flush().catch(() => {});
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

  /**
   * 官方 AgentState.maxTurns（1.5.0）：限制一次 run 的工具轮数。
   * system_config.agent_max_turns=0（默认）表示不启用，保持旧行为。
   */
  private configuredMaxTurns(): number | undefined {
    try {
      return parseConfiguredMaxTurns(this.store.getConfig("agent_max_turns", "0"));
    } catch {
      return undefined;
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
    const maxTurns = this.configuredMaxTurns();

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

    // 会话扩展集合（技能 + 常驻扩展）单一来源
    const agentSkills = this.extensionsFor(agent);
    // 画像与 chatTurn 的 sessionKind 判定同源：轮询回滚路径也用 `scheduler:` 前缀
    const profile: ContextSessionProfile = sessionId.startsWith("scheduler:") ? "scheduled" : "normal";

    if (!cached) {
      // Check if session mapping exists
      const sessionRecord = this.store.getSession(INTERNAL_MAPPING_CHANNEL, cacheKey);

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
          cached = {
            conv: await this.createNewConversation(agent, agentSkills, maxTurns, profile),
            configFp: this.configFingerprint(agent, maxTurns),
          };
        }
      } else {
        cached = {
          conv: await this.createNewConversation(agent, agentSkills, maxTurns, profile),
          configFp: this.configFingerprint(agent, maxTurns),
        };
      }

      this.cacheConversation(cacheKey, cached.conv, cached.configFp);

      // Save session mapping
      this.store.saveSession({
        channelInstanceId: INTERNAL_MAPPING_CHANNEL,
        peerId: cacheKey,
        agentId: agent.id,
        conversationId: String(cached.conv.id),
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      });
    }

    // Sync agent settings only when they actually changed (configure 是一次事务提交);
    // extensions 也同步: 会话创建时冻结的技能集无法反映管理页的勾选变更
    const fp = this.configFingerprint(agent, maxTurns);
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
            // AgentChange 允许 null 清除；配置关掉时必须显式传 null，不能省略（省略=保持不变）
            maxTurns: maxTurns ?? null,
            // 1.6.0：每个会话写自己的压缩设置（普通画像不套用定时任务阈值）
            compaction: this.conversationCompaction(agent, profile),
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
    maxTurns: number | undefined,
    profile: ContextSessionProfile,
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
          ...(maxTurns ? { maxTurns } : {}),
          compaction: this.conversationCompaction(agent, profile),
        },
      },
      BACKGROUND_CONTEXT,
    );
    return conv;
  }

  /** 当前模型目录里的上下文窗口（未知为 0）；配置指纹与压缩设置共用同一来源。 */
  private modelContextWindow(provider: string, modelId: string): number {
    return this.models?.getModel(provider, modelId)?.contextWindow ?? 0;
  }

  /** 1.6.0：按会话画像派生压缩设置（普通/定时两套 keepRecent，模型窗口未知按 0）。 */
  private conversationCompaction(agent: AgentDefinition, profile: ContextSessionProfile): CompactionSettings {
    return buildConversationCompactionSettings(this.contextPolicy, profile, {
      provider: agent.model.provider,
      id: agent.model.modelId,
      contextWindow: this.modelContextWindow(agent.model.provider, agent.model.modelId),
    });
  }

  /**
   * 会话配置指纹：agent 配置 + 策略版本 + 模型目录代际。
   * 后两者变化时压缩设置需要重新下发（窗口/阈值可能已变）。
   */
  private configFingerprint(a: AgentDefinition, maxTurns?: number): string {
    return [
      a.model.provider,
      a.model.modelId,
      a.model.thinkingLevel,
      a.instructions,
      a.workspaceDir,
      [...a.skills].sort().join(","),
      maxTurns ?? 0,
      this.policyVersion,
      this.modelsRevision,
    ].join("|");
  }

  /** 会话扩展集合（技能 + 常驻扩展，见 BASE_EXTENSIONS） */
  private extensionsFor(agent: AgentDefinition): any[] {
    return [
      ...SkillRegistry.getInstance().resolveExtensions(agent.skills),
      ...BASE_EXTENSIONS,
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
    const mapping = this.store.getSession(INTERNAL_MAPPING_CHANNEL, peerId);
    // 轮询回滚模式（scheduler_durable_enabled=0）的旧映射是
    // `${agentId}:scheduler:<taskId>`，且 scheduled_tasks.conversation_id 为空；
    // 仅在 durable 绑定缺失时才回退到它，避免把旧轮询会话当成新会话。
    const legacyMapping =
      task.conversationId || mapping?.conversationId
        ? undefined
        : this.store.getSession(INTERNAL_MAPPING_CHANNEL, `${agentId}:scheduler:${taskId}`);
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
    const maxTurns = this.configuredMaxTurns();
    const agentSkills = this.extensionsFor(agent);
    const cacheKey = sessionKey(agentId, `scheduler:${taskId}`);

    let conv: Conversation | undefined;
    const effective =
      conversationId ?? task.conversationId ?? mapping?.conversationId ?? legacyMapping?.conversationId;
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
      conv = await this.createNewConversation(agent, agentSkills, maxTurns, "scheduled");
      this.store.bindSchedulerConversation(taskId, String(conv.id), agentId);
    }

    const cached = this.conversations.get(cacheKey);
    const fp = this.configFingerprint(agent, maxTurns);
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
          maxTurns: maxTurns ?? null,
          // 1.6.0：定时会话用定时画像的压缩设置
          compaction: this.conversationCompaction(agent, "scheduled"),
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
    const maxTurns = this.configuredMaxTurns();
    const conv = await this.createNewConversation(agent, this.extensionsFor(agent), maxTurns, "scheduled");
    this.cacheConversation(
      sessionKey(agentId, `scheduler:${taskId}`),
      conv,
      this.configFingerprint(agent, maxTurns),
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
    // 在等待会话锁之前记录触发时间：排队/忙碌时仍使用用户真实发送时刻
    const effectiveOptions: ChatOptions = {
      ...options,
      messageTime: options?.messageTime ?? Date.now(),
    };
    const activeKey = effectiveOptions.schedulerTaskId
      ? `task:${effectiveOptions.schedulerTaskId}`
      : `${agentId}:${sessionId}`;
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
      runKey: effectiveOptions.runKey,
      leaseFence: effectiveOptions.leaseFence,
      owner: effectiveOptions.owner,
    };
    this.activeChats.set(activeKey, entry);

    if (entry.controller.signal.aborted) {
      entry.resolveDone();
      this.activeChats.delete(activeKey);
      throw new Error("Chat cancelled before start");
    }

    const run = this.withSessionLock(`${agentId}:${sessionId}`, () =>
      this.chatLocked(agentId, sessionId, userMessage, onChunk, effectiveOptions, entry),
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

  /** 全进程在飞生成数 + 手动压缩数 (gateway drain 协议的等待判据) */
  public activeTurnCount(): number {
    return this.busyTurns.size + this.manualCompactions;
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

  /**
   * 1.5.0: inspect() 只返回 live 任务；崩溃达到 restartLimit 的任务已显式终结，
   * 需要 getTask 读取终态来区分「已结束」与「从未创建」。
   */
  public async getDurableTaskRecord(id: string) {
    if (!this.harness) return undefined;
    return this.harness.getTask(Number(id) as TaskId, BACKGROUND_CONTEXT);
  }

  /** 读取官方 runFailure；异常时返回 undefined，绝不覆盖原始错误。 */
  private async readRunFailure(conv: Conversation): Promise<RunFailure | undefined> {
    try {
      return (await this.harness?.snapshot(LiveDoc, conv.id, BACKGROUND_CONTEXT))?.runFailure;
    } catch {
      return undefined;
    }
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
    // 每条用户消息前置事实型时间上下文（无指令）；图片 content 也会附带同一块。
    const modelContent = withMessageContext(
      options?.userContent ?? userMessage,
      formatMessageContext({
        messageTime: options?.messageTime ?? Date.now(),
        extra: options?.messageContextFacts,
      }),
    );
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
    const telemetry = getContextTelemetry();
    const sessionKind: SessionKind =
      options?.schedulerTaskId !== undefined || sessionId.startsWith("scheduler:") ? "scheduled" : "normal";
    const schedulerTaskId =
      options?.schedulerTaskId ??
      (sessionId.startsWith("scheduler:") ? sessionId.slice("scheduler:".length) : undefined);
    const agentForModel = this.store.getAgent(agentId);
    const contextWindow = agentForModel
      ? this.modelContextWindow(agentForModel.model.provider, agentForModel.model.modelId)
      : 0;

    // 七期：前置压缩（普通/定时各一套阈值；失败 fail-open，取消则不提交）
    let preCompaction: CompactionOutcome | null = null;
    try {
      preCompaction = await maybeCompactBeforeTurn({
        harness: this.harness!,
        conversation: conv,
        conversationId: String(conv.id),
        agentId,
        sessionId,
        policy: this.contextPolicy,
        profile: sessionKind === "scheduled" ? "scheduled" : "normal",
        trigger: "pre_turn",
        contextWindow,
        incomingTokens: estimateIncomingInput(modelContent),
        instructions:
          sessionKind === "scheduled"
            ? "保留任务目标、已完成步骤、当前状态、待办与关键约束"
            : undefined,
        signal: activeChat?.controller.signal,
        telemetry,
        store: this.store,
      });
    } catch (err) {
      if (activeChat?.controller.signal.aborted) throw new Error("Chat cancelled");
      logger.warn("AgentManager", `Pre-turn compaction failed (fail-open): ${err}`);
    }
    if (preCompaction) {
      EventBus.getInstance().publish({
        type: "context.compacted",
        agentId,
        sessionId,
        conversationId: String(conv.id),
        trigger: preCompaction.trigger,
        status: preCompaction.status,
        beforeTokens: preCompaction.beforeTokens,
        afterTokens: preCompaction.afterTokens,
        durationMs: preCompaction.durationMs,
        costUsd: preCompaction.costUsd,
      });
      if (preCompaction.status === "aborted" || activeChat?.controller.signal.aborted) {
        throw new Error("Chat cancelled");
      }
    }

    const turnId = crypto.randomUUID();
    telemetry.beginTurn(String(conv.id), turnId);
    const turnStartedAt = Date.now();
    const usageBefore = await snapshotUsage(this.harness!, conv.id);

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
    if (channelInstanceId !== INTERNAL_MAPPING_CHANNEL && this.store.getChannel(channelInstanceId)) {
      this.store.saveSession({
        channelInstanceId,
        peerId: sessionId.slice(channelInstanceId.length + 1),
        agentId,
        conversationId: String(conv.id),
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      });
    }

    // Attach the framework's synchronous conversation observer (1.5.0): 流式输出 +
    // 七期指标（首字、压缩事件、durationMs 兜底）。observer 在 commit 采纳时同步调用，
    // 不经过 watch 的 pending 队列，turn 结束时不存在“最后一帧还没投递”的窗口。
    let observation: Observation<ConversationView> | undefined;
    const viewState = createTurnViewState();
    let lastRenderedText = "";
    // 本轮消耗 = 轮内各 assistant 消息 usage 相加; 当前上下文 = 最后一条
    // assistant 消息的 prompt 侧 (工具调用轮的累计差值会把多条消息 prompt
    // 相加, 虚高于真实上下文——实测踩坑, 勿改回差值口径)
    const turnAgg = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, reasoning: 0, cost: 0 };
    let lastMsgUsage: { input: number; cacheRead: number; cacheWrite: number } | undefined;
    let firstTokenAt: number | undefined;
    let fallbackLlmMs = 0;
    let fallbackToolMs = 0;
    const compactionSnapshots = new Map<
      string,
      { startedAt: number; usageBefore: Awaited<ReturnType<typeof snapshotUsage>> }
    >();
    // 压缩快照要读 Session（snapshotUsage），不能放进同步 observer；串行异步处理。
    let compactionWork: Promise<void> = Promise.resolve();
    const serialize = (
      current: Promise<void>,
      label: string,
      work: () => void | Promise<void>,
    ): Promise<void> =>
      current.then(work).catch((err) => {
        logger.warn("AgentManager", `${label}: ${err}`);
      });
    const enqueueCompactions = (changes: TurnViewChanges): void => {
      if (changes.compactionStarts.length === 0 && changes.compactionEnds.length === 0) return;
      const starts = changes.compactionStarts;
      const ends = changes.compactionEnds;
      compactionWork = serialize(
        compactionWork,
        "Conversation view compaction processing failed",
        async () => {
          for (const start of starts) {
            const snapUsage = await snapshotUsage(this.harness!, conv.id);
            compactionSnapshots.set(start.taskId, {
              startedAt: start.at,
              usageBefore: snapUsage,
            });
          }

          for (const end of ends) {
            const taskId = end.taskId;
            const snap = compactionSnapshots.get(taskId);
            compactionSnapshots.delete(taskId);
            const snapAfter = await snapshotUsage(this.harness!, conv.id);
            const diff = snap?.usageBefore && snapAfter
              ? diffUsageState(snap.usageBefore, snapAfter)
              : emptyUsageDiff();
            const endedAt = end.at;
            const startedAt = snap?.startedAt ?? endedAt;
            try {
              const already = this.store
                .listCompactionEvents({ turnId, limit: 200 })
                .find((x) => x.taskId === taskId);
              if (already?.id) {
                this.store.updateCompactionEventMetrics(already.id, {
                  requestCount: already.requestCount,
                  traceId: telemetry.traceForTurn(turnId),
                });
                continue;
              }
              this.store.insertCompactionEvent({
                conversationId: String(conv.id),
                agentId,
                sessionId,
                turnId,
                taskId,
                profile: sessionKind === "scheduled" ? "scheduled" : "normal",
                trigger:
                  end.trigger === "overflow"
                    ? "overflow"
                    : end.trigger === "manual"
                      ? "manual"
                      : "threshold",
                startedAt,
                endedAt,
                durationMs: Math.max(0, endedAt - startedAt),
                costUsd: diff.totals.costUsd,
                costInTurn: true,
                requestCount: Object.keys(diff.models).length,
                status: end.error ? "failed" : "done",
                failOpen: false,
                error: end.error?.slice(0, 500),
              });
            } catch (err) {
              logger.warn("AgentManager", `Failed to record in-turn compaction: ${err}`);
            }
            EventBus.getInstance().publish({
              type: "context.compacted",
              agentId,
              sessionId,
              conversationId: String(conv.id),
              trigger: end.trigger,
              status: end.error ? "failed" : "done",
              durationMs: Math.max(0, endedAt - startedAt),
              costUsd: diff.totals.costUsd,
            });
          }
        },
      );
    };
    // observer 只做同步归约；usage/sink/压缩快照进入串行异步队列，避免阻塞 Session 线。
    let changeWork: Promise<void> = Promise.resolve();
    // 所有调用点都在 observation.detach() 之后：不会再入队新 work。
    // 但 changeWork 执行时会 enqueueCompactions 替换 compactionWork，所以必须
    // 先等 changeWork，再等它产生的最新 compactionWork（不能同时捕获两者）。
    const waitObserverDrain = async (timeoutMs = 5_000): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      await raceTimeout(changeWork, Math.max(0, deadline - Date.now()), undefined);
      await raceTimeout(compactionWork, Math.max(0, deadline - Date.now()), undefined);
    };
    const applyChanges = (changes: TurnViewChanges): void => {
      for (const entry of changes.entries) {
        // 压缩摘要的消息不计入用户可见的 turn usage（UsageDoc 差分仍包含其成本）
        if (CompactionEntry.is(entry)) continue;
        // EntryRecord.model = 该条目贡献给模型上下文的消息数组;
        // assistant 消息的 usage 是本次请求的计量 (input=未命中, cacheRead=命中);
        // toolResult 消息可能带独立 usage (工具内部模型调用), 一并计入本轮消耗
        for (const m of entry.model ?? []) {
          const usage = (m as { usage?: Record<string, any> }).usage;
          if (!usage) continue;
          turnAgg.input += usage.input ?? 0;
          turnAgg.output += usage.output ?? 0;
          turnAgg.cacheRead += usage.cacheRead ?? 0;
          turnAgg.cacheWrite += usage.cacheWrite ?? 0;
          turnAgg.totalTokens += usage.totalTokens ?? 0;
          turnAgg.cost += usage.cost?.total ?? 0;
          if (typeof usage.reasoning === "number") turnAgg.reasoning += usage.reasoning;
          const durationMs = (m as { durationMs?: unknown }).durationMs;
          if (typeof durationMs === "number" && m.role === "assistant") fallbackLlmMs += durationMs;
          if (typeof durationMs === "number" && m.role === "toolResult") fallbackToolMs += durationMs;
          // 当前上下文取最后一条 assistant 消息的 prompt 侧 (含全部历史)
          if (m.role === "assistant") {
            lastMsgUsage = {
              input: usage.input ?? 0,
              cacheRead: usage.cacheRead ?? 0,
              cacheWrite: usage.cacheWrite ?? 0,
            };
          }
        }
      }

      // 近似 TTFT：observer 在 partial commit 采纳时看到首个 token（不是 HTTP 首字节；
      // 受 progress.partialIntervalMs 影响，口径与 1.4 的流事件计时略有差异）。
      if (changes.firstTokenSeen && firstTokenAt === undefined) firstTokenAt = Date.now();
      if (changes.textDelta) {
        lastRenderedText += changes.textDelta;
        sink?.({ delta: changes.textDelta });
      }
      for (const tool of changes.toolUpdates) sink?.({ toolCall: tool });
      enqueueCompactions(changes);
    };
    const enqueueChanges = (changes: TurnViewChanges): void => {
      changeWork = serialize(changeWork, "Conversation view processing failed", () => {
        applyChanges(changes);
      });
    };

    // observeConversation() 先注册 observer 再 resolve；注册到 resolve 之间到达的
    // advance 必须缓存，不能在 seed 之前归约——否则会把历史窗口当成新 entries 并
    // 污染 turn usage。observation.value 是注册前捕获的初始快照，缓存的 value 都
    // 比它新；resolve 后先 seed，再按序 replay。
    let observerSeeded = false;
    const pendingObserverCalls: WatchCall<ConversationView>[] = [];
    const processObserverCall = (call: WatchCall<ConversationView>): void => {
      if (call.kind === "failed") {
        logger.warn("AgentManager", `Conversation view observer failed: ${call.error}`);
        return;
      }
      try {
        enqueueChanges(reduceTurnView(viewState, call.value, Date.now()));
      } catch (err) {
        // 指标/UI 异常绝不能打断 Session 线；旧实现同样 fail-open
        logger.warn("AgentManager", `Conversation view processing failed: ${err}`);
      }
    };

    try {
      observation = await this.harness!.observeConversation(
        conv.id,
        {
          advance(call) {
            if (!observerSeeded) {
              pendingObserverCalls.push(call);
              return;
            }
            processObserverCall(call);
          },
          end(end) {
            if (end.kind === "failed" || end.kind === "listener_error") {
              logger.warn("AgentManager", `Conversation view observer ended: ${end.kind}`);
            }
          },
        },
        context,
        { min: 50, max: 200 },
      );
      seedTurnView(viewState, observation.value);
      observerSeeded = true;
      for (const call of pendingObserverCalls.splice(0)) processObserverCall(call);
    } catch (e) {
      logger.warn("AgentManager", `Failed to attach conversation view observer: ${e}`);
      observation = undefined;
      pendingObserverCalls.length = 0;
    }

    const modelCost = agentForModel
      ? this.models?.getModel(agentForModel.model.provider, agentForModel.model.modelId)?.cost
      : undefined;
    try {
      this.store.insertLlmTurn({
        turnId,
        conversationId: String(conv.id),
        agentId,
        sessionId,
        sessionKind,
        schedulerTaskId,
        provider: agentForModel?.model.provider,
        modelId: agentForModel?.model.modelId,
        startedAt: turnStartedAt,
        requestCount: 0,
        toolCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoningTokens: 0,
        costUsd: 0,
        priced: Boolean(
          modelCost &&
            (modelCost.input > 0 ||
              modelCost.output > 0 ||
              modelCost.cacheRead > 0 ||
              modelCost.cacheWrite > 0 ||
              (modelCost.tiers?.length ?? 0) > 0),
        ),
        contextWindow,
        compactedBefore: preCompaction?.status === "done",
        compactionMs: preCompaction?.durationMs ?? 0,
        status: "running",
        requestId: options?.requestId,
        runKey: options?.runKey,
        detailTruncated: false,
      });
    } catch (err) {
      logger.warn("AgentManager", `Failed to record running turn (ignored): ${err}`);
    }

    try {
      if (activeChat?.controller.signal.aborted) {
        throw new Error("Chat cancelled");
      }
      const submission = await conv.submit(
        { type: "input", content: modelContent, requestId: options?.requestId },
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

      // turn 已结算：先 detach 防止迟到 commit 继续入队，再把 changeWork/
      // compactionWork 全部 drain 完，最后才做最终文本对账与 usage 固化。
      observation?.detach();
      observation = undefined;
      await waitObserverDrain();

      if (settled.status === "done" && settled.type === "input") {
        const answer = await conv.commit(
          (tx) => tx.entry(AssistantEntry, settled.answer),
          context,
        );

        const assistantMsg = answer?.model?.[0];
        const fullText = assistantMsg ? textOfContent(assistantMsg.content) : "";
        // 最终 assistant entry 的 usage 是当前上下文的最新真相；多 tool round 时
        // observer 可能还没来得及把最后一条 entry 归约进来，不能只在 lastMsgUsage
        // 为空时兜底，否则 contextTokens 会停在前一轮 assistant 上。
        if (assistantMsg?.role === "assistant" && assistantMsg.usage) {
          lastMsgUsage = {
            input: assistantMsg.usage.input ?? 0,
            cacheRead: assistantMsg.usage.cacheRead ?? 0,
            cacheWrite: assistantMsg.usage.cacheWrite ?? 0,
          };
        }

        // 流式已发送的内容与最终回答不是前缀关系时 (多轮工具调用导致生成重置),
        // 不能按长度切片, 否则发出错位的中段子串——改为显式补发完整回答。
        // 1.5.0 的 view 归约器在新 generation 前会补一个换行，因此还要识别
        // “最终回答已经作为尾部完整展示过”的情况，避免重复发一遍。
        const alreadyStreamed =
          lastRenderedText === fullText ||
          (fullText.length > 0 && lastRenderedText.endsWith(`\n${fullText}`));
        if (sink && !alreadyStreamed) {
          if (fullText.startsWith(lastRenderedText)) {
            if (fullText.length > lastRenderedText.length) {
              sink({ delta: fullText.slice(lastRenderedText.length) });
            }
          } else if (fullText) {
            sink({ delta: `\n${fullText}` });
          }
        }

        // 七期：turn 成本以 UsageDoc 差分为真相源（含压缩摘要/工具内部调用），
        // message_end 汇总只作兜底与 /status 的实时快照。
        // 观测写入失败绝不能影响已经成功的回答（fail-open）。
        let costUsd = turnAgg.cost;
        let inputTokens = turnAgg.input;
        let outputTokens = turnAgg.output;
        let cacheRead = turnAgg.cacheRead;
        let cacheWrite = turnAgg.cacheWrite;
        const contextTokens = lastMsgUsage
          ? lastMsgUsage.input + lastMsgUsage.cacheRead + lastMsgUsage.cacheWrite
          : undefined;
        const durationMs = Date.now() - turnStartedAt;
        // 终端 /status 与会话累计也使用与 llm_turns 相同的账本（diff 可用时）
        let usageForStats = turnAgg;
        try {
          await telemetry.flush().catch(() => {});
          const usageAfter = await snapshotUsage(this.harness!, conv.id);
          const usageDiff = usageBefore && usageAfter
            ? diffUsageState(usageBefore, usageAfter)
            : emptyUsageDiff();
          const requests = this.store.listLlmRequests(turnId);
          const tools = this.store.listToolInvocations(turnId);
          const generationRequests = requests
            .filter((r) => r.taskKind === "generation" && r.kind === "request")
            .sort((a, b) => a.startedAt - b.startedAt);
          const firstGeneration = generationRequests[0];
          const llmMs =
            generationRequests.reduce((sum, r) => sum + (r.durationMs ?? 0), 0) || fallbackLlmMs;
          const toolMs = tools.reduce((sum, t) => sum + (t.durationMs ?? 0), 0) || fallbackToolMs;
          const ttftMs =
            firstTokenAt === undefined
              ? undefined
              : Math.max(0, firstTokenAt - (firstGeneration?.startedAt ?? turnStartedAt));
          let contextEstimateTokens = contextTokens;
          if (contextEstimateTokens === undefined) {
            // 只有 watch 没拿到 prompt 侧 usage 时才回读整段上下文估算
            try {
              const view = await conv.context(context);
              contextEstimateTokens = estimateContextTokens(view.messages).tokens;
            } catch {
              /* keep undefined */
            }
          }
          // 两个 snapshot 都成功时以 diff 为唯一真相（零也是有效值），
          // 只有 snapshot 不可用时才整体回退到 message_end 汇总。
          const hasUsageDiff = Boolean(usageBefore && usageAfter);
          const diffCost = hasUsageDiff ? usageDiff.totals.costUsd : turnAgg.cost;
          const diffInput = hasUsageDiff ? usageDiff.totals.input : turnAgg.input;
          const diffOutput = hasUsageDiff ? usageDiff.totals.output : turnAgg.output;
          const diffCacheRead = hasUsageDiff ? usageDiff.totals.cacheRead : turnAgg.cacheRead;
          const diffCacheWrite = hasUsageDiff ? usageDiff.totals.cacheWrite : turnAgg.cacheWrite;
          usageForStats = {
            input: diffInput,
            output: diffOutput,
            cacheRead: diffCacheRead,
            cacheWrite: diffCacheWrite,
            totalTokens: diffInput + diffOutput + diffCacheRead + diffCacheWrite,
            reasoning: hasUsageDiff ? usageDiff.totals.reasoning : turnAgg.reasoning,
            cost: diffCost,
          };
          costUsd = diffCost;
          inputTokens = diffInput;
          outputTokens = diffOutput;
          cacheRead = diffCacheRead;
          cacheWrite = diffCacheWrite;
          const traceId =
            telemetry.traceForTurn(turnId) ?? telemetry.traceForSubmission(String(submission.id));
          this.backfillInTurnCompactions({
            conversationId: String(conv.id),
            agentId,
            sessionId,
            sessionKind,
            turnId,
            requests,
            traceId,
          });
          this.store.updateLlmTurn(turnId, {
            endedAt: Date.now(),
            durationMs,
            firstChunkMs: firstGeneration?.firstChunkMs,
            ttftMs,
            llmMs,
            toolMs,
            requestCount: requests.length,
            toolCount: tools.length,
            inputTokens: diffInput,
            outputTokens: diffOutput,
            cacheRead: diffCacheRead,
            cacheWrite: diffCacheWrite,
            reasoningTokens: hasUsageDiff ? usageDiff.totals.reasoning : turnAgg.reasoning,
            costUsd: diffCost,
            usageJson: hasUsageDiff ? JSON.stringify(usageDiff) : undefined,
            contextTokens,
            contextEstimateTokens,
            contextWindow,
            status: "done",
            traceId,
            submissionId: String(submission.id),
            detailTruncated: telemetry.wasTruncated(turnId),
          });
          EventBus.getInstance().publish({
            type: "context.turn",
            agentId,
            sessionId,
            conversationId: String(conv.id),
            turnId,
            status: "done",
            contextTokens,
            contextWindow,
            costUsd: diffCost,
          });
        } catch (err) {
          logger.warn("AgentManager", `Failed to record turn metrics (ignored): ${err}`);
        }

        // 轮统计: 本轮消耗 = 轮内各 assistant 消息 usage 相加;
        // 当前上下文 = 最后一条 assistant 消息的 prompt 侧 (input+cacheRead+cacheWrite)
        // ——工具调用轮的"累计差值"会把多条消息 prompt 相加, 虚高于真实上下文 (实测踩坑)
        if (lastMsgUsage) {
          const cacheHitRate = contextTokens! > 0 ? (lastMsgUsage.cacheRead / contextTokens!) * 100 : undefined;

          // 会话 usage 快照 (跨轮累计): /status 命令与订阅方的会话上下文信息源。
          // 独立于 sink——即使无人观看 (IM 后台会话), 统计也持续累计
          this.recordUsageStats(`${agentId}:${sessionId}`, {
            contextTokens: contextTokens!,
            contextWindow,
            cacheHitRate,
            turnAgg: usageForStats,
            durationMs,
          });

          if (sink) {
            sink({
              usage: {
                input: inputTokens,
                output: outputTokens,
                cacheRead,
                cacheWrite,
                totalTokens: usageForStats.totalTokens,
                reasoning: usageForStats.reasoning || undefined,
                contextTokens: contextTokens!,
                contextWindow,
                cacheHitRate,
                costTotal: costUsd,
                durationMs,
              },
            });
          }
        }

        return fullText || "(无返回内容)";
      } else {
        // 1.5.0: pi.live.runFailure 是「本轮为什么没有回答」的官方来源，
        // submission 的 reason 只是兜底（continue/turn_limit/nothing_to_answer 等）。
        // 只采用包含本次 submission 的 runFailure；排队中被 abort 时不会 startRun，
        // pi.live 里可能仍留着上一轮的失败原因。
        const liveFailure = await this.readRunFailure(conv);
        const failure =
          liveFailure && liveFailure.inputs.some((id) => String(id) === String(submission.id))
            ? liveFailure
            : undefined;
        const reason = failure?.reason ?? settled.reason ?? "unknown";
        const detailValue = failure?.detail ?? settled.detail;
        const detail =
          detailValue === undefined
            ? ""
            : typeof detailValue === "string"
              ? `: ${detailValue}`
              : `: ${JSON.stringify(detailValue)}`;
        throw new Error(`Agent failed to answer: ${reason}${detail}`);
      }
    } catch (err) {
      observation?.detach();
      observation = undefined;
      const aborted =
        activeChat?.controller.signal.aborted === true ||
        /cancel/i.test(String(err)) ||
        /\babort(ed)?\b/i.test(String(err));
      try {
        const endedAt = Date.now();
        await waitObserverDrain();
        const usageAfter = await snapshotUsage(this.harness!, conv.id).catch(() => undefined);
        const usageDiff = usageBefore && usageAfter
            ? diffUsageState(usageBefore, usageAfter)
            : emptyUsageDiff();
        await telemetry.flush().catch(() => {});
        const requests = this.store.listLlmRequests(turnId);
        const tools = this.store.listToolInvocations(turnId);
        const generationRequests = requests
          .filter((r) => r.taskKind === "generation" && r.kind === "request")
          .sort((a, b) => a.startedAt - b.startedAt);
        const firstGeneration = generationRequests[0];
        const hasUsageDiff = Boolean(usageBefore && usageAfter);
        const costUsd = hasUsageDiff ? usageDiff.totals.costUsd : turnAgg.cost;
        const turnTraceId = telemetry.traceForTurn(turnId);
        this.backfillInTurnCompactions({
          conversationId: String(conv.id),
          agentId,
          sessionId,
          sessionKind,
          turnId,
          requests,
          traceId: turnTraceId,
        });
        this.store.updateLlmTurn(turnId, {
          endedAt,
          durationMs: Math.max(0, endedAt - turnStartedAt),
          firstChunkMs: firstGeneration?.firstChunkMs,
          ttftMs:
            firstTokenAt === undefined
              ? undefined
              : Math.max(0, firstTokenAt - (firstGeneration?.startedAt ?? turnStartedAt)),
          llmMs: generationRequests.reduce((sum, r) => sum + (r.durationMs ?? 0), 0) || fallbackLlmMs,
          toolMs: tools.reduce((sum, t) => sum + (t.durationMs ?? 0), 0) || fallbackToolMs,
          requestCount: requests.length,
          toolCount: tools.length,
          inputTokens: hasUsageDiff ? usageDiff.totals.input : turnAgg.input,
          outputTokens: hasUsageDiff ? usageDiff.totals.output : turnAgg.output,
          cacheRead: hasUsageDiff ? usageDiff.totals.cacheRead : turnAgg.cacheRead,
          cacheWrite: hasUsageDiff ? usageDiff.totals.cacheWrite : turnAgg.cacheWrite,
          reasoningTokens: hasUsageDiff ? usageDiff.totals.reasoning : turnAgg.reasoning,
          costUsd,
          usageJson: hasUsageDiff ? JSON.stringify(usageDiff) : undefined,
          status: aborted ? "aborted" : "error",
          error: String(err).slice(0, 500),
          traceId: telemetry.traceForTurn(turnId),
          detailTruncated: telemetry.wasTruncated(turnId),
        });
        EventBus.getInstance().publish({
          type: "context.turn",
          agentId,
          sessionId,
          conversationId: String(conv.id),
          turnId,
          status: aborted ? "aborted" : "error",
          contextTokens: lastMsgUsage ? lastMsgUsage.input + lastMsgUsage.cacheRead + lastMsgUsage.cacheWrite : undefined,
          contextWindow,
          costUsd,
        });
      } catch (metricsErr) {
        logger.warn("AgentManager", `Failed to record failed turn metrics (ignored): ${metricsErr}`);
      }
      throw err;
    } finally {
      telemetry.endTurn(String(conv.id), turnId);
      observation?.detach();
    }
  }

  /**
   * 中止该会话正在进行的生成 (SSE 客户端断开 / 用户取消)。
   * 返回 true = 该会话确实在生成中且已发出 abort; 会话未缓存或空闲则无事发生。
   */
  public async abortSession(agentId: string, sessionId: string): Promise<boolean> {
    let aborted = false;
    // 先取消宿主侧 signal：前置压缩/idle 检查/估算窗口内 conversation 可能已经 idle，
    // 仅 conv.abort() 不会阻止随后 submit（七期评审 BLOCKING）。
    const activeKeys = new Set<string>([`${agentId}:${sessionId}`]);
    if (sessionId.startsWith("scheduler:")) {
      activeKeys.add(`task:${sessionId.slice("scheduler:".length)}`);
    }
    for (const key of activeKeys) {
      const entry = this.activeChats.get(key);
      if (entry && !entry.controller.signal.aborted) {
        entry.controller.abort();
        aborted = true;
      }
    }
    const key = sessionKey(agentId, sessionId);
    const conv = this.busyTurns.get(key);
    if (conv) {
      try {
        await conv.abort(BACKGROUND_CONTEXT);
        logger.info("AgentManager", `Aborted active generation for ${agentId}:${sessionId}`);
        aborted = true;
      } catch (err) {
        logger.warn("AgentManager", `Abort failed for ${agentId}:${sessionId}: ${err}`);
      }
    }
    return aborted;
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

  /**
   * 七期：轮内压缩事件回填。watch 的 compaction_end 可能还在 pending frames 中，
   * 这里以已 flush 的请求明细（task_kind=compaction + task_id）为准补齐事件，
   * 并按 task_id 精确统计请求数与 trace；失败只告警，不影响 turn 终态。
   */
  private backfillInTurnCompactions(input: {
    conversationId: string;
    agentId: string;
    sessionId: string;
    sessionKind: SessionKind;
    turnId: string;
    requests: LlmRequestRecord[];
    traceId?: string;
  }): void {
    try {
      const groups = new Map<string, LlmRequestRecord[]>();
      for (const request of input.requests) {
        if (request.taskKind !== "compaction" || !request.taskId) continue;
        const rows = groups.get(request.taskId) ?? [];
        rows.push(request);
        groups.set(request.taskId, rows);
      }
      if (groups.size === 0) return;
      const existing = this.store.listCompactionEvents({ turnId: input.turnId, limit: 200 });
      const byTask = new Map(
        existing.filter((e) => e.taskId).map((e) => [e.taskId!, e] as const),
      );
      for (const [taskId, rows] of groups) {
        const already = byTask.get(taskId);
        if (already?.id) {
          // watch 已写入权威事件：只补真实请求数与 trace
          this.store.updateCompactionEventMetrics(already.id, {
            requestCount: rows.length,
            traceId: input.traceId,
          });
          continue;
        }
        const startedAt = Math.min(...rows.map((r) => r.startedAt));
        const endedAt = Math.max(...rows.map((r) => r.endedAt ?? r.startedAt));
        const status = rows.some((r) => r.status === "error")
          ? "failed"
          : rows.some((r) => r.status === "aborted")
            ? "aborted"
            : "done";
        this.store.insertCompactionEvent({
          conversationId: input.conversationId,
          agentId: input.agentId,
          sessionId: input.sessionId,
          turnId: input.turnId,
          taskId,
          traceId: input.traceId,
          profile: input.sessionKind === "scheduled" ? "scheduled" : "normal",
          trigger: "threshold",
          startedAt,
          endedAt,
          durationMs: Math.max(0, endedAt - startedAt),
          costUsd: rows.reduce((sum, r) => sum + r.costUsd, 0),
          costInTurn: true,
          requestCount: rows.length,
          status,
          failOpen: false,
        });
      }
    } catch (err) {
      logger.warn("AgentManager", `Failed to backfill in-turn compactions (ignored): ${err}`);
    }
  }

  /**
   * 手动压缩。scheduler 会话必须走 openSchedulerConversation：
   * scheduler 的映射 peerId 是 `scheduler:<taskId>`（无 agentId 前缀），
   * getOrCreateConversation 查不到会新建一个错误的会话。
   */
  public async compactSession(
    agentId: string,
    sessionId: string,
    instructions?: string,
  ): Promise<CompactionOutcome> {
    // 在任何 await 之前登记 drain 等待面；REST 二次检查后到这里仍可能开始 drain。
    this.manualCompactions++;
    try {
      return await this.withSessionLock(`${agentId}:${sessionId}`, async () => {
        const taskId = sessionId.startsWith("scheduler:") ? sessionId.slice("scheduler:".length) : undefined;
        const conv = taskId
          ? await this.openSchedulerConversation(agentId, taskId)
          : await this.getOrCreateConversation(agentId, sessionId);
        return this.runManualCompaction(agentId, sessionId, conv, instructions);
      });
    } finally {
      this.manualCompactions = Math.max(0, this.manualCompactions - 1);
    }
  }

  /** conversationId → 与 chat 一致的 {agentId, sessionId}（REST/命令/压缩共用）。 */
  public resolveConversationSession(
    conversationId: string,
  ): { agentId: string; sessionId: string } | undefined {
    const scheduled = this.store.getScheduledTaskByConversation(conversationId);
    if (scheduled) {
      return { agentId: scheduled.agentId, sessionId: `scheduler:${scheduled.id}` };
    }
    const session = this.store.getSessionByConversation(conversationId);
    if (!session) return undefined;
    let sessionId: string;
    if (session.peerId.startsWith("scheduler:")) {
      sessionId = session.peerId;
    } else if (session.channelInstanceId === INTERNAL_MAPPING_CHANNEL) {
      const prefix = `${session.agentId}:`;
      sessionId = session.peerId.startsWith(prefix)
        ? session.peerId.slice(prefix.length)
        : session.peerId;
    } else {
      sessionId = `${session.channelInstanceId}:${session.peerId}`;
    }
    return { agentId: session.agentId, sessionId };
  }

  public isConversationBusy(conversationId: string): boolean {
    const resolved = this.resolveConversationSession(conversationId);
    return resolved ? this.isBusy(resolved.agentId, resolved.sessionId) : false;
  }

  /** 管理台按 conversationId 手动压缩（真实渠道 / sentinel / scheduler 统一入口）。 */
  public async compactConversation(conversationId: string, instructions?: string): Promise<CompactionOutcome> {
    const resolved = this.resolveConversationSession(conversationId);
    if (!resolved) throw new ConversationMissing(conversationId);
    return this.compactSession(resolved.agentId, resolved.sessionId, instructions);
  }

  private async runManualCompaction(
    agentId: string,
    sessionId: string,
    conv: Conversation,
    instructions?: string,
  ): Promise<CompactionOutcome> {
    if (!this.harness) throw new Error("Agent Harness is not initialized");
    const agent = this.store.getAgent(agentId);
    const contextWindow = agent
      ? this.modelContextWindow(agent.model.provider, agent.model.modelId)
      : 0;
    const outcome = await compactConversationNow({
      harness: this.harness,
      conversation: conv,
      conversationId: String(conv.id),
      agentId,
      sessionId,
      policy: this.contextPolicy,
      profile: "manual",
      trigger: "manual",
      contextWindow,
      instructions,
      telemetry: getContextTelemetry(),
      store: this.store,
    });
    EventBus.getInstance().publish({
      type: "context.compacted",
      agentId,
      sessionId,
      conversationId: String(conv.id),
      trigger: "manual",
      status: outcome.status,
      beforeTokens: outcome.beforeTokens,
      afterTokens: outcome.afterTokens,
      durationMs: outcome.durationMs,
      costUsd: outcome.costUsd,
    });
    logger.info(
      "AgentManager",
      `Manual compaction for ${agentId}:${sessionId}: ${outcome.status} (${outcome.beforeTokens ?? "?"} → ${outcome.afterTokens ?? "?"})`,
    );
    return outcome;
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
