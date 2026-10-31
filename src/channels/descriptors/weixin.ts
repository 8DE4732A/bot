import {
  ILINK_BASE_URL,
  WeixinChannelAdapter,
  clearWeixinPersistedState,
  extractQrCredentials,
  pollQrStatus,
  startQrLogin,
} from "../adapters/weixin.ts";
import type { ChannelTypeDescriptor } from "../descriptor.ts";
import { accessFields } from "./common.ts";

/** 微信个人号是唯一无普通凭据输入的渠道：扫码后 token 自动并入 credentials */
export const weixinDescriptor: ChannelTypeDescriptor = {
  type: "weixin",
  label: "微信个人号 (Weixin iLink)",
  description: "iLink Bot API 长轮询；扫码登录，通常仅私聊",
  managedBy: "manager",
  creatable: true,
  deletable: true,
  credentialHint: "保存渠道后点击「微信扫码登录」，扫码确认后凭据自动写入并热重启",
  credentials: [
    {
      key: "accountId",
      label: "iLink Bot ID（扫码自动填写）",
      type: "string",
      section: "advanced",
      placeholder: "扫码后自动填写",
    },
    {
      key: "token",
      label: "Bot Token（扫码自动填写）",
      type: "secret",
      section: "advanced",
      placeholder: "扫码后自动填写",
    },
    {
      key: "baseUrl",
      label: "API Base URL（高级）",
      type: "string",
      section: "advanced",
      placeholder: ILINK_BASE_URL,
    },
    {
      key: "cdnBaseUrl",
      label: "媒体 CDN Base URL（高级）",
      type: "string",
      section: "advanced",
      placeholder: "https://novac2c.cdn.weixin.qq.com/c2c",
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
    maxMessageBytes: 2_000,
  },
  auth: {
    kind: "qr",
    label: "微信扫码登录",
    pollIntervalMs: 2_000,
    hint: "扫码确认后 bot_token 自动落盘（0600）并热重启渠道",
    readyFields: ["token"],
    start: async (config) => {
      const baseUrl = String(config.credentials.baseUrl || ILINK_BASE_URL);
      return startQrLogin(baseUrl);
    },
    poll: async (state, config) => {
      const baseUrl = String(config.credentials.baseUrl || ILINK_BASE_URL);
      const resp = await pollQrStatus(state.qrcode, baseUrl, state.redirectHost);
      const status = String(resp.status ?? "wait");
      if (status !== "confirmed") {
        return {
          status,
          redirectHost:
            typeof resp.redirect_host === "string" ? resp.redirect_host : undefined,
        };
      }
      const creds = extractQrCredentials(resp);
      return {
        status,
        credentials: {
          token: creds.token,
          accountId: creds.accountId,
          baseUrl: creds.baseUrl,
        },
        identity: creds.accountId,
      };
    },
  },
  create: (config, deps) =>
    new WeixinChannelAdapter(config.id, config.name, config.credentials, deps),
  onDelete: (config) => {
    clearWeixinPersistedState(
      typeof config.credentials.accountId === "string" ? config.credentials.accountId : undefined,
    );
  },
  onCredentialsChanged: (previous, credentials) => {
    const oldId =
      typeof previous.credentials.accountId === "string" && previous.credentials.accountId
        ? previous.credentials.accountId
        : "default";
    const newId = typeof credentials.accountId === "string" ? credentials.accountId : "";
    // accountId 变化（扫码或手工修改）：清理旧账号目录（空值为 default），
    // 避免以后以旧 accountId 重建时复活旧 token/sync
    if (newId && oldId !== newId) clearWeixinPersistedState(oldId);
  },
};
