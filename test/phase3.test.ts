import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync, existsSync } from "node:fs";

import { MessageDeduplicator } from "../src/channels/runtime/dedupe.ts";
import { MessageCoalescer } from "../src/channels/runtime/coalesce.ts";
import { splitMessage } from "../src/channels/runtime/segmenter.ts";
import { downgradeMarkdown } from "../src/channels/runtime/markdown.ts";
import { LoopGuard } from "../src/channels/runtime/loop-guard.ts";
import { InboundPipeline } from "../src/channels/runtime/dispatch.ts";
import type { InboundMessage } from "../src/channels/base.ts";
import { storeMediaBytes } from "../src/channels/runtime/media-cache.ts";

// 测试隔离纪律: 显式绑定临时目录单例 (勿 rmSync——单例被全部套件共享);
// 父目录必须预创建, 不存在的父目录会让 node:sqlite 初始化挂起
import { DatabaseManager } from "../src/database/index.ts";
import { mkdirSync } from "node:fs";
const tmpDbDir = join(tmpdir(), `bot-phase3-${Date.now()}`);
mkdirSync(tmpDbDir, { recursive: true });
DatabaseManager.getInstance(join(tmpDbDir, "bot.sqlite"));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("runtime: MessageDeduplicator", () => {
  test("同 id 短窗口内去重; 无 id 不去重", () => {
    const d = new MessageDeduplicator(60_000);
    expect(d.isDuplicate("m1")).toBe(false);
    expect(d.isDuplicate("m1")).toBe(true);
    expect(d.isDuplicate(undefined)).toBe(false);
    expect(d.isDuplicate(undefined)).toBe(false);
    expect(d.isDuplicate("m2")).toBe(false);
  });
});

describe("runtime: MessageCoalescer", () => {
  test("quiet window 内连发合并为一次派发 (\\n 连接, 元数据取最新)", async () => {
    const got: { text: string; meta: number }[] = [];
    const c = new MessageCoalescer<string, number>({ quietMs: 60, maxWaitMs: 5_000 }, async (_key, merged, meta) => {
      got.push({ text: merged, meta });
    });
    c.submit("peer1", "你好", 1);
    c.submit("peer1", "在吗", 2);
    c.submit("peer2", "另一会话", 3);
    await sleep(200);
    const p1 = got.find((g) => g.text === "你好\n在吗");
    expect(p1).toBeDefined();
    expect(p1!.meta).toBe(2); // 元数据 = 最新一条
    expect(got.find((g) => g.text === "另一会话")?.meta).toBe(3);
    expect(got.length).toBe(2);
  });

  test("派发回调抛错不冒泡 (unhandled rejection 防线)", async () => {
    const c = new MessageCoalescer<string, null>({ quietMs: 30, maxWaitMs: 5_000 }, async () => {
      throw new Error("dispatch boom");
    });
    c.submit("peer", "触发", null);
    await sleep(150); // 派发失败只进日志, 不杀进程
  });

  test("stop() 冲刷未派发消息", async () => {
    const got: string[] = [];
    const c = new MessageCoalescer<string, null>({ quietMs: 60_000, maxWaitMs: 60_000 }, async (_k, merged) => {
      got.push(merged);
    });
    c.submit("peer", "待冲刷", null);
    await c.stop();
    expect(got).toEqual(["待冲刷"]);
  });
});

describe("runtime: splitMessage", () => {
  test("短消息不分段", () => {
    expect(splitMessage("短消息", 100)).toEqual(["短消息"]);
    expect(splitMessage("短消息", undefined)).toEqual(["短消息"]);
  });

  test("长文本优先在段落/换行切分", () => {
    const text = "第一段。\n\n" + "B".repeat(60) + "\n" + "C".repeat(60);
    const parts = splitMessage(text, 40);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(Buffer.byteLength(p, "utf8")).toBeLessThanOrEqual(40);
    expect(parts.join("\n").replace(/\n+/g, "\n")).toContain("第一段。");
  });

  test("切分不出 UTF-8 字符边界错误 (中文 + emoji)", () => {
    const text = "你好".repeat(100) + "👨‍👩‍👧".repeat(10);
    const parts = splitMessage(text, 30);
    for (const p of parts) {
      // 切坏的多字节字符在 round-trip 时会变成 U+FFFD
      expect(p.includes("�")).toBe(false);
    }
    expect(parts.join("")).toContain("你好");
  });

  test("代码块被切开时闭合/重开围栏", () => {
    const code = "```js\n" + "x".repeat(80) + "\n```";
    const parts = splitMessage(code, 40);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      const fences = p.split("```").length - 1;
      expect(fences % 2).toBe(0);
    }
  });

  test("围栏中间段不超预算 (off-by-one 回归守护)", () => {
    // B-R3-1: emit = open + \n + part + \n + marker, budget 曾少减一个 \n
    for (const maxBytes of [100, 4_096, 4_000, 20_000]) {
      const code = "```js\n" + "x".repeat(maxBytes * 3) + "\n```";
      for (const p of splitMessage(code, maxBytes)) {
        expect(Buffer.byteLength(p, "utf8")).toBeLessThanOrEqual(maxBytes);
      }
    }
  });

  test("小预算不死循环 (硬切空截断的码点保底)", () => {
    // M2 回归: budget < 首字符字节数时曾同步死循环
    const start = Date.now();
    const parts = splitMessage("```python\n中文内容行\n```\n", 12);
    expect(parts.length).toBeGreaterThan(0);
    const parts2 = splitMessage("中文".repeat(50), 3);
    expect(parts2.length).toBe(100);
    expect(Date.now() - start).toBeLessThan(2_000);
  });

  test("~~~ / 四反引号围栏的中间段闭合用同款标记", () => {
    const tilde = "~~~js\n" + "x".repeat(80) + "\n~~~";
    for (const p of splitMessage(tilde, 40)) {
      expect((p.split("~~~").length - 1) % 2).toBe(0);
    }
    const four = "````js\n" + "```\ninner\n```\n" + "y".repeat(80) + "\n````";
    for (const p of splitMessage(four, 40)) {
      // 外层 ```` 围栏在每段内保持配对 (内部 ``` 不构成边界)
      expect((p.split("````").length - 1) % 2).toBe(0);
    }
  });
});

describe("runtime: downgradeMarkdown", () => {
  test("full 原样返回", () => {
    const md = "# 标题\n**加粗** `code`";
    expect(downgradeMarkdown(md, "full")).toBe(md);
  });

  test("plain 剥围栏/标记/表格/链接, 保留内容", () => {
    const md = [
      "# 标题",
      "",
      "**加粗** 和 *斜体* 以及 ~~删除~~",
      "",
      "| A | B |",
      "|---|---|",
      "| 1 | 2 |",
      "",
      "[链接文字](https://example.com)",
      "",
      "```js",
      "const x = 1;",
      "```",
    ].join("\n");
    const plain = downgradeMarkdown(md, "plain");
    expect(plain).toContain("标题");
    expect(plain).toContain("加粗");
    expect(plain).not.toContain("**");
    expect(plain).not.toContain("```");
    expect(plain).toContain("const x = 1;");
    expect(plain).toContain("链接文字 (https://example.com)");
    expect(plain).toContain("A  |  B");
    expect(plain).not.toContain("---");
  });
});

describe("runtime: LoopGuard", () => {
  test("窗口内超限熔断; reset 解除", () => {
    const g = new LoopGuard({ windowMs: 60_000, maxEvents: 3 });
    const peer = ["c", "p"] as const;
    for (let i = 0; i < 3; i++) expect(g.check(peer[0], peer[1]).allowed).toBe(true);
    const verdict = g.check(peer[0], peer[1]);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("loop-guard");
    g.reset(peer[0], peer[1]);
    expect(g.check(peer[0], peer[1]).allowed).toBe(true);
    // 其他 peer 不受影响
    expect(g.check("c", "other").allowed).toBe(true);
  });
});

describe("runtime: InboundPipeline", () => {
  const makeMsg = (over: Partial<InboundMessage> = {}): InboundMessage => ({
    channelInstanceId: "ch",
    peerId: "p1",
    content: "hello",
    messageId: "m" + Math.random(),
    ...over,
  });

  test("管道终点收到消息; 重复 messageId 被丢弃", async () => {
    const dispatched: InboundMessage[] = [];
    const p = new InboundPipeline({
      channelId: "ch",
      enableCoalesce: false,
      dispatch: (m) => {
        dispatched.push(m);
        return Promise.resolve();
      },
    });
    await p.submit(makeMsg({ messageId: "dup-1" }));
    await p.submit(makeMsg({ messageId: "dup-1" }));
    await p.submit(makeMsg({ messageId: undefined }));
    await p.submit(makeMsg({ messageId: undefined }));
    expect(dispatched.length).toBe(3);
  });

  test("防抖合并附件并集 (先发图后发字不丢附件)", async () => {
    const dispatched: InboundMessage[] = [];
    const p = new InboundPipeline({
      channelId: "ch-union",
      coalesceQuietMs: 60,
      dispatch: (m) => {
        dispatched.push(m);
        return Promise.resolve();
      },
    });
    await p.submit(
      makeMsg({
        messageId: "u1",
        content: "看这张图",
        attachments: [{ kind: "image", localPath: "/tmp/a.jpg" }],
      }),
    );
    await p.submit(
      makeMsg({
        messageId: "u2",
        content: "放大看",
        attachments: [{ kind: "image", localPath: "/tmp/b.jpg" }],
      }),
    );
    await sleep(120);
    expect(dispatched.length).toBe(1);
    const atts = dispatched[0].attachments ?? [];
    const paths = atts.map((a) => a.localPath);
    expect(paths).toContain("/tmp/a.jpg");
    expect(paths).toContain("/tmp/b.jpg");
  });

  test("loop-guard 熔断后不再派发", async () => {
    const dispatched: InboundMessage[] = [];
    const p = new InboundPipeline({
      channelId: "ch2",
      enableCoalesce: false,
      loopGuard: { windowMs: 60_000, maxEvents: 2 },
      dispatch: (m) => {
        dispatched.push(m);
        return Promise.resolve();
      },
    });
    await p.submit(makeMsg());
    await p.submit(makeMsg());
    await p.submit(makeMsg());
    expect(dispatched.length).toBe(2);
  });

  test("附件引用并入 prompt 文本", async () => {
    const dispatched: InboundMessage[] = [];
    const p = new InboundPipeline({
      channelId: "ch3",
      enableCoalesce: false,
      dispatch: (m) => {
        dispatched.push(m);
        return Promise.resolve();
      },
    });
    await p.submit(
      makeMsg({
        content: "看图",
        attachments: [{ kind: "image", localPath: "/tmp/x.jpg", mimeType: "image/jpeg", sizeBytes: 1234 }],
      }),
    );
    expect(dispatched[0].content).toContain("看图");
    expect(dispatched[0].content).toContain("/tmp/x.jpg");
    expect(dispatched[0].attachments?.length).toBe(1);
  });
});

describe("runtime: storeMediaBytes", () => {
  test("字节落媒体缓存 (文件名注入防护) + uuid 兜底命名", async () => {
    const data = Buffer.from("测试图片内容");
    const named = await storeMediaBytes("ch-media", data, { filename: "../../etc/passwd" });
    expect(existsSync(named.localPath)).toBe(true);
    expect(named.localPath).toContain("passwd"); // basename 保留
    expect(named.localPath).not.toContain("..");
    expect(readFileSync(named.localPath)).toEqual(data);

    const inferred = await storeMediaBytes("ch-media", data, { mimeType: "image/png" });
    expect(inferred.localPath.endsWith(".png")).toBe(true);
    expect(inferred.sizeBytes).toBe(data.length);
  });
});
