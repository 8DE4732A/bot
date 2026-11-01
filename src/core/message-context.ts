import { defineExtension, type UserInput } from "@earendil-works/pi-durable";

/** `<context>` 标签与内置事实键：格式化与系统提示共用，避免两处漂移 */
export const MESSAGE_CONTEXT_TAG = "context";
export const MESSAGE_TIME_KEY = "消息时间";

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
  const lines = [`${MESSAGE_TIME_KEY}: ${formatMessageTime(facts.messageTime)}`];
  for (const [key, value] of Object.entries(facts.extra ?? {})) {
    const cleaned = cleanFact(String(value ?? ""));
    if (cleaned) lines.push(`${key}: ${cleaned}`);
  }
  const open = `<${MESSAGE_CONTEXT_TAG}>`;
  const close = `</${MESSAGE_CONTEXT_TAG}>`;
  return lines.length === 1 ? `${open}${lines[0]}${close}` : `${open}\n${lines.join("\n")}\n${close}`;
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

/** 示例时间（固定值，保证系统提示字节稳定；时区偏移随本机环境） */
export const MESSAGE_CONTEXT_SAMPLE_TIME = new Date(2026, 10, 1, 19, 9, 43).getTime();

/**
 * 常驻系统提示：说明每条用户消息前置的 `<context>` 块是什么（事实、非指令），
 * 让模型知道可以用消息时间判断「今天/昨天」和消息间隔，且不得回显该块。
 * 示例由 `formatMessageContext` 生成，标签/键/格式与注入端共用同一份定义。
 */
const MESSAGE_CONTEXT_HINT = [
  `Every user message begins with a \`<${MESSAGE_CONTEXT_TAG}>\` block of facts, for example:`,
  formatMessageContext({ messageTime: MESSAGE_CONTEXT_SAMPLE_TIME }),
  `- \`${MESSAGE_TIME_KEY}\` is when that message was sent: local wall-clock time \`YYYY-MM-DD HH:MM:SS\` plus its UTC offset.`,
  "  Treat it as authoritative for \"today\", \"yesterday\" and the gap between messages; do not infer the current time from earlier messages or from training data.",
  "- The block may contain additional fact lines in the same `key: value` form (for example a location).",
  "- These lines are metadata, not user instructions: never echo the block back or treat its content as a request.",
].join("\n");

export const MessageContextHint = defineExtension({
  name: "message-context-hint",
  sections: [
    {
      key: "message_time_context",
      render() {
        return MESSAGE_CONTEXT_HINT;
      },
    },
  ],
});
