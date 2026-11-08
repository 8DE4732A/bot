import {
  ToolResultEntry,
  type ConversationView,
  type EntryRecord,
  type LiveState,
} from "@earendil-works/pi-durable";
import { textOfContent } from "./message-content.ts";

/**
 * pi-durable 1.5.0 的流式状态归约器。
 *
 * `watchEvents()` 在 1.5.0 已删除，官方模型改为「渲染状态」：
 * `harness.observeConversation()` / `conversation.watch()` 返回 `ConversationView`，
 * 流式回答在 `docs["pi.live"].generation.message`，工具状态在
 * `docs["pi.live"].tools`，压缩在 `docs["pi.live"].compactions` / `compactionFailure`。
 *
 * 这里把 view 的连续快照归约成 agent-manager 需要的增量（文本 delta、
 * 工具状态、压缩任务起止、新 entries）。归约器不碰数据库/网络，便于单测。
 */
export interface ToolStatusUpdate {
  name: string;
  status: string;
}

export interface CompactionStart {
  taskId: string;
  trigger: string;
  at: number;
}

export interface CompactionEnd {
  taskId: string;
  trigger: string;
  at: number;
  error?: string;
}

export interface TurnViewChanges {
  /** 本次新出现的 transcript 条目（按 id 递增） */
  entries: EntryRecord[];
  /** 本轮新增的可见文本（可直接作为 ChatChunk.delta） */
  textDelta?: string;
  /** 工具状态变化（只输出 running/done，pending 不展示） */
  toolUpdates: ToolStatusUpdate[];
  compactionStarts: CompactionStart[];
  compactionEnds: CompactionEnd[];
  /** 本轮首次出现 text/thinking/toolCall token */
  firstTokenSeen: boolean;
}

export interface TurnViewState {
  /** 已处理的最大 entry id；attach 时用首值做基线，之前的历史不重复消费 */
  lastEntryId?: number;
  /** 当前 generation 的身份（run task + attempt + message timestamp） */
  generationKey?: string;
  /** 当前 generation 已见过的文本，用于计算增量 */
  generationText: string;
  /** 本轮是否已经输出过文本（generation 之间可能隔着无消息的 commit，不能只看 generationText） */
  emittedAnyText: boolean;
  /** 新 generation 的首个非空 text 前需要补分隔换行（首帧只有 thinking 时不能丢） */
  needsSeparator: boolean;
  /** 已展示的工具状态与名称，按 callId */
  tools: Map<string, { status: string; name: string }>;
  /** 正在进行的压缩任务，按 durable task id；attach 前已存在的不属于本轮 */
  compactions: Map<string, { trigger: string; at: number; preexisting: boolean }>;
  firstTokenSeen: boolean;
}

export function createTurnViewState(): TurnViewState {
  return {
    generationText: "",
    emittedAnyText: false,
    needsSeparator: false,
    tools: new Map(),
    compactions: new Map(),
    firstTokenSeen: false,
  };
}

/** `docs` 的公开键；`LiveState` 是 1.5.0 主入口导出的类型化结构。 */
function liveStateOf(view: ConversationView): LiveState | undefined {
  const live = view.docs["pi.live"];
  return live ? (live as unknown as LiveState) : undefined;
}

type ContentPart = { type?: unknown; text?: unknown; thinking?: unknown };

function contentParts(message: unknown): ContentPart[] {
  const content = (message as { content?: unknown } | undefined)?.content;
  return Array.isArray(content) ? (content as ContentPart[]) : [];
}

/** 只取可见 text block；thinking 不进入用户可见流（与旧 watchEvents 行为一致）。 */
function messageText(message: unknown): string {
  return textOfContent((message as { content?: unknown } | undefined)?.content);
}

function hasToken(message: unknown): boolean {
  for (const part of contentParts(message)) {
    if (part.type === "toolCall") return true;
    if (part.type === "text" && typeof part.text === "string" && part.text.length > 0) return true;
    if (part.type === "thinking" && typeof part.thinking === "string" && part.thinking.length > 0) {
      return true;
    }
  }
  return false;
}

/** 每个 generation 一个稳定身份；tool round 之间 taskId/attempt 会变化。 */
function generationKeyOf(live: LiveState | undefined, message: unknown): string | undefined {
  if (!message || !live?.generation) return undefined;
  const timestamp = (message as { timestamp?: unknown }).timestamp;
  return [
    live.run?.taskId ?? "",
    live.generation.attempt ?? "",
    typeof timestamp === "number" ? timestamp : "",
  ].join(":");
}

/**
 * attach 时用当前 view 做基线：历史 entries、已有工具/压缩状态都不重复上报。
 * observer 的 `value` 是同步快照，attach 之后不会再有“start 前 pending 帧”的情况。
 * 已存在的 compaction 标记 preexisting：它属于上一轮，结束时不能写进本轮指标。
 */
export function seedTurnView(state: TurnViewState, view: ConversationView, now = Date.now()): void {
  const last = view.entries.at(-1);
  state.lastEntryId = last === undefined ? undefined : Number(last.id);

  const live = liveStateOf(view);
  for (const slot of live?.tools ?? []) {
    state.tools.set(slot.callId, { status: slot.status, name: slot.name });
  }
  for (const compaction of live?.compactions ?? []) {
    const taskId = String(compaction.taskId);
    // observer 可能在 attach promise resolve 前已经 advance 过：那属于本轮，不能标 preexisting
    if (state.compactions.has(taskId)) continue;
    state.compactions.set(taskId, {
      trigger: compaction.trigger,
      at: now,
      preexisting: true,
    });
  }

  const message = live?.generation?.message;
  if (message) {
    state.generationKey = generationKeyOf(live, message);
    state.generationText = messageText(message);
    state.emittedAnyText = state.generationText.length > 0;
    state.firstTokenSeen = hasToken(message);
  }
}

/** 把一次 view 快照归约为增量；view 的多次 commit 可能已被框架折叠。 */
export function reduceTurnView(
  state: TurnViewState,
  view: ConversationView,
  now = Date.now(),
): TurnViewChanges {
  const live = liveStateOf(view);
  const changes: TurnViewChanges = {
    entries: [],
    toolUpdates: [],
    compactionStarts: [],
    compactionEnds: [],
    firstTokenSeen: false,
  };

  // 1. transcript 新条目：按 id 增量，窗口丢旧条目也不影响（只处理更新的）。
  for (const entry of view.entries) {
    const id = Number(entry.id);
    if (state.lastEntryId !== undefined && id <= state.lastEntryId) continue;
    changes.entries.push(entry);
    state.lastEntryId = id;

    // 兜底：非常快的工具可能在两次 view 之间完成，live.tools 里已经看不到 running。
    // 结果条目本身带 toolCallId/toolName，补一个 done，避免 TUI/Web 工具轨迹整段缺失。
    if (ToolResultEntry.is(entry)) {
      const result = entry.model?.[0];
      if (result?.role === "toolResult" && state.tools.get(result.toolCallId)?.status !== "done") {
        state.tools.set(result.toolCallId, { status: "done", name: result.toolName });
        changes.toolUpdates.push({ name: result.toolName, status: "done" });
      }
    }
  }

  // 2. 流式回答：generation 变化时另起一段；同一 generation 内做前缀差分。
  // 新 generation 的首帧可能只有 thinking（可见 text 为空），分隔换行必须挂起，
  // 等第一个非空 text delta 再补，否则最终回答会被重复发送一遍。
  const message = live?.generation?.message;
  if (message) {
    const key = generationKeyOf(live, message);
    if (state.generationKey !== key) {
      state.generationKey = key;
      state.generationText = "";
      state.needsSeparator = state.emittedAnyText;
    }
    const text = messageText(message);
    if (text.startsWith(state.generationText)) {
      let delta = text.slice(state.generationText.length);
      if (delta && state.needsSeparator) {
        delta = `\n${delta}`;
        state.needsSeparator = false;
      }
      if (delta) changes.textDelta = delta;
      state.generationText = text;
    } else if (text) {
      // 重试/重写（罕见）：provider 可能在 text_end 替换文本。此时 generationKey
      // 不变但内容不再以旧文本为前缀，必须另起一行发完整当前文本；只看
      // needsSeparator 会漏掉“已经流过字、同 generation 被改写”的情况。
      const separator = state.needsSeparator || state.emittedAnyText;
      changes.textDelta = separator ? `\n${text}` : text;
      state.needsSeparator = false;
      state.generationText = text;
    }
    if (changes.textDelta) state.emittedAnyText = true;
    if (!state.firstTokenSeen && hasToken(message)) {
      state.firstTokenSeen = true;
      changes.firstTokenSeen = true;
    }
  } else {
    state.generationKey = undefined;
    state.generationText = "";
  }

  // 3. 工具状态：只上报 running/done（pending 是顺序轮的占位，旧事件流不展示）。
  // 已上报的状态保留整轮：slot 消失后结果条目仍可能晚一个 view 到达，
  // 保留 done 可避免重复上报，也避免滞后的 running 覆盖。
  const liveTools = new Set<string>();
  for (const slot of live?.tools ?? []) {
    liveTools.add(slot.callId);
    const previous = state.tools.get(slot.callId);
    if (previous?.status === slot.status) continue;
    // 结果条目已补过 done，不允许被滞后的 running 覆盖
    if (previous?.status === "done" && slot.status !== "done") continue;
    state.tools.set(slot.callId, { status: slot.status, name: slot.name });
    if (slot.status === "running" || slot.status === "done") {
      changes.toolUpdates.push({ name: slot.name, status: slot.status });
    }
  }
  // slot 消失时补 done：tool fault/orphan 没有 ToolResultEntry，且 done 与删除
  // 可能被折叠进同一个 view；不补的话 TUI/Web 工具轨迹会永久卡在 running。
  for (const [callId, tracked] of [...state.tools]) {
    if (liveTools.has(callId)) continue;
    if (tracked.status === "running") {
      state.tools.set(callId, { status: "done", name: tracked.name });
      changes.toolUpdates.push({ name: tracked.name, status: "done" });
    } else if (tracked.status === "pending") {
      state.tools.delete(callId);
    }
  }

  // 4. 压缩任务：出现/消失即起止；失败原因从 compactionFailure（字段是 trigger）。
  // seed 时已存在的 compaction 属于上一轮，消失时不产生本轮的 start/end。
  const liveCompactions = new Set<string>();
  for (const compaction of live?.compactions ?? []) {
    const taskId = String(compaction.taskId);
    liveCompactions.add(taskId);
    if (!state.compactions.has(taskId)) {
      state.compactions.set(taskId, { trigger: compaction.trigger, at: now, preexisting: false });
      changes.compactionStarts.push({ taskId, trigger: compaction.trigger, at: now });
    }
  }
  for (const [taskId, tracked] of [...state.compactions]) {
    if (liveCompactions.has(taskId)) continue;
    state.compactions.delete(taskId);
    if (tracked.preexisting) continue;
    const failure =
      live?.compactionFailure && String(live.compactionFailure.taskId) === taskId
        ? live.compactionFailure
        : undefined;
    changes.compactionEnds.push({
      taskId,
      trigger: failure?.trigger ?? tracked.trigger,
      at: now,
      error: failure?.error,
    });
  }

  return changes;
}
