/**
 * 模型上下文窗口识别 (参照 hermes agent 的 model_metadata 策略):
 * 内置目录 + 最长前缀匹配, BYOK 自定义 modelId 无需注册即可识别。
 * 命中语义: modelId 小写化后以前缀匹配目录 key, 取最长命中的窗口值。
 * 未命中 → undefined (调用方决定 fallback, 如 128k)。
 */

const CATALOG: [string, number][] = [
  // DeepSeek — V4 系 1M; 旧 V3/V2 系 128k
  ["deepseek-v4", 1_000_000],
  ["deepseek-reasoner", 1_000_000],
  ["deepseek-chat", 1_000_000],
  ["deepseek-r", 64_000],
  ["deepseek", 128_000],
  // OpenAI
  ["gpt-5", 400_000],
  ["gpt-4.1", 1_047_576],
  ["gpt-4o", 128_000],
  ["gpt-4-turbo", 128_000],
  ["gpt-4", 8_192],
  ["gpt-3.5", 16_384],
  ["o1", 200_000],
  ["o3", 200_000],
  ["o4-mini", 200_000],
  // Anthropic — Claude 4+ 200k (特定长窗型号由用户配置覆盖)
  ["claude-opus-4", 200_000],
  ["claude-sonnet-4", 200_000],
  ["claude-3-7", 200_000],
  ["claude-3-5", 200_000],
  ["claude-3", 200_000],
  ["claude", 200_000],
  // Google
  ["gemini-2", 1_048_576],
  ["gemini-1.5-pro", 2_097_152],
  ["gemini", 1_048_576],
  ["gemma", 8_192],
  // Qwen / GLM / Kimi / MiniMax / Llama 常见家族
  ["qwen3-max", 262_144],
  ["qwen3", 131_072],
  ["qwen2.5", 131_072],
  ["qwen", 32_768],
  ["glm-4", 128_000],
  ["glm", 8_192],
  ["kimi-k", 262_144],
  ["kimi", 131_072],
  ["minimax", 1_000_000],
  ["llama-4", 1_048_576],
  ["llama-3", 131_072],
  ["llama", 8_192],
  ["mistral", 131_072],
];

export function lookupContextWindow(modelId: string): number | undefined {
  const id = modelId.toLowerCase().trim();
  if (!id) return undefined;
  let best: { prefix: string; window: number } | undefined;
  for (const [prefix, window] of CATALOG) {
    if (id.startsWith(prefix) && (!best || prefix.length > best.prefix.length)) {
      best = { prefix, window };
    }
  }
  return best?.window;
}
