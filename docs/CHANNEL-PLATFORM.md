# 渠道平台（声明式注册表）

> 2026-10 交付。目标：新增渠道只需「写 adapter + 声明 descriptor」，前后端零枚举改动；同时补齐 weixin/qq 的出站媒体、DM/群策略、引用/语音与健康重连。

## 1. 单一真相源

```
src/channels/
├── base.ts              ChannelAdapter / InboundMessage / OutboundMedia / ChannelHealth
├── descriptor.ts        ChannelTypeDescriptor + toPublicChannelType()
├── registry.ts          register/get/list/createChannelAdapter（内置 descriptor 自注册）
├── descriptors/         feishu / wecom / qq / weixin / telegram / terminal
├── credentials.ts       掩码、归一化、必填校验
├── access-policy.ts     DM/群策略纯函数
├── prompt-context.ts    渠道上下文 section（排版 + MEDIA 约定）
├── manager.ts           生命周期 + dispatch/deliverOutbound/getHealth
└── adapters/            协议实现（+ weixin-media/qq-upload/weixin-protocol/qq-protocol）
```

`ChannelTypeDescriptor` 关键字段：

```ts
{
  type, label, description,
  managedBy: "manager" | "cli",       // terminal 由 CLI 管理
  creatable, deletable,
  credentials: ChannelFieldDescriptor[], // string|secret|boolean|list|select
  capabilities: { groupChat, mediaInbound, mediaOutbound, passiveReply, typing,
                  streaming, markdown, maxMessageBytes },
  auth?: { kind:"qr", label, pollIntervalMs, start(config), poll(state, config) },
  create?(config, deps), validate?(config), onDelete?(config)
}
```

- `GET /api/channel-types` 返回 `toPublicChannelType()`：白名单字段，绝不带函数或凭据值。
- `ChannelAdapter.type` / `ChannelInstanceConfig.type` 为 `string`；API 保存时由 registry 校验未知类型（400）。
- 管理台 `ChannelsView` 不再维护类型/字段表：类型下拉、字段控件（密码/多选/布尔/下拉）、扫码入口、能力提示全部来自元数据。

## 2. 依赖方向与运行时注入

```
server / manager → registry → descriptors → adapters → descriptor 类型 / runtime
```

adapter 不再 import `ChannelManager`；构造注入：

```ts
interface ChannelAdapterDeps {
  runtime: ChannelDispatchRuntime; // dispatchAndReply / dispatchInbound / deliverOutbound
  mediaFetch?, wsFactory?, now?, sleep?, qq?, dotBotDir?, tuning?
}
```

`createChannelInboundPipeline` + `createTypingController` 统一装配入站管道与 per-peer typing；wecom 通过 `dispatchOverride` 保留流式 dispatch。

## 3. 生命周期

`ChannelManager` 提供 `startChannel/stopChannel/restartChannel/saveAndRestart/deleteChannel/getHealth/withChannelLock`：

- 保存/扫码确认/删除共享同一 per-channel 锁；`saveAndRestart` 锁内重读配置，旧快照不得复活已删除渠道。
- 启动失败 unregister + `channel.status error` + 抛出（HTTP 500，配置已保存）。
- 删除：stop → unregister → `clearMediaCache` → `descriptor.onDelete`（微信清 `.bot/channels/weixin/<accountId>`）→ 删库。
- terminal：`managedBy: "cli"`，manager 不重建；管理台只允许编辑既有实例。

## 4. 认证

descriptor.auth 声明 `start/poll`；通用路由：

- `POST /api/channels/:id/auth/start`
- `GET /api/channels/:id/auth/poll?qrcode=&redirect_host=`

旧 `/qr-login`、`/qr-status` 保留为别名。confirmed 时在锁内合并 credentials 并热重启，审计 `channel.auth_confirmed`。

认证型渠道（如微信）在无凭据时**保存不会失败**：adapter 进入 `pendingAuth`（不轮询、health 报「待扫码」），管理台保存后按 `auth.readyFields` 自动拉起二维码；扫码确认后热重启进入正常状态。

## 5. 出站媒体

- Agent 回复中的独占行 `MEDIA:<path>`（最多 8 个，代码围栏内不算）。
- 路径安全：绝对路径或相对 Agent workspace；`realpath` 后必须位于 workspace；`.bot` 下只允许 `.bot/workspaces/**`；必须是普通文件、1B..128MB、单条回复总计 ≤256MB；硬链接文件（nlink>1）保守拒绝。
- 校验后立即以 `O_NOFOLLOW` 打开并 `fstat` 比对 dev/ino，从受控 fd 读出内容快照放入 `OutboundMedia.data`；adapter 只发送这份快照，避免校验与读取之间的路径替换（TOCTOU）。
- 校验失败写 `channel.media_rejected` 审计，用户只看到不含绝对路径的提示。
- `ChannelManager.deliverOutbound` 先发文本、后发媒体；通知可传 `agentId`（`sendNotification`），主动通知也可带媒体。
- weixin：`getuploadurl` → AES-128-ECB（PKCS#7）→ CDN POST（必须 `x-encrypted-param`）→ item_list；`aes_key` 必须是 `base64(hex)`；音频按文件附件。
- qq：≤10MB 内联 `file_data`，更大 `upload_prepare → PUT parts → upload_part_finish → files`；发送 `msg_type=7`（窗口内带 `msg_id`）。

## 6. 访问策略

凭据字段：`dmPolicy`、`allowFrom`、`groupPolicy`、`groupAllowFrom`（`open|allowlist|disabled`，空 = 自动）。

- DM：disabled 拒绝；allowlist 匹配 `allowFrom`；open 放行；未配置时旧行为（allowFrom 非空 = 白名单）。
- Group：disabled 拒绝；allowlist 匹配 `groupAllowFrom`；open 放行；未配置时 groupAllowFrom 优先，否则回退旧 allowFrom。
- 只匹配不可变 peerId，不匹配昵称。
- weixin 按 `room_id/chat_room_id` 识别群（peer=group，sender=from_user_id）；iLink bot 身份通常收不到普通群事件，策略可能无效（启动 warn）。

## 7. weixin / qq 能力对齐

- QQ：`message_type=103` + `msg_elements` 引用文本/附件；语音优先 `asr_refer_text`，否则 `voice_wav_url`/原 URL 下载为 audio；`markdownSupport=true` 时 `markdownMode="full"` + `msg_type=2`；被动窗口客户端计时（c2c 60min/group 5min，预留 5s）；close code 分类（4004 刷 token、4006/4007/4900-4913 清 session、4008 限流 60s、4009 Resume、其余 fatal）；快速断连 3 次停止；healthCheck 用 WS 状态。
- weixin：引用 `ref_msg.message_item` 媒体递归；`voice_item.text` 兜底；copy-friendly 排版（标题/表格/空行）；healthCheck 看长轮询新鲜度（90s）；`-14` 标记 sessionExpired；-2 限频熔断（30s 窗口/30s 打开）。

## 8. 测试（无真实凭据）

- 纯函数：registry/credentials/access-policy/media-outbound/qq-protocol/weixin-protocol。
- 本地模拟：`test/weixin-adapter.test.ts`（Bun.serve 模拟 QR/getupdates/sendmessage/getuploadurl/upload，验证 tokenless 降级与 AES 往返）；`test/qq-adapter.test.ts`（本地 HTTP + WS 模拟 token/gateway/READY/C2C/群 @，验证被动回复、markdown、媒体）。
- 生命周期：`test/channel-lifecycle.test.ts`（并发保存串行、失败不残留、terminal、onDelete、getHealth）。
- 单例纪律：临时 DB + `logger.init(临时目录)`，不 rmSync 单例库目录；adapter 测试通过 deps 注入本地服务与 `dotBotDir`，生产 `safeFetch` 无 localhost 旁路。

## 9. 已知边界 / backlog

- 未做真实微信/QQ 账号联调；协议细节按 hermes 对照与本地模拟，平台演进可能需调整。
- QQ guild、外部 STT provider、微信原生语音气泡、pairing 配对、动态第三方渠道插件、投递账本未做。
- 微信普通群事件可达性受 iLink bot 身份限制，不承诺投递。
- 出站媒体路径若为 workspace 内硬链接指向受保护 inode，realpath 防线下仍可能读取（与现有 PathGuard 的 inode 边界一致），后续可复用 inode deny 集合。
