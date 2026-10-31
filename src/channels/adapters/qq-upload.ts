import { createHash } from "node:crypto";
import type { OutboundMedia } from "../base.ts";

/** QQ 媒体类型 */
export const QQ_FILE_IMAGE = 1;
export const QQ_FILE_VIDEO = 2;
export const QQ_FILE_VOICE = 3;
export const QQ_FILE_FILE = 4;

/** 内联 file_data 上限（平台约束约 10MB），超过走分块上传 */
export const QQ_INLINE_MAX_BYTES = 10 * 1024 * 1024;
/** 平台单文件上限约 100MB */
export const QQ_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export interface QQUploadContext {
  /** 复用 adapter 的 QQBot 鉴权/JSON/错误管线 */
  request(path: string, body: Record<string, unknown>, timeoutMs?: number): Promise<any>;
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
  chatType: "c2c" | "group";
  /** 渠道 stop 时中止在途 PUT */
  signal?: AbortSignal;
}

function fileTypeFor(media: OutboundMedia): number {
  if (media.kind === "image") return QQ_FILE_IMAGE;
  if (media.kind === "video") return QQ_FILE_VIDEO;
  if (media.kind === "audio") return QQ_FILE_VOICE;
  return QQ_FILE_FILE;
}

function restPath(chatType: "c2c" | "group", targetId: string, endpoint: string): string {
  const kind = chatType === "c2c" ? "users" : "groups";
  return `/v2/${kind}/${targetId}/${endpoint}`;
}

function extractFileInfo(resp: any): string {
  const info = resp?.file_info ?? resp?.data?.file_info;
  if (!info) throw new Error(`QQ upload returned no file_info: ${JSON.stringify(resp).slice(0, 200)}`);
  return String(info);
}

export interface QQPreparedUpload {
  uploadId: string;
  stride: number;
  parts: { index: number; url: string; blockSize: number }[];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class PermanentUploadError extends Error {}

/** PUT 分片：只对网络错误/5xx 做有界重试，4xx 立即失败 */
async function putPart(
  ctx: QQUploadContext,
  url: string,
  chunk: Buffer,
  partIndex: number,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await ctx.fetchImpl(url, {
        method: "PUT",
        body: new Uint8Array(chunk),
        signal: AbortSignal.any([
          AbortSignal.timeout(300_000),
          ...(ctx.signal ? [ctx.signal] : []),
        ]),
      });
      if (res.ok) return;
      if (res.status < 500) {
        throw new PermanentUploadError(`QQ upload part ${partIndex} HTTP ${res.status}`);
      }
      lastError = new Error(`QQ upload part ${partIndex} HTTP ${res.status}`);
    } catch (err) {
      if (ctx.signal?.aborted) throw err;
      if (err instanceof PermanentUploadError) throw err;
      lastError = err;
    }
    if (attempt < 2) await delay(500 * 2 ** attempt);
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** part_finish：40093001 可重试（参考 hermes），其他错误立即失败 */
async function finishPart(
  ctx: QQUploadContext,
  path: string,
  body: Record<string, unknown>,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await ctx.request(path, body, 120_000);
      return;
    } catch (err) {
      const retryable = String(err).includes("40093001");
      if (!retryable || attempt === 2) throw err;
      await delay(1_000 * (attempt + 1));
    }
  }
}

/** 归一化 QQ upload_prepare 的各种响应形态（data 包装 / parts|part_list / index|part_index） */
export function parseQQUploadPrepare(prepared: any): QQPreparedUpload {
  const src = prepared?.data && typeof prepared.data === "object" ? prepared.data : prepared;
  const uploadId = String(src?.upload_id ?? "");
  const blockSize = Number(src?.block_size ?? 0);
  const rawParts = src?.parts ?? src?.part_list ?? [];
  if (!uploadId || !Array.isArray(rawParts) || rawParts.length === 0) {
    throw new Error(`QQ upload_prepare returned incomplete payload: ${JSON.stringify(prepared).slice(0, 200)}`);
  }
  const parts = rawParts
    .filter((p: any) => p && typeof p === "object")
    .map((p: any) => ({
      index: Number(p.part_index ?? p.index ?? 0),
      url: String(p.presigned_url ?? p.url ?? ""),
      blockSize: Number(p.block_size ?? 0),
    }))
    .sort((a, b) => a.index - b.index);
  const stride = blockSize > 0 ? blockSize : (parts[0]?.blockSize ?? 0);
  return { uploadId, stride, parts };
}

/**
 * 本地文件上传（≤10MB 内联 file_data；更大走 prepare → PUT parts → part_finish → files）。
 * 返回 file_info，供 msg_type=7 的 RichMedia 消息使用。
 */
export async function uploadQQMedia(
  ctx: QQUploadContext,
  peerId: string,
  media: OutboundMedia,
): Promise<string> {
  if (media.sizeBytes > QQ_MAX_UPLOAD_BYTES) {
    throw new Error(`QQ media exceeds 100MB limit`);
  }
  const data = media.data;
  const fileType = fileTypeFor(media);

  if (data.length <= QQ_INLINE_MAX_BYTES) {
    const resp = await ctx.request(restPath(ctx.chatType, peerId, "files"), {
      file_type: fileType,
      srv_send_msg: false,
      file_data: data.toString("base64"),
      ...(fileType === QQ_FILE_FILE ? { file_name: media.filename } : {}),
    });
    return extractFileInfo(resp);
  }

  return uploadChunked(ctx, peerId, media, data, fileType);
}

async function uploadChunked(
  ctx: QQUploadContext,
  peerId: string,
  media: OutboundMedia,
  data: Buffer,
  fileType: number,
): Promise<string> {
  const md5 = createHash("md5").update(data).digest("hex");
  const sha1 = createHash("sha1").update(data).digest("hex");
  const md5_10m = createHash("md5").update(data.subarray(0, 10_002_432)).digest("hex");

  const prepared = await ctx.request(
    restPath(ctx.chatType, peerId, "upload_prepare"),
    {
      file_type: fileType,
      file_name: media.filename,
      file_size: data.length,
      md5,
      sha1,
      md5_10m,
    },
    120_000,
  );
  const { uploadId, stride, parts } = parseQQUploadPrepare(prepared);

  let fallbackOffset = 0;
  for (const part of parts) {
    // QQ 以 1 为 part 起点；offset 由 part_index 与 block_size 推导；
    // 两个 block_size 都缺失时退回顺序偏移（兼容简化响应）
    const offset = stride > 0 ? (part.index - 1) * stride : fallbackOffset;
    const length = Math.min(part.blockSize > 0 ? part.blockSize : stride, data.length - offset);
    if (!part.url || !Number.isFinite(offset) || offset < 0 || !Number.isFinite(length) || length <= 0) {
      throw new Error(`QQ upload_prepare returned invalid part ${part.index}`);
    }
    fallbackOffset = offset + length;
    const chunk = data.subarray(offset, offset + length);
    await putPart(ctx, part.url, chunk, part.index);
    await finishPart(ctx, restPath(ctx.chatType, peerId, "upload_part_finish"), {
      upload_id: uploadId,
      part_index: part.index,
      block_size: chunk.length,
      md5: createHash("md5").update(chunk).digest("hex"),
    });
  }

  const done = await ctx.request(
    restPath(ctx.chatType, peerId, "files"),
    { upload_id: uploadId },
    120_000,
  );
  return extractFileInfo(done);
}
