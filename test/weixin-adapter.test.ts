import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDecipheriv } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseManager } from "../src/database/index.ts";
import { logger } from "../src/utils/logger.ts";
import { WeixinChannelAdapter } from "../src/channels/adapters/weixin.ts";
import type { ChannelAdapterDeps } from "../src/channels/descriptor.ts";

const testHome = mkdtempSync(join(tmpdir(), "bot-weixin-adapter-"));
DatabaseManager.getInstance(join(testHome, "bot.sqlite"));
logger.init(testHome);

const mediaFile = join(testHome, "photo.png");
writeFileSync(mediaFile, "hello-weixin-media");

const state = {
  sent: [] as any[],
  upload: [] as any[],
  ciphertext: Buffer.alloc(0),
  aesKeyHex: "",
  expireOnce: 0,
  pollCount: 0,
  qrStatus: "wait" as string,
};

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path === "/ilink/bot/getupdates") {
      state.pollCount++;
      await new Promise((r) => setTimeout(r, 100));
      return Response.json({ ret: 0, errcode: 0, msgs: [], get_updates_buf: "buf-1" });
    }
    if (path === "/ilink/bot/sendmessage") {
      const body = await req.json();
      state.sent.push(body);
      if (state.expireOnce > 0) {
        state.expireOnce--;
        return Response.json({ ret: -14, errcode: -14, errmsg: "expired" });
      }
      return Response.json({ ret: 0, errcode: 0 });
    }
    if (path === "/ilink/bot/getuploadurl") {
      const body = await req.json();
      state.upload.push(body);
      state.aesKeyHex = body.aeskey;
      return Response.json({ upload_full_url: `${server.url}upload` });
    }
    if (path === "/upload") {
      state.ciphertext = Buffer.from(await req.arrayBuffer());
      return new Response("", { status: 200, headers: { "x-encrypted-param": "ENC-PARAM" } });
    }
    if (path === "/ilink/bot/getconfig") {
      return Response.json({ ret: 0, errcode: 0, typing_ticket: "ticket-1" });
    }
    if (path === "/ilink/bot/get_bot_qrcode") {
      return Response.json({ qrcode: "qr-1", qrcode_img_content: "https://example/qr" });
    }
    if (path === "/ilink/bot/get_qrcode_status") {
      return Response.json({ status: state.qrStatus });
    }
    return new Response("not found", { status: 404 });
  },
});

let adapter: WeixinChannelAdapter;
const deps: ChannelAdapterDeps = {
  runtime: {
    dispatchAndReply: async () => {},
    dispatchInbound: async () => "",
    deliverOutbound: async () => true,
  },
  dotBotDir: join(testHome, ".bot"),
  mediaFetch: fetch,
  tuning: { typingIntervalMs: 50 },
};

beforeAll(async () => {
  adapter = new WeixinChannelAdapter("wx-test", "wx-test", {
    token: "token-1",
    accountId: "acct-1",
    baseUrl: server.url.toString().replace(/\/$/, ""),
  }, deps);
  await adapter.start();
  // 等第一次长轮询成功（healthCheck 依赖）
  await new Promise((r) => setTimeout(r, 250));
});

afterAll(async () => {
  await adapter.stop();
  server.stop(true);
});

describe("WeixinChannelAdapter (local iLink mock)", () => {
  test("sendReply 回带 context_token", async () => {
    state.sent = [];
    const ok = await adapter.sendReply("peer-1", "hello", { contextToken: "ctx-1" });
    expect(ok).toBe(true);
    const body = state.sent.at(-1);
    expect(body.msg.context_token).toBe("ctx-1");
    expect(body.msg.item_list).toEqual([{ type: 1, text_item: { text: "hello" } }]);
  });

  test("-14 时降级 tokenless 重发一次", async () => {
    state.sent = [];
    state.expireOnce = 1;
    const ok = await adapter.sendReply("peer-1", "retry-me", { contextToken: "ctx-expired" });
    expect(ok).toBe(true);
    expect(state.sent.length).toBe(2);
    expect(state.sent[0].msg.context_token).toBe("ctx-expired");
    expect(state.sent[1].msg.context_token).toBeUndefined();
    expect(state.sent[1].msg.item_list[0].text_item.text).toBe("retry-me");
  });

  test("sendMedia 走 getuploadurl + AES 加密 + CDN 上传", async () => {
    state.upload = [];
    state.sent = [];
    const ok = await adapter.sendMedia("peer-1", {
      kind: "image",
      localPath: mediaFile,
      filename: "photo.png",
      mimeType: "image/png",
      sizeBytes: 18,
      data: Buffer.from("hello-weixin-media"),
    });
    expect(ok).toBe(true);
    const upload = state.upload.at(-1);
    expect(upload.media_type).toBe(1);
    expect(upload.filesize).toBe(32); // PKCS#7 填充到 16 的倍数
    expect(upload.aeskey).toMatch(/^[0-9a-f]{32}$/);

    const decipher = createDecipheriv("aes-128-ecb", Buffer.from(upload.aeskey, "hex"), null);
    const plain = Buffer.concat([decipher.update(state.ciphertext), decipher.final()]).toString("utf8");
    expect(plain).toBe("hello-weixin-media");

    const item = state.sent.at(-1).msg.item_list[0];
    expect(item.type).toBe(2);
    expect(item.image_item.media.encrypt_query_param).toBe("ENC-PARAM");
    expect(item.image_item.media.aes_key).toBe(
      Buffer.from(String(upload.aeskey), "ascii").toString("base64"),
    );
  });

  test("healthCheck 反映长轮询新鲜度", async () => {
    const health = await adapter.healthCheck();
    expect(health.ok).toBe(true);
    expect(health.lastSendAt).toBeGreaterThan(0);
    expect(state.pollCount).toBeGreaterThan(0);
  });

  test("无凭据 start 进入待扫码状态而非抛错", async () => {
    const pending = new WeixinChannelAdapter(
      "wx-pending",
      "wx-pending",
      { accountId: "pending-account", baseUrl: server.url.toString().replace(/\/$/, "") },
      deps,
    );
    await pending.start();
    const health = await pending.healthCheck();
    expect(health.ok).toBe(false);
    expect(health.detail).toContain("扫码");
    await pending.stop();
  });
});
