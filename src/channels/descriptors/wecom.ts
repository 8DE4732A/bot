import { WeComChannelAdapter } from "../adapters/wecom.ts";
import type { ChannelTypeDescriptor } from "../descriptor.ts";
import { accessFields } from "./common.ts";

export const wecomDescriptor: ChannelTypeDescriptor = {
  type: "wecom",
  label: "企业微信智能机器人 (WeCom)",
  description: "官方 SDK 长连接 + 流式回复",
  managedBy: "manager",
  creatable: true,
  deletable: true,
  credentials: [
    { key: "botId", label: "Bot ID", type: "string", required: true },
    {
      key: "secret",
      label: "Secret",
      type: "secret",
      required: true,
      placeholder: "智能机器人 Secret",
    },
    {
      key: "welcomeMessage",
      label: "欢迎语（可选）",
      type: "string",
      placeholder: "进入会话时自动回复",
    },
    ...accessFields(),
  ],
  capabilities: {
    groupChat: true,
    mediaInbound: ["image", "file", "audio", "video"],
    mediaOutbound: [],
    passiveReply: true,
    typing: false,
    streaming: true,
    markdown: "full",
    maxMessageBytes: 20_000,
  },
  create: (config, deps) =>
    new WeComChannelAdapter(config.id, config.name, config.credentials, deps),
};
