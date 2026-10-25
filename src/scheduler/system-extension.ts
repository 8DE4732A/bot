import { defineExtension } from "@earendil-works/pi-durable";
import { ScheduledPromptTask } from "./durable-task.ts";

/**
 * 六期系统扩展：把调度任务定义注册进 Harness registry。
 * 不进 SkillRegistry（不出现在 Agent 技能勾选列表），但必须在 AgentManager.init 显式
 * install——会话按名字解析任务定义，缺注册物会被框架视为 missing_task。
 */
export const SchedulerSystemExtension = defineExtension({
  name: "system-scheduler",
  tasks: [ScheduledPromptTask],
});
