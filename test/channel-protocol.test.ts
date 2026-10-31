import { describe, expect, test } from "bun:test";
import {
  buildQQTextBody,
  classifyQQCloseCode,
  isPassiveWindowOpen,
  isVoiceAttachment,
  parseQuotedElements,
  passiveWindowMs,
  pickVoiceUrl,
} from "../src/channels/adapters/qq-protocol.ts";
import {
  describeReference,
  formatWeixinCopyFriendly,
  referencedMediaItems,
  voiceTranscript,
} from "../src/channels/adapters/weixin-protocol.ts";
import { paddedLength } from "../src/channels/adapters/weixin-media.ts";
import { parseQQUploadPrepare, uploadQQMedia } from "../src/channels/adapters/qq-upload.ts";

describe("QQ protocol", () => {
  test("close code 分类", () => {
    expect(classifyQQCloseCode(4004)).toBe("refresh-token");
    expect(classifyQQCloseCode(4006)).toBe("reset-session");
    expect(classifyQQCloseCode(4901)).toBe("reset-session");
    expect(classifyQQCloseCode(4008)).toBe("rate-limit");
    expect(classifyQQCloseCode(4009)).toBe("reconnect");
    expect(classifyQQCloseCode(4914)).toBe("fatal");
    expect(classifyQQCloseCode(4014)).toBe("fatal");
    expect(classifyQQCloseCode(4000)).toBe("reconnect");
  });

  test("被动回复窗口（群 5min / 单聊 60min，预留 5s）", () => {
    const now = 1_000_000;
    expect(passiveWindowMs("group")).toBe(5 * 60_000);
    expect(passiveWindowMs("c2c")).toBe(60 * 60_000);
    expect(isPassiveWindowOpen(now - 10_000, "group", now)).toBe(true);
    expect(isPassiveWindowOpen(now - (5 * 60_000 - 4_000), "group", now)).toBe(false);
    expect(isPassiveWindowOpen(now - (60 * 60_000 - 6_000), "c2c", now)).toBe(true);
    expect(isPassiveWindowOpen(undefined, "c2c", now)).toBe(false);
  });

  test("引用消息解析（文本 + 附件）", () => {
    const parsed = parseQuotedElements([
      { content: "hello" },
      { content: "world", attachments: [{ url: "a" }, { url: "b" }] },
      null,
    ]);
    expect(parsed.text).toBe("hello world");
    expect(parsed.attachments.length).toBe(2);
    expect(parseQuotedElements("bad")).toEqual({ text: "", attachments: [] });
  });

  test("语音判定与 URL 选择", () => {
    expect(isVoiceAttachment("audio/silk", "x.silk")).toBe(true);
    expect(isVoiceAttachment("application/octet-stream", "a.amr")).toBe(true);
    expect(isVoiceAttachment("image/png", "a.png")).toBe(false);
    expect(pickVoiceUrl({ voice_wav_url: "//cdn/x.wav", url: "https://cdn/y.silk" })).toBe(
      "https://cdn/x.wav",
    );
    expect(pickVoiceUrl({ url: "cdn/y.silk" })).toBe("https://cdn/y.silk");
  });

  test("文本/markdown 请求体", () => {
    expect(buildQQTextBody({ content: "hi", markdown: false, msgSeq: 1, replyTo: "m" })).toEqual({
      content: "hi",
      msg_type: 0,
      msg_seq: 1,
      msg_id: "m",
    });
    expect(buildQQTextBody({ content: "**hi**", markdown: true, msgSeq: 2 })).toEqual({
      markdown: { content: "**hi**" },
      msg_type: 2,
      msg_seq: 2,
    });
  });

  test("上传 prepare 响应归一化（data/part_list/url/index 变体 + 乱序）", () => {
    const parsed = parseQQUploadPrepare({
      data: {
        upload_id: "up-1",
        block_size: 1024,
        part_list: [
          { index: 2, url: "https://cos/2" },
          { index: 1, presigned_url: "https://cos/1", block_size: 512 },
        ],
      },
    });
    expect(parsed.uploadId).toBe("up-1");
    expect(parsed.stride).toBe(1024);
    expect(parsed.parts.map((p) => p.index)).toEqual([1, 2]);
    expect(parsed.parts[0]).toEqual({ index: 1, url: "https://cos/1", blockSize: 512 });
    expect(parsed.parts[1].url).toBe("https://cos/2");
  });

  test("QQ >10MB 走 prepare→PUT parts→finish→files，按 part_index 计算偏移", async () => {
    const blockSize = 4 * 1024 * 1024;
    const data = Buffer.alloc(10 * 1024 * 1024 + 3, 7);
    const puts: number[] = [];
    const finishes: any[] = [];
    const ctx = {
      chatType: "c2c" as const,
      request: async (path: string, body: any) => {
        if (path.endsWith("upload_prepare")) {
          return {
            data: {
              upload_id: "up-1",
              block_size: blockSize,
              part_list: [3, 1, 2].map((index) => ({
                index,
                url: `https://cos/${index}`,
              })),
            },
          };
        }
        if (path.endsWith("upload_part_finish")) {
          finishes.push(body);
          return {};
        }
        if (path.endsWith("files")) return { file_info: "FILE-1" };
        throw new Error(`unexpected path ${path}`);
      },
      fetchImpl: async (url: string, init?: RequestInit) => {
        const body = init?.body as Uint8Array;
        expect(url).toMatch(/^https:\/\/cos\/\d$/);
        puts.push(body.length);
        return new Response(null, { status: 200 });
      },
    };

    const info = await uploadQQMedia(
      ctx as any,
      "user-1",
      {
        kind: "image",
        localPath: "/tmp/x.png",
        filename: "x.png",
        sizeBytes: data.length,
        data,
      },
    );
    expect(info).toBe("FILE-1");
    expect(puts).toEqual([blockSize, blockSize, data.length - 2 * blockSize]);
    expect(finishes.map((f) => f.part_index)).toEqual([1, 2, 3]);
    expect(finishes.map((f) => f.block_size)).toEqual(puts);
  });

  test("QQ 分块 PUT 5xx 重试、4xx 不重试、part_finish 40093001 重试", async () => {
    const blockSize = 6 * 1024 * 1024;
    const data = Buffer.alloc(10 * 1024 * 1024 + 1, 1);
    const buildCtx = (putStatuses: number[], finishFailures: number) => {
      let putCalls = 0;
      let finishCalls = 0;
      return {
        ctx: {
          chatType: "c2c" as const,
          request: async (path: string) => {
            if (path.endsWith("upload_prepare")) {
              return {
                upload_id: "up-retry",
                block_size: blockSize,
                parts: [1, 2].map((index) => ({ part_index: index, presigned_url: `u/${index}` })),
              };
            }
            if (path.endsWith("upload_part_finish")) {
              finishCalls++;
              if (finishCalls <= finishFailures) throw new Error("biz 40093001 retry");
              return {};
            }
            return { file_info: "FILE-RETRY" };
          },
          fetchImpl: async () => {
            const status = putStatuses[putCalls++] ?? 200;
            return new Response(null, { status });
          },
        },
        counts: () => ({ puts: putCalls, finishes: finishCalls }),
      };
    };
    const media = {
      kind: "image" as const,
      localPath: "/tmp/x.png",
      filename: "x.png",
      sizeBytes: data.length,
      data,
    };

    const retry = buildCtx([500], 1);
    expect(await uploadQQMedia(retry.ctx as any, "user-1", media)).toBe("FILE-RETRY");
    expect(retry.counts()).toEqual({ puts: 3, finishes: 3 }); // 2 parts + first 500 retry

    const forbidden = buildCtx([403], 0);
    await expect(uploadQQMedia(forbidden.ctx as any, "user-1", media)).rejects.toThrow(/403/);
    expect(forbidden.counts().puts).toBe(1);
  });
});

describe("Weixin protocol", () => {
  test("copy-friendly 排版（标题/表格/空行/围栏）", () => {
    const input = [
      "# 标题",
      "",
      "| a | b |",
      "|---|---|",
      "| 1 | 2 |",
      "",
      "",
      "",
      "```ts",
      "const x = 1; // MEDIA:/tmp/x",
      "```",
    ].join("\n");
    const out = formatWeixinCopyFriendly(input);
    expect(out).toContain("标题");
    expect(out).toContain("a · b");
    expect(out).toContain("1 · 2");
    expect(out).not.toContain("|---|");
    expect(out).toContain("```ts");
    expect(out).toContain("const x = 1; // MEDIA:/tmp/x");
    expect(out).not.toMatch(/\n{3,}/);
  });

  test("引用文本/媒体与语音转写", () => {
    expect(describeReference({ title: "T", message_item: { type: 1, text_item: { text: "body" } } })).toContain(
      "T",
    );
    expect(describeReference({ title: "", message_item: { type: 2 } })).toBe("[引用图片]");
    expect(describeReference({})).toBeUndefined();
    const refs = referencedMediaItems([
      { type: 1, ref_msg: { title: "pic", message_item: { type: 2 } } },
      { type: 1, ref_msg: { title: "txt", message_item: { type: 1 } } },
    ]);
    expect(refs.length).toBe(1);
    expect(refs[0].title).toBe("pic");
    expect(voiceTranscript({ type: 3, voice_item: { text: "你好" } })).toBe("你好");
    expect(voiceTranscript({ type: 1 })).toBeUndefined();
  });

  test("PKCS#7 填充长度（整块也会补一个完整块）", () => {
    expect(paddedLength(1)).toBe(16);
    expect(paddedLength(16)).toBe(32);
    expect(paddedLength(17)).toBe(32);
  });
});
