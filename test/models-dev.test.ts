import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseManager } from "../src/database/index.ts";
import { DatabaseStore } from "../src/config/database-store.ts";
import {
  builtinModelToValues,
  listCatalogCandidates,
  matchBuiltinModelMatch,
  matchCatalogModel,
  modelsDevEntryToValues,
  providerKeyCandidates,
  refreshModelsDevCatalog,
  resetCatalogMemoryCache,
  type ModelsDevCatalog,
} from "../src/core/models-dev.ts";
import { resolveModelMetadata } from "../src/core/model-metadata.ts";
import { logger } from "../src/utils/logger.ts";

const root = mkdtempSync(join(tmpdir(), "bot-models-dev-"));
DatabaseManager.getInstance(join(root, "bot.sqlite"));
logger.init(root);

afterAll(() => {
  resetCatalogMemoryCache();
});

const CATALOG: ModelsDevCatalog = {
  deepseek: {
    id: "deepseek",
    models: {
      "deepseek-v4": {
        id: "deepseek-v4",
        name: "DeepSeek V4",
        limit: { context: 1_000_000, output: 128_000 },
        modalities: { input: ["text", "image"], output: ["text"] },
        reasoning: true,
        tool_call: true,
        cost: { input: 0.3, output: 1.2, cache_read: 0.03, cache_write: 0.3 },
      },
    },
  },
  openrouter: {
    id: "openrouter",
    models: {
      "deepseek/deepseek-v4": {
        id: "deepseek/deepseek-v4",
        name: "DeepSeek V4 (OpenRouter)",
        canonical_model_id: "deepseek/deepseek-v4",
        limit: { context: 1_000_000, output: 128_000 },
        modalities: { input: ["text"], output: ["text"] },
        cost: {
          input: 0.9,
          output: 3.6,
          cache_read: 0,
          cache_write: 0,
          context_over_200k: { input: 1.5, output: 6, cache_read: 0, cache_write: 0 },
        },
      },
    },
  },
  anthropic: {
    id: "anthropic",
    models: {
      "orphan-v4": {
        id: "orphan-v4",
        name: "Orphan V4",
        limit: { context: 64_000, output: 8_000 },
        modalities: { input: ["text"], output: ["text"] },
        cost: { input: 1, output: 2, cache_read: 0, cache_write: 0 },
      },
      "claude-test": {
        id: "claude-test",
        name: "Claude Test",
        limit: { context: 200_000, output: 64_000 },
        modalities: { input: ["text", "image", "pdf"], output: ["text"] },
        reasoning: true,
        tool_call: true,
        cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
      },
    },
  },
};

describe("models.dev matching", () => {
  test("provider id / 别名 / apiBase host", () => {
    expect(providerKeyCandidates({ id: "deepseek", apiBase: "https://api.deepseek.com" })).toContain("deepseek");
    expect(providerKeyCandidates({ id: "my-vertex", apiBase: "https://generativelanguage.googleapis.com" })).toContain(
      "google",
    );
    expect(providerKeyCandidates({ id: "kimi", apiBase: "https://api.moonshot.cn" })).toContain("moonshotai");
  });

  test("精确 provider 匹配带价格；canonical 跨 provider 不带价格", () => {
    const exact = matchCatalogModel(CATALOG, { id: "deepseek", apiBase: "https://api.deepseek.com" }, "deepseek-v4");
    expect(exact?.exactProvider).toBe(true);
    const exactValues = modelsDevEntryToValues(exact!.entry, true);
    expect(exactValues.cost?.input).toBe(0.3);
    expect(exactValues.contextWindow).toBe(1_000_000);
    expect(exactValues.inputModalities).toEqual(["text", "image"]);

    const cross = matchCatalogModel(CATALOG, { id: "custom-reseller", apiBase: "https://example.com" }, "orphan-v4");
    expect(cross?.exactProvider).toBe(false);
    expect(cross?.providerKey).toBe("anthropic");
    const crossValues = modelsDevEntryToValues(cross!.entry, false);
    expect(crossValues.cost).toBeUndefined();
    expect(crossValues.contextWindow).toBe(64_000);
  });


  test("语义后缀（:free/-cloud）只做精确匹配，不回退到付费条目", () => {
    const freeCatalog: ModelsDevCatalog = {
      openrouter: {
        models: {
          "deepseek-v4": { id: "deepseek-v4", cost: { input: 1, output: 2, cache_read: 0, cache_write: 0 } },
          "deepseek-v4:free": { id: "deepseek-v4:free", cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 } },
        },
      },
    };
    const free = matchCatalogModel(freeCatalog, { id: "openrouter", apiBase: "https://openrouter.ai" }, "deepseek-v4:free");
    expect(free?.modelKey).toBe("deepseek-v4:free");
    const paid = matchCatalogModel(freeCatalog, { id: "openrouter", apiBase: "https://openrouter.ai" }, "deepseek-v4");
    expect(paid?.modelKey).toBe("deepseek-v4");
    // 目录只有付费条目时，free 请求必须拒绝，不能套用付费价格
    const onlyPaid: ModelsDevCatalog = { openrouter: { models: { "deepseek-v4": { id: "deepseek-v4" } } } };
    expect(
      matchCatalogModel(onlyPaid, { id: "openrouter", apiBase: "https://openrouter.ai" }, "deepseek-v4:free"),
    ).toBeUndefined();
  });


  test("builtin 语义后缀/跨 provider 命中不得复用价格", () => {
    const match = matchBuiltinModelMatch(
      { id: "openrouter", apiBase: "https://openrouter.ai" },
      "deepseek/deepseek-chat:free",
    );
    if (match) {
      expect(match.priceAllowed).toBe(false);
      expect(builtinModelToValues(match.model, false).cost).toBeUndefined();
    }
    // 同一模型无后缀时应允许价格（候选 provider 精确命中）
    const paid = matchBuiltinModelMatch({ id: "deepseek", apiBase: "https://api.deepseek.com" }, "deepseek-chat");
    if (paid?.exact) expect(paid.priceAllowed).toBe(true);
    // 跨 provider 同名但窗口不同（如 gpt-5.4 的 azure/openai）必须判为歧义
    expect(
      matchBuiltinModelMatch({ id: "unknown-provider", apiBase: "https://example.com" }, "gpt-5.4"),
    ).toBeUndefined();
  });

  test("tiers / context_over_200k 映射", () => {
    const values = modelsDevEntryToValues(
      CATALOG.openrouter!.models!["deepseek/deepseek-v4"],
      true,
    );
    expect(values.costTiers?.some((t) => t.inputTokensAbove === 200_000)).toBe(true);
  });

  test("歧义不猜", () => {
    const ambiguous: ModelsDevCatalog = {
      a: { models: { "x-1": { id: "x-1" } } },
      b: { models: { "x-1": { id: "x-1" } } },
    };
    expect(matchCatalogModel(ambiguous, { id: "unknown", apiBase: "https://example.com" }, "x-1")).toBeUndefined();
  });

  test("点号/横线归一：provider 精确命中时可套用价格", () => {
    const catalog: ModelsDevCatalog = {
      opencode: {
        name: "OpenCode",
        models: {
          "deepseek-v4.1-flash": {
            id: "deepseek-v4.1-flash",
            limit: { context: 1_000_000, output: 393_216 },
            cost: { input: 0.3, output: 1.2, cache_read: 0.006, cache_write: 0 },
          },
        },
      },
    };
    const match = matchCatalogModel(
      catalog,
      { id: "opencode", apiBase: "https://opencode.ai" },
      "deepseek-v4-1-flash",
    );
    expect(match?.exactProvider).toBe(true);
    expect(match?.modelKey).toBe("deepseek-v4.1-flash");
    expect(modelsDevEntryToValues(match!.entry, true).cost?.input).toBe(0.3);
  });

  test("无后缀目标不匹配 :free 条目；同 provider 多价格变体不猜", () => {
    const withFree: ModelsDevCatalog = {
      openrouter: {
        models: {
          x: { id: "x", cost: { input: 1, output: 2, cache_read: 0, cache_write: 0 } },
          "x:free": { id: "x:free", cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 } },
        },
      },
    };
    expect(
      matchCatalogModel(withFree, { id: "openrouter", apiBase: "https://openrouter.ai" }, "x")?.modelKey,
    ).toBe("x");
    const onlyFree: ModelsDevCatalog = {
      openrouter: { models: { "x:free": { id: "x:free", cost: { input: 0, output: 0 } } } },
    };
    expect(
      matchCatalogModel(onlyFree, { id: "openrouter", apiBase: "https://openrouter.ai" }, "x"),
    ).toBeUndefined();

    const variants: ModelsDevCatalog = {
      edenai: {
        models: {
          "a/deepseek-v4.1-flash": {
            id: "a/deepseek-v4.1-flash",
            cost: { input: 0.2, output: 0.6, cache_read: 0, cache_write: 0 },
          },
          "b/deepseek-v4.1-flash": {
            id: "b/deepseek-v4.1-flash",
            cost: { input: 0.3, output: 0.9, cache_read: 0, cache_write: 0 },
          },
        },
      },
    };
    expect(
      matchCatalogModel(variants, { id: "edenai", apiBase: "https://edenai.co" }, "deepseek-v4-1-flash"),
    ).toBeUndefined();
  });

  test("目录参考候选：跨供应商列出点号/厂商前缀变体，排除 free 变体", () => {    const catalog: ModelsDevCatalog = {
      neon: {
        name: "Neon",
        models: {
          "deepseek-v4-1-flash": {
            id: "deepseek-v4-1-flash",
            limit: { context: 1_000_000, output: 384_000 },
            cost: { input: 0.3, output: 1.2, cache_read: 0.03 },
          },
        },
      },
      tinfoil: {
        name: "Tinfoil",
        models: {
          "deepseek-v4-1-flash": {
            id: "deepseek-v4-1-flash",
            limit: { context: 1_048_576, output: 384_000 },
            cost: { input: 0.65, output: 1.45, cache_read: 0.13 },
          },
        },
      },
      openrouter: {
        name: "OpenRouter",
        models: {
          "deepseek/deepseek-v4.1-flash": {
            id: "deepseek/deepseek-v4.1-flash",
            canonical_model_id: "deepseek/deepseek-v4.1-flash",
            limit: { context: 1_048_576, output: 943_718 },
            cost: { input: 0.045, output: 0.5, cache_read: 0.006 },
          },
        },
      },
      opencode: {
        name: "OpenCode",
        models: {
          "deepseek-v4.1-flash-free": {
            id: "deepseek-v4.1-flash-free",
            limit: { context: 200_000, output: 8_192 },
            cost: { input: 0, output: 0, cache_read: 0 },
          },
        },
      },
    };
    const candidates = listCatalogCandidates(
      catalog,
      { id: "google", apiBase: "http://127.0.0.1:9002/v1" },
      "deepseek-v4-1-flash",
    );
    expect(candidates.map((c) => c.providerKey)).toEqual(["neon", "tinfoil", "openrouter"]);
    expect(candidates[0].match).toBe("exact");
    expect(candidates[2].match).toBe("normalized");
    expect(candidates[2].cost.input).toBe(0.045);
    expect(candidates[2].contextWindow).toBe(1_048_576);
    expect(candidates.every((c) => c.priced)).toBe(true);
  });
});

describe("refresh + manual override", () => {
  beforeAll(() => {
    const store = new DatabaseStore();
    store.saveModelProvider({
      id: "deepseek",
      name: "DeepSeek",
      protocol: "openai-completions",
      apiBase: "https://api.deepseek.com",
      apiKey: "k",
      models: ["deepseek-v4", "deepseek-chat", "deepseek-unknown"],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });


  test("models.dev 条目缺字段时回退 builtin/static", async () => {
    const partial: ModelsDevCatalog = { deepseek: { models: { "deepseek-v4": { id: "deepseek-v4" } } } };
    const store = new DatabaseStore();
    const fetchImpl = (async () =>
      new Response(JSON.stringify(partial), { status: 200 })) as unknown as typeof fetch;
    await refreshModelsDevCatalog(store, fetchImpl);
    const meta = resolveModelMetadata(store.getModelProvider("deepseek")!, "deepseek-v4", store);
    expect(meta.contextWindow).toBe(1_000_000);
    expect(meta.maxOutputTokens).toBeGreaterThan(0);
    expect(meta.source).toBe("models.dev");
  });


  test("models.dev 显式 0 价格不回退 builtin 付费价", async () => {
    const free: ModelsDevCatalog = {
      deepseek: {
        models: {
          "deepseek-chat": {
            id: "deepseek-chat",
            cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
          },
        },
      },
    };
    const store = new DatabaseStore();
    const fetchImpl = (async () =>
      new Response(JSON.stringify(free), { status: 200 })) as unknown as typeof fetch;
    await refreshModelsDevCatalog(store, fetchImpl);
    const meta = resolveModelMetadata(store.getModelProvider("deepseek")!, "deepseek-chat", store);
    expect(meta.cost.input).toBe(0);
    expect(meta.cost.output).toBe(0);
    expect(meta.source).toBe("models.dev");
  });

  test("拉取目录 → 保存缓存/自动元数据；manual 覆盖在刷新后保留", async () => {
    const store = new DatabaseStore();
    const fetchImpl = (async () =>
      new Response(JSON.stringify(CATALOG), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const stats = await refreshModelsDevCatalog(store, fetchImpl);
    expect(stats.models).toBeGreaterThanOrEqual(2);
    expect(stats.matched).toBeGreaterThanOrEqual(1);
    expect(store.getModelCatalogCache()?.providerCount).toBe(3);

    const auto = store.getModelMetadata("deepseek", "deepseek-v4");
    expect(auto?.autoSource).toBe("models.dev");
    expect(auto?.auto?.contextWindow).toBe(1_000_000);

    // 手动覆盖 + 再次刷新：auto 更新，manual 保留
    store.saveModelMetadata({
      ...auto!,
      manual: { contextWindow: 500_000 },
      updatedAt: Date.now(),
    });
    await refreshModelsDevCatalog(store, fetchImpl);
    const record = store.getModelMetadata("deepseek", "deepseek-v4");
    expect(record?.manual).toEqual({ contextWindow: 500_000 });
    const effective = resolveModelMetadata(store.getModelProvider("deepseek")!, "deepseek-v4", store);
    expect(effective.contextWindow).toBe(500_000);
    expect(effective.cost.input).toBe(0.3);
    expect(effective.source).toBe("manual");

    // 未匹配模型走 fallback，窗口来自静态目录（deepseek 前缀）
    const unknown = resolveModelMetadata(store.getModelProvider("deepseek")!, "deepseek-unknown", store);
    expect(unknown.contextWindow).toBe(128_000);
    expect(unknown.source).toBe("fallback");
  });
});
