/**
 * Web 管理后台端点的单一解析来源。
 *
 * `bot start --port/--host` 是**进程级覆盖**：只改变本次运行的监听地址，
 * 不写 system_config。跨进程消费者（TUI / `bot admin` / `bot status`）
 * 必须经 gateway.sock 的 `status` 应答发现实际端点，否则会一直连数据库
 * 里的旧端口（表现为 gateway 在线、TUI 却反复“连接断开”）。
 */

export interface WebEndpoint {
  host: string;
  port: number;
}

/** 只依赖 getConfig 的最小读取面（DatabaseStore 与测试 stub 共用） */
export interface WebConfigReader {
  getConfig(key: string, defaultValue?: string): string;
}

let runtimeEndpoint: WebEndpoint | undefined;

/** 记录本进程实际绑定的端点（Web 服务 listen 成功后调用）。 */
export function setRuntimeWebEndpoint(endpoint: WebEndpoint): void {
  runtimeEndpoint = { ...endpoint };
}

/** 测试用：清除进程内覆盖。 */
export function clearRuntimeWebEndpoint(): void {
  runtimeEndpoint = undefined;
}

/** 通配地址对客户端没有意义，统一拨回环。 */
export function connectableHost(host: string): string {
  const value = host.trim();
  if (!value || value === "0.0.0.0" || value === "::" || value === "[::]") return "127.0.0.1";
  return value;
}

/** URL 中的 IPv6 字面量必须加方括号。 */
export function formatHostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

export function formatWebUrl(endpoint: WebEndpoint): string {
  return `http://${formatHostForUrl(connectableHost(endpoint.host))}:${endpoint.port}`;
}

function isValidPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 65_535;
}

/** system_config 中的配置端点；非法端口回退 3000。 */
export function configuredWebEndpoint(store: WebConfigReader): WebEndpoint {
  const raw = Number.parseInt(store.getConfig("web_port", "3000"), 10);
  return {
    host: store.getConfig("web_host", "127.0.0.1"),
    port: isValidPort(raw) ? raw : 3000,
  };
}

/** 运行期覆盖优先，其次数据库配置。 */
export function runtimeOrConfiguredWebEndpoint(store: WebConfigReader): WebEndpoint {
  return runtimeEndpoint ? { ...runtimeEndpoint } : configuredWebEndpoint(store);
}

/**
 * 从 gateway `status` 应答解析实际端点；字段缺失或非法时回退配置。
 * 旧版本 gateway 没有 `webHost` 时同样走回退，保持向后兼容。
 */
export function resolveWebEndpoint(
  live: { webHost?: unknown; webPort?: unknown } | undefined,
  fallback: WebEndpoint,
): WebEndpoint {
  const liveHost = typeof live?.webHost === "string" ? live.webHost.trim() : "";
  const rawPort =
    typeof live?.webPort === "number"
      ? live.webPort
      : typeof live?.webPort === "string"
        ? Number(live.webPort)
        : NaN;
  return {
    host: connectableHost(liveHost || fallback.host),
    port: isValidPort(rawPort) ? rawPort : fallback.port,
  };
}
