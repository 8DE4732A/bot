import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { DatabaseStore, type ModelProtocol, type ModelProviderDefinition } from "../config/database-store.ts";
import { lookupContextWindow } from "../config/context-windows.ts";
import { logger } from "../utils/logger.ts";

export class ModelFactory {
  // 延迟获取: 模块 import 阶段绝不触发 DatabaseManager 开库
  // (否则单例会在 CLI/测试设置自定义路径之前绑定到 process.cwd())
  private static get store() {
    return new DatabaseStore();
  }

  // 注意: 不再把 provider 密钥写入 process.env——所有 provider 都经
  // createProvider 的 auth.resolve 闭包从库中取 key, 环境变量注入
  // 只是给沙盒内 bash (inheritEnv) 泄漏机密的纯攻击面。

  public static createConfiguredModels() {
    const models = createModels();
    const providers = this.store.listModelProviders();

    for (const p of providers) {
      try {
        const providerInstance = this.buildProviderInstance(p);
        models.setProvider(providerInstance);
        logger.debug("ModelFactory", `Registered BYOK provider: ${p.id} (${p.models.length} models)`);
      } catch (err) {
        logger.warn("ModelFactory", `Failed to register provider ${p.id}: ${err}`);
      }
    }

    return models;
  }

  public static buildProviderInstance(p: ModelProviderDefinition) {
    let api: any;
    switch (p.protocol) {
      case "openai-responses":
        api = openAIResponsesApi();
        break;
      case "anthropic-messages":
        api = anthropicMessagesApi();
        break;
      case "google":
        api = googleGenerativeAIApi();
        break;
      case "openai-completions":
      default:
        api = openAICompletionsApi();
        break;
    }

    const isStandardOpenAiHost = p.apiBase.includes("api.openai.com");
    const registeredModelIds = new Set<string>(p.models && p.models.length > 0 ? p.models : ["default"]);
    try {
      const agents = this.store.listAgents();
      for (const a of agents) {
        if (a.model?.provider === p.id && a.model.modelId) {
          registeredModelIds.add(a.model.modelId);
        }
      }
    } catch {
      // ignore
    }

    const modelEntries = Array.from(registeredModelIds).map((modelId) => ({
      id: modelId,
      name: modelId,
      type: "chat" as const,
      api: p.protocol as any,
      provider: p.id,
      baseUrl: p.apiBase,
      reasoning: false,
      input: ["text" as const],
      // 目录未命中 → 0: 终端只显示 tokens 不显示假百分比 (pi-ai 内部不依赖此值做决策)
      contextWindow: lookupContextWindow(modelId) ?? 0,
      maxTokens: 8192,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: {
        supportsStore: isStandardOpenAiHost,
        supportsDeveloperRole: isStandardOpenAiHost,
      },
    }));

    return createProvider({
      id: p.id,
      name: p.name,
      baseUrl: p.apiBase,
      auth: {
        apiKey: {
          name: `${p.name} API Key`,
          login: async () => ({ type: "api_key", key: p.apiKey }),
          resolve: async () => ({
            auth: { apiKey: p.apiKey },
            source: "byok_store",
          }),
        },
      },
      models: modelEntries,
      api,
    });
  }

  /**
   * Automatically queries the remote endpoint to discover available models.
   * Standard for OpenAI-compatible endpoints: GET ${apiBase}/models
   */
  public static async fetchRemoteModels(
    apiBase: string,
    apiKey: string,
  ): Promise<{ success: boolean; models: string[]; error?: string }> {
    try {
      const base = apiBase.trim().replace(/\/+$/, "");
      const modelsUrl = base.endsWith("/v1") ? `${base}/models` : `${base}/v1/models`;

      logger.info("ModelFactory", `Fetching models from: ${modelsUrl}`);
      const headers: Record<string, string> = {
        "User-Agent": "Bot-Agent/1.0",
      };
      if (apiKey) {
        headers.Authorization = `Bearer ${apiKey}`;
      }

      const res = await fetch(modelsUrl, { headers });
      if (!res.ok) {
        // Try direct base/models if v1 failed
        const altUrl = `${base}/models`;
        if (altUrl !== modelsUrl) {
          const resAlt = await fetch(altUrl, { headers });
          if (resAlt.ok) {
            const data = (await resAlt.json()) as any;
            return { success: true, models: this.extractModelIds(data) };
          }
        }
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      const data = (await res.json()) as any;
      const models = this.extractModelIds(data);
      return { success: true, models };
    } catch (err: any) {
      logger.warn("ModelFactory", `Failed to fetch remote models from ${apiBase}: ${err?.message || err}`);
      return { success: false, models: [], error: err?.message || String(err) };
    }
  }

  private static extractModelIds(data: any): string[] {
    if (!data) return [];
    if (Array.isArray(data.data)) {
      return data.data.map((item: any) => item.id).filter(Boolean);
    }
    if (Array.isArray(data)) {
      return data.map((item: any) => (typeof item === "string" ? item : item.id || item.name)).filter(Boolean);
    }
    if (data.models && Array.isArray(data.models)) {
      return data.models.map((item: any) => item.id || item.name).filter(Boolean);
    }
    return [];
  }

  public static async testConnection(
    providerId: string,
    modelId: string,
    apiBase?: string,
    apiKey?: string,
    protocol: ModelProtocol = "openai-completions",
  ): Promise<{ success: boolean; latencyMs?: number; error?: string }> {
    const startTime = Date.now();
    try {
      let resolvedBase = apiBase;
      let resolvedKey = apiKey;

      if (!resolvedBase || !resolvedKey) {
        const stored = this.store.getModelProvider(providerId);
        if (stored) {
          resolvedBase = resolvedBase || stored.apiBase;
          resolvedKey = resolvedKey || stored.apiKey;
        }
      }

      if (!resolvedBase) {
        throw new Error("Missing API Base URL");
      }

      const testProviderDef: ModelProviderDefinition = {
        id: `test-${providerId}-${Date.now()}`,
        name: `Test ${providerId}`,
        protocol,
        apiBase: resolvedBase,
        apiKey: resolvedKey || "",
        models: [modelId],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const testModels = createModels();
      testModels.setProvider(this.buildProviderInstance(testProviderDef));

      const model = testModels.getModel(testProviderDef.id, modelId);
      if (!model) {
        throw new Error(`Failed to resolve model ${modelId} under ${providerId}`);
      }

      logger.info("ModelFactory", `Testing connection to ${testProviderDef.id}/${modelId}...`);
      const stream = await testModels.stream(
        model,
        {
          messages: [
            {
              role: "user",
              timestamp: Date.now(),
              content: [{ type: "text", text: "Say 'OK' and nothing else." }],
            },
          ],
        },
        {},
      );

      let text = "";
      for await (const chunk of stream) {
        if (chunk.type === "text_delta") {
          text += chunk.delta;
        }
      }

      const latencyMs = Date.now() - startTime;
      logger.info("ModelFactory", `Test successful in ${latencyMs}ms: ${text.trim()}`);
      return { success: true, latencyMs };
    } catch (err: any) {
      const latencyMs = Date.now() - startTime;
      logger.error("ModelFactory", `Test connection failed:`, err);
      return { success: false, latencyMs, error: err?.message || String(err) };
    }
  }
}
