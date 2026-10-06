import { describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { AdminWebServer } from "../src/server/server.ts";
import { DatabaseManager } from "../src/database/index.ts";
import { logger } from "../src/utils/logger.ts";

const testPort = 3199;
// 隔离: 单例指向临时目录, 避免测试写进真实 cwd 的 .bot/
const testHome = `/tmp/test-bot-server-${Date.now()}`;
DatabaseManager.getInstance(join(testHome, "bot.sqlite"));
logger.init(testHome);
const server = new AdminWebServer(testPort);

describe("AdminWebServer API & BYOK", () => {

  it("should serve embedded dashboard, handle BYOK model providers, and handle REST API requests", async () => {
    await server.start();

    // 1. Dashboard UI (React SPA, served from embedded vite build)
    const htmlRes = await fetch(`http://127.0.0.1:${testPort}/`);
    expect(htmlRes.status).toBe(200);
    const html = await htmlRes.text();
    expect(html).toContain("Bot 控制台");
    expect(html).toContain('<div id="root">');

    // 1b. Embedded static asset (hashed JS bundle) with immutable cache
    const assetMatch = html.match(/src="(\/assets\/[^"]+\.js)"/);
    expect(assetMatch).not.toBeNull();
    const assetRes = await fetch(`http://127.0.0.1:${testPort}${assetMatch![1]}`);
    expect(assetRes.status).toBe(200);
    expect(assetRes.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(assetRes.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");

    // 1c. SPA fallback: unknown non-API path serves index.html
    const spaRes = await fetch(`http://127.0.0.1:${testPort}/some/spa/route`);
    expect(spaRes.status).toBe(200);
    const spaText = await spaRes.text();
    expect(spaText).toContain("Bot 控制台");

    // 2. Status API
    const statusRes = await fetch(`http://127.0.0.1:${testPort}/api/status`);
    expect(statusRes.status).toBe(200);
    const status = await statusRes.json();
    expect(status.cwd).toBeDefined();

    // 3. BYOK Providers API
    const providersRes = await fetch(`http://127.0.0.1:${testPort}/api/providers`);
    expect(providersRes.status).toBe(200);
    const providers = await providersRes.json();
    expect(Array.isArray(providers)).toBe(true);

    // Create a new BYOK provider
    const postProvRes = await fetch(`http://127.0.0.1:${testPort}/api/providers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "my-custom-endpoint",
        name: "私有 vLLM 服务",
        protocol: "openai-completions",
        apiBase: "http://192.168.1.100:8000/v1",
        apiKey: "vllm-secret",
        models: ["qwen2.5-72b", "deepseek-coder"],
      }),
    });
    expect(postProvRes.status).toBe(200);

    // Verify it was created
    const provUpdatedRes = await fetch(`http://127.0.0.1:${testPort}/api/providers`);
    const provUpdated = await provUpdatedRes.json();
    const createdProv = provUpdated.find((p: any) => p.id === "my-custom-endpoint");
    expect(createdProv).toBeDefined();
    expect(createdProv.name).toBe("私有 vLLM 服务");
    expect(createdProv.models).toContain("qwen2.5-72b");

    // 4. Agents API (GET and POST)
    const agentsRes = await fetch(`http://127.0.0.1:${testPort}/api/agents`);
    expect(agentsRes.status).toBe(200);
    const agents = await agentsRes.json();
    expect(Array.isArray(agents)).toBe(true);

    // Create a new agent bound to the new BYOK provider
    const postAgentRes = await fetch(`http://127.0.0.1:${testPort}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "agent-byok-test",
        name: "BYOK 测试助手",
        model: { provider: "my-custom-endpoint", modelId: "qwen2.5-72b" },
        instructions: "Test instructions with BYOK",
        sandbox: { enabled: true, network: { allowedDomains: [] }, filesystem: { allowWrite: ["."] } },
        skills: ["coding-tools"],
      }),
    });
    expect(postAgentRes.status).toBe(200);

    // Verify it was created
    const agentsUpdatedRes = await fetch(`http://127.0.0.1:${testPort}/api/agents`);
    const agentsUpdated = await agentsUpdatedRes.json();
    const createdAgent = agentsUpdated.find((a: any) => a.id === "agent-byok-test");
    expect(createdAgent).toBeDefined();
    expect(createdAgent.model.provider).toBe("my-custom-endpoint");
    expect(createdAgent.model.modelId).toBe("qwen2.5-72b");

    // 5. Skills API
    const skillsRes = await fetch(`http://127.0.0.1:${testPort}/api/skills`);
    const skills = await skillsRes.json();
    expect(skills.find((s: any) => s.id === "coding-tools")).toBeDefined();
    expect(skills.find((s: any) => s.id === "web-search")).toBeDefined();

    // 6. Config API (GET and POST)
    await fetch(`http://127.0.0.1:${testPort}/api/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "test_key", value: "test_value_123" }),
    });

    const configRes = await fetch(`http://127.0.0.1:${testPort}/api/config`);
    const config = await configRes.json();
    expect(config.test_key).toBe("test_value_123");

    // server 保持运行, 由随后的渠道生命周期 describe 继续使用
    // (testHome 的清理挪到整个文件最后一个测试之后——目录先删会让
    //  审计日志写入抛错, 渠道 POST 全部 500)
  });
});

describe("AdminWebServer 渠道生命周期 (POST 热替换 / DELETE 回收)", () => {
  const testPort = 3199; // 复用上一个 describe 的 AdminWebServer 实例 (已 start)

  it("weixin 渠道无凭据保存 → start 失败返回 500 且不留僵尸注册", async () => {
    // weixin.start() 无凭据必然抛错 (确定性离线路径): POST 必须如实 500,
    // 且 adapter 已从 manager 注销 (B-R5-1 回归守护: epoch set 丢失会让
    // restartChannel 无限重启, 该请求永不响应——超时即失败)
    const res = await fetch(`http://127.0.0.1:${testPort}/api/channels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "lifecycle-weixin",
        name: "生命周期",
        type: "weixin",
        boundAgentId: "agent-default",
        enabled: true,
        credentials: {},
      }),
    }).then((r) => r.status);
    expect(res).toBe(500);
  });

  it("terminal-main 编辑放行 (禁新建但可改绑定), DELETE 受保留项保护", async () => {
    const edit = await fetch(`http://127.0.0.1:${testPort}/api/channels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "terminal-main",
        name: "本地终端交互通道",
        type: "terminal",
        boundAgentId: "agent-default",
        enabled: true,
        credentials: {},
      }),
    });
    expect(edit.status).toBe(200);

    const del = await fetch(`http://127.0.0.1:${testPort}/api/channels?id=terminal-main`, { method: "DELETE" });
    expect(del.status).toBe(500); // 保留项保护 (terminal 不可经 API 删除)
  });

  it("停用的 weixin 渠道保存成功 (不触发 start), DELETE 同步回收", async () => {
    const save = await fetch(`http://127.0.0.1:${testPort}/api/channels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "lifecycle-weixin",
        name: "生命周期",
        type: "weixin",
        boundAgentId: "agent-default",
        enabled: false,
        credentials: {},
      }),
    });
    expect(save.status).toBe(200);

    const del = await fetch(`http://127.0.0.1:${testPort}/api/channels?id=lifecycle-weixin`, { method: "DELETE" });
    expect(del.status).toBe(200);
    const list = await (await fetch(`http://127.0.0.1:${testPort}/api/channels`)).json();
    expect(list.find((c: any) => c.id === "lifecycle-weixin")).toBeUndefined();

    // 全部 API 测试结束: 清理临时目录 (server 不 stop, 进程退出回收)
    await server.stop();
    rmSync(testHome, { recursive: true, force: true });
  });
});
