import type { MarkdownMode } from "../base.ts";

/**
 * 出站 markdown 降级 (对齐 hermes 各平台 format_message):
 * 平台不支持 markdown 时先转换再分段, 保证纯文本形态可读。
 * - plain (微信 iLink / QQ 默认 / 兜底): 剥代码围栏(保留内容)、表格转行文本、
 *   链接只留文本或 URL、去加粗斜体删除线标记、去标题井号、去图片语法
 * - limited (QQ markdown 需申请, 未开通时同样走 plain): 预留——当前与 plain 一致
 * - full (飞书 post / 企微 markdown / 终端 / Web): 原样
 */

function stripInlineMarks(text: string): string {
  return text
    .replace(/\*\*\*(.+?)\*\*\*/g, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/(?<!\w)\*(?!\s)(.+?)(?<!\s)\*(?!\w)/g, "$1")
    .replace(/(?<![\w\\])_(?!\s)(.+?)(?<!\s)_(?!\w)/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/`([^`\n]+?)`/g, "$1");
}

/** 表格行 → 竖线分隔的行文本 (保留对齐信息, 不试图渲染) */
function convertTableRows(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\|?\s*:?-{2,}.*\|/.test(trimmed) && !trimmed.replace(/[|\s:-]/g, "")) continue; // 分隔行
    out.push(trimmed.replace(/^\||\|$/g, "").split("|").map((c) => c.trim()).join("  |  "));
  }
  return out;
}

export function downgradeMarkdown(content: string, mode: MarkdownMode = "full"): string {
  if (mode === "full") return content;

  const lines = content.split("\n");
  const out: string[] = [];
  let inCode = false;
  let tableBuf: string[] = [];

  const flushTable = () => {
    if (tableBuf.length > 0) {
      out.push(...convertTableRows(tableBuf));
      tableBuf = [];
    }
  };

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      flushTable();
      inCode = !inCode;
      continue; // 剥围栏标记, 内容保留
    }
    if (inCode) {
      out.push(line);
      continue;
    }
    // 表格行收集
    if (/^\s*\|.*\|\s*$/.test(line)) {
      tableBuf.push(line);
      continue;
    }
    flushTable();
    let l = line
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // 图片 → alt 文本
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text: string, url: string) =>
        text && text !== url ? `${text} (${url})` : url,
      ) // 链接 → 文本 (URL)
      .replace(/^\s{0,3}#{1,6}\s+/, "") // 标题井号
      .replace(/^\s*>\s?/, ""); // 引用标记
    l = stripInlineMarks(l);
    out.push(l);
  }
  flushTable();
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
