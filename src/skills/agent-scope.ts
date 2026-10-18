/**
 * 会话 → Agent 归属解析（注入式，避免 skills-catalog ↔ AgentManager 的直接循环依赖）。
 * 由 AgentManager.init() 在 harness 就绪前接线；解析失败一律 fail-closed。
 */
type AgentIdResolver = (conversationId: string) => string | undefined;

let resolver: AgentIdResolver | undefined;

export function setAgentIdResolver(fn: AgentIdResolver | undefined): void {
  resolver = fn;
}

export function resolveAgentId(conversationId: string | undefined): string | undefined {
  if (!resolver || !conversationId) return undefined;
  try {
    return resolver(conversationId);
  } catch {
    return undefined;
  }
}
