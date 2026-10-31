import type { ChannelInstanceConfig } from "../config/database-store.ts";
import { logger } from "../utils/logger.ts";
import type { ChannelAdapter } from "./base.ts";
import {
  toPublicChannelType,
  type ChannelAdapterDeps,
  type ChannelTypeDescriptor,
  type PublicChannelTypeDescriptor,
} from "./descriptor.ts";
import { BUILTIN_DESCRIPTORS } from "./descriptors/index.ts";

/** 渠道类型注册表：类型元数据的唯一真相源（前端经 /api/channel-types 消费） */
const registry = new Map<string, ChannelTypeDescriptor>();

/** 注册（重复注册直接抛错，避免内置类型被静默覆盖）；返回注销函数（测试用） */
export function registerChannelType(descriptor: ChannelTypeDescriptor): () => void {
  if (registry.has(descriptor.type)) {
    throw new Error(`duplicate channel type: ${descriptor.type}`);
  }
  registry.set(descriptor.type, descriptor);
  return () => registry.delete(descriptor.type);
}

export function getChannelType(type: string): ChannelTypeDescriptor | undefined {
  return registry.get(type);
}

export function listChannelTypes(): ChannelTypeDescriptor[] {
  return [...registry.values()];
}

export function listPublicChannelTypes(): PublicChannelTypeDescriptor[] {
  return listChannelTypes().map(toPublicChannelType);
}

/**
 * 按配置实例化 adapter。未知类型 / managedBy=cli / 无 create 均返回 null
 * （调用方决定 warn 还是跳过）。
 */
export function createChannelAdapter(
  config: ChannelInstanceConfig,
  deps: ChannelAdapterDeps,
): ChannelAdapter | null {
  const descriptor = registry.get(config.type);
  if (!descriptor) {
    logger.warn("ChannelRegistry", `Unknown channel type "${config.type}" (${config.id}), skipped`);
    return null;
  }
  if (descriptor.managedBy === "cli" || !descriptor.create) {
    logger.debug(
      "ChannelRegistry",
      `Channel type "${config.type}" is managed by CLI; factory skipped (${config.id})`,
    );
    return null;
  }
  return descriptor.create(config, deps);
}

for (const descriptor of BUILTIN_DESCRIPTORS) {
  registerChannelType(descriptor);
}
