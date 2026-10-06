import { createDecipheriv, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rm, stat, unlink } from "node:fs/promises";
import { extname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { AsyncLocalStorage } from "node:async_hooks";
import { getBotPaths } from "../../config/env-paths.ts";
import { logger } from "../../utils/logger.ts";
import { safeFetch } from "../../utils/net-guard.ts";

/** 入站媒体单文件上限 */
export const MEDIA_MAX_BYTES = 128 * 1024 * 1024;
/** 媒体缓存总磁盘水位 (sweep 时超出则从最旧开始删除) */
export const MEDIA_TOTAL_QUOTA_BYTES = 1024 * 1024 * 1024;
/** 全局并发下载上限 (多渠道并发大附件的内存/带宽保护) */
const MAX_CONCURRENT_DOWNLOADS = 4;
let activeDownloads = 0;
const downloadQueue: (() => void)[] = [];

async function acquireDownloadSlot(): Promise<void> {
  if (activeDownloads < MAX_CONCURRENT_DOWNLOADS) {
    activeDownloads++;
    return;
  }
  await new Promise<void>((resolve) => downloadQueue.push(resolve));
  activeDownloads++;
}

function releaseDownloadSlot(): void {
  activeDownloads--;
  const next = downloadQueue.shift();
  if (next) next();
}

/** 可重入信号量上下文: 外层已持 slot 时, 内层嵌套调用直接复用 (防自锁死锁) */
const slotContext = new AsyncLocalStorage<boolean>();

/**
 * 信号量作用域: 网络建连/SDK 请求阶段也计入并发 (不只落盘阶段)。
 * 可重入——adapter 外层占位后调用 downloadMedia/storeMediaStream 等内部
 * 再次请求 slot 时直接复用当前上下文的 slot (嵌套占位会确定性死锁:
 * 4 个外层等内层、内层等计数释放)。
 */
export async function withDownloadSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (slotContext.getStore()) {
    return fn(); // 已持有 slot (异步上下文延续到所有 await 子调用)
  }
  await acquireDownloadSlot();
  return slotContext.run(true, async () => {
    try {
      return await fn();
    } finally {
      releaseDownloadSlot();
    }
  });
}
/** 缓存 TTL: 下载 24h 后可清理 (agent 的引用只在当轮上下文有效) */
const MEDIA_TTL_MS = 24 * 60 * 60 * 1000;
/** TTL 清理最小间隔 (懒触发, 不为清理建常驻定时器) */
const SWEEP_INTERVAL_MS = 30 * 60 * 1000;
/** 强制水位检查阈值: 进程累计落盘超过此量就无视 sweep 节流 (防 quota 被 30min 节流架空) */
const FORCE_SWEEP_BYTES = 128 * 1024 * 1024;
let bytesSinceSweep = 0;

export interface MediaDownloadResult {
  localPath: string;
  sizeBytes: number;
}

function mediaDir(channelId: string): string {
  const dir = join(getBotPaths().dotBot, "media", channelId.replace(/[^a-zA-Z0-9_-]/g, "_"));
  return dir;
}

let lastSweep = 0;

/** 懒清理: 过期媒体删除 + 总量水位执行 (超 MEDIA_TOTAL_QUOTA 从最旧删除) */
export async function sweepMediaCache(): Promise<void> {
  const now = Date.now();
  // TTL 清理按 30min 节流; 但进程累计落盘超阈值时强制执行 (quota 不被节流架空)
  const forced = bytesSinceSweep >= FORCE_SWEEP_BYTES;
  if (forced) bytesSinceSweep = 0;
  else if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  const root = join(getBotPaths().dotBot, "media");
  const all: { path: string; mtimeMs: number; size: number }[] = [];
  try {
    for (const channel of await readdir(root)) {
      const dir = join(root, channel);
      for (const file of await readdir(dir)) {
        const full = join(dir, file);
        try {
          const s = await stat(full);
          if (now - s.mtimeMs > MEDIA_TTL_MS) {
            await unlink(full);
            continue;
          }
          all.push({ path: full, mtimeMs: s.mtimeMs, size: s.size });
        } catch {
          // 单文件失败忽略 (并发清理/已删除)
        }
      }
    }
    // 总量水位: 超出 quota 从最旧删除 (防合法大附件持续写入耗尽磁盘)
    all.sort((a, b) => a.mtimeMs - b.mtimeMs);
    let total = all.reduce((sum, f) => sum + f.size, 0);
    for (const f of all) {
      if (total <= MEDIA_TOTAL_QUOTA_BYTES) break;
      await unlink(f.path).catch(() => {});
      total -= f.size;
    }
  } catch {
    // media 目录不存在等——无需清理
  }
}

/**
 * 入站媒体下载到本地缓存 (safeFetch 强制——SSRF 防线覆盖各平台 CDN):
 * 流式落盘, 边下边计数, 超 MEDIA_MAX_BYTES 中止并删除半成品。
 * 返回 localPath 供 agent 在沙盒内读取; 失败抛错由调用方决定降级策略。
 */
export async function downloadMedia(
  channelId: string,
  url: string,
  options: { filename?: string; mimeType?: string; maxBytes?: number } = {},
): Promise<MediaDownloadResult> {
  return withDownloadSlot(async () => {
    const result = await downloadMediaInner(channelId, url, options, MEDIA_MAX_BYTES);
    bytesSinceSweep += result.sizeBytes;
    return result;
  });
}

async function downloadMediaInner(
  channelId: string,
  url: string,
  options: { filename?: string; mimeType?: string; maxBytes?: number },
  maxBytes: number,
): Promise<MediaDownloadResult> {
  // 建连即计时 (60s), 不等拿到 body
  const res = await safeFetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) {
    // 错误信息不带 URL——各平台下载 URL 可能内嵌凭据 (如 Telegram bot token)
    throw new Error(`media download failed: HTTP ${res.status}`);
  }
  return writeMediaStream(channelId, Readable.fromWeb(res.body as any), options, maxBytes, url);
}

/**
 * 已在宿主进程内拿到的媒体字节直接落盘 (飞书等资源必须经官方 API 拉取,
 * 没有可 fetch 的直链)。与 downloadMedia 共用命名/上限/清理逻辑。
 */
export async function storeMediaBytes(
  channelId: string,
  data: Uint8Array,
  options: { filename?: string; mimeType?: string; maxBytes?: number } = {},
): Promise<MediaDownloadResult> {
  const maxBytes = options.maxBytes ?? MEDIA_MAX_BYTES;
  if (data.byteLength > maxBytes) {
    throw new Error(`media exceeds ${maxBytes} bytes`);
  }
  const result = await writeMediaStream(
    channelId,
    Readable.from(Buffer.from(data)),
    options,
    maxBytes,
    options.filename ?? "inline",
  );
  // 落盘字节计入强制水位 (SDK Buffer 形态的渠道——如企微——同样参与 quota)
  bytesSinceSweep += result.sizeBytes;
  return result;
}

export interface StreamMediaOptions {
  filename?: string;
  mimeType?: string;
  maxBytes?: number;
  /** AES-128-ECB 解密 key (base64(16 字节原始 key) 或 base64(hex 字符串), iLink 媒体) */
  aesKeyB64?: string;
  /** 外部超时/停机信号 */
  signal?: AbortSignal;
}

/**
 * 流式落盘 (零内存累积): 网络流 → [解密] → 边计数边写文件, 超 maxBytes
 * 立即中止并删除半成品。平台媒体 (QQ/飞书/微信) 的"流式落盘"统一入口——
 * 不再把响应体整段读进内存 (并发大附件会 OOM)。
 * 接受 Node Readable 或 Web ReadableStream。
 */
export async function storeMediaStream(
  channelId: string,
  source: NodeJS.ReadableStream | ReadableStream<Uint8Array>,
  options: StreamMediaOptions = {},
): Promise<MediaDownloadResult> {
  return withDownloadSlot(async () => {
    const result = await storeMediaStreamInner(channelId, source, options, MEDIA_MAX_BYTES);
    bytesSinceSweep += result.sizeBytes;
    return result;
  });
}

async function storeMediaStreamInner(
  channelId: string,
  source: NodeJS.ReadableStream | ReadableStream<Uint8Array>,
  options: StreamMediaOptions,
  maxBytes: number,
): Promise<MediaDownloadResult> {
  const dir = mediaDir(channelId);
  await mkdir(dir, { recursive: true });

  const base = (options.filename ?? "").replace(/.*[/\\]/, "").trim();
  const uuid8 = randomUUID().slice(0, 8);
  const name =
    base && base !== "." && base !== ".."
      ? `${uuid8}-${base}`
      : `${uuid8}${extname(options.filename ?? "") || extFromMime(options.mimeType) || ".bin"}`;
  const localPath = join(dir, name);

  // 组装管道: source → [decipher] → counter → file
  let nodeStream: NodeJS.ReadableStream =
    "getReader" in source ? Readable.fromWeb(source as any) : (source as NodeJS.ReadableStream);
  if (options.aesKeyB64) {
    const decipher = createDecipheriv("aes-128-ecb", parseAesKey(options.aesKeyB64), null);
    decipher.setAutoPadding(true);
    nodeStream = nodeStream.pipe(decipher as any);
  }

  let sizeBytes = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      sizeBytes += chunk.length;
      if (sizeBytes > maxBytes) {
        cb(new Error(`media exceeds ${maxBytes} bytes`));
        return;
      }
      cb(null, chunk);
    },
  });
  // signal 已预中止: 直接失败 (对已中止 signal addEventListener 不会触发)
  if (options.signal?.aborted) {
    throw new Error("media download aborted");
  }
  let onAbort: (() => void) | undefined;
  const externalAbort = options.signal && new Promise<never>((_, reject) => {
    onAbort = () => {
      // race 胜出时必须销毁源流——否则下载管道继续写已 unlink 的 inode
      (nodeStream as any).destroy?.(new Error("media download aborted"));
      reject(new Error("media download aborted"));
    };
    options.signal!.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([
      pipeline(nodeStream, counter, createWriteStream(localPath, { flags: "wx" })),
      ...(externalAbort ? [externalAbort] : []),
    ]);
  } catch (err) {
    (nodeStream as any).destroy?.();
    await rm(localPath, { force: true }).catch(() => {});
    throw err;
  } finally {
    // 正常完成后移除 abort listener (长期 signal 不被本下载持有)
    if (onAbort) options.signal?.removeEventListener("abort", onAbort);
  }
  void sweepMediaCache();
  return { localPath, sizeBytes };
}

/** iLink aes_key 两种形态: base64(16 字节原始 key) 或 base64(hex 字符串) */
function parseAesKey(aesKeyB64: string): Buffer {
  const decoded = Buffer.from(aesKeyB64, "base64");
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32) {
    const text = decoded.toString("ascii");
    if (/^[0-9a-fA-F]{32}$/.test(text)) return Buffer.from(text, "hex");
  }
  throw new Error(`unexpected aes_key format (${decoded.length} bytes)`);
}

async function writeMediaStream(
  channelId: string,
  stream: NodeJS.ReadableStream & { on?: Function },
  options: { filename?: string; mimeType?: string },
  maxBytes: number,
  url: string,
): Promise<MediaDownloadResult> {
  const dir = mediaDir(channelId);
  await mkdir(dir, { recursive: true });

  // 文件名: 优先平台提供的, 兜底 uuid + 扩展名 (防路径注入——只取 basename;
  // 命名带 uuid 前缀保证独占创建永不冲突, 重复媒体不去重, 由 TTL 清理兜底)
  const base = (options.filename ?? "").replace(/.*[/\\]/, "").trim();
  const uuid8 = randomUUID().slice(0, 8);
  const name =
    base && base !== "." && base !== ".."
      ? `${uuid8}-${base}`
      : `${uuid8}${extname(options.filename ?? "") || extFromMime(options.mimeType) || ".bin"}`;
  const localPath = join(dir, name);

  let sizeBytes = 0;
  const wrapped = stream.on("data", (chunk: Buffer) => {
    sizeBytes += chunk.length;
    if (sizeBytes > maxBytes) (stream as any).destroy?.(new Error(`media exceeds ${maxBytes} bytes`));
  }) as NodeJS.ReadableStream;
  try {
    await pipeline(wrapped, createWriteStream(localPath, { flags: "wx" }));
  } catch (err) {
    await rm(localPath, { force: true }).catch(() => {});
    throw err;
  }
  void sweepMediaCache();
  return { localPath, sizeBytes };
}

function extFromMime(mime?: string): string {
  if (!mime) return "";
  const map: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "audio/amr": ".amr",
    "audio/silk": ".silk",
    "audio/mpeg": ".mp3",
    "video/mp4": ".mp4",
    "application/pdf": ".pdf",
  };
  return map[mime.split(";")[0].trim()] ?? "";
}

/** 渠道删除时清空其媒体缓存 (ChannelManager.unregister 生命周期调用) */
export async function clearMediaCache(channelId: string): Promise<void> {
  await rm(mediaDir(channelId), { recursive: true, force: true }).catch(() => {});
  logger.debug("MediaCache", `Cleared media cache for channel '${channelId}'`);
}
