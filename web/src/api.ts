import type {
  Agent,
  AuditLog,
  AuditPage,
  ChatChunk,
  Channel,
  ChannelHealth,
  McpServer,
  ModelProvider,
  ScheduledTask,
  ScheduleType,
  SessionHistory,
  SessionRow,
  SessionSearchHit,
  Skill,
  SystemStatus,
  WeixinQrLogin,
} from "./types";

/** 从非 2xx 响应中提取错误消息 (统一给 json() 与 chatStream 使用) */
async function resErrorMessage(res: Response): Promise<string> {
  let msg = `HTTP ${res.status}`;
  try {
    const body = await res.json();
    if (body?.error) msg = body.error;
  } catch {
    /* ignore */
  }
  return msg;
}

/**
 * 注入式 session token (四期 §6.1): 优先读服务端注入 HTML 的
 * window.__BOT_TOKEN__; vite dev 模式 (HTML 无注入) 回退 /api/bootstrap。
 * 惰性解析一次, 之后全部请求统一附 header。
 */
let cachedToken: string | null | undefined;
async function authToken(): Promise<string> {
  if (cachedToken !== undefined) return cachedToken ?? "";
  const injected = (window as any).__BOT_TOKEN__;
  if (typeof injected === "string" && injected) {
    cachedToken = injected;
    return injected;
  }
  try {
    const res = await fetch("/api/bootstrap");
    const body = await res.json();
    cachedToken = typeof body?.token === "string" ? body.token : "";
  } catch {
    cachedToken = "";
  }
  return cachedToken ?? "";
}

/** 全部 /api 请求的统一头 (token 鉴权 + JSON 体) */
async function apiHeaders(extra?: Record<string, string>): Promise<Record<string, string>> {
  const headers: Record<string, string> = { "x-bot-token": await authToken(), ...extra };
  return headers;
}

/** 401 = gateway 重启后 token 轮换: 自动 reload 重新拿注入的新 token (§6.1)。
 *  计数上限 2 次 (R1 评审 M11: token 持续失效时避免无限 reload 循环) */
function handle401(res: Response): void {
  if (res.status !== 401) return;
  const key = "bot:401-reloads";
  const count = Number(sessionStorage.getItem(key) ?? "0");
  if (count >= 2) return;
  sessionStorage.setItem(key, String(count + 1));
  window.location.reload();
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    handle401(res);
    throw new Error(await resErrorMessage(res));
  }
  return res.json() as Promise<T>;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  return fetch(path, {
    ...init,
    headers: await apiHeaders(init?.headers as Record<string, string> | undefined),
  }).then((r) => json<T>(r));
}

export const api = {
  status: () => request<SystemStatus>("/api/status"),

  listAgents: () => request<Agent[]>("/api/agents"),
  saveAgent: (a: Partial<Agent> & { id: string }) =>
    request<{ success: boolean }>("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(a),
    }),
  deleteAgent: (id: string) =>
    request<{ success: boolean }>(`/api/agents?id=${encodeURIComponent(id)}`, { method: "DELETE" }),

  listProviders: () => request<ModelProvider[]>("/api/providers"),
  saveProvider: (p: Partial<ModelProvider> & { id: string }) =>
    request<{ success: boolean }>("/api/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(p),
    }),
  deleteProvider: (id: string) =>
    request<{ success: boolean }>(`/api/providers?id=${encodeURIComponent(id)}`, { method: "DELETE" }),
  fetchRemoteModels: (apiBase: string, apiKey: string, providerId?: string) =>
    request<{ success: boolean; models: string[]; error?: string }>("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiBase, apiKey, providerId }),
    }),
  testProvider: (req: {
    providerId: string;
    modelId: string;
    apiBase?: string;
    apiKey?: string;
    protocol?: string;
  }) =>
    request<{ success: boolean; latencyMs?: number; error?: string }>("/api/providers/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    }),

  listChannels: () => request<Channel[]>("/api/channels"),
  saveChannel: (c: Partial<Channel> & { id: string }) =>
    request<{ success: boolean }>("/api/channels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(c),
    }),
  deleteChannel: (id: string) =>
    request<{ success: boolean }>(`/api/channels?id=${encodeURIComponent(id)}`, { method: "DELETE" }),
  channelHealth: (id: string) =>
    request<ChannelHealth>(`/api/channels/${encodeURIComponent(id)}/health`),
  weixinQrLogin: (id: string) =>
    request<WeixinQrLogin>(`/api/channels/${encodeURIComponent(id)}/qr-login`, { method: "POST" }),
  weixinQrStatus: (id: string, qrcode: string, redirectHost?: string) =>
    request<{ status: string; redirectHost?: string }>(
      `/api/channels/${encodeURIComponent(id)}/qr-status?qrcode=${encodeURIComponent(qrcode)}${redirectHost ? `&redirect_host=${encodeURIComponent(redirectHost)}` : ""}`,
    ),

  listSkills: () => request<Skill[]>("/api/skills"),
  listAuditLogs: () => request<AuditLog[]>("/api/audit-logs"),

  listMcpServers: () => request<McpServer[]>("/api/mcp-servers"),
  saveMcpServer: (s: Partial<McpServer> & { id: string }) =>
    request<{ success: boolean }>("/api/mcp-servers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(s),
    }),
  deleteMcpServer: (id: string) =>
    request<{ success: boolean }>(`/api/mcp-servers?id=${encodeURIComponent(id)}`, { method: "DELETE" }),
  testMcpServer: (s: Partial<McpServer> & { id?: string }) =>
    request<{ ok: boolean; toolCount?: number; tools?: string[]; error?: string }>("/api/mcp-servers/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(s),
    }),

  listScheduledTasks: () => request<ScheduledTask[]>("/api/scheduled-tasks"),
  deleteScheduledTask: (id: string) =>
    request<{ success: boolean }>(`/api/scheduled-tasks?id=${encodeURIComponent(id)}`, { method: "DELETE" }),

  resetChat: (agentId: string, sessionId: string) =>
    request<{ success: boolean }>("/api/chat/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId, sessionId }),
    }),
  cancelChat: (agentId: string, sessionId: string) =>
    request<{ success: boolean; aborted: boolean }>("/api/chat/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId, sessionId }),
    }),

  /* ---------------- 四期 M3 ---------------- */

  listSessions: () => request<SessionRow[]>("/api/sessions"),
  findSession: (agentId: string, sessionId: string) =>
    request<SessionRow | null>(`/api/sessions/find?agentId=${encodeURIComponent(agentId)}&sessionId=${encodeURIComponent(sessionId)}`),
  sessionHistory: (conversationId: string) =>
    request<SessionHistory>(`/api/sessions/${encodeURIComponent(conversationId)}/history`),
  searchSessions: (q: string) =>
    request<SessionSearchHit[]>(`/api/sessions/search?q=${encodeURIComponent(q)}`),
  auditLogsFiltered: (params: {
    event?: string;
    agentId?: string;
    since?: number;
    until?: number;
    limit?: number;
    offset?: number;
  }) => {
    const usp = new URLSearchParams();
    if (params.event) usp.set("event", params.event);
    if (params.agentId) usp.set("agentId", params.agentId);
    if (params.since !== undefined) usp.set("since", String(params.since));
    if (params.until !== undefined) usp.set("until", String(params.until));
    usp.set("limit", String(params.limit ?? 100));
    usp.set("offset", String(params.offset ?? 0));
    return request<AuditPage>(`/api/audit-logs?${usp.toString()}`);
  },
  saveScheduledTask: (t: Partial<ScheduledTask> & { agentId: string; name: string; prompt: string; scheduleType: ScheduleType }) =>
    request<{ success: boolean; id: string; nextRunAt?: number }>("/api/scheduled-tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(t),
    }),
  triggerScheduledTask: (id: string) =>
    request<{ success: boolean; runNumber: number }>("/api/scheduled-tasks/trigger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    }),
};

/* ---------------- Gateway 事件流 (四期 §6.1): SSE → 窗口事件分发 ---------------- */

export type GatewayEvent = { type: string; [k: string]: unknown };

/**
 * 订阅 /api/gateway/events。断线自动重连 (指数退避); 每个事件同时以
 * window CustomEvent("bot:event", {detail}) 分发——视图无需各自持连接,
 * 监听窗口事件做静默刷新即可 (hermes 用轮询模拟的效果)。
 */
export function subscribeGatewayEvents(): () => void {
  let es: EventSource | null = null;
  let stopped = false;
  let retry = 0;

  const open = async () => {
    while (!stopped) {
      try {
        const token = await authToken();
        // EventSource 无法带 header: token 走查询参数 (127.0.0.1 本机面)
        es = new EventSource(`/api/gateway/events?token=${encodeURIComponent(token)}`);
        es.onmessage = (msg) => {
          try {
            const event = JSON.parse(msg.data) as GatewayEvent;
            if (event.type && event.type !== "hello") {
              window.dispatchEvent(new CustomEvent("bot:event", { detail: event }));
            }
          } catch {
            /* 跳过坏帧 */
          }
        };
        es.onerror = () => {
          es?.close();
          es = null;
          if (stopped) return;
          retry = Math.min(retry + 1, 5);
          setTimeout(open, 1000 * 2 ** retry);
        };
        es.onopen = () => {
          retry = 0;
        };
        return;
      } catch {
        if (stopped) return;
        retry = Math.min(retry + 1, 5);
        await new Promise((r) => setTimeout(r, 1000 * 2 ** retry));
      }
    }
  };
  void open();

  return () => {
    stopped = true;
    es?.close();
  };
}

/** 视图侧监听窗口事件的便捷 hook 依赖: 事件类型过滤 */
export function isGatewayEvent(e: Event, ...types: string[]): boolean {
  const detail = (e as CustomEvent).detail as GatewayEvent | undefined;
  return Boolean(detail && types.includes(detail.type));
}

/**
 * SSE 流式对话。后端在 Accept: text/event-stream 时返回
 * `data: {json}\n\n` 帧，以 `data: [DONE]` 结束。
 * sessionId 不传时后端默认 `web-playground:<agentId>` (与 reset 一致)。
 */
export async function chatStream(
  agentId: string,
  sessionId: string | undefined,
  message: string,
  onChunk: (chunk: ChatChunk) => void,
): Promise<void> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: await apiHeaders({ "Content-Type": "application/json", Accept: "text/event-stream" }),
    body: JSON.stringify({ agentId, message, sessionId }),
  });

  if (!res.ok || !res.body) {
    handle401(res);
    throw new Error(await resErrorMessage(res));
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE 帧以空行分隔
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        if (payload === "[DONE]") return;
        try {
          onChunk(JSON.parse(payload) as ChatChunk);
        } catch {
          /* 跳过坏帧 */
        }
      }
    }
  }
}
