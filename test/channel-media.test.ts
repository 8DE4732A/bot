import { afterAll, describe, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractMediaMarkers,
  inferMediaKind,
  resolveOutboundMedia,
} from "../src/channels/runtime/media-outbound.ts";

const root = mkdtempSync(join(tmpdir(), "bot-media-out-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const workspace = join(root, "workspace");
const dotBot = join(root, ".bot");
mkdirSync(workspace, { recursive: true });
mkdirSync(join(dotBot, "channels"), { recursive: true });
mkdirSync(join(dotBot, "workspaces", "agent"), { recursive: true });

writeFileSync(join(workspace, "a.png"), "png-data");
writeFileSync(join(root, "outside.txt"), "outside");
writeFileSync(join(dotBot, "channels", "secret.txt"), "secret");
writeFileSync(join(dotBot, "workspaces", "agent", "ok.txt"), "ok");
writeFileSync(join(workspace, "empty.txt"), "");
mkdirSync(join(workspace, "dir"));
symlinkSync(join(root, "outside.txt"), join(workspace, "escape.txt"));
writeFileSync(join(workspace, "hard-base.txt"), "hard");
linkSync(join(workspace, "hard-base.txt"), join(workspace, "hard.png"));

const opts = { workspaceDir: workspace, dotBotDir: dotBot };

describe("extractMediaMarkers", () => {
  test("剥离独占行的 MEDIA 标记并保持正文", () => {
    const { text, refs } = extractMediaMarkers("hello\nMEDIA:/tmp/a.png\nworld\n  media: b.png  ");
    expect(refs).toEqual(["/tmp/a.png", "b.png"]);
    expect(text).toBe("hello\nworld");
  });

  test("代码围栏内的示例不当作媒体", () => {
    const content = "示例：\n```\nMEDIA:/tmp/example.png\n```\n结束";
    const { text, refs } = extractMediaMarkers(content);
    expect(refs).toEqual([]);
    expect(text).toContain("MEDIA:/tmp/example.png");
  });

  test("最多 8 个", () => {
    const content = Array.from({ length: 12 }, (_, i) => `MEDIA:/tmp/${i}.png`).join("\n");
    expect(extractMediaMarkers(content).refs.length).toBe(8);
  });
});

describe("resolveOutboundMedia", () => {
  test("workspace 内普通文件", async () => {
    const media = await resolveOutboundMedia("a.png", opts);
    expect(media.kind).toBe("image");
    expect(media.filename).toBe("a.png");
    expect(media.sizeBytes).toBe(8);
    expect(media.data.toString()).toBe("png-data");
    expect(media.localPath.startsWith(realpathSync(workspace))).toBe(true);
  });

  test("返回受控读取的文件快照，不依赖之后可被替换的路径", async () => {
    const path = join(workspace, "snapshot.txt");
    writeFileSync(path, "before");
    const media = await resolveOutboundMedia("snapshot.txt", opts);
    writeFileSync(path, "after");
    expect(media.data.toString()).toBe("before");
    expect(media.sizeBytes).toBe(6);
  });

  test("拒绝 ../ 逃逸、symlink 逃逸、目录、空文件", async () => {
    await expect(resolveOutboundMedia("../outside.txt", opts)).rejects.toThrow(/escapes/);
    await expect(resolveOutboundMedia("escape.txt", opts)).rejects.toThrow(/escapes/);
    await expect(resolveOutboundMedia("dir", opts)).rejects.toThrow(/regular file/);
    await expect(resolveOutboundMedia("empty.txt", opts)).rejects.toThrow(/empty/);
    await expect(resolveOutboundMedia("hard.png", opts)).rejects.toThrow(/hard-linked/);
  });

  test("拒绝 .bot 下的凭据/日志，但允许 .bot/workspaces", async () => {
    await expect(
      resolveOutboundMedia(join(dotBot, "channels", "secret.txt"), {
        workspaceDir: dotBot,
        dotBotDir: dotBot,
      }),
    ).rejects.toThrow(/under \.bot/);
    await expect(
      resolveOutboundMedia(join(dotBot, "workspaces", "agent", "ok.txt"), {
        workspaceDir: join(dotBot, "workspaces", "agent"),
        dotBotDir: dotBot,
      }),
    ).resolves.toMatchObject({ filename: "ok.txt" });
  });

  test("拒绝 URL、~ 与超出体积上限", async () => {
    await expect(resolveOutboundMedia("https://x/y.png", opts)).rejects.toThrow(/URL/);
    await expect(resolveOutboundMedia("~/a.png", opts)).rejects.toThrow(/home-relative/);
    await expect(resolveOutboundMedia("a.png", { ...opts, maxBytes: 2 })).rejects.toThrow(/limit/);
  });
});

describe("inferMediaKind", () => {
  test("按 mime 与扩展名推断", () => {
    expect(inferMediaKind("x", "image/png")).toBe("image");
    expect(inferMediaKind("x.mp4")).toBe("video");
    expect(inferMediaKind("x.silk")).toBe("audio");
    expect(inferMediaKind("x.pdf")).toBe("file");
  });
});
