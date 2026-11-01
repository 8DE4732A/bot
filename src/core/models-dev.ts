import { promisify } from "node:util";
import { gunzipSync, gzip } from "node:zlib";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { Model } from "@earendil-works/pi-ai";
import {
  DatabaseStore,
  type ModelCostRates,
  type ModelCostTier,
  type ModelMetadataRecord,
  type ModelMetadataSource,
  type ModelMetadataValues,
  type ModelProviderDefinition,
} from "../config/database-store.ts";
import { lookupContextWindow } from "../config/context-windows.ts";
import { logger } from "../utils/logger.ts";

export const MODELS_DEV_URL = "https://models.dev/api.json";
export const MODELS_DEV_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CATALOG_BYTES = 20 * 1024 * 1024;
const gzipAsync = promisify(gzip);

export interface ModelsDevModelEntry {
  id?: string;
  name?: string;
  attachment?: boolean;
  reasoning?: boolean;
  tool_call?: boolean;
  modalities?: { input?: string[]; output?: string[] };
  limit?: { context?: number; output?: number; input?: number };
  cost?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
    tiers?: unknown;
    context_over_200k?: {
      input?: number;
      output?: number;
      cache_read?: number;
      cache_write?: number;
    };
  };
  canonical_model_id?: string;
  [key: string]: unknown;
}

export interface ModelsDevProviderEntry {
  id?: string;
  name?: string;
  models?: Record<string, ModelsDevModelEntry>;
  [key: string]: unknown;
}

export type ModelsDevCatalog = Record<string, ModelsDevProviderEntry>;

export interface CatalogMatch {
  providerKey: string;
  modelKey: string;
  entry: ModelsDevModelEntry;
  /** true = provider 精确命中（价格可信）；false = 跨 provider canonical 回退（不应用价格） */
  exactProvider: boolean;
}

export interface CatalogRefreshStats {
  providers: number;
  models: number;
  matched: number;
  builtin: number;
  fallback: number;
  manualPreserved: number;
  fetchedAt: number;
  changed: boolean;
}

const PROVIDER_ALIASES: Record<string, string[]> = {
  openai: ["openai"],
  anthropic: ["anthropic"],
  google: ["google", "google-vertex", "google-generative-ai", "vertex"],
  gemini: ["google"],
  deepseek: ["deepseek"],
  openrouter: ["openrouter"],
  siliconflow: ["siliconflow"],
  moonshot: ["moonshotai"],
  moonshotai: ["moonshotai"],
  kimi: ["moonshotai"],
  zhipu: ["zhipuai"],
  zhipuai: ["zhipuai"],
  glm: ["zhipuai"],
  minimax: ["minimax"],
  xai: ["xai"],
  grok: ["xai"],
  groq: ["groq"],
  mistral: ["mistral"],
  ollama: ["ollama"],
  azure: ["azure"],
  "azure-openai": ["azure"],
  together: ["togetherai", "together"],
  fireworks: ["fireworks-ai", "fireworks"],
  deepinfra: ["deepinfra"],
  cerebras: ["cerebras"],
  cohere: ["cohere"],
};

const HOST_ALIASES: [RegExp, string][] = [
  [/api\.openai\.com$/, "openai"],
  [/api\.anthropic\.com$/, "anthropic"],
  [/generativelanguage\.googleapis\.com$/, "google"],
  [/api\.deepseek\.com$/, "deepseek"],
  [/openrouter\.ai$/, "openrouter"],
  [/api\.siliconflow\.(cn|com)$/, "siliconflow"],
  [/api\.moonshot\.(cn|ai)$/, "moonshotai"],
  [/open\.bigmodel\.cn$/, "zhipuai"],
  [/api\.minimax(chat)?\.(chat|com)$/, "minimax"],
  [/api\.x\.ai$/, "xai"],
  [/api\.groq\.com$/, "groq"],
  [/api\.mistral\.ai$/, "mistral"],
  [/(^|\.)ollama\.(com|ai)$/, "ollama"],
  [/localhost|127\.0\.0\.1/, "ollama"],
];

function unique(values: string[]): string[] {
  return [...new Set(values.filter((v) => v.length > 0))];
}

/** provider 可能对应的 models.dev key（精确 id > 别名 > apiBase host）。 */
export function providerKeyCandidates(provider: Pick<ModelProviderDefinition, "id" | "apiBase">): string[] {
  const id = String(provider.id || "").trim().toLowerCase();
  const keys = [id, ...(PROVIDER_ALIASES[id] ?? [])];
  try {
    const host = new URL(provider.apiBase).hostname.toLowerCase();
    for (const [pattern, key] of HOST_ALIASES) {
      if (pattern.test(host)) keys.push(key);
    }
  } catch {
    /* 非法 URL 忽略 */
  }
  return unique(keys);
}

function normalizedModelId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_.]+/g, "-")
    .replace(/:([a-z0-9-]+)$/g, "")
    .replace(/-(cloud|free|nitro|extended|beta|floor)$/g, "");
}

/** :free / -free / :cloud 等价格/路由后缀，归一化时绝不能丢掉。 */
export function hasSemanticSuffix(modelId: string): boolean {
  return /([:-])(free|cloud|nitro|extended|beta|floor)$/i.test(String(modelId || "").trim());
}

/** 带任何变体后缀（语义后缀或 :thinking 等冒号标签）的条目不能当作基础模型的候选。 */
function hasVariantSuffix(modelId: string): boolean {
  return hasSemanticSuffix(modelId) || /:[a-z0-9-]+$/i.test(String(modelId || "").trim());
}

function exactVariants(modelId: string): string[] {
  const raw = String(modelId || "").trim().toLowerCase();
  const short = raw.includes("/") ? raw.slice(raw.lastIndexOf("/") + 1) : raw;
  return unique([raw, short]);
}

function fuzzyVariants(modelId: string): string[] {
  const raw = String(modelId || "").trim().toLowerCase();
  const short = raw.includes("/") ? raw.slice(raw.lastIndexOf("/") + 1) : raw;
  return unique([normalizedModelId(raw), normalizedModelId(short)]);
}

function entryKeys(key: string, entry: ModelsDevModelEntry, normalize: boolean): string[] {
  const norm = (v: string) => (normalize ? normalizedModelId(v) : v.trim().toLowerCase());
  const keys = [norm(key), norm(String(entry.id ?? ""))];
  const canonical = typeof entry.canonical_model_id === "string" ? entry.canonical_model_id : "";
  if (canonical) {
    const canonicalLower = canonical.toLowerCase();
    const canonicalShort = canonicalLower.includes("/")
      ? canonicalLower.slice(canonicalLower.lastIndexOf("/") + 1)
      : canonicalLower;
    keys.push(norm(canonicalLower), norm(canonicalShort));
  }
  return keys;
}

function entryMatches(key: string, entry: ModelsDevModelEntry, variants: string[], normalize: boolean): boolean {
  const keys = entryKeys(key, entry, normalize);
  return variants.some((variant) => keys.includes(variant));
}

/** 在目录中匹配一个模型。provider 精确命中带价格；跨 provider 唯一命中不带价格。
 *  语义后缀（:free/-cloud 等）只允许精确匹配，绝不回退到无后缀的付费条目。 */
export function matchCatalogModel(
  catalog: ModelsDevCatalog,
  provider: Pick<ModelProviderDefinition, "id" | "apiBase">,
  modelId: string,
): CatalogMatch | undefined {
  const exact = exactVariants(modelId);
  const fuzzy = hasSemanticSuffix(modelId) ? [] : fuzzyVariants(modelId);
  if (exact.length === 0 && fuzzy.length === 0) return undefined;
  const candidateKeys = providerKeyCandidates(provider);

  const findIn = (
    providerKey: string,
    entry: ModelsDevProviderEntry | undefined,
    variants: string[],
    normalize: boolean,
  ): { modelKey: string; entry: ModelsDevModelEntry } | undefined => {
    if (!entry?.models) return undefined;
    const targetHasVariantSuffix = hasVariantSuffix(modelId);
    const hits: { modelKey: string; entry: ModelsDevModelEntry }[] = [];
    for (const [modelKey, model] of Object.entries(entry.models)) {
      if (!model) continue;
      // 目标没有 :free/:thinking 等变体后缀时，绝不把变体条目当作基础模型
      if (!targetHasVariantSuffix && (hasVariantSuffix(modelKey) || hasVariantSuffix(String(model.id ?? "")))) {
        continue;
      }
      if (entryMatches(modelKey, model, variants, normalize)) hits.push({ modelKey, entry: model });
    }
    if (hits.length === 0) return undefined;
    if (hits.length === 1) return hits[0];
    // 同一 provider 内多个变体（如不同厂商前缀）元数据一致才采用，否则歧义不猜
    const signature = (hit: { entry: ModelsDevModelEntry }) =>
      JSON.stringify([
        hit.entry.limit?.context ?? null,
        hit.entry.limit?.output ?? null,
        hit.entry.cost ?? null,
        hit.entry.modalities ?? null,
        hit.entry.reasoning ?? null,
        hit.entry.tool_call ?? null,
      ]);
    return new Set(hits.map(signature)).size === 1 ? hits[0] : undefined;
  };

  for (const providerKey of candidateKeys) {
    const hit = findIn(providerKey, catalog[providerKey], exact, false) ?? (fuzzy.length ? findIn(providerKey, catalog[providerKey], fuzzy, true) : undefined);
    if (hit) {
      return { providerKey, modelKey: hit.modelKey, entry: hit.entry, exactProvider: true };
    }
  }

  for (const [normalize, variants] of [[false, exact], [true, fuzzy]] as const) {
    if (variants.length === 0) continue;
    const crossHits: CatalogMatch[] = [];
    for (const [providerKey, entry] of Object.entries(catalog)) {
      const hit = findIn(providerKey, entry, variants, normalize);
      if (hit) {
        crossHits.push({ providerKey, modelKey: hit.modelKey, entry: hit.entry, exactProvider: false });
        if (crossHits.length > 1) break;
      }
    }
    if (crossHits.length === 1) return crossHits[0];
  }
  return undefined;
}

export interface CatalogCandidate {
  providerKey: string;
  providerName?: string;
  modelKey: string;
  displayName?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  inputModalities?: string[];
  outputModalities?: string[];
  reasoning?: boolean;
  toolCall?: boolean;
  cost: ModelCostRates;
  costTiers?: ModelCostTier[];
  priced: boolean;
  canonicalModelId?: string;
  /** exact = 模型 ID 原名命中；normalized = 点/横线/厂商前缀归一后命中 */
  match: "exact" | "normalized";
  /** 命中 models.dev 中当前 provider 自身（排序优先） */
  preferredProvider: boolean;
}

/**
 * 列出 models.dev 中所有可能对应的供应商条目（跨 provider，不做歧义淘汰）。
 * 用于「目录参考价」选择：用户明确知道自己的上游对应哪家，由用户决定。
 */
export function listCatalogCandidates(
  catalog: ModelsDevCatalog,
  provider: Pick<ModelProviderDefinition, "id" | "apiBase">,
  modelId: string,
): CatalogCandidate[] {
  const exact = new Set(exactVariants(modelId));
  const targetHasVariantSuffix = hasVariantSuffix(modelId);
  const fuzzy = targetHasVariantSuffix ? new Set<string>() : new Set(fuzzyVariants(modelId));
  const preferredKeys = new Set(providerKeyCandidates(provider));
  const candidates: CatalogCandidate[] = [];

  for (const [providerKey, providerEntry] of Object.entries(catalog)) {
    if (!providerEntry?.models) continue;
    const providerName = typeof providerEntry.name === "string" ? providerEntry.name : undefined;
    for (const [modelKey, entry] of Object.entries(providerEntry.models)) {
      if (!entry || typeof entry !== "object") continue;
      const entryId = typeof entry.id === "string" ? entry.id : "";
      if (!targetHasVariantSuffix && (hasVariantSuffix(modelKey) || hasVariantSuffix(entryId))) continue;
      const rawKeys = [modelKey, entryId].map((v) => v.trim().toLowerCase()).filter(Boolean);
      if (rawKeys.length === 0) continue;
      const rawShorts = rawKeys.map((v) => (v.includes("/") ? v.slice(v.lastIndexOf("/") + 1) : v));
      const exactHit = [...exact].some((v) => rawKeys.includes(v) || rawShorts.includes(v));
      let normalizedHit = false;
      if (!exactHit && fuzzy.size > 0) {
        const canonical = typeof entry.canonical_model_id === "string" ? entry.canonical_model_id.toLowerCase() : "";
        const canonicalShort = canonical.includes("/") ? canonical.slice(canonical.lastIndexOf("/") + 1) : canonical;
        normalizedHit = [modelKey, entryId, canonical, canonicalShort]
          .filter(Boolean)
          .some((key) => fuzzy.has(normalizedModelId(key)));
      }
      if (!exactHit && !normalizedHit) continue;

      const values = modelsDevEntryToValues(entry, true);
      const cost: ModelCostRates = values.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      const priced =
        cost.input > 0 || cost.output > 0 || cost.cacheRead > 0 || cost.cacheWrite > 0 || (values.costTiers?.length ?? 0) > 0;
      candidates.push({
        providerKey,
        providerName,
        modelKey,
        displayName: values.displayName,
        contextWindow: values.contextWindow,
        maxOutputTokens: values.maxOutputTokens,
        inputModalities: values.inputModalities,
        outputModalities: values.outputModalities,
        reasoning: values.reasoning,
        toolCall: values.toolCall,
        cost,
        costTiers: values.costTiers,
        priced,
        canonicalModelId: typeof entry.canonical_model_id === "string" ? entry.canonical_model_id : undefined,
        match: exactHit ? "exact" : "normalized",
        preferredProvider: preferredKeys.has(providerKey),
      });
    }
  }

  candidates.sort(
    (a, b) =>
      Number(b.preferredProvider) - Number(a.preferredProvider) ||
      Number(b.match === "exact") - Number(a.match === "exact") ||
      Number(b.priced) - Number(a.priced) ||
      (a.providerName ?? a.providerKey).localeCompare(b.providerName ?? b.providerKey) ||
      a.modelKey.localeCompare(b.modelKey),
  );
  return candidates;
}

function rate(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}
function mapTiers(cost: ModelsDevModelEntry["cost"]): ModelCostTier[] | undefined {
  if (!cost) return undefined;
  const tiers: ModelCostTier[] = [];
  if (Array.isArray(cost.tiers)) {
    for (const raw of cost.tiers) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as Record<string, unknown>;
      const above = Number(item.inputTokensAbove ?? item.size ?? 0);
      if (!Number.isFinite(above) || above <= 0) continue;
      tiers.push({
        inputTokensAbove: above,
        input: rate(item.input),
        output: rate(item.output),
        cacheRead: rate(item.cache_read ?? item.cacheRead),
        cacheWrite: rate(item.cache_write ?? item.cacheWrite),
      });
    }
  }
  const over = cost.context_over_200k;
  if (over && typeof over === "object") {
    tiers.push({
      inputTokensAbove: 200_000,
      input: rate(over.input),
      output: rate(over.output),
      cacheRead: rate(over.cache_read),
      cacheWrite: rate(over.cache_write),
    });
  }
  if (tiers.length === 0) return undefined;
  return tiers.sort((a, b) => a.inputTokensAbove - b.inputTokensAbove);
}

function hasExplicitCost(entry: ModelsDevModelEntry): boolean {
  const cost = entry.cost;
  if (!cost || typeof cost !== "object") return false;
  return (
    ["input", "output", "cache_read", "cache_write"].some((key) => Number.isFinite(Number((cost as any)[key]))) ||
    Array.isArray(cost.tiers) ||
    Boolean(cost.context_over_200k)
  );
}

/** models.dev 条目 → 内部元数据值；exactProvider=false 时不采用价格。 */
export function modelsDevEntryToValues(entry: ModelsDevModelEntry, exactProvider: boolean): ModelMetadataValues {
  const values: ModelMetadataValues = {};
  if (typeof entry.name === "string" && entry.name) values.displayName = entry.name;
  if (typeof entry.limit?.context === "number" && entry.limit.context > 0) {
    values.contextWindow = Math.floor(entry.limit.context);
  }
  if (typeof entry.limit?.output === "number" && entry.limit.output > 0) {
    values.maxOutputTokens = Math.floor(entry.limit.output);
  }
  const inputs = Array.isArray(entry.modalities?.input) ? entry.modalities.input.filter((m) => typeof m === "string") : [];
  const outputs = Array.isArray(entry.modalities?.output) ? entry.modalities.output.filter((m) => typeof m === "string") : [];
  if (inputs.length > 0) values.inputModalities = inputs;
  if (outputs.length > 0) values.outputModalities = outputs;
  if (typeof entry.reasoning === "boolean") values.reasoning = entry.reasoning;
  if (typeof entry.tool_call === "boolean") values.toolCall = entry.tool_call;
  if (exactProvider && entry.cost) {
    const cost: ModelCostRates = {
      input: rate(entry.cost.input),
      output: rate(entry.cost.output),
      cacheRead: rate(entry.cost.cache_read),
      cacheWrite: rate(entry.cost.cache_write),
    };
    const tiers = mapTiers(entry.cost);
    // 显式 cost（即使全 0）与「缺少 cost」语义不同：前者是免费模型，
    // 后者才允许回退 builtin 价格。
    if (hasExplicitCost(entry)) {
      values.cost = cost;
      if (tiers) values.costTiers = tiers;
    }
  }
  return values;
}

// --- 内置目录 fallback ---

let builtinIndex: Map<string, Map<string, Model<any>>> | undefined;

function getBuiltinIndex(): Map<string, Map<string, Model<any>>> {
  if (builtinIndex) return builtinIndex;
  const index = new Map<string, Map<string, Model<any>>>();
  try {
    const models = builtinModels();
    for (const model of models.getModels()) {
      const provider = String(model.provider).toLowerCase();
      let bucket = index.get(provider);
      if (!bucket) {
        bucket = new Map();
        index.set(provider, bucket);
      }
      bucket.set(String(model.id).toLowerCase(), model);
    }
  } catch (err) {
    logger.debug("ModelMetadata", `Failed to index pi-ai builtin models: ${err}`);
  }
  builtinIndex = index;
  return index;
}

export interface BuiltinModelMatch {
  model: Model<any>;
  /** false = 语义后缀或跨 provider fuzzy 命中：只能复用窗口/模态，不能复用价格 */
  priceAllowed: boolean;
  exact: boolean;
}

export function matchBuiltinModelMatch(
  provider: Pick<ModelProviderDefinition, "id" | "apiBase">,
  modelId: string,
): BuiltinModelMatch | undefined {
  const index = getBuiltinIndex();
  const exact = exactVariants(modelId);
  const fuzzy = fuzzyVariants(modelId);
  const semantic = hasSemanticSuffix(modelId);

  const findExact = (bucket: Map<string, Model<any>>): Model<any> | undefined => {
    for (const variant of exact) {
      const hit = bucket.get(variant);
      if (hit) return hit;
    }
    return undefined;
  };
  const findFuzzy = (bucket: Map<string, Model<any>>): Model<any> | undefined => {
    if (fuzzy.length === 0) return undefined;
    for (const [key, model] of bucket) {
      if (fuzzy.includes(normalizedModelId(key))) return model;
    }
    return undefined;
  };

  for (const key of providerKeyCandidates(provider)) {
    const bucket = index.get(key);
    if (!bucket) continue;
    const hit = findExact(bucket);
    if (hit) return { model: hit, priceAllowed: true, exact: true };
    const fuzzyHit = findFuzzy(bucket);
    if (fuzzyHit) return { model: fuzzyHit, priceAllowed: !semantic, exact: false };
  }

  // 跨 provider：只复用元数据，不采用价格；同名模型元数据不一致时按歧义拒绝，
  // 避免把 azure/openai 等不同窗口的条目随机套用。
  const crossExact: Model<any>[] = [];
  for (const bucket of index.values()) {
    const hit = findExact(bucket);
    if (hit) crossExact.push(hit);
  }
  if (crossExact.length === 1) {
    return { model: crossExact[0]!, priceAllowed: false, exact: true };
  }
  if (crossExact.length > 1) {
    const signature = (model: Model<any>) =>
      JSON.stringify([model.contextWindow, model.maxTokens, [...model.input].sort(), model.reasoning]);
    const signatures = new Set(crossExact.map(signature));
    // 元数据完全一致才可采用；否则歧义不猜
    return signatures.size === 1
      ? { model: crossExact[0]!, priceAllowed: false, exact: true }
      : undefined;
  }
  if (!semantic) {
    let found: Model<any> | undefined;
    for (const bucket of index.values()) {
      const hit = findFuzzy(bucket);
      if (hit) {
        if (found) return undefined;
        found = hit;
      }
    }
    if (found) return { model: found, priceAllowed: false, exact: false };
  }
  return undefined;
}

export function builtinModelToValues(model: Model<any>, includeCost = true): ModelMetadataValues {
  const values: ModelMetadataValues = {
    displayName: model.name,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxTokens,
    inputModalities: [...model.input],
    reasoning: model.reasoning,
    toolCall: true,
  };
  if (!includeCost) return values;
  const cost: ModelCostRates = {
    input: rate(model.cost?.input),
    output: rate(model.cost?.output),
    cacheRead: rate(model.cost?.cacheRead),
    cacheWrite: rate(model.cost?.cacheWrite),
  };
  if (cost.input > 0 || cost.output > 0 || cost.cacheRead > 0 || cost.cacheWrite > 0) {
    values.cost = cost;
    const tiers = model.cost?.tiers;
    if (Array.isArray(tiers) && tiers.length > 0) {
      values.costTiers = tiers.map((t) => ({
        inputTokensAbove: rate(t.inputTokensAbove),
        input: rate(t.input),
        output: rate(t.output),
        cacheRead: rate(t.cacheRead),
        cacheWrite: rate(t.cacheWrite),
      }));
    }
  }
  return values;
}

function mergeNonPriceValues(primary: ModelMetadataValues, fallback: ModelMetadataValues): ModelMetadataValues {
  const values: ModelMetadataValues = {};
  const displayName = primary.displayName ?? fallback.displayName;
  if (displayName !== undefined) values.displayName = displayName;
  const contextWindow = primary.contextWindow ?? fallback.contextWindow;
  if (contextWindow !== undefined) values.contextWindow = contextWindow;
  const maxOutputTokens = primary.maxOutputTokens ?? fallback.maxOutputTokens;
  if (maxOutputTokens !== undefined) values.maxOutputTokens = maxOutputTokens;
  const inputModalities = primary.inputModalities?.length ? primary.inputModalities : fallback.inputModalities;
  if (inputModalities?.length) values.inputModalities = inputModalities;
  const outputModalities = primary.outputModalities?.length ? primary.outputModalities : fallback.outputModalities;
  if (outputModalities?.length) values.outputModalities = outputModalities;
  const reasoning = primary.reasoning ?? fallback.reasoning;
  if (reasoning !== undefined) values.reasoning = reasoning;
  const toolCall = primary.toolCall ?? fallback.toolCall;
  if (toolCall !== undefined) values.toolCall = toolCall;
  return values;
}

/** models.dev 命中时：缺字段回退 builtin/static；价格只在 provider 精确命中时采用。 */
function autoValuesForMatch(
  provider: Pick<ModelProviderDefinition, "id" | "apiBase">,
  modelId: string,
  match: CatalogMatch,
): ModelMetadataValues {
  const builtinMatch = matchBuiltinModelMatch(provider, modelId);
  const fallback = builtinMatch
    ? builtinModelToValues(builtinMatch.model, builtinMatch.priceAllowed)
    : staticFallbackValues(modelId);
  const primary = modelsDevEntryToValues(match.entry, match.exactProvider);
  const values = mergeNonPriceValues(primary, fallback);
  if (match.exactProvider) {
    if (primary.cost) {
      values.cost = primary.cost;
      if (primary.costTiers) values.costTiers = primary.costTiers;
    } else if (fallback.cost) {
      // models.dev 条目缺少 cost 字段：回退到同 provider 的 builtin 价格
      values.cost = fallback.cost;
      if (fallback.costTiers) values.costTiers = fallback.costTiers;
    }
  }
  return values;
}

export function staticFallbackValues(modelId: string): ModelMetadataValues {
  const contextWindow = lookupContextWindow(modelId);
  return {
    contextWindow: contextWindow && contextWindow > 0 ? contextWindow : 0,
    maxOutputTokens: 8192,
    inputModalities: ["text"],
    reasoning: false,
    toolCall: true,
  };
}

// --- 目录拉取与缓存 ---

export async function fetchModelsDevCatalog(fetchImpl: typeof fetch = fetch): Promise<ModelsDevCatalog> {
  const res = await fetchImpl(MODELS_DEV_URL, {
    headers: { accept: "application/json", "user-agent": "Bot-Agent/1.0" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`models.dev HTTP ${res.status}`);
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_CATALOG_BYTES) {
    throw new Error(`models.dev catalog too large: ${declared} bytes`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.byteLength > MAX_CATALOG_BYTES) {
    throw new Error(`models.dev catalog too large: ${buffer.byteLength} bytes`);
  }
  const parsed = JSON.parse(buffer.toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("models.dev catalog is not an object");
  }
  const catalog = parsed as ModelsDevCatalog;
  const providers = Object.values(catalog).filter((p) => p && typeof p === "object" && p.models && typeof p.models === "object");
  if (providers.length === 0) throw new Error("models.dev catalog has no providers");
  return catalog;
}

let memoryCatalog: { catalog: ModelsDevCatalog; fetchedAt: number } | undefined;

export function loadCatalogFromCache(store = new DatabaseStore()): ModelsDevCatalog | undefined {
  const cached = store.getModelCatalogCache();
  if (!cached) return undefined;
  if (memoryCatalog && memoryCatalog.fetchedAt === cached.fetchedAt) return memoryCatalog.catalog;
  try {
    const json = gunzipSync(cached.payload).toString("utf8");
    const catalog = JSON.parse(json) as ModelsDevCatalog;
    memoryCatalog = { catalog, fetchedAt: cached.fetchedAt };
    return catalog;
  } catch (err) {
    logger.warn("ModelMetadata", `Failed to read cached models.dev catalog: ${err}`);
    return undefined;
  }
}

export function catalogFetchedAt(store = new DatabaseStore()): number | undefined {
  return store.getModelCatalogMeta()?.fetchedAt;
}

function catalogCounts(catalog: ModelsDevCatalog): { providerCount: number; modelCount: number } {
  let modelCount = 0;
  for (const provider of Object.values(catalog)) {
    if (provider?.models) modelCount += Object.keys(provider.models).length;
  }
  return { providerCount: Object.keys(catalog).length, modelCount };
}

export function modelsForProvider(store: DatabaseStore, provider: ModelProviderDefinition): string[] {
  const ids = new Set(provider.models ?? []);
  for (const agent of store.listAgents()) {
    if (agent.model?.provider === provider.id && agent.model.modelId) ids.add(agent.model.modelId);
  }
  return [...ids];
}

export interface ResolvedAutoMetadata {
  auto: ModelMetadataValues;
  autoSource: ModelMetadataSource;
  matchedProvider?: string;
  matchedModel?: string;
}

/** 单一的元数据优先级链：models.dev（精确 provider 才带价格）→ builtin → static。 */
export function resolveAutoMetadata(
  provider: Pick<ModelProviderDefinition, "id" | "apiBase">,
  modelId: string,
  catalog: ModelsDevCatalog | undefined,
): ResolvedAutoMetadata {
  const match = catalog ? matchCatalogModel(catalog, provider, modelId) : undefined;
  if (match) {
    return {
      auto: autoValuesForMatch(provider, modelId, match),
      autoSource: "models.dev",
      matchedProvider: match.providerKey,
      matchedModel: match.modelKey,
    };
  }
  const builtin = matchBuiltinModelMatch(provider, modelId);
  if (builtin) {
    return {
      auto: builtinModelToValues(builtin.model, builtin.priceAllowed),
      autoSource: "builtin",
      matchedProvider: builtin.model.provider,
      matchedModel: builtin.model.id,
    };
  }
  return { auto: staticFallbackValues(modelId), autoSource: "fallback" };
}

/** 刷新目录并重算所有已配置模型的自动元数据（manual 覆盖保留）。 */
export async function refreshModelsDevCatalog(
  store = new DatabaseStore(),
  fetchImpl: typeof fetch = fetch,
): Promise<CatalogRefreshStats> {
  const catalog = await fetchModelsDevCatalog(fetchImpl);
  const fetchedAt = Date.now();
  const counts = catalogCounts(catalog);
  store.saveModelCatalogCache({
    payload: await gzipAsync(Buffer.from(JSON.stringify(catalog), "utf8")),
    fetchedAt,
    lastCheckedAt: fetchedAt,
    providerCount: counts.providerCount,
    modelCount: counts.modelCount,
  });
  memoryCatalog = { catalog, fetchedAt };
  return rematchConfiguredModels(store, catalog, fetchedAt);
}

/** 用内存/缓存目录重新匹配（目录未变时也可单独调用）。 */
export function rematchConfiguredModels(
  store: DatabaseStore,
  catalog: ModelsDevCatalog,
  fetchedAt = Date.now(),
): CatalogRefreshStats {
  let matched = 0;
  let builtin = 0;
  let fallback = 0;
  let manualPreserved = 0;
  let models = 0;
  const providers = store.listModelProviders();
  for (const provider of providers) {
    const modelIds = modelsForProvider(store, provider);
    const records: ModelMetadataRecord[] = [];
    for (const modelId of modelIds) {
      models++;
      const existing = store.getModelMetadata(provider.id, modelId);
      const manual = existing?.manual ?? null;
      if (manual && Object.keys(manual).length > 0) manualPreserved++;
      const resolved = resolveAutoMetadata(provider, modelId, catalog);
      if (resolved.autoSource === "models.dev") matched++;
      else if (resolved.autoSource === "builtin") builtin++;
      else fallback++;
      records.push({
        providerId: provider.id,
        modelId,
        auto: resolved.auto,
        autoSource: resolved.autoSource,
        manual,
        matchedProvider: resolved.matchedProvider,
        matchedModel: resolved.matchedModel,
        refreshedAt: fetchedAt,
        updatedAt: Date.now(),
      });
    }
    store.saveModelMetadataBatch(records);
    store.pruneModelMetadata(provider.id, modelIds);
  }
  return {
    providers: providers.length,
    models,
    matched,
    builtin,
    fallback,
    manualPreserved,
    fetchedAt,
    changed: true,
  };
}

/** 启动时在 TTL 内跳过；失败只记日志，绝不影响启动。 */
export async function refreshIfStale(store = new DatabaseStore(), fetchImpl: typeof fetch = fetch): Promise<CatalogRefreshStats | undefined> {
  const cached = store.getModelCatalogMeta();
  if (cached && Date.now() - cached.lastCheckedAt < MODELS_DEV_TTL_MS) return undefined;
  try {
    return await refreshModelsDevCatalog(store, fetchImpl);
  } catch (err) {
    logger.warn("ModelMetadata", `models.dev refresh failed (kept old cache): ${err}`);
    return undefined;
  }
}

/** provider 保存后：无需联网，用已有缓存尽力匹配新增模型。 */
export function rematchProviderFromCache(store: DatabaseStore, provider: ModelProviderDefinition): CatalogRefreshStats | undefined {
  const catalog = loadCatalogFromCache(store);
  if (!catalog) return undefined;
  const modelIds = modelsForProvider(store, provider);
  for (const modelId of modelIds) {
    const existing = store.getModelMetadata(provider.id, modelId);
    if (existing?.manual && Object.keys(existing.manual).length > 0) continue;
    const resolved = resolveAutoMetadata(provider, modelId, catalog);
    store.saveModelMetadata({
      providerId: provider.id,
      modelId,
      auto: resolved.auto,
      autoSource: resolved.autoSource,
      manual: existing?.manual ?? null,
      matchedProvider: resolved.matchedProvider,
      matchedModel: resolved.matchedModel,
      refreshedAt: Date.now(),
      updatedAt: Date.now(),
    });
  }
  store.pruneModelMetadata(provider.id, modelIds);
  return {
    providers: 1,
    models: modelIds.length,
    matched: modelIds.length,
    builtin: 0,
    fallback: 0,
    manualPreserved: 0,
    fetchedAt: Date.now(),
    changed: true,
  };
}

/** 清除内存目录缓存（测试用）。 */
export function resetCatalogMemoryCache(): void {
  memoryCatalog = undefined;
  builtinIndex = undefined;
}
