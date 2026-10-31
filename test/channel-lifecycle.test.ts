import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseManager } from "../src/database/index.ts";
import { DatabaseStore } from "../src/config/database-store.ts";
import { ChannelManager } from "../src/channels/manager.ts";
import { registerChannelType } from "../src/channels/registry.ts";
import type { ChannelTypeDescriptor } from "../src/channels/descriptor.ts";
import type { ChannelAdapter, InboundMessage } from "../src/channels/base.ts";
import { logger } from "../src/utils/logger.ts";

const testHome = mkdtempSync(join(tmpdir(), "bot-channel-life-"));
DatabaseManager.getInstance(join(testHome, "bot.sqlite"));
logger.init(testHome);

const store = new DatabaseStore();
const manager = ChannelManager.getInstance();

const state = {
  active: 0,
  maxActive: 0,
  starts: [] as string[],
  stops: [] as string[],
  deleted: [] as string[],
  sent: [] as string[],
  media: [] as string[],
  failIds: new Set<string>(),
  failMedia: false,
  failSend: false,
};

class FakeAdapter implements ChannelAdapter {
  readonly type = "fake-lifecycle";
  readonly name: string;
  readonly maxMessageBytes = 1_000;
  constructor(readonly id: string) {
    this.name = id;
  }
  async start(): Promise<void> {
    if (state.failIds.has(this.id)) throw new Error(`start failed: ${this.id}`);
    state.active++;
    state.maxActive = Math.max(state.maxActive, state.active);
    await new Promise((r) => setTimeout(r, 20));
    state.starts.push(this.id);
  }
  async stop(): Promise<void> {
    if (state.active > 0) state.active--;
    state.stops.push(this.id);
  }
  async sendMessage(_peerId: string, content: string): Promise<void> {
    if (state.failSend) throw new Error("send failed");
    state.sent.push(content);
  }
  async sendMedia(_peerId: string, media: { localPath: string }): Promise<boolean> {
    if (state.failMedia) return false;
    state.media.push(media.localPath);
    return true;
  }
  async healthCheck() {
    return { ok: true, detail: "fake" };
  }
}

const descriptor: ChannelTypeDescriptor = {
  type: "fake-lifecycle",
  label: "Fake lifecycle",
  description: "test",
  managedBy: "manager",
  creatable: true,
  deletable: true,
  credentials: [],
  capabilities: {
    groupChat: false,
    mediaInbound: [],
    mediaOutbound: ["image"],
    passiveReply: false,
    typing: false,
    streaming: false,
    markdown: "plain",
    maxMessageBytes: 1_000,
  },
  create: (config) => new FakeAdapter(config.id),
  onDelete: (config) => {
    state.deleted.push(config.id);
  },
};

let disposeDescriptor: () => void;

beforeAll(() => {
  disposeDescriptor = registerChannelType(descriptor);
});
afterAll(() => {
  disposeDescriptor();
});
beforeEach(() => {
  state.active = 0;
  state.maxActive = 0;
  state.starts = [];
  state.stops = [];
  state.deleted = [];
  state.sent = [];
  state.media = [];
  state.failIds.clear();
  state.failMedia = false;
  state.failSend = false;
});

const configFor = (id: string) => ({
  id,
  type: "fake-lifecycle",
  name: id,
  enabled: true,
  boundAgentId: "agent-default",
  credentials: {},
  updatedAt: Date.now(),
});

describe("ChannelManager lifecycle", () => {
  test("saveAndRestart 启动 / 停用停止 / 重启替换实例", async () => {
    const id = "life-a";
    await manager.saveAndRestart(id, () => configFor(id));
    expect(manager.getAdapter(id)?.id).toBe(id);
    expect(state.starts).toEqual([id]);

    await manager.saveAndRestart(id, (fresh) => ({ ...fresh!, enabled: false }));
    expect(manager.getAdapter(id)).toBeUndefined();

    await manager.saveAndRestart(id, (fresh) => ({ ...fresh!, enabled: true }));
    expect(manager.getAdapter(id)?.id).toBe(id);
    expect(state.starts.length).toBe(2);

    await manager.deleteChannel(id);
    expect(manager.getAdapter(id)).toBeUndefined();
    expect(store.getChannel(id)).toBeUndefined();
    expect(state.deleted).toContain(id);
  });

  test("并发 saveAndRestart 串行执行（同一渠道不同时启动两个实例）", async () => {
    const id = "life-b";
    await Promise.all([
      manager.saveAndRestart(id, () => configFor(id)),
      manager.saveAndRestart(id, () => configFor(id)),
      manager.saveAndRestart(id, () => configFor(id)),
    ]);
    expect(state.maxActive).toBe(1);
    expect(manager.getAdapter(id)?.id).toBe(id);
    expect(state.starts.length).toBe(3);
  });

  test("启动失败不留下僵尸注册", async () => {
    const id = "life-fail";
    state.failIds.add(id);
    await expect(manager.saveAndRestart(id, () => configFor(id))).rejects.toThrow(/start failed/);
    expect(manager.getAdapter(id)).toBeUndefined();
    expect(store.getChannel(id)?.id).toBe(id); // 配置已保存（HTTP 500 语义）
  });

  test("terminal 由 CLI 管理：start 会启动已注册实例、delete 拒绝", async () => {
    // 单例在多个测试套件间共享，terminal 可能已被其他套件注册
    const before = manager.getAdapter("terminal-main");
    let starts = 0;
    const fakeTerminal: ChannelAdapter = {
      id: "terminal-main",
      type: "terminal",
      name: "fake-terminal",
      start: async () => {
        starts++;
      },
      stop: async () => {},
      sendMessage: async () => {},
    };
    manager.register(fakeTerminal);
    try {
      await manager.startChannel("terminal-main");
      expect(starts).toBe(1);
    } finally {
      manager.unregister("terminal-main");
      if (before) manager.register(before);
    }
    await expect(manager.deleteChannel("terminal-main")).rejects.toThrow(/terminal/);
  });

  test("getHealth 合并运行时统计", async () => {
    const id = "life-health";
    await manager.saveAndRestart(id, () => configFor(id));
    await manager.deliverOutbound(id, "peer", "hello");
    const health = await manager.getHealth(id);
    expect(health.ok).toBe(true);
    expect(typeof health.lastSendAt).toBe("number");
    expect((await manager.getHealth("no-such-channel")).ok).toBe(false);
  });

  test("deliverOutbound 解析 MEDIA 标记并调用 sendMedia；越界路径降级为提示", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "bot-media-agent-"));
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "pic.png"), "png");
    writeFileSync(join(tmpdir(), "outside-media.txt"), "outside");
    const baseAgent = store.getAgent("agent-default")!;
    store.saveAgent({
      ...baseAgent,
      id: "media-agent",
      name: "media-agent",
      workspaceDir: workspace,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const id = "life-media";
    await manager.saveAndRestart(id, () => ({
      ...configFor(id),
      boundAgentId: "media-agent",
    }));

    state.sent = [];
    state.media = [];
    await manager.deliverOutbound(id, "peer", "see attachment\nMEDIA:pic.png");
    expect(state.sent).toEqual(["see attachment"]);
    expect(state.media.length).toBe(1);
    expect(state.media[0].endsWith("pic.png")).toBe(true);

    state.sent = [];
    state.media = [];
    await manager.deliverOutbound(id, "peer", "bad\nMEDIA:../outside-media.txt");
    expect(state.media.length).toBe(0);
    expect(state.sent.join("\n")).toContain("附件未发送");
    expect(state.sent.join("\n")).not.toContain("outside-media");
    await manager.deleteChannel(id);
  });

  test("附件发送失败时即使正文已送达也提示（不静默丢失）", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "bot-media-fail-"));
    writeFileSync(join(workspace, "pic.png"), "png");
    const baseAgent = store.getAgent("agent-default")!;
    store.saveAgent({
      ...baseAgent,
      id: "media-fail-agent",
      name: "media-fail-agent",
      workspaceDir: workspace,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const id = "life-media-fail";
    await manager.saveAndRestart(id, () => ({
      ...configFor(id),
      boundAgentId: "media-fail-agent",
    }));
    state.failMedia = true;
    state.sent = [];
    await manager.deliverOutbound(id, "peer", "正文\nMEDIA:pic.png");
    expect(state.sent).toContain("正文");
    expect(state.sent.join("\n")).toContain("附件发送失败");

    // 纯媒体 + 媒体失败 + 失败提示也失败 → 零投递，必须返回 false
    state.failSend = true;
    expect(await manager.deliverOutbound(id, "peer", "MEDIA:pic.png")).toBe(false);
    await manager.deleteChannel(id);
  });

  test("deliverOutbound 对停用渠道返回 false", async () => {
    const id = "life-disabled";
    await manager.saveAndRestart(id, () => ({ ...configFor(id), enabled: false }));
    expect(await manager.deliverOutbound(id, "peer", "hi")).toBe(false);
  });
});
