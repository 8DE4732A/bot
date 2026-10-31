import type { ChannelFieldDescriptor } from "../descriptor.ts";

const POLICY_OPTIONS = [
  { value: "", label: "自动（兼容旧配置）" },
  { value: "open", label: "允许所有" },
  { value: "allowlist", label: "仅白名单" },
  { value: "disabled", label: "禁用" },
];

/**
 * DM/群访问策略字段（各 IM 渠道共用）。
 * 未配置 policy 时保持旧行为：allowFrom 非空 = 白名单，空 = 放行。
 */
export function accessFields(): ChannelFieldDescriptor[] {
  return [
    {
      key: "dmPolicy",
      label: "私聊策略",
      type: "select",
      section: "access",
      options: POLICY_OPTIONS,
      hint: "自动 = 兼容旧配置：allowFrom 非空时按白名单；留空策略值可删除该项",
    },
    {
      key: "allowFrom",
      label: "私聊白名单（可选）",
      type: "list",
      section: "access",
      maxItems: 500,
      placeholder: "id_1, id_2",
      hint: "逗号分隔的不可变 peer id（勿填昵称）；留空 = 允许所有私聊",
    },
    {
      key: "groupPolicy",
      label: "群聊策略",
      type: "select",
      section: "access",
      options: POLICY_OPTIONS,
    },
    {
      key: "groupAllowFrom",
      label: "群聊白名单（可选）",
      type: "list",
      section: "access",
      maxItems: 500,
      placeholder: "group_id_1, group_id_2",
      hint: "逗号分隔的群/房间 id（不可变 id，勿填群名）；仅群聊策略=白名单时生效",
    },
  ];
}
