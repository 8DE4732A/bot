import { constants as fsConstants, realpathSync } from "node:fs";
import { open, stat as statFile } from "node:fs/promises";
import { basename, extname, isAbsolute, resolve } from "node:path";
import { isInsidePath } from "../../config/env-paths.ts";
import type { MediaKind, OutboundMedia } from "../base.ts";
import { MEDIA_MAX_BYTES } from "./media-cache.ts";

/** 单条回复允许的媒体数量上限 */
export const MAX_OUTBOUND_MEDIA = 8;
/** 单条回复媒体总大小上限（防 8×128MB 同时驻留） */
export const MAX_TOTAL_OUTBOUND_MEDIA_BYTES = 256 * 1024 * 1024;
/** 提示词与解析器共用的标记前缀 */
export const MEDIA_MARKER_PREFIX = "MEDIA:";

const MEDIA_LINE = /^\s*MEDIA:\s*(.+?)\s*$/i;
const FENCE_LINE = /^\s*(`{3,}|~{3,})/;

/**
 * 从 Agent 回复中剥离 `MEDIA:<path>` 标记（hermes 同款约定）。
 * - 仅识别独占一行的标记；代码围栏内的示例不处理
 * - 返回剩余文本（保留原有段落结构，压缩因删除产生的多余空行）
 */
export function extractMediaMarkers(content: string): { text: string; refs: string[] } {
  if (!/MEDIA:/i.test(content)) return { text: content, refs: [] };

  const refs: string[] = [];
  const kept: string[] = [];
  let fence: string | undefined;

  for (const line of content.split(/\r?\n/)) {
    const fenceMatch = line.match(FENCE_LINE);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (!fence) fence = marker;
      else if (fence === marker) fence = undefined;
      kept.push(line);
      continue;
    }
    if (!fence) {
      const match = line.match(MEDIA_LINE);
      if (match) {
        const ref = match[1].trim().replace(/^["']|["']$/g, "");
        if (ref) refs.push(ref);
        continue;
      }
    }
    kept.push(line);
  }

  const text = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text, refs: refs.slice(0, MAX_OUTBOUND_MEDIA) };
}

interface MediaExtInfo {
  kind: MediaKind;
  mime: string;
}

/** 扩展名 → 类型/MIME 单一表（infer 与 guess 共用，避免两张表漂移） */
const MEDIA_EXT: Record<string, MediaExtInfo> = {
  ".png": { kind: "image", mime: "image/png" },
  ".jpg": { kind: "image", mime: "image/jpeg" },
  ".jpeg": { kind: "image", mime: "image/jpeg" },
  ".gif": { kind: "image", mime: "image/gif" },
  ".webp": { kind: "image", mime: "image/webp" },
  ".bmp": { kind: "image", mime: "image/bmp" },
  ".heic": { kind: "image", mime: "image/heic" },
  ".svg": { kind: "image", mime: "image/svg+xml" },
  ".mp4": { kind: "video", mime: "video/mp4" },
  ".mov": { kind: "video", mime: "video/quicktime" },
  ".m4v": { kind: "video", mime: "video/x-m4v" },
  ".webm": { kind: "video", mime: "video/webm" },
  ".avi": { kind: "video", mime: "video/x-msvideo" },
  ".mkv": { kind: "video", mime: "video/x-matroska" },
  ".mp3": { kind: "audio", mime: "audio/mpeg" },
  ".wav": { kind: "audio", mime: "audio/wav" },
  ".m4a": { kind: "audio", mime: "audio/mp4" },
  ".aac": { kind: "audio", mime: "audio/aac" },
  ".ogg": { kind: "audio", mime: "audio/ogg" },
  ".silk": { kind: "audio", mime: "audio/silk" },
  ".amr": { kind: "audio", mime: "audio/amr" },
  ".flac": { kind: "audio", mime: "audio/flac" },
};

export function inferMediaKind(path: string, mimeType?: string): MediaKind {
  const mime = (mimeType ?? "").toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return MEDIA_EXT[extname(path).toLowerCase()]?.kind ?? "file";
}

function guessMime(path: string): string | undefined {
  return MEDIA_EXT[extname(path).toLowerCase()]?.mime;
}

export interface OutboundMediaResolveOptions {
  workspaceDir: string;
  dotBotDir: string;
  maxBytes?: number;
  /** 跨多次 resolve 共享的剩余总预算（分配前扣减，防超额文件先读入） */
  budget?: { remaining: number };
}

/**
 * 编译一次 workspace/.bot 的 realpath，返回可复用的媒体校验器。
 * 一条回复里的多个 MEDIA 引用只做一次根路径解析。
 */
export function createOutboundMediaResolver(
  opts: OutboundMediaResolveOptions,
): (ref: string) => Promise<OutboundMedia> {
  const realWorkspace = realpathSync(opts.workspaceDir);
  // .bot 可能尚未创建（极早期启动）；不存在时没有可保护的沙盒目录
  let realDotBot: string | undefined;
  try {
    realDotBot = realpathSync(opts.dotBotDir);
  } catch {
    realDotBot = undefined;
  }
  const workspacesRoot = realDotBot ? resolve(realDotBot, "workspaces") : "";
  const maxBytes = opts.maxBytes ?? MEDIA_MAX_BYTES;

  return async (ref: string): Promise<OutboundMedia> => {
    const raw = ref.trim();
    if (!raw) throw new Error("empty media path");
    if (raw.startsWith("~")) throw new Error("home-relative media paths are not allowed");
    if (/^(https?:|file:)/i.test(raw)) throw new Error("URL media is not allowed; use a workspace file path");
    if (!isAbsolute(raw) && raw.includes("://")) throw new Error("invalid media path");

    const candidate = isAbsolute(raw) ? raw : resolve(realWorkspace, raw);
    const realFile = realpathSync(candidate);

    if (!isInsidePath(realWorkspace, realFile)) {
      throw new Error("media path escapes the agent workspace");
    }
    if (realDotBot && isInsidePath(realDotBot, realFile) && !isInsidePath(workspacesRoot, realFile)) {
      throw new Error("media path under .bot is not allowed");
    }

    const stat = await statFile(realFile);
    if (!stat.isFile()) throw new Error("media path is not a regular file");
    if (stat.size <= 0) throw new Error("media file is empty");
    if (stat.size > maxBytes) {
      throw new Error(`media file exceeds ${Math.round(maxBytes / (1024 * 1024))}MB limit`);
    }
    if (opts.budget && stat.size > opts.budget.remaining) {
      throw new Error("media total size exceeds 256MB budget");
    }

    // 校验与读取之间不允许路径被替换：O_NOFOLLOW 封堵最终 symlink，
    // fstat 与 stat 的 dev/ino 比对封堵父目录/文件被调包。
    const handle = await open(realFile, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (!opened.isFile()) throw new Error("media path is not a regular file");
      if (opened.dev !== stat.dev || opened.ino !== stat.ino) {
        throw new Error("media file changed during validation");
      }
      if (opened.size <= 0) throw new Error("media file is empty");
      if (opened.size > maxBytes) {
        throw new Error(`media file exceeds ${Math.round(maxBytes / (1024 * 1024))}MB limit`);
      }
      if (opened.nlink > 1) {
        // 工作区硬链接可能指向 .bot 受保护 inode；出站媒体 fail-closed
        throw new Error("hard-linked media files are not allowed");
      }
      if (opts.budget && opened.size > opts.budget.remaining) {
        throw new Error("media total size exceeds 256MB budget");
      }
      const data = Buffer.alloc(opened.size);
      let read = 0;
      while (read < opened.size) {
        const { bytesRead } = await handle.read(data, read, opened.size - read, read);
        if (bytesRead <= 0) break;
        read += bytesRead;
      }
      if (read !== opened.size) throw new Error("media file changed during read");
      if (opts.budget) opts.budget.remaining -= data.length;
      return {
        kind: inferMediaKind(realFile),
        localPath: realFile,
        filename: basename(realFile),
        mimeType: guessMime(realFile),
        sizeBytes: data.length,
        data,
      };
    } finally {
      await handle.close();
    }
  };
}

/** 单次校验便捷入口（批量场景请用 createOutboundMediaResolver） */
export async function resolveOutboundMedia(
  ref: string,
  opts: OutboundMediaResolveOptions,
): Promise<OutboundMedia> {
  return createOutboundMediaResolver(opts)(ref);
}
