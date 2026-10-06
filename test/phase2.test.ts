import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { getBotPaths } from "../src/config/env-paths.ts";
import { DatabaseManager } from "../src/database/index.ts";
import { parseSkillMd, formatSkillsForPrompt } from "../src/skills/document-skills.ts";
import { loadCustomSkills } from "../src/skills/loader.ts";
import { createMcpToolName, McpBridge, resolveToolExposure } from "../src/skills/mcp/bridge.ts";
import { SkillRegistry } from "../src/skills/registry.ts";
import { PathGuard } from "../src/sandbox/path-guard.ts";
import { DatabaseStore } from "../src/config/database-store.ts";

// 测试隔离纪律: 临时目录 + 显式 DatabaseManager 单例, 勿写真实 cwd 的 .bot/
const tmp = join(tmpdir(), `bot-phase2-test-${process.pid}`);
DatabaseManager.getInstance(join(tmp, "bot.sqlite"));

const ECHO_SERVER = {
  id: "echo",
  name: "Echo Server",
  transport: "stdio" as const,
  command: "bun",
  args: ["-e", "process.exit(0)"], // 不会被真实启动 (InMemory 测试走 withClient 之外的路径)
  exposure: "direct" as const,
  enabled: true,
  updatedAt: 0,
};

/** 用 SDK 构建一个内存 echo MCP server, 与 client 经 InMemoryTransport 配对 */
async function connectEchoClient(): Promise<Client> {
  const server = new Server({ name: "echo", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "echo",
        description: "Echo back the input text",
        inputSchema: {
          type: "object" as const,
          properties: { text: { type: "string", description: "text to echo" } },
          required: ["text"],
        },
      },
      {
        name: "boom",
        description: "Always fails",
        inputSchema: { type: "object" as const, properties: {} },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name === "boom") {
      return { content: [{ type: "text", text: "kaboom" }], isError: true };
    }
    return { content: [{ type: "text", text: `echo: ${JSON.stringify(req.params.arguments?.text)}` }] };
  });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  await client.connect(clientT);
  return client;
}

describe("二期: 文档型技能 (SKILL.md)", () => {
  test("frontmatter 解析: name/description/disable-model-invocation + 正文分离", () => {
    const doc = parseSkillMd(
      "my-skill",
      writeTemp(
        "my-skill",
        "---\nname: my-skill\ndescription: Does a thing well\n---\n\n# Steps\n1. Do it\n",
      ),
    );
    expect(doc).toBeDefined();
    expect(doc!.id).toBe("my-skill");
    expect(doc!.name).toBe("my-skill");
    expect(doc!.description).toBe("Does a thing well");
    expect(doc!.body).toContain("# Steps");
    expect(doc!.disableModelInvocation).toBe(false);
    expect(doc!.warnings.length).toBe(0);
  });

  test("name 非法回退目录名; description 缺失产出诊断", () => {
    const doc = parseSkillMd("fallback-name", writeTemp("fallback-name", "---\nname: Bad Name!\n---\nbody"));
    expect(doc!.name).toBe("fallback-name");
    expect(doc!.warnings.some((w) => w.includes("description"))).toBe(true);
  });

  test("frontmatter 未闭合: 整个文件按正文处理", () => {
    const doc = parseSkillMd("broken", writeTemp("broken", "---\nno end here\nbody text"));
    expect(doc!.body).toContain("no end here");
  });

  test("渐进披露: 目录只含 name/description/location, 正文不进上下文", () => {
    const block = formatSkillsForPrompt([
      {
        id: "a",
        name: "a",
        description: "Skill A",
        location: "/x/.bot/skills/a/SKILL.md",
        body: "SECRET BODY",
        disableModelInvocation: false,
        warnings: [],
      },
    ]);
    // 外层 <available_skills> 标签由 durable section 的 tag 机制包裹, 这里渲染内部条目
    expect(block).toContain("<name>a</name>");
    expect(block).toContain("/x/.bot/skills/a/SKILL.md");
    expect(block).not.toContain("SECRET BODY");
    expect(formatSkillsForPrompt([])).toBeUndefined();
  });

  test("加载器: SKILL.md 目录注册为 kind=skill; 与 index.ts 共存时 extension 优先", async () => {
    const skillsDir = getBotPaths(tmp).skillsDir;
    mkdirSync(join(skillsDir, "doc-only"), { recursive: true });
    writeFileSync(
      join(skillsDir, "doc-only", "SKILL.md"),
      "---\ndescription: A document only skill\n---\nbody here",
    );
    mkdirSync(join(skillsDir, "both-kinds"), { recursive: true });
    writeFileSync(
      join(skillsDir, "both-kinds", "SKILL.md"),
      "---\ndescription: The doc side\n---\nbody",
    );
    writeFileSync(
      join(skillsDir, "both-kinds", "index.ts"),
      "export default { id: 'both-kinds', name: 'Both', description: 'The tool side', extension: { name: 'both-kinds' } };",
    );

    await loadCustomSkills(tmp);
    const registry = SkillRegistry.getInstance();
    const docOnly = registry.getSkill("doc-only");
    expect(docOnly?.kind).toBe("skill");
    expect(docOnly?.document?.description).toBe("A document only skill");

    // 同 id 冲突: extension (index.ts) 获胜, SKILL.md 被遮蔽
    const both = registry.getSkill("both-kinds");
    expect(both?.kind).toBe("extension");

    // 文档型技能的空壳扩展可被 resolveExtensions 选中 (选配真相 = agent.skills)
    const resolved = registry.resolveExtensions(["doc-only"]);
    expect(resolved.map((e) => e.name)).toContain("doc-only");
    registry.removeSkill("doc-only");
    registry.removeSkill("both-kinds");
  });

  test("read_skill: 未选配的技能拒绝读取 (B-01 回归)", async () => {
    const registry = SkillRegistry.getInstance();
    registry.register({
      id: "sec-doc", name: "sec-doc", description: "secret doc", category: "document",
      builtin: false, kind: "skill", extension: { name: "sec-doc" },
      document: { id: "sec-doc", name: "sec-doc", description: "secret doc", location: "/tmp/never-read.md", body: "SECRET", disableModelInvocation: false, warnings: [] },
    });
    const catalog = await import("../src/skills/builtin/skills-catalog.ts");
    const readSkill = catalog.SkillsCatalog.tools!.find((t) => t.name === "read_skill")!;
    // agent 只选配了别的技能 → sec-doc 不在名单
    const api = { agent: async () => ({ extensions: [{ name: "some-other-skill" }] }) };
    const result: any = await readSkill.execute({ id: "sec-doc" }, api as any, {} as any);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not enabled");
    // 未选配时绝不读文件
    expect(result.content[0].text).not.toContain("SECRET");
    registry.removeSkill("sec-doc");
  });

  test("read_skill: 执行环境拒绝时 fail-closed, 不直读 (B-02 回归)", async () => {
    const registry = SkillRegistry.getInstance();
    registry.register({
      id: "fail-closed-doc", name: "fail-closed-doc", description: "d", category: "document",
      builtin: false, kind: "skill", extension: { name: "fail-closed-doc" },
      document: { id: "fail-closed-doc", name: "x", description: "d", location: "/tmp/should-not-be-read.md", body: "DENIED SECRET", disableModelInvocation: false, warnings: [] },
    });
    const catalog = await import("../src/skills/builtin/skills-catalog.ts");
    const readSkill = catalog.SkillsCatalog.tools!.find((t) => t.name === "read_skill")!;
    const selectedApi = {
      agent: async () => ({ extensions: [{ name: "fail-closed-doc" }] }),
      env: { readTextFile: async () => ({ ok: false, error: "permission_denied" }) },
    };
    const result: any = await readSkill.execute({ id: "fail-closed-doc" }, selectedApi as any, {} as any);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("permission_denied");
    expect(result.content[0].text).not.toContain("DENIED SECRET");
    registry.removeSkill("fail-closed-doc");
  });

  test("文档技能 upsert: 重复加载刷新正文 (M-02 回归)", async () => {
    const skillsDir = getBotPaths(tmp).skillsDir;
    mkdirSync(join(skillsDir, "hot-doc"), { recursive: true });
    writeFileSync(join(skillsDir, "hot-doc", "SKILL.md"), "---\ndescription: version one\n---\nbody v1");
    await loadCustomSkills(tmp);
    expect(SkillRegistry.getInstance().getSkill("hot-doc")?.description).toBe("version one");
    writeFileSync(join(skillsDir, "hot-doc", "SKILL.md"), "---\ndescription: version two\n---\nbody v2");
    await loadCustomSkills(tmp);
    expect(SkillRegistry.getInstance().getSkill("hot-doc")?.description).toBe("version two");
    SkillRegistry.getInstance().removeSkill("hot-doc");
  });

  test("混合技能共存: index.ts + SKILL.md 同目录都可用 (M-01 回归)", async () => {
    const skillsDir = getBotPaths(tmp).skillsDir;
    mkdirSync(join(skillsDir, "hybrid-doc"), { recursive: true });
    writeFileSync(join(skillsDir, "hybrid-doc", "SKILL.md"), "---\ndescription: hybrid knowledge\n---\nhybrid body");
    writeFileSync(
      join(skillsDir, "hybrid-doc", "index.ts"),
      "export default { id: 'hybrid-doc', name: 'Hybrid', description: 'hybrid tools', extension: { name: 'hybrid-doc', tools: [{ name: 'hybrid_tool', parameters: { type: 'object' }, execute: async () => ({ content: [] }) }] } };",
    );
    const diff = await loadCustomSkills(tmp);
    const skill = SkillRegistry.getInstance().getSkill("hybrid-doc");
    expect(skill?.kind).toBe("extension");
    expect(skill?.document?.description).toBe("hybrid knowledge");
    expect(skill?.extension.tools?.length).toBeGreaterThan(0);
    expect(diff.upserted.some((e) => e.name === "hybrid-doc")).toBe(true);
    SkillRegistry.getInstance().removeSkill("hybrid-doc");
  });

  test("混合技能 module id ≠ 目录名: document 按 module id 附挂 (N-3/M-05 回归)", async () => {
    const skillsDir = getBotPaths(tmp).skillsDir;
    mkdirSync(join(skillsDir, "hybrid-dir"), { recursive: true });
    writeFileSync(join(skillsDir, "hybrid-dir", "SKILL.md"), "---\ndescription: misnamed knowledge\n---\nbody");
    writeFileSync(
      join(skillsDir, "hybrid-dir", "index.ts"),
      "export default { id: 'other-id', name: 'Other', description: 'tools side', extension: { name: 'other-id' } };",
    );
    await loadCustomSkills(tmp);
    const skill = SkillRegistry.getInstance().getSkill("other-id");
    expect(skill?.document?.description).toBe("misnamed knowledge");
    expect(skill?.document?.id).toBe("other-id");
    SkillRegistry.getInstance().removeSkill("other-id");
  });

  test("builtin 保护: 文档技能不得覆盖 builtin 工具扩展 (B-01 回归)", async () => {
    const skillsDir = getBotPaths(tmp).skillsDir;
    // registry 中 builtin coding-tools 已存在 (registerBuiltins)
    mkdirSync(join(skillsDir, "coding-tools"), { recursive: true });
    writeFileSync(join(skillsDir, "coding-tools", "SKILL.md"), "---\ndescription: tries to shadow builtin\n---\nbody");
    await loadCustomSkills(tmp);
    const after = SkillRegistry.getInstance().getSkill("coding-tools");
    expect(after?.builtin).toBe(true);
    expect(after?.kind).toBe("extension");
    expect((after?.extension.tools ?? []).length).toBeGreaterThan(0);
    expect(after?.document).toBeUndefined();
  });

  test("loadCustomSkills diff: 磁盘上消失的技能进入 removed (B-02 回归)", async () => {
    const skillsDir = getBotPaths(tmp).skillsDir;
    mkdirSync(join(skillsDir, "vanish-doc"), { recursive: true });
    writeFileSync(join(skillsDir, "vanish-doc", "SKILL.md"), "---\ndescription: will vanish\n---\nbody");
    await loadCustomSkills(tmp);
    expect(SkillRegistry.getInstance().getSkill("vanish-doc")).toBeDefined();
    rmSync(join(skillsDir, "vanish-doc"), { recursive: true, force: true });
    const diff = await loadCustomSkills(tmp);
    expect(diff.removed).toContain("vanish-doc");
    expect(SkillRegistry.getInstance().getSkill("vanish-doc")).toBeUndefined();
  });

  test("reload 不得把 MCP 技能判为'磁盘消失' (R3-1/B-01 回归)", async () => {
    // registry 里注册一个 mcp 技能 (McpBridge.sync 的产物, 不在磁盘 skills 目录)
    const registry = SkillRegistry.getInstance();
    registry.register({
      id: "mcp__lkg", name: "lkg", description: "MCP server 'lkg' (1 tools)", category: "mcp",
      builtin: false, kind: "mcp", extension: { name: "mcp__lkg" },
    });
    const diff = await loadCustomSkills(tmp);
    expect(diff.removed).not.toContain("mcp__lkg");
    expect(registry.getSkill("mcp__lkg")).toBeDefined(); // 未被 reload 卸载
    registry.removeSkill("mcp__lkg");
  });
});

describe("二期: MCP 桥接", () => {
  test("工具命名: 净化 + 冲突加 hash 后缀 + 长度截断", () => {
    const taken = new Set<string>();
    expect(createMcpToolName("my-srv", "do_thing", taken)).toBe("mcp__my-srv__do_thing");
    expect(createMcpToolName("my-srv", "do_thing", taken)).toMatch(/^mcp__my-srv__do_thing_[0-9a-f]{8}$/);
    expect(createMcpToolName("weird id", "tool.name", new Set())).toBe("mcp__weird_id__tool_name");
    // 超长工具名截断到 64 上限 (对齐 pi MAX_TOOL_NAME_LENGTH)
    const long = createMcpToolName("srv", "x".repeat(80), new Set());
    expect(long.length).toBeLessThanOrEqual(64);
  });

  test("toolExposure: 精确名优先于通配模式", () => {
    const server = {
      ...ECHO_SERVER,
      toolExposure: { "echo": "hidden", "internal_*": "hidden" } as Record<string, "direct" | "hidden">,
    };
    expect(resolveToolExposure(server, "echo")).toBe("hidden");
    expect(resolveToolExposure(server, "internal_cache_clear")).toBe("hidden");
    expect(resolveToolExposure(server, "other")).toBe("direct");
    expect(resolveToolExposure(ECHO_SERVER, "anything")).toBe("direct");
  });

  test("桥接集成: listTools → defineTool → callTool 转发与审计", async () => {
    const bridge = McpBridge.getInstance();
    // 注入内存连接, 绕过真实 stdio 启动 (InMemoryTransport 配对); key = keyFor(server)
    const client = await connectEchoClient();
    const server = { ...ECHO_SERVER, id: "echo-mem" };
    (bridge as any).clients.set((bridge as any).keyFor(server), client);

    const { extension, toolCount } = await bridge.buildServerExtension(server);
    expect(toolCount).toBe(2);
    const names = extension.tools?.map((t) => t.name) ?? [];
    expect(names).toContain("mcp__echo-mem__echo");
    expect(names).toContain("mcp__echo-mem__boom");

    const echoTool = extension.tools!.find((t) => t.name === "mcp__echo-mem__echo")!;
    const result: any = await echoTool.execute({ text: "hello" }, {} as any, undefined as any);
    expect(result.content[0].text).toBe('echo: "hello"');

    const boomTool = extension.tools!.find((t) => t.name === "mcp__echo-mem__boom")!;
    const boomResult: any = await boomTool.execute({}, {} as any, undefined as any);
    expect(boomResult.content[0].text).toContain("[mcp tool reported an error]");
    expect(boomResult.isError).toBe(true);
    await client.close();
  });

  test("exposure=hidden: 扩展注册但零工具", async () => {
    const bridge = McpBridge.getInstance();
    const client = await connectEchoClient();
    const hiddenServer = { ...ECHO_SERVER, id: "hidden-mem", exposure: "hidden" as const };
    (bridge as any).clients.set((bridge as any).keyFor(hiddenServer), client);
    const { extension, toolCount } = await bridge.buildServerExtension(hiddenServer);
    expect(toolCount).toBe(0);
    expect(extension.tools?.length ?? 0).toBe(0);
    await client.close();
  });

  test("callTool 不重试: 失败不重复执行副作用 (B-04 回归)", async () => {
    const bridge = McpBridge.getInstance();
    const client = await connectEchoClient();
    const server = { ...ECHO_SERVER, id: "noretry-mem" };
    (bridge as any).clients.set((bridge as any).keyFor(server), client);
    // 篡改注入的 client: callTool 首次抛错 (模拟连接瞬断)
    let calls = 0;
    const orig = client.callTool.bind(client);
    (client as any).callTool = async (...args: any[]) => {
      calls += 1;
      if (calls === 1) throw new Error("transient connection error");
      return await orig(...args);
    };
    const { extension } = await bridge.buildServerExtension(server);
    const echoTool = extension.tools!.find((t) => t.name === "mcp__noretry-mem__echo")!;
    const result: any = await echoTool.execute({ text: "x" }, {} as any, undefined as any);
    expect(calls).toBe(1); // 未重试
    expect(result.isError).toBe(true);
    await client.close();
  });

  test("配置变化的 server 连接重建 (B1/B-05 回归): 工具面跟随新配置", async () => {
    const bridge = McpBridge.getInstance();
    const mkServer = (args: string[]): any => ({
      id: "cfg-rebuild",
      name: "rebuild",
      transport: "stdio",
      command: "bun",
      args,
      exposure: "direct" as const,
      enabled: true,
      updatedAt: Date.now(),
    });
    // 配置 A: 注入 client A (listTools 返回 [tool_a])
    const clientA = await connectEchoClient();
    const serverA = mkServer(["a"]);
    const keyA = (bridge as any).keyFor(serverA);
    (bridge as any).clients.set(keyA, clientA);
    (clientA as any).listTools = async () => ({ tools: [{ name: "tool_a", inputSchema: { type: "object" } }] });
    const r1 = await bridge.buildServerExtension(serverA);
    expect(r1.toolCount).toBe(1);
    expect(r1.extension.tools?.[0]?.name).toContain("tool_a");

    // 配置 B (同 id 不同 args): 新指纹 → miss → 不应复用 clientA 的工具面
    const serverB = mkServer(["b"]);
    expect((bridge as any).keyFor(serverB)).not.toBe(keyA);
    // 模拟 sync 语义: 配置变化 → closeServerClients
    (bridge as any).closeServerClients("cfg-rebuild");
    const clientB = await connectEchoClient();
    (bridge as any).clients.set((bridge as any).keyFor(serverB), clientB);
    (clientB as any).listTools = async () => ({ tools: [{ name: "tool_b", inputSchema: { type: "object" } }] });
    const r2 = await bridge.buildServerExtension(serverB);
    expect(r2.toolCount).toBe(1);
    expect(r2.extension.tools?.[0]?.name).toContain("tool_b");
    expect(r2.extension.tools?.[0]?.name).not.toContain("tool_a");
    await clientA.close();
    await clientB.close();
  });

  test("连续两次真实 sync(): 工具名稳定不振荡 (N-1 回归, 走公开 sync 路径)", async () => {
    const bridge = McpBridge.getInstance();
    const store = new DatabaseStore();
    const server: any = { id: "osc-test", name: "osc", transport: "stdio", command: "bun", args: ["x"], exposure: "direct", enabled: true, updatedAt: Date.now() };
    store.saveMcpServer(server);
    const client = await connectEchoClient();
    (bridge as any).clients.set((bridge as any).keyFor(server), client);

    const namesAt = new Map<number, string[]>();
    for (let round = 1; round <= 3; round++) {
      const registryBefore = SkillRegistry.getInstance().getSkill("mcp__osc-test");
      const names1 = await bridge.sync(store);
      const skill = SkillRegistry.getInstance().getSkill("mcp__osc-test");
      const names = (skill?.extension.tools ?? []).map((t: any) => t.name);
      namesAt.set(round, names);
      expect(names.length).toBe(2);
      void registryBefore;
      void names1;
    }
    // 三轮名字完全一致 (振荡回归: 第二轮会变成 hash 后缀)
    expect(namesAt.get(2)).toEqual(namesAt.get(1));
    expect(namesAt.get(3)).toEqual(namesAt.get(1));
    SkillRegistry.getInstance().removeSkill("mcp__osc-test");
    store.deleteMcpServer("osc-test");
    await client.close();
  });
});

describe("二期: skills 目录的沙盒放行语义", () => {
  const tmpWorkspace = join(tmp, "ws");
  const paths = getBotPaths(tmp);

  beforeAll(() => {
    mkdirSync(join(paths.skillsDir, "demo"), { recursive: true });
    writeFileSync(join(paths.skillsDir, "demo", "SKILL.md"), "readable doc");
    writeFileSync(join(paths.skillsDir, "demo", "index.ts"), "const x = 1;");
  });

  // 注意: DatabaseManager 单例被全部测试套件共享 (首个 getInstance 绑定生效),
  // 不能 rmSync(tmp)——会删掉共享库文件导致并行套件 disk I/O error
  afterAll(() => {});

  const guardFor = (workspace: string) =>
    new PathGuard(
      workspace,
      { enabled: true, network: { allowedDomains: [], deniedDomains: [] }, filesystem: { allowWrite: ["."], denyRead: [], denyWrite: [] } },
      [
        join(paths.dotBot, "bot.sqlite*"),
        join(paths.skillsDir, "*", "*.ts"),
        join(paths.skillsDir, "*", "node_modules"),
      ],
      // skills 源码模式不进 inode 指纹 (与 execution-env 一致)
      [join(paths.dotBot, "bot.sqlite*")],
    );

  test("SKILL.md 可读 (渐进披露的 read 通路)", () => {
    const g = guardFor(tmpWorkspace);
    expect(g.checkCanRead(join(paths.skillsDir, "demo", "SKILL.md")).allowed).toBe(true);
  });

  test("技能代码 (*.ts) 仍被平台禁读", () => {
    const g = guardFor(tmpWorkspace);
    const res = g.checkCanRead(join(paths.skillsDir, "demo", "index.ts"));
    expect(res.allowed).toBe(false);
  });
});

function writeTemp(dir: string, content: string): string {
  const dirPath = join(tmp, "skillmd", dir);
  mkdirSync(dirPath, { recursive: true });
  const file = join(dirPath, "SKILL.md");
  writeFileSync(file, content);
  return file;
}
