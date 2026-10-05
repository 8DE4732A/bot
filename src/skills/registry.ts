import type { Extension } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { AgentDefinition } from "../config/database-store.ts";
import { logger } from "../utils/logger.ts";
import { DatetimeTools } from "./builtin/datetime.ts";
import { FrontendDesignTools } from "./builtin/frontend-design.ts";
import { WebSearchTools } from "./builtin/web-search.ts";

export interface BotSkillMetadata {
  id: string;
  name: string;
  description: string;
  category: "coding" | "search" | "utility" | "design" | "custom";
  builtin: boolean;
  extension: Extension;
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
      extension: CodingTools,
    });

    this.register({
      id: "web-search",
      name: "联网检索与网页抓取 (Web Search)",
      description: "提供 search_web 与 fetch_url 工具，支持在线查询实时信息与提取网页内容",
      category: "search",
      builtin: true,
      extension: WebSearchTools,
    });

    this.register({
      id: "datetime",
      name: "系统日期与时间 (Date & Time)",
      description: "提供 get_current_time 工具，用于获取当前 ISO 时间、本地时间戳与时区信息",
      category: "utility",
      builtin: true,
      extension: DatetimeTools,
    });

    this.register({
      id: "frontend-design",
      name: "前端工程与视觉设计 (Frontend Design)",
      description: "提供专业的前端设计规范、色彩/排版设计原则与反模板化指导，助力开发高品质界面",
      category: "design",
      builtin: true,
      extension: FrontendDesignTools,
    });
  }

  public register(skill: BotSkillMetadata): void {
    this.skills.set(skill.id, skill);
    logger.debug("SkillRegistry", `Registered skill: ${skill.id} (${skill.name})`);
  }

  public listSkills(): BotSkillMetadata[] {
    return Array.from(this.skills.values());
  }

  public getSkill(id: string): BotSkillMetadata | undefined {
    return this.skills.get(id);
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
