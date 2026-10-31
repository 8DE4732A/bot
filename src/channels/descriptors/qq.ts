import { QQChannelAdapter } from "../adapters/qq.ts";
import type { ChannelTypeDescriptor } from "../descriptor.ts";
import { accessFields } from "./common.ts";

export const qqDescriptor: ChannelTypeDescriptor = {
  type: "qq",
  label: "QQ 机器人 (QQ Bot)",
  description: "QQ 开放平台官方 Bot API v2（C2C + 群 @）",
  managedBy: "manager",
  creatable: true,
  deletable: true,
  credentials: [
    {
      key: "appId",
      label: "App ID",
      type: "string",
      required: true,
      placeholder: "QQ 开放平台机器人 AppID",
    },
    {
      key: "clientSecret",
      label: "Client Secret",
      type: "secret",
      required: true,
      placeholder: "机器人密钥",
    },
    {
      key: "sandbox",
      label: "沙箱环境",
      type: "boolean",
      section: "advanced",
      hint: "沙箱机器人使用 sandbox.api.sgroup.qq.com",
    },
    {
      key: "markdownSupport",
      label: "Markdown 消息",
      type: "boolean",
      section: "advanced",
      hint: "开启后以 msg_type=2 发送 markdown（需机器人拥有对应权限）",
    },
    ...accessFields(),
  ],
  capabilities: {
    groupChat: true,
    mediaInbound: ["image", "file", "audio", "video"],
    mediaOutbound: ["image", "file", "audio", "video"],
    passiveReply: true,
    typing: true,
    streaming: false,
    markdown: "plain",
    maxMessageBytes: 4_000,
  },
  create: (config, deps) => new QQChannelAdapter(config.id, config.name, config.credentials, deps),
};
