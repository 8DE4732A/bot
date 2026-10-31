import { TelegramChannelAdapter } from "../adapters/telegram.ts";
import type { ChannelTypeDescriptor } from "../descriptor.ts";
import { accessFields } from "./common.ts";

export const telegramDescriptor: ChannelTypeDescriptor = {
  type: "telegram",
  label: "Telegram (基准渠道)",
  description: "Bot API 长轮询，零 SDK 依赖",
  managedBy: "manager",
  creatable: true,
  deletable: true,
  credentials: [
    {
      key: "botToken",
      label: "Bot Token",
      type: "secret",
      required: true,
      placeholder: "123456:ABC-DEF… (@BotFather 获取)",
    },
    ...accessFields(),
  ],
  capabilities: {
    groupChat: true,
    mediaInbound: ["image", "file", "audio", "video"],
    mediaOutbound: [],
    passiveReply: false,
    typing: true,
    streaming: false,
    markdown: "plain",
    maxMessageBytes: 4_096,
  },
  create: (config, deps) =>
    new TelegramChannelAdapter(config.id, config.name, config.credentials, deps),
};
