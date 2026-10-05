import { describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { AdminWebServer } from "../src/server/server.ts";
import { DatabaseManager } from "../src/database/index.ts";
import { logger } from "../src/utils/logger.ts";

describe("AdminWebServer API & BYOK", () => {
  const testPort = 3199;
  // 隔离: 单例指向临时目录, 避免测试写进真实 cwd 的 .bot/
  const testHome = `/tmp/test-bot-server-${Date.now()}`;
  DatabaseManager.getInstance(join(testHome, "bot.sqlite"));
  logger.init(testHome);
  const server = new AdminWebServer(testPort);

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

    await server.stop();
    rmSync(testHome, { recursive: true, force: true });
  });
});
