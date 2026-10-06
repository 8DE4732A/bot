import type { Extension } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { DocumentSkill } from "./document-skills.ts";
import type { AgentDefinition } from "../config/database-store.ts";
import { logger } from "../utils/logger.ts";
import { DatetimeTools } from "./builtin/datetime.ts";
import { FrontendDesignTools } from "./builtin/frontend-design.ts";
import { WebSearchTools } from "./builtin/web-search.ts";
import { SchedulerTools } from "../scheduler/tools.ts";

/** 三类统一技能: 工具型 Extension / 文档型 SKILL.md / MCP server 桥接 */
export type SkillKind = "extension" | "skill" | "mcp";

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
}

export class SkillRegistry {
  private static instance?: SkillRegistry;
  private skills = new Map<string, BotSkillMetadata>();

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
  }

  public register(skill: BotSkillMetadata): void {
    this.skills.set(skill.id, skill);
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
