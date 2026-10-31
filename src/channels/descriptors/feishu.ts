import { FeishuChannelAdapter } from "../adapters/feishu.ts";
import type { ChannelTypeDescriptor } from "../descriptor.ts";
import { accessFields } from "./common.ts";

export const feishuDescriptor: ChannelTypeDescriptor = {
  type: "feishu",
  label: "飞书 (Feishu)",
  description: "飞书自建应用，官方 SDK WebSocket 长连接，无需公网回调",
  managedBy: "manager",
  creatable: true,
  deletable: true,
  credentials: [
    { key: "appId", label: "App ID", type: "string", required: true, placeholder: "cli_xxx" },
    {
      key: "appSecret",
      label: "App Secret",
      type: "secret",
      required: true,
      placeholder: "飞书开放平台应用密钥",
    },
    ...accessFields(),
  ],
  capabilities: {
    groupChat: true,
    mediaInbound: ["image", "file", "audio", "video"],
    mediaOutbound: [],
    passiveReply: true,
    typing: false,
    streaming: false,
    markdown: "plain",
    maxMessageBytes: 140_000,
  },
  create: (config, deps) =>
    new FeishuChannelAdapter(config.id, config.name, config.credentials, deps),
};
