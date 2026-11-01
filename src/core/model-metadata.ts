import {
  DatabaseStore,
  type ModelCostRates,
  type ModelCostTier,
  type ModelMetadataRecord,
  type ModelMetadataSource,
  type ModelMetadataValues,
  type ModelProviderDefinition,
} from "../config/database-store.ts";
import {
  builtinModelToValues,
  matchBuiltinModelMatch,
  modelsForProvider,
  staticFallbackValues,
} from "./models-dev.ts";

export interface EffectiveModelMetadata {
  providerId: string;
  modelId: string;
  displayName?: string;
  contextWindow: number;
  maxOutputTokens: number;
  inputModalities: string[];
  outputModalities: string[];
  reasoning: boolean;
  toolCall: boolean;
  cost: ModelCostRates;
  costTiers?: ModelCostTier[];
  source: ModelMetadataSource | "manual" | "unknown";
  auto: ModelMetadataValues | null;
  manual: Partial<ModelMetadataValues> | null;
  matchedProvider?: string;
  matchedModel?: string;
}

const ZERO_COST: ModelCostRates = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export function mergeMetadataValues(
  auto: ModelMetadataValues | null | undefined,
  manual: Partial<ModelMetadataValues> | null | undefined,
): ModelMetadataValues {
  const merged: ModelMetadataValues = { ...(auto ?? {}) };
  for (const [key, value] of Object.entries(manual ?? {})) {
    if (value === undefined || value === null) continue;
    (merged as Record<string, unknown>)[key] = value;
  }
  // 手动改基础价格但未同时提供 tiers 时，清除自动 tiers，避免 >200k 仍按旧价格计费。
  if (manual && "cost" in manual && manual.costTiers === undefined) {
    delete merged.costTiers;
  }
  return merged;
}

export function effectiveFromValues(
  providerId: string,
  modelId: string,
  values: ModelMetadataValues,
  extra: {
    source?: ModelMetadataSource | "manual" | "unknown";
    auto?: ModelMetadataValues | null;
    manual?: Partial<ModelMetadataValues> | null;
    matchedProvider?: string;
    matchedModel?: string;
  } = {},
): EffectiveModelMetadata {
  const contextWindow = Number(values.contextWindow ?? 0);
  const maxOutputTokens = Number(values.maxOutputTokens ?? 0) || 8192;
  const inputModalities = Array.isArray(values.inputModalities) && values.inputModalities.length > 0
    ? values.inputModalities
    : ["text"];
  const outputModalities = Array.isArray(values.outputModalities) ? values.outputModalities : ["text"];
  return {
    providerId,
    modelId,
    displayName: values.displayName,
    contextWindow: Number.isFinite(contextWindow) && contextWindow > 0 ? Math.floor(contextWindow) : 0,
    maxOutputTokens: Number.isFinite(maxOutputTokens) && maxOutputTokens > 0 ? Math.floor(maxOutputTokens) : 8192,
    inputModalities,
    outputModalities,
    reasoning: Boolean(values.reasoning),
    toolCall: values.toolCall !== false,
    cost: values.cost ?? ZERO_COST,
    costTiers: values.costTiers,
    source: extra.source ?? "unknown",
    auto: extra.auto ?? null,
    manual: extra.manual ?? null,
    matchedProvider: extra.matchedProvider,
    matchedModel: extra.matchedModel,
  };
}

function fallbackValues(provider: ModelProviderDefinition, modelId: string): {
  values: ModelMetadataValues;
  source: ModelMetadataSource;
  matchedProvider?: string;
  matchedModel?: string;
} {
  const builtin = matchBuiltinModelMatch(provider, modelId);
  if (builtin) {
    return {
      values: builtinModelToValues(builtin.model, builtin.priceAllowed),
      source: "builtin",
      matchedProvider: builtin.model.provider,
      matchedModel: builtin.model.id,
    };
  }
  return { values: staticFallbackValues(modelId), source: "fallback" };
}

/** 由给定行计算有效元数据（批量构建模型目录时避免逐模型 SELECT）。 */
export function effectiveModelMetadataFromRecord(
  provider: ModelProviderDefinition,
  modelId: string,
  record: ModelMetadataRecord | undefined,
): EffectiveModelMetadata {
  if (record && (record.auto || record.manual)) {
    // auto 缺失（例如用户先手动覆盖、目录尚未刷新）时用 builtin/static 兜底，
    // 避免只改一个字段把窗口/模态清零。
    const fallback = record.auto ? undefined : fallbackValues(provider, modelId);
    const merged = mergeMetadataValues(record.auto ?? fallback?.values ?? null, record.manual);
    return effectiveFromValues(provider.id, modelId, merged, {
      source: record.manual && Object.keys(record.manual).length > 0
        ? "manual"
        : (record.autoSource ?? fallback?.source ?? "fallback"),
      auto: record.auto ?? fallback?.values ?? null,
      manual: record.manual,
      matchedProvider: record.matchedProvider ?? fallback?.matchedProvider,
      matchedModel: record.matchedModel ?? fallback?.matchedModel,
    });
  }
  const fallback = fallbackValues(provider, modelId);
  return effectiveFromValues(provider.id, modelId, fallback.values, {
    source: fallback.source,
    matchedProvider: fallback.matchedProvider,
    matchedModel: fallback.matchedModel,
  });
}

/** 有效元数据 = manual 覆盖 auto；无记录时即时使用 builtin/static。 */
export function resolveModelMetadata(
  provider: ModelProviderDefinition,
  modelId: string,
  store = new DatabaseStore(),
): EffectiveModelMetadata {
  return effectiveModelMetadataFromRecord(provider, modelId, store.getModelMetadata(provider.id, modelId));
}

export function hasPricing(meta: Pick<EffectiveModelMetadata, "cost" | "costTiers">): boolean {
  const c = meta.cost;
  return c.input > 0 || c.output > 0 || c.cacheRead > 0 || c.cacheWrite > 0 || (meta.costTiers?.length ?? 0) > 0;
}

/** 所有已配置模型的有效值指纹：只在变化时 reloadModels，避免刷新风暴。 */
export function effectiveMetadataFingerprint(store = new DatabaseStore()): string {
  const parts: string[] = [];
  for (const provider of store.listModelProviders()) {
    const models = modelsForProvider(store, provider).sort();
    for (const modelId of models) {
      const meta = resolveModelMetadata(provider, modelId, store);
      parts.push(JSON.stringify([
        provider.id,
        modelId,
        meta.displayName ?? null,
        meta.contextWindow,
        meta.maxOutputTokens,
        meta.inputModalities,
        meta.reasoning,
        meta.toolCall,
        meta.cost,
        meta.costTiers ?? null,
      ]));
    }
  }
  return parts.join("\n");
}
