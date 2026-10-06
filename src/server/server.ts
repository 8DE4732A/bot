import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { DatabaseStore } from "../config/database-store.ts";
import { getAgentWorkspaceDir } from "../config/env-paths.ts";
import { AgentManager } from "../core/agent-manager.ts";
import { ModelFactory } from "../core/model-factory.ts";
import { ChannelManager } from "../channels/manager.ts";
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
          // 值为掩码的字段由后端还原为已存凭据 (前端不持有明文)
          body.credentials = unmaskCredentials(
            body.credentials ?? {},
            this.store.getChannel(body.id)?.credentials ?? {},
          );
          this.store.saveChannel(body);
          this.sendJson(res, { success: true });
          return;
        }
        if (method === "DELETE" && this.handleDelete(url, res, (id) => this.store.deleteChannel(id))) {
          return;
        }
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
