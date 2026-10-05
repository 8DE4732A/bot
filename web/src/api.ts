import type {
  Agent,
  AuditLog,
  ChatChunk,
  Channel,
  ModelProvider,
  Skill,
  SystemStatus,
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

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(await resErrorMessage(res));
  return res.json() as Promise<T>;
}

export const api = {
  status: () => fetch("/api/status").then((r) => json<SystemStatus>(r)),

  listAgents: () => fetch("/api/agents").then((r) => json<Agent[]>(r)),
  saveAgent: (a: Partial<Agent> & { id: string }) =>
    fetch("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(a),
    }).then((r) => json<{ success: boolean }>(r)),
  deleteAgent: (id: string) =>
    fetch(`/api/agents?id=${encodeURIComponent(id)}`, { method: "DELETE" }).then((r) =>
      json<{ success: boolean }>(r),
    ),

  listProviders: () => fetch("/api/providers").then((r) => json<ModelProvider[]>(r)),
  saveProvider: (p: Partial<ModelProvider> & { id: string }) =>
    fetch("/api/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(p),
    }).then((r) => json<{ success: boolean }>(r)),
  deleteProvider: (id: string) =>
    fetch(`/api/providers?id=${encodeURIComponent(id)}`, { method: "DELETE" }).then((r) =>
      json<{ success: boolean }>(r),
    ),
  fetchRemoteModels: (apiBase: string, apiKey: string, providerId?: string) =>
    fetch("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiBase, apiKey, providerId }),
    }).then((r) => json<{ success: boolean; models: string[]; error?: string }>(r)),
  testProvider: (req: {
    providerId: string;
    modelId: string;
    apiBase?: string;
    apiKey?: string;
    protocol?: string;
  }) =>
    fetch("/api/providers/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    }).then((r) => json<{ success: boolean; latencyMs?: number; error?: string }>(r)),

  listChannels: () => fetch("/api/channels").then((r) => json<Channel[]>(r)),
  saveChannel: (c: Partial<Channel> & { id: string }) =>
    fetch("/api/channels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(c),
    }).then((r) => json<{ success: boolean }>(r)),
  deleteChannel: (id: string) =>
    fetch(`/api/channels?id=${encodeURIComponent(id)}`, { method: "DELETE" }).then((r) =>
      json<{ success: boolean }>(r),
    ),

  listSkills: () => fetch("/api/skills").then((r) => json<Skill[]>(r)),
  listAuditLogs: () => fetch("/api/audit-logs").then((r) => json<AuditLog[]>(r)),

  resetChat: (agentId: string, sessionId: string) =>
    fetch("/api/chat/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId, sessionId }),
    }).then((r) => json<{ success: boolean }>(r)),
};

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
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ agentId, message, sessionId }),
  });

  if (!res.ok || !res.body) {
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
