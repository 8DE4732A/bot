import { readFile } from "node:fs/promises";
import {
  DEFAULT_IMAGE_LIMITS,
  type ImageLimits,
  type ImageProcessor,
} from "@earendil-works/pi-durable/tools";
import { fitImage } from "@earendil-works/pi-durable/images/fit";
import type { UserInput } from "@earendil-works/pi-durable";
import type { MediaAttachment } from "../base.ts";
import { imagePixelSize } from "./image-size.ts";

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
  /**
   * 1.6.0：按模型限制缩放/转换图片的处理器（`images/fit` 的 `ImageProcessor`）。
   * 传函数则推迟到真正有图片要处理时才解析（纯文本消息不加载 Photon）。
   */
  processor?: ImageProcessor | (() => Promise<ImageProcessor | undefined>);
  /** 图片适配限制（maxBytes 为 base64 长度上限）；缺省 DEFAULT_IMAGE_LIMITS */
  limits?: ImageLimits;
  /** 源文件字节上限（有/无处理器一致）；缺省 8MiB */
  maxSourceBytes?: number;
}

/** 默认源文件上限：比旧 base64 预检（≈3.4MiB）宽容，又避免把超大原图送进解码器。 */
const DEFAULT_MAX_SOURCE_BYTES = 8 * 1024 * 1024;

/**
 * 解码前的像素上限（40MP）：压缩字节很小但宽高极大的图片会让 Photon 按
 * 宽×高×4 分配 wasm 内存（且永不收缩），足以拖垮网关进程。只对有解码的
 * 处理器路径生效；无处理器时图片不解码，没有这个风险。
 */
const MAX_DECODE_PIXELS = 40_000_000;

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
 * - 支持图片的模型 → 作为 user content 的 image block 附加；注入 `processor` 时
 *   先按模型限制缩放/转码（1.6.0 `images/fit`），没有处理器或适配失败则超限跳过
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

  const limits = options.limits ?? DEFAULT_IMAGE_LIMITS;
  const maxSourceBytes = options.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES;
  // 处理器在“确实有图片且模型支持”之后才解析：纯文本消息不加载 Photon
  const processor =
    typeof options.processor === "function" ? await options.processor() : options.processor;
  const read = options.readFile ?? (async (path: string) => new Uint8Array(await readFile(path)));
  const blocks: { type: "image"; data: string; mimeType: string }[] = [];
  const fitNotes: string[] = [];
  const omittedNotes: string[] = [];
  let skipped = 0;

  for (const image of images) {
    if (!image.localPath) {
      skipped++;
      continue;
    }
    // sizeBytes 是上游元数据，可能缺失；先做廉价预检，读入后再按真实字节数复核
    if (image.sizeBytes !== undefined && image.sizeBytes > maxSourceBytes) {
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
    if (bytes.byteLength > maxSourceBytes) {
      skipped++;
      continue;
    }
    const mimeType = sniffImageMime(bytes);
    if (!mimeType || !INLINE_IMAGE_MIME.has(mimeType)) {
      skipped++;
      continue;
    }
    if (processor) {
      // 解码前按文件头拦「小文件、巨像素」的解压炸弹
      const size = imagePixelSize(bytes, mimeType);
      if (size && size.width * size.height > MAX_DECODE_PIXELS) {
        skipped++;
        continue;
      }
      const fitted = await fitImage(bytes, mimeType, limits, processor);
      if (fitted.kind === "omitted") {
        skipped++;
        omittedNotes.push(fitted.note);
        continue;
      }
      blocks.push(fitted.image);
      fitNotes.push(...fitted.notes);
      continue;
    }
    const data = Buffer.from(bytes).toString("base64");
    if (data.length > limits.maxBytes) {
      skipped++;
      continue;
    }
    blocks.push({ type: "image", data, mimeType });
  }

  if (blocks.length === 0) {
    // 声明是图片但无法直接附加（格式/大小/读取失败）：退回路径 + read 提示，
    // 不阻断文本；显式图片模型仍可能通过 read 工具自行读取。
    const reason =
      omittedNotes.length > 0 ? `\n\n[系统提示：${omittedNotes.join(" ")}]` : "";
    return {
      mode: "text",
      text:
        `${text}\n\n[系统提示：用户发送的图片无法直接附加（格式或大小限制），` +
        `请使用 read 工具读取上面的附件路径。]${reason}`,
    };
  }

  const skippedNote =
    skipped > 0
      ? `\n\n[系统提示：另有 ${skipped} 张图片未能直接附加，请使用 read 工具读取上面的附件路径。]`
      : "";
  // 适配说明（尺寸/格式转换）随内容一起给模型，便于它把坐标映射回原图；
  // 无法解码被省略的图片把原因也带上（框架已给出 note）
  const fitNote =
    fitNotes.length > 0 ? `\n\n[系统提示：部分图片已按模型限制处理：${fitNotes.join(" ")}]` : "";
  const omitNote =
    omittedNotes.length > 0 ? `\n\n[系统提示：${omittedNotes.join(" ")}]` : "";
  const combined = `${text}${skippedNote}${fitNote}${omitNote}`;
  return {
    mode: "attach",
    text: combined,
    content: [{ type: "text", text: combined }, ...blocks],
  };
}
