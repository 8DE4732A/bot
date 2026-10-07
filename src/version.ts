/**
 * 应用版本 (单一真相源 = git tag): 构建时由 CI 注入——
 *   bun build ... --define __APP_VERSION__='"0.2.0"'
 * (workflow 从 tag GITHUB_REF_NAME 剥掉 v 前缀; 本地开发/未注入时 fallback "dev")
 */
declare const __APP_VERSION__: string | undefined;

export const BOT_VERSION: string =
  typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "dev";
