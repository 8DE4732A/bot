# Bot Agent — 基于 pi-durable 的轻量级多 Agent 平台

> 架构详解、pi-durable 框架理解见 **docs/TECHNICAL.md**；二期设计（SKILL/MCP/统一技能模型，已交付）见 **docs/PHASE2-DESIGN.md**。

基于 `@earendil-works/pi-durable` 的多 Agent 对话网关：零配置文件（一切存 SQLite）、双层安全沙盒、多渠道接入（终端 + 企微/微信/QQ 预留）、免密 Web 管理后台。原始需求见 `INTEND.md`（一期目标：完整 agent 能力、沙盒、终端渠道）。

## 常用命令

```bash
bun install          # 安装依赖（需要本机已安装 Bun）
bun run dev          # 后端开发模式（终端 REPL + Web 管理后台，用已构建的 UI）
bun run dev:web      # 前端开发模式（后端 3000 + Vite HMR 5173，/api 自动代理）
bun test             # 运行全部测试（bun:test）
bun run typecheck    # TypeScript 类型检查（后端 tsc + 前端 web/tsconfig.json）
bun run build:web    # 构建管理后台 → 生成 src/server/ui/generated.ts（内嵌资源）
bun run build:binary # build:web + 编译单二进制到 bin/bot（bun build --compile）
```

- CLI：`bot [start|status|admin] [--port <num>] [--host <addr>] [--no-terminal|--daemon]`
- Web 管理后台：`http://127.0.0.1:3000`（免密，默认只监听 127.0.0.1；端口/地址存于 `system_config` 的 `web_port`/`web_host`）
- 终端 REPL 斜杠命令：`/agent [id]`、`/reset`、`/compact`、`/status`、`/admin`、`/exit`

## 关键约束（改动前必读）

1. **pi 框架依赖为纯 npm**：`@earendil-works/pi-durable`、`pi-ai`、`chord` 在 package.json 中声明为 npm 依赖（1.0.2），`bun install` 后**完全独立运行**——构建/测试/typecheck 均不需要本地 `../pi`。重要事实（第八轮评审实证）：**Bun 运行时恒解析 node_modules 的 dist**，tsconfig paths 对 Bun 运行时无效（仅 tsc 遵循）——因此 tsconfig 已移除框架的 paths 映射，让 typecheck 与运行时同源（dist 1.0.2），消除"类型超前于运行时"的漂移。npm 1.0.2 类型面缺少的少数成员（`watch`/`openBinaryReader` 等）在 `execution-env.ts` 用 `@ts-ignore` + prototype 兼容调用标注（缺方法时走 fail-closed fallback，保持 Result 契约）。`../pi` 本地仓库仅作**源码阅读参考**（理解框架行为时对照 dist 与 src）；上游发布新版本后提升依赖版本号对齐。
2. **零配置文件原则**：会话、Agent、渠道、模型密钥等一切状态只存 SQLite（`<cwd>/.bot/bot.sqlite`），不引入任何配置文件。新增配置项走 `DatabaseStore.getConfig/setConfig` 或建新表（改 `src/database/migrations.ts`）。
3. **cwd 自包含**：所有持久化数据落在 `<cwd>/.bot/` 下（`bot.sqlite`、`workspaces/<agent-id>/`、`logs/`、`skills/`），路径逻辑统一在 `src/config/env-paths.ts`，不要硬编码其他位置。
4. **删除保护**：`agent-default` 和 `terminal-main` 是保留项，`DatabaseStore.deleteAgent/deleteChannel` 会拒绝删除；数据库 bootstrap（`migrations.ts` 里的种子数据）只在全新库执行一次（`bootstrapped` 标记），绝不恢复用户已删除的数据。
5. **运行环境**：Bun + TypeScript strict + ESM（import 带 `.ts` 扩展名，tsconfig 已开 `allowImportingTsExtensions` + `noEmit`）；沙盒仅支持 macOS（Seatbelt）/ Linux（Bubblewrap+Seccomp）。`node:sqlite` 的 `DatabaseSync` 要求 Node 22+ / Bun。
6. **管理后台安全**：免密是需求，但默认只监听 `127.0.0.1` 且**刻意不设 CORS 头**（API 暴露已配置的 API key，禁止跨域读取）。需要局域网访问时用 `--host` 或 `web_host` 配置显式放开。另有 Host/Origin 双校验（信任集含本机网卡地址）、provider 密钥与渠道凭据**响应脱敏**（空值/掩码值提交=保留旧值）、fetch-models/test 库补 key 限定同 apiBase、请求体 1MB 上限、webhook 分发前置豁免（回调方由渠道验签负责）。
7. **沙盒安全模型**（多轮对抗评审的结果，改动前必读）：
   - **平台级无条件禁读**（`.bot` 两个 sqlite/logs/`.env*`/skills 代码/其他 Agent 工作区）同时作用于应用层 PathGuard 与内核层 ASRT denyRead——`kernelDenyRead`（manager.ts）与 `platformDenyRead`（execution-env.ts）必须同步演进，改清单时两处都改；**skills 目录只禁代码（`*.ts`/`*.js`/`node_modules`），SKILL.md 必须放行**（文档型技能正文经 read_skill 供模型按需读取），且 skills 代码 deny 模式不进 inode 指纹收集（glob 会枚举整目录把 SKILL.md 一并指纹化）；
   - **PathGuard 的 `resolveReal`** 是统一逐段迭代解析（symlink/悬空链接/`..`），所有策略匹配与执行都用其结果（`guardRead/guardWrite` 把 `realPath` 传给执行回调，防 TOCTOU）；**inode 指纹**（collectInodesCached，TTL 60s 多槽缓存 + 10000 上限 + lstat 不跟随 symlink）封堵硬链接改名——这两层与路径 deny 缺一不可；
   - **fail-closed 纪律**：argv 数组命令、不支持平台、wrap 失败一律拒绝执行并审计，绝不降级裸跑；
   - **宿主进程 env 不进子进程**：provider 密钥只经 `auth.resolve` 闭包，bash 强制最小环境白名单 `inheritEnv:false`；宿主进程内 fetch（fetch_url）走 `safeFetch`（拒绝内网/回环/元数据，重定向逐跳校验）。
8. **内核网络白名单非实时（评审实证）**：ASRT 的域名过滤判定（`filterNetworkRequest`）读取的是**进程级全局 config**（`initialize`/`updateConfig` 时刻的清单），`wrapWithSandbox` 的 `customConfig.network` 只决定"是否启用网络限制"，**不更新代理的域名规则**；本项目从不调 `updateConfig`，故内核层白名单冻结在首个执行 bash 的 Agent 的配置上。应用层（read/write 的 PathGuard）是实时的（env 回调每轮从库重读）。多 Agent 各自域名配置下内核层会用错清单——根治需要 per-agent 代理（ASRT 架构限制），短期可在 `wrapCommand` 前检测配置变化并调 `updateConfig`（有微小竞态窗口，方向是最近一次 wrap 的配置）。
9. **已知 backlog**（评审确认非阻碍性但记录在案）：temperature 是死配置（pi-durable AgentState 无该字段）；`env.cleanup()` 未接入（优雅退出由 harness.close join 任务覆盖，SIGKILL 场景接受）；safeFetch 的 DNS TOCTOU 需 runtime 层 dispatcher；删除 Agent 后 conversations.sqlite 的孤儿会话无框架删除 API（重置=删库文件）；INODE_ENTRY_LIMIT 截断后超出部分依赖内核层路径 deny；**ASRT 内置网络代理与宿主 TUN 代理（Fake-IP 198.18/15）环境不兼容**——白名单外域名正常拦截，但白名单内域名的 CONNECT 经代理挂起（实测 2026-10，宿主 Clash 类 TUN 环境），内核出网功能性失效（方向 fail-closed 不出数据）；网络层白名单在该环境下不可依赖，需 ASRT proxy 支持上游宿主代理或改用 TUN 层白名单。**内核违规监控（violation monitor）已开启**（`initialize(…, enableLogMonitor=true)`，事件经 subscribe 落 `sandbox.violation` 审计并归因 agent），但 macOS 上 file-read/file-write 类 deny 事件只记 debug 级内核日志且不带规则 logTag（实测 deny 行无 message 后缀，monitor 的 ENDSWITH 谓词匹配不到）——file 类内核拦截当前仍无审计，文件边界审计依赖应用层 PathGuard；sysctl/代理拒绝等带 logTag 的事件可正常捕获归因。**二期四轮对抗评审（herdr Claude+Codex）收敛记录**：终态双方 NO BLOCKING ISSUES；遗留 MINOR backlog——同 server 内工具名净化碰撞的 base 归属已按 name 排序确定化（listTools 顺序无关）；MCP 工具名全局唯一靠"重建时排除 MCP 自身 + id 排序 + 64 字符截断"，跨进程重启后的 transcript 旧工具名兼容未做；mcp_servers 表无 CHECK 约束（id 格式靠 API 层校验）；`.bot/skills/mcp__<id>/` 目录撞 MCP id 时 SKILL.md 被 shadowed（有诊断）；混合技能删除 index.ts 后 registry 保留旧工具条目（目录名 id 存活，文档面 stale）。

## 架构

```
src/
├── cli.ts                  入口：命令解析 → init(AgentManager) → WebServer → 渠道注册 → REPL/守护
├── config/
│   ├── env-paths.ts        <cwd>/.bot/ 路径计算与目录保障
│   └── database-store.ts   全部数据模型的 CRUD（Agent/Provider/Channel/Session/Audit/Config）
├── database/
│   ├── index.ts            DatabaseManager 单例（WAL、busy_timeout、foreign_keys）
│   └── migrations.ts       建表 + 一次性 bootstrap 种子（默认 providers/agent/终端渠道/端口）
├── core/
│   ├── event-bus.ts        平台事件总线 (进程内 pub/sub): 事件源只发布事实,
│   │                       消费方 (渠道通知/webhook 推送) 订阅; 见 events.ts 类型
│   ├── agent-manager.ts    AgentManager 单例：pi-durable Harness 生命周期、会话缓存
│   │                       (LRU 上限 100) 与恢复、**同会话串行锁**（withSessionLock，
│   │                       防 watch 互踩与会话双重创建）、流式 chat、reset/compact、
│   │                       shutdown()（退出时 checkpoint 会话库）
│   └── model-factory.ts    BYOK 模型提供商：4 种协议（openai-completions/responses、
│                           anthropic-messages、google）、/v1/models 远程发现、连通性测试
├── sandbox/
│   ├── manager.ts          SandboxRuntimeManager：ASRT 内核级沙盒（bash 命令包装）；
│   │                       包装失败 **fail-closed** 拒绝执行（不降级裸跑）
│   ├── path-guard.ts       PathGuard：应用级路径边界（denyRead/denyWrite/allowWrite + 通配符）
│   └── execution-env.ts    SandboxedExecutionEnv extends NodeExecutionEnv：
│                           覆写全部文件读写/命令方法，读走 PathGuard、exec 走 ASRT 包装；
│                           所有拦截写入 audit_logs 表（Web 审计页数据源）
├── scheduler/
│   ├── schedule.ts         调度纯计算（无项目内依赖，独立成模块防循环依赖）：
│   │                       computeNextRunAt（once/every/cron）+ cron 校验（croner）
│   ├── index.ts            SchedulerManager：宿主进程 1s 轮询到期任务，触发 =
│   │                       AgentManager.chat(agentId, `scheduler:<taskId>`, …)——
│   │                       任务会话复用同一 conversation；先占坑再执行（防重复
│   │                       触发）；重启 catch-up 补跑一次；once 跑完标记 done
│   └── tools.ts            系统级工具组技能 "scheduler"（schedule_create/list/
│                           update/delete）；归属经 conversationId 反查（fail-closed，
│                           模型不可伪造），update/delete 只作用于本 Agent 的任务；
│                           创建时记录通知目标（来源渠道+peer，渠道层寻址）
├── notifications/
│   └── dispatcher.ts       NotificationDispatcher：订阅 EventBus 的
│                           scheduler.completed 事件 → 寻址推送（任务记录的
│                           通知渠道优先，fallback 到 Agent 绑定的启用渠道）；
│                           新渠道实现 sendMessage 后自动接入通知
├── skills/
│   ├── registry.ts         SkillRegistry 单例：三类统一技能（kind: extension/skill/mcp）；
│   │                       内置技能 coding-tools/web-search/datetime/frontend-design
│   ├── document-skills.ts  文档型技能：SKILL.md frontmatter 解析/校验 + 渐进披露目录渲染
│   ├── builtin/            内置技能实现（defineExtension/defineTool + typebox）；
│   │                       skills-catalog.ts = 常驻扩展（available_skills section +
│   │                       read_skill 工具，承载文档型技能的目录注入与正文读取）
│   ├── mcp/bridge.ts       MCP 桥接：配置表 → 官方 SDK 连接 → 工具动态注册为
│   │                       Extension（mcp__<id>）；懒重连、exposure/toolExposure、
│   │                       描述截断、每次调用写审计；sync() 热更新即刻生效
│   └── loader.ts           扫描 <cwd>/.bot/skills/：SKILL.md → 文档型条目（id=目录名），
│                           index.ts → 工具型 Extension（现状不变；同 id 冲突 extension 优先）
├── channels/
│   ├── base.ts             ChannelAdapter 接口（id/type/start/stop/sendMessage）
│   ├── factory.ts          渠道工厂：CHANNEL_TYPES 注册表 (type → 构造器) 实例化
│   │                       adapter；新渠道只需实现 ChannelAdapter 并登记一行；
│   │                       terminal 不经工厂（由 CLI 特殊管理）
│   ├── manager.ts          ChannelManager 单例：startAll 从数据库配置实例化并启动全部
│   │                       已启用渠道；按 boundAgentId 路由分发消息
│   ├── terminal/index.ts   本地 REPL 渠道（terminal-main）+ 斜杠命令；
│   │                       动态 prompt（agent·model·ctx%）+ 每轮统计行
│   │                       （↑↓ R/W 缓存 · CH 命中率 · ctx 上下文占比 · $ 耗时）
│   │                       + /status 可观测面板（会话累计）
│   ├── terminal/stats.ts   统计渲染纯函数（可测试）：数据源 = watchEvents 的
│                           usage_changed 事件（会话累计）+ 轮前 snapshot 差值；
│                           当前上下文 = 本轮 prompt 侧（累计值会虚高，勿改）
│   └── adapters/           wecom/weixin/qq 适配器（二期实现真实连接，现为占位）
└── server/
    ├── server.ts           AdminWebServer：原生 node:http + REST API（providers/agents/
    │                       channels/skills/audit-logs/chat SSE 流式），默认监听
    │                       127.0.0.1、无 CORS（见约束 6）；静态服务 serveStatic()
    │                       从 generated.ts 提供 SPA 资源 + hash 资源长缓存 + SPA 回退；
    │                       playgroundSession() 统一 Web 对话会话 key；handleDelete()
    │                       收敛 DELETE 样板
    └── ui/generated.ts     ⚠️ 生成文件（scripts/embed-web.ts 从 web/dist 生成），
                            内嵌全部前端产物；随源码提交使 bun test 开箱即跑

web/                        管理后台前端（React 19 + Vite + TypeScript，见下「前端」）
scripts/
├── embed-web.ts            web/dist → src/server/ui/generated.ts（build:web 自动执行）
└── dev-web.ts              并行启动 Bun 后端 + Vite Dev Server（dev:web）
```

### 管理后台前端（web/）

- **栈**：React 19 + Vite + 原生 CSS（无 CSS 框架）；字体 @fontsource/instrument-sans + ibm-plex-mono（打包内嵌，离线可用）。运行时零新增依赖（全部打进产物）。
- **结构**：`web/src/` 下 `App.tsx`（壳 + 极简 hash 路由 + **视图注册表**——新视图只需在 VIEWS 表加一行）、`api.ts`（fetch + SSE 流解析）、`types.ts`（后端类型副本）、`components/ui.tsx`（Icon/Toast/Modal/ConfirmButton/Field/Empty/useAsync/**useFormDialog**——列表页弹窗统一单状态）、`views/`（Overview/Agents/Providers/Channels/Chat/Audit）、`styles/base.css`（设计 token + 全部样式）。
- **与后端共享代码**：vite alias `@bot-core` → `../src`，仅限**无 node 依赖的纯数据模块**（如 `config/sandbox-defaults.ts` 沙盒默认值——migrations 与前端表单共用，防止两处漂移；type-only import 不会把 node:sqlite 拉进 bundle）。
- **设计语言**：浅色工程工作台；色彩只做状态语义（青绿=运行/启用，琥珀=警告，砖红=危险）；**机器数据层**——所有 ID/模型名/URL/时间戳渲染为 mono（`.mono`）；签名元素为 Agent 卡片左侧状态轨（`.card--rail`）。改视觉从 `base.css` 的 token 入手。
- **工作流**：改 UI 一律改 `web/src/`，`bun run dev:web` 热更新；改完 `bun run build:web` 重新生成内嵌资源（generated.ts 需随改动提交）。后端 API 不变时前端可独立开发。
- **对齐约束**：表单保存的默认值（temperature 0.7、thinkingLevel medium、denyWrite `['.git','*.pem','*.key']` 等）需与后端 migrations.ts 种子保持语义一致。

### 消息流转

```
渠道(Terminal/Web/API) → ChannelManager.dispatchInbound
  → 按渠道配置解析 boundAgentId（缺省 agent-default）
  → AgentManager.chat(agentId, `${channelInstanceId}:${peerId}`, text, onChunk)
      → getOrCreateConversation：channel_sessions 表恢复或新建 pi-durable Conversation
        （每次都会 conv.configure 同步最新模型/instructions/cwd/skills）
      → conv.submit + watch 流式回调（delta / toolCall）→ commit
  → 回调输出到终端 / SSE / JSON
```

### 双层沙盒

- **内核级**：`SandboxRuntimeManager` 用 `@anthropic-ai/sandbox-runtime` 包装 bash 命令（网络域名白名单 + 文件读写边界）。包装失败 **fail-closed**：拒绝执行并审计，绝不降级为裸跑（仅 `enabled:false` 或不支持的平台上直连）。
- **应用级**：`SandboxedExecutionEnv` 在 pi-durable 执行环境层**机制级拦截全部带路径的文件方法**——读类走 `guardRead`、写类走 `guardWrite`（含 `listDir`/`exists`/`watch`/`createTemp*` 等元数据与临时资源），新增框架方法按同一模式接入；`PathGuard` 按 agent 的 `sandbox.filesystem` 规则校验（deny 优先于 allow；写操作必须命中 allowWrite；支持 `*` 通配符与 `~` 展开）。
- **审计闭环**：所有拦截（读/写/命令执行）写入 `audit_logs` 表（Web 后台「沙盒审计」页数据源）并同步 `.bot/logs/audit.log`。
- 多 agent 沙盒策略经 `wrapWithSandbox` 的 `customConfig` 逐命令生效（ASRT 全局 initialize 只承担基础设施就绪）。

### 数据模型（双文件分库）

- **业务库 `<cwd>/.bot/bot.sqlite`**：`DatabaseManager`（`node:sqlite`）管理，表：`system_config`、`model_providers`、`agents`、`channel_instances`、`channel_sessions`（主键 channel_instance_id+peer_id）、`mcp_servers`、`scheduled_tasks`（逻辑删除：deleted_at）、`audit_logs`。schema 由 `migrations.ts` 建。
- **会话库 `<cwd>/.bot/conversations.sqlite`**：pi-durable 状态机专用（`openNodeSqliteStorage` 自建自管：`conversations`、`entries`、`tasks`、`submissions`、`documents`、`durable_*` 等表与 `durable_schema` 版本迁移）。**业务代码不得触碰**——升级框架时由它自己的 schema 迁移负责；要重置全部会话直接删此文件即可。
- 两库仅通过业务库 `channel_sessions.conversation_id` 软引用关联（无外键）。

### 管理后台 API（server.ts）

`/api/status`、`/api/config`（GET/POST）、`/api/providers`（GET/POST/DELETE）、`/api/providers/fetch-models`、`/api/providers/test`、`/api/agents`（GET/POST/DELETE）、`/api/channels`（GET/POST/DELETE）、`/api/skills`、`/api/mcp-servers`（GET/POST/DELETE；headers/env 脱敏语义同渠道凭据）、`/api/mcp-servers/test`（连接试测，不落库）、`/api/scheduled-tasks`（GET 全部 Agent 的任务 / DELETE 逻辑删除）、`/api/audit-logs`、`/api/chat`（POST，Accept: text/event-stream 时走 SSE 流式）、`/api/chat/reset`。

保存 provider/agent 后需调用 `AgentManager.reloadModels()` 热刷新 pi-ai 模型注册（server.ts 中已这样处理）。

## 约定

- **单例**：`DatabaseManager`、`AgentManager`、`ChannelManager`、`SkillRegistry` 均为 `getInstance()` 单例；`DatabaseStore` 可自由实例化（内部委托单例）。
- **日志**：统一 `src/utils/logger.ts` 的 `logger.debug/info/warn/error(tag, msg)`；安全审计用 `logger.audit` / `DatabaseStore.recordAudit`。debug 级别需 `DEBUG` 或 `BOT_DEBUG` 环境变量。
- **技能（三类统一模型）**：`agent.skills: string[]` 是唯一选配真相，三类条目混排其中：
  - **工具型** (`kind: "extension"`)：新内置技能在 `src/skills/builtin/` 用 `defineExtension`/`defineTool` + typebox 定义，并在 `registry.ts` 的 `registerBuiltins()` 注册；用户自定义放 `<cwd>/.bot/skills/<name>/index.ts`，`export default { id, name, description, extension }`；
  - **文档型** (`kind: "skill"`)：`<cwd>/.bot/skills/<name>/SKILL.md`（frontmatter：name?/description?/disable-model-invocation?），纯数据不执行；skills-catalog 常驻扩展把已选配条目渐进披露进系统提示词，模型用 `read_skill` 工具按需读正文（不依赖 coding-tools 的 read）；
  - **MCP** (`kind: "mcp"`，id=`mcp__<serverId>`)：管理台「MCP 服务」页配置（stdio/HTTP），`McpBridge.sync()` 桥接为动态 Extension；pi-durable 会话按名字解析扩展，registry 同名 install 即刻生效（含既有会话）。
  - **定时任务**（内置技能 `scheduler`）：`schedule_create/list/update/delete` 四工具；任务归属创建它的 Agent（经 `api.conversationId` → `AgentManager.getAgentIdForConversation` 反查，fail-closed）；触发由 `SchedulerManager`（cli 启动）执行，会话 key `scheduler:<taskId>` 天然复用同一 conversation；interval 最小 60s（防高频烧 token）；删除为逻辑删除。**触发结果经事件机制推送渠道**：SchedulerManager publish `scheduler.completed` → NotificationDispatcher 按"任务记录的通知目标（来源渠道+peer）→ Agent 绑定渠道兜底"投递——渠道层寻址与会话无关，会话重置不影响；通知目标依赖真实渠道映射行（`chat` 的 `origin` 参数写入，`getSessionByConversation` 优先非哨兵行）。
  - skills-catalog 本身**不注册进 SkillRegistry**（避免出现在选配列表），但必须在 `AgentManager.init` 显式 `registry.install`——会话按名字解析，缺注册物会被静默丢弃。
- **新渠道**：实现 `ChannelAdapter` 接口，在 `ChannelManager` 注册；渠道实例与 Agent 的绑定关系存 `channel_instances.bound_agent_id`。
- **测试**：`test/` 下 9 个套件（paths/database/sandbox/skills/server/phase2/scheduler/notifications 等），基于 `bun:test`，多为真实文件系统 + 真实 HTTP 端口的集成测试；server 测试已隔离到临时目录（测试顶部显式 `DatabaseManager.getInstance(临时路径)` + `logger.init(临时目录)`，新增测试套件须沿用此模式，勿写真实 cwd 的 `.bot/`）；**单例被全部套件共享（首个 getInstance 绑定生效），任何套件不得 rmSync 单例库文件所在目录**，否则并行套件会 disk I/O error。
- 代码中的中文注释/命名（如技能名称、终端 banner）是刻意为之，保持一致。
