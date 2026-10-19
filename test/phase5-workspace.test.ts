import { afterAll, describe, expect, test } from "bun:test";
import { linkSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DatabaseManager } from "../src/database/index.ts";
import { DatabaseStore, type AgentDefinition } from "../src/config/database-store.ts";
import { defaultSandbox } from "../src/config/sandbox-defaults.ts";
import { createAgentWorkspaceDir, getAgentWorkspaceDir, isInsidePath } from "../src/config/env-paths.ts";
import { detectWorkspaceConflicts } from "../src/config/workspace-conflicts.ts";
import { PathGuard } from "../src/sandbox/path-guard.ts";
import { SandboxedExecutionEnv } from "../src/sandbox/execution-env.ts";
import { parseWorkspaceSkill, parseSkillMd, codePointLength } from "../src/skills/document-skills.ts";
import { SkillRegistry } from "../src/skills/registry.ts";
import { setAgentIdResolver } from "../src/skills/agent-scope.ts";
import {
  readVerifiedText,
  resetWorkspaceSkillCacheForTests,
  syncWorkspaceSkills,
} from "../src/skills/workspace.ts";
import { SkillsCatalog } from "../src/skills/builtin/skills-catalog.ts";
import { WorkspaceContext } from "../src/skills/builtin/workspace-context.ts";

// 测试隔离纪律: 临时 DB + 唯一 Agent ID; 不 rmSync 单例库所在目录
const tmp = join(tmpdir(), `bot-phase5-${process.pid}-${Date.now()}`);
DatabaseManager.getInstance(join(tmp, "bot.sqlite"));
const store = new DatabaseStore();
const createdAgents: string[] = [];

const skillsRoot = (ws: string) => join(ws, ".agents", "skills");

function makeAgent(id: string, workspaceDir: string): AgentDefinition {
  return {
    id,
    name: id,
    description: "",
    model: { provider: "deepseek", modelId: "deepseek-chat", temperature: 0.7, thinkingLevel: "medium" },
    instructions: "",
    workspaceDir,
    sandbox: defaultSandbox(workspaceDir),
    skills: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function createAgent(label: string): { id: string; ws: string } {
  const id = `p5-${label}-${process.pid}-${Date.now().toString(36)}`;
  const ws = join(tmp, "ws", id);
  mkdirSync(ws, { recursive: true });
  store.saveAgent(makeAgent(id, ws));
  createdAgents.push(id);
  return { id, ws };
}

function writeSkill(ws: string, id: string, description: string, body = "# Steps\n1. Do it\n") {
  const dir = join(skillsRoot(ws), id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${id}\ndescription: ${description}\n---\n\n${body}`,
  );
}

async function renderCatalog(agentId: string): Promise<string | undefined> {
  setAgentIdResolver((conv) => (conv === `conv-${agentId}` ? agentId : undefined));
  const section = SkillsCatalog.sections![0];
  return section.render(
    {
      conversationId: `conv-${agentId}`,
      agent: { extensions: [], tools: [] },
      env: {},
      shown: {},
      read: {},
    } as any,
    {} as any,
  );
}

afterAll(() => {
  for (const id of createdAgents) {
    try {
      store.deleteAgent(id);
    } catch {
      /* ignore */
    }
    SkillRegistry.getInstance().clearWorkspaceSkills(id);
  }
  resetWorkspaceSkillCacheForTests();
  setAgentIdResolver(undefined);
  // 注意: 不要删除 tmp 目录——DatabaseManager 单例库文件就在其中,
  // 并行套件仍在使用 (CLAUDE.md 测试纪律)。
});

describe("五期: 工作区技能发现", () => {
  test("严格解析: 合法 SKILL.md 进入快照并注册到 per-agent 分区", async () => {
    const a = createAgent("basic");
    writeSkill(a.ws, "demo", "Does a demo thing");
    const snap = await syncWorkspaceSkills(a.id, { force: true });
    expect(snap?.enabled).toBe(true);
    expect(snap?.skills.map((s) => s.id)).toContain("demo");
    expect(SkillRegistry.getInstance().getWorkspaceSkill(a.id, "demo")).toBeDefined();
    expect(SkillRegistry.getInstance().getWorkspaceSkill(a.id, "demo")?.document?.description).toBe(
      "Does a demo thing",
    );
  });

  test("工作区技能目录缺少 name 与目录名不一致时严格拒绝", async () => {
    const a = createAgent("bad-name");
    const dir = join(skillsRoot(a.ws), "bad-name");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "---\nname: Other Name\ndescription: x\n---\nbody");
    const snap = await syncWorkspaceSkills(a.id, { force: true });
    expect(snap?.skills).toHaveLength(0);
    expect(snap?.diagnostics.some((d) => d.reason.includes("name"))).toBe(true);
  });

  test("description 超过 1024 码点按严格模式拒绝", () => {
    const long = "x".repeat(1025);
    const parsed = parseWorkspaceSkill("demo", `---\nname: demo\ndescription: ${long}\n---\nbody`, "/tmp/x");
    expect(parsed.skill).toBeUndefined();
    expect(parsed.errors.some((e) => e.includes("description"))).toBe(true);
  });

  test("平台宽松解析兼容旧格式（未加引号冒号 / 数字 description）", () => {
    const dir = join(tmp, "legacy-skill");
    mkdirSync(dir, { recursive: true });
    const p = join(dir, "SKILL.md");
    writeFileSync(p, "---\nname: legacy\ndescription: Use when: handling PDFs\n---\nbody");
    expect(parseSkillMd("legacy", p)?.description).toBe("Use when: handling PDFs");
    writeFileSync(p, "---\nname: legacy\ndescription: 123\n---\nbody");
    expect(parseSkillMd("legacy", p)?.description).toBe("123");
  });

  test("修改/删除技能后，下一次 sync 立即反映（不依赖 TTL）", async () => {
    const a = createAgent("hot");
    writeSkill(a.ws, "hot", "first");
    let snap = await syncWorkspaceSkills(a.id, { force: true });
    expect(snap?.skills[0]?.document?.description).toBe("first");

    writeSkill(a.ws, "hot", "second");
    snap = await syncWorkspaceSkills(a.id);
    expect(snap?.skills[0]?.document?.description).toBe("second");

    rmSync(join(skillsRoot(a.ws), "hot"), { recursive: true, force: true });
    snap = await syncWorkspaceSkills(a.id);
    expect(snap?.skills).toHaveLength(0);
  });

  test("普通目录中的非技能文件不会进入快照", async () => {
    const a = createAgent("noise");
    mkdirSync(skillsRoot(a.ws), { recursive: true });
    writeFileSync(join(skillsRoot(a.ws), "README.md"), "not a skill");
    const snap = await syncWorkspaceSkills(a.id, { force: true });
    expect(snap?.skills).toHaveLength(0);
  });

  test("总开关关闭后旧缓存失效，重新开启后恢复（不依赖 force）", async () => {
    const a = createAgent("toggle");
    writeSkill(a.ws, "toggle-skill", "toggle");
    let snap = await syncWorkspaceSkills(a.id, { force: true });
    expect(snap?.enabled).toBe(true);
    expect(snap?.skills.map((s) => s.id)).toContain("toggle-skill");

    store.setConfig("workspace_skills_enabled", "0");
    try {
      snap = await syncWorkspaceSkills(a.id); // 不 force，模拟下一次请求
      expect(snap?.enabled).toBe(false);
      expect(snap?.skills).toHaveLength(0);
      expect(SkillRegistry.getInstance().getWorkspaceSkill(a.id, "toggle-skill")).toBeUndefined();
    } finally {
      store.setConfig("workspace_skills_enabled", "1");
    }
    snap = await syncWorkspaceSkills(a.id);
    expect(snap?.enabled).toBe(true);
    expect(snap?.skills.map((s) => s.id)).toContain("toggle-skill");
  });

  test("多个扫描根同名技能: 先到先得 + 冲突诊断", async () => {
    const a = createAgent("dup-roots");
    const first = join(a.ws, ".agents", "skills", "dup");
    const second = join(a.ws, ".other", "skills", "dup");
    mkdirSync(first, { recursive: true });
    mkdirSync(second, { recursive: true });
    writeFileSync(join(first, "SKILL.md"), "---\nname: dup\ndescription: first wins\n---\nbody");
    writeFileSync(join(second, "SKILL.md"), "---\nname: dup\ndescription: second loses\n---\nbody");
    store.setConfig("workspace_skill_roots", ".agents/skills,.other/skills");
    try {
      const snap = await syncWorkspaceSkills(a.id, { force: true });
      expect(snap?.skills).toHaveLength(1);
      expect(snap?.skills[0]?.document?.description).toBe("first wins");
      expect(snap?.diagnostics.some((d) => d.reason.includes("重复技能 id"))).toBe(true);
    } finally {
      store.setConfig("workspace_skill_roots", ".agents/skills");
    }
  });

  test("首个 root 同名目录无效时仍占用名字（后续 root 不能顶替）", async () => {
    const a = createAgent("dup-invalid");
    mkdirSync(join(a.ws, ".agents", "skills", "broken"), { recursive: true });
    const second = join(a.ws, ".other", "skills", "broken");
    mkdirSync(second, { recursive: true });
    writeFileSync(join(second, "SKILL.md"), "---\nname: broken\ndescription: should be shadowed\n---\nbody");
    store.setConfig("workspace_skill_roots", ".agents/skills,.other/skills");
    try {
      const snap = await syncWorkspaceSkills(a.id, { force: true });
      expect(snap?.skills).toHaveLength(0);
      expect(snap?.diagnostics.some((d) => d.reason.includes("缺少 SKILL.md"))).toBe(true);
      expect(snap?.diagnostics.some((d) => d.reason.includes("重复技能 id"))).toBe(true);
    } finally {
      store.setConfig("workspace_skill_roots", ".agents/skills");
    }
  });
});

describe("五期: 技能目录与 read_skill", () => {
  test("目录包含工作区技能与内置 skill-creator；正文不进入目录", async () => {
    const a = createAgent("catalog");
    writeSkill(a.ws, "visible", "Visible skill", "SECRET BODY");
    const block = await renderCatalog(a.id);
    expect(block).toBeDefined();
    expect(block!).toContain("<name>visible</name>");
    expect(block!).toContain("skill-creator");
    expect(block!).not.toContain("SECRET BODY");
  });

  test("read_skill 读取工作区技能正文（资源不自动枚举）", async () => {
    const a = createAgent("read");
    writeSkill(a.ws, "reader", "Reader skill", "# Reader\nUse scripts/run.sh\n");
    mkdirSync(join(skillsRoot(a.ws), "reader", "scripts"), { recursive: true });
    writeFileSync(join(skillsRoot(a.ws), "reader", "scripts", "run.sh"), "echo hi\n");
    await syncWorkspaceSkills(a.id, { force: true });
    setAgentIdResolver((conv) => (conv === `conv-${a.id}` ? a.id : undefined));

    const tool = SkillsCatalog.tools![0];
    const res: any = await tool.execute!(
      { id: "reader" },
      {
        conversationId: `conv-${a.id}`,
        agent: async () => ({ extensions: [] }),
        env: {},
      } as any,
      {} as any,
    );
    expect(res.isError).toBeFalsy();
    const text = res.output[0].text as string;
    expect(text).toContain("# Reader");
    expect(text).toContain("scripts/run.sh");
    expect(text).not.toContain("<skill_resources>");
  });

  test("内置 skill-creator 无需勾选即可读取", async () => {
    const a = createAgent("creator");
    await syncWorkspaceSkills(a.id, { force: true });
    setAgentIdResolver((conv) => (conv === `conv-${a.id}` ? a.id : undefined));
    const tool = SkillsCatalog.tools![0];
    const res: any = await tool.execute!(
      { id: "skill-creator" },
      {
        conversationId: `conv-${a.id}`,
        agent: async () => ({ extensions: [] }),
        env: {},
      } as any,
      {} as any,
    );
    expect(res.isError).toBeFalsy();
    expect(res.output[0].text).toContain("Skill Creator");
  });

  test("总开关关闭时 skill-creator 也不可读", async () => {
    const a = createAgent("creator-off");
    await syncWorkspaceSkills(a.id, { force: true });
    setAgentIdResolver((conv) => (conv === `conv-${a.id}` ? a.id : undefined));
    store.setConfig("workspace_skills_enabled", "0");
    try {
      const tool = SkillsCatalog.tools![0];
      const res: any = await tool.execute!(
        { id: "skill-creator" },
        { conversationId: `conv-${a.id}`, agent: async () => ({ extensions: [] }), env: {} } as any,
        {} as any,
      );
      expect(res.isError).toBe(true);
    } finally {
      store.setConfig("workspace_skills_enabled", "1");
    }
  });

  test("无执行环境时工作区目录/正文 fail-closed", async () => {
    const a = createAgent("no-env");
    writeSkill(a.ws, "no-env-skill", "no env");
    await syncWorkspaceSkills(a.id, { force: true });
    setAgentIdResolver((conv) => (conv === `conv-${a.id}` ? a.id : undefined));
    const section = SkillsCatalog.sections![0];
    const block = await section.render(
      {
        conversationId: `conv-${a.id}`,
        agent: { extensions: [], tools: [] },
        env: undefined,
        shown: {},
        read: {},
      } as any,
      {} as any,
    );
    expect(block ?? "").not.toContain("no-env-skill");
    expect(block ?? "").not.toContain("skill-creator");

    const tool = SkillsCatalog.tools![0];
    const res: any = await tool.execute!(
      { id: "no-env-skill" },
      { conversationId: `conv-${a.id}`, agent: async () => ({ extensions: [] }), env: undefined } as any,
      {} as any,
    );
    expect(res.isError).toBe(true);
    const creatorRes: any = await tool.execute!(
      { id: "skill-creator" },
      { conversationId: `conv-${a.id}`, agent: async () => ({ extensions: [] }), env: undefined } as any,
      {} as any,
    );
    expect(creatorRes.isError).toBe(true);
  });

  test("工作区资源不自动枚举（避免 readdir 祖先 symlink 竞态）", async () => {
    const a = createAgent("resource-symlink");
    writeSkill(a.ws, "res", "resources");
    const scripts = join(skillsRoot(a.ws), "res", "scripts");
    mkdirSync(scripts, { recursive: true });
    writeFileSync(join(scripts, "ok.sh"), "echo ok\n");
    const outside = join(tmp, "outside-resource.sh");
    writeFileSync(outside, "secret\n");
    symlinkSync(outside, join(scripts, "leak.sh"));
    await syncWorkspaceSkills(a.id, { force: true });
    setAgentIdResolver((conv) => (conv === `conv-${a.id}` ? a.id : undefined));
    const tool = SkillsCatalog.tools![0];
    const res: any = await tool.execute!(
      { id: "res" },
      { conversationId: `conv-${a.id}`, agent: async () => ({ extensions: [] }), env: {} } as any,
      {} as any,
    );
    const text = res.output[0].text as string;
    expect(text).toContain("# Steps");
    expect(text).not.toContain("<skill_resources>");
    expect(text).not.toContain("leak.sh");
  });

  test("跨 Agent 隔离: A 看不到 B 的技能，read_skill 也无法读取", async () => {
    const a = createAgent("iso-a");
    const b = createAgent("iso-b");
    writeSkill(b.ws, "secret-skill", "B only");
    await syncWorkspaceSkills(b.id, { force: true });

    const block = await renderCatalog(a.id);
    expect(block ?? "").not.toContain("secret-skill");

    setAgentIdResolver((conv) => (conv === `conv-${a.id}` ? a.id : undefined));
    const tool = SkillsCatalog.tools![0];
    const res: any = await tool.execute!(
      { id: "secret-skill" },
      { conversationId: `conv-${a.id}`, agent: async () => ({ extensions: [] }), env: {} } as any,
      {} as any,
    );
    expect(res.isError).toBe(true);
  });
});

describe("五期: 工作区记忆", () => {
  test("AGENTS.md 进入快照并渲染为 workspace_context", async () => {
    const a = createAgent("memory");
    writeFileSync(join(a.ws, "AGENTS.md"), "# Memory\nAlways answer in Chinese.\n");
    const snap = await syncWorkspaceSkills(a.id, { force: true });
    expect(snap?.memory?.content).toContain("Always answer in Chinese");

    setAgentIdResolver((conv) => (conv === `conv-${a.id}` ? a.id : undefined));
    const section = WorkspaceContext.sections![0];
    const text = await section.render(
      {
        conversationId: `conv-${a.id}`,
        agent: { extensions: [], tools: [] },
        env: {},
        shown: {},
        read: {},
      } as any,
      {} as any,
    );
    expect(text).toContain("<project_instructions");
    expect(text).toContain("Always answer in Chinese");
  });

  test("AGENTS.override.md 优先于 AGENTS.md", async () => {
    const a = createAgent("memory-priority");
    writeFileSync(join(a.ws, "AGENTS.md"), "base");
    writeFileSync(join(a.ws, "AGENTS.override.md"), "override wins");
    const snap = await syncWorkspaceSkills(a.id, { force: true });
    expect(snap?.memory?.content).toContain("override wins");
    expect(snap?.memory?.content).not.toContain("base");
  });

  test("AGENTS.override.md 是 symlink 时跳过并回退到 AGENTS.md", async () => {
    const a = createAgent("memory-symlink");
    writeFileSync(join(a.ws, "AGENTS.md"), "fallback memory");
    const outside = join(tmp, "outside-memory.md");
    writeFileSync(outside, "outside secret");
    symlinkSync(outside, join(a.ws, "AGENTS.override.md"));
    const snap = await syncWorkspaceSkills(a.id, { force: true });
    expect(snap?.memory?.content).toContain("fallback memory");
    expect(snap?.diagnostics.some((d) => d.reason.includes("symlink"))).toBe(true);
  });

  test("workspace_skills_enabled=0 不影响工作区记忆", async () => {
    const a = createAgent("memory-independent");
    writeFileSync(join(a.ws, "AGENTS.md"), "memory survives");
    store.setConfig("workspace_skills_enabled", "0");
    try {
      const snap = await syncWorkspaceSkills(a.id, { force: true });
      expect(snap?.enabled).toBe(false);
      expect(snap?.memory?.content).toContain("memory survives");
    } finally {
      store.setConfig("workspace_skills_enabled", "1");
    }
  });

  test("缓存后新增 denyRead 立即失效（不再注入旧记忆正文）", async () => {
    const a = createAgent("deny-refresh");
    writeFileSync(join(a.ws, "AGENTS.md"), "sensitive memory");
    let snap = await syncWorkspaceSkills(a.id, { force: true });
    expect(snap?.memory?.content).toContain("sensitive memory");

    const agent = store.getAgent(a.id)!;
    store.saveAgent({
      ...agent,
      sandbox: {
        ...agent.sandbox,
        filesystem: { ...agent.sandbox.filesystem, denyRead: ["AGENTS.md"] },
      },
    });
    snap = await syncWorkspaceSkills(a.id); // 不 force
    expect(snap?.memory).toBeUndefined();
  });
});

describe("五期: 安全回归", () => {
  test("symlink 技能目录被跳过", async () => {
    const a = createAgent("symlink-dir");
    const outside = join(tmp, "outside-skill");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "SKILL.md"), "---\nname: evil\ndescription: x\n---\nbody");
    mkdirSync(skillsRoot(a.ws), { recursive: true });
    symlinkSync(outside, join(skillsRoot(a.ws), "evil"));
    const snap = await syncWorkspaceSkills(a.id, { force: true });
    expect(snap?.skills.map((s) => s.id)).not.toContain("evil");
  });

  test("symlink SKILL.md 被拒绝", async () => {
    const a = createAgent("symlink-file");
    const dir = join(skillsRoot(a.ws), "linked");
    mkdirSync(dir, { recursive: true });
    const outside = join(tmp, "outside-skill.md");
    writeFileSync(outside, "---\nname: linked\ndescription: x\n---\nbody");
    symlinkSync(outside, join(dir, "SKILL.md"));
    const snap = await syncWorkspaceSkills(a.id, { force: true });
    expect(snap?.skills).toHaveLength(0);
    expect(snap?.diagnostics.some((d) => d.reason.includes("SKILL.md"))).toBe(true);
  });

  test("硬链接到受保护文件被拒绝（inode + nlink 防护）", () => {
    const ws = join(tmp, "hardlink-ws");
    const dir = join(skillsRoot(ws), "evil");
    mkdirSync(dir, { recursive: true });
    const protectedFile = join(tmp, "protected.txt");
    writeFileSync(protectedFile, "TOP SECRET");
    linkSync(protectedFile, join(dir, "SKILL.md"));

    const guard = new PathGuard(ws, defaultSandbox(ws), [protectedFile], []);
    expect(() => readVerifiedText(join(dir, "SKILL.md"), guard, ws, { maxBytes: 1024 })).toThrow();
  });

  test("沙盒关闭时平台硬规则仍生效", () => {
    const ws = join(tmp, "disabled-sandbox-ws");
    mkdirSync(ws, { recursive: true });
    const protectedFile = join(tmp, "protected-disabled.txt");
    writeFileSync(protectedFile, "SECRET");
    const sandbox = defaultSandbox(ws);
    sandbox.enabled = false;
    const guard = new PathGuard(ws, sandbox, [protectedFile], []);
    expect(guard.checkCanRead(protectedFile, { force: true }).allowed).toBe(false);
    expect(() => readVerifiedText(protectedFile, guard, ws, { maxBytes: 1024 })).toThrow();
  });

  test("exec 在沙盒关闭时也阻断硬链接命令", async () => {
    const ws = join(tmp, "exec-hardlink-ws");
    mkdirSync(ws, { recursive: true });
    const sandbox = defaultSandbox(ws);
    sandbox.enabled = false;
    const env = new SandboxedExecutionEnv({ cwd: ws, agentId: "p5-exec", sandboxConfig: sandbox });
    const res = await env.exec("ln a b", {}, {} as any);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toContain("硬链接");
  });

  test("workspace_skill_roots 不允许绝对路径/..", async () => {
    const a = createAgent("roots");
    store.setConfig("workspace_skill_roots", "/etc,../outside,.agents/skills");
    try {
      const snap = await syncWorkspaceSkills(a.id, { force: true });
      expect(snap?.diagnostics.some((d) => d.reason.includes("绝对路径"))).toBe(true);
      expect(snap?.diagnostics.some((d) => d.reason.includes(".."))).toBe(true);
    } finally {
      store.setConfig("workspace_skill_roots", ".agents/skills");
    }
  });

  test("路径包含性工具", () => {
    expect(isInsidePath("/a/b", "/a/b/c")).toBe(true);
    expect(isInsidePath("/a/b", "/a/bc")).toBe(false);
    expect(isInsidePath("/a/b", "/a/b/../c")).toBe(false);
  });

  test("openat 从 workspace root 逐级打开，拒绝中间目录 symlink", () => {
    const ws = join(tmp, "openat-ws");
    mkdirSync(join(ws, "real"), { recursive: true });
    writeFileSync(join(ws, "real", "file.md"), "safe");
    symlinkSync(join(ws, "real"), join(ws, "link"));
    const guard = new PathGuard(ws, defaultSandbox(ws), []);
    expect(() =>
      readVerifiedText(join(ws, "link", "file.md"), guard, ws, { maxBytes: 1024 }, ws),
    ).toThrow();
    expect(readVerifiedText(join(ws, "real", "file.md"), guard, ws, { maxBytes: 1024 }, ws).text).toBe(
      "safe",
    );
  });

  test("Unicode 码点计数", () => {
    expect(codePointLength("😀")).toBe(1);
    expect(codePointLength("abc")).toBe(3);
  });

  test("YAML 解析错误不把源码行写入诊断/审计", async () => {
    const a = createAgent("yaml-secret");
    const dir = join(skillsRoot(a.ws), "leaky");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      "---\nname: [SECRET_TOKEN_123\ndescription: x\n---\nbody",
    );
    const snap = await syncWorkspaceSkills(a.id, { force: true });
    expect(snap?.skills).toHaveLength(0);
    expect(snap?.diagnostics.some((d) => d.reason.includes("SECRET_TOKEN_123"))).toBe(false);
    const logs = store.listAuditLogs(100).filter((l) => l.agentId === a.id);
    expect(logs.some((l) => String(l.details).includes("SECRET_TOKEN_123"))).toBe(false);
  });
});

describe("五期: 工作区路径", () => {
  test("新建 Agent 的默认工作区带代际后缀，现有路径 helper 保持稳定", () => {
    const legacy = getAgentWorkspaceDir("same-id", tmp);
    const fresh = createAgentWorkspaceDir("same-id", tmp);
    expect(fresh).not.toBe(legacy);
    expect(fresh.startsWith(legacy.replace(/\/?$/, "") + "-")).toBe(true);
  });

  test("历史 workspace 冲突检测（相等/祖先）", () => {
    const base = join(tmp, "conflict-detect");
    const conflicts = detectWorkspaceConflicts([
      { id: "a", workspaceDir: base },
      { id: "b", workspaceDir: join(base, "child") },
      { id: "c", workspaceDir: join(base, "child") },
    ]);
    expect(conflicts.has("a")).toBe(true);
    expect(conflicts.has("b")).toBe(true);
    expect(conflicts.has("c")).toBe(true);
  });
});
