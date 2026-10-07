#!/usr/bin/env bun
/**
 * 发布构建 (0.1.0): 四平台二进制编译, GitHub Release 分发。
 *   bun run scripts/build-release.ts            # 当前平台
 *   bun run scripts/build-release.ts --all      # 四平台矩阵 (CI 用)
 *
 * 产物: dist/release/<os>-<arch>/bot (裸二进制; CI 打成 bot-<platform>.tar.gz)
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const PLATFORMS = [
  { target: "bun-darwin-arm64", os: "darwin", cpu: "arm64" },
  { target: "bun-darwin-x64", os: "darwin", cpu: "x64" },
  { target: "bun-linux-x64", os: "linux", cpu: "x64" },
  { target: "bun-linux-arm64", os: "linux", cpu: "arm64" },
] as const;

const root = process.cwd();
const all = process.argv.includes("--all");
// 版本单一真相源 = git tag (CI 从 GITHUB_REF_NAME 剥 v 前缀传入); 本地
// 无 tag 时 "dev"。经 --define 注入二进制 (bot --version / identify 可见)
const version = process.env.VERSION || "dev";

async function sh(cmd: string[], label: string): Promise<void> {
  console.log(`▶ ${label}`);
  const proc = Bun.spawn(cmd, { cwd: root, stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) {
    console.error(`✗ ${label} 失败 (exit ${code})`);
    process.exit(code);
  }
}

// 1. Web UI 内嵌产物 (所有平台共用)
await sh(["bun", "run", "build:web"], "build:web");

// 2. 目标平台
const targets = all
  ? PLATFORMS
  : PLATFORMS.filter((p) => `${p.os}-${p.cpu}` === `${process.platform}-${process.arch}`);
if (targets.length === 0) {
  console.error(`当前平台 ${process.platform}-${process.arch} 不在发布矩阵中`);
  process.exit(1);
}

for (const platform of targets) {
  const outDir = join(root, "dist", "release", `${platform.os}-${platform.cpu}`);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  console.log(`▶ 编译 ${platform.target} → bot-${platform.os}-${platform.cpu}`);
  const proc = Bun.spawn(
    [
      "bun",
      "build",
      "src/cli.ts",
      "--compile",
      "--minify",
      `--define=__APP_VERSION__=${JSON.stringify(version)}`,
      `--target=${platform.target}`,
      `--outfile=${join(outDir, "bot")}`,
    ],
    { cwd: root, stdout: "inherit", stderr: "inherit" },
  );
  const code = await proc.exited;
  if (code !== 0) {
    console.error(`✗ 编译 ${platform.target} 失败 (exit ${code})`);
    process.exit(code);
  }
  console.log(`✓ ${outDir}`);
}

console.log(`\n发布物就绪 (v${version}); CI 打包为 bot-<platform>.tar.gz 并挂 GitHub Release。`);
