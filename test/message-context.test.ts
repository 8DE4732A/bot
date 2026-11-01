import { describe, expect, test } from "bun:test";
import {
  formatMessageContext,
  formatMessageTime,
  withMessageContext,
} from "../src/core/message-context.ts";

const MESSAGE_TIME = new Date(2026, 10, 1, 15, 11, 23).getTime();

describe("message context", () => {
  test("格式化本地时间 + UTC 偏移，精确到秒", () => {
    const formatted = formatMessageTime(MESSAGE_TIME);
    expect(formatted).toMatch(/^2026-11-01 15:11:23 [+-]\d{2}:\d{2}$/);
  });

  test("默认单行 <context>，不带指令", () => {
    const context = formatMessageContext({ messageTime: MESSAGE_TIME });
    expect(context).toMatch(/^<context>消息时间: 2026-11-01 15:11:23 [+-]\d{2}:\d{2}<\/context>$/);
  });

  test("额外事实展开为多行", () => {
    const context = formatMessageContext({
      messageTime: MESSAGE_TIME,
      extra: { 用户位置: "上海", 来源: "微信" },
    });
    expect(context).toMatch(/^<context>\n消息时间: 2026-11-01 15:11:23 [+-]\d{2}:\d{2}\n用户位置: 上海\n来源: 微信\n<\/context>$/);
  });

  test("字符串消息前置 context", () => {
    const content = withMessageContext("上海的天气怎么样？", "<context>消息时间: 2026-11-01 15:11:23 +08:00</context>");
    expect(content).toBe("<context>消息时间: 2026-11-01 15:11:23 +08:00</context>\n\n上海的天气怎么样？");
  });

  test("文本 content parts 合并到首个 text block", () => {
    const content = withMessageContext(
      [{ type: "text", text: "看图" }],
      "<context>消息时间: 2026-11-01 15:11:23 +08:00</context>",
    ) as { type: string; text?: string }[];
    expect(content).toHaveLength(1);
    expect(content[0]!.text).toBe("<context>消息时间: 2026-11-01 15:11:23 +08:00</context>\n\n看图");
  });

  test("图片开头时插入 text block", () => {
    const content = withMessageContext(
      [{ type: "image", data: "abc", mimeType: "image/png" }],
      "<context>消息时间: 2026-11-01 15:11:23 +08:00</context>",
    ) as { type: string; text?: string }[];
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({
      type: "text",
      text: "<context>消息时间: 2026-11-01 15:11:23 +08:00</context>",
    });
    expect(content[1]!.type).toBe("image");
  });
});
