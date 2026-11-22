import { describe, expect, test } from "bun:test";
import { DEFAULT_IMAGE_LIMITS } from "@earendil-works/pi-durable/tools";
import { planVisionInput, sniffImageMime, type InboundModelInfo } from "../src/channels/runtime/vision-input.ts";
import { getImageProcessor } from "../src/channels/runtime/image-processor.ts";
import type { MediaAttachment } from "../src/channels/base.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2]);

function attachment(overrides: Partial<MediaAttachment> = {}): MediaAttachment {
  return { kind: "image", localPath: "/tmp/media/photo.png", mimeType: "image/png", ...overrides };
}

const vision: InboundModelInfo = {
  provider: "custom",
  modelId: "vision-model",
  inputModalities: ["text", "image"],
  known: true,
};
const textOnly: InboundModelInfo = {
  provider: "custom",
  modelId: "text-model",
  inputModalities: ["text"],
  known: true,
};
const unknown: InboundModelInfo = {
  provider: "custom",
  modelId: "fallback-model",
  inputModalities: ["text"],
  known: false,
};

describe("sniffImageMime", () => {
  test("识别 jpeg/png/gif 文件头", () => {
    expect(sniffImageMime(PNG)).toBe("image/png");
    expect(sniffImageMime(JPEG)).toBe("image/jpeg");
    expect(sniffImageMime(GIF)).toBe("image/gif");
    expect(sniffImageMime(new TextEncoder().encode("not an image"))).toBeUndefined();
  });
});

describe("planVisionInput", () => {
  test("无图片附件时原样返回文本", async () => {
    const plan = await planVisionInput("hello", [], vision);
    expect(plan).toEqual({ mode: "text", text: "hello" });
  });

  test("明确不支持图片的模型：拒绝且不调用 LLM", async () => {
    const plan = await planVisionInput("describe", [attachment()], textOnly);
    expect(plan.mode).toBe("reject");
    if (plan.mode === "reject") {
      expect(plan.message).toContain("text-model");
      expect(plan.message).toContain("不支持图片输入");
      expect(plan.message).toContain("1 张图片");
    }
  });

  test("模态未知：retain 路径引用并提示 read", async () => {
    const plan = await planVisionInput("describe", [attachment()], unknown);
    expect(plan.mode).toBe("text");
    if (plan.mode === "text") {
      expect(plan.text).toContain("read 工具");
      expect(plan.text).toContain("describe");
    }
  });

  test("支持图片：直接附加 image block（按文件头识别格式）", async () => {
    const plan = await planVisionInput("describe", [attachment()], vision, {
      readFile: async () => PNG,
    });
    expect(plan.mode).toBe("attach");
    if (plan.mode === "attach") {
      expect(Array.isArray(plan.content)).toBe(true);
      const blocks = plan.content as { type: string; text?: string; data?: string; mimeType?: string }[];
      expect(blocks[0]).toEqual({ type: "text", text: "describe" });
      expect(blocks[1]?.type).toBe("image");
      expect(blocks[1]?.mimeType).toBe("image/png");
      expect(Buffer.from(blocks[1]!.data!, "base64")).toEqual(Buffer.from(PNG));
    }
  });

  test("文件内容不是图片时退回路径提示", async () => {
    const plan = await planVisionInput("describe", [attachment()], vision, {
      readFile: async () => new TextEncoder().encode("fake"),
    });
    expect(plan.mode).toBe("text");
    if (plan.mode === "text") expect(plan.text).toContain("read 工具");
  });

  test("超过 base64 上限时跳过并提示", async () => {
    const bigPng = new Uint8Array(2_000);
    bigPng.set(PNG);
    const plan = await planVisionInput("describe", [attachment({ sizeBytes: 2_000 })], vision, {
      readFile: async () => bigPng,
      limits: { ...DEFAULT_IMAGE_LIMITS, maxBytes: 1_000 },
    });
    expect(plan.mode).toBe("text");
    if (plan.mode === "text") expect(plan.text).toContain("无法直接附加");
  });

  test("源文件上限在读取后按真实字节复核（sizeBytes 缺失也生效）", async () => {
    const plan = await planVisionInput("describe", [attachment()], vision, {
      readFile: async () => new Uint8Array(2_000),
      maxSourceBytes: 1_000,
    });
    expect(plan.mode).toBe("text");
    if (plan.mode === "text") expect(plan.text).toContain("无法直接附加");
  });

  test("惰性处理器：纯文本或明确不支持图片时不解析", async () => {
    let calls = 0;
    const getter = async () => {
      calls++;
      return { prepare: async () => undefined };
    };
    await planVisionInput("hi", [], vision, { processor: getter });
    await planVisionInput("describe", [attachment()], textOnly, { processor: getter });
    expect(calls).toBe(0);
  });

  test("注入处理器：超过旧上限的图片缩放后附加，并带适配说明", async () => {
    const processor = {
      prepare: async (bytes: Uint8Array, mimeType: string) => ({
        data: Buffer.from(bytes).toString("base64"),
        mimeType,
        resized: { from: { width: 4_000, height: 3_000 }, to: { width: 1_600, height: 1_200 } },
      }),
    };
    const plan = await planVisionInput(
      "describe",
      [attachment({ sizeBytes: 10_000 })],
      vision,
      {
        processor,
        readFile: async () => PNG,
        limits: { ...DEFAULT_IMAGE_LIMITS, maxBytes: 1_000 },
      },
    );
    expect(plan.mode).toBe("attach");
    if (plan.mode === "attach") {
      const blocks = plan.content as { type: string; data?: string; text?: string }[];
      expect(blocks.filter((block) => block.type === "image")).toHaveLength(1);
      expect(blocks[0]?.text).toContain("Resized from 4000x3000 to 1600x1200");
    }
  });

  test("处理器无法准备时退回 read 提示，并带上框架给出的原因", async () => {
    const processor = { prepare: async () => undefined };
    const plan = await planVisionInput("describe", [attachment()], vision, {
      processor,
      readFile: async () => PNG,
    });
    expect(plan.mode).toBe("text");
    if (plan.mode === "text") {
      expect(plan.text).toContain("无法直接附加");
      expect(plan.text).toContain("cannot be prepared");
    }
  });

  test("解码前拦截解压炸弹：小字节、巨像素的图片直接跳过", async () => {
    const bomb = new Uint8Array(24);
    bomb.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    bomb.set([0x49, 0x48, 0x44, 0x52], 12); // IHDR
    new DataView(bomb.buffer).setUint32(16, 20_000);
    new DataView(bomb.buffer).setUint32(20, 20_000);
    let prepared = 0;
    const processor = {
      prepare: async (bytes: Uint8Array, mimeType: string) => {
        prepared++;
        return { data: Buffer.from(bytes).toString("base64"), mimeType };
      },
    };
    const plan = await planVisionInput("describe", [attachment()], vision, {
      processor,
      readFile: async () => bomb,
    });
    expect(prepared).toBe(0);
    expect(plan.mode).toBe("text");
  });

  test("多张图片中部分失败：附加成功的并提示剩余", async () => {
    const plan = await planVisionInput(
      "describe",
      [attachment({ localPath: "/tmp/a.png" }), attachment({ localPath: "/tmp/b.png" })],
      vision,
      {
        readFile: async (path) => {
          if (path.endsWith("b.png")) throw new Error("gone");
          return JPEG;
        },
      },
    );
    expect(plan.mode).toBe("attach");
    if (plan.mode === "attach") {
      const blocks = plan.content as { type: string; text?: string }[];
      expect(blocks.filter((block) => block.type === "image")).toHaveLength(1);
      expect(blocks[0]?.text).toContain("另有 1 张图片");
    }
  });

  test("处理器加载：源码运行可用（worker 或内嵌 wasm），探测字节不被分离", async () => {
    const processor = await getImageProcessor();
    expect(processor).toBeDefined();
  });
});
