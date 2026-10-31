import { defineExtension } from "@earendil-works/pi-durable";
import { DatabaseStore } from "../config/database-store.ts";
import { getChannelType } from "./registry.ts";
import { MAX_OUTBOUND_MEDIA, MEDIA_MARKER_PREFIX } from "./runtime/media-outbound.ts";

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
          const channel = store.getChannel(session.channelInstanceId);
          if (!channel) return undefined;
          const descriptor = getChannelType(channel.type);
          if (!descriptor || descriptor.managedBy === "cli") return undefined;

          const lines: string[] = [
            `You are replying through the "${descriptor.label}" chat channel.`,
            `- Markdown support: ${descriptor.capabilities.markdown}.`,
          ];
          if (descriptor.capabilities.mediaOutbound.length > 0) {
            lines.push(
              `- To send files from your workspace, put each path on its own line as \`${MEDIA_MARKER_PREFIX}<path>\` ` +
                "(absolute or relative to the workspace). The gateway validates the path, sends it as an " +
                "attachment after your text, and strips the marker from the visible message. " +
                `Up to ${MAX_OUTBOUND_MEDIA} files; platform size limits still apply.`,
            );
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
