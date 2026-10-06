import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * 进程内工具的统一远程访问守卫。
 * ASRT 网络白名单只覆盖 bash 子命令; fetch_url 等宿主进程内 fetch 是旁路,
 * 必须在此收紧: 仅允许公网 http/https, 拒绝回环/私网/链路本地/云元数据地址。
 */
const BLOCKED_HOSTNAMES = new Set([
  "metadata.google.internal",
  "metadata.goog",
  "metadata.azure.internal",
]);

function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // link-local (含云元数据 169.254.169.254)
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmark 198.18.0.0/15
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) return true;
  if (lower.startsWith("64:ff9b:")) return true; // NAT64 (可映射任意 IPv4, 含内网)
  if (lower.startsWith("2002:")) return true; // 6to4
  if (lower.startsWith("::ffff:")) return isPrivateIp(lower.slice(7));
  return false;
}

export async function assertSafeRemoteUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    // 不带原始 URL——平台下载 URL 可能内嵌凭据 (Telegram bot token)
    throw new Error("Invalid URL (unable to parse)");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Blocked non-HTTP URL scheme: ${url.protocol}`);
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new Error(`Blocked internal host: ${hostname}`);
  }
  if (isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error(`Blocked private address: ${hostname}`);
    return url;
  }
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    throw new Error(`Blocked internal host: ${hostname}`);
  }
  const resolved = await lookup(hostname, { all: true });
  if (resolved.length === 0) {
    throw new Error(`Cannot resolve host: ${hostname}`);
  }
  for (const { address } of resolved) {
    if (isPrivateIp(address)) {
      throw new Error(`Host ${hostname} resolves to a private address (${address}); blocked`);
    }
  }
  return url;
}

const MAX_REDIRECTS = 3;

/** 带 SSRF 校验的受限 fetch: 每一跳重定向都重新校验目标;
 * 跨源重定向时剥离 Authorization (认证头绝不跟随到跳转目标) */
export async function safeFetch(rawUrl: string, init?: RequestInit): Promise<Response> {
  let url = await assertSafeRemoteUrl(rawUrl);
  let headers: Record<string, string> | undefined;
  if (init?.headers) {
    // 兼容普通对象与 Headers 实例 (统一成对象便于跨源摘头)
    headers = init.headers instanceof Headers
      ? Object.fromEntries(init.headers.entries())
      : { ...(init.headers as Record<string, string>) };
  }
  for (let hop = 0; ; hop++) {
    const res = await fetch(url, { ...init, headers, redirect: "manual" });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      // 错误信息不带原始 URL——平台下载 URL 可能内嵌凭据 (Telegram bot token)
      if (hop >= MAX_REDIRECTS) throw new Error(`Too many redirects (>= ${MAX_REDIRECTS + 1}) following media/platform URL`);
      const next = await assertSafeRemoteUrl(new URL(location, url).toString());
      // 跳转目标 origin 变化 → 摘除 Authorization (最小暴露)
      if (headers && new URL(next).origin !== new URL(url).origin) {
        const { Authorization, authorization, ...rest } = headers;
        headers = rest;
      }
      url = next;
      continue;
    }
    return res;
  }
}
