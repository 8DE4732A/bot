# Bot Agent 技术文档

> 面向后续开发者的架构说明、框架理解与演进路线。基础用法见 `README.md`，工作约定见 `CLAUDE.md`。
> 本文沉淀自 2026-10 一期开发与 7 轮对抗式架构评审（详见 §7）。

---

## 1. 项目定位与一期现状

**定位**：基于 `@earendil-works/pi-durable` 的轻量级多 Agent 对话网关——hermes agent 的轻量替代。核心主张：

- **零配置文件**：一切状态存 SQLite（`.bot/` 下双库），`cwd` 自包含，单二进制分发
- **双层沙盒**：应用层路径防护 + 内核层 ASRT（macOS Seatbelt / Linux Bubblewrap）
- **多 Agent × 多渠道解耦**：渠道实例绑定任意 Agent，互不串扰

一期已交付：终端 REPL 渠道、免密 Web 管理台（React 19 + Vite，构建产物内嵌二进制）、BYOK 模型服务商（4 种协议）、技能系统（内置 4 个 + 本地动态加载）、双层沙盒 + 审计闭环、对话调试 Playground（SSE 流式）。企微/微信/QQ 渠道为二期目标（适配器占位 + webhook 挂载点已就绪）。

---

## 2. 对 pi-durable 的理解

pi-durable 是 pi monorepo（`../pi`，作者 Mario Zechner）中的实验性框架，自称 *"durable conversation, task, and document runtime"*。它解决的问题是：**让 agent 的对话、任务、文档成为可崩溃恢复的持久状态机**，而不只是内存里的消息数组。

### 2.1 分层模型

```
chord (底层运行时)
  └─ 事务性文档存储: Tx / Draft / 文档族 (docs["pi.live"] 等)
  └─ Context: 请求作用域 (含 abortSignal); BACKGROUND_CONTEXT 是空实现
pi-durable
  ├─ Harness        应用级编排器: 持有 storage/models/registry, 管理会话集合
  ├─ Conversation   一次持久对话: submit → (运行) → commit 的生命周期
  ├─ Entry          一切状态都是追加条目 (AssistantEntry 等), 不可变历史
  ├─ Env            工具执行环境抽象 (文件/shell), NodeExecutionEnv 为默认实现
  ├─ Registry       Extension 注册中心 (defineExtension/defineTool/hook/section)
  └─ SqliteStorage  自带连接/WAL/串行事务队列的状态机存储
```

### 2.2 核心心智模型

- **一切皆文档**：运行中状态（`pi.live`）、Agent 配置（`pi.agent`）、收件箱（`pi.inbox`）、用量（`pi.usage`）都是事务性文档。Durable 的含义是：任意时刻 kill 进程，重启后 `harness.resume()` 会把 running 任务重放为 pending，对话不丢。
- **提交式交互**：用户消息走 `conv.submit({type:"input", content})` → `submission.wait()` → 拿到 `settled.answer` 后必须 `conv.commit(tx => tx.entry(AssistantEntry, settled.answer))` 才真正入历史。框架的 `coding-agent` 示例（`../pi/packages/coding-agent/src/experimental/vacation/`）是该用法的权威参照。
- **Agent 配置与会话解耦**：创建会话时传入 `{model, thinkingLevel, instructions, cwd, extensions}`；后续用 `conv.configure(AgentChange)` 变更——**extensions 支持数组整体替换**（`harness/agent.ts:99-110`），这是本项目"技能热更新"的实现基础。
- **Env 回调每次使用时重建**：`HarnessOptions.env(target)` 在每个工具轮次被调用（含崩溃恢复的重放任务）。这意味着：env 层的安全策略必须 fail-closed（查不到归属就拒绝），且不能依赖回调只发生一次。
- **watch vs watchEvents**：`conv.watch()` 返回 view 文档流（需要读 `docs["pi.live"]` 内部结构）；`watchEvents(harness, conversationId, ctx)` 返回**类型化事件流**（`text_delta` 经由 `message_update.changes`、`tool_execution_start/update/end` 等）。后者是公开 API（主入口导出），框架升级有编译期兜底——**始终用它**。

### 2.3 实测确认的关键契约（踩坑沉淀）

| 契约 | 说明 | 项目中的落点 |
|---|---|---|
| `harness.conversation(id)` 对不存在记录**返回 undefined 不抛错** | 删除会话库后旧映射不会报错而是静默 `undefined` | `agent-manager.ts` 显式判 undefined → 新建会话自愈；抛错视为瞬时错误上抛 |
| `conv.configure()` 是一次事务提交 | 每条消息都调会多一次 SQLite 写事务 | 配置指纹（provider/model/thinking/instructions/cwd/skills）未变化时跳过 |
| bash 工具固定 `inheritEnv: true` 且 spill 用 `createTempFile` | 子进程默认继承宿主全部 env；大输出落 os.tmpdir | 执行环境强制最小环境白名单 `inheritEnv:false`；`createTemp*` 放行不套业务 allowWrite |
| `Harness.close()` 会 join 全部任务；`storage.close()` 做 WAL checkpoint | 直接关 storage 会硬杀在途任务 | `AgentManager.shutdown()` 先 harness.close 再 storage.close |
| `ToolSlot` 等内部结构在 npm 与本地源码间**已经漂移过**（name 字段曾删除） | `as any` 读内部文档无编译期信号 | 禁止读内部文档，一律 watchEvents / 类型化 API |
| `durable` 表名无前缀（conversations/entries/…） | 与业务表共存会冲突 | 双库分储：`bot.sqlite`（业务）/ `conversations.sqlite`（状态机） |

### 2.4 pi-durable 的扩展机制与 pi 生态的关系

**durable 的 Extension 是声明式代码包**（`Extension<Tool>`），一个扩展可注册五类东西：

| 注册物 | 能力 |
|---|---|
| `tools` | typebox 参数 schema + `execute(args, api, ctx)`；支持 `replay`（崩溃恢复重跑安全性）、`executionMode`（顺序/并行）、`prepareArguments`（模型坏参修复）、`outputLimits` |
| `sections` | 系统提示词段，每次请求前按序渲染（可异步）——给 Agent 注入使用说明的挂点 |
| `hooks` | 按 task 名挂生命周期钩子 |
| `wraps` | 纯函数包装**其他扩展**的工具或 section（横切增强，如日志/限流/改写） |
| `tasks` | 自定义 durable 任务定义（持久后台任务） |

工具运行时拿到的 `ToolExecutionApi` 能力很强：`env`（受沙盒管束的执行环境）、`commit()`（在工具内发起事务）、`memo()`（持久 KV）、`createTask()`（从工具内创建子任务）、`output()` 流式输出、`registry` 快照。即**扩展不是孤立的函数，而是能在持久状态机内做一切事的代码**。

会话按**名字**选择扩展（存于 `pi.agent` 文档）：数组=精确选择，`{add,remove}`=编辑宿主默认；`tools` 字段可再过滤所选扩展的工具面。Registry 的 install/uninstall 即时发布——这就是本项目技能热更新的底层。

**与 pi（coding-agent）扩展生态的关系**：不兼容，是两套 API。pi 编码助手的 `ExtensionAPI`（`coding-agent/src/core/extensions/types.ts`，约 1600 行）是**宿主事件总线**风格——订阅 `session_before_compact`、`before_provider_request`、`agent_before_settle` 等宿主生命周期事件，深度绑定其 TUI/session/provider 拦截层；而 durable 的 Extension 无宿主事件，是纯声明式注册。因此 pi 编码助手的扩展**不能直接装进本项目**。可行路线：(a) 多数 pi 扩展的核心是自定义工具，逻辑可低成本包成 `defineTool` 移植；(b) 正道是 **MCP 桥接**。

**MCP 的分层事实**：durable 本体零 MCP 代码；MCP 支持是 pi 宿主（coding-agent）用 durable 的 Extension 机制自己实现的——`packages/mcp` 是纯协议客户端库（`McpClient`/Stdio/HTTP/OAuth），`coding-agent/src/extensions/mcp/runtime.ts`（474 行）是完整的"server → durable tools"桥接参考实现（连接生命周期、`listTools` 动态注册、`callTool` 转发、资源读取）。本项目做 MCP 支持即仿此桥接：管理台配置 MCP server → 基于 `packages/mcp` 的 `McpClient` 连接 → 工具动态注册进 `SkillRegistry`（需自行实现的部分：配置 UI、连接生命周期、命名空间隔离——coding-agent 的 `mcp-servers.ts` 的 `mcpNamespace`/registry 模式可参照；其 OAuth/配置解析依赖宿主，不直接搬）。

### 2.5 durable 的"技能"边界：只有积木，没有 skill 概念

pi-durable **没有专门的 skill 概念**——它的原语是 Extension（工具/钩子/任务，代码型）。而 Claude 式的 **Agent Skills**（SKILL.md 文档型技能）是 pi 宿主（coding-agent）实现的，且其注入方式值得照抄：

- `coding-agent/src/core/skills.ts`：发现（目录扫描 + ignore 规则 + frontmatter 校验，`disableModelInvocation` 支持禁止模型自主触发）
- **渐进披露**：`formatSkillsForPrompt()` 只把技能的 name/description/location 注入系统提示词（`<available_skills>` 块），**正文不进上下文**——模型判断任务匹配后用 read 工具自己读 SKILL.md。100 个技能只占几百 token 的目录

映射到 durable：`sections` 承载技能目录清单，`env` 的 read 工具承载按需读正文——durable 提供的是积木，skill 的发现/校验/格式化是宿主职责。

**对本项目**：当前 SkillRegistry 的技能全是工具型（连 frontend-design 都是把规范包成 `get_frontend_design_guidelines` 工具，模型不主动调用就拿不到规范）。缺口是**文档型技能**：`.bot/skills/<name>/SKILL.md`（frontmatter name/description）→ 用 durable `section` 注入目录 → 模型用 read 工具按需读。这样"技能"才完整：工具型（Extension）+ 知识型（SKILL.md），且可直接复用 Claude Code 格式的既有技能资产（如 `.agents/skills/`）。

### 2.6 实验性框架的使用姿势

pi-durable 处于 1.0.x 早期，API 仍在动（`ToolSlot.name` 曾被删除又恢复）。本项目的策略：

1. **纯 npm 依赖**：npm `^1.0.2`，`bun install` 后完全独立（构建/测试/typecheck 均不需要本地 `../pi`）。**关键事实**：Bun 运行时恒解析 node_modules 的 dist，tsconfig paths 对运行时无效（仅 tsc 遵循）——若保留 paths 会出现"类型超前于运行时"的漂移（typecheck 绿但 dist 里没有该 API），因此 tsconfig 已移除框架 paths 映射，typecheck 与运行时同源；npm 1.0.2 缺失的少数 API（watch 等）以兼容调用 + fail-closed fallback 标注（`execution-env.ts`）。升级 = 等 npm 发版后提升版本号。`../pi` 仅作源码阅读参考。
2. **只用公开导出**：`Harness`/`watchEvents`/`AssistantEntry`/`defineTool` 均从主入口 import；凡是需要 `as any` 读框架内部的地方都是升级雷区，一律换成类型化 API 或封装适配层。
3. **对框架行为做实证**：不信任文档记忆，关键契约（undefined 语义、env 重建时机、configure 提交成本、close 链）都在框架源码中核实过（见 `../pi/packages/durable/src/`），部分写入了 `test/` 固化。

---

## 3. 本项目架构

### 3.1 分层与数据流

```
渠道层   Terminal(REPL) / Web Playground / [二期: wecom/weixin/qq]
   │  ChannelAdapter (id/type/start/stop/sendMessage/handleWebhook?)
   ▼
ChannelManager   按库配置实例化 (factory: type → 构造器注册表)、startAll、
   │             dispatchInbound (按 boundAgentId 路由, 悬空绑定显式报错)
   ▼
AgentManager     会话串行锁 → getOrCreateConversation (LRU 缓存 100 +
   │             channel_sessions 反查 fail-closed) → conv.configure (指纹去重)
   │             → submit/wait/commit + watchEvents 流式回调
   ▼
SandboxedExecutionEnv   pi-durable env 的安全实现 (每个工具轮次由框架回调创建)
   ├─ PathGuard          路径 deny / symlink 逐段解析 / inode 指纹
   ├─ ASRT 内核包装       wrapCommand (denyRead 合并平台红线)
   └─ 审计               一切拦截 → audit_logs 表 + audit.log

横切: DatabaseStore (业务库 CRUD) · ModelFactory (BYOK, 4 协议) ·
      SkillRegistry (Extension 注册) · AdminWebServer (静态资源 + REST + SSE + webhook)
```

### 3.2 双库分储

| 库 | 属主 | 内容 |
|---|---|---|
| `.bot/bot.sqlite` | `DatabaseManager`（业务代码） | `system_config` / `model_providers` / `agents` / `channel_instances` / `channel_sessions` / `audit_logs`；`PRAGMA user_version` 版本化迁移（`BEGIN IMMEDIATE` 原子推进） |
| `.bot/conversations.sqlite` | pi-durable 全权管理 | conversations/entries/tasks/submissions/documents + `durable_schema` 版本。**业务代码零接触**；重置全部会话 = 删除此文件 |

两库仅通过 `channel_sessions.conversation_id` 软引用（无外键）。删除 Agent 时清理其映射并拒绝仍被渠道绑定的删除；状态机会话本身成为孤儿（框架无删除 API，见 §6 backlog）。

### 3.3 关键设计决策

- **组合根与懒初始化**：模块 import 期绝不开库（`ModelFactory.store` 是懒 getter；`DatabaseManager` 构造显式 mkdir）。单例只在 CLI main 显式创建路径，测试在 describe 顶部 `DatabaseManager.getInstance(临时路径)` 抢占——否则 import 链会把单例绑死到 `process.cwd()`（一期曾实证污染真实库）。
- **会话串行锁**：`withSessionLock(key)` 是 per-session Promise 链（前序失败不阻塞后续）。Web/渠道并发到达同一会话时严格排队，杜绝 Conversation 双重创建与 watch 互踩。
- **配置指纹去重**：configure 是事务提交，指纹（含 skills）不变则跳过——每条消息零额外写。
- **Web 管理台**：React 19 + Vite 源码在 `web/`，构建产物经 `scripts/embed-web.ts` 转成 `src/server/ui/generated.ts` 内嵌二进制（woff 回退字体已剔除）。开发用 `bun run dev:web`（Vite HMR，`/api` 代理）。前端经 vite alias `@bot-core` 共享后端**无 node 依赖的纯数据模块**（如沙盒默认值），防止前后端漂移。

---

## 4. 安全模型（多轮对抗评审的沉淀）

沙盒的价值取决于最弱一层。以下是当前的三道文件防线与两道网络/入口防线，**改动任何一层前先读 CLAUDE.md 约束 7/8**。

### 4.1 文件防线（三层，缺一不可）

1. **路径 deny**：平台级无条件禁读清单（两个库文件、logs、`.env*`、skillsDir、**其他 Agent 的工作区**）同时作用于应用层 PathGuard 与内核层 ASRT（`kernelDenyRead` + `extraDenyRead`）。**两份清单必须同步演进**——只加应用层时 bash `cat` 旁路原样存在（评审第 2/3 轮两次抓到）。
2. **真实路径解析**（`PathGuard.resolveReal`）：统一逐段迭代队列，处理 symlink/悬空 symlink/`..`；**校验与执行用同一真实路径**（`guardRead/guardWrite` 把 realPath 传给执行回调），符号链接翻转的 TOCTOU 竞态在结构上失效。`/tmp → /private/tmp` 这类部署路径 symlink 是常态，词法坐标系统一前平台红线曾整体失效。
3. **inode 指纹**：硬链接是同一文件的第二个名字，路径 deny 拦不住（ASRT 官方文档：macOS 对 hardlink "nothing is promised"）。`collectInodesCached` 对平台保护文件收集 `dev:ino`（glob 展开 + 目录枚举，lstat 不跟随 symlink 防遍历逃逸，10000 上限 + TTL 60s 多槽 LRU 缓存摊销成本），读写两侧命中即拒。

### 4.2 网络与宿主防线

- **bash 出网**：ASRT 域名白名单（deny-by-default）；`allowLocalBinding` 默认 **false**（免密管理台就在本机回环，放行 = agent 可直连管理 API）。
- **宿主进程内 fetch**（`fetch_url` 等工具）：ASRT 管不到，走 `safeFetch`——拒绝回环/私网/链路本地/云元数据（含 NAT64/6to4 编码），DNS 解析校验，重定向逐跳重新校验，流式读取按 maxBytes 中止（防 OOM）。
- **密钥零暴露**：provider 密钥只经 `auth.resolve` 闭包从库取（**不写 process.env**）；bash 子进程强制最小环境白名单 `inheritEnv:false`；API 响应脱敏（provider apiKey、channel credentials 掩码，空值/掩码提交 = 保留旧值）；`fetch-models`/`test` 从库补 key 限定同 apiBase（否则管理 API 就是"把密钥发往任意 URL"的通道），且全部写审计。
- **管理台**：Host/Origin 双校验（信任集 = 回环 + 本机网卡地址）；请求体 1MB 上限；webhook 分发前置豁免（回调方是服务器非浏览器，真伪由渠道验签负责）。
- **fail-closed 纪律**：argv 数组命令、不支持内核沙盒的平台、wrap 失败、未知会话归属——一律拒绝执行并写审计，绝不降级裸跑。

### 4.3 已知边界（有意取舍，勿当作 bug 修）

- `INODE_ENTRY_LIMIT=10000` 截断后超出部分的文件失去硬链接指纹（路径 deny 与内核层仍在）——枚举失控目录树的 DoS 风险换来的有界权衡
- `safeFetch` 的 DNS TOCTOU：lookup 校验与 fetch 实际解析之间的 rebinding 窗口需 runtime 层自定义 dispatcher 才能关闭
- `env.cleanup()` 未接入：优雅退出由 `harness.close()` join 任务覆盖（长命令会跑完再退出）；SIGKILL 场景接受孤儿进程
- temperature 是死配置：pi-durable `AgentState` 无该字段，DB 列保留但永不生效

---

## 5. 二期实现思路

### 5.1 渠道接入（企微 / 微信 / QQ）——核心工作

现有扩展点已就绪：`ChannelAdapter.handleWebhook(pathname, query, body)`（管理台把 `GET/POST /api/channel-webhook/<id>` 前置转发，豁免管理台 Host 校验）、工厂注册表（`CHANNEL_TYPES` 加一行）、`dispatchInbound` 路由。企微回调模式的实现路径：

1. **验签**：`handleWebhook` 内做 signature/timestamp/nonce 校验与 AES 解密（凭据在 `channel_instances.credentials`，注意响应脱敏语义——掩码值提交自动还原）
2. **消息 → Agent**：解析出 peer（用户/群 id）后调 `ChannelManager.dispatchInbound`，会话 key 即 `channelInstanceId:peerId`，串行锁与上下文恢复自动生效
3. **回复语义**：企微被动回复有 5s 窗口——模型调用通常超时。采用"立即 200 空回 + 主动发送"：`sendMessage` 走企微 API（access_token 缓存在 adapter 实例内，过期刷新）
4. **需要补的通用设施**（在 ChannelManager 或新 base 类）：
   - 长**文本分段**：IM 单条消息长度上限，按段落切分排队发送
   - **防抖合并**：用户连发多条时合并为一次 agent 调用（会话锁天然排队，可在此基础上做窗口合并）
   - **per-peer 限流**与黑名单（防滥用烧 token）
   - 媒体消息占位（图片/文件：先存 workspace 再以路径告知 agent）
5. **部署前提**：webhook 需要公网可达——必须 TLS 反代（nginx/caddy）+ `web_host` 放开；管理台 Host 校验信任集已含本机网卡，反代透传 Host 需评估（建议反代后管理台仍走内网，仅 `/api/channel-webhook/` 暴露公网）

### 5.2 会话运营

- **历史查询/导出**：pi-durable 的文档 API（`ConversationView`/entries）可读任意会话历史——做"按 Agent/渠道列出会话 + 导出 markdown"的管理台页面。注意只走类型化 view，不碰内部文档
- **孤儿 GC**：等框架提供会话删除 API；在此之前删除 Agent 时把 `conversation_id` 列表写入一张 tombstone 表（业务库），GC 任务按表清理
- **上下文策略**：`conv.compact()` 已在终端暴露；二期把自动 compaction 策略（阈值触发）接入 AgentManager

### 5.3 模型与技能

- **sampling 参数**：temperature 当前无处挂——pi-durable `AgentState` 不含它。解决路径在 pi-ai 层：`ModelFactory.buildProviderInstance` 时把 per-agent 采样参数注入 stream 选项（需确认 pi-ai 的 stream 选项面），或上游 AgentChange 增加字段后跟进
- **自定义技能**：`<cwd>/.bot/skills/<name>/index.ts` 动态加载已有；技能当前在启动时扫描（新增文件需重启）。二期可加 chokidar 热重载 + 管理台重载按钮
- **MCP 桥接**：把 MCP server 的工具包成 `defineTool` Extension 注册（`registry.ts` 的 `registerBuiltins` 模式），是接入生态的低成本路径
- **技能上下文注入**：`section`/`hook`（pi-durable 提供）可给 Agent 注入技能使用说明——当前内置技能只注册了工具，提示词引导是空缺

### 5.4 运维与部署

- 守护模式 + systemd unit（`--no-terminal`）；日志轮转（当前 appendFileSync 无轮转）
- `web_host` 公网场景的前置检查清单（TLS、反代、webhook 路由）
- 备份：业务库 + 会话库分开备份（密钥库考虑操作系统 keychain 或加密存储——当前明文是有意的零配置取舍）

### 5.5 建议排序

1. **企微回调渠道**（验证 webhook 挂载点与分段/防抖设施，是一期的价值闭环）
2. 会话历史管理页（复用文档 API，低风险高价值）
3. 技能 section 注入 + MCP 桥接
4. compaction 自动化 / per-peer 限流
5. temperature 挂点、密钥加密存储（跟随上游或用户需求）

---

## 6. 开发速查

```bash
bun run dev / dev:web   # 后端 / 前端 HMR
bun test / typecheck    # 18 tests; tsc 双工程
bun run build:web       # 构建管理台 → src/server/ui/generated.ts (提交进 git)
bun run build:binary    # 含 build:web 的单二进制
```

- 框架 API 有疑问：直接读 `../pi/packages/durable/src/`（tsconfig paths 已映射）
- 新增渠道/技能/视图：见 CLAUDE.md「约定」——工厂注册表、`registerBuiltins`、App.tsx `VIEWS` 表各一行
- **测试隔离纪律**：新测试套件必须在顶部 `DatabaseManager.getInstance(临时路径)`，勿写真实 `.bot/`
- 安全相关改动：跑 `test/sandbox.test.ts`（hardened 语义组固化了 symlink/硬链接/平台禁读行为）；改禁读清单时 `kernelDenyRead` 与 `platformDenyRead` 两处同步

## 7. 方法论备注：对抗式评审循环

一期收尾用了 7 轮双 agent（Claude + Codex，经 herdr 在同 tab 空上下文评审）对抗循环：每轮两份独立报告 → 修复 → 下一轮验证修复质量并找新问题，直到双方 "NO BLOCKING ISSUES"。有效的原因：

- **空上下文评审员不带实现偏见**，且两个模型擅长面不同（Codex 多次用运行时实证抓到"修复实际未生效"——glob 坐标系错误、测试用 symlink 冒充硬链接、Bun 下 close 事件语义；Claude 强于组合攻击链与框架源码交叉验证）
- **修复者自证不可信**：每轮 prompt 要求评审员做运行时实证（临时目录/端口实验），第 4/5 轮的"修复空转"都是这样抓到的
- 报告落盘 `/tmp/bot-reviewN-*.md`，修复清单回写 prompt 作为下轮基线

后续大改动（尤其安全相关）建议沿用此循环。
