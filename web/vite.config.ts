import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 管理后台前端。开发时: bun run dev:web (HMR, /api 代理到 Bun 后端)。
// 构建: bun run build:web → 产物经 scripts/embed-web.ts 内嵌进单二进制。
export default defineConfig({
  root: __dirname,
  plugins: [react()],
  resolve: {
    alias: {
      // 与后端共享纯数据模块 (如沙盒默认值), type-only import 不会带入 node 依赖
      "@bot-core": resolve(__dirname, "../src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${process.env.BOT_PORT || 3000}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // 单二进制内嵌场景，产物越小越好
    chunkSizeWarningLimit: 700,
  },
});
