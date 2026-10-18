import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isInsidePath } from "./env-paths.ts";

/** 词法/真实路径归一：逐级 realpath 已存在的父目录，再拼回不存在的尾部 */
export function canonicalPath(path: string): string {
  let current = resolve(path);
  const tail: string[] = [];
  while (!currentExists(current)) {
    const parent = dirname(current);
    if (parent === current) return resolve(path);
    tail.unshift(current.slice(parent.length).replace(/^[/\\]+/, ""));
    current = parent;
  }
  try {
    return resolve(realpathSync(current), ...tail);
  } catch {
    return resolve(path);
  }
}

function currentExists(path: string): boolean {
  try {
    realpathSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * 历史数据可能已存在重叠 workspaceDir；返回 agentId -> 冲突原因。
 * 相等、祖先/后代包含都算冲突。
 */
export function detectWorkspaceConflicts(
  agents: { id: string; workspaceDir: string }[],
): Map<string, string> {
  const conflicts = new Map<string, string>();
  const entries = agents
    .filter((a) => a.workspaceDir)
    .map((a) => ({ id: a.id, ws: canonicalPath(a.workspaceDir) }));
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i];
      const b = entries[j];
      if (isInsidePath(a.ws, b.ws) || isInsidePath(b.ws, a.ws)) {
        if (!conflicts.has(a.id)) conflicts.set(a.id, `workspace 与 Agent '${b.id}' 重叠`);
        if (!conflicts.has(b.id)) conflicts.set(b.id, `workspace 与 Agent '${a.id}' 重叠`);
      }
    }
  }
  return conflicts;
}
