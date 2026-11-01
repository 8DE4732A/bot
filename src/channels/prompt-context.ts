import { defineExtension } from "@earendil-works/pi-durable";
import { DatabaseStore, INTERNAL_MAPPING_CHANNEL } from "../config/database-store.ts";
import { getChannelType } from "./registry.ts";
import {
  MAX_OUTBOUND_MEDIA,
  MAX_TOTAL_OUTBOUND_MEDIA_BYTES,
  MEDIA_MARKER_PREFIX,
  MEDIA_MAX_BYTES,
} from "./runtime/media-outbound.ts";

const MEDIA_MAX_MB = Math.round(MEDIA_MAX_BYTES / (1024 * 1024));
const MEDIA_TOTAL_MAX_MB = Math.round(MAX_TOTAL_OUTBOUND_MEDIA_BYTES / (1024 * 1024));

/** 出站媒体约定（与 deliverOutbound/解析器共用同一组常量，逐条对应实际校验规则） */
const MEDIA_OUTBOUND_LINES = [
  `- Sending files: put each file path on its own line as \`${MEDIA_MARKER_PREFIX}<path>\` ` +
    `(for example \`${MEDIA_MARKER_PREFIX}out/report.pdf\`). The gateway removes the marker ` +
    "from the visible message and sends the files after your text.",
  "  - Only files inside your workspace can be sent: relative paths resolve against the " +
    "workspace, and absolute paths outside it are rejected. Copy a file into the workspace " +
    "first if it lives elsewhere.",
  "  - The marker must be alone on its line and outside code fences; URLs and Markdown " +
    "image links are not sent as attachments.",
  `  - Up to ${MAX_OUTBOUND_MEDIA} files per reply, ${MEDIA_MAX_MB} MB each and ` +
    `${MEDIA_TOTAL_MAX_MB} MB in total; the platform's own limits still apply.`,
];

/**
 * 渠道上下文提示（常驻 section）：
 * 当会话来自某个 IM 渠道时，告诉模型当前平台的排版能力与出站媒体约定
 * （MEDIA:<path>）；终端/Web/调度会话不注入。
 */
export const ChannelContext = defineExtension({
  name: "channel-context",
  sections: [
    {
      key: "channel_context",
      render(input) {
        try {
          const conversationId = input.conversationId ? String(input.conversationId) : "";
          if (!conversationId) return undefined;
          const store = new DatabaseStore();
          const session = store.getSessionByConversation(conversationId);
          if (!session) return undefined;
          // 内部会话（web/scheduler）只有哨兵行，不是真实渠道，直接跳过
          if (session.channelInstanceId === INTERNAL_MAPPING_CHANNEL) return undefined;
          const channel = store.getChannel(session.channelInstanceId);
          if (!channel) return undefined;
          const descriptor = getChannelType(channel.type);
          if (!descriptor || descriptor.managedBy === "cli") return undefined;

          const lines: string[] = [
            `You are replying through the "${descriptor.label}" chat channel.`,
            `- Markdown support: ${descriptor.capabilities.markdown}.`,
          ];
          if (descriptor.capabilities.mediaOutbound.length > 0) {
            lines.push(...MEDIA_OUTBOUND_LINES);
          }
          if (descriptor.capabilities.groupChat) {
            lines.push(
              "- Group and direct-message access are controlled by the gateway's DM/group policies; " +
                "you do not need to enforce allowlists yourself.",
            );
          }
          return lines.join("\n");
        } catch {
          return undefined;
        }
      },
    },
  ],
});
