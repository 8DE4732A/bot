# 上下文管理与可观测性（七期）

> 2026-10 交付。目标：模型参数自动匹配（models.dev）、普通/定时任务分开的上下文压缩策略、每轮调用持久化观测、Provider/Context 管理台。

## 1. 模型元数据

- 来源优先级：**手动覆盖 > models.dev（provider 精确命中）> pi-ai 内置目录 > 静态前缀表**。
- 目录缓存：`model_catalog_cache`（gzip 后的 `https://models.dev/api.json`，单行）；启动后台刷新（24h TTL，失败静默）+ 管理台手动刷新。`POST /api/model-metadata/refresh` 手动失败返回 502。
- 匹配：provider id / 别名 / apiBase host → 目录 key；模型 id 原样 / 去厂商前缀 / 小写归一 / `canonical_model_id` 唯一回查；歧义不猜。
- **价格只在 provider 精确命中时采用**；跨 provider canonical 回退只补窗口/输出/模态，避免把官方价套到转售商。
- `model_metadata` 存 `auto_json`（最近自动值）+ `manual_json`（部分手动覆盖），effective = merge(auto, manual)；`auto_source` ∈ `models.dev | builtin | fallback`；「恢复自动」仅清空 manual。
- `ModelFactory` 把窗口/最大输出/模态/reasoning/价格/tiers 灌入 pi-ai `Model`；`usage.cost` 由 pi-ai `calculateCost` 按 USD/1M 直接计算。

## 2. 上下文策略

`system_config.context_policy`（JSON，`src/core/context-policy.ts`）：

```ts
{
  normal:    { enabled, percent, minTokens },                  // 默认 0.8 / 20k
  scheduled: { enabled, tokens, maxPercentOfWindow, minTokens }, // 默认 50k / 0.8 / 5k
  safetyTokens, keepRecentCapTokens, emergencyReserveCapTokens,
  timeoutMs, settleTimeoutMs, retentionDays, detailRetentionDays
}
```

- **阈值**：普通 = `window * percent`；定时 = `min(tokens, window * maxPercentOfWindow)`；窗口未知时普通跳过、定时用绝对 tokens；再按 `minTokens` 与 `window - emergencyReserve` 夹住，并保证大于 `keepRecent + 1024`。
- **keepRecent 是框架全局值**（pi-durable 不支持 per-conversation）：`min(0.4 * scheduled.tokens, 10% window, keepRecentCap)`，floor 1k。`0.4×` 上界确保定时任务 50k 阈值一定能选出可切分区间。
- **框架 compaction 只做紧急兜底**：`enabled: true`、`reserveTokens = clamp(5% window, 2k, cap)`、`backgroundTokens: 0`。必须显式设置 harness-wide 基础值，否则窗口未知的模型会落回框架默认 `backgroundTokens=32768`。
- 策略热更新：`AgentManager.applyContextPolicy()` 更新内存快照 + `policyVersion`；settings 函数按 `{models, policyVersion}` 缓存失效，不重开 Harness。

### pre-turn 压缩

在 `AgentManager.chatTurn` 中、`submit` 之前：

1. 有界等待会话真正 idle（`LiveDoc.run/generation/tools/compactions` 为空）；
2. `conv.context()` + `estimateContextTokens()` + 新消息估算 + `safetyTokens`；
3. 超过 profile 阈值 → `conv.compact(instructions, withTelemetry(span, ctx))` → `waitForTask`（超时 90s）→ `waitForIdle` → `context().head/entries` 复核；
4. 成功/跳过/失败/超时写 `compaction_events`；**失败 fail-open**（审计 `context.compact_failed`，本轮继续）；取消则不 submit；
5. 普通会话摘要用框架默认；定时任务 instructions 保留任务目标/进度/待办/约束。

每次 turn 最多前置压缩一次；压缩后仍超阈值也继续。

### 手动 `/compact`

`/compact [额外关注点]` 与管理台「立即压缩」都走同一实现：等待摘要完成、返回前后 tokens/耗时/成本；scheduler 会话按 `scheduler:<taskId>` 走 `openSchedulerConversation`（修复此前压错会话的问题），REST 对 busy 会话返回 409。

## 3. 可观测性

### turn 成本

`harness.snapshot(UsageDoc, conversationId)` 前后差分是**唯一成本真相源**：包含 assistant、compaction 摘要与工具内部模型调用，不重复计费。请求明细只做审计，不求和。

### Telemetry

自研 `ContextTelemetry`（`src/core/context-telemetry.ts`）实现 pi-telemetry 的 `TelemetryContext/TelemetrySpan/TelemetryPropagation`：

- span end 只入内存环形缓冲（5000），turn/压缩结束、每 2s、shutdown 时批量写库；`UNIQUE`/`INSERT OR IGNORE` 幂等。
- 只记录 `pi.ai.request`/`pi.ai.poll`（`llm_requests`）、带 `tool.name` 的 `pi.durable.phase`（`tool_invocations`，按 `tool.call_id` 归并）、`pi.durable.submit`（submission/turn → trace 映射）。
- carrier 携带 `trace/span/conversation/turn/compaction`；submit 前 `beginTurn`、压缩前 `beginCompaction`，scheduler 恢复/异步任务也能归因。
- 不记录 prompt/回复正文；错误信息截断 500 字符；写入失败只告警，不影响会话。

### 指标口径

- **wall**：`llm_turns.started_at → ended_at`（前置压缩完成后开始）。
- **首包 `first_chunk_ms`**：pi-ai `pi.ai.first_chunk`（首个归一化流事件，**不是 HTTP 首字节**）。
- **首字 `ttft_ms`**：watch 首个文本/思考/工具调用 token delta − 首个 generation 请求 start（近似 TTFT）。
- **工具耗时**：`tool_invocations` 按 call 归并后的跨度之和。
- **上下文 tokens**：最后一条 assistant usage 的 prompt 侧（input+cacheRead+cacheWrite）；`context_estimate_tokens` 为 turn 后 `estimateContextTokens`。
- **成本**：UsageDoc 差分；`priced=0` 表示模型没有有效价格，UI 显示「未定价」。
- 轮内 threshold/overflow 压缩成本已含在 turn；`compaction_events.cost_in_turn=1` 仅作拆分展示；pre_turn/manual 独立记账。

### 数据与保留期

| 表 | 内容 | 默认保留 |
|---|---|---|
| `llm_turns` | 每轮 usage/成本/上下文/时序/状态 | 90 天 |
| `llm_requests` | 每次模型请求 | 30 天 |
| `tool_invocations` | 每次工具调用 | 30 天 |
| `compaction_events` | 压缩事件 | 90 天 |
| `model_metadata` / `model_catalog_cache` | 模型参数与目录缓存 | 长期 |

启动后延迟清理 + 每日批量 `DELETE ... LIMIT 5000`；不做自动 VACUUM；启动时把遗留 `running` turn 标记为 `interrupted`。

## 4. REST API

```
GET/PUT /api/context/policy
GET     /api/context/sessions?agentId=&kind=&from=&to=&q=&limit=&offset=
GET     /api/context/sessions/:conversationId/turns
GET     /api/context/turns/:turnId
POST    /api/context/sessions/:conversationId/compact
GET     /api/model-metadata?providerId=
PUT     /api/model-metadata           { providerId, modelId, overrides } | { reset:true }
POST    /api/model-metadata/refresh
```

会话枚举以 `llm_turns` 聚合，优先 `scheduled_tasks.conversation_id` 判定时任务，其次 `channel_sessions` 真实行判 IM，最后解析 sentinel（含 `scheduler:<taskId>` 形态）。

## 5. 管理台

- 「上下文」页两个 Tab：
  - **会话观测**：stat-strip、Agent/类型/时间/搜索过滤、上下文 meter、累计成本、轮次/压缩数；详情显示每轮 wall/首包/首字/工具/请求数/成本，本地开关展开每次请求明细与工具列表，支持「立即压缩」。
  - **策略设置**：普通/定时卡片、高级参数、每模型有效阈值预览与警告、models.dev 刷新。
- 「模型服务商」页新增「参数」入口：每模型窗口/最大输出/模态/价格/来源（自动/手动/fallback），支持编辑与恢复自动。

## 6. 测试与边界

- `bun test` 覆盖：策略/估算、models.dev 匹配与 manual 合并、UsageDoc 差分、telemetry 缓冲/归因/幂等、真实 Harness + faux 的前置压缩（成功/低阈值/失败 fail-open/手动）、真实 AgentManager + 本地 SSE provider 的端到端 turn/request 落库、REST。
- models.dev 依赖外网；离线用缓存/builtin/static fallback。
- 首包不是 HTTP TTFB；每请求 TTFT 不可得（pi-ai 只暴露 first_chunk），UI 已注明口径。
- 框架 compaction 的 keepRecent/reserve 是全局值；只有阈值按普通/定时分开。
- 多输入排队时 generation 继承首个 submission trace；本项目 session lock 基本串行，turn 总量始终以 UsageDoc 为准。
