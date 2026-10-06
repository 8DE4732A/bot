# 三期设计：多渠道接入（飞书 / QQ / 微信 / 企业微信）

> 状态：设计稿（2026-10）。一期/二期现状见 `TECHNICAL.md` 与 `PHASE2-DESIGN.md`（§8 记录产品语义取舍）。
> 调研对象：**hermes**（Python，本地 `../hermes-agent`，`gateway/platforms/` 24653 行生产级多渠道实现）、**OpenClaw**（TypeScript，channel 插件体系）、各平台官方 API/SDK 现状。
> 核心结论先行：**四个渠道全部走官方 WebSocket 长连接（飞书/企微智能机器人/QQ 官方 SDK + 微信 iLink 长轮询），收发消息一律免公网、免 HTTP 回调验签**——部署面与一期终端/Web 完全一致，`bun run dev` 即用。

---

## 1. 目标与非目标

### 目标

1. **统一消息模型与渠道运行时**：媒体附件、文本分段、防抖合并、去重、限流、typing 心跳、防自循环——一次建好，所有渠道共用（对齐 hermes 的 `gateway/platforms/_shared` + `base.py` 设施层）
2. **四个渠道落地**（按接入难度排序）：飞书 → QQ → 微信(iLink) → 企业微信完善
3. **管理台渠道配置升级**：按 type 出差异化表单（凭据字段声明式），连接状态/健康检查可见
4. 既有不变量保持：`ChannelAdapter` 工厂注册表、`channel_sessions` 会话映射、通知寻址（二期）、沙盒与审计闭环

### 非目标

- 微信公众号/小程序渠道（模板消息形态与 IM 不同，需要时另行设计）
- 微信个人号的群聊（iLink Bot API 仅支持私聊，见 §3.1）
- 语音实时通话、视频号、渠道间消息转发
- 多渠道账号 multiplexing（hermes 支持 per-platform 多 profile；我们一期先单实例单凭据，表结构预留）

---

## 2. 调研：两个参照系的架构结论

### 2.1 hermes（Python，`gateway/platforms/`，24k 行）

**分层**：`BasePlatformAdapter`（基类契约）→ 平台适配器（每平台一个文件/目录）→ `_shared.py`（凭据读取 `get_scoped_secret`、env seeding）→ 通用设施独立成模块（`webhook.py` 验签、`webhook_coalesce.py` 防抖、`media_cache.py` 媒体缓存、`bot_loop_guard.py` 防自循环、`delivery.py`+`delivery_ledger.py` 投递账本、`helpers.py` 的 `MessageDeduplicator`/UTF-16 安全分段）。

**值得照抄的四个机制**：

| 机制 | hermes 实现 | 我们的做法 |
|---|---|---|
| 防抖合并 | `webhook_coalesce.py`：按 payload 派生 key 分组，quiet window（默认 30s）内只派发**最新**事件，`max_wait`（默认 300s）防饿死 | 用户连发多条 → 合并为一次 agent 调用（一期 §5.1 就规划了，此处给出精确语义） |
| 消息去重 | `MessageDeduplicator`（TTL 300s，平台重推/长轮询重连双投防御） | 各渠道 adapter 入口统一过一遍 |
| 防自循环 | `bot_loop_guard.py`：agent 回复触发平台上另一条@消息再触发 agent 的回环，`max_events`/`window_seconds` 熔断 | 群聊场景（QQ 群/飞书群）必需 |
| UTF-16 安全分段 | `base.py:249` 按平台字符预算二分切段，永不劈开代理对 | 企业微信/QQ 消息长度限制的字节安全切分 |

**平台时间窗模式**（`_keep_typing` 覆盖模式）：LINE 60s 单次回复 token、WhatsApp 24h 会话窗、QQ 被动回复 5 分钟窗口——同一模式：**超窗后从"被动回复"切换为"主动发送"**，typing 心跳维持到回复落地。我们的 `ChannelAdapter` 需要把这个模式作为一等概念（见 §4）。

**凭据**：`config.extra` 优先、env var 兜底（`_shared.get_scoped_secret`），永不明文进配置文件。

### 2.2 OpenClaw（TypeScript）

**Channel 接口极小**（`@openclaw/sdk`）：`connect(config, ctx)` / `disconnect()` / `sendReply(msg, reply)` / 可选 `healthCheck()`——入站由适配器自管（WS/轮询/webhook），规范化为统一 `ChannelMessage`（`sender`/`conversation`/`attachments`/`raw`）后调 `ctx.onMessage`。**核心/插件分离**：Telegram/WebChat 在核心，WhatsApp(Discord/Slack) 是 npm 插件，凭据 `${ENV_VAR}` 展开。

**对我们的启示**：(1) 渠道差异封装在 adapter 内，网关只见统一消息——与我们现有 `ChannelAdapter` 一致，验证了方向；(2) npm 插件化渠道不急（内部项目），但 `factory.ts` 注册表已支持；(3) 会话存储 key 约定 `agent:main:telegram:user123` 与我们 `channel_sessions` 主键同构。

### 2.3 平台可行性矩阵（2026-10 实测调研，含官方 SDK 选型）

| 平台 | 接入方式 | SDK | 公网要求 | 群聊 | 关键限制 |
|---|---|---|---|---|---|
| **飞书** | 官方 `@larksuiteoapi/node-sdk` **WebSocket 长连接**（企业自建应用） | ✅ 官方 | **不需要** | 群聊 ✓（@机器人） | 事件 3 秒内须处理完（超时重推）；50 连接/应用；集群投递 |
| **企业微信(智能机器人)** | 官方 `@wecom/aibot-node-sdk` **WebSocket 长连接**（`wss://openws.work.weixin.qq.com`） | ✅ 官方 | **不需要**（无需 HTTP 回调/验签/access_token——认证帧鉴权） | 群聊 ✓（`chattype: group`） | 欢迎语/卡片 5s 窗口；媒体分片上传 ≤50MB；**支持流式回复**（`replyStream`） |
| **QQ** | 官方 Bot API v2：`qq-guild-bot` npm（WS 网关 + REST）或自实现薄客户端 | ✅ 官方（需实测 C2C/群事件覆盖） | **不需要**（WS 网关） | 群 @ 消息 ✓ | **主动消息每月 4 条**；被动回复群 5 分钟/单聊 60 分钟窗口；单群 20 qpm |
| **微信个人号** | 腾讯 **iLink Bot API**（`ilinkai.weixin.qq.com`，hermes/qwen-code/openclaw 同款）：QR 扫码登录、`getupdates` 长轮询 | ❌ 无官方 SDK（协议简单：纯 HTTP + AES-128-ECB，hermes `weixin.py` 1243 行可逐段移植） | **不需要** | **仅私聊** | 回复须回执 peer 的 `context_token`；`errcode -14` 会话过期需重扫码；纯文本回复 |

> 微信 iLink 是 2026 年微信官方开放的"微信智能体机器人"通道（ClawBot/Qwen Code/hermes 均基于它），凭据经二维码扫码获得，**不是**逆向协议，账号风险与公众号/企业微信同级。
>
> **SDK 结论**：四渠道中三个有官方 Node SDK 直接复用（飞书/企微/QQ），唯一需要自写协议的是微信 iLink——且有 hermes 生产级实现逐段可移植。各渠道的"回调验签/AES 解密/token 刷新/分片上传"这类平台机械码全部由 SDK 承担，我们的工作量收敛在：统一消息模型适配、被动回复窗口语义、流式回复对接、管理台表单。

---

## 3. 统一消息模型与渠道运行时（M0，先行）

### 3.1 InboundMessage 扩展（`src/channels/base.ts`）

```ts
export interface MediaAttachment {
  kind: "image" | "file" | "audio" | "video";
  /** 下载到本地媒体缓存后的路径 (喂给 agent 的 read/bash); 入站即下载 */
  localPath?: string;
  url?: string;          // 原始 URL (调试用, 不进 prompt)
  filename?: string;
  mimeType?: string;
  sizeBytes?: number;
}

export interface InboundMessage {
  channelInstanceId: string;
  peerId: string;            // 会话对端 (user_openid / chat_id / ...)
  peerName?: string;
  senderName?: string;
  content: string;
  messageId?: string;        // 平台消息 id (去重键)
  conversationType?: "direct" | "group";
  attachments?: MediaAttachment[];
  /** 被动回复凭据 (QQ msgSeq/iLink context_token/企微 Encrypt): adapter 自管, 网关不解读 */
  replyContext?: unknown;
  raw?: unknown;
}
```

`ChannelAdapter` 契约调整（保持向后兼容）：

```ts
export interface ChannelAdapter {
  // 既有: id/type/name/start/stop/sendMessage/handleWebhook?
  /** 被动回复窗口内发送 (携带 replyContext); 无窗口或超窗返回 false, 网关转 sendMessage */
  sendReply?(peerId: string, content: string, replyContext: unknown): Promise<boolean>;
  /** 平台消息长度上限 (字节); 缺省不主动分段 */
  maxMessageBytes?: number;
  /** 平台 markdown 能力: "full" | "limited" | "plain" (分段前先降级转换) */
  markdownMode?: "full" | "limited" | "plain";
  healthCheck?(): Promise<{ ok: boolean; detail?: string }>;
}
```

### 3.2 渠道运行时（`src/channels/runtime/`，全部渠道共用）

| 设施 | 语义 | 参照 |
|---|---|---|
| `dedupe.ts` | messageId TTL 300s 去重（Map + 定期清理） | hermes `MessageDeduplicator` |
| `coalesce.ts` | per-peer 防抖：quiet window 5s（IM 打字节奏）+ maxWait 30s，只派发合并文本（`\n` 连接），首条立即派发选项留给命令类消息 | hermes `webhook_coalesce.py`（30s/300s 是 webhook 场景，IM 调小） |
| `segmenter.ts` | `maxMessageBytes` 分段：按段落→句子→硬切的 UTF-8 字符边界切分，段落间保持代码块完整性（``` 内不切）；发出间隔 300ms 防平台风控 | hermes `base.py` UTF-16 二分 + `greedy_pack_blocks` |
| `markdown.ts` | markdownMode 转换：plain（QQ 默认/微信）剥表格代码块保留纯文本结构；limited（QQ markdown 需申请） | hermes 各平台 `format_message` |
| `typing.ts` | typing 心跳：agent 处理中每 5s 调 adapter 的 typing 接口（飞书/QQ/iLink 均有），回复落地即停 | hermes `_keep_typing` |
| `media-cache.ts` | `.bot/media/` 入站媒体下载（safeFetch 强制）+ 128MB 上限 + 24h TTL 清理；文件以 `attachments.localPath` 告知 agent | hermes `media_cache.py` |
| `loop-guard.ts` | 群聊防自循环：滑动窗口内同 peer 派发 >N 次（默认 8/60s）熔断并审计告警 | hermes `bot_loop_guard.py` |
| `dispatch.ts` | 组装管道：dedupe → loop-guard → coalesce → (媒体下载) → dispatchInbound | 新增 |

出站投递顺序（`ChannelManager.deliver`）：`sendReply(replyContext)` 优先 → 失败/超窗回退 `sendMessage` → `segmenter` 分段逐条发。**回复窗口语义留在 adapter 内部**（`sendReply` 返回 false 即视作超窗），网关不感知各平台窗口差异。

---

## 4. 各渠道设计

### 4.1 飞书（M1，首个渠道——SDK 长连接，工程量最小）

- **依赖**：`@larksuiteoapi/node-sdk`（官方，`WSClient` WebSocket 长连接，免公网免验签）
- **凭据**（`channel_instances.credentials`，脱敏沿用二期）：`appId`、`appSecret`
- **入站**：`WSClient.start({ eventDispatcher })` 订阅 `im.message.receive_v1`；`chat_id` → peerId；消息在 handler 里**只做入队**（3 秒时限由 SDK 强制，超时重推——去重器兜住重推），实际 agent 调用异步化
- **出站**：`client.im.v1.message.create`（`receive_id_type: chat_id`）；分段后富文本用 `post` 类型；媒体先 `im.v1.media` 上传换 file_key
- **沙盒关系**：出站/媒体在宿主进程，走既有 `safeFetch`/SDK 自带 HTTP
- **群聊**：@机器人 触发（事件里 `mentions`）；loop-guard 开启

### 4.2 QQ（M2）

- **依赖**：官方 `qq-guild-bot` npm（WS 网关 + REST 封装），**M2 首周实测其对 `C2C_MESSAGE_CREATE`/`GROUP_AT_MESSAGE_CREATE` 与群主动消息的支持度**；不满足再退回自实现薄客户端（~400 行，参照 hermes `qqbot/adapter.py`：Hello→Identify→心跳 45s + REST `api.sgroup.qq.com`、token 刷新）
- **凭据**：`appId`、`clientSecret`（沙箱开关 `sandbox: boolean`）
- **入站**：WS `C2C_MESSAGE_CREATE`（单聊）/`GROUP_AT_MESSAGE_CREATE`（群 @）；openid → peerId
- **出站**：被动回复（`msg_id` + `msg_seq` 递增，窗口内）优先，超窗转主动消息（**每月 4 条限制**——定时任务通知走这条时要考虑配额，`delivery` 记录配额消耗）
- **风险**：主动消息配额使"定时任务结果推送"在 QQ 上受限——文档明示用户

### 4.3 微信 iLink（M3）

- **零外部依赖**（hermes `weixin.py` 逐段可移植，纯 HTTP + AES）：QR 扫码登录（`get_bot_qrcode`/`get_qrcode_status` → `bot_token`）→ token 持久化 `.bot/channels/<id>/account.json`（0600）→ `getupdates` 长轮询（35s 超时，断线指数退避 2s→30s）→ `sendmessage`（必须带 `ContextTokenStore` 里该 peer 的最新 `context_token`，磁盘持久化 per account+peer）
- **媒体**：`getuploadurl` 上传 / CDN 下载，AES-128-ECB（key 来自 getconfig）；Node `crypto` 原生支持
- **限制即语义**：仅私聊、纯文本（markdown 降级 plain 分段）、`-14` 过期 → 管理台标记"需重新扫码" + 通知运维渠道
- **风险**：iLink 是微信官方通道但接口无 SLA 承诺，字段可能演进——adapter 内集中所有协议常量

### 4.4 企业微信智能机器人（M4——官方 SDK，全渠道唯一支持流式回复）

- **依赖**：官方 `@wecom/aibot-node-sdk`（`WSClient` WebSocket 长连接，认证帧鉴权——免 HTTP 回调/验签/access_token，**部署面与飞书同级，M4 不再需要反代**）
- **凭据**：`botId`、`secret`（企业微信后台"智能机器人"创建后获取）
- **入站**：`message.text`/`message.image`/`message.file` 等 frame 事件（SDK 自动分发），`chattype: single|group`，群聊带 `chatid`
- **出站**（SDK 能力最全的渠道）：
  - **流式回复**：`replyStream(frame, streamId, chunk, done)`——AgentManager 的 `onChunk` 直接映射为流式帧，终端体验同款"打字机"；分段器只做兜底
  - 模板卡片（按钮交互/更新）、欢迎语（进入会话 5s 内）、`uploadMedia` 分片上传（≤50MB）、`downloadFile`（消息自带 aeskey 的 AES-256-CBC 由 SDK 解）
  - 主动推送 `sendMessage`（单聊 userid / 群聊 chatid）——定时任务通知走这条
- **与"传统企业微信应用消息"的关系**：SDK 面向智能机器人形态（对话式）；若用户已有企微自建应用想走 `message/send` 老接口，另行扩展——M4 不做
- **风险**：aibot 是较新的产品形态，后台开通入口与配额以企业微信管理端为准

### 4.5 Telegram（可选 M5，兜底验证渠道）

官方 Bot API 最简（长轮询/WS 均免公网、无凭据审核）——作为渠道运行时的**验收基准渠道**（一小时可通），验证运行时设施的正确性。按需启用。

---

## 5. 管理台与配置

- **渠道表单按 type 差异化**：`CHANNEL_FORM_SCHEMAS`（factory.ts 注册表扩展）声明凭据字段（label/secret 标志/placeholder），McpView 模式复用 `PairsField`；飞书=appId+appSecret、QQ=appId+clientSecret+sandbox、微信=无（扫码流程）、企微=corpId+corpSecret+agentId+token+encodingAESKey
- **微信扫码流程**：渠道卡片"扫码登录"按钮 → 后端起 QR 会话 → 前端轮询状态（wait/scaned/confirmed/expired）→ 成功显示绑定账号
- **连接健康**：渠道卡片显示 adapter `healthCheck()` 结果 + 最近一次入站时间（`channel_sessions.last_active_at` MAX）
- **消息审计**：channel_instances 维度查看投递账本（成功/失败/重试，参照 hermes delivery_ledger 简化为 `channel_delivery` 表）
- **表单字段声明**：飞书=appId+appSecret；企微=botId+secret；QQ=appId+clientSecret+sandbox；微信=无字段（卡片内扫码）

---

## 6. 安全要点

1. **凭据**：全部走 `credentials` 列（脱敏掩码/还原沿用二期），微信 token 落盘 0600；`safeFetch` 强制媒体下载（SSRF 防线覆盖飞书 CDN/QQ 媒体域）
2. **入站面**：四渠道全部 WS/长轮询入站（企微智能机器人认证帧鉴权、飞书 SDK 自带验签、QQ WS 网关），**不开监听端口**；传统 HTTP 回调仅在企业微信老式应用消息场景才需要（三期不做）
3. **access policy**：`channel_instances.credentials.allowFrom`（peerId 白名单，缺省拒绝群聊陌生 peer）——对齐 hermes `access_policy_mixin`；群聊默认仅 @ 响应
4. **滥用防护**：per-peer 限流（runtime 限流器）+ loop-guard 熔断 + 审计
5. **内容面**：入站媒体大小上限 128MB 流式下载；agent 回复经 markdown 降级后长度受 `maxMessageBytes` 约束（防把 1M 上下文的回答灌进 QQ）

---

## 7. 里程碑与验收

| 里程碑 | 内容 | 验收 |
|---|---|---|
| **M0 渠道运行时** | 统一消息模型 + runtime 七件套 + ChannelAdapter 契约扩展 + Telegram 基准渠道 | Telegram 双向对话 + 分段/防抖/去重/loop-guard 单测全绿；现有 terminal/web 渠道回归不受影响 |
| **M1 飞书** | SDK 长连接 + 富文本/媒体收发 + 管理台扫码外最简表单 | 真实飞书群 @机器人 对话、媒体入站进 agent、主动推送定时任务结果 |
| **M2 QQ** | 薄 WS 客户端 + 被动回复/主动消息双通道 + 配额记账 | 群 @ 与单聊真实对话；超窗自动转主动发送；配额见管理台 |
| **M3 微信 iLink** | QR 登录流程 + 长轮询 + context_token store + AES 媒体 | 个人微信私聊真实对话（文本+图片）；会话过期 → 管理台标记重扫 |
| **M4 企业微信** | `@wecom/aibot-node-sdk` WS 长连接 + **流式回复**（replyStream ↔ onChunk 对接）+ 模板卡片/媒体 | 企业微信智能机器人真实对话（单聊+群聊）；流式回复在企微客户端可见 |

依赖风险：iLink 接口无 SLA（字段演进集中在 adapter 常量层）；QQ 主动消息月配额限制推送场景；飞书 SDK 的 WS 依赖 Bun 兼容性（官方 ws 库，风险低，M1 首验）。

---

## 8. 开放问题

1. **多账号**：同平台多实例（两个飞书应用/两个微信号）——表结构已支持（channel_instances 多行同 type），但 adapter 内 `_LIVE_ADAPTERS` 式静态状态（iLink）需要 per-instance 化；M3 时处理
2. **群聊上下文策略**：群消息是否全部进 agent 上下文（噪声）还是仅 @ 消息 + 窗口内近邻消息？倾向"仅 @ + 引用"，M1 实测定
3. **回复窗口与定时任务的冲突**：QQ 主动消息月 4 条 vs 定时任务通知——需要"配额感知的通知分级"（critical 才走主动消息）还是用户自担？M2 定
4. **渠道抽象与二期通知 dispatcher 的衔接**：`sendNotification` 的 fallback 目前忽略 peer——接入 IM 后 fallback 必须携带真实 peer（来源任务的 notify_peer_id），无目标时跳过而非发往"渠道级假地址"（对齐二期评审 R3 轮意见）
