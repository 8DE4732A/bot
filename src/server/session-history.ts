import { DatabaseSync } from "node:sqlite";
import { getBotPaths } from "../config/env-paths.ts";

/**
 * 会话历史只读读取器 (四期 M3, 设计 §6.2 #1):
 * conversations.sqlite 是 pi-durable 专属库——业务代码**绝不写入**,
 * 这里只做 readonly SELECT (框架无删除/查询 API, 会话浏览页的边界即"仅读")。
 * entries.record.model = 该条目贡献给模型上下文的消息数组 (与 AgentManager
 * 的 watchEvents 同一记录形态)。
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

/** toolResult 文本截断 (会话浏览页只做概览, 全文点开价值低) */
const TOOL_RESULT_MAX_CHARS = 400;

interface EntryRecord {
  model?: {
    role?: string;
    content?: string | { type?: string; text?: string }[];
    toolName?: string;
    timestamp?: number;
  }[];
  kind?: string;
}

/** 从 entry record 提取消息 (压缩条目无 model → 降级为 handoff 行由前端呈现) */
function extractMessages(record: EntryRecord, seqBase: number): { messages: SessionMessage[]; isHandoff: boolean } {
  const model = record.model;
  if (!Array.isArray(model) || model.length === 0) {
    return { messages: [], isHandoff: true };
  }
  const messages: SessionMessage[] = [];
  for (const msg of model) {
    const role = msg.role;
    const content = msg.content;
    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter((part) => part?.type === "text" || typeof part?.text === "string")
        .map((part) => part.text ?? "")
        .join("");
    }
    // thinking 等非文本内容已过滤 (渐进披露: 浏览页只看对话面)
    if (!text.trim()) continue;
    if (role === "user") {
      messages.push({ role: "user", text, seq: seqBase });
    } else if (role === "assistant") {
      messages.push({ role: "assistant", text, seq: seqBase });
    } else if (role === "toolResult") {
      messages.push({
        role: "tool",
        text: text.slice(0, TOOL_RESULT_MAX_CHARS),
        toolName: msg.toolName,
        seq: seqBase,
      });
    }
  }
  return { messages, isHandoff: false };
}

/**
 * 只读连接单例 (R8 simplify F3: 每请求新开 readOnly 连接要付 WAL 挂载
 * 成本——长寿命连接复用; 只读边界不变, 打开失败返回 null 不再重试同请求)。
 */
let readonlyDb: DatabaseSync | undefined;

function getReadonlyDb(): DatabaseSync | undefined {
  if (readonlyDb) return readonlyDb;
  const paths = getBotPaths();
  try {
    readonlyDb = new DatabaseSync(paths.conversationsDbFile, { readOnly: true });
    return readonlyDb;
  } catch {
    // fail-closed (R2 评审 M-11): 只读不可用/库不存在一律空结果,
    // 绝不退化为读写连接 (会产生 WAL/锁, 违反只读边界)
    return undefined;
  }
}

/**
 * 只读读取会话条目。⚠️ head 列语义: head IS NOT NULL 的行是分支头标记
 * (pi-durable readLatestHeadMarker 用, 每会话仅少数几条)——全量条目读取
 * 不过滤 head (框架 readEntries 即 WHERE conversation_id=? ORDER BY id)。
 * 打开失败 (库不存在/锁) 返回空历史, 不抛错——浏览页不阻断。
 */
export function readConversationHistory(conversationId: number, limit = 400): ConversationHistory {
  const paths = getBotPaths();
  const db = getReadonlyDb();
  if (!db) return { conversationId, messages: [], truncated: false };
  try {
    const total = db
      .prepare("SELECT COUNT(*) AS n FROM entries WHERE conversation_id = ?")
      .get(conversationId) as { n: number } | undefined;
    const rows = db
      .prepare(
        `SELECT record FROM entries WHERE conversation_id = ? ORDER BY id ASC LIMIT ? OFFSET ?`,
      )
      .all(conversationId, limit, Math.max(0, (total?.n ?? 0) - limit)) as { record: string }[];
    const messages: SessionMessage[] = [];
    let seq = 0;
    for (const row of rows) {
      let parsed: EntryRecord;
      try {
        parsed = JSON.parse(row.record) as EntryRecord;
      } catch {
        continue;
      }
      const { messages: extracted, isHandoff } = extractMessages(parsed, seq);
      if (isHandoff) {
        // 压缩交接降级为 muted 标记行 (设计 §6.2 #1: Context handoff)
        messages.push({ role: "handoff", text: "Context handoff (上下文已压缩)", seq: seq++ });
        continue;
      }
      for (const m of extracted) m.seq = seq++;
      messages.push(...extracted);
    }
    return {
      conversationId,
      messages,
      truncated: (total?.n ?? 0) > limit,
    };
  } catch {
    readonlyDb = undefined; // 连接失效 (库被删重建): 下次请求重开
    return { conversationId, messages: [], truncated: false };
  }
}

/** 全文搜索 (LIKE 扫 record JSON; 本地规模可接受, LIMIT 50 防深翻) */
export interface SessionSearchHit {
  conversationId: number;
  snippet: string;
}

export function searchConversations(query: string, limit = 50): SessionSearchHit[] {
  if (!query.trim()) return [];
  const paths = getBotPaths();
  const db = getReadonlyDb();
  if (!db) return [];
  try {
    const like = `%${query.replace(/[%_]/g, "")}%`;
    const rows = db
      .prepare(
        `SELECT conversation_id, substr(record, max(1, instr(record, ?) - 60), 160) AS snippet
         FROM entries WHERE record LIKE ? LIMIT ?`,
      )
      .all(query, like, limit) as { conversation_id: number; snippet: string }[];
    return rows.map((r) => ({ conversationId: r.conversation_id, snippet: r.snippet }));
  } catch {
    readonlyDb = undefined;
    return [];
  }
}
