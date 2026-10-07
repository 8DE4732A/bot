import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * gateway-token (四期 M0, 设计 §6.1): 注入式 session token。
 * 启动生成 (0600), serveStatic 出 HTML 时注入 window.__BOT_TOKEN__,
 * 前端 fetch 层统一附 header; API 校验用常量时间比较。
 * 保留 127.0.0.1 免密输入体验 (浏览器用户无感知), 挡住本机其他进程与
 * 恶意页面对管理 API (暴露 provider key) 的 no-cors 调用。
 */

export function gatewayTokenPath(cwd: string = process.cwd()): string {
  return join(cwd, ".bot", "gateway-token");
}

/** 读取或首次生成 gateway-token (0600); 内容为 base64url 随机 32 字节。
 *  已有文件也强制 chmod 自愈 (R1 评审 M1: 备份恢复/误放宽后不变式仍成立) */
export function loadOrCreateGatewayToken(cwd: string = process.cwd()): string {
  const path = gatewayTokenPath(cwd);
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8").trim();
    if (existing) {
      try {
        chmodSync(path, 0o600);
      } catch {}
      return existing;
    }
  }
  const token = randomBytes(32).toString("base64url");
  mkdirSync(join(cwd, ".bot"), { recursive: true });
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // chmod 失败 (如 Windows) 不阻塞启动: 文件本就以 0600 mode 创建
  }
  return token;
}

/** 常量时间比较 (防逐字节时序侧信道); 长度不等直接 false (不泄长度) */
export function tokensEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length || ba.length === 0) return false;
  return timingSafeEqual(ba, bb);
}
