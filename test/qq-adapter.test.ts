import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseManager } from "../src/database/index.ts";
import { logger } from "../src/utils/logger.ts";
import { QQChannelAdapter } from "../src/channels/adapters/qq.ts";
import type { ChannelAdapterDeps } from "../src/channels/descriptor.ts";
import type { InboundMessage } from "../src/channels/base.ts";

const testHome = mkdtempSync(join(tmpdir(), "bot-qq-adapter-"));
DatabaseManager.getInstance(join(testHome, "bot.sqlite"));
logger.init(testHome);

const mediaFile = join(testHome, "pic.png");
writeFileSync(mediaFile, "qq-media-bytes");

const state = {
  inbound: [] as InboundMessage[],
  rest: [] as { path: string; body: any }[],
  seq: 0,
  sockets: new Set<any>(),
};

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      if (srv.upgrade(req)) return;
      return new Response("upgrade failed", { status: 400 });
    }
    if (url.pathname === "/app/getAppAccessToken") {
      return Response.json({ access_token: "qq-token", expires_in: 7200 });
    }
    if (url.pathname === "/gateway") {
      return Response.json({ url: `ws://127.0.0.1:${server.port}/ws` });
    }
    if (url.pathname.endsWith("/messages") || url.pathname.endsWith("/files")) {
      return req.json().then((body) => {
        state.rest.push({ path: url.pathname, body });
        if (url.pathname.endsWith("/files")) return Response.json({ file_info: "FILE-INFO" });
        return Response.json({ id: "sent-1" });
      });
    }
    return new Response("not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      state.sockets.add(ws);
      ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 30_000 } }));
    },
    message(ws, raw) {
      const payload = JSON.parse(String(raw));
      if (payload.op === 2) {
        ws.send(JSON.stringify({ op: 0, s: ++state.seq, t: "READY", d: { session_id: "sess-1" } }));
      } else if (payload.op === 6) {
        ws.send(JSON.stringify({ op: 0, s: ++state.seq, t: "RESUMED", d: {} }));
      } else if (payload.op === 1) {
        ws.send(JSON.stringify({ op: 11 }));
      }
    },
    close(ws) {
      state.sockets.delete(ws);
    },
  },
});

function pushEvent(type: string, d: any) {
  const frame = JSON.stringify({ op: 0, s: ++state.seq, t: type, d });
  for (const ws of state.sockets) ws.send(frame);
}

const deps: ChannelAdapterDeps = {
  runtime: {
    dispatchAndReply: async (message) => {
      state.inbound.push(message);
    },
    dispatchInbound: async () => "",
    deliverOutbound: async () => true,
  },
  qq: {
    apiBase: `http://127.0.0.1:${server.port}`,
    tokenUrl: `http://127.0.0.1:${server.port}/app/getAppAccessToken`,
  },
  mediaFetch: fetch,
  tuning: { disableCoalesce: true, typingIntervalMs: 60_000 },
};

let adapter: QQChannelAdapter;

beforeAll(async () => {
  adapter = new QQChannelAdapter("qq-test", "qq-test", {
    appId: "app-1",
    clientSecret: "secret-1",
    markdownSupport: true,
  }, deps);
  await adapter.start();
  // 等 READY（healthCheck 依赖 sessionId）
  for (let i = 0; i < 50; i++) {
    if ((await adapter.healthCheck()).ok) break;
    await new Promise((r) => setTimeout(r, 20));
  }
});

afterAll(async () => {
  await adapter.stop();
  server.stop(true);
});

describe("QQChannelAdapter (local gateway mock)", () => {
  test("healthCheck 反映 WS 就绪", async () => {
    const health = await adapter.healthCheck();
    expect(health.ok).toBe(true);
  });

  test("C2C 入站：peer/senderId/正文", async () => {
    state.inbound = [];
    pushEvent("C2C_MESSAGE_CREATE", {
      id: "m1",
      content: "hello",
      author: { user_openid: "user-1", username: "Alice" },
    });
    await new Promise((r) => setTimeout(r, 80));
    expect(state.inbound.length).toBe(1);
    expect(state.inbound[0]).toMatchObject({
      peerId: "user-1",
      senderId: "user-1",
      content: "hello",
      conversationType: "direct",
    });
  });

  test("群 @ 入站：peer=group，sender=member", async () => {
    state.inbound = [];
    pushEvent("GROUP_AT_MESSAGE_CREATE", {
      id: "m2",
      content: "@bot hi group",
      group_openid: "group-1",
      author: { member_openid: "member-1", username: "Bob" },
    });
    await new Promise((r) => setTimeout(r, 80));
    expect(state.inbound.length).toBe(1);
    expect(state.inbound[0]).toMatchObject({
      peerId: "group-1",
      senderId: "member-1",
      content: "hi group",
      conversationType: "group",
    });
  });

  test("被动回复带 msg_id；窗口过期直接返回 false", async () => {
    state.rest = [];
    const ok = await adapter.sendReply("user-1", "reply", { msgId: "m1" });
    expect(ok).toBe(true);
    const body = state.rest.at(-1)?.body;
    expect(body.msg_id).toBe("m1");
    expect(body.markdown.content).toBe("reply");
    expect(body.msg_type).toBe(2);

    // 模拟 61 分钟前的入站：单聊被动窗口已关闭
    (adapter as any).lastInboundAtByPeer.set("user-1", Date.now() - 61 * 60_000);
    state.rest = [];
    expect(await adapter.sendReply("user-1", "late", { msgId: "m1" })).toBe(false);
    expect(state.rest.length).toBe(0);
  });

  test("sendMedia 走 files 上传并发送 msg_type=7", async () => {
    state.rest = [];
    const ok = await adapter.sendMedia("user-1", {
      kind: "image",
      localPath: mediaFile,
      filename: "pic.png",
      mimeType: "image/png",
      sizeBytes: 14,
      data: Buffer.from("qq-media-bytes"),
    });
    expect(ok).toBe(true);
    expect(state.rest[0].path).toBe("/v2/users/user-1/files");
    expect(state.rest[0].body.file_type).toBe(1);
    expect(state.rest[1].body).toMatchObject({
      msg_type: 7,
      media: { file_info: "FILE-INFO" },
    });
  });
});
