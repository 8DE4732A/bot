import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { logger } from "../utils/logger.ts";

/**
 * 文档型技能 (Agent Skills / SKILL.md): 纯知识/流程型能力, 不执行代码。
 * 注入采用渐进披露——系统提示词里只有目录 (name/description/location),
 * 正文由模型判断任务匹配后用 read_skill 按需读取。
 *
 * 五期: 工作区技能遵循 agentskills 规范的完整 frontmatter（YAML），
 * 平台技能保留宽松兼容语义（警告但尽量加载）。
 */

/** 规范上限（按 Unicode 码点计数） */
export const NAME_MAX_CHARS = 64;
export const DESCRIPTION_MAX_CHARS = 1024;
export const COMPATIBILITY_MAX_CHARS = 500;

/** 规范允许的未知字段策略：客户端兼容扩展，警告但加载 */
const KNOWN_FIELDS = new Set([
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "allowed-tools",
  "disable-model-invocation",
]);

export interface SkillSpecFields {
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string;
}

export interface DocumentSkill {
  /** 技能 id (= 目录名, 也是 read_skill 的寻址键) */
  id: string;
  name: string;
  description: string;
  /** SKILL.md 绝对路径；内置文档技能没有实体文件时省略 */
  location?: string;
  /** frontmatter 原始正文 (管理台预览用) */
  body: string;
  /** true = 不进目录 (仅管理台可见, 模型无法自主发现) */
  disableModelInvocation: boolean;
  /** 解析诊断 (description 缺失等) */
  warnings: string[];
  /** agentskills 可选字段 */
  spec?: SkillSpecFields;
  /** 内置文档技能（如 skill-creator）：无需磁盘文件，正文直接来自内存 */
  builtin?: boolean;
}

export interface SkillParseResult {
  skill?: DocumentSkill;
  /** 严格模式下的硬错误（调用方跳过该技能） */
  errors: string[];
  warnings: string[];
}

/** 按 Unicode 码点计数（避免 JS UTF-16 surrogate pair 口径差异） */
export function codePointLength(s: string): number {
  return Array.from(s).length;
}

const normalize = (s: string): string => s.normalize("NFKC");

/**
 * 校验 skill name（对齐 agentskills 参考实现 validator.py）：
 * 1-64 码点、Unicode 小写字母/数字/连字符、无首尾/连续连字符。
 * expectedDir 存在时还要求 NFKC 后与目录名一致。
 */
export function validateSkillName(name: string, expectedDir?: string): string[] {
  const errors: string[] = [];
  if (!name || typeof name !== "string" || !name.trim()) {
    errors.push("name 必须是非空字符串");
    return errors;
  }
  const n = normalize(name.trim());
  if (codePointLength(n) > NAME_MAX_CHARS) {
    errors.push(`name 超过 ${NAME_MAX_CHARS} 个字符上限 (${codePointLength(n)})`);
  }
  if (n !== n.toLowerCase()) errors.push("name 必须全部小写");
  if (n.startsWith("-") || n.endsWith("-")) errors.push("name 不能以连字符开头或结尾");
  if (n.includes("--")) errors.push("name 不能包含连续连字符");
  if (!/^[\p{Ll}\p{Nd}-]+$/u.test(n)) {
    errors.push("name 只能包含小写字母、数字和连字符");
  }
  if (expectedDir !== undefined) {
    const dir = normalize(expectedDir);
    if (dir !== n) errors.push(`目录名 '${expectedDir}' 必须与 name '${n}' 一致`);
  }
  return errors;
}

interface FrontmatterSplit {
  yaml?: string;
  body: string;
  /** 文本以 --- 开头但没有闭合 */
  unclosed: boolean;
}

function splitFrontmatter(raw: string): FrontmatterSplit {
  // Windows 行尾与 BOM: 后续匹配假设 \n
  const text = raw.replace(/\r\n/g, "\n").replace(/^﻿/, "");
  if (!text.startsWith("---")) return { body: text, unclosed: false };
  const match = text.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!match) return { body: text, unclosed: true };
  return {
    yaml: match[1],
    body: text.slice(match[0].length).replace(/^\n+/, ""),
    unclosed: false,
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

/** 平台宽松模式: 旧技能可能写 description: 123 之类的非字符串标量 */
function asLooseString(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

/**
 * 旧手写 frontmatter 的兼容回退（仅平台宽松模式，YAML 解析失败时使用）。
 * 支持平铺 key: value 与 >/| 块标量；不追求完整 YAML。
 */
function parseLegacyFrontmatter(text: string): Record<string, unknown> | undefined {
  const fm: Record<string, unknown> = {};
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([A-Za-z_-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].trim();
    let value = m[2].trim().replace(/^["']|["']$/g, "");
    if (value === ">-" || value === ">" || value === "|" || value === "|-") {
      const collected: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const cont = lines[j];
        if (/^\s+\S/.test(cont)) collected.push(cont.trim());
        else if (/^\s*$/.test(cont) && j + 1 < lines.length && /^\s+\S/.test(lines[j + 1])) {
          collected.push("");
        } else break;
      }
      i = j - 1;
      value = collected
        .filter((l, idx, arr) => l !== "" || (idx > 0 && idx < arr.length - 1))
        .join(value.startsWith(">") ? " " : "\n");
    }
    fm[key] = value;
  }
  return Object.keys(fm).length > 0 ? fm : undefined;
}

function normalizeMetadata(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      out[String(k)] = String(v);
    }
  }
  return out;
}

/**
 * 从字符串解析 SKILL.md（不触碰文件系统）。
 * - strict=false（平台技能）：尽量加载，缺失/非法字段降级为警告；
 * - strict=true（工作区技能）：必需字段、name/目录一致、长度上限为硬错误。
 */
export function parseSkillMdContent(
  dirName: string,
  raw: string,
  location: string | undefined,
  options: { strict?: boolean; builtin?: boolean } = {},
): SkillParseResult {
  const strict = options.strict === true;
  const errors: string[] = [];
  const warnings: string[] = [];
  /** 严格模式记硬错误，宽松模式记警告（同一字段只写一处） */
  const report = (msg: string): number => (strict ? errors : warnings).push(msg);
  const toStringValue = strict ? asString : asLooseString;
  const split = splitFrontmatter(raw);

  let fm: Record<string, unknown> = {};
  if (split.unclosed) {
    warnings.push("frontmatter 未闭合 (--- 缺失), 整个文件按正文处理");
  } else if (split.yaml !== undefined) {
    try {
      const parsed = parseYaml(split.yaml, { maxAliasCount: 10, uniqueKeys: true });
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        report("frontmatter 必须是 YAML mapping");
      } else {
        fm = parsed as Record<string, unknown>;
      }
    } catch (err) {
      // 绝不复用包含源码行的 err.message（可能含密钥）；只保留稳定分类/行列号
      const pos = (err as any)?.linePos?.[0];
      const loc = pos ? ` (line ${pos.line}, col ${pos.col})` : "";
      if (strict) {
        report(`frontmatter YAML 解析失败${loc}`);
        // 严格模式不做 legacy 回退
      } else {
        const legacy = split.yaml !== undefined ? parseLegacyFrontmatter(split.yaml) : undefined;
        if (legacy) {
          fm = legacy;
          warnings.push("frontmatter YAML 解析失败，按宽松格式回退");
        } else {
          warnings.push("frontmatter YAML 解析失败");
        }
      }
    }
  }

  for (const key of Object.keys(fm)) {
    if (!KNOWN_FIELDS.has(key)) warnings.push(`未知 frontmatter 字段 '${key}' (按兼容扩展加载)`);
  }

  // name
  let name = toStringValue(fm.name) ?? "";
  if (!name) {
    report("缺少必需字段 name");
    name = dirName;
  }
  const nameErrors = validateSkillName(name, strict ? dirName : undefined);
  if (nameErrors.length > 0) {
    if (strict) {
      errors.push(...nameErrors);
    } else {
      // 平台宽松语义: 非法 name 回退目录名（保持既有行为）
      warnings.push(...nameErrors);
      name = dirName;
    }
  }

  // description
  let description = toStringValue(fm.description) ?? "";
  if (!description) {
    report("缺少 description——无法进入技能目录, 模型将无法发现该技能");
  } else if (codePointLength(description) > DESCRIPTION_MAX_CHARS) {
    report(`description 超过 ${DESCRIPTION_MAX_CHARS} 个字符上限`);
    description = Array.from(description).slice(0, DESCRIPTION_MAX_CHARS).join("");
  }

  // compatibility
  let compatibility = toStringValue(fm.compatibility);
  if (fm.compatibility !== undefined && (compatibility === undefined || compatibility.length === 0)) {
    report("compatibility 提供时必须是非空字符串");
    compatibility = undefined;
  }
  if (compatibility !== undefined && codePointLength(compatibility) > COMPATIBILITY_MAX_CHARS) {
    report(`compatibility 超过 ${COMPATIBILITY_MAX_CHARS} 个字符上限`);
    compatibility = Array.from(compatibility).slice(0, COMPATIBILITY_MAX_CHARS).join("");
  }

  const metadata = normalizeMetadata(fm.metadata);
  if (fm.metadata !== undefined && !metadata) {
    report("metadata 必须是 string→string 的映射");
  }

  const disableRaw = fm["disable-model-invocation"];
  const disableModelInvocation =
    disableRaw === true || (typeof disableRaw === "string" && disableRaw.trim().toLowerCase() === "true");

  const spec: SkillSpecFields = {};
  const license = toStringValue(fm.license);
  if (fm.license !== undefined && (license === undefined || license.length === 0)) {
    report("license 提供时必须是非空字符串");
  }
  if (license) spec.license = license;
  if (compatibility) spec.compatibility = compatibility;
  if (metadata) spec.metadata = metadata;
  const allowedTools = toStringValue(fm["allowed-tools"]);
  if (allowedTools) spec.allowedTools = allowedTools;

  const skill: DocumentSkill = {
    id: dirName,
    name,
    description,
    location,
    body: split.body,
    disableModelInvocation,
    warnings,
    ...(Object.keys(spec).length > 0 ? { spec } : {}),
    ...(options.builtin ? { builtin: true } : {}),
  };

  return { skill: errors.length === 0 ? skill : undefined, errors, warnings };
}

/**
 * 平台技能：宽松解析（保留既有签名与行为）。
 */
export function parseSkillMd(dirName: string, absPath: string): DocumentSkill | undefined {
  let raw: string;
  try {
    raw = readFileSync(absPath, "utf-8");
  } catch (err) {
    logger.warn("DocumentSkills", `Failed to read ${absPath}: ${err}`);
    return undefined;
  }
  const result = parseSkillMdContent(dirName, raw, absPath, { strict: false });
  return result.skill;
}

/**
 * 工作区技能：严格解析。调用方拿到 errors 后跳过该技能并写诊断。
 */
export function parseWorkspaceSkill(
  dirName: string,
  raw: string,
  location: string,
): SkillParseResult {
  return parseSkillMdContent(dirName, raw, location, { strict: true });
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
 * 内置文档技能没有实体 location，省略 <location>，统一用 read_skill 激活。
 */
export function formatSkillsForPrompt(skills: DocumentSkill[]): string | undefined {
  if (skills.length === 0) return undefined;
  const entries = skills
    .map((s) => {
      const location = s.location
        ? `\n<location>${escapeXml(s.location)}</location>`
        : "";
      return `<skill>\n<name>${escapeXml(s.name)}</name>\n<id>${escapeXml(s.id)}</id>\n<description>${escapeXml(s.description)}</description>${location}\n</skill>`;
    })
    .join("\n");
  return [
    "The following skills provide specialized knowledge and workflows. When a task matches a skill's description, read its SKILL.md with the read_skill tool (by id) and follow it.",
    "Relative paths inside a skill file resolve against the skill's own directory.",
    "",
    entries,
  ].join("\n");
}
