import type { ChannelTypeDescriptor } from "../descriptor.ts";
import { feishuDescriptor } from "./feishu.ts";
import { qqDescriptor } from "./qq.ts";
import { telegramDescriptor } from "./telegram.ts";
import { terminalDescriptor } from "./terminal.ts";
import { wecomDescriptor } from "./wecom.ts";
import { weixinDescriptor } from "./weixin.ts";

/** 内置渠道类型（注册顺序即管理台展示顺序） */
export const BUILTIN_DESCRIPTORS: ChannelTypeDescriptor[] = [
  feishuDescriptor,
  wecomDescriptor,
  qqDescriptor,
  weixinDescriptor,
  telegramDescriptor,
  terminalDescriptor,
];
