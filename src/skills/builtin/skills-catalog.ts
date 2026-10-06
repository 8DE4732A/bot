import { readFileSync } from "node:fs";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { SkillRegistry } from "../registry.ts";
import { formatSkillsForPrompt, truncateMiddleBytes, type DocumentSkill } from "../document-skills.ts";
import { logger } from "../../utils/logger.ts";

/** read_skill 输出上限: 超大 SKILL.md 不进上下文 */
const READ_SKILL_MAX_BYTES = 20 * 1024;

/**
 * skills-catalog 常驻扩展: 目录 section + read_skill 工具, 承载文档型技能。
 *
 * - 对所有 Agent 安装 (AgentManager 构造 extensions 时追加), 但只渲染该 Agent
 *   实际选配的条目——目录本身不泄露未选配技能;
 * - 通过 input.agent.extensions 感知会话选中的扩展名: 文档型技能以空壳扩展
 *   (仅 name, 零工具) 注册进 registry, 名单 (agent.skills) 是唯一选配真相;
 *   混合技能 (index.ts + SKILL.md 同目录) 以 extension 为主注册, document 附挂;
 * - read_skill: 按 id 寻址 (name 可能重名), 校验调用方 Agent 的选配名单
 *   (经 api.agent 获取, 模型不可伪造)——未选配即拒绝, 解析失败也拒绝 (fail-closed)。
 *   注意: 选配是工具层的可发现性边界, 不是硬性安全隔离——技能是平台共享知识,
 *   沙盒对 SKILL.md 恒放行 (有 coding-tools 的 Agent 用 read 也能读);
 *   执行环境拒绝时 fail-closed 返回错误, 绝不直读文件 (仅 env 缺失时直读,
 *   location 由 registry 内部生成, 非模型可控);
 * - 每次请求前渲染, registry 更新 (SKILL.md 增删 / MCP 重装) 即时生效。
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
        const skill = SkillRegistry.getInstance()
          .listSkills()
          .find((s) => s.document && s.id === args.id)?.document as DocumentSkill | undefined;
        if (!skill) {
          return { content: [{ type: "text", text: `Unknown skill: ${args.id}` }], isError: true };
        }
        // disable-model-invocation: 模型不可自主调用 (即使已选配), 仅供宿主触发
        if (skill.disableModelInvocation) {
          return { content: [{ type: "text", text: `Skill '${args.id}' is not model-invocable` }], isError: true };
        }
        // 选配校验: 调用方 Agent 的扩展名单; 解析失败 fail-closed (绝不跳过校验)
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
        // 执行环境优先 (走沙盒 PathGuard): 环境明确拒绝时 fail-closed 返回错误,
        // 绝不退化为直读; 仅 env 缺失 (无执行环境的运行形态) 才直读——
        // location 由 registry 内部生成, 非模型可控
        try {
          const env = (api as any).env;
          if (env?.readTextFile && context) {
            const res = await env.readTextFile(skill.location, context);
            if (res && res.ok) {
              return { content: [{ type: "text", text: truncateMiddleBytes(res.value as string, READ_SKILL_MAX_BYTES) }] };
            }
            if (env) {
              const reason = (res as any)?.error ? String((res as any).error) : "denied by execution environment";
              return { content: [{ type: "text", text: `Failed to read skill: ${reason}` }], isError: true };
            }
          }
        } catch (err) {
          logger.warn("SkillsCatalog", `env read failed for skill '${args.id}': ${err}`);
          return { content: [{ type: "text", text: `Failed to read skill: ${err}` }], isError: true };
        }
        try {
          return { content: [{ type: "text", text: truncateMiddleBytes(readFileSync(skill.location, "utf-8"), READ_SKILL_MAX_BYTES) }] };
        } catch (err) {
          return { content: [{ type: "text", text: `Failed to read skill: ${err}` }], isError: true };
        }
      },
    }),
  ],
  sections: [
    {
      key: "available_skills",
      async render(input) {
        try {
          const selected = new Set(input.agent.extensions.map((e) => e.name));
          const docSkills = SkillRegistry.getInstance()
            .listSkills()
            .filter((s) => s.document && selected.has(s.id) && s.document.description)
            .map((s) => s.document as DocumentSkill)
            .filter((d) => !d.disableModelInvocation);
          return formatSkillsForPrompt(docSkills);
        } catch (err) {
          logger.warn("SkillsCatalog", `Failed to render skills catalog: ${err}`);
          return undefined;
        }
      },
    },
  ],
});
