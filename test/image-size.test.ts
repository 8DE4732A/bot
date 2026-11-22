import { describe, expect, test } from "bun:test";
import { imagePixelSize } from "../src/channels/runtime/image-size.ts";

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  bytes.set([0, 0, 0, 13], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // IHDR
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

function gif(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(10);
  bytes.set(new TextEncoder().encode("GIF89a"));
  bytes[6] = width & 0xff;
  bytes[7] = width >> 8;
  bytes[8] = height & 0xff;
  bytes[9] = height >> 8;
  return bytes;
}

function jpeg(width: number, height: number): Uint8Array {
  const app0 = 16; // 段长含自身 2 字节
  const sof = 17;
  const bytes = new Uint8Array(2 + 2 + app0 + 2 + sof);
  let offset = 0;
  bytes.set([0xff, 0xd8], offset); // SOI
  offset += 2;
  bytes.set([0xff, 0xe0, 0x00, app0], offset); // APP0
  offset += 2 + app0;
  bytes.set([0xff, 0xc0, 0x00, sof], offset); // SOF0
  offset += 4;
  bytes[offset] = 8; // 精度
  bytes[offset + 1] = height >> 8;
  bytes[offset + 2] = height & 0xff;
  bytes[offset + 3] = width >> 8;
  bytes[offset + 4] = width & 0xff;
  return bytes;
}

function webpVp8x(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  bytes.set(new TextEncoder().encode("WEBP"), 8);
  bytes.set(new TextEncoder().encode("VP8X"), 12);
  const w = width - 1;
  const h = height - 1;
  bytes[24] = w & 0xff;
  bytes[25] = (w >> 8) & 0xff;
  bytes[26] = (w >> 16) & 0xff;
  bytes[27] = h & 0xff;
  bytes[28] = (h >> 8) & 0xff;
  bytes[29] = (h >> 16) & 0xff;
  return bytes;
}

describe("imagePixelSize", () => {
  test("识别 PNG / GIF / JPEG / WebP(VP8X) 的宽高", () => {
    expect(imagePixelSize(png(1200, 900), "image/png")).toEqual({ width: 1200, height: 900 });
    expect(imagePixelSize(gif(320, 240), "image/gif")).toEqual({ width: 320, height: 240 });
    expect(imagePixelSize(jpeg(4000, 3000), "image/jpeg")).toEqual({ width: 4000, height: 3000 });
    expect(imagePixelSize(webpVp8x(1920, 1080), "image/webp")).toEqual({ width: 1920, height: 1080 });
  });

  test("头部截断/格式不符/未知格式返回 undefined", () => {
    expect(imagePixelSize(new Uint8Array(10), "image/png")).toBeUndefined();
    expect(imagePixelSize(new TextEncoder().encode("not an image"), "image/png")).toBeUndefined();
    expect(imagePixelSize(png(10, 10), "image/bmp")).toBeUndefined();
    // JPEG 在 SOF 前就遇到 SOS
    expect(imagePixelSize(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2]), "image/jpeg")).toBeUndefined();
  });
});
