import type { ChannelInstanceConfig } from "../config/database-store.ts";
import { logger } from "../utils/logger.ts";
import type { ChannelAdapter } from "./base.ts";
import { QQChannelAdapter } from "./adapters/qq.ts";
import { WeComChannelAdapter } from "./adapters/wecom.ts";
import { WeixinChannelAdapter } from "./adapters/weixin.ts";

/**
 * 渠道类型注册表: 新增渠道只需实现 ChannelAdapter 并在此登记一行。
 * terminal 由 CLI 特殊管理 (REPL 单实例, 直接与进程 stdin 绑定), 不经工厂。
 */
const CHANNEL_TYPES: Record<string, new (id: string, name: string, credentials: Record<string, any>) => ChannelAdapter> = {
  wecom: WeComChannelAdapter,
  weixin: WeixinChannelAdapter,
  qq: QQChannelAdapter,
};

export function createChannelAdapter(config: ChannelInstanceConfig): ChannelAdapter | null {
  const Ctor = CHANNEL_TYPES[config.type];
  if (!Ctor) {
    logger.warn("ChannelFactory", `Unknown channel type "${config.type}" (${config.id}), skipped`);
    return null;
  }
  return new Ctor(config.id, config.name, config.credentials);
}
