/**
 * 前端开发模式: 同时启动 Bun 后端 (API, 默认 3000) 与 Vite Dev Server (HMR, 5173)。
 * 浏览器访问 http://localhost:5173，/api 由 Vite 代理到后端。
 * Ctrl+C 同时退出两个进程。
 */
const backendPort = process.env.BOT_PORT || "3000";

const backend = Bun.spawn(["bun", "run", "src/cli.ts", "start", "--port", backendPort, "--no-terminal"], {
  cwd: import.meta.dir + "/..",
  stdout: "inherit",
  stderr: "inherit",
});

const vite = Bun.spawn(["bunx", "vite", "dev"], {
  cwd: import.meta.dir + "/../web",
  stdout: "inherit",
  stderr: "inherit",
});

console.log(`\n  后端 API  : http://127.0.0.1:${backendPort}`);
  console.log(`  管理界面  : http://localhost:5173 (HMR)\n`);

const shutdown = () => {
  backend.kill();
  vite.kill();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await Promise.all([backend.exited, vite.exited]);
