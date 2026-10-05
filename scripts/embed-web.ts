/**
 * 将 web/dist 构建产物转换为 TypeScript 模块 src/server/ui/generated.ts，
 * 供 AdminWebServer 直接内嵌进单二进制分发，无需外部静态目录。
 *
 * 文本资源 (html/js/css/svg/json/map) 原文内嵌；二进制资源 (woff2/png 等) base64。
 * 运行: bun run scripts/embed-web.ts （build:web 会自动串联执行）
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";

const DIST_DIR = join(import.meta.dir, "..", "web", "dist");
const OUT_FILE = join(import.meta.dir, "..", "src", "server", "ui", "generated.ts");

const TEXT_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
  ".webmanifest": "application/manifest+json",
};

const BINARY_MIME: Record<string, string> = {
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
};

function collectFiles(dir: string, base = dir): { path: string; abs: string }[] {
  const out: { path: string; abs: string }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectFiles(abs, base));
    } else {
      out.push({ path: relative(base, abs).split("\\").join("/"), abs });
    }
  }
  return out;
}

function main() {
  if (!statSync(DIST_DIR, { throwIfNoEntry: false })?.isDirectory()) {
    console.error(`[embed-web] 未找到 ${DIST_DIR}，请先执行 vite 构建 (bun run build:web)。`);
    process.exit(1);
  }

  const files = collectFiles(DIST_DIR)
    // woff2 现代浏览器全覆盖, 跳过 @fontsource 产出的 .woff 回退版 (体积减半)
    .filter((f) => !f.path.endsWith(".woff"));
  if (!files.some((f) => f.path === "index.html")) {
    console.error(`[embed-web] ${DIST_DIR} 中缺少 index.html，构建产物不完整。`);
    process.exit(1);
  }

  const entries: string[] = [];
  let textBytes = 0;
  let binaryBytes = 0;

  for (const file of files) {
    const ext = extname(file.path).toLowerCase();
    const isHashed = /-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/.test(file.path) && file.path !== "index.html";
    const textMime = TEXT_MIME[ext];

    if (textMime) {
      const body = readFileSync(file.abs, "utf8");
      textBytes += body.length;
      entries.push(
        `  ${JSON.stringify("/" + file.path)}: { mime: ${JSON.stringify(textMime)}, immutable: ${isHashed}, body: ${JSON.stringify(body)} },`,
      );
    } else {
      const body = readFileSync(file.abs);
      binaryBytes += body.length;
      entries.push(
        `  ${JSON.stringify("/" + file.path)}: { mime: ${JSON.stringify(BINARY_MIME[ext] || "application/octet-stream")}, immutable: ${isHashed}, bodyB64: ${JSON.stringify(body.toString("base64"))} },`,
      );
    }
  }

  const banner = `// ⚠️ 本文件由 scripts/embed-web.ts 自动生成，请勿手工编辑。
// 源头: web/dist (vite build)。重新生成: bun run build:web

export interface EmbeddedAsset {
  readonly mime: string;
  /** 带 hash 的资源可长缓存 */
  readonly immutable: boolean;
  readonly body?: string;
  readonly bodyB64?: string;
}

export const EMBEDDED_UI: Readonly<Record<string, EmbeddedAsset>> = {
${entries.join("\n")}
};
`;

  mkdirSync(join(OUT_FILE, ".."), { recursive: true });
  writeFileSync(OUT_FILE, banner, "utf8");
  console.log(
    `[embed-web] 已内嵌 ${files.length} 个文件 (${(textBytes / 1024).toFixed(0)}KB 文本 + ${(binaryBytes / 1024).toFixed(0)}KB 二进制) → ${relative(process.cwd(), OUT_FILE)}`,
  );
}

main();
