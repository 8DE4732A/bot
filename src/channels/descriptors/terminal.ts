import type { ChannelTypeDescriptor } from "../descriptor.ts";

/** terminal 由 CLI 管理（REPL 绑定进程 stdin），管理台只能编辑既有实例的绑定/启用状态 */
export const terminalDescriptor: ChannelTypeDescriptor = {
  type: "terminal",
  label: "本地终端",
  description: "本地 REPL 交互通道（由 CLI 管理，不可在管理台新建或删除）",
  managedBy: "cli",
  creatable: false,
  deletable: false,
  credentials: [],
  capabilities: {
    groupChat: false,
    mediaInbound: [],
    mediaOutbound: [],
    passiveReply: false,
    typing: false,
    streaming: false,
    markdown: "full",
    maxMessageBytes: 0,
  },
};
