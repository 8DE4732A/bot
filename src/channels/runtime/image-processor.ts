import { DEFAULT_IMAGE_LIMITS, type ImageProcessor } from "@earendil-works/pi-durable/tools";
import { logger } from "../../utils/logger.ts";
import { readPhotonWasm } from "./photon-wasm.ts";

/**
 * Photon 图片处理器的懒加载单例（1.6.0 `images/fit` 的 `ImageProcessor`）。
 *
 * 两级加载：
 * 1. `images/node` 的 worker 线程处理器（源码运行；解码不阻塞事件循环）；
 * 2. 单文件二进制里 worker 无法按 node_modules 解析 `photon_rs_bg.wasm`，
 *    退回构建期内嵌的 wasm（`photon-wasm.ts`）+ 进程内处理器。
 *
 * 两级都用一张 1×1 PNG 探测：真到 `prepare()` 才失败会让 `fitImage` 把
 * 图片当成“无法准备”直接丢弃，比旧行为更糟；探测失败就返回 undefined，
 * 调用方退回“超限跳过 + read 提示”。
 */
// 必须是真正的 Uint8Array 拷贝：worker 处理器对 Node Buffer 调 slice() 会共享
// 底层（Buffer 池），postMessage 转移后会分离整个池；plain Uint8Array 的
// slice() 是拷贝，转移只影响副本。源码运行与二进制可复用同一份探测字节。
const PROBE_PNG = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
);

let pending: Promise<ImageProcessor | undefined> | undefined;

export function getImageProcessor(): Promise<ImageProcessor | undefined> {
  pending ??= load();
  return pending;
}

async function load(): Promise<ImageProcessor | undefined> {
  // 1) worker：解码不阻塞事件循环
  try {
    const { createNodePhotonImages } = await import("@earendil-works/pi-durable/images/node");
    const processor = await createNodePhotonImages();
    if (await processor.prepare(PROBE_PNG, "image/png", DEFAULT_IMAGE_LIMITS)) return processor;
  } catch (error) {
    // 单文件二进制预期会失败（worker 解析不到 wasm），继续走内嵌 wasm
    logger.debug("VisionInput", `Photon worker processor unavailable: ${error}`);
  }
  // 2) 内嵌 wasm：worker 不可用时（如单文件二进制）；解码在调用线程，只影响超限图片
  try {
    const [{ createPhotonImages }, wasm] = await Promise.all([
      import("@earendil-works/pi-durable/images"),
      readPhotonWasm(),
    ]);
    const processor = createPhotonImages(wasm);
    if (await processor.prepare(PROBE_PNG, "image/png", DEFAULT_IMAGE_LIMITS)) return processor;
    logger.warn("VisionInput", "Image processor unavailable: the probe image could not be prepared");
  } catch (error) {
    logger.warn(
      "VisionInput",
      `Image processor unavailable (oversized images will be skipped instead of resized): ${error}`,
    );
  }
  return undefined;
}
