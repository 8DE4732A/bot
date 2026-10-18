import type { Extension } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { parseSkillMdContent, type DocumentSkill } from "./document-skills.ts";
import { logger } from "../utils/logger.ts";
import { DatetimeTools } from "./builtin/datetime.ts";
import { FrontendDesignTools } from "./builtin/frontend-design.ts";
import { WebSearchTools } from "./builtin/web-search.ts";
import { SKILL_CREATOR_MD } from "./builtin/skill-creator.ts";
import { SchedulerTools } from "../scheduler/tools.ts";

/** 三类统一技能: 工具型 Extension / 文档型 SKILL.md / MCP server 桥接 */
export type SkillKind = "extension" | "skill" | "mcp";

/** 平台技能 vs 某 Agent 的工作区私有技能 */
export type SkillScope = "platform" | "workspace";

export interface BotSkillMetadata {
  id: string;
  name: string;
  description: string;
  category: "coding" | "search" | "utility" | "design" | "custom" | "document" | "mcp";
  builtin: boolean;
  kind: SkillKind;
  /** 工具型/MCP: 实际扩展; 文档型: 空壳 (仅 name, 用于会话选配追踪) */
  extension: Extension;
  /** kind === "skill" 时的解析结果 */
  document?: DocumentSkill;
  /** 五期: 作用域与归属 */
  scope?: SkillScope;
  ownerAgentId?: string;
  sourcePath?: string;
  /** 内置文档技能恒生效（如 skill-creator），不依赖 agent.skills 勾选 */
  autoEnabled?: boolean;
}

export class SkillRegistry {
  private static instance?: SkillRegistry;
  private skills = new Map<string, BotSkillMetadata>();
  /** agentId -> skillId -> metadata（工作区私有技能） */
  private workspaceSkills = new Map<string, Map<string, BotSkillMetadata>>();

  constructor() {
    this.registerBuiltins();
  }

  public static getInstance(): SkillRegistry {
    if (!SkillRegistry.instance) {
      SkillRegistry.instance = new SkillRegistry();
    }
    return SkillRegistry.instance;
  }

  private registerBuiltins() {
    this.register({
      id: "coding-tools",
      name: "代码编写与执行 (Coding Tools)",
      description: "提供 read、write、edit、bash 四大基础开发工具，支持在隔离沙盒内安全编写代码与执行命令",
      category: "coding",
      builtin: true,
      kind: "extension",
      extension: CodingTools,
    });

    this.register({
      id: "web-search",
      name: "联网检索与网页抓取 (Web Search)",
      description: "提供 search_web 与 fetch_url 工具，支持在线查询实时信息与提取网页内容",
      category: "search",
      builtin: true,
      kind: "extension",
      extension: WebSearchTools,
    });

    this.register({
      id: "datetime",
      name: "系统日期与时间 (Date & Time)",
      description: "提供 get_current_time 工具，用于获取当前 ISO 时间、本地时间戳与时区信息",
      category: "utility",
      builtin: true,
      kind: "extension",
      extension: DatetimeTools,
    });

    this.register({
      id: "frontend-design",
      name: "前端工程与视觉设计 (Frontend Design)",
      description: "提供专业的前端设计规范、色彩/排版设计原则与反模板化指导，助力开发高品质界面",
      category: "design",
      builtin: true,
      kind: "extension",
      extension: FrontendDesignTools,
    });

    this.register({
      id: "scheduler",
      name: "定时任务 (Scheduler)",
      description:
        "提供 schedule_create / schedule_list / schedule_update / schedule_delete 四个工具，创建与管理定时任务：任务触发时以本 Agent 的配置在专属任务会话中执行 prompt，重复触发复用同一会话",
      category: "utility",
      builtin: true,
      kind: "extension",
      extension: SchedulerTools,
    });

    // 五期内置文档技能: 指导 Agent 在自身工作区按 Agent Skills 规范创建技能。
    // 正文内嵌，不依赖编译后的磁盘文件；autoEnabled 使其无需勾选即出现在目录。
    const creator = parseSkillMdContent("skill-creator", SKILL_CREATOR_MD, undefined, {
      strict: true,
      builtin: true,
    });
    if (creator.skill) {
      this.register({
        id: "skill-creator",
        name: "技能创建指南 (Skill Creator)",
        description: creator.skill.description,
        category: "document",
        builtin: true,
        kind: "skill",
        extension: { name: "skill-creator" },
        document: creator.skill,
        autoEnabled: true,
      });
    } else {
      logger.warn("SkillRegistry", `Built-in skill-creator failed to parse: ${creator.errors.join("; ")}`);
    }
  }

  public register(skill: BotSkillMetadata): void {
    const normalized: BotSkillMetadata = { ...skill, scope: skill.scope ?? "platform" };
    this.skills.set(skill.id, normalized);
    logger.debug("SkillRegistry", `Registered ${skill.kind} skill: ${skill.id} (${skill.name})`);
  }

  public listSkills(): BotSkillMetadata[] {
    return Array.from(this.skills.values());
  }

  public getSkill(id: string): BotSkillMetadata | undefined {
    return this.skills.get(id);
  }

  /** 注销技能 (MCP server 禁用/删除时由 bridge 调用) */
  public removeSkill(id: string): boolean {
    return this.skills.delete(id);
  }

  // --- 工作区技能 (per-agent 私有) ---

  public replaceWorkspaceSkills(agentId: string, skills: BotSkillMetadata[]): void {
    const map = new Map<string, BotSkillMetadata>();
    for (const skill of skills) {
      map.set(skill.id, { ...skill, scope: "workspace", ownerAgentId: agentId });
    }
    this.workspaceSkills.set(agentId, map);
  }

  public getWorkspaceSkill(agentId: string, id: string): BotSkillMetadata | undefined {
    return this.workspaceSkills.get(agentId)?.get(id);
  }

  public clearWorkspaceSkills(agentId: string): void {
    this.workspaceSkills.delete(agentId);
  }

  /** 内置 autoEnabled 文档技能（目录恒可见） */
  public listAutoEnabledDocumentSkills(): BotSkillMetadata[] {
    return Array.from(this.skills.values()).filter(
      (s) => s.autoEnabled && s.kind === "skill" && s.document,
    );
  }

  public resolveExtensions(enabledSkillIds: string[]): Extension[] {
    const extensions: Extension[] = [];
    for (const id of enabledSkillIds) {
      const skill = this.skills.get(id);
      if (skill) {
        extensions.push(skill.extension);
      } else {
        logger.warn("SkillRegistry", `Unknown skill requested: ${id}`);
      }
    }
    return extensions;
  }
}
