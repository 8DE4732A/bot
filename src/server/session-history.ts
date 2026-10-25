import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
  Conversation,
  ConversationId,
  EntryRecord,
  Harness as HarnessType,
} from "@earendil-works/pi-durable";
import type { Message } from "@earendil-works/pi-ai";

/**
 * 会话历史读取器（四期 M3）。
 *
 * conversations.sqlite 是 pi-durable 私有存储：这里只通过 Harness/Conversation
 * 的版本化 API 读取当前活动 transcript，不再直接解析 entries 表或依赖 record 形态。
 */

export interface SessionMessage {
  role: "user" | "assistant" | "tool" | "handoff";
  text: string;
  toolName?: string;
  /** 该条目内部的顺序 */
  seq: number;
}

export interface ConversationHistory {
  conversationId: number;
  messages: SessionMessage[];
  /** 条目数超出 limit 被截断 (取最近的) */
  truncated: boolean;
}

export interface SessionSearchHit {
  conversationId: number;
  snippet: string;
}

/** toolResult 文本截断 (会话浏览页只做概览, 全文点开价值低) */
const TOOL_RESULT_MAX_CHARS = 400;
const SEARCH_SNIPPET_RADIUS = 60;
const SEARCH_SCAN_PER_CONVERSATION = 2_000;

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { text: string } => {
      return Boolean(
        part &&
          typeof part === "object" &&
          "text" in part &&
          typeof (part as { text?: unknown }).text === "string",
      );
    })
    .map((part) => part.text)
    .join("");
}

function describeMessage(message: Message, seq: number): SessionMessage | undefined {
  const text = textOfContent(message.content);
  if (!text.trim()) return undefined;
  if (message.role === "user") return { role: "user", text, seq };
  if (message.role === "assistant") return { role: "assistant", text, seq };
  if (message.role === "toolResult") {
    return {
      role: "tool",
      text: text.slice(0, TOOL_RESULT_MAX_CHARS),
      toolName: message.toolName,
      seq,
    };
  }
  return undefined;
}

/** 将框架 EntryRecord 映射为管理台时间线；模型不可见条目降级为 handoff 标记。 */
function entriesToMessages(entries: readonly EntryRecord[], seqStart = 0): SessionMessage[] {
  const messages: SessionMessage[] = [];
  let seq = seqStart;
  for (const entry of entries) {
    const model = entry.model;
    if (!model || model.length === 0) {
      messages.push({ role: "handoff", text: "Context handoff (上下文已压缩)", seq: seq++ });
      continue;
    }
    for (const message of model) {
      const described = describeMessage(message, seq);
      if (described) {
        messages.push(described);
        seq++;
      }
    }
  }
  return messages;
}

async function openConversation(
  harness: HarnessType | undefined,
  conversationId: number,
): Promise<Conversation | undefined> {
  if (!harness || !Number.isInteger(conversationId) || conversationId <= 0) return undefined;
  try {
    return await harness.conversation(conversationId as ConversationId, BACKGROUND_CONTEXT);
  } catch {
    return undefined;
  }
}

/**
 * 读取当前活动 transcript。`context()` 负责 head / reset / fork ancestry 的框架语义；
 * 管理台只做展示层截断，不自行判断行可见性。
 */
export async function readConversationHistory(
  conversationId: number,
  harness?: HarnessType,
  limit = 400,
): Promise<ConversationHistory> {
  const conversation = await openConversation(harness, conversationId);
  if (!conversation) return { conversationId, messages: [], truncated: false };
  try {
    const view = await conversation.context(BACKGROUND_CONTEXT);
    const bounded = Math.max(1, Math.min(limit, 2_000));
    const entries = view.entries.slice(-bounded);
    return {
      conversationId,
      messages: entriesToMessages(entries),
      truncated: view.entries.length > entries.length,
    };
  } catch {
    return { conversationId, messages: [], truncated: false };
  }
}

function searchableText(entry: EntryRecord): string {
  const parts = (entry.model ?? []).map((message) => textOfContent(message.content));
  if (entry.data !== undefined) parts.push(JSON.stringify(entry.data));
  return parts.join("\n");
}

function snippetAround(text: string, needle: string): string {
  const index = text.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase());
  if (index < 0) return text.slice(0, SEARCH_SNIPPET_RADIUS * 2);
  const start = Math.max(0, index - SEARCH_SNIPPET_RADIUS);
  const end = Math.min(text.length, index + needle.length + SEARCH_SNIPPET_RADIUS);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

/**
 * 在给定会话的当前活动 transcript 中搜索。候选会话来自业务库的 channel_sessions，
 * 内容读取仍只经 Conversation.entries；历史遍历有上限，避免管理台查询拖垮常驻进程。
 */
export async function searchConversations(
  query: string,
  harness?: HarnessType,
  conversationIds: readonly number[] = [],
  limit = 50,
): Promise<SessionSearchHit[]> {
  const needle = query.trim();
  if (!needle || !harness || conversationIds.length === 0) return [];
  const maxHits = Math.max(1, Math.min(limit, 200));
  const hits: SessionSearchHit[] = [];

  for (const conversationId of new Set(conversationIds)) {
    if (hits.length >= maxHits) break;
    const conversation = await openConversation(harness, conversationId);
    if (!conversation) continue;
    try {
      let cursor: Parameters<Conversation["entries"]>[2];
      let scanned = 0;
      let matched: string | undefined;
      do {
        const page = await conversation.entries(
          { order: "descending" },
          Math.min(100, SEARCH_SCAN_PER_CONVERSATION - scanned),
          cursor,
          BACKGROUND_CONTEXT,
        );
        scanned += page.items.length;
        for (const entry of page.items) {
          const text = searchableText(entry);
          if (text.toLocaleLowerCase().includes(needle.toLocaleLowerCase())) {
            matched = snippetAround(text, needle);
            break;
          }
        }
        cursor = page.next;
      } while (!matched && cursor !== undefined && scanned < SEARCH_SCAN_PER_CONVERSATION);
      if (matched !== undefined) hits.push({ conversationId, snippet: matched });
    } catch {
      // 单个会话损坏不应阻断整个搜索结果。
    }
  }
  return hits;
}
