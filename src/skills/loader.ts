import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Extension } from "@earendil-works/pi-durable";
import { getBotPaths } from "../config/env-paths.ts";
import { logger } from "../utils/logger.ts";
import { parseSkillMd } from "./document-skills.ts";
import { SkillRegistry } from "./registry.ts";

export interface SkillsReloadDiff {
  /** 本次新增/更新的扩展 (调用方需 installExtension 同步 durable registry) */
  upserted: Extension[];
  /** 磁盘上已消失的扩展名 (调用方需 uninstallExtension) */
  removed: string[];
  /** 工具型技能的代码变更被 ESM import 缓存挡住, 需重启进程才生效 */
  codeReloadLimited: boolean;
}

/** 工具型技能上次 import 时的 mtime: 变化说明代码改过, 而 ESM 缓存会挡住刷新 */
const importedMtimes = new Map<string, number>();

/**
 * 扫描 <cwd>.bot/skills/: SKILL.md → 文档型条目, index.ts → 工具型 Extension。
 * - upsert: 重复加载刷新条目 (文档型正文/描述; 工具型受 ESM import 缓存限制,
 *   代码变更需重启——见返回值 codeReloadLimited);
 * - 混合目录 (index.ts + SKILL.md) 合并为同一 id: extension 为主, document 附挂;
 * - builtin/既有工具扩展受保护: 文档技能不得覆盖 (空壳 extension 会清掉核心工具面);
 * - 返回 diff (added/updated/removed) 供调用方 reconcile durable registry——
 *   SkillRegistry 只是元数据视图, 模型实际可用性由 AgentManager 的 registry 决定。
 */
export async function loadCustomSkills(cwd?: string): Promise<SkillsReloadDiff> {
  const paths = getBotPaths(cwd);
  const skillsDir = paths.skillsDir;
  const diff: SkillsReloadDiff = { upserted: [], removed: [], codeReloadLimited: false };
  const registry = SkillRegistry.getInstance();

  if (!existsSync(skillsDir)) return diff;

  try {
    const entries = readdirSync(skillsDir, { withFileTypes: true });
    // removed 候选 = 非 builtin 且非 MCP 的技能 (MCP 由 McpBridge.sync 全权管理,
    // 它们不在磁盘 skills 目录里——不排除会被 reload 误判"消失"而卸载, 破坏 last-known-good)
    const beforeCustom = new Set(
      registry.listSkills().filter((s) => !s.builtin && s.kind !== "mcp").map((s) => s.id),
    );
    const seenDiskIds = new Set<string>();
    const docNameOwners = new Map<string, string>(); // frontmatter name → 技能 id (冲突诊断)

    const trackUpsert = (id: string, extension: Extension) => {
      seenDiskIds.add(id);
      if (!diff.upserted.some((e) => e.name === extension.name)) {
        diff.upserted.push(extension);
      }
    };

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = join(skillsDir, entry.name);
      // 目录在磁盘上就视为"存活": 混合技能删掉 index.ts 只剩 SKILL.md 时,
      // 目录名 id 仍是它的家——避免 removed 把 registry 条目清掉导致技能整体消失
      seenDiskIds.add(entry.name);

      // 工具型: index.ts
      const skillPath = join(dir, "index.ts");
      let extensionId: string | undefined;
      if (existsSync(skillPath)) {
        try {
          logger.debug("SkillLoader", `Loading custom skill from ${skillPath}`);
          const mtime = statSync(skillPath).mtimeMs;
          if (importedMtimes.has(skillPath) && importedMtimes.get(skillPath) !== mtime) {
            // 代码改了但 ESM import 缓存会返回旧模块——registry 拿到的是旧代码
            diff.codeReloadLimited = true;
            logger.warn("SkillLoader", `Tool skill '${skillPath}' changed on disk but ESM module cache prevents hot reload; restart required`);
          }
          importedMtimes.set(skillPath, mtime);
          const mod = await import(skillPath);
          if (mod.default && mod.default.id && mod.default.extension) {
            extensionId = String(mod.default.id);
            const existing = registry.getSkill(extensionId);
            registry.register({
              id: extensionId,
              name: mod.default.name || entry.name,
              description: mod.default.description || "Custom local skill",
              category: "custom",
              builtin: false,
              kind: "extension",
              // 混合技能 (index.ts + SKILL.md): extension 为主, 保留已挂的 document
              document: existing?.document,
              extension: mod.default.extension,
            });
            trackUpsert(extensionId, mod.default.extension);
            logger.info("SkillLoader", `Successfully loaded custom skill: ${extensionId}`);
          }
        } catch (err) {
          logger.error("SkillLoader", `Failed to load custom skill at ${skillPath}:`, err);
        }
      }

      // 文档型: SKILL.md 即技能 (数据, 不执行)。
      // 与 index.ts 共存时必须同一 id——module id ≠ 目录名时文档按 module id 附挂并诊断。
      const mdPath = join(dir, "SKILL.md");
      if (existsSync(mdPath)) {
        const doc = parseSkillMd(entry.name, mdPath);
        if (!doc) continue;
        if (!doc.description) {
          // 缺 description 的技能模型无法发现, 不进目录 (诊断已带)
          logger.warn("SkillLoader", `Skill '${doc.id}': ${doc.warnings.join("; ")}`);
          continue;
        }
        const docNameOwner = docNameOwners.get(doc.name);
        if (docNameOwner && docNameOwner !== doc.id) {
          logger.warn(
            "SkillLoader",
            `Document skill name collision: '${docNameOwner}' and '${doc.id}' both use frontmatter name '${doc.name}'; read_skill resolves by id`,
          );
        }
        docNameOwners.set(doc.name, doc.id);

        if (extensionId) {
          // 混合目录: document 附挂到 extension 条目 (id 以 module default 为准)
          if (extensionId !== doc.id) {
            logger.warn(
              "SkillLoader",
              `Hybrid skill at '${entry.name}/': index.ts exports id '${extensionId}' but directory/SKILL.md is '${doc.id}'; attaching document under '${extensionId}'`,
            );
          }
          doc.id = extensionId;
          const existing = registry.getSkill(extensionId);
          if (existing) {
            registry.register({ ...existing, document: doc });
            trackUpsert(extensionId, existing.extension);
          }
          continue;
        }

        // 纯文档技能: 不得覆盖 builtin、工具扩展或 MCP 注册 (空壳 extension 会清掉工具面;
        // 与 mcp__<id> 撞名会让文档技能覆盖 MCP 桥接的注册)
        const existing = registry.getSkill(doc.id);
        if (existing && (existing.builtin || (existing.extension.tools?.length ?? 0) > 0 || existing.kind === "mcp")) {
          logger.warn(
            "SkillLoader",
            `Document skill '${doc.id}' (dir '${entry.name}') conflicts with an existing ${existing.kind} skill; SKILL.md is shadowed. Rename the directory to expose it`,
          );
          continue;
        }
        seenDiskIds.add(doc.id);
        registry.register({
          id: doc.id,
          name: doc.name,
          description: doc.description,
          category: "document",
          builtin: false,
          kind: "skill",
          extension: { name: doc.id },
          document: doc,
        });
        trackUpsert(doc.id, { name: doc.id });
        for (const w of doc.warnings) {
          logger.warn("SkillLoader", `Skill '${doc.id}': ${w}`);
        }
      }
    }

    // 磁盘上已消失的非 builtin 技能 → removed (调用方卸载)
    for (const id of beforeCustom) {
      if (!seenDiskIds.has(id)) {
        registry.removeSkill(id);
        diff.removed.push(id);
        logger.info("SkillLoader", `Skill '${id}' no longer on disk; removed from registry`);
      }
    }
  } catch (err) {
    logger.warn("SkillLoader", `Error scanning skills directory ${skillsDir}: ${err}`);
  }
  return diff;
}
