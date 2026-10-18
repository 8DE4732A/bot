import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { SkillRegistry, type BotSkillMetadata } from "../registry.ts";
import {
  escapeXml,
  formatSkillsForPrompt,
  truncateMiddleBytes,
  type DocumentSkill,
} from "../document-skills.ts";
import { resolveAgentId } from "../agent-scope.ts";
import {
  readWorkspaceSkillText,
  syncWorkspaceSkills,
  workspaceSkillsEnabled,
} from "../workspace.ts";
import { logger } from "../../utils/logger.ts";

/** read_skill 输出上限: 超大 SKILL.md 不进上下文 */
const READ_SKILL_MAX_BYTES = 20 * 1024;
const MAX_RESOURCE_ENTRIES = 50;

/** 平台技能资源清单：不列代码/依赖，避免把工具源码暴露给模型。 */
function listPlatformResources(skillDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 2 || out.length >= MAX_RESOURCE_ENTRIES) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= MAX_RESOURCE_ENTRIES) return;
      if (entry.isSymbolicLink()) continue;
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile()) {
        if (/\.(ts|js|mjs|cjs)$/i.test(entry.name)) continue;
        const rel = full.slice(skillDir.length + 1).split("\\").join("/");
        out.push(rel);
      }
    }
  };
  walk(skillDir, 0);
  return out;
}

function formatSkillContent(
  skill: BotSkillMetadata,
  content: string,
  location: string | undefined,
  resources: string[],
): string {
  const doc = skill.document!;
  const parts = [
    `<skill_content name="${escapeXml(doc.name)}" id="${escapeXml(doc.id)}">`,
    truncateMiddleBytes(content, READ_SKILL_MAX_BYTES),
    "</skill_content>",
  ];
  if (location) {
    parts.push(
      "",
      `Skill directory: ${location}`,
      "Relative paths in this skill are relative to the skill directory.",
    );
  }
  if (resources.length > 0) {
    parts.push(
      "",
      "<skill_resources>",
      ...resources.map((r) => `  <file>${escapeXml(r)}</file>`),
      "</skill_resources>",
    );
  }
  return parts.join("\n");
}

/**
 * skills-catalog 常驻扩展: 目录 section + read_skill 工具, 承载文档型技能。
 *
 * - 目录 = 平台已选文档技能 + 当前 Agent 的工作区技能 + autoEnabled 内置文档技能；
 * - 工作区技能按 (agentId, id) 分区寻址，跨 Agent 不可见；
 * - 工作区技能读取经 readVerifiedText（平台硬规则 + 包含性 + no-follow），
 *   不信任扫描缓存路径；
 * - autoEnabled 内置技能（skill-creator）无需勾选，正文直接来自内存。
 */
export const SkillsCatalog = defineExtension({
  name: "skills-catalog",
  tools: [
    defineTool({
      name: "read_skill",
      description:
        "Read the full content of an available skill (SKILL.md). Use the skill's <id> from the <available_skills> catalog.",
      parameters: Type.Object({
        id: Type.String({ description: "The skill id from the catalog" }),
      }),
      outputLimits: { maxBytes: READ_SKILL_MAX_BYTES, retain: "head" },
      async execute(args: { id: string }, api: ToolExecutionApi, context: any) {
        const registry = SkillRegistry.getInstance();
        const agentId = resolveAgentId(api.conversationId ? String(api.conversationId) : undefined);
        let workspaceSkill = agentId ? registry.getWorkspaceSkill(agentId, args.id) : undefined;
        let platformSkill = registry.getSkill(args.id);
        // 未知 id 才做增量同步（同轮刚写入的技能）；已知技能直接读正文，
        // 目录 section 已在每轮渲染前同步过，无需每次 read_skill 全量指纹。
        if (!workspaceSkill && !platformSkill && agentId) {
          try {
            await syncWorkspaceSkills(agentId);
          } catch (err) {
            logger.warn("SkillsCatalog", `workspace sync before read_skill failed: ${err}`);
          }
          workspaceSkill = registry.getWorkspaceSkill(agentId, args.id);
          platformSkill = registry.getSkill(args.id);
        }
        const skill = workspaceSkill ?? platformSkill;

        if (!skill || !skill.document) {
          return { content: [{ type: "text", text: `Unknown skill: ${args.id}` }], isError: true };
        }
        // disable-model-invocation: 模型不可自主调用 (即使已选配)，仅供宿主触发
        if (skill.document.disableModelInvocation) {
          return { content: [{ type: "text", text: `Skill '${args.id}' is not model-invocable` }], isError: true };
        }

        // autoEnabled 内置文档技能也必须绑定有效 Agent、总开关与执行环境
        if (
          skill.autoEnabled &&
          (!agentId || !workspaceSkillsEnabled() || !(api as any).env)
        ) {
          return {
            content: [{ type: "text", text: `Skill '${args.id}' is not available in this context` }],
            isError: true,
          };
        }

        // 选配校验: 工作区技能按归属；autoEnabled 内置技能免勾选；其余走会话扩展名单
        if (!workspaceSkill && !skill.autoEnabled) {
          let selected: Set<string>;
          try {
            const agent = await api.agent(context);
            selected = new Set(agent.extensions.map((e: any) => e.name));
          } catch (err) {
            logger.warn("SkillsCatalog", `Failed to resolve calling agent: ${err}`);
            return {
              content: [{ type: "text", text: `Unable to resolve calling agent; skill read refused` }],
              isError: true,
            };
          }
          if (!selected.has(args.id)) {
            return {
              content: [{ type: "text", text: `Skill '${args.id}' is not enabled for this agent` }],
              isError: true,
            };
          }
        }

        // 1. 内置文档技能：正文在内存中
        if (skill.document.builtin) {
          return {
            content: [
              {
                type: "text",
                text: formatSkillContent(skill, skill.document.body, undefined, []),
              },
            ],
          };
        }

        // 2. 工作区技能：走受保护读取（每次重新校验，不使用缓存路径）
        if (workspaceSkill) {
          if (!agentId || !skill.document.location) {
            return { content: [{ type: "text", text: `Skill '${args.id}' has no readable location` }], isError: true };
          }
          // 设计契约: 工作区读取必须依附执行环境；无 env 一律 fail-closed
          if (!(api as any).env) {
            return {
              content: [{ type: "text", text: `Failed to read skill: execution environment unavailable` }],
              isError: true,
            };
          }
          try {
            const read = readWorkspaceSkillText(agentId, skill.document.location, READ_SKILL_MAX_BYTES);
            // 工作区资源不做目录枚举：readdir 仍存在祖先 symlink 竞态，
            // 模型可按 SKILL.md 里的相对路径用 read/bash 自行读取
            return {
              content: [
                {
                  type: "text",
                  text: formatSkillContent(skill, read.text, read.realPath, []),
                },
              ],
            };
          } catch (err) {
            logger.warn("SkillsCatalog", `workspace skill read failed for '${args.id}': ${err}`);
            return {
              content: [{ type: "text", text: `Failed to read skill: read_error` }],
              isError: true,
            };
          }
        }

        // 3. 平台技能：统一要求执行环境（不再裸读宿主文件系统）
        const location = skill.document.location;
        let content: string | undefined;
        if (location) {
          const env = (api as any).env;
          if (!env?.readTextFile || !context) {
            return {
              content: [{ type: "text", text: `Failed to read skill: execution environment unavailable` }],
              isError: true,
            };
          }
          try {
            const res = await env.readTextFile(location, context);
            if (res && res.ok) {
              content = res.value as string;
            } else {
              return { content: [{ type: "text", text: `Failed to read skill: permission_denied` }], isError: true };
            }
          } catch (err) {
            logger.warn("SkillsCatalog", `env read failed for skill '${args.id}': ${err}`);
            return { content: [{ type: "text", text: `Failed to read skill: read_error` }], isError: true };
          }
        }
        if (content === undefined) {
          return { content: [{ type: "text", text: `Skill '${args.id}' has no readable location` }], isError: true };
        }
        const resources = location ? listPlatformResources(dirname(location)) : [];
        return {
          content: [{ type: "text", text: formatSkillContent(skill, content, location, resources) }],
        };
      },
    }),
  ],
  sections: [
    {
      key: "available_skills",
      async render(input) {
        try {
          const registry = SkillRegistry.getInstance();
          const selected = new Set(input.agent.extensions.map((e) => e.name));
          // name -> document；后写入的覆盖先写入的：
          // 平台已选 < 工作区（项目级优先）< autoEnabled 内置（保留名，不应被覆盖）
          const byName = new Map<string, DocumentSkill>();

          for (const s of registry.listSkills()) {
            if (s.document && selected.has(s.id) && s.document.description && !s.document.disableModelInvocation) {
              byName.set(s.document.name, s.document);
            }
          }

          const agentId = resolveAgentId(input.conversationId ? String(input.conversationId) : undefined);
          // 工作区技能是宿主侧扫描的，但设计契约要求依附执行环境；
          // 无 env 或总开关关闭时 fail-closed，不扫描也不注入。
          if (agentId && input.env && workspaceSkillsEnabled()) {
            const snapshot = await syncWorkspaceSkills(agentId);
            if (snapshot?.enabled) {
              for (const s of snapshot.skills) {
                if (s.document && s.document.description && !s.document.disableModelInvocation) {
                  byName.set(s.document.name, s.document);
                }
              }
            }
            for (const s of registry.listAutoEnabledDocumentSkills()) {
              if (s.document && s.document.description && !s.document.disableModelInvocation) {
                byName.set(s.document.name, s.document);
              }
            }
          }

          return formatSkillsForPrompt(Array.from(byName.values()));
        } catch (err) {
          logger.warn("SkillsCatalog", `Failed to render skills catalog: ${err}`);
          return undefined;
        }
      },
    },
  ],
});
