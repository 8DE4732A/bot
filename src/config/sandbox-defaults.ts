import type { BotSandboxConfig } from "./database-store.ts";

/**
 * 子进程最小环境白名单——单一真相源, 两条路线共用:
 * - 沙盒 bash (execution-env 的 inheritEnv:false)
 * - MCP stdio server 子进程 (bridge)
 * 漂移有实际后果: 抄漏 SSL_CERT_FILE 会让企业根证书环境的 TLS 握手静默失败。
 */
export const CHILD_PROCESS_ENV_ALLOW = [
  "PATH", "HOME", "USER", "SHELL", "TERM", "TMPDIR", "LANG", "TZ", "LC_ALL", "SSL_CERT_FILE",
];

/** 从白名单构造子进程 env (宿主 process.env 中存在的才带) */
export function buildChildProcessEnv(extra?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of CHILD_PROCESS_ENV_ALLOW) {
    const value = process.env[key];
    if (value !== undefined) out[key] = value;
  }
  if (extra) Object.assign(out, extra);
  return out;
}

/**
 * 新建 Agent 的沙盒默认规则 (单一数据源):
 * migrations.ts 的种子数据与 Web 表单的新建初值共用此函数, 防止两处漂移。
 */
export function defaultSandbox(workspaceDir?: string): BotSandboxConfig {
  const workspace = workspaceDir || ".";
  return {
    enabled: true,
    network: {
      allowedDomains: [
        "github.com",
        "*.github.com",
        "api.github.com",
        "npmjs.org",
        "*.npmjs.org",
        "registry.npmjs.org",
      ],
      deniedDomains: [],
      // 默认不允许沙盒内 bash 连接 localhost——免密管理 API 就在本机回环,
      // 放行本地回环 = agent 可直连管理 API 读配置/当出网代理。需要本地
      // 端口绑定的 Agent (如本地开发服务) 显式开启
      allowLocalBinding: false,
    },
    filesystem: {
      allowWrite: [workspace, "/tmp"],
      denyRead: ["~/.ssh", "~/.aws", "~/.gnupg", ".env*"],
      denyWrite: [".git", "*.pem", "*.key"],
    },
  };
}

const strArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/**
 * 防御性归一化: 历史数据或前端提交可能缺字段 (PathGuard/ASRT 会对
 * undefined 数组抛 TypeError, 导致该 Agent 全部工具失效)。
 * 读侧与写侧统一经过这里, 保证任何存量库里的配置都是完整结构。
 * 缺省语义 fail-closed: sandbox 缺失视为"开启", allowLocalBinding 缺省 false。
 */
export function normalizeSandbox(raw: unknown): BotSandboxConfig {
  const r = (raw ?? {}) as Partial<BotSandboxConfig>;
  return {
    enabled: r.enabled ?? true,
    network: {
      allowedDomains: strArray(r.network?.allowedDomains),
      deniedDomains: strArray(r.network?.deniedDomains),
      allowLocalBinding: r.network?.allowLocalBinding ?? false,
    },
    filesystem: {
      allowWrite: strArray(r.filesystem?.allowWrite),
      denyRead: strArray(r.filesystem?.denyRead),
      denyWrite: strArray(r.filesystem?.denyWrite),
    },
  };
}
