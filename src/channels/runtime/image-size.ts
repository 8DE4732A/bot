/**
 * 从图片文件头解析像素尺寸，供入站图片在解码前做「解压炸弹」预检。
 *
 * 为什么需要：Photon 解码按 宽×高×4 分配 wasm 内存且永不收缩；一张几 MiB 的
 * 高压缩 JPEG/PNG 可以解出上亿像素（数百 MB～GB），足以把网关进程拖入 OOM。
 * 只读头部，不依赖解码器。
 */
export interface ImagePixelSize {
  width: number;
  height: number;
}

/** 已知格式返回像素尺寸；头部损坏/截断/格式不支持返回 undefined。 */
export function imagePixelSize(bytes: Uint8Array, mimeType: string): ImagePixelSize | undefined {
  switch (mimeType) {
    case "image/png":
      return pngSize(bytes);
    case "image/jpeg":
      return jpegSize(bytes);
    case "image/gif":
      return gifSize(bytes);
    case "image/webp":
      return webpSize(bytes);
    default:
      return undefined;
  }
}

function pngSize(bytes: Uint8Array): ImagePixelSize | undefined {
  // 8 字节签名 + 4 字节长度 + "IHDR"；宽高为紧随其后的两个大端 u32
  if (bytes.length < 24) return undefined;
  if (String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!) !== "IHDR") return undefined;
  const width = readUint32BE(bytes, 16);
  const height = readUint32BE(bytes, 20);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

function gifSize(bytes: Uint8Array): ImagePixelSize | undefined {
  // "GIF87a"/"GIF89a" + 逻辑屏幕宽高（小端 u16）
  if (bytes.length < 10) return undefined;
  const width = bytes[6]! | (bytes[7]! << 8);
  const height = bytes[8]! | (bytes[9]! << 8);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

function jpegSize(bytes: Uint8Array): ImagePixelSize | undefined {
  // 逐段扫描到 SOF（C0-CF，排除 C4/C8/CC）；段长含自身的 2 字节
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = bytes[offset + 1]!;
    // 填充字节、无载荷标记
    if (marker === 0xff) {
      offset++;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    // EOI / SOS 之前没遇到 SOF：拿不到尺寸
    if (marker === 0xd9 || marker === 0xda) return undefined;
    if (offset + 4 > bytes.length) return undefined;
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    if (length < 2) return undefined;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      // 段内：精度(1) + 高(2) + 宽(2)
      if (offset + 9 > bytes.length) return undefined;
      const height = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
      const width = (bytes[offset + 7]! << 8) | bytes[offset + 8]!;
      return width > 0 && height > 0 ? { width, height } : undefined;
    }
    offset += 2 + length;
  }
  return undefined;
}

function webpSize(bytes: Uint8Array): ImagePixelSize | undefined {
  // "RIFF" + size + "WEBP" + chunk fourcc
  if (bytes.length < 30) return undefined;
  if (String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!) !== "RIFF") return undefined;
  if (String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!) !== "WEBP") return undefined;
  const chunk = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!);
  if (chunk === "VP8X") {
    // 画布宽高各 3 字节小端，存的是 尺寸-1
    const width = (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)) + 1;
    const height = (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)) + 1;
    return { width, height };
  }
  if (chunk === "VP8 ") {
    // 帧标签(3) + 同步码(3) + 宽(2, 14 位) + 高(2, 14 位)
    if (bytes.length < 30) return undefined;
    const width = (bytes[26]! | (bytes[27]! << 8)) & 0x3fff;
    const height = (bytes[28]! | (bytes[29]! << 8)) & 0x3fff;
    return width > 0 && height > 0 ? { width, height } : undefined;
  }
  if (chunk === "VP8L") {
    // 0x2f 签名 + 4 字节位域：宽-1(14) / 高-1(14)
    if (bytes.length < 25 || bytes[20] !== 0x2f) return undefined;
    const bits =
      (bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24)) >>> 0;
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >>> 14) & 0x3fff) + 1;
    return { width, height };
  }
  return undefined;
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0
  );
}
