import { toStringList } from "./credentials.ts";

/**
 * 渠道访问策略（纯函数, 便于矩阵测试）。
 *
 * 字段语义（descriptor 在 access 分组声明）：
 * - dmPolicy: open | allowlist | disabled；缺省 = 兼容旧行为（allowFrom 非空即白名单）
 * - groupPolicy: open | allowlist | disabled；缺省时 groupAllowFrom 优先，其次回退旧 allowFrom
 * - 只匹配不可变 peerId（open_id / openid / chat_id / group id），绝不匹配昵称
 *
 * 凭据只在 adapter 重启时变化，因此 pipeline 用 compileChannelAccess 编译一次，
 * 每条消息不再重复读库/解析列表。
 */

export type ChannelAccessScope = "dm" | "group";
export type ChannelAccessPolicy = "open" | "allowlist" | "disabled";

export interface ChannelAccessInput {
  credentials?: Record<string, unknown>;
  peerId: string;
  conversationType?: "direct" | "group";
  senderId?: string;
}

export interface ChannelAccessVerdict {
  allowed: boolean;
  scope: ChannelAccessScope;
  reason: string;
}

export type ChannelAccessCheck = (
  input: Omit<ChannelAccessInput, "credentials">,
) => ChannelAccessVerdict;

function asPolicy(value: unknown): ChannelAccessPolicy | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim().toLowerCase();
  return v === "open" || v === "allowlist" || v === "disabled" ? v : undefined;
}

function decide(
  scope: ChannelAccessScope,
  policy: ChannelAccessPolicy,
  allowlist: string[],
  peerId: string,
  label: string,
): ChannelAccessVerdict {
  if (policy === "disabled") {
    return { allowed: false, scope, reason: `${label} disabled by policy` };
  }
  if (policy === "open") return { allowed: true, scope, reason: `${label}Policy=open` };
  return allowlist.includes(peerId)
    ? { allowed: true, scope, reason: `${label} allowlist matched` }
    : { allowed: false, scope, reason: `${label} peer not in allowlist` };
}

/** 编译一次凭据 → 可复用的访问检查函数 */
export function compileChannelAccess(
  credentials: Record<string, unknown> | undefined,
): ChannelAccessCheck {
  const creds = credentials ?? {};
  const allowFrom = toStringList(creds.allowFrom);
  const groupAllowFrom = toStringList(creds.groupAllowFrom);
  const dmPolicy = asPolicy(creds.dmPolicy);
  const groupPolicy = asPolicy(creds.groupPolicy);

  return (input) => {
    if (input.conversationType === "group") {
      const policy =
        groupPolicy ??
        (groupAllowFrom.length > 0 || allowFrom.length > 0 ? "allowlist" : "open");
      const list = groupPolicy
        ? groupAllowFrom
        : groupAllowFrom.length > 0
          ? groupAllowFrom
          : allowFrom;
      return decide("group", policy, list, input.peerId, "group");
    }
    const policy = dmPolicy ?? (allowFrom.length > 0 ? "allowlist" : "open");
    return decide("dm", policy, allowFrom, input.peerId, "dm");
  };
}

/** 便捷入口（一次性判定；pipeline 请用 compileChannelAccess 缓存） */
export function evaluateChannelAccess(input: ChannelAccessInput): ChannelAccessVerdict {
  return compileChannelAccess(input.credentials)(input);
}
