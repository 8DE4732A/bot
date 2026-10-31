import type { ChannelFieldDescriptor, ChannelTypeDescriptor } from "./descriptor.ts";

/** GET /api/channels 的凭据掩码（与前端约定一致） */
export const CREDENTIAL_MASK = "••••";

function fieldMap(descriptor: ChannelTypeDescriptor): Map<string, ChannelFieldDescriptor> {
  return new Map(descriptor.credentials.map((f) => [f.key, f]));
}

/** * 响应脱敏：secret 字段与未声明的字符串一律掩码；声明为 string 的字段保留明文
 * （如 weixin.accountId/baseUrl——它们不是机密，掩码反而让表单无法辨认）。
 */
export function maskChannelCredentials(
  descriptor: ChannelTypeDescriptor,
  credentials: Record<string, unknown>,
): Record<string, unknown> {
  const fields = fieldMap(descriptor);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(credentials ?? {})) {
    const field = fields.get(key);
    if (typeof value !== "string" || value.length === 0) {
      out[key] = value;
      continue;
    }
    const secret = field ? field.type === "secret" : true;
    out[key] = secret ? CREDENTIAL_MASK : value;
  }
  return out;
}

/** 逗号列表/数组 → 去空字符串数组（凭据归一化与访问策略共用） */
export function toStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value === "string") {
    return value.split(",").map((v) => v.trim()).filter(Boolean);
  }
  return value === undefined || value === null ? [] : [String(value)];
}

function toBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.trim().toLowerCase() === "true";
  return Boolean(value);
}

/**
 * 保存时的凭据归一化：
 * - secret 字段：空字符串/掩码 = 保留旧值（凭据是连接关键，清空即删是显式删除渠道才有意义）
 * - 非 secret 字段：按提交值覆盖，空字符串 = 删除该键
 * - list/boolean/select 按声明的类型归一化
 * - 未声明的新字段原样保留；旧字段未提交也保留（避免升级后丢失历史配置）
 */
export function normalizeChannelCredentials(
  descriptor: ChannelTypeDescriptor,
  next: Record<string, unknown>,
  previous: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...(previous ?? {}) };
  const fields = fieldMap(descriptor);

  for (const field of descriptor.credentials) {
    const submitted = Object.prototype.hasOwnProperty.call(next ?? {}, field.key);
    const raw = next?.[field.key];

    if (!submitted) {
      // secret 缺省 = 保旧；其他字段缺省 = 显式清空（与旧管理台语义一致）
      if (field.type === "secret") continue;
      delete merged[field.key];
      continue;
    }

    if (field.type === "secret") {
      if (raw === "" || raw === CREDENTIAL_MASK || raw === undefined || raw === null) continue;
      merged[field.key] = String(raw);
      continue;
    }

    if (raw === "" || raw === undefined || raw === null) {
      delete merged[field.key];
      continue;
    }

    switch (field.type) {
      case "boolean":
        merged[field.key] = toBoolean(raw);
        break;
      case "list": {
        const list = toStringList(raw);
        merged[field.key] = field.maxItems ? list.slice(0, field.maxItems) : list;
        break;
      }
      case "select": {
        const value = String(raw);
        const allowed = field.options?.some((o) => o.value === value);
        if (value && field.options && !allowed) {
          throw new Error(`invalid value for ${field.key}: ${value}`);
        }
        merged[field.key] = value;
        break;
      }
      default:
        merged[field.key] = String(raw);
    }
  }

  // 未声明字段：提交值优先（掩码还原旧值），否则保留旧值
  for (const [key, value] of Object.entries(next ?? {})) {
    if (fields.has(key)) continue;
    merged[key] =
      value === CREDENTIAL_MASK && typeof previous?.[key] === "string" ? previous[key] : value;
  }

  return merged;
}

/** 必填校验（API 保存前调用；只检查声明的 required 字段） */
export function validateRequiredCredentials(
  descriptor: ChannelTypeDescriptor,
  credentials: Record<string, unknown>,
): string | undefined {
  for (const field of descriptor.credentials) {
    if (!field.required) continue;
    const value = credentials?.[field.key];
    if (field.type === "list") {
      if (!Array.isArray(value) || value.length === 0) return `${field.label} is required`;
    } else if (field.type === "boolean") {
      continue;
    } else if (value === undefined || value === null || String(value).trim() === "") {
      return `${field.label} is required`;
    }
  }
  return undefined;
}
