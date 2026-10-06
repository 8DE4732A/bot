import { readFileSync } from "node:fs";
import { logger } from "../utils/logger.ts";

/**
 * 文档型技能 (Agent Skills / SKILL.md): 纯知识/流程型能力, 不执行代码。
 * 注入采用渐进披露——系统提示词里只有目录 (name/description/location),
 * 正文由模型判断任务匹配后用 read 工具自行读取 (路径天然受沙盒 PathGuard 管束)。
 */

/** name 校验对齐 Agent Skills 规范 (目录名即缺省 name) */
const NAME_PATTERN = /^[a-z0-9_-]+$/;

/** 工具描述/技能摘要进入上下文前的截断长度 (防提示注入面过大) */
export const DESCRIPTION_MAX_CHARS = 500;

export interface DocumentSkill {
  /** 技能 id (= 目录名, 也是注册进 SkillRegistry 的扩展名) */
  id: string;
  name: string;
  description: string;
  /** SKILL.md 绝对路径——目录条目中给模型, 供 read 工具读取 */
  location: string;
  /** frontmatter 原始正文 (管理台预览用) */
  body: string;
  /** true = 不进目录 (仅管理台可见, 模型无法自主发现) */
  disableModelInvocation: boolean;
  /** 解析诊断 (description 缺失等) */
  warnings: string[];
}

/**
 * 解析 SKILL.md: YAML frontmatter (--- 界定) + markdown 正文。
 * 只认平铺的 key: value 行 (name/description/disable-model-invocation),
 * 不实现完整 YAML——技能 frontmatter 规范本就只有这几个标量字段。
 */
export function parseSkillMd(dirName: string, absPath: string): DocumentSkill | undefined {
  let raw: string;
  try {
    raw = readFileSync(absPath, "utf-8");
  } catch (err) {
    logger.warn("DocumentSkills", `Failed to read ${absPath}: ${err}`);
    return undefined;
  }

  const warnings: string[] = [];
  let name = dirName;
  let description = "";
  let disableModelInvocation = false;

  // Windows 行尾与 BOM: 后续的行匹配与 frontmatter 界定都假设 \n
  const trimmed = raw.replace(/\r\n/g, "\n").replace(/^﻿/, "");
  let body = trimmed;
  if (trimmed.startsWith("---")) {
    const end = trimmed.indexOf("\n---", 3);
    if (end !== -1) {
      const frontmatterLines = trimmed.slice(3, end).split("\n");
      body = trimmed.slice(end + 4).replace(/^\s*\n/, "");
      for (let i = 0; i < frontmatterLines.length; i++) {
        const line = frontmatterLines[i];
        const m = line.match(/^([A-Za-z_-]+)\s*:\s*(.*)$/);
        if (!m) continue;
        const key = m[1].trim();
        let value = m[2].trim().replace(/^["']|["']$/g, "");
        // YAML 折叠/块标量 (>- / |): Claude Code 官方技能资产的常见多行写法——
        // 拼接后续缩进行 (折叠语义近似: 行间空格连接; 允许空行, 空行后仍继续收集
        // 直到下一个非缩进的顶层 key 或 frontmatter 结束)
        if (value === ">-" || value === ">" || value === "|" || value === "|-") {
          const collected: string[] = [];
          let j = i + 1;
          for (; j < frontmatterLines.length; j++) {
            const cont = frontmatterLines[j];
            if (/^\s+\S/.test(cont)) collected.push(cont.trim());
            else if (/^\s*$/.test(cont) && j + 1 < frontmatterLines.length && /^\s+\S/.test(frontmatterLines[j + 1])) {
              collected.push(""); // 块中间的空行
            } else break;
          }
          i = j - 1;
          if (collected.length > 0) value = collected.filter((l, idx, arr) => l !== "" || (idx > 0 && idx < arr.length - 1)).join(value.startsWith(">") ? " " : "\n");
          else warnings.push(`${key} 使用了 ${value} 折叠块但无缩进内容`);
        }
        if (key === "name" && value) name = value;
        else if (key === "description") description = value;
        else if (key === "disable-model-invocation") disableModelInvocation = value === "true";
      }
    } else {
      warnings.push("frontmatter 未闭合 (-- 缺失), 整个文件按正文处理");
    }
  }

  if (!NAME_PATTERN.test(name)) {
    logger.warn("DocumentSkills", `Skill '${dirName}' name '${name}' invalid; falling back to dir name`);
    name = dirName;
  }
  if (!description) {
    warnings.push("缺少 description——无法进入技能目录, 模型将无法发现该技能");
  }

  return {
    id: dirName,
    name,
    description: description.slice(0, DESCRIPTION_MAX_CHARS),
    location: absPath,
    body,
    disableModelInvocation,
    warnings,
  };
}

/** XML 转义 (对齐 pi core/skills.ts): name/description 是不可信文本, 防止伪造目录条目 */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** 中段截断 (对齐 pi truncateMiddle): 按字节在 UTF-8 字符边界切割, CJK 不超限不切半 */
export function truncateMiddleBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf-8");
  if (buf.length <= maxBytes) return text;
  // 0b10xxxxxx 是 UTF-8 continuation 字节, 回退/前进到字符头
  const isContinuation = (i: number) => (buf[i] & 0xc0) === 0x80;
  let headEnd = Math.floor(maxBytes * 0.7);
  while (headEnd > 0 && isContinuation(headEnd)) headEnd--;
  let tailStart = buf.length - Math.floor(maxBytes * 0.2);
  while (tailStart < buf.length && isContinuation(tailStart)) tailStart++;
  const head = buf.subarray(0, headEnd).toString("utf-8");
  const tail = tailStart < buf.length ? buf.subarray(tailStart).toString("utf-8") : "";
  const omitted = buf.length - headEnd - (buf.length - tailStart);
  return `${head}\n…[truncated ${omitted} bytes]…\n${tail}`;
}

/**
 * 渐进披露目录块 (照抄 pi coding-agent 的 formatSkillsForPrompt 语义):
 * 每技能约 3 行, 100 个技能只占几百 token; 正文按需 read。
 * 字段全部经 escapeXml——description 来自不可信的 SKILL.md frontmatter。
 */
export function formatSkillsForPrompt(skills: DocumentSkill[]): string | undefined {
  if (skills.length === 0) return undefined;
  const entries = skills
    .map(
      (s) =>
        `<skill>\n<name>${escapeXml(s.name)}</name>\n<id>${escapeXml(s.id)}</id>\n<description>${escapeXml(s.description)}</description>\n<location>${escapeXml(s.location)}</location>\n</skill>`,
    )
    .join("\n");
  return [
    "The following skills provide specialized knowledge and workflows. When a task matches a skill's description, read its SKILL.md with the read_skill tool (by id) and follow it.",
    "Relative paths inside a skill file resolve against the skill's own directory.",
    "",
    entries,
  ].join("\n");
}

