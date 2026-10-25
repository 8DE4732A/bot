import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { closeSync, mkdtempSync, openSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentManager, type ChatChunk } from "../../src/core/agent-manager.ts";
import {
  DatabaseStore,
  type ModelProtocol,
} from "../../src/config/database-store.ts";
import {
  ensureBotDirectories,
} from "../../src/config/env-paths.ts";
import { DatabaseManager } from "../../src/database/index.ts";
import { loadCustomSkills } from "../../src/skills/loader.ts";
import { logger } from "../../src/utils/logger.ts";

/**
 * 真实 Agent 对话 E2E。
 *
 * 默认跳过，只有显式设置 BOT_E2E=1 才访问模型 provider。测试使用独立的
 * 临时 cwd/.bot，不会读取或写入项目当前的 Agent、会话与凭据。
 */
const ENABLED = process.env.BOT_E2E === "1";
const suite = ENABLED ? describe : describe.skip;
const timeoutMs = positiveInt(process.env.BOT_E2E_TIMEOUT_MS, 120_000);

let tempRoot: string | undefined;
let manager: AgentManager;
let store: DatabaseStore;
let db: DatabaseManager | undefined;
let lockFd: number | undefined;
let agentId: string;
let modelLabel: string;

interface ConversationCase {
  id: string;
  messages: string[];
  contains?: string[];
  containsCaseInsensitive?: string[];
  notContains?: string[];
  expectedTools?: string[];
  expectStreaming?: boolean;
  resetBeforeFinal?: boolean;
}

const cases: ConversationCase[] = [
  {
    id: "basic-reply",
    messages: [
      "Reply with exactly this token and no other text: E2E_BASIC_OK",
    ],
    contains: ["E2E_BASIC_OK"],
    expectStreaming: true,
  },
  {
    id: "multi-turn-memory",
    messages: [
      "Remember this codeword for the next turn: COBALT-7419. Reply OK.",
      "What is the codeword I asked you to remember? Reply with only the codeword.",
    ],
    containsCaseInsensitive: ["COBALT-7419"],
  },
  {
    id: "reset-clears-context",
    messages: [
      "Remember this private codeword: RESET-CANARY-9352. Reply OK.",
      "What is the private codeword? Reply with only the codeword.",
    ],
    resetBeforeFinal: true,
    notContains: ["RESET-CANARY-9352"],
  },
  {
    id: "datetime-tool",
    messages: [
      "Call the get_current_time tool. Then reply with the returned ISO timestamp only.",
    ],
    expectedTools: ["get_current_time"],
    contains: ["T"],
  },
];

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function protocolEnv(): ModelProtocol {
  const value = process.env.BOT_E2E_PROTOCOL?.trim() || "openai-completions";
  const protocols: ModelProtocol[] = [
    "openai-completions",
    "openai-responses",
    "anthropic-messages",
    "google",
  ];
  if (!protocols.includes(value as ModelProtocol)) {
    throw new Error(
      `BOT_E2E_PROTOCOL must be one of ${protocols.join(", ")}; received '${value}'`,
    );
  }
  return value as ModelProtocol;
}

function configureAgent(): void {
  const providerId = process.env.BOT_E2E_PROVIDER_ID?.trim() || "e2e-provider";
  const modelId = requiredEnv("BOT_E2E_MODEL");
  const now = Date.now();

  store.saveModelProvider({
    id: providerId,
    name: "Agent E2E Provider",
    protocol: protocolEnv(),
    apiBase: requiredEnv("BOT_E2E_BASE_URL"),
    apiKey: requiredEnv("BOT_E2E_API_KEY"),
    models: [modelId],
    createdAt: now,
    updatedAt: now,
  });

  const existing = store.getAgent("agent-default");
  if (!existing) throw new Error("Fresh E2E database did not bootstrap agent-default");
  store.saveAgent({
    ...existing,
    name: "Agent E2E Test Agent",
    model: {
      provider: providerId,
      modelId,
      temperature: 0,
      thinkingLevel: "low",
    },
    instructions:
      "You are an integration-test assistant. Follow the user's output constraints exactly. " +
      "Use a requested tool when the user explicitly asks for it.",
    skills: ["datetime"],
  });
  agentId = existing.id;
  modelLabel = `${providerId}/${modelId}`;
}

function resetSession(sessionId: string): Promise<void> {
  return manager.resetSession(agentId, sessionId);
}

async function runCase(input: ConversationCase): Promise<{
  answer: string;
  chunks: ChatChunk[];
}> {
  const sessionId = `e2e:${input.id}:${Date.now().toString(36)}`;
  const chunks: ChatChunk[] = [];
  let answer = "";

  for (let i = 0; i < input.messages.length; i++) {
    const message = input.messages[i]!;
    if (input.resetBeforeFinal && i === input.messages.length - 1) {
      await resetSession(sessionId);
    }
    answer = await manager.chat(agentId, sessionId, message, (chunk) => {
      chunks.push(chunk);
    });
  }

  return { answer, chunks };
}

function assertCase(input: ConversationCase, result: { answer: string; chunks: ChatChunk[] }): void {
  expect(result.answer.trim().length, `${input.id}: empty answer`).toBeGreaterThan(0);

  for (const text of input.contains ?? []) {
    expect(result.answer, `${input.id}: answer must contain '${text}'`).toContain(text);
  }
  const folded = result.answer.toLocaleLowerCase();
  for (const text of input.containsCaseInsensitive ?? []) {
    expect(folded, `${input.id}: answer must contain '${text}'`).toContain(
      text.toLocaleLowerCase(),
    );
  }
  for (const text of input.notContains ?? []) {
    expect(result.answer, `${input.id}: answer must not contain '${text}'`).not.toContain(text);
  }

  const toolCalls = result.chunks
    .filter((chunk) => chunk.toolCall?.status === "running")
    .map((chunk) => chunk.toolCall!.name);
  for (const tool of input.expectedTools ?? []) {
    expect(toolCalls, `${input.id}: expected tool '${tool}'`).toContain(tool);
  }
  if (input.expectStreaming) {
    expect(
      result.chunks.some((chunk) => (chunk.delta?.length ?? 0) > 0),
      `${input.id}: expected streaming text deltas`,
    ).toBe(true);
  }
}

suite("Agent real-provider conversation E2E", () => {
  beforeAll(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "bot-agent-e2e-"));
    const paths = ensureBotDirectories(tempRoot);
    lockFd = openSync(join(paths.dotBot, "e2e.lock"), "wx");
    logger.init(tempRoot);

    // npm script 固定单文件执行；锁文件防止有人把它直接混进全量 test
    // 后被 Bun 拼进仍持有其他 DatabaseManager 单例的进程。
    db = DatabaseManager.getInstance(paths.dbFile);
    store = new DatabaseStore(db);
    const activeDbFile = db.getRawDatabase().prepare("PRAGMA database_list").get()?.file;
    if (
      typeof activeDbFile !== "string" ||
      realpathSync(activeDbFile) !== realpathSync(paths.dbFile)
    ) {
      throw new Error(
        "E2E database singleton is already bound to another process path; run `bun run test:e2e`",
      );
    }
    configureAgent();

    await loadCustomSkills(tempRoot);
    manager = new AgentManager(store);
    await manager.init(tempRoot, { resume: false });
    manager.resume();

    console.log(`[agent-e2e] model=${modelLabel} root=${tempRoot}`);
  }, timeoutMs);

  for (const input of cases) {
    test(
      input.id,
      async () => {
        const result = await runCase(input);
        assertCase(input, result);
      },
      timeoutMs,
    );
  }

  afterAll(async () => {
    await manager?.shutdown().catch(() => {});
    db?.close();
    if (lockFd !== undefined) closeSync(lockFd);
    lockFd = undefined;
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  }, timeoutMs);
});
