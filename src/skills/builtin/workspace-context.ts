import { defineExtension } from "@earendil-works/pi-durable";
import { resolveAgentId } from "../agent-scope.ts";
import { escapeXml } from "../document-skills.ts";
import { syncWorkspaceSkills } from "../workspace.ts";
import { logger } from "../../utils/logger.ts";

/**
 * 工作区记忆 section（五期 §4.7）：读取 <workspace>/AGENTS.md（以及 pi 同款候选），
 * 每个请求渲染前做指纹检查，变更下一轮生效。
 *
 * durable 的 section 顺序 = 扩展 section 在前，Agent instructions 最后追加，
 * 因此本 section 实际排在 instructions 之前（文档 §4.7 已按真实行为描述）。
 */
export const WorkspaceContext = defineExtension({
  name: "workspace-context",
  sections: [
    {
      key: "workspace_context",
      async render(input) {
        try {
          const agentId = resolveAgentId(input.conversationId ? String(input.conversationId) : undefined);
          // 与工作区技能同一 fail-closed 契约：无执行环境不注入
          if (!agentId || !input.env) return undefined;
          const snapshot = await syncWorkspaceSkills(agentId);
          const memory = snapshot?.memory;
          if (!memory || !memory.content.trim()) return undefined;
          const note = memory.truncated ? "\n\n[workspace memory truncated to the configured size limit]" : "";
          return [
            "The following instructions and memory come from the agent's workspace.",
            "",
            `<project_instructions path="${escapeXml(memory.path)}">`,
            memory.content.trimEnd() + note,
            "</project_instructions>",
          ].join("\n");
        } catch (err) {
          logger.warn("WorkspaceContext", `Failed to render workspace context: ${err}`);
          return undefined;
        }
      },
    },
  ],
});
