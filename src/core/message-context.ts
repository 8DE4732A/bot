import type { UserInput } from "@earendil-works/pi-durable";

/** 用户消息附带的事实型上下文：只告知，不写指令。 */
export interface MessageContextFacts {
  /** 消息触发时间（epoch ms） */
  messageTime: number;
  /** 额外事实（如未来「用户位置」），键值会逐行渲染 */
  extra?: Record<string, string>;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/** 本地时间 + UTC 偏移，精确到秒：2026-11-01 15:11:23 +08:00 */
export function formatMessageTime(timestamp: number): string {
  const date = new Date(timestamp);
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const offset = `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${offset}`
  );
}

function cleanFact(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim().slice(0, 500);
}

/**
 * `<context>消息时间: ...</context>`；有额外事实时展开为多行。
 * 不包含任何提示/指令，保持上下文事实中立。
 */
export function formatMessageContext(facts: MessageContextFacts): string {
  const lines = [`消息时间: ${formatMessageTime(facts.messageTime)}`];
  for (const [key, value] of Object.entries(facts.extra ?? {})) {
    const cleaned = cleanFact(String(value ?? ""));
    if (cleaned) lines.push(`${key}: ${cleaned}`);
  }
  return lines.length === 1 ? `<context>${lines[0]}</context>` : `<context>\n${lines.join("\n")}\n</context>`;
}

/** 把 context 块前置到用户消息（字符串或 content parts）。 */
export function withMessageContext(content: UserInput, contextText: string): UserInput {
  if (typeof content === "string") {
    return content ? `${contextText}\n\n${content}` : contextText;
  }
  const parts = [...content];
  const first = parts[0];
  if (first && first.type === "text") {
    parts[0] = { ...first, text: first.text ? `${contextText}\n\n${first.text}` : contextText };
  } else {
    parts.unshift({ type: "text", text: contextText });
  }
  return parts;
}
