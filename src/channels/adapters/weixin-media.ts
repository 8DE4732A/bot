import { createCipheriv, createHash, randomBytes } from "node:crypto";
import type { OutboundMedia } from "../base.ts";
import { WX_ITEM_FILE, WX_ITEM_IMAGE, WX_ITEM_VIDEO } from "./weixin-protocol.ts";

/** getuploadurl 的 media_type（与 item_list 的 type 不同） */
const WEIXIN_MEDIA_IMAGE = 1;
const WEIXIN_MEDIA_VIDEO = 2;
const WEIXIN_MEDIA_FILE = 3;

export interface WeixinUploadContext {
  cdnBaseUrl: string;
  /** 调 iLink API（复用 adapter 的鉴权与超时管线） */
  apiPost(endpoint: string, payload: Record<string, unknown>, timeoutMs: number): Promise<any>;
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
  /** 渠道 stop 时中断在途 CDN 上传 */
  signal?: AbortSignal;
}

function aes128EcbEncrypt(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function mediaTypeFor(media: OutboundMedia): number {
  if (media.kind === "image") return WEIXIN_MEDIA_IMAGE;
  if (media.kind === "video") return WEIXIN_MEDIA_VIDEO;
  // 微信不发送原生气泡；音频一律按文件附件（与 hermes 一致）
  return WEIXIN_MEDIA_FILE;
}

function itemFor(
  media: OutboundMedia,
  mediaBlock: Record<string, unknown>,
  ciphertextSize: number,
  rawMd5: string,
): Record<string, unknown> {
  switch (media.kind) {
    case "image":
      return { type: WX_ITEM_IMAGE, image_item: { media: mediaBlock, mid_size: ciphertextSize } };
    case "video":
      return {
        type: WX_ITEM_VIDEO,
        video_item: {
          media: mediaBlock,
          video_size: ciphertextSize,
          play_length: 0,
          video_md5: rawMd5,
        },
      };
    default:
      return {
        type: WX_ITEM_FILE,
        file_item: { media: mediaBlock, file_name: media.filename, len: String(media.sizeBytes) },
      };
  }
}

/**
 * 出站媒体上传（iLink getuploadurl → AES-128-ECB 加密 → CDN POST）。
 *
 * 关键协议细节（对齐 hermes）：
 * - getuploadurl 的 `filesize` 是 PKCS#7 填充后的长度；
 * - 发给 sendmessage 的 `aes_key` 必须是 base64(hex_string)，不是 base64(raw key)；
 * - CDN 上传响应必须携带 `x-encrypted-param`（作为 encrypt_query_param）。
 */
export async function uploadWeixinMedia(
  ctx: WeixinUploadContext,
  media: OutboundMedia,
  peerId: string,
): Promise<Record<string, unknown>> {
  const plaintext = media.data;
  const rawsize = plaintext.length;
  const rawfilemd5 = createHash("md5").update(plaintext).digest("hex");
  const filekey = randomBytes(16).toString("hex");
  const aesKey = randomBytes(16);
  const mediaType = mediaTypeFor(media);

  const uploadResp = await ctx.apiPost(
    "ilink/bot/getuploadurl",
    {
      filekey,
      media_type: mediaType,
      to_user_id: peerId,
      rawsize,
      rawfilemd5,
      filesize: paddedLength(rawsize),
      no_need_thumb: true,
      aeskey: aesKey.toString("hex"),
    },
    15_000,
  );

  const uploadParam = String(uploadResp?.upload_param ?? "");
  const uploadFullUrl = String(uploadResp?.upload_full_url ?? "");
  const uploadUrl =
    uploadFullUrl ||
    (uploadParam
      ? `${ctx.cdnBaseUrl.replace(/\/$/, "")}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`
      : "");
  if (!uploadUrl) {
    throw new Error("iLink getuploadurl returned neither upload_param nor upload_full_url");
  }

  const ciphertext = aes128EcbEncrypt(plaintext, aesKey);
  const res = await ctx.fetchImpl(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: new Uint8Array(ciphertext),
    signal: ctx.signal
      ? AbortSignal.any([AbortSignal.timeout(120_000), ctx.signal])
      : AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    throw new Error(`iLink CDN upload HTTP ${res.status}`);
  }
  const encryptedParam = res.headers.get("x-encrypted-param");
  if (!encryptedParam) {
    throw new Error("iLink CDN upload missing x-encrypted-param header");
  }

  const mediaBlock = {
    encrypt_query_param: encryptedParam,
    // iLink 期望 base64(hex_string)：传 base64(raw_bytes) 图片会显示灰块
    aes_key: Buffer.from(aesKey.toString("hex"), "ascii").toString("base64"),
    encrypt_type: 1,
  };
  return itemFor(media, mediaBlock, ciphertext.length, rawfilemd5);
}

/** PKCS#7 填充后长度（总是补齐一个完整块：16B → 32B） */
export function paddedLength(rawSize: number): number {
  return (Math.floor(rawSize / 16) + 1) * 16;
}
