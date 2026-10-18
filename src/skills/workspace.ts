import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, basename, join, relative, resolve } from "node:path";
import { dlopen, FFIType } from "bun:ffi";
import type { AgentDefinition } from "../config/database-store.ts";
import { DatabaseStore } from "../config/database-store.ts";
import {
  isInsidePath,
  safeAgentId,
} from "../config/env-paths.ts";
import { EventBus } from "../core/event-bus.ts";
import { createSandboxPathGuard } from "../sandbox/execution-env.ts";
import type { PathGuard } from "../sandbox/path-guard.ts";
import { logger } from "../utils/logger.ts";
import {
  parseWorkspaceSkill,
  validateSkillName,
  type DocumentSkill,
} from "./document-skills.ts";
import { SkillRegistry, type BotSkillMetadata } from "./registry.ts";

/** 工作区技能的默认扫描根（相对 workspace） */
export const DEFAULT_SKILL_ROOT = ".agents/skills";

const DEFAULT_MAX_SKILLS = 100;
const DEFAULT_MAX_SKILL_BYTES = 64 * 1024;
const DEFAULT_MAX_MEMORY_BYTES = 32 * 1024;

/** 工作区记忆候选文件（与 pi coding agent 的 context files 顺序一致） */
export const MEMORY_CANDIDATES = [
  "AGENTS.override.md",
  "AGENTS.md",
  "AGENTS.MD",
  "CLAUDE.md",
  "CLAUDE.MD",
] as const;

/** 工作区技能不能覆盖的内置/保留名（从 registry 派生，新增内置技能无需改此处） */
function isReservedSkillId(id: string): boolean {
  if (id === "skills-catalog" || id.startsWith("mcp__") || id.startsWith("ws__")) return true;
  return SkillRegistry.getInstance()
    .listSkills()
    .some((s) => s.builtin && s.kind === "skill" && s.id === id);
}

export interface WorkspaceSkillDiagnostic {
  skill?: string;
  path: string;
  reason: string;
}

export interface WorkspaceMemoryFile {
  path: string;
  content: string;
  bytes: number;
  truncated: boolean;
  mtimeMs: number;
}

export interface WorkspaceSnapshot {
  agentId: string;
  enabled: boolean;
  roots: string[];
  skills: BotSkillMetadata[];
  diagnostics: WorkspaceSkillDiagnostic[];
  memory?: WorkspaceMemoryFile;
  fingerprint: string;
  scannedAt: number;
}

const cache = new Map<string, WorkspaceSnapshot>();
const inflight = new Map<string, Promise<WorkspaceSnapshot | undefined>>();
/** 扫描代际：purge 递增；写回前校验，防止未来引入 await 后旧扫描复活旧技能 */
const generations = new Map<string, number>();

const store = () => new DatabaseStore();

/** 一次读取全部工作区配置，避免每次扫描重复查询同一批 system_config 行。 */
interface WorkspaceConfig {
  skillsEnabled: boolean;
  memoryEnabled: boolean;
  roots: string;
  maxSkills: number;
  maxSkillBytes: number;
  maxMemoryBytes: number;
}

const FALSE_VALUES = new Set(["0", "false", "off", "no", "disabled"]);

function isFalseValue(value: string): boolean {
  return FALSE_VALUES.has(value.trim().toLowerCase());
}

function configFlag(all: Record<string, string>, key: string): boolean {
  return !isFalseValue(all[key] ?? "1");
}

function configNumber(all: Record<string, string>, key: string, fallback: number): number {
  const n = Number.parseInt(all[key] ?? String(fallback), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function readWorkspaceConfig(): WorkspaceConfig {
  const all = store().getAllConfigs();
  return {
    skillsEnabled: configFlag(all, "workspace_skills_enabled"),
    memoryEnabled: configFlag(all, "workspace_memory_enabled"),
    roots: all.workspace_skill_roots ?? DEFAULT_SKILL_ROOT,
    maxSkills: configNumber(all, "workspace_skills_max_count", DEFAULT_MAX_SKILLS),
    maxSkillBytes: configNumber(all, "workspace_skill_max_bytes", DEFAULT_MAX_SKILL_BYTES),
    maxMemoryBytes: configNumber(all, "workspace_memory_max_bytes", DEFAULT_MAX_MEMORY_BYTES),
  };
}

export function workspaceSkillsEnabled(): boolean {
  return !isFalseValue(store().getConfig("workspace_skills_enabled", "1"));
}

/**
 * 目录中是否已有工作区技能根或记忆文件（管理台"采纳旧工作区"守卫用）。
 * 扫描根取 system_config，避免守卫与实际扫描语义漂移。
 */
export function hasWorkspaceContent(dir: string): boolean {
  const raw = store().getConfig("workspace_skill_roots", DEFAULT_SKILL_ROOT);
  for (const part of raw.split(",")) {
    const rel = part.trim();
    if (!rel || isAbsolute(rel)) continue;
    const segments = rel.split(/[\\/]+/).filter(Boolean);
    if (segments.length === 0 || segments.some((s) => s === "..")) continue;
    if (existsSync(resolve(dir, rel))) return true;
  }
  return MEMORY_CANDIDATES.some((name) => existsSync(join(dir, name)));
}

/** 真实路径（workspace 不存在时回退到词法 resolve） */
function realOrResolve(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

let openatFn:
  | ((dirfd: number, path: Buffer, flags: number, mode: number) => number)
  | undefined;
let openatLoaded = false;

/**
 * 通过 libc openat(2) 从 workspace root 逐级打开（每级 O_NOFOLLOW）。
 * 这是消除“祖先目录 symlink TOCTOU”的唯一可靠方式：校验与打开绑定到
 * 同一目录 fd 链，而不是可被替换的字符串路径。
 */
function getOpenat(): typeof openatFn {
  if (!openatLoaded) {
    openatLoaded = true;
    try {
      const libNames =
        process.platform === "darwin"
          ? ["libSystem.B.dylib"]
          : ["libc.so.6", "libc.musl-x86_64.so.1", "libc.musl-aarch64.so.1", "libc.so"];
      let lastError: unknown;
      for (const libName of libNames) {
        try {
          const lib = dlopen(libName, {
            openat: {
              args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.i32],
              returns: FFIType.i32,
            },
          });
          openatFn = lib.symbols.openat as typeof openatFn;
          break;
        } catch (err) {
          lastError = err;
        }
      }
      if (!openatFn) throw lastError ?? new Error("openat symbol not found");
    } catch (err) {
      logger.warn("WorkspaceSkills", `openat unavailable; workspace reads will fail closed: ${err}`);
    }
  }
  return openatFn;
}

/** 打开 workspace 内目标文件的可信 fd；任一级 symlink/越界都失败 */
function openVerifiedFd(
  workspaceReal: string,
  path: string,
  workspaceLexical?: string,
): { fd: number; realPath: string } {
  const openat = getOpenat();
  if (!openat) throw new Error("secure openat is unavailable on this platform");
  let target = resolve(path);
  if (!isInsidePath(workspaceReal, target)) {
    // /tmp -> /private/tmp 这类 workspace 根别名：只映射根前缀，
    // 不解析目标内部的 symlink（内部 symlink 必须由 openat O_NOFOLLOW 拒绝）
    if (!workspaceLexical) {
      throw new Error(`target is outside agent workspace: ${target}`);
    }
    const rel = relative(resolve(workspaceLexical), target);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`target is outside agent workspace: ${target}`);
    }
    target = resolve(workspaceReal, rel);
    if (!isInsidePath(workspaceReal, target)) {
      throw new Error(`target is outside agent workspace: ${target}`);
    }
  }
  const rel = relative(workspaceReal, target);
  const parts = rel.split(/[\\/]+/).filter(Boolean);
  if (parts.length === 0 || parts.some((p) => p === ".." || p === ".")) {
    throw new Error(`invalid workspace-relative path: ${rel}`);
  }

  const dirFlags =
    constants.O_RDONLY |
    constants.O_DIRECTORY |
    (constants.O_NOFOLLOW ?? 0) |
    ((constants as any).O_CLOEXEC ?? 0);
  const fileFlags =
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | ((constants as any).O_CLOEXEC ?? 0);

  const openedDirs: number[] = [];
  let dirfd = openSync(workspaceReal, dirFlags);
  openedDirs.push(dirfd);
  try {
    for (let i = 0; i < parts.length - 1; i++) {
      const next = openat(dirfd, Buffer.from(parts[i] + "\0"), dirFlags, 0);
      if (next < 0) throw new Error(`openat failed for component '${parts[i]}'`);
      openedDirs.push(next);
      dirfd = next;
    }
    const last = parts[parts.length - 1];
    const fd = openat(dirfd, Buffer.from(last + "\0"), fileFlags, 0);
    if (fd < 0) throw new Error(`openat failed for '${last}'`);
    return { fd, realPath: target };
  } finally {
    // 中间目录 fd 到此关闭；最终文件 fd 由调用方负责
    for (const d of openedDirs) {
      try {
        closeSync(d);
      } catch {
        /* ignore */
      }
    }
  }
}

export interface VerifiedReadResult {
  text: string;
  bytes: number;
  truncated: boolean;
  mtimeMs: number;
  realPath: string;
}

/**
 * 受保护读取：平台硬规则（不随 sandbox.enabled 短路）+ 从 workspace root
 * 逐级 openat（O_NOFOLLOW）打开 + fstat 校验 + 同一 fd 读取。
 * 这是工作区技能/记忆在宿主侧的唯一读取入口。
 */
export function readVerifiedText(
  path: string,
  guard: PathGuard,
  workspaceReal: string,
  options: { maxBytes: number; truncate?: boolean },
  workspaceLexical?: string,
): VerifiedReadResult {
  const check = guard.checkCanRead(path, { force: true });
  if (!check.allowed) {
    throw new Error(check.reason ?? "read denied");
  }
  // 关键：不使用字符串路径 open；从 workspace root 逐级 openat，
  // 祖先目录被替换为 symlink 也无法把读取重定向到工作区外。
  const { fd, realPath } = openVerifiedFd(workspaceReal, path, workspaceLexical);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`not a regular file: ${realPath}`);
    if (st.nlink > 1) {
      throw new Error(`hard-linked file refused: ${realPath}`);
    }
    const size = options.truncate ? Math.min(st.size, options.maxBytes) : st.size;
    if (!options.truncate && st.size > options.maxBytes) {
      throw new Error(`file exceeds ${options.maxBytes} bytes: ${realPath}`);
    }
    const buf = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const n = readSync(fd, buf, offset, size - offset, offset);
      if (n <= 0) break;
      offset += n;
    }
    return {
      text: buf.subarray(0, offset).toString("utf-8"),
      bytes: st.size,
      truncated: st.size > options.maxBytes,
      mtimeMs: st.mtimeMs,
      realPath,
    };
  } finally {
    closeSync(fd);
  }
}

interface RootResolution {
  path: string;
  real: string;
}

function resolveRoots(agent: AgentDefinition, workspaceReal: string, raw: string): {
  roots: RootResolution[];
  diagnostics: WorkspaceSkillDiagnostic[];
} {
  const roots: RootResolution[] = [];
  const diagnostics: WorkspaceSkillDiagnostic[] = [];
  const seen = new Set<string>();

  for (const part of raw.split(",")) {
    const rel = part.trim();
    if (!rel) continue;
    if (isAbsolute(rel)) {
      diagnostics.push({ path: rel, reason: "workspace_skill_roots 不允许绝对路径" });
      continue;
    }
    const segments = rel.split(/[\\/]+/).filter(Boolean);
    if (segments.some((s) => s === "..") || /[\\/]{2,}/.test(rel)) {
      diagnostics.push({ path: rel, reason: "workspace_skill_roots 不允许 .. 或空路径段" });
      continue;
    }
    const abs = resolve(agent.workspaceDir, rel);
    const stat = lstatSync(abs, { throwIfNoEntry: false });
    if (!stat) continue; // 根尚未创建是正常状态
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      diagnostics.push({ path: abs, reason: "扫描根必须是真实目录（不能是 symlink）" });
      continue;
    }
    const real = realOrResolve(abs);
    if (!isInsidePath(workspaceReal, real)) {
      diagnostics.push({ path: abs, reason: "扫描根超出 Agent 工作区" });
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    roots.push({ path: abs, real });
  }
  return { roots, diagnostics };
}

interface SkillCandidate {
  id: string;
  dir: string;
  skillPath: string;
}

function findSkillMd(dir: string): string | undefined {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const byName = new Map(entries.map((e) => [e.name, e]));
  for (const name of ["SKILL.md", "skill.md"]) {
    const entry = byName.get(name);
    if (!entry) continue;
    // symlink / 特殊文件一律拒绝（Dirent kind 来自 lstat）
    if (entry.isSymbolicLink() || !entry.isFile()) return undefined;
    return join(dir, name);
  }
  return undefined;
}

function discoverCandidates(
  roots: RootResolution[],
  maxSkills: number,
): { candidates: SkillCandidate[]; diagnostics: WorkspaceSkillDiagnostic[] } {
  const candidates: SkillCandidate[] = [];
  const diagnostics: WorkspaceSkillDiagnostic[] = [];
  const seen = new Set<string>();

  for (const root of roots) {
    let entries;
    try {
      // 校验后全程使用 real 路径，避免扫描根/祖先在校验后被替换为 symlink
      if (realOrResolve(root.real) !== root.real) {
        diagnostics.push({ path: root.real, reason: "扫描根在扫描期间被替换，已跳过" });
        continue;
      }
      entries = readdirSync(root.real, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch (err) {
      logger.warn("WorkspaceSkills", `failed to read scan root ${root.real}: ${err}`);
      diagnostics.push({ path: root.real, reason: "无法读取扫描根" });
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue; // symlink/文件跳过
      const id = entry.name;
      const dir = join(root.real, id);
      const dirReal = realOrResolve(dir);
      if (dirReal !== dir || !isInsidePath(root.real, dirReal)) {
        diagnostics.push({ skill: id, path: dir, reason: "技能目录在扫描期间被替换，已跳过" });
        continue;
      }
      const nameErrors = validateSkillName(id, id);
      if (nameErrors.length > 0) {
        diagnostics.push({ skill: id, path: dir, reason: nameErrors.join("; ") });
        continue;
      }
      if (isReservedSkillId(id)) {
        diagnostics.push({ skill: id, path: dir, reason: "保留技能名，工作区技能不可使用" });
        continue;
      }
      if (seen.has(id)) {
        diagnostics.push({ skill: id, path: dir, reason: "重复技能 id（已被更早的扫描根占用，先到先得）" });
        continue;
      }
      if (candidates.length >= maxSkills) {
        diagnostics.push({ skill: id, path: dir, reason: `超过单 Agent 技能上限 ${maxSkills}` });
        continue;
      }
      // 目录名一出现就占用名字：即使首个 root 的技能无效，后续 root
      // 也不能用同名技能顶替（先到先得 + fail-closed）
      seen.add(id);
      const skillPath = findSkillMd(dir);
      if (!skillPath) {
        diagnostics.push({ skill: id, path: dir, reason: "缺少 SKILL.md（或 skill.md 不是真实文件）" });
        continue;
      }
      candidates.push({ id, dir, skillPath });
    }
  }
  return { candidates, diagnostics };
}

function findMemoryFile(
  agent: AgentDefinition,
  workspaceReal: string,
  guard: PathGuard,
  maxBytes: number,
): {
  file?: WorkspaceMemoryFile;
  diagnostics: WorkspaceSkillDiagnostic[];
} {
  const diagnostics: WorkspaceSkillDiagnostic[] = [];
  for (const name of MEMORY_CANDIDATES) {
    const path = join(agent.workspaceDir, name);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isSymbolicLink()) {
      // 与指纹一致：symlink 候选不可用，继续下一个候选
      diagnostics.push({ path, reason: "工作区记忆文件是 symlink，已跳过" });
      continue;
    }
    if (!stat.isFile()) continue;
    try {
      const res = readVerifiedText(path, guard, workspaceReal, {
        maxBytes,
        truncate: true,
      }, agent.workspaceDir);
      return {
        file: {
          path: res.realPath,
          content: res.text,
          bytes: res.bytes,
          truncated: res.truncated,
          mtimeMs: res.mtimeMs,
        },
        diagnostics,
      };
    } catch (err) {
      logger.warn("WorkspaceSkills", `failed to read memory file ${path}: ${err}`);
      return {
        diagnostics: [...diagnostics, { path, reason: "工作区记忆读取失败" }],
      };
    }
  }
  return { diagnostics };
}

/** 轻量指纹：只 stat 候选文件，不读正文；用于决定是否需要重新解析。 */
function computeFingerprint(
  roots: RootResolution[],
  agent: AgentDefinition,
  cfg: WorkspaceConfig,
): string {
  // 配置也是扫描结果的一部分：开关/roots/上限变化必须让旧快照失效
  const configSig = [
    cfg.skillsEnabled ? "1" : "0",
    cfg.memoryEnabled ? "1" : "0",
    cfg.roots,
    cfg.maxSkills,
    cfg.maxSkillBytes,
    cfg.maxMemoryBytes,
    // 撤权配置（denyRead/allowWrite/enabled）变化必须让旧快照失效，
    // 否则缓存里的记忆正文会绕过新加的 denyRead 继续注入
    JSON.stringify({
      enabled: agent.sandbox.enabled,
      allowWrite: agent.sandbox.filesystem.allowWrite,
      denyRead: agent.sandbox.filesystem.denyRead,
    }),
  ].join("|");
  const parts: string[] = [`cfg:${configSig}`, `roots:${roots.map((r) => r.real).join(",")}`];
  // 技能开关关闭时不枚举技能目录；重新开启会因 configSig 变化而必然重扫
  for (const root of cfg.skillsEnabled ? roots : []) {
    const rootStat = lstatSync(root.real, { throwIfNoEntry: false });
    if (!rootStat) continue;
    if (realOrResolve(root.real) !== root.real) continue;
    parts.push(`root:${root.real}:${rootStat.mtimeMs}:${rootStat.ino}`);
    let entries;
    try {
      entries = readdirSync(root.real, { withFileTypes: true }).sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      );
    } catch {
      continue;
    }
    for (const entry of entries) {
      // 目录条目本身参与指纹：新增/删除/改名即使没有有效 SKILL.md 也要失效
      const entryPath = join(root.real, entry.name);
      // 非 symlink 条目的父目录已是 real path，无需再做一次 realpath
      const entryReal = entry.isSymbolicLink() ? realOrResolve(entryPath) : entryPath;
      if (!isInsidePath(root.real, entryReal)) continue;
      const entryStat = lstatSync(entryReal, { throwIfNoEntry: false });
      if (entryStat) {
        parts.push(`entry:${entryReal}:${entryStat.mtimeMs}:${entryStat.ctimeMs}:${entryStat.ino}:${entryStat.mode}`);
      }
      if (!entry.isDirectory()) continue;
      for (const md of ["SKILL.md", "skill.md"]) {
        const st = lstatSync(join(entryReal, md), { throwIfNoEntry: false });
        if (st?.isFile() && !st.isSymbolicLink()) {
          parts.push(`${join(entryReal, md)}:${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.ino}`);
          break;
        }
      }
    }
  }
  if (cfg.memoryEnabled) {
    for (const name of MEMORY_CANDIDATES) {
      const st = lstatSync(join(agent.workspaceDir, name), { throwIfNoEntry: false });
      if (st?.isFile()) {
        parts.push(`mem:${join(agent.workspaceDir, name)}:${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.ino}`);
        break;
      }
    }
  }
  return parts.join("|");
}

function scanAgent(
  agent: AgentDefinition,
  cfg: WorkspaceConfig,
  resolved: { roots: RootResolution[]; diagnostics: WorkspaceSkillDiagnostic[] },
  fingerprint: string,
): WorkspaceSnapshot {
  const workspaceReal = realOrResolve(agent.workspaceDir);
  const guard = createSandboxPathGuard(agent.workspaceDir, agent.sandbox, store());
  const { roots, diagnostics } = resolved;
  const snapshot: WorkspaceSnapshot = {
    agentId: agent.id,
    enabled: cfg.skillsEnabled,
    roots: roots.map((r) => r.path),
    skills: [],
    diagnostics: [...diagnostics],
    fingerprint,
    scannedAt: Date.now(),
  };

  // 技能开关关闭不应连带关闭记忆：两者是独立配置
  if (cfg.skillsEnabled) {
    const discovered = discoverCandidates(roots, cfg.maxSkills);
    snapshot.diagnostics.push(...discovered.diagnostics);

    for (const candidate of discovered.candidates) {
      try {
        const read = readVerifiedText(candidate.skillPath, guard, workspaceReal, {
          maxBytes: cfg.maxSkillBytes,
        }, agent.workspaceDir);
        const parsed = parseWorkspaceSkill(candidate.id, read.text, candidate.skillPath);
        if (!parsed.skill) {
          snapshot.diagnostics.push({
            skill: candidate.id,
            path: candidate.skillPath,
            reason: parsed.errors.join("; "),
          });
          continue;
        }
        // 快照只保留元数据：正文由 read_skill 每次受保护重读，不常驻内存
        const document: DocumentSkill = { ...parsed.skill, location: read.realPath, body: "" };
        snapshot.skills.push({
          id: candidate.id,
          name: document.name,
          description: document.description,
          category: "custom",
          builtin: false,
          kind: "skill",
          extension: { name: `ws__${safeAgentId(agent.id)}__${candidate.id}` },
          document,
          scope: "workspace",
          ownerAgentId: agent.id,
          sourcePath: read.realPath,
        });
        for (const warning of parsed.warnings) {
          snapshot.diagnostics.push({ skill: candidate.id, path: candidate.skillPath, reason: warning });
        }
      } catch (err) {
        logger.warn("WorkspaceSkills", `failed to read skill ${candidate.skillPath}: ${err}`);
        snapshot.diagnostics.push({
          skill: candidate.id,
          path: candidate.skillPath,
          reason: "技能读取失败",
        });
      }
    }
  }

  if (cfg.memoryEnabled) {
    const mem = findMemoryFile(agent, workspaceReal, guard, cfg.maxMemoryBytes);
    if (mem.file) snapshot.memory = mem.file;
    snapshot.diagnostics.push(...mem.diagnostics);
  }

  return snapshot;
}

/** 审计只记录稳定分类，绝不写入诊断里的原文（可能含 frontmatter 敏感片段） */
function auditReason(reason: string): string {
  if (/yaml/i.test(reason)) return "yaml_parse";
  if (/symlink/i.test(reason)) return "symlink";
  if (/hard link|hardlink|硬链接/i.test(reason)) return "hardlink";
  if (/denied|保护|禁读|platform-protected/i.test(reason)) return "read_denied";
  if (/重复/.test(reason)) return "duplicate";
  if (/保留/.test(reason)) return "reserved";
  if (/缺少 SKILL/.test(reason)) return "missing_skill_md";
  if (/description|name|compatibility|metadata/i.test(reason)) return "spec_invalid";
  if (/超过|上限/.test(reason)) return "limit";
  if (/超出|包含性|outside|扫描根/.test(reason)) return "containment";
  return "other";
}

function auditSnapshotChange(
  agentId: string,
  prev: WorkspaceSnapshot | undefined,
  next: WorkspaceSnapshot,
  changed: boolean,
): void {
  if (!changed) return;
  try {
    const db = store();
    db.recordAudit(
      "workspace.skills.loaded",
      {
        skills: next.skills.map((s) => s.id),
        diagnostics: next.diagnostics.slice(0, 20).map((d) => ({
          skill: d.skill ?? null,
          reason: auditReason(d.reason),
        })),
        memory: next.memory ? basename(next.memory.path) : null,
      },
      agentId,
    );
    for (const d of next.diagnostics.filter((x) => x.skill).slice(0, 10)) {
      db.recordAudit(
        "workspace.skill.rejected",
        { skill: d.skill!, reason: auditReason(d.reason) },
        agentId,
      );
    }
    const memoryChanged =
      prev?.memory?.path !== next.memory?.path || prev?.memory?.content !== next.memory?.content;
    if (next.memory && memoryChanged) {
      db.recordAudit(
        "workspace.memory.loaded",
        { file: basename(next.memory.path), bytes: next.memory.bytes, truncated: next.memory.truncated },
        agentId,
      );
    }
    for (const d of next.diagnostics.filter((x) => !x.skill && x.reason.includes("记忆"))) {
      db.recordAudit(
        "workspace.memory.rejected",
        { reason: auditReason(d.reason) },
        agentId,
      );
    }
  } catch (err) {
    logger.warn("WorkspaceSkills", `Failed to record audit entry: ${err}`);
  }
}

/**
 * 同步某个 Agent 的工作区技能快照。
 * - 每次调用都做轻量指纹检查；指纹不变时复用缓存（TTL 不是正确性依赖）；
 * - force=true 强制重新解析；
 * - 同一 Agent 的并发调用合并为一次扫描。
 */
export async function syncWorkspaceSkills(
  agentId: string,
  options: { force?: boolean } = {},
): Promise<WorkspaceSnapshot | undefined> {
  const existing = inflight.get(agentId);
  if (existing) {
    if (!options.force) return existing;
    // force 不能被普通 inflight 吞掉：等所有在飞扫描结束后再发起强制扫描
    while (inflight.has(agentId)) {
      const running = inflight.get(agentId)!;
      await running;
    }
  }

  const run = (async () => {
    const agent = store().getAgent(agentId);
    if (!agent) {
      cache.delete(agentId);
      SkillRegistry.getInstance().clearWorkspaceSkills(agentId);
      return undefined;
    }

    const prev = cache.get(agentId);
    const cfg = readWorkspaceConfig();
    const workspaceReal = realOrResolve(agent.workspaceDir);
    const resolved = resolveRoots(agent, workspaceReal, cfg.roots);
    const fingerprint = computeFingerprint(resolved.roots, agent, cfg);
    if (!options.force && prev && prev.fingerprint === fingerprint) {
      // 已关闭时也要清除上一个快照的注入内容
      if (!prev.enabled) {
        SkillRegistry.getInstance().replaceWorkspaceSkills(agentId, []);
      }
      return prev;
    }

    // 复用同一份 roots/指纹：避免指纹与快照来自不同扫描时刻
    const gen = generations.get(agentId) ?? 0;
    const next = scanAgent(agent, cfg, resolved, fingerprint);
    // 防御式代际校验（当前 scanAgent 是同步的，正常不会在扫描中途 purge；
    // 保留该检查防止未来引入 await 后旧结果回写）
    const current = store().getAgent(agentId);
    if (
      (generations.get(agentId) ?? 0) !== gen ||
      !current ||
      current.workspaceDir !== agent.workspaceDir ||
      JSON.stringify(current.sandbox) !== JSON.stringify(agent.sandbox)
    ) {
      return prev;
    }
    cache.set(agentId, next);
    if (next.enabled) {
      SkillRegistry.getInstance().replaceWorkspaceSkills(agentId, next.skills);
    } else {
      SkillRegistry.getInstance().replaceWorkspaceSkills(agentId, []);
    }
    const changed = !prev || prev.fingerprint !== next.fingerprint;
    auditSnapshotChange(agentId, prev, next, changed);
    if (changed) {
      EventBus.getInstance().publish({
        type: "workspace.skills.changed",
        agentId,
        detail: next.skills.map((s) => s.id),
      });
    }
    const memoryChanged =
      !prev ||
      prev.memory?.path !== next.memory?.path ||
      prev.memory?.content !== next.memory?.content;
    if (memoryChanged) {
      EventBus.getInstance().publish({
        type: "workspace.memory.changed",
        agentId,
        detail: next.memory ? [basename(next.memory.path)] : [],
      });
    }
    return next;
  })();

  inflight.set(agentId, run);
  void run.finally(() => {
    if (inflight.get(agentId) === run) inflight.delete(agentId);
  });
  return run;
}

/** 清理某 Agent 的注册表分区与缓存（删除 Agent / 配置变更时调用） */
export function purgeWorkspaceSkills(agentId: string): void {
  cache.delete(agentId);
  inflight.delete(agentId);
  generations.set(agentId, (generations.get(agentId) ?? 0) + 1);
  SkillRegistry.getInstance().clearWorkspaceSkills(agentId);
}

/** 测试用：清空全部进程内缓存 */
export function resetWorkspaceSkillCacheForTests(): void {
  cache.clear();
  inflight.clear();
  generations.clear();
}

/** read_skill 的工作区读取入口：重新构造 guard，不信任扫描缓存。 */
export function readWorkspaceSkillText(agentId: string, path: string, maxBytes: number): VerifiedReadResult {
  const agent = store().getAgent(agentId);
  if (!agent) throw new Error(`Agent not found: ${agentId}`);
  const guard = createSandboxPathGuard(agent.workspaceDir, agent.sandbox, store());
  return readVerifiedText(path, guard, realOrResolve(agent.workspaceDir), {
    maxBytes,
    truncate: true,
  }, agent.workspaceDir);
}
