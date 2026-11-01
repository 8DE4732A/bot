import { readFile } from "node:fs/promises";
import { DEFAULT_IMAGE_LIMITS } from "@earendil-works/pi-durable/tools";
import type { UserInput } from "@earendil-works/pi-durable";
import type { MediaAttachment } from "../base.ts";

const INLINE_IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

export interface InboundModelInfo {
  provider: string;
  modelId: string;
  inputModalities: string[];
  /** false = 目录 fallback，图片能力未知（fail-open，保留 read 路径） */
  known: boolean;
}

export type VisionPlan =
  | { mode: "text"; text: string }
  | { mode: "attach"; text: string; content: UserInput }
  | { mode: "reject"; message: string };

export interface VisionInputOptions {
  readFile?: (path: string) => Promise<Uint8Array>;
  /** base64 长度上限（与 pi-durable read 的默认限制一致） */
  maxBytes?: number;
}

/** 按文件头判断真实图片格式，避免把伪装成图片的文件直接发给模型。 */
export function sniffImageMime(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return undefined;
}

/**
 * 入站图片策略：
 * - 明确不支持图片的模型 → 拒绝（不调用 LLM，直接回复用户）
 * - 支持图片的模型 → 直接作为 user content 的 image block 附加（单张超过 base64 上限则跳过）
 * - 模态未知（fallback 目录）→ 保留路径引用，提示模型用 read 读取
 */
export async function planVisionInput(
  text: string,
  attachments: MediaAttachment[] | undefined,
  model: InboundModelInfo | undefined,
  options: VisionInputOptions = {},
): Promise<VisionPlan> {
  const images = (attachments ?? []).filter((attachment) => attachment.kind === "image");
  if (images.length === 0) return { mode: "text", text };

  const label = model ? `${model.provider}/${model.modelId}` : "当前模型";
  if (model?.known && !model.inputModalities.includes("image")) {
    return {
      mode: "reject",
      message:
        `当前模型（${label}）不支持图片输入，本次消息包含 ${images.length} 张图片，未被发送给模型。` +
        "请改用支持视觉的模型，或去掉图片后重新发送文字内容。",
    };
  }

  if (!model || !model.known) {
    return {
      mode: "text",
      text:
        `${text}\n\n[系统提示：用户发送了 ${images.length} 张图片，当前无法确认模型是否支持图片；` +
        "请使用 read 工具读取上面的附件路径。]",
    };
  }

  const maxBytes = options.maxBytes ?? DEFAULT_IMAGE_LIMITS.maxBytes;
  const read = options.readFile ?? (async (path: string) => new Uint8Array(await readFile(path)));
  const blocks: { type: "image"; data: string; mimeType: string }[] = [];
  let skipped = 0;

  for (const image of images) {
    if (!image.localPath) {
      skipped++;
      continue;
    }
    // base64 后约 4/3；sizeBytes 是原始字节，先做保守预检避免读入超大文件
    if (image.sizeBytes !== undefined && image.sizeBytes > Math.floor((maxBytes * 3) / 4)) {
      skipped++;
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = await read(image.localPath);
    } catch {
      skipped++;
      continue;
    }
    const mimeType = sniffImageMime(bytes);
    if (!mimeType || !INLINE_IMAGE_MIME.has(mimeType)) {
      skipped++;
      continue;
    }
    const data = Buffer.from(bytes).toString("base64");
    if (data.length > maxBytes) {
      skipped++;
      continue;
    }
    blocks.push({ type: "image", data, mimeType });
  }

  if (blocks.length === 0) {
    // 声明是图片但无法直接附加（格式/大小/读取失败）：退回路径 + read 提示，
    // 不阻断文本；显式图片模型仍可能通过 read 工具自行读取。
    return {
      mode: "text",
      text:
        `${text}\n\n[系统提示：用户发送的图片无法直接附加（格式或大小限制），` +
        "请使用 read 工具读取上面的附件路径。]",
    };
  }

  const note =
    skipped > 0
      ? `\n\n[系统提示：另有 ${skipped} 张图片未能直接附加，请使用 read 工具读取上面的附件路径。]`
      : "";
  const combined = `${text}${note}`;
  return {
    mode: "attach",
    text: combined,
    content: [{ type: "text", text: combined }, ...blocks],
  };
}
