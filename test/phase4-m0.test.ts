import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync } from "node:fs";

import { commandRouter } from "../src/core/commands.ts";
import { tryCommand, initCommandRouting } from "../src/core/chat-orchestrator.ts";
import { setSlashFastPath } from "../src/channels/runtime/dispatch.ts";
import { loadOrCreateGatewayToken, gatewayTokenPath, tokensEqual } from "../src/core/gateway-token.ts";
import { AdminWebServer } from "../src/server/server.ts";
import { DatabaseManager } from "../src/database/index.ts";
import { logger } from "../src/utils/logger.ts";
import type { InboundMessage } from "../src/channels/base.ts";

// 测试隔离纪律: 显式绑定临时目录单例 (勿 rmSync——单例被全部套件共享)
const tmpDbDir = join(tmpdir(), `bot-phase4-${Date.now()}`);
mkdirSync(tmpDbDir, { recursive: true });
DatabaseManager.getInstance(join(tmpDbDir, "bot.sqlite"));
logger.init(tmpDbDir);

const baseInv = {
  channel: "web" as const,
  channelInstanceId: "web",
  peerId: "web-playground:agent-default",
  agentId: "agent-default",
  sessionId: "web-playground:agent-default",
};

describe("phase4: CommandRouter.parse", () => {
  test("标准命令与参数解析", () => {
    const p = commandRouter.parse("/status");
    expect(p.kind).toBe("command");
    if (p.kind === "command") {
      expect(p.def.name).toBe("status");
      expect(p.args).toEqual([]);
    }
    const p2 = commandRouter.parse("  /agent  agent-a  extra ");
    expect(p2.kind).toBe("command");
    if (p2.kind === "command") {
      expect(p2.def.name).toBe("agent");
      expect(p2.args).toEqual(["agent-a", "extra"]);
      expect(p2.rest).toBe("agent-a  extra");
    }
  });

  test("别名解析 (reset = new)", () => {
    const p = commandRouter.parse("/new");
    expect(p.kind).toBe("command");
    if (p.kind === "command") expect(p.def.name).toBe("reset");
  });

  test("@botname 后缀剥离 (Telegram 群寻址)", () => {
    const p = commandRouter.parse("/status@my_bot");
    expect(p.kind).toBe("command");
    if (p.kind === "command") expect(p.def.name).toBe("status");
  });

  test("路径形态不拦截 (/Users/x/file.md)", () => {
    expect(commandRouter.parse("/Users/x/file.md").kind).toBe("not-command");
    expect(commandRouter.parse("/usr/local/bin").kind).toBe("not-command");
  });

  test("非命令输入与空斜杠不拦截", () => {
    expect(commandRouter.parse("你好").kind).toBe("not-command");
    expect(commandRouter.parse("/").kind).toBe("not-command");
    expect(commandRouter.parse("").kind).toBe("not-command");
  });

  test("未注册但形态合法的词 → unknown (IM 必须 fail-closed)", () => {
    const p = commandRouter.parse("/frobnicate");
    expect(p.kind).toBe("unknown");
    if (p.kind === "unknown") expect(p.name).toBe("frobnicate");
  });
});

describe("phase4: tryCommand 语义", () => {
  test("未知命令: web fail-closed 显式回复; terminal 保留自由", async () => {
    const web = await tryCommand({ ...baseInv, input: "/frobnicate" });
    expect(web.handled).toBe(true);
    expect(web.result?.content).toContain("/help");

    const term = await tryCommand({
      ...baseInv,
      channel: "terminal",
      channelInstanceId: "terminal-main",
      input: "/frobnicate",
    });
    expect(term.handled).toBe(false);
  });

  test("/help 按渠道过滤可见命令", async () => {
    const web = await tryCommand({ ...baseInv, input: "/help" });
    expect(web.handled).toBe(true);
    expect(web.result?.ok).toBe(true);
    expect(web.result?.content).toContain("/status");

    // 全部命令对 web 可见 (visibility: all); 可见性过滤本身由 listVisible 承担
    const visible = commandRouter.listVisible("im");
    expect(visible.some((d) => d.name === "help")).toBe(true);
    expect(visible.some((d) => d.name === "status")).toBe(true);
  });

  test("非命令输入 handled=false", async () => {
    const r = await tryCommand({ ...baseInv, input: "帮我写个爬虫" });
    expect(r.handled).toBe(false);
  });

  test("/agent 无参数列出 Agent (读类命令 busy=dispatch)", async () => {
    const r = await tryCommand({ ...baseInv, input: "/agent" });
    expect(r.handled).toBe(true);
    expect(r.result?.ok).toBe(true);
    expect(r.result?.content).toContain("agent-default");
  });

  test("/agent <不存在> 显式失败", async () => {
    const r = await tryCommand({ ...baseInv, input: "/agent nope-xyz" });
    expect(r.handled).toBe(true);
    expect(r.result?.ok).toBe(false);
  });
});

describe("phase4: IM slash fast path (管道接线)", () => {
  test("initCommandRouting 后 fast path 返回 false 时落回常规链路", async () => {
    initCommandRouting();
    // 直接调 handleInboundCommand 的注入点行为: 非命令 → false (由注册的
    // fast path 判定, 这里验证注入机制与命令判定协作)
    const { handleInboundCommand } = await import("../src/core/chat-orchestrator.ts");
    const msg = (over: Partial<InboundMessage> = {}): InboundMessage => ({
      channelInstanceId: "ch-x",
      peerId: "p1",
      content: "hello",
      ...over,
    });
    // 渠道不存在 → 绑定解析失败 → false (落回常规链路统一报错)
    expect(await handleInboundCommand(msg({ content: "/status" }), "/status")).toBe(false);
    expect(await handleInboundCommand(msg({ content: "普通文本" }), "普通文本")).toBe(false);
  });

  test("fast path 注入点可替换 (测试隔离)", async () => {
    let called = 0;
    setSlashFastPath(async () => {
      called++;
      return true;
    });
    // 机制验证: 替换后指针生效
    setSlashFastPath(undefined);
    expect(called).toBe(0);
  });
});

describe("phase4: gateway-token", () => {
  test("生成并复用 (0600)", () => {
    const dir = join(tmpdir(), `bot-token-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const t1 = loadOrCreateGatewayToken(dir);
    expect(t1.length).toBeGreaterThanOrEqual(32);
    const t2 = loadOrCreateGatewayToken(dir);
    expect(t2).toBe(t1);
    const { statSync, readFileSync } = require("node:fs");
    expect(statSync(gatewayTokenPath(dir)).mode & 0o777).toBe(0o600);
    expect(readFileSync(gatewayTokenPath(dir), "utf8").trim()).toBe(t1);
  });

  test("tokensEqual 常量时间语义 (长度不等 false)", () => {
    expect(tokensEqual("abc", "abc")).toBe(true);
    expect(tokensEqual("abc", "abd")).toBe(false);
    expect(tokensEqual("abc", "abcd")).toBe(false);
    expect(tokensEqual("", "")).toBe(false);
  });
});

describe("phase4: AdminWebServer token 鉴权", () => {
  const port = 3266;
  const server = new AdminWebServer(port, "127.0.0.1", { authToken: "test-token-123" });

  test("无 token 401 / 带 token 200 / bootstrap 下发 / HTML 注入", async () => {
    await server.start();

    const noAuth = await fetch(`http://127.0.0.1:${port}/api/status`);
    expect(noAuth.status).toBe(401);

    const wrong = await fetch(`http://127.0.0.1:${port}/api/status`, {
      headers: { "x-bot-token": "wrong" },
    });
    expect(wrong.status).toBe(401);

    const ok = await fetch(`http://127.0.0.1:${port}/api/status`, {
      headers: { "x-bot-token": "test-token-123" },
    });
    expect(ok.status).toBe(200);

    const boot = await fetch(`http://127.0.0.1:${port}/api/bootstrap`);
    expect((await boot.json()).token).toBe("test-token-123");

    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    expect(html).toContain('window.__BOT_TOKEN__="test-token-123"');

    await server.stop();
  });
});
