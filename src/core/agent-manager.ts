import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  AssistantEntry,
  createRegistry,
  Harness,
  watchEvents,
} from "@earendil-works/pi-durable";
import type { AgentEventStream, Conversation, ConversationId, Harness as HarnessType } from "@earendil-works/pi-durable";
import type { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { DatabaseStore, type AgentDefinition } from "../config/database-store.ts";
import { getBotPaths } from "../config/env-paths.ts";
import { SandboxedExecutionEnv } from "../sandbox/execution-env.ts";
import { SkillRegistry } from "../skills/registry.ts";
import { logger } from "../utils/logger.ts";
import { ModelFactory } from "./model-factory.ts";

import type { MutableModels } from "@earendil-works/pi-ai/models";

export interface ChatChunk {
  delta?: string;
  toolCall?: {
    name: string;
    status: string;
  };
}

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

const configFingerprint = (a: AgentDefinition) =>
  [
    a.model.provider,
    a.model.modelId,
    a.model.thinkingLevel,
    a.instructions,
    a.workspaceDir,
    [...a.skills].sort().join(","),
  ].join("|");

export class AgentManager {
  private static instance?: AgentManager;
  private harness?: HarnessType;
  private models?: MutableModels;
  private storage?: SqliteStorage;
  private store: DatabaseStore;
  private conversations = new Map<string, ConvCache>();
  private conversationToAgent = new Map<string, string>();
  /** 同一会话的互斥队列: 保证串行处理, 避免 watch 流回调互踩与会话双重创建 */
  private sessionLocks = new Map<string, Promise<unknown>>();

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
this.models.clearProviders();
    const providers = this.store.listModelProviders();
    for (const p of providers) {
      try {
        const providerInstance = ModelFactory.buildProviderInstance(p);
        this.models.setProvider(providerInstance);
        logger.info("AgentManager", `Reloaded BYOK provider: ${p.id} (${p.models.length} models)`);
      } catch (err) {
        logger.warn("AgentManager", `Failed to reload provider ${p.id}: ${err}`);
      }
    }
  }

  public async init(cwd: string = process.cwd()): Promise<void> {
    if (this.harness) return;

    const paths = getBotPaths(cwd);
    logger.info("AgentManager", `Initializing Agent Harness with conversations DB at ${paths.conversationsDbFile}`);

    // 会话状态机独立分库: 与业务库 (bot.sqlite) 物理隔离, 由 pi-durable 全权管理
    const storage = await openNodeSqliteStorage(paths.conversationsDbFile);
    this.storage = storage;
    this.models = ModelFactory.createConfiguredModels();

    const registry = createRegistry();
    const allSkills = SkillRegistry.getInstance().listSkills();
    for (const skill of allSkills) {
      registry.install(skill.extension);
    }

    this.harness = await Harness.open(
      storage,
      {
        models: this.models,
        registry,
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

    this.harness.resume();
    logger.info("AgentManager", "Agent Harness successfully initialized and resumed");
  }

  /** 进程退出前收尾: 先 join 运行中的 Harness 任务再 checkpoint 会话库 (WAL 收敛)。 */
  public async shutdown(): Promise<void> {
    try {
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
    if (!this.harness) throw new Error("AgentManager is not initialized");

    const cacheKey = sessionKey(agentId, sessionId);
    let cached = this.conversations.get(cacheKey);

    const agent = this.store.getAgent(agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);

    const agentSkills = SkillRegistry.getInstance().resolveExtensions(agent.skills);

    if (!cached) {
      // Check if session mapping exists
      const sessionRecord = this.store.getSession(MAPPING_CHANNEL, cacheKey);

      if (sessionRecord) {
        // 框架契约: conversation 对不存在的记录返回 undefined (而非抛错)。
        // undefined → 映射失效 (如会话库被重置), 新建会话并覆盖映射, 可自愈;
        // 抛错则是瞬时/底层存储错误, 不能静默新建覆盖用户历史, 直接上抛。
        const existing = await this.harness.conversation(
          Number(sessionRecord.conversationId) as ConversationId,
          BACKGROUND_CONTEXT,
        );
        if (existing) {
          cached = { conv: existing, configFp: configFingerprint(agent) };
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

  public async chat(
    agentId: string,
    sessionId: string,
    userMessage: string,
    onChunk?: (chunk: ChatChunk) => void,
  ): Promise<string> {
    return this.withSessionLock(`${agentId}:${sessionId}`, () =>
      this.chatLocked(agentId, sessionId, userMessage, onChunk),
    );
  }

  private async chatLocked(
    agentId: string,
    sessionId: string,
    userMessage: string,
    onChunk?: (chunk: ChatChunk) => void,
  ): Promise<string> {
    const conv = await this.getOrCreateConversation(agentId, sessionId);
    const context = BACKGROUND_CONTEXT;

    // Attach the framework's typed event stream (watchEvents) for streaming output;
    // 不再读取 pi.live 内部文档结构, 框架升级时由编译期类型兜底
    let watch: AgentEventStream | undefined;
    let lastRenderedText = "";

    if (onChunk) {
      try {
        watch = await watchEvents(this.harness!, conv.id, context);
        let lastToolEvent = "";
        watch.start(async (events) => {
          for (const e of events) {
            if (e.type === "message_update") {
              for (const change of e.changes) {
                if (change.type === "text_delta") {
                  lastRenderedText += change.delta;
                  onChunk({ delta: change.delta });
                }
              }
            } else if (e.type === "tool_execution_start" || e.type === "tool_execution_update") {
              if (lastToolEvent !== `${e.toolName}:running`) {
                lastToolEvent = `${e.toolName}:running`;
                onChunk({ toolCall: { name: e.toolName, status: "running" } });
              }
            } else if (e.type === "tool_execution_end") {
              if (lastToolEvent !== `${e.toolName}:done`) {
                lastToolEvent = `${e.toolName}:done`;
                onChunk({ toolCall: { name: e.toolName, status: "done" } });
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
        { type: "input", content: userMessage },
        context,
      );

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
        if (onChunk) {
          if (fullText.startsWith(lastRenderedText)) {
            if (fullText.length > lastRenderedText.length) {
              onChunk({ delta: fullText.slice(lastRenderedText.length) });
            }
          } else if (fullText) {
            onChunk({ delta: `\n${fullText}` });
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

  /** 中止该会话正在进行的生成 (SSE 客户端断开 / 用户取消)。会话未缓存则无事发生。 */
  public async abortSession(agentId: string, sessionId: string): Promise<void> {
    const cached = this.conversations.get(sessionKey(agentId, sessionId));
    if (!cached) return;
    try {
      await cached.conv.abort(BACKGROUND_CONTEXT);
      logger.info("AgentManager", `Aborted active generation for ${agentId}:${sessionId}`);
    } catch (err) {
      logger.warn("AgentManager", `Abort failed for ${agentId}:${sessionId}: ${err}`);
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
