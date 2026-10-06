import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import QRCode from "qrcode";
import { DatabaseStore } from "../config/database-store.ts";
import { getAgentWorkspaceDir } from "../config/env-paths.ts";
import { AgentManager } from "../core/agent-manager.ts";
import { ModelFactory } from "../core/model-factory.ts";
import { ChannelManager } from "../channels/manager.ts";
import { createChannelAdapter } from "../channels/factory.ts";
import { startQrLogin, pollQrStatus, extractQrCredentials, clearWeixinPersistedState } from "../channels/adapters/weixin.ts";
import { clearMediaCache } from "../channels/runtime/media-cache.ts";
import { McpBridge } from "../skills/mcp/bridge.ts";
import type { McpServerDefinition } from "../config/database-store.ts";
import { SkillRegistry } from "../skills/registry.ts";
import { loadCustomSkills } from "../skills/loader.ts";
import { logger } from "../utils/logger.ts";
import { EMBEDDED_UI } from "./ui/generated.ts";

/** Web Playground 的默认会话标识, 与 /api/chat 与 /api/chat/reset 共用 */
const playgroundSession = (agentId: string) => `web-playground:${agentId}`;

/** 内嵌二进制资源 (字体等) 的懒解码缓存: 每个资源只做一次 base64 → Buffer */
const binaryCache = new Map<string, Buffer>();

/** 允许出现在 Host / Origin 中的主机名 (防 DNS rebinding 与跨站写请求) */
const TRUSTED_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

// 本机全部网卡地址也在信任集内: --host 0.0.0.0 局域网开放时, Host 是实际 IP
for (const addrs of Object.values(networkInterfaces())) {
  for (const addr of addrs ?? []) {
    TRUSTED_HOSTNAMES.add(addr.address);
  }
}

function isTrustedHost(hostHeader: string | undefined, configuredHost: string): boolean {
  if (!hostHeader) return true; // 无 Host 的本机客户端 (curl/socket) 放行
  const hostname = hostHeader.replace(/:\d+$/, "");
  return TRUSTED_HOSTNAMES.has(hostname) || hostname === configuredHost;
}

function isTrustedOrigin(origin: string | undefined, configuredHost: string): boolean {
  if (!origin) return true; // 非浏览器客户端 (curl/工具) 不带 Origin
  try {
    const hostname = new URL(origin).hostname;
    return TRUSTED_HOSTNAMES.has(hostname) || hostname === configuredHost;
  } catch {
    return false;
  }
}

/** provider 响应脱敏: 永不回传明文 apiKey, 只给掩码与是否已配置 */
function maskProviderKey(p: ReturnType<DatabaseStore["listModelProviders"]>[number]) {
  const { apiKey, ...rest } = p;
  return {
    ...rest,
    apiKey: apiKey ? `••••${apiKey.slice(-4)}` : "",
    hasApiKey: Boolean(apiKey),
  };
}

const CREDENTIAL_MASK = "••••";

/** 渠道凭据脱敏: 字符串值统一掩码; 提交时值为掩码的字段由后端还原旧值 */
/** 渠道类型枚举 (与 factory CHANNEL_TYPES 对齐; terminal 由 CLI 管理) */
const CHANNEL_TYPE_KEYS = new Set(["wecom", "weixin", "qq", "feishu", "telegram"]);
/** 各渠道类型的 secret 凭据字段 (保存时清空/掩码 → 保留旧值; 非 secret 字段可显式清空) */
const SECRET_CREDENTIAL_KEYS: Record<string, string[]> = {
  feishu: ["appSecret"],
  qq: ["clientSecret"],
  wecom: ["secret"],
  weixin: ["token"],
  telegram: ["botToken"],
};

function maskCredentials(credentials: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(credentials ?? {})) {
    out[k] = typeof v === "string" && v.length > 0 ? CREDENTIAL_MASK : v;
  }
  return out;
}

function unmaskCredentials(next: Record<string, unknown>, previous: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(next ?? {})) {
    out[k] = v === CREDENTIAL_MASK && typeof previous[k] === "string" ? previous[k] : v;
  }
  return out;
}


/** MCP 表单载荷 → server 定义 (保存与连接测试共用同一套归一化与凭据还原) */
function normalizeMcpServerInput(
  body: any,
  previous: ReturnType<DatabaseStore["getMcpServer"]>,
): McpServerDefinition {
  return {
    id: typeof body.id === "string" ? body.id : String(body.id ?? ""),
    name: body.name || "test",
    transport: body.transport === "http" ? "http" : "stdio",
    command: body.command || undefined,
    args: Array.isArray(body.args) ? body.args : undefined,
    env: unmaskCredentials(body.env ?? {}, previous?.env ?? {}) as Record<string, string>,
    url: body.url || undefined,
    headers: unmaskCredentials(body.headers ?? {}, previous?.headers ?? {}) as Record<string, string>,
    description: body.description || undefined,
    exposure: body.exposure === "hidden" ? "hidden" : "direct",
    toolExposure: body.toolExposure && typeof body.toolExposure === "object" ? body.toolExposure : undefined,
    enabled: body.enabled !== false,
    updatedAt: Date.now(),
  };
}

function binaryFor(pathname: string, bodyB64: string): Buffer {
  let buf = binaryCache.get(pathname);
  if (!buf) {
    buf = Buffer.from(bodyB64, "base64");
    binaryCache.set(pathname, buf);
  }
  return buf;
}

export class AdminWebServer {
  private server: any;
  private port: number;
  private host: string;
  private store: DatabaseStore;
  constructor(port = 3000, host = "127.0.0.1") {
    this.port = port;
    this.host = host;
    this.store = new DatabaseStore();
  }

  public async start(): Promise<number> {
    return new Promise((resolve) => {
      this.server = createServer((req, res) => this.handleRequest(req, res));
      this.server.listen(this.port, this.host, () => {
        logger.info("WebServer", `Web Admin Dashboard running at http://${this.host}:${this.port}`);
        if (Object.keys(EMBEDDED_UI).length === 0) {
          logger.warn(
            "WebServer",
            "管理界面资源为空: 请先运行 `bun run build:web` 生成 src/server/ui/generated.ts",
          );
        }
        resolve(this.port);
      });
    });
  }

  public stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  /**
   * 静态资源服务: 管理后台 SPA (React/Vite 构建产物内嵌于 generated.ts)。
   * 带 hash 的资源长缓存, 其余 (index.html) 每次校验; 未命中路径回退到 index.html。
   */
  private serveStatic(pathname: string, res: ServerResponse, method: string): boolean {
    if (pathname.startsWith("/api")) return false;

    const isHead = method === "HEAD";
    const send = (mime: string, cacheControl: string, body: string | Buffer) => {
      res.writeHead(200, { "Content-Type": mime, "Cache-Control": cacheControl });
      res.end(isHead ? undefined : body);
    };

    const asset = EMBEDDED_UI[pathname];
    if (asset) {
      const cacheControl = asset.immutable
        ? "public, max-age=31536000, immutable"
        : "no-cache";
      const body = asset.bodyB64 ? binaryFor(pathname, asset.bodyB64) : asset.body!;
      send(asset.mime, cacheControl, body);
      return true;
    }

    const index = EMBEDDED_UI["/index.html"];
    if (index) {
      send(index.mime, "no-cache", index.body!);
      return true;
    }

    // 资源未构建: 给出可操作的提示页
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      `<!doctype html><meta charset="utf-8"><title>Bot 控制台</title>` +
        `<body style="font-family:ui-monospace,monospace;background:#f6f6f4;color:#1b1c1e;display:grid;place-items:center;height:100vh;margin:0">` +
        `<div style="text-align:center"><div style="letter-spacing:.14em;font-size:.72rem;color:#8f929a">UI NOT BUILT</div>` +
        `<h1 style="font-size:1.1rem;margin:10px 0">管理界面尚未构建</h1>` +
        `<p style="color:#565860">在项目根目录运行 <code style="background:#f1f1ee;padding:2px 6px;border-radius:4px">bun run build:web</code> 后重启服务。</p></div></body>`,
    );
    return true;
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;
    const method = req.method?.toUpperCase();

      // 3b-前置. Channel webhook 转发: /api/channel-webhook/<channelId>
      // 在管理台 Host/Origin 校验之前分发——回调方是外部服务器 (无浏览器 CSRF 面),
      // 真伪由渠道适配器的签名验签负责, 回调域名本来就是渠道自己的配置项
      if (pathname.startsWith("/api/channel-webhook/")) {
        const channelId = decodeURIComponent(pathname.slice("/api/channel-webhook/".length));
        const adapter = ChannelManager.getInstance().getAdapter(channelId);
        if (!adapter?.handleWebhook) {
          this.sendError(res, 404, `No webhook-capable channel '${channelId}'`);
          return;
        }
        let rawBody: string;
        try {
          rawBody = await this.readBody(req);
        } catch {
          this.sendError(res, 413, "Payload too large");
          return;
        }
        try {
          const result = await adapter.handleWebhook(pathname, url.searchParams, rawBody);
          res.writeHead(result.status, {
            "Content-Type": result.contentType ?? "text/plain; charset=utf-8",
          });
          res.end(result.body);
        } catch (err: any) {
          logger.error("WebServer", `Webhook error for channel ${channelId}:`, err);
          this.sendError(res, 500, err?.message || "Webhook failed");
        }
        return;
      }

    // NOTE: no CORS headers on purpose, but absence of CORS alone does not stop
    // cross-site form POSTs or DNS rebinding — validate Host/Origin explicitly.
    if (!isTrustedHost(req.headers.host, this.host) ||
        !isTrustedOrigin(req.headers.origin, this.host)) {
      this.sendError(res, 403, "Forbidden host/origin");
      return;
    }

    try {
      // 1. Dashboard UI (static assets + SPA fallback)
      if ((method === "GET" || method === "HEAD") && this.serveStatic(pathname, res, method)) {
        return;
      }

      // 2. Status API
      if (pathname === "/api/status" && method === "GET") {
        const agents = this.store.listAgents();
        const channels = this.store.listChannels();
        const providers = this.store.listModelProviders();
        const auditLogs = this.store.listAuditLogs(10);
        this.sendJson(res, {
          uptime: Math.floor(process.uptime()),
          cwd: process.cwd(),
          platform: process.platform,
          stats: {
            agentsCount: agents.length,
            channelsCount: channels.length,
            providersCount: providers.length,
            auditCount: auditLogs.length,
          },
          memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        });
        return;
      }

      // 3. System Config API
      if (pathname === "/api/config") {
        if (method === "GET") {
          this.sendJson(res, this.store.getAllConfigs());
          return;
        }
        if (method === "POST") {
          const body = await this.readJsonBody(req);
          if (body.key && body.value !== undefined) {
            this.store.setConfig(body.key, String(body.value));
            this.sendJson(res, { success: true });
          } else {
            this.sendError(res, 400, "Missing key or value");
          }
          return;
        }
      }


      // 4. BYOK Model Providers API (响应不回传明文 apiKey)
      if (pathname === "/api/providers") {
        if (method === "GET") {
          this.sendJson(res, this.store.listModelProviders().map(maskProviderKey));
          return;
        }
        if (method === "POST") {
          const body = await this.readJsonBody(req);
          if (!body.id || !body.name || !body.apiBase) {
            this.sendError(res, 400, "id, name, and apiBase are required");
            return;
          }
          // apiKey 留空表示保留已存密钥 (脱敏响应下前端不持有明文)
          const apiKey = body.apiKey || this.store.getModelProvider(body.id)?.apiKey || "";
          this.store.saveModelProvider({
            id: body.id,
            name: body.name,
            protocol: body.protocol || "openai-completions",
            apiBase: body.apiBase,
            apiKey,
            models: Array.isArray(body.models) ? body.models : [],
            createdAt: body.createdAt || Date.now(),
            updatedAt: Date.now(),
          });
          AgentManager.getInstance().reloadModels();
          this.sendJson(res, { success: true });
          return;
        }
        if (method === "DELETE" &&
          this.handleDelete(url, res, (id) => {
            this.store.deleteModelProvider(id);
            AgentManager.getInstance().reloadModels();
          })
        ) {
          return;
        }
      }

      // 5. Fetch Remote Models API
      if (pathname === "/api/providers/fetch-models" && method === "POST") {
        const body = await this.readJsonBody(req);
        if (!body.apiBase) {
          this.sendError(res, 400, "apiBase is required");
          return;
        }
        // 编辑已有服务商时前端不持有明文 key。从库中补全的 key 只允许发往
        // 该 provider 已存储的 apiBase——否则管理 API 就是"把密钥发往任意
        // URL"的外带通道。目标变更时要求请求方显式提供 key。
        let apiKey = body.apiKey || "";
        const stored = body.providerId ? this.store.getModelProvider(body.providerId) : undefined;
        if (!apiKey && stored) {
          if (stored.apiBase === body.apiBase) apiKey = stored.apiKey;
          else {
            this.sendError(res, 400, "apiBase differs from the stored provider; provide the API key explicitly");
            return;
          }
        }
        this.store.recordAudit("provider.fetch_models", { apiBase: body.apiBase, providerId: body.providerId || null });
        const result = await ModelFactory.fetchRemoteModels(body.apiBase, apiKey);
        this.sendJson(res, result);
        return;
      }

      // 6. Test Model Connection API
      if (pathname === "/api/providers/test" && method === "POST") {
        const body = await this.readJsonBody(req);
        if (!body.modelId) {
          this.sendError(res, 400, "modelId is required");
          return;
        }
        // 与 fetch-models 同样的密钥外带防护: 未显式提供 key 时只允许测
        // 该 provider 已存储的 apiBase (库补 key 的前提)
        if (!body.apiKey && body.providerId) {
          const stored = this.store.getModelProvider(body.providerId);
          if (stored?.apiKey && body.apiBase && stored.apiBase !== body.apiBase) {
            this.sendError(res, 400, "apiBase differs from the stored provider; provide the API key explicitly");
            return;
          }
        }
        this.store.recordAudit("provider.test", {
          apiBase: body.apiBase || null,
          providerId: body.providerId || null,
          modelId: body.modelId,
        });
        const result = await ModelFactory.testConnection(
          body.providerId || "custom",
          body.modelId,
          body.apiBase,
          body.apiKey,
          body.protocol || "openai-completions",
        );
        this.sendJson(res, result);
        return;
      }

      // 7. Agents API
      if (pathname === "/api/agents") {
        if (method === "GET") {
          this.sendJson(res, this.store.listAgents());
          return;
        }
        if (method === "POST") {
          const body = await this.readJsonBody(req);
          if (!body.id || !body.name) {
            this.sendError(res, 400, "id and name are required");
            return;
          }
          if (!body.model?.provider || !body.model?.modelId) {
            this.sendError(res, 400, "model.provider and model.modelId are required");
            return;
          }
          if (!body.workspaceDir) {
            body.workspaceDir = getAgentWorkspaceDir(body.id);
          }
          this.store.saveAgent(body);
          AgentManager.getInstance().reloadModels();
          this.sendJson(res, { success: true });
          return;
        }
        if (method === "DELETE" && this.handleDelete(url, res, (id) => this.store.deleteAgent(id))) {
          return;
        }
      }

      // 8. Channels API
      if (pathname === "/api/channels") {
        if (method === "GET") {
          this.sendJson(
            res,
            this.store.listChannels().map((c) => ({ ...c, credentials: maskCredentials(c.credentials) })),
          );
          return;
        }
        if (method === "POST") {
          const body = await this.readJsonBody(req);
          if (!body.id || !body.name || !body.type || !body.boundAgentId) {
            this.sendError(res, 400, "id, name, type, and boundAgentId are required");
            return;
          }
          // type 必须是已注册的渠道类型 (terminal 只允许编辑既有实例——
          // 它由 CLI 管理, 新建无意义, 但绑定 Agent 的修改必须可达)
          const existingForType = this.store.getChannel(body.id);
          if (!CHANNEL_TYPE_KEYS.has(body.type) && body.type !== "terminal") {
            this.sendError(res, 400, `unknown channel type: ${body.type}`);
            return;
          }
          if (body.type === "terminal" && !existingForType) {
            this.sendError(res, 400, "terminal channels are managed by the CLI and cannot be created here");
            return;
          }
          body.enabled = body.enabled !== false;
          if (!this.store.getAgent(body.boundAgentId)) {
            this.sendError(res, 400, `bound agent '${body.boundAgentId}' does not exist`);
            return;
          }
          const previous = this.store.getChannel(body.id);
          // 已有渠道禁止改 type (跨类型凭据合并会互相污染)
          if (previous && previous.type !== body.type) {
            this.sendError(res, 400, `channel '${body.id}' type cannot be changed (${previous.type} → ${body.type})`);
            return;
          }
          // secret 字段: 值为掩码或被清空都保留旧值 (凭据是连接的关键机密,
          // 清空即删会静默断连——删除渠道重建才是显式路径);
          // 非 secret 字段按提交值覆盖 (显式可清空)
          const prevCreds = previous?.credentials ?? {};
          const merged: Record<string, unknown> = { ...prevCreds };
          const nextCreds = unmaskCredentials(body.credentials ?? {}, prevCreds);
          for (const k of Object.keys(merged)) {
            if (SECRET_CREDENTIAL_KEYS[body.type]?.includes(k)) continue;
            if (!(k in nextCreds)) delete merged[k];
          }
          for (const [k, v] of Object.entries(nextCreds)) {
            // secret 字段空字符串提交 = 保旧 (与前端清空删 key 的语义一致)
            if (SECRET_CREDENTIAL_KEYS[body.type]?.includes(k) && v === "") continue;
            merged[k] = v;
          }
          body.credentials = merged;
          this.store.saveChannel(body);

          // 生命周期统一入口: 热替换/停用走带单飞锁的 restartChannel
          // (terminal 由 CLI 特殊管理, restartChannel 内部跳过)
          const epoch = (this.channelConfigEpoch.get(body.id) ?? 0) + 1;
          try {
            await this.restartChannel(body.id, epoch);
          } catch (err) {
            this.sendError(res, 500, `channel saved but adapter start failed: ${err instanceof Error ? err.message : err}`);
            return;
          }
          this.store.recordAudit("channel.saved", { channelId: body.id, type: body.type, enabled: body.enabled });
          this.sendJson(res, { success: true });
          return;
        }
        if (method === "DELETE") {
          const handled = await this.handleDeleteAsync(url, res, (id) => this.deleteChannelFully(id));
          if (handled) return;
        }
      }

      // 8b. 渠道健康检查 (adapter.healthCheck, 管理台渠道卡片)
      if (/^\/api\/channels\/[^/]+\/health$/.test(pathname) && method === "GET") {
        const channelId = decodeURIComponent(pathname.split("/")[3]);
        const adapter = ChannelManager.getInstance().getAdapter(channelId);
        if (!adapter) {
          this.sendError(res, 404, `Channel '${channelId}' is not running`);
          return;
        }
        // 未实现 healthCheck 的 adapter 不能默认健康 (可能已断线/过期);
        // 终端是本地常驻例外
        const health = adapter.healthCheck
          ? await adapter.healthCheck().catch((err) => ({ ok: false, detail: String(err) }))
          : adapter.type === "terminal"
            ? { ok: true, detail: "local terminal" }
            : { ok: false, detail: "unknown (no health check implemented)" };
        this.sendJson(res, health);
        return;
      }

      // 8c. 微信 iLink 扫码登录 (POST 发起 → 前端展示二维码链接 → GET 轮询状态;
      // confirmed 时凭据自动并入渠道 credentials 并热重启 adapter)
      // 仅对 weixin 类型渠道开放 (防止把 iLink 凭据写进其他渠道)
      if (/^\/api\/channels\/[^/]+\/qr-login$/.test(pathname) && method === "POST") {
        const channelId = decodeURIComponent(pathname.split("/")[3]);
        const channel = this.store.getChannel(channelId);
        if (!channel || channel.type !== "weixin") {
          this.sendError(res, 400, "QR login is only available for weixin channels");
          return;
        }
        if (!channel.enabled) {
          this.sendError(res, 400, "channel is disabled; enable it before QR login");
          return;
        }
        try {
          const qr = await startQrLogin();
          // liteapp URL 编码为二维码图 (桌面管理台可直接扫码)
          const dataUrl = await QRCode.toDataURL(qr.qrcodeImgContent || qr.qrcode, { margin: 1 });
          this.sendJson(res, { ...qr, dataUrl });
        } catch (err) {
          this.sendError(res, 502, `iLink QR request failed: ${err instanceof Error ? err.message : err}`);
        }
        return;
      }
      if (/^\/api\/channels\/[^/]+\/qr-status$/.test(pathname) && method === "GET") {
        const channelId = decodeURIComponent(pathname.split("/")[3]);
        const qrcode = url.searchParams.get("qrcode");
        const redirectHost = url.searchParams.get("redirect_host");
        if (!qrcode) {
          this.sendError(res, 400, "qrcode is required");
          return;
        }
        const channel = this.store.getChannel(channelId);
        if (!channel || channel.type !== "weixin") {
          this.sendError(res, 400, "QR login is only available for weixin channels");
          return;
        }
        if (!channel.enabled) {
          this.sendError(res, 400, "channel is disabled");
          return;
        }
        try {
          // scaned_but_redirect 携带 redirect_host: 后续轮询必须切到新 host
          // (平台迁移轮询端点, 忽略它登录永远无法确认)
          const statusResp = await pollQrStatus(qrcode, undefined, redirectHost || undefined);
          if (statusResp.status === "confirmed") {
            const creds = extractQrCredentials(statusResp);
            // 锁内重读→写库→重启 (QR 轮询等待期间的旧快照不得覆盖并发修改,
            // 更不能复活已删除的渠道)
            const qrEpoch = (this.channelConfigEpoch.get(channelId) ?? 0) + 1;
            await this.withChannelLock(channelId, async () => {
              const fresh = this.store.getChannel(channelId);
              if (!fresh || fresh.type !== "weixin" || !fresh.enabled) return;
              this.store.saveChannel({
                ...fresh,
                credentials: {
                  ...fresh.credentials,
                  token: creds.token,
                  accountId: creds.accountId,
                  baseUrl: creds.baseUrl,
                },
                updatedAt: Date.now(),
              });
              this.channelConfigEpoch.set(channelId, qrEpoch);
              await this.doRestartChannel(channelId);
            });
            logger.info("WebServer", `Weixin channel '${channelId}' authenticated via QR scan (account=${creds.accountId})`);
            this.store.recordAudit("channel.weixin_qr_login", { channelId, accountId: creds.accountId });
          }
          this.sendJson(res, {
            status: statusResp.status,
            // scaned_but_redirect: 前端后续轮询必须带回来这个 host
            redirectHost: typeof statusResp.redirect_host === "string" ? statusResp.redirect_host : undefined,
          });
        } catch (err) {
          this.sendError(res, 502, `iLink QR status failed: ${err instanceof Error ? err.message : err}`);
        }
        return;
      }

      // 9. Skills API (三类统一: extension / skill / mcp; 文档型附正文预览)
      if (pathname === "/api/skills" && method === "GET") {
        const skills = SkillRegistry.getInstance().listSkills().map((s) => ({
          id: s.id,
          name: s.name,
          description: s.description,
          category: s.category,
          builtin: s.builtin,
          kind: s.kind,
          toolCount: s.extension.tools?.length ?? 0,
          ...(s.document
            ? {
                location: s.document.location,
                bodyPreview: s.document.body.slice(0, 400),
                warnings: s.document.warnings,
                disableModelInvocation: s.document.disableModelInvocation,
              }
            : {}),
        }));
        this.sendJson(res, skills);
        return;
      }

      // 9b-2. 技能热刷新: 重扫 .bot/skills 并 reconcile durable registry——
      // 只改 SkillRegistry 是"假成功" (模型可用性由 AgentManager 的 registry 决定)
      if (pathname === "/api/skills/reload" && method === "POST") {
        const diff = await loadCustomSkills();
        const agentManager = AgentManager.getInstance();
        for (const ext of diff.upserted) agentManager.installExtension(ext);
        for (const name of diff.removed) agentManager.uninstallExtension(name);
        await McpBridge.getInstance().sync(this.store);
        this.store.recordAudit("skills.reloaded", {
          upserted: diff.upserted.map((e) => e.name),
          removed: diff.removed,
        });
        this.sendJson(res, {
          success: true,
          upserted: diff.upserted.map((e) => e.name),
          removed: diff.removed,
          ...(diff.codeReloadLimited
            ? { note: "tool skill code changed but requires a restart (ESM module cache)" }
            : {}),
        });
        return;
      }

      // 9b. MCP Servers API (凭据语义同渠道: headers/env 响应掩码, 掩码值提交还原)
      if (pathname === "/api/mcp-servers") {
        if (method === "GET") {
          this.sendJson(
            res,
            this.store.listMcpServers().map((s) => ({
              ...s,
              env: maskCredentials(s.env ?? {}),
              headers: maskCredentials(s.headers ?? {}),
            })),
          );
          return;
        }
        if (method === "POST") {
          const body = await this.readJsonBody(req);
          if (!body.id || !body.name || !body.transport) {
            this.sendError(res, 400, "id, name, and transport are required");
            return;
          }
          // id 进入工具名 mcp__<id>__ 与连接缓存 key——必须是字符串且只允许安全字符
          // (NUL 曾造成 closeServerClients 前缀碰撞; JSON number 会被 String() 掩盖)
          if (typeof body.id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(body.id)) {
            this.sendError(res, 400, "id must be a string containing only letters, digits, '_' and '-'");
            return;
          }
          if (body.transport === "stdio" && !body.command) {
            this.sendError(res, 400, "stdio transport requires command");
            return;
          }
          if (body.transport === "http" && !body.url) {
            this.sendError(res, 400, "http transport requires url");
            return;
          }
          this.store.saveMcpServer(normalizeMcpServerInput(body, this.store.getMcpServer(body.id)));
          this.store.recordAudit("mcp.server_saved", { serverId: body.id, transport: body.transport });
          // registry 重装即刻生效 (会话按名字解析扩展); 返回连接状态供前端展示
          const syncResults = await McpBridge.getInstance().sync(this.store);
          const mine = syncResults.find((r) => r.serverId === body.id);
          this.sendJson(res, {
            success: true,
            ok: mine?.ok ?? true,
            toolCount: mine?.toolCount ?? 0,
            warnings: mine?.warnings ?? [],
          });
          return;
        }
        if (
          method === "DELETE" &&
          this.handleDelete(url, res, (id) => {
            this.store.deleteMcpServer(id);
            this.store.recordAudit("mcp.server_deleted", { serverId: id });
          })
        ) {
          await McpBridge.getInstance().sync(this.store);
          return;
        }
      }

      // 9c. MCP 连接测试 (不落库不装扩展)
      if (pathname === "/api/mcp-servers/test" && method === "POST") {
        const body = await this.readJsonBody(req);
        // 已存 server 的 headers/env 掩码值在此还原后再试连
        const server = normalizeMcpServerInput(
          { ...body, id: body.id || "test" },
          body.id ? this.store.getMcpServer(body.id) : undefined,
        );
        this.store.recordAudit("mcp.server_test", { serverId: server.id, transport: server.transport });
        this.sendJson(res, await McpBridge.getInstance().testServer(server));
        return;
      }

      // 10. Scheduled Tasks API (管理台视角: 全部 Agent 的任务; 删除为逻辑删除)
      if (pathname === "/api/scheduled-tasks") {
        if (method === "GET") {
          this.sendJson(res, this.store.listScheduledTasks());
          return;
        }
        if (method === "DELETE" && this.handleDelete(url, res, (id) => {
          this.store.softDeleteScheduledTask(id);
          this.store.recordAudit("scheduler.task_deleted", { taskId: id, via: "admin" });
        })) {
          return;
        }
      }

      // 11. Audit Logs API
      if (pathname === "/api/audit-logs" && method === "GET") {
        const logs = this.store.listAuditLogs(100);
        this.sendJson(res, logs);
        return;
      }

      // 11. Chat API (Web Playground)
      if (pathname === "/api/chat" && method === "POST") {
        const body = await this.readJsonBody(req);
        const { agentId, message, sessionId } = body;
        if (!agentId || !message) {
          this.sendError(res, 400, "agentId and message are required");
          return;
        }

        const effectiveSessionId = sessionId || playgroundSession(agentId);
        const agentManager = AgentManager.getInstance();

        if (req.headers.accept?.includes("text/event-stream")) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });

          let finished = false;
          try {
            // Bun 下 req 的 "close" 不因客户端断开而触发, 监听响应侧;
            // 正常完成后 close 也会触发 (writableEnded), 不得误中止下一轮
            res.on("close", () => {
              if (!finished && !res.writableEnded) {
                void AgentManager.getInstance().abortSession(agentId, effectiveSessionId);
              }
            });
            await agentManager.chat(
              agentId,
              effectiveSessionId,
              message,
              (chunk) => {
                res.write(`data: ${JSON.stringify(chunk)}\n\n`);
              },
            );
            res.write(`data: [DONE]\n\n`);
          } catch (err: any) {
            res.write(`data: ${JSON.stringify({ error: err?.message || String(err) })}\n\n`);
          } finally {
            finished = true;
            res.end();
          }
          return;
        }

        try {
          const answer = await agentManager.chat(
            agentId,
            effectiveSessionId,
            message,
          );
          this.sendJson(res, { success: true, answer });
        } catch (err: any) {
          this.sendError(res, 500, err?.message || "Chat failed");
        }
        return;
      }

      // 12. Reset Session API
      if (pathname === "/api/chat/reset" && method === "POST") {
        const body = await this.readJsonBody(req);
        const { agentId, sessionId } = body;
        const targetAgentId = agentId || "agent-default";
        const effectiveSessionId = sessionId || playgroundSession(targetAgentId);
        await AgentManager.getInstance().resetSession(targetAgentId, effectiveSessionId);
        this.sendJson(res, { success: true });
        return;
      }

      this.sendError(res, 404, "Not Found");
    } catch (err: any) {
      logger.error("WebServer", "Request error:", err);
      this.sendError(res, 500, err?.message || "Internal Server Error");
    }
  }

  /** 统一处理 DELETE ?id=... 的样板 (异步删除: 响应等待回收完成, 防幽灵行) */
  private handleDeleteAsync(url: URL, res: ServerResponse, del: (id: string) => Promise<void>): Promise<boolean> {
    return (async () => {
      const id = url.searchParams.get("id");
      if (!id) {
        this.sendError(res, 400, "id is required");
        return true;
      }
      await del(id);
      this.sendJson(res, { success: true });
      return true;
    })();
  }

  /** 统一处理 DELETE ?id=... 的样板; 返回是否已响应 */
  private handleDelete(url: URL, res: ServerResponse, del: (id: string) => void): boolean {
    const id = url.searchParams.get("id");
    if (!id) {
      this.sendError(res, 400, "id is required");
      return true;
    }
    del(id);
    this.sendJson(res, { success: true });
    return true;
  }

  /** 配置代际计数: 每次保存/扫码确认自增, 重启后比对防并发保存被单飞吞掉 */
  private channelConfigEpoch = new Map<string, number>();
  /** per-channel 互斥锁: restart 与 delete 共享同一临界区 (防交叉产生僵尸渠道) */
  private channelLocks = new Map<string, Promise<void>>();

  private async withChannelLock<T>(channelId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.channelLocks.get(channelId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    this.channelLocks.set(channelId, prev.then(() => gate));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private async restartChannel(channelId: string, epoch: number): Promise<void> {
    await this.withChannelLock(channelId, async () => {
      if (!this.store.getChannel(channelId)) return; // 渠道已删除
      this.channelConfigEpoch.set(channelId, epoch); // 登记代际 (审计/诊断用)
      // 单次重启即可: 拿到锁后才重读配置, 任何并发保存都在等锁之前完成了
      // 落库——本次 doRestart 读到的就是最新配置, 无需循环收敛
      // (循环写法在旧代际调用方遇到新代际时会活锁, 已废弃)
      await this.doRestartChannel(channelId);
    });
  }

  private async doRestartChannel(channelId: string): Promise<void> {
    const manager = ChannelManager.getInstance();
    const config = this.store.getChannel(channelId);
    // terminal 由 CLI 特殊管理 (工厂无法重建), 热替换跳过——
    // 与 startAll 的特判保持同一不变量, 否则管理台保存一次就杀死 REPL
    if (config?.type === "terminal") return;
    const old = manager.getAdapter(channelId);
    if (old) {
      await old.stop().catch(() => {});
      manager.unregister(channelId);
    }
    if (config?.enabled) {
      const adapter = createChannelAdapter(config);
      if (adapter) {
        manager.register(adapter);
        try {
          await adapter.start();
        } catch (err) {
          // start 失败不留僵尸注册 (管理台健康检查/通知寻址都依赖 adapters 表)
          manager.unregister(channelId);
          logger.error("WebServer", `Channel '${channelId}' start failed:`, err);
          this.store.recordAudit("channel.start_failed", { channelId, error: String(err) });
          throw err;
        }
      }
    }
  }

  /** 渠道完整删除: 与热替换共用同一 per-channel 临界区 (防交叉产生僵尸渠道) */
  private async deleteChannelFully(id: string): Promise<void> {
    await this.withChannelLock(id, async () => {
      const manager = ChannelManager.getInstance();
      const config = this.store.getChannel(id);
      // 保留项保护必须前置: store.deleteChannel 对 terminal-main 会抛错,
      // 但那是在 stop/unregister 之后——终端 REPL 会先被杀死 (与 startAll
      // 的 terminal 特判同一条不变量)
      if (id === "terminal-main" || config?.type === "terminal") {
        throw new Error("terminal channel cannot be deleted via API");
      }
      const adapter = manager.getAdapter(id);
      if (adapter) {
        await adapter.stop().catch(() => {});
        manager.unregister(id);
      }
      await clearMediaCache(id);
      // 微信持久化凭据/游标删除 (防同 accountId 重建渠道时旧 token 复活)
      if (config?.type === "weixin") {
        clearWeixinPersistedState(
          typeof config.credentials?.accountId === "string" ? config.credentials.accountId : undefined,
        );
      }
      this.store.deleteChannel(id);
      this.channelConfigEpoch.delete(id); // 待重启循环感知删除态 (restart 首行 getChannel 兜底)
      this.store.recordAudit("channel.deleted", { channelId: id });
    });
  }

  private sendJson(res: ServerResponse, data: unknown): void {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(data));
  }

  private sendError(res: ServerResponse, code: number, message: string): void {
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: message }));
  }

  private readBody(req: IncomingMessage): Promise<string> {
    const MAX_BODY = 1 << 20; // 1MB: 请求体上限, webhook 公网开放后是内存 DoS 面
    return new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (chunk) => {
        data += chunk;
        if (data.length > MAX_BODY) {
          req.destroy();
          reject(new Error("Payload too large"));
        }
      });
      req.on("end", () => resolve(data));
      req.on("error", reject);
    });
  }

  private async readJsonBody(req: IncomingMessage): Promise<any> {
    const data = await this.readBody(req);
    if (!data) return {};
    try {
      return JSON.parse(data);
    } catch {
      throw new Error("Invalid JSON body");
    }
  }
}
