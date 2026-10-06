import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import type { McpServerDefinition } from "../../config/database-store.ts";
import { DatabaseStore } from "../../config/database-store.ts";
import { buildChildProcessEnv } from "../../config/sandbox-defaults.ts";
import { logger } from "../../utils/logger.ts";
import { DESCRIPTION_MAX_CHARS, truncateMiddleBytes } from "../document-skills.ts";
import { SkillRegistry } from "../registry.ts";
import { AgentManager } from "../../core/agent-manager.ts";

/** callTool 超时 (progress 重置语义简化为绝对超时) */
const TOOL_TIMEOUT_MS = 60_000;

/** 工具结果进入上下文的字节上限 (对齐 pi 的 MCP_OUTPUT_MAX_BYTES) */
const MCP_OUTPUT_MAX_BYTES = 20 * 1024;

/** 工具名长度上限 (对齐 pi 的 MAX_TOOL_NAME_LENGTH) */
const MAX_TOOL_NAME_LENGTH = 64;

/** 连接失败的 server 的重试间隔 */
const RETRY_INTERVAL_MS = 60_000;



/** 工具名段净化 (mcp__<server>__<tool>) */
function sanitizeSegment(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * 全局唯一工具名 (对齐 pi createMcpToolName 语义):
 * 净化 + 长度截断 + 冲突加 sha256 前 8 位; taken 为跨 server 的全局集合。
 */
export function createMcpToolName(serverId: string, toolName: string, taken: Set<string>): string {
  const base = `mcp__${sanitizeSegment(serverId)}__${sanitizeSegment(toolName)}`;
  let name = base;
  if (taken.has(name) || name.length > MAX_TOOL_NAME_LENGTH) {
    const hash = createHash("sha256").update(`${serverId}:${toolName}`).digest("hex").slice(0, 8);
    name = `${base.slice(0, MAX_TOOL_NAME_LENGTH - hash.length - 1)}_${hash}`;
  }
  taken.add(name);
  return name;
}

/** per-tool 暴露判定: 精确名优先于通配模式 */
export function resolveToolExposure(
  server: McpServerDefinition,
  toolName: string,
): "direct" | "hidden" {
  const map = server.toolExposure ?? {};
  if (map[toolName]) return map[toolName];
  for (const [pattern, exposure] of Object.entries(map)) {
    if (!pattern.includes("*")) continue;
    const re = new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
    if (re.test(toolName)) return exposure;
  }
  return "direct";
}

function truncate(text: string): string {
  return text.length > DESCRIPTION_MAX_CHARS ? text.slice(0, DESCRIPTION_MAX_CHARS) + "…" : text;
}

/** MCP 工具结果 → durable 工具输出 (text 拼接 + structuredContent 附 JSON, 20KB 截断) */
function formatCallResult(result: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const item of (result.content as any[]) ?? []) {
    if (item?.type === "text" && typeof item.text === "string") parts.push(item.text);
    else parts.push(JSON.stringify(item));
  }
  if (result.structuredContent !== undefined) {
    parts.push(`[structured] ${JSON.stringify(result.structuredContent)}`);
  }
  if (result.isError === true) parts.push("[mcp tool reported an error]");
  return truncateMiddleBytes(parts.join("\n") || "(empty result)", MCP_OUTPUT_MAX_BYTES);
}

/** 配置指纹: 连接缓存的 key 成分——配置变化必须重建连接 (pi 的 entry 绑定语义) */
function configFingerprint(server: McpServerDefinition): string {
  const stable = JSON.stringify([
    server.transport,
    server.command ?? null,
    server.args ?? null,
    server.env ?? null,
    server.url ?? null,
    server.headers ?? null,
  ]);
  return createHash("sha256").update(stable).digest("hex").slice(0, 16);
}

export interface McpSyncResult {
  serverId: string;
  ok: boolean;
  toolCount: number;
  warnings: string[];
}

/**
 * MCP server → durable Extension 桥接 (参照 pi coding-agent extensions/mcp/runtime.ts
 * 的连接生命周期语义, 基于 MCP 官方 SDK 实现):
 * - 连接缓存 key = serverId + 配置指纹: 配置变化必然 miss, 旧连接被关闭淘汰;
 * - listTools 失败重连一次; callTool 绝不重试 (可能已在外部 server 产生副作用);
 * - listTools 动态注册为 defineTool (inputSchema 经 Type.Unsafe 直通 JSON Schema);
 * - callTool 在宿主进程转发到外部 server (外部进程有自己的隔离边界), 每次调用写审计。
 */
export class McpBridge {
  private static instance?: McpBridge;
  /** "serverId:配置指纹" → 已连接 client; 配置变化自然 miss, 旧条目淘汰时关闭 */
  private clients = new Map<string, Client>();
  /** 连接失败的 serverId (低频重试) */
  private failedServers = new Set<string>();
  private retryTimer?: ReturnType<typeof setInterval>;

  public static getInstance(): McpBridge {
    if (!McpBridge.instance) {
      McpBridge.instance = new McpBridge();
    }
    return McpBridge.instance;
  }

/** 该 server 当前配置指纹对应的连接 key (分隔符用 serverId 不可能含的字符, 防前缀碰撞) */
  private keyFor(server: McpServerDefinition): string {
    return `${server.id}\u0000${configFingerprint(server)}`;
  }

  /** 关闭并移除该 server 的全部旧连接 (配置变化/停用/删除时调用, 防 stdio 子进程泄漏) */
  private closeServerClients(serverId: string): void {
    for (const key of [...this.clients.keys()]) {
      if (key.startsWith(`${serverId}\u0000`)) {
        const client = this.clients.get(key);
        this.clients.delete(key);
        void client?.close().catch(() => {});
      }
    }
  }

  private async connect(server: McpServerDefinition): Promise<Client> {
    const client = new Client({ name: "bot-agent", version: "1.0.0" });
    if (server.transport === "stdio") {
      if (!server.command) throw new Error("stdio server requires a command");
      // 最小环境白名单与沙盒 bash 同源 (共享 sandbox-defaults, 含 SSL_CERT_FILE——
      // MCP server 子进程常做 TLS, 抄漏会让企业根证书环境握手失败)
      const transport = new StdioClientTransport({
        command: server.command,
        args: server.args ?? [],
        env: buildChildProcessEnv(server.env),
      });
      await client.connect(transport);
    } else {
      if (!server.url) throw new Error("http server requires a url");
      if (!/^https?:\/\//i.test(server.url)) throw new Error("url must be http(s)");
      const transport = new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: server.headers ?? {} },
      });
      await client.connect(transport);
    }
    return client;
  }

  /**
   * 取可用连接: 失败时关旧连接重连一次 (仅限只读操作——callTool 可能已在外部
   * server 产生副作用, 重试会重复执行, 参照 pi runtime 的 readOnly 区分)。
   */
  private async withClient<T>(
    server: McpServerDefinition,
    fn: (client: Client) => Promise<T>,
    options: { retry?: boolean } = {},
  ): Promise<T> {
    const retry = options.retry !== false;
    const key = this.keyFor(server);
    const existing = this.clients.get(key);
    if (existing) {
      try {
        return await fn(existing);
      } catch (err) {
        if (!retry) throw err;
        logger.warn("McpBridge", `Client for '${server.id}' failed (${err}); reconnecting once`);
        this.clients.delete(key);
        void existing.close().catch(() => {});
      }
    }
    const client = await this.connect(server);
    this.clients.set(key, client);
    return fn(client);
  }

  /** 连接并列举工具 (sync 构建扩展 / 管理台连接测试共用; 只读, 可重连) */
  public async listTools(server: McpServerDefinition): Promise<
    { name: string; description?: string; inputSchema: Record<string, unknown> }[]
  > {
    return this.withClient(server, async (client) => {
      const res = await client.listTools({}, { timeout: TOOL_TIMEOUT_MS });
      return (res.tools ?? []).map((t: any) => ({
        name: String(t.name),
        description: t.description ? String(t.description) : undefined,
        inputSchema: (t.inputSchema ?? { type: "object" }) as Record<string, unknown>,
      }));
    });
  }

  /** 管理台连接测试: 一次性连接 (绝不进连接缓存——表单配置不能污染已存配置的连接) */
  public async testServer(server: McpServerDefinition): Promise<{ ok: boolean; toolCount?: number; tools?: string[]; error?: string }> {
    let client: Client | undefined;
    try {
      client = await this.connect(server);
      const res = await client.listTools({}, { timeout: TOOL_TIMEOUT_MS });
      const tools = (res.tools ?? []).map((t: any) => String(t.name));
      return { ok: true, toolCount: tools.length, tools };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      void client?.close().catch(() => {});
    }
  }

  /** server → durable Extension (工具经 exposure/toolExposure 过滤后注册) */
  public async buildServerExtension(
    server: McpServerDefinition,
    globalTaken?: Set<string>,
  ): Promise<{ extension: Extension; toolCount: number; warnings: string[] }> {
    const warnings: string[] = [];
    let mcpTools: Awaited<ReturnType<McpBridge["listTools"]>> = [];
    try {
      mcpTools = await this.listTools(server);
    } catch (err) {
      warnings.push(`连接失败: ${err instanceof Error ? err.message : err}`);
    }

    const store = new DatabaseStore();
    const skillId = `mcp__${server.id}`;
    // 全局工具名集合: 跨 server + 跨既有技能, 防净化后碰撞与覆盖
    const taken = globalTaken ?? new Set<string>(
      SkillRegistry.getInstance().listSkills().flatMap((s) => (s.extension.tools ?? []).map((t: any) => t.name)),
    );
    const tools: ToolRegistration[] = [];

    if (server.exposure === "direct") {
      // server 内工具按 name 排序: 碰撞名的 base 归属与 server 返回顺序无关 (确定性分配)
      for (const t of [...mcpTools].sort((a, b) => a.name.localeCompare(b.name))) {
        if (resolveToolExposure(server, t.name) === "hidden") continue;
        // 工具描述是不可信文本 (tool poisoning 面): 进入上下文前截断
        const description = truncate(t.description ?? t.name);
        const toolName = createMcpToolName(server.id, t.name, taken);
        const bridge = this;
        const inputSchema = t.inputSchema;
        tools.push(
          defineTool({
            name: toolName,
            description,
            parameters: Type.Unsafe(inputSchema as any),
            outputLimits: { maxBytes: MCP_OUTPUT_MAX_BYTES, retain: "head" },
            async execute(args: any) {
              const started = Date.now();
              const argsSummary = JSON.stringify(args).slice(0, 300);
              try {
                // callTool 不重试: 外部 server 可能已执行副作用, 重试会重复写
                const result = await bridge.withClient(
                  server,
                  (client) =>
                    client.callTool(
                      { name: t.name, arguments: (args ?? {}) as Record<string, unknown> },
                      undefined,
                      { timeout: TOOL_TIMEOUT_MS },
                    ),
                  { retry: false },
                );
                store.recordAudit(
                  "mcp.call_tool",
                  { server: server.id, tool: t.name, argsSummary, durationMs: Date.now() - started, serverError: (result as any).isError === true },
                );
                return {
                  content: [{ type: "text", text: formatCallResult(result as Record<string, unknown>) }],
                  isError: (result as any).isError === true,
                };
              } catch (err) {
                store.recordAudit(
                  "mcp.call_tool",
                  { server: server.id, tool: t.name, argsSummary, durationMs: Date.now() - started, error: String(err) },
                );
                return { content: [{ type: "text", text: `MCP tool failed: ${err instanceof Error ? err.message : err}` }], isError: true };
              }
            },
          }),
        );
      }
    }

    const extension = defineExtension({
      name: skillId,
      tools,
    });
    return { extension, toolCount: tools.length, warnings };
  }

  /**
   * 与业务库对齐: 启用中的 server 注册/替换, 其余 (禁用/删除) 卸载并关闭连接。
   * registry 同名 install 即刻生效 (会话按名字解析), 下一条消息自动生效。
   * 返回 per-server 结果供管理台展示连接状态。
   *
   * @param onlyIds 限定本次只重建这些 server (重试循环只传 failedServers——
   *                否则健康的 server 每 60s 陪跑一轮 connect/listTools)。
   *                卸载扫描仍遍历全量 (删除/停用在任何 sync 路径都要生效)。
   */
  public async sync(store?: DatabaseStore, onlyIds?: Set<string>): Promise<McpSyncResult[]> {
    const db = store ?? new DatabaseStore();
    const registry = SkillRegistry.getInstance();
    const agentManager = AgentManager.getInstance();
    const results: McpSyncResult[] = [];

    const allDesired = db.listMcpServers().filter((s) => s.enabled);
    const desiredIds = new Set(allDesired.map((s) => s.id));
    const desired = onlyIds ? allDesired.filter((s) => onlyIds.has(s.id)) : allDesired;

    // 卸载失效的: 被删除/禁用 → 注销扩展 + 关闭其全部连接 (stdio 子进程回收)
    for (const skill of registry.listSkills()) {
      if (skill.kind === "mcp" && !desiredIds.has(skill.id.replace(/^mcp__/, ""))) {
        registry.removeSkill(skill.id);
        agentManager.uninstallExtension(skill.extension.name);
        this.closeServerClients(skill.id.replace(/^mcp__/, ""));
        this.failedServers.delete(skill.id.replace(/^mcp__/, ""));
        logger.info("McpBridge", `Uninstalled MCP extension: ${skill.id}`);
      }
    }

    // 按 id 固定排序: 跨 server 净化碰撞时 base 名的归属必须与顺序无关 (确定性分配)
    desired.sort((a, b) => a.id.localeCompare(b.id));
    // 全局工具名集合: 跨 server 去重 (净化后碰撞加 hash)。
    // 排除本次即将重建的 MCP 技能——把它们的旧名算进 taken 会让工具名在
    // 原名 ↔ hash 后缀之间周期性振荡; 不在重建范围内的 MCP 名必须保留
    // (onlyIds 模式下健康 server 的工具名是碰撞基线)
    const rebuilding = new Set(desired.map((s) => `mcp__${s.id}`));
    const globalTaken = new Set<string>(
      registry
        .listSkills()
        .filter((s) => !(s.kind === "mcp" && rebuilding.has(s.id)))
        .flatMap((s) => (s.extension.tools ?? []).map((t: any) => t.name)),
    );

    for (const server of desired) {
      const skillId = `mcp__${server.id}`;
      // 配置变化的 server: 旧连接必须关闭 (cache key 含配置指纹, 残留条目也要清理);
      // 配置未变且有活连接时不打断 (重试循环会反复走 sync)
      if (!this.clients.has(this.keyFor(server))) {
        this.closeServerClients(server.id);
      }
      try {
        const { extension, toolCount, warnings } = await this.buildServerExtension(server, globalTaken);
        if (warnings.length > 0) {
          // 连接失败: 保留 last-known-good 工具面 (若注册过且有工具), 不替换为空
          const existing = registry.getSkill(skillId);
          if (existing && (existing.extension.tools ?? []).length > 0) {
            logger.warn("McpBridge", `MCP server '${server.id}' unreachable; keeping last-known-good extension (${(existing.extension.tools ?? []).length} tools)`);
            this.failedServers.add(server.id);
            results.push({ serverId: server.id, ok: false, toolCount: (existing.extension.tools ?? []).length, warnings });
            continue;
          }
        }
        registry.register({
          id: skillId,
          name: server.name,
          description: truncate(server.description || `MCP server '${server.name}' (${toolCount} tools)`),
          category: "mcp",
          builtin: false,
          kind: "mcp",
          extension,
        });
        agentManager.installExtension(extension);
        if (warnings.length === 0) this.failedServers.delete(server.id);
        else this.failedServers.add(server.id);
        for (const w of warnings) {
          logger.warn("McpBridge", `MCP server '${server.id}': ${w}`);
        }
        logger.info("McpBridge", `Synced MCP server '${server.id}' (${toolCount} tools)`);
        results.push({ serverId: server.id, ok: warnings.length === 0, toolCount, warnings });
      } catch (err) {
        this.failedServers.add(server.id);
        logger.error("McpBridge", `Failed to bridge MCP server '${server.id}':`, err);
        results.push({ serverId: server.id, ok: false, toolCount: 0, warnings: [String(err)] });
      }
    }
    return results;
  }

  /** 低频重试: 连接失败的 server 定期重建 (只动 failedServers, 健康 server 不陪跑) */
  public startRetryLoop(store?: DatabaseStore): void {
    if (this.retryTimer) return;
    this.retryTimer = setInterval(() => {
      if (this.failedServers.size === 0) return;
      logger.info("McpBridge", `Retrying ${this.failedServers.size} failed MCP server(s)`);
      void this.sync(store, new Set(this.failedServers));
    }, RETRY_INTERVAL_MS);
  }

  public stopRetryLoop(): void {
    if (this.retryTimer) clearInterval(this.retryTimer);
    this.retryTimer = undefined;
  }

  /** 进程退出时关闭全部 MCP 连接 (stdio 子进程回收) */
  public async closeAll(): Promise<void> {
    this.stopRetryLoop();
    const closing = [...this.clients.values()].map((c) => c.close().catch(() => {}));
    this.clients.clear();
    await Promise.all(closing);
  }
}
