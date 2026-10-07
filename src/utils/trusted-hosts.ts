import { networkInterfaces } from "node:os";

/** 信任主机集 (HTTP Host/Origin 与 WS Origin 共用, R8 simplify 收敛——
 *  此前 WS 侧独立复制且已漂移: 缺 [::1] 与本机网卡地址, 局域网模式下
 *  同一管理台 HTTP 正常而 WS 403)。信任集含 loopback 与本机全部网卡地址。 */
const TRUSTED_HOSTNAMES = new Set<string>(["127.0.0.1", "localhost", "::1", "[::1]"]);

// 本机全部网卡地址进信任集 (--host 0.0.0.0 局域网开放时, Host 是实际 IP)
for (const addrs of Object.values(networkInterfaces())) {
  for (const addr of addrs ?? []) {
    TRUSTED_HOSTNAMES.add(addr.address);
  }
}

export function isTrustedHostname(hostname: string): boolean {
  return TRUSTED_HOSTNAMES.has(hostname);
}

