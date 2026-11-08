/**
 * 从消息 content（string 或 content blocks）提取可见文本。
 * 只取带 string `text` 字段的 block（text block）；thinking/toolCall/image 不进入。
 * 会话历史、live-view 流式归约、最终回答对账共用，避免三处分叉。
 */
export function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const part of content) {
    if (
      part &&
      typeof part === "object" &&
      typeof (part as { text?: unknown }).text === "string"
    ) {
      text += (part as { text: string }).text;
    }
  }
  return text;
}
