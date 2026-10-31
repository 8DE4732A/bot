/**
 * QQ 协议纯函数（无网络/无状态）：close code 分类、被动回复窗口、
 * 引用消息解析、语音判定、文本/ markdown 请求体。
 */

export type QQCloseAction =
  | "fatal"
  | "refresh-token"
  | "reset-session"
  | "rate-limit"
  | "reconnect";

const FATAL = new Set([4001, 4002, 4010, 4011, 4012, 4013, 4014, 4914, 4915]);
const RESET_SESSION = new Set([4006, 4007]);
const RATE_LIMIT = new Set([4008]);

export function classifyQQCloseCode(code: number): QQCloseAction {
  if (FATAL.has(code)) return "fatal";
  if (code === 4004) return "refresh-token";
  if (RESET_SESSION.has(code) || (code >= 4900 && code <= 4913)) return "reset-session";
  if (RATE_LIMIT.has(code)) return "rate-limit";
  // 4009 可 Resume，与普通重连同路径（有 sessionId/lastSeq 时 connectGateway 自动 Resume）
  return "reconnect";
}

/** 被动回复窗口：单聊 60 分钟 / 群聊 5 分钟 */
export function passiveWindowMs(chatType: "c2c" | "group"): number {
  return chatType === "group" ? 5 * 60_000 : 60 * 60_000;
}

/** 窗口判断预留 5s 安全余量（网络/排队延迟） */
export function isPassiveWindowOpen(
  receivedAt: number | undefined,
  chatType: "c2c" | "group",
  now: number,
): boolean {
  if (!receivedAt) return false;
  return now - receivedAt < passiveWindowMs(chatType) - 5_000;
}

export function isVoiceAttachment(contentType: string, filename?: string): boolean {
  const ct = contentType.toLowerCase();
  if (ct.includes("audio") || ct.includes("voice") || ct.includes("silk")) return true;
  return /\.(silk|amr|wav|mp3|m4a|ogg|aac)$/i.test(filename ?? "");
}

/** QQ 语音优先用平台预转 WAV（voice_wav_url），否则回退原始 URL */
export function pickVoiceUrl(att: any): string | undefined {
  const wav = String(att?.voice_wav_url ?? "").trim();
  const url = String(att?.url ?? "").trim();
  const pick = wav || url;
  return pick ? normalizeQQUrl(pick) : undefined;
}

export function normalizeQQUrl(url: string): string {
  return url.startsWith("http") ? url : url.startsWith("//") ? `https:${url}` : `https://${url}`;
}

/**
 * 解析引用消息（message_type=103, msg_elements[]）：
 * 文本拼接 + 引用内附件（交给调用方下载并计入 4 个上限）。
 * 纯函数只做结构提取，不下载。
 */
export function parseQuotedElements(elements: unknown): {
  text: string;
  attachments: any[];
} {
  if (!Array.isArray(elements) || elements.length === 0) {
    return { text: "", attachments: [] };
  }
  const texts: string[] = [];
  const attachments: any[] = [];
  for (const element of elements) {
    if (!element || typeof element !== "object") continue;
    const content = String((element as any).content ?? "").trim();
    if (content) texts.push(content);
    const list = (element as any).attachments;
    if (Array.isArray(list)) {
      for (const att of list) {
        if (att && typeof att === "object") attachments.push(att);
      }
    }
  }
  return { text: texts.join(" "), attachments };
}

export interface QQTextBodyInput {
  content: string;
  markdown: boolean;
  msgSeq: number;
  replyTo?: string;
}

export function buildQQTextBody(input: QQTextBodyInput): Record<string, unknown> {
  const text = input.content.slice(0, 4_000);
  if (input.markdown) {
    return {
      markdown: { content: text },
      msg_type: 2,
      msg_seq: input.msgSeq,
      ...(input.replyTo ? { msg_id: input.replyTo } : {}),
    };
  }
  return {
    content: text,
    msg_type: 0,
    msg_seq: input.msgSeq,
    ...(input.replyTo ? { msg_id: input.replyTo } : {}),
  };
}
