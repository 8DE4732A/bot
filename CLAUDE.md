# Bot Agent — 基于 pi-durable 的轻量级多 Agent 平台

> 架构详解、pi-durable 框架理解见 **docs/TECHNICAL.md**；二期设计（SKILL/MCP/统一技能模型，已交付）见 **docs/PHASE2-DESIGN.md**；三期设计（多渠道：飞书/QQ/微信/企微，已交付）见 **docs/PHASE3-DESIGN.md**；四期（用户体验：gateway 服务化/TUI 分离/统一命令/管理台 2.0，**已交付**）见 **docs/PHASE4-DESIGN.md**（调研全文在 docs/PHASE4-research/）。

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

- **发布（0.1.0 起，纯 GitHub Release）**：`git tag v0.1.0 && git push origin v0.1.0` → GitHub Actions（`.github/workflows/release.yml`：ubuntu 矩阵 bun `--target` 交叉编译 darwin/linux × arm64/x64 四平台 → Release 挂 `bot-<platform>.tar.gz`）。**版本单一真相源 = git tag**：workflow 校验 tag 与 package.json 一致（防双源漂移），`--define __APP_VERSION__` 注入二进制（`bot --version` / `bot version` / gateway.sock identify / `gateway status` 全部可见；本地源码运行显示 `dev`）。构建脚本 `scripts/build-release.ts`（`--all` 全矩阵，env VERSION 可覆盖）。安装：下载对应平台 tar.gz 解压得 `bot` 二进制。
- CLI：`bot`（连 gateway 进 TUI）/ `bot gateway install|uninstall|start|stop|restart|status|service`（服务化命令族）/ `bot start|run`（前台 = `gateway start --foreground` 别名）/ `bot status|admin`
- 服务化：`bot gateway install` 注册 launchd LaunchAgent / systemd user unit（label `com.bot.gateway.<sha8(cwd)>`，一机多项目互不干扰）；退出码协议 exit 75=请重启 / exit 78=配置错不重启（launchd 经 bootstrap-guard 标记文件实现链条终止）；restart = drain 协议（SIGUSR1：停调度器 → 等在飞 turn 上限 50s → exit 75），成功判据 = 观测到新 PID（socket identify 变化）
- **liveness = "可连接 + 合法 identify 应答"**（`.bot/gateway.sock`，0600）——绝不用 PID 文件/端口探测判活
- Web 管理后台：`http://127.0.0.1:3000`（默认只监听 127.0.0.1；端口/地址存于 `system_config` 的 `web_port`/`web_host`）
- 终端 REPL 斜杠命令已收敛为统一注册表：`/agent /reset /compact /status /tasks /cancel /help /admin`（`src/core/commands.ts` 单一真相，终端/IM/Web/TUI 语义一致）

## 关键约束（改动前必读）

1. **pi 框架依赖为纯 npm**：`@earendil-works/pi-durable`、`pi-ai`、`chord` 在 package.json 中声明为 npm 依赖（1.0.2），`bun install` 后**完全独立运行**——构建/测试/typecheck 均不需要本地 `../pi`。重要事实（第八轮评审实证）：**Bun 运行时恒解析 node_modules 的 dist**，tsconfig paths 对 Bun 运行时无效（仅 tsc 遵循）——因此 tsconfig 已移除框架的 paths 映射，让 typecheck 与运行时同源（dist 1.0.2），消除"类型超前于运行时"的漂移。npm 1.0.2 类型面缺少的少数成员（`watch`/`openBinaryReader` 等）在 `execution-env.ts` 用 `@ts-ignore` + prototype 兼容调用标注（缺方法时走 fail-closed fallback，保持 Result 契约）。`../pi` 本地仓库仅作**源码阅读参考**（理解框架行为时对照 dist 与 src）；上游发布新版本后提升依赖版本号对齐。
2. **零配置文件原则**：会话、Agent、渠道、模型密钥等一切状态只存 SQLite（`<cwd>/.bot/bot.sqlite`），不引入任何配置文件。新增配置项走 `DatabaseStore.getConfig/setConfig` 或建新表（改 `src/database/migrations.ts`）。
3. **cwd 自包含**：所有持久化数据落在 `<cwd>/.bot/` 下（`bot.sqlite`、`workspaces/<agent-id>/`、`logs/`、`skills/`），路径逻辑统一在 `src/config/env-paths.ts`，不要硬编码其他位置。
4. **删除保护**：`agent-default` 和 `terminal-main` 是保留项，`DatabaseStore.deleteAgent/deleteChannel` 会拒绝删除；数据库 bootstrap（`migrations.ts` 里的种子数据）只在全新库执行一次（`bootstrapped` 标记），绝不恢复用户已删除的数据。
5. **运行环境**：Bun + TypeScript strict + ESM（import 带 `.ts` 扩展名，tsconfig 已开 `allowImportingTsExtensions` + `noEmit`）；沙盒仅支持 macOS（Seatbelt）/ Linux（Bubblewrap+Seccomp）。`node:sqlite` 的 `DatabaseSync` 要求 Node 22+ / Bun。
6. **管理后台安全**：免密是需求，但默认只监听 `127.0.0.1` 且**刻意不设 CORS 头**（API 暴露已配置的 API key，禁止跨域读取）。需要局域网访问时用 `--host` 或 `web_host` 配置显式放开。四期注入式 token（§6.1）：启动生成 `.bot/gateway-token`（0600），serveStatic 出 HTML 时注入 `window.__BOT_TOKEN__`，全部 API 校验 `x-bot-token` header（常量时间比较；EventSource 可用 `?token=` 等价携带），`/api/bootstrap` 与渠道 webhook 豁免，静态资源在鉴权门**之前**服务（浏览器首次加载才拿得到注入）。另有 Host/Origin 双校验（信任集含本机网卡地址）、provider 密钥与渠道凭据**响应脱敏**（空值/掩码值提交=保留旧值）、fetch-models/test 库补 key 限定同 apiBase、请求体 1MB 上限、webhook 分发前置豁免（回调方由渠道验签负责）。
7. **沙盒安全模型**（多轮对抗评审的结果，改动前必读）：
   - **平台级无条件禁读**（`.bot` 两个 sqlite/logs/`.env*`/skills 代码/其他 Agent 工作区）同时作用于应用层 PathGuard 与内核层 ASRT denyRead——`kernelDenyRead`（manager.ts）与 `platformDenyRead`（execution-env.ts）必须同步演进，改清单时两处都改；**skills 目录只禁代码（`*.ts`/`*.js`/`node_modules`），SKILL.md 必须放行**（文档型技能正文经 read_skill 供模型按需读取），且 skills 代码 deny 模式不进 inode 指纹收集（glob 会枚举整目录把 SKILL.md 一并指纹化）；
   - **PathGuard 的 `resolveReal`** 是统一逐段迭代解析（symlink/悬空链接/`..`），所有策略匹配与执行都用其结果（`guardRead/guardWrite` 把 `realPath` 传给执行回调，防 TOCTOU）；**inode 指纹**（collectInodesCached，TTL 60s 多槽缓存 + 10000 上限 + lstat 不跟随 symlink）封堵硬链接改名——这两层与路径 deny 缺一不可；
   - **fail-closed 纪律**：argv 数组命令、不支持平台、wrap 失败一律拒绝执行并审计，绝不降级裸跑；
   - **防自杀闸**（四期 §3.1）：Agent 经 bash 执行 `bot gateway stop/restart/uninstall` 或 launchctl/systemctl 直杀 bot-gateway unit 一律拒绝并审计（execution-env.ts 的 SELF_DESTRUCT_PATTERN 作用于全部 exec，先于沙盒包装）——gateway 运维是用户终端/管理台的事，模型绝不可自毁宿主服务；
   - **宿主进程 env 不进子进程**：provider 密钥只经 `auth.resolve` 闭包，bash 强制最小环境白名单 `inheritEnv:false`；宿主进程内 fetch（fetch_url）走 `safeFetch`（拒绝内网/回环/元数据，重定向逐跳校验）。
8. **内核网络白名单非实时（评审实证）**：ASRT 的域名过滤判定（`filterNetworkRequest`）读取的是**进程级全局 config**（`initialize`/`updateConfig` 时刻的清单），`wrapWithSandbox` 的 `customConfig.network` 只决定"是否启用网络限制"，**不更新代理的域名规则**；本项目从不调 `updateConfig`，故内核层白名单冻结在首个执行 bash 的 Agent 的配置上。应用层（read/write 的 PathGuard）是实时的（env 回调每轮从库重读）。多 Agent 各自域名配置下内核层会用错清单——根治需要 per-agent 代理（ASRT 架构限制），短期可在 `wrapCommand` 前检测配置变化并调 `updateConfig`（有微小竞态窗口，方向是最近一次 wrap 的配置）。
9. **已知 backlog**（评审确认非阻碍性但记录在案）：temperature 是死配置（pi-durable AgentState 无该字段）；`env.cleanup()` 未接入（优雅退出由 harness.close join 任务覆盖，SIGKILL 场景接受）；safeFetch 的 DNS TOCTOU 需 runtime 层 dispatcher；删除 Agent 后 conversations.sqlite 的孤儿会话无框架删除 API（重置=删库文件）；INODE_ENTRY_LIMIT 截断后超出部分依赖内核层路径 deny；**ASRT 内置网络代理与宿主 TUN 代理（Fake-IP 198.18/15）环境不兼容**——白名单外域名正常拦截，但白名单内域名的 CONNECT 经代理挂起（实测 2026-10，宿主 Clash 类 TUN 环境），内核出网功能性失效（方向 fail-closed 不出数据）；网络层白名单在该环境下不可依赖，需 ASRT proxy 支持上游宿主代理或改用 TUN 层白名单。**内核违规监控（violation monitor）已开启**（`initialize(…, enableLogMonitor=true)`，事件经 subscribe 落 `sandbox.violation` 审计并归因 agent），但 macOS 上 file-read/file-write 类 deny 事件只记 debug 级内核日志且不带规则 logTag（实测 deny 行无 message 后缀，monitor 的 ENDSWITH 谓词匹配不到）——file 类内核拦截当前仍无审计，文件边界审计依赖应用层 PathGuard；sysctl/代理拒绝等带 logTag 的事件可正常捕获归因。**二期四轮对抗评审（herdr Claude+Codex）收敛记录**：终态双方 NO BLOCKING ISSUES；遗留 MINOR backlog——同 server 内工具名净化碰撞的 base 归属已按 name 排序确定化（listTools 顺序无关）；MCP 工具名全局唯一靠"重建时排除 MCP 自身 + id 排序 + 64 字符截断"，跨进程重启后的 transcript 旧工具名兼容未做；mcp_servers 表无 CHECK 约束（id 格式靠 API 层校验）；`.bot/skills/mcp__<id>/` 目录撞 MCP id 时 SKILL.md 被 shadowed（有诊断）；混合技能删除 index.ts 后 registry 保留旧工具条目（目录名 id 存活，文档面 stale）。**三期渠道 backlog（均未实测真机凭据，连上后验证）**：四渠道 adapter 未经全量真机联调（协议语义对照 hermes 生产实现移植，QQ/微信接口字段可能演进）；飞书 text 消息不渲染 markdown（出站降级 plain，interactive 卡片形态未做）；QQ 主动消息月 4 条配额未做配额记账；微信 iLink 无 SLA（-14 会话过期需重新扫码）；群聊 @ 过滤依赖平台事件订阅层（allowFrom 白名单已实现，未配置时群消息放行——成本防护由 loop-guard 兜底）；微信 QR 扫码 UI 呈现为 liteapp 链接而非内嵌二维码图；投递账本（delivery ledger）未实现；Telegram 未确认 updates 游标不持久化的重启重投语义（官方以确认前保留为准）。**四期交付记录与 backlog（2026-10，未全量真机联调）**：**九轮对抗评审（herdr Claude+Codex 空上下文，R1 22 项 BLOCKING → R2 8 → R3 9 → R4 3 → R5 3 → R6 1 → R7 1 → R8 1 → R9 双方 NO BLOCKING ISSUES 收敛，159 tests 全绿）**：安全面（gateway-token/pid/sock/lock 全入双层禁读、防自杀闸覆盖 launchd label/源码入口/pkill 特征 + 只读首词白名单防检索误报、WS tokensEqual + maxPayload + Origin 校验、token 下发仅 loopback 面、control socket 单行上限）；生命周期（runPlatform 前置 probeLiveGateway + gateway.lock O_EXCL 互斥、serviceState 磁盘/loaded 语义分离、updated 定义 bootout+bootstrap、stop/restart 先 drain（新动词 drain-stop exit 0）、SIGTERM 走 drain、drainInFlight 等 scheduler inFlight、uninstall/install 清 config-error 标记）；drain 统一闸下沉 tryCommand（覆盖全部命令入口 + WS/Web/reset/cancel/trigger）；命令层（WS prompt.submit 过 router、terminal REPL 接入注册表、/agent switchTo 三端消费 + TUI/REPL 清屏重建、/api/chat 删除 close→abort、reset 先 abort）；SessionHub（scheduler.completed fanout 复制 keys 防 Map 迭代挂死、attach ensureRing 建环、LRU 置顶、truncated 全量语义接入 client resync）；管理台（healthTimer 不可达修复、broadcast 覆盖全部 enabled 渠道、/api/sessions/find 显式查找 + listSessions 哨兵行提升去重、handoff 行、审计聚合 Math.abs + 保持最新时间、cron 严格逆向、runCount 原子递增、401 reload 上限）。**WS 排队消息已持久化**（gateway_queued_prompts 表 v5：受理即落库、出队删行、启动恢复残留、drain/cancel/reset 清空）。**R3 复核（3+6 项 BLOCKING 已修复，153 tests）**：events.since 重建 attach（重连断流根因）+ ensureRing 空环 replaySince 短路；只读白名单限无 shell 元字符单段命令（复合/管道/awk-find 执行型移出白名单，R3 矩阵测试）；token 下发改 socket.remoteAddress 判定（Host 可伪造）；drain 应答改完成时回执（notifyDone）+ drainInFlight promise 缓存（SIGTERM 二次调用等第一次完成）；恢复队列自驱动（非 busy 会话直接投第一条）；cancel/reset 全入口统一 clearQueuedForSession（含 HTTP/WS/命令层）；immediate 分支二次 drain 校验；listSessions 去重后截断；ChatView switchTo 帧同写 delta。**R4 复核（3 项 BLOCKING 已修复，155 tests）**：防自杀闸生产实现导出 selfDestructBlocked（R4 教训：测试复制逻辑致生产漂移全绿假象——测试必须走生产实现）；durable 层 busy 追踪（harness.inspect 的 running/ready 任务计入 drain 等待面与队列自驱动闸，cleanup 的 AgentManager.shutdown 待遇见下）；SessionHub attach 引用计数（多客户端同看）+ 硬上限强逐（全部 pinned 时逐最旧，被逐会话经 since truncated 全量拉自愈）；队列投递周期轮询自驱动（5s，durable 闸不与恢复任务并发）；manual trigger body 后二次校验。**已知取舍**：cleanup 通用 race 800ms（harness.close 的 join 在长任务下依赖 drain 路径而非 cleanup race——drainInFlight 已含 durable 等待面）。**R5 复核（2+1 项 BLOCKING 已修复，157 tests）**：SessionHub seq 墓碑（逐出环的 nextSeq 记忆恢复，重建环 seq 单调——修复"强逐后 attach 客户端 watermark 永久过滤新事件且重连不自愈"的断流）；逐出策略统一 evictOneRing（append/ensureRing 共用：pinCount=0 优先、全 pinned 强逐最旧）；durableBusyCount 统计全部 live 任务并 fail-closed 抛错（drain catch 计 1 继续等、队列 dispatch catch 跳过本轮）；dispatchQueueFor await 后全量重校验（drain 置位/队头一致性——闭包旧数组会绕过 drain 清空）；attach 幂等（重复 attach 不虚增 pinCount）；exec 直用 selfDestructBlocked；drain handler 异常应答；listSessions LIMIT 上界。**R4 教训记录**：测试复制生产逻辑会掩盖漂移（R4-B1 全绿假象）——回归测试必须 import 生产实现。**R6 复核（Codex 1 项 BLOCKING 已修复，Claude 首报 0 BLOCKING；157 tests）**：SessionHub seq 改**进程级全局单调计数器**（R6-B1：R5 的 tombstone 方案受容量限制、超限丢墓碑即回归 seq 重置断流——全局计数器从根上消除，环逐出/重建不可能破坏单调性，truncated 判定 oldest > lastSeq+1 依然精确；Codex 确定性复现修复后场景通过）。drain async rejection 兜底日志。**R7 复核（Codex 1 项 BLOCKING 已修复，158 tests）**：attach 状态与环缓存分离（SessionHub.attachedKeys 引用计数独立于 rings——强逐 ring 不丢订阅，fanout 对 attached 但无环的会话 ensureRing 重建后照常投递 platform 事件；强逐场景历史 delta 回放有损，取舍在案）；drain 协议 error 应答路径补全（async rejection 不再让 CLI 等 65s 超时）。**R8 复核（Codex 1 项 BLOCKING 已修复，159 tests；Claude 0 BLOCKING）**：ensureRing 拆分——ensureRingOnly（仅建环/置顶，fanout 内部重建专用）与 ensureRing（真实 attach = 计数 + 建环），修复 fanout 重建虚增订阅计数导致的幽灵订阅泄漏。**/simplify 四角清理（4 agent 并行，修复 ~20 项；159 tests 全绿）**：cancel/reset 收敛为 lifecycle 的 doCancel/doReset（6 入口一行调用，消除 ws 侧绕过 helper 的漂移）；WS prompt.submit 复用 tryCommand 返回值（删双重 parse + 动态 import）；信任集抽 utils/trusted-hosts（修复 WS 侧缺 [::1]/网卡地址——局域网模式 HTTP 正常而 WS 403 的实际分叉）；fanout 的 ensureRingOnly 死代码删除（append 自建环）；durableBusyCount 共享求值（轮询一轮一次 + drain 进程内计数短路）；session-history 只读连接复用（失败重置单例）；resolveBoundAgent 收敛（命令层与 dispatchInbound 同一判定）；fmtTokens→stats.formatTokens（口径统一）；probeGateway verb 扩展吸收 probeGatewayDrain 整段重写；一批死代码（GatewayClient.reset/runTui socketFile/terminal logger/CommandOutcome.parsed/手动帧上限）。**拒绝项**：TUI blocks 尾部裁剪建议（会破坏 Static append-only 契约→重引 R4-B3 冻结 bug，无界增长是 Ink Static 的必然代价）。**有意取舍 backlog**：plain `kill <pid>` 与 shell 转义不可静态拦截（pid/token/lock 全禁读断链后残余面极窄，hermes 同款）；lock stale 检测的 PID 复用误判（手删锁恢复）；launchd 仅 GUI 登录会话自启（headless 服务器需登录或改 LaunchDaemon）；IM 群聊截断命令无成员权限；Chat 页切视图不常驻（刷新丢 usage，历史已可恢复）；跨多客户端同看一会话的 Fanout 邮箱（当前多客户端同 key attach 各自 replay，无增量分摊）；gateway-token 局域网 OAuth（§8-4）、WS 单连接 attach 会话数上限（R9-M1: 需 token 的认证客户端容量治理，正常用法不触发）、强逐 attached 环时历史 delta 回放有损（live 流与 platform 通知有保障）。统一命令层（CommandDef 注册表 + ChatOrchestrator + InboundPipeline slash fast path + Web/TUI 统一入口，修复 F3"IM /status 直达 LLM"）；gateway 服务化（launchd/systemd 代码生成 + 退出码协议 75/78（launchd 侧经 bootstrap-guard 标记文件实现 78 不复活——KeepAlive 本身无法表达按退出码跳过，须首次 supervised 启动失败写标记、下次启动见标记 exit 0）+ gateway.sock liveness + drain 协议（SIGUSR1 → 停调度器 → 等在飞 turn 50s 上限 → exit 75，已实测）+ 防自杀闸）；TUI（Ink 8 + Bun 原生 WebSocket 纯客户端，Static transcript + slash ghost 补全 + busy 排队；会话权威在 gateway，attach 语义）；WS 第二传输（SessionHub seq/replay/epoch + busy 三模式 + 服务端排队 16 上限）；管理台 2.0（注入式 token/会话浏览页/chat 页历史+取消+usage/审计过滤分页聚合/任务编辑器/渠道 enabled≠connected 语义/暗色模式/SSE 静默刷新）。**backlog**：TUI 虚拟滚动与 agent 视图切换（现固定 agent-default 绑定视图，/agent 切换仅展示不改绑定）；launchd 78 语义依赖标记文件（进程被 SIGKILL 时不落标记会多复活一轮）；conversations.sqlite 只读读取在框架 schema 变更时需同步（耦合 entries.record.model 形态）；审计"同型聚合"是 60s 窗口近似；多实例 `bot gateway list`、通知离线队列、`--host 0.0.0.0` 强制 OAuth、Telegram setMyCommands 菜单派生均记设计稿 §8 未做。**三轮对抗评审（herdr Claude+Codex 空上下文）修复记录（2026-10）**：R1 8 BLOCKING（unhandled rejection 杀进程/QQ 致命码/飞书媒体 API/企微分段/Telegram 去重键与预算/微信指纹去重/stop 挂死）→ R2 2 BLOCKING（QR redirect_host SSRF 白名单/terminal 热替换保护）+ 生命周期统一（POST/QR/DELETE 全走 restartChannel 单飞+代际收敛，start 失败注销，DELETE 前置保留项保护并同步等待）→ R3 1 BLOCKING（分段器围栏预算 off-by-one）+ 收尾（三渠道媒体 storeMediaStream 真流式含管道内 AES 解密与建连超时、DB WAL/SHM chmod、QQ token/gateway 超时、pre-coalesce per-peer 限流 30/min、防抖附件并集上限、Telegram 群消息 @ 判定不依赖 privacy mode、截断末段围栏补全、allowFrom 只匹配不可变 peerId、.bot/channels 进双层沙盒 deny、QR 端点限 weixin 类型/禁用渠道、已存渠道禁改 type、前端二维码图、管理台 allowFrom 字段）。regression tests：分段器 off-by-one/小预算死循环/围栏闭合/emoji 边界/附件并集（phase3 套件 19 用例）。R6 修复：信号量可重入化（AsyncLocalStorage 上下文——adapter 外层建连占位 + 内层 storeMediaStream 复用同一 slot，消除 4 并发确定性自锁死锁）；QR confirmed 锁内重读配置再写库（旧快照不得复活已删除渠道/覆盖并发修改）；飞书超时路径 slot 占用至底层 axios settle（有界 60s，防 fd 泄漏）；企微 SDK Buffer 路径纳入全局信号量与强制水位。R5 修复：restartChannel 循环简化为锁内单次重启（锁内才重读最新配置，循环在旧代际遇新代际时活锁——B-R5-1 教训：epoch set 丢失导致无限重启风暴，已由渠道生命周期端到端测试守护：无凭据 weixin POST 必须超时前返回 500）；媒体信号量前移到建连/SDK 请求阶段（withDownloadSlot 全程作用域）；磁盘水位强制触发（进程累计落盘 128MB 无视 sweep 节流）；截断围栏补全改用段首开围栏标记（嵌套时内部标记不是边界）。**R7-R9 收敛**：信号量可重入（AsyncLocalStorage——嵌套占位死锁根治）、QR 锁内重读配置（旧快照不复活已删渠道）、飞书 httpInstance 注入自定义 axios（60s 原生超时 + 精确复刻 SDK 的 UA/resp.data 解包 interceptor——裸实例会导致 token/消息 API 全部失败，已对真实 API 冒烟）、企微纳入信号量与强制水位。**终态：六轮评审双方 NO BLOCKING ISSUES。** 已记录取舍 backlog：wecom SDK downloadFile 返回 Buffer、分段器病态小预算契约、DNS TOCTOU（既有）、媒体缓存 per-channel 配额未分账。**R4 修复：per-channel 互斥锁统一 restart/delete 临界区（防交叉产生僵尸渠道）、QR confirmed 自增代际（新凭据不被同 epoch 在途重启吞掉）、terminal 既有实例可经管理台编辑（仅禁新建）、start 失败本代如实 500（旧代静默交新代处理）、限流 Map 逐插容量守护+过期清扫（防唯一 peer 洪水 OOM）、微信 item_list 附件上限 4、媒体全局并发信号量（4）+ 总磁盘水位 1GB（sweep 从最旧删除）、飞书 SDK 请求阶段 60s race（axios 默认无超时）、截断末段围栏补全升级（识别 ~~~/四反引号+补全计入预算）、DB chmod 挪到 pragmas 后（覆盖首启新建的 WAL）+ 失败告警、QQ stop 等待 close+lastInboundMsgId LRU、telegram 命令过滤 @otherbot、API 空字符串不清空 secret、QR status 前置 enabled 检查、weixin typing 30s。**第一轮修复明细**：B1 级——coalesce 定时器链 unhandled rejection 杀进程（flush 内置 catch）、QQ 致命 close 码对齐 hermes（4004 刷 token/4006/4007/4009 清 session 重连）、飞书媒体改 messageResource.get（image.get/file.get 对用户资源平台直接拒绝且返回非 Buffer）、企微流式路径超限分段兜底、Telegram 去重键拼 chatId 前缀（message_id 是 per-chat 计数）+ 4096 字节预算、微信内容指纹去重删除（合法重复文本被误杀）、微信 stop 可中断（stopAwareSleep + AbortController，QR 热重启不再挂 10 分钟）、渠道 CRUD 与 adapter 生命周期对齐（保存热替换/停用停止/删除回收+清媒体缓存）、loop-guard 改为按派发计数（防抖后）+ 审计节流、allowFrom 访问策略、DB 文件 0600、QQ typing 用 input_notify 协议体且限单聊、QQ 端点选择以入站记录的 chatType 为准（弃 G 前缀启发式）、safeFetch 跨源重定向摘 Authorization、凭据清空保旧（后端合并）、wecom/qq/weixin/telegram 网络调用全部带超时。

## 架构

```
src/
├── cli.ts                  入口：gateway 生命周期命令族 / 前台运行时 (runPlatform:
│                           组件启动 + 控制套接字 + SIGUSR1 drain + bootstrap-guard) /
│                           bot / bot tui（连接 gateway 进 TUI，未运行时给引导）
├── gateway/                四期 M1/M2：服务化与第二传输
│   ├── service-defs.ts     launchd plist / systemd unit 纯函数生成器（代码生成而非
│                           模板；KeepAlive/ThrottleInterval=30/ExitTimeOut=60/
│                           RestartForceExitStatus=75/RestartPreventExitStatus=78）、
│                           实例标识 sha8(cwd)、resolveGatewayProgram（bin/bot 优先）
│   ├── control-socket.ts   gateway.sock 控制套接字（identify/status/drain 动词，
│                           newline JSON）+ CLI 探针 probeGateway（liveness 判据）
│   ├── lifecycle.ts        install（幂等 + 双 gateway 防护 + 临时 cwd 拒装）/uninstall/
│                           start/stop/restart（新 PID 观测）/status（三源合一）/
│                           drainInFlight（停调度器 + 等在飞 turn）
│   ├── session-hub.ts      会话事件中枢：per-session 单调 seq + 512 事件重放环 +
│                           replay_epoch（进程 UUID）+ truncated 全量语义；数据源 =
│                           AgentManager.onTurnEvent + EventBus chat.turn
│   └── ws-gateway.ts       /api/gateway/ws：WS 第二传输（session.attach/prompt.submit
│                           busy 三模式 queue|interrupt/command.exec/session.cancel/
│                           reset/events.since/commands.list）；断开 = detach 不销毁
├── tui/                    Ink+React 纯客户端（M2）：Static transcript + live 流式区
│                           + slash ghost 补全 + busy 排队预览 + Ctrl+C（busy=中断/
│                           idle=退出）；会话键 terminal-main:local-user（与旧 REPL
│                           会话历史连续）；Bun 原生 WebSocket 作客户端
├── config/
│   ├── env-paths.ts        <cwd>/.bot/ 路径计算与目录保障
│   └── database-store.ts   全部数据模型的 CRUD（Agent/Provider/Channel/Session/
│                           Audit(过滤+分页)/Config）；recordAudit 同步广播审计事件
├── database/
│   ├── index.ts            DatabaseManager 单例（WAL、busy_timeout、foreign_keys）
│   └── migrations.ts       建表 + 一次性 bootstrap 种子（默认 providers/agent/终端渠道/端口）
├── core/
│   ├── event-bus.ts        平台事件总线 (进程内 pub/sub): 事件源只发布事实,
│   │                       消费方 (渠道通知/webhook 推送/SSE/SessionHub) 订阅; 见 events.ts
│   ├── events.ts           PlatformEvent 全集：scheduler.completed / sandbox.violation /
│   │                       chat.turn / channel.status / channel.health / task.updated /
│   │                       audit.recorded（管理台 SSE 与 SessionHub 的事件源）
│   ├── commands.ts         统一 slash 命令注册表（四期 M0，设计 §5）：CommandDef
│   │                       (name/aliases/visibility/busyPolicy/handler) 单一真相源；
│   │                       parse 健壮性（@botname 剥离/路径形态拒绝/未识别显式回复）；
│   │                       内置 /help /status /reset /compact /agent /tasks /admin /cancel
│   ├── chat-orchestrator.ts 统一入站入口：tryCommand（busy 三模式判定）+
│   │                       handleInboundCommand（IM 管道 slash fast path，经
│   │                       setSlashFastPath 注入防依赖环）+ handleChatInbound（Web/TUI），
│   │                       修复"IM /status 直达 LLM"（F3）
│   ├── gateway-token.ts    注入式 token：loadOrCreateGatewayToken（0600）+ 常量时间比较
│   ├── agent-manager.ts    AgentManager 单例：pi-durable Harness 生命周期、会话缓存
│   │                       (LRU 上限 100) 与恢复、**同会话串行锁**（withSessionLock）、
│   │                       busySessions 追踪（isBusy/activeTurnCount——cancel/drain 用）、
│   │                       onTurnEvent（流式 chunk 广播 → SessionHub）、abortSession
│   │                       （显式取消；返回是否真的在生成）、reset/compact、shutdown()
│   ├── chat-orchestrator.ts (见上)
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
│   ├── base.ts             ChannelAdapter 契约（id/type/start/stop/sendMessage +
│   │                       sendReply?/maxMessageBytes?/markdownMode?/sendTyping?/
│   │                       healthCheck?）+ InboundMessage（媒体附件/replyContext/
│   │                       messageId 去重键/conversationType）
│   ├── factory.ts          渠道工厂：CHANNEL_TYPES 注册表 (type → 构造器) 实例化
│   │                       adapter；新渠道只需实现 ChannelAdapter 并登记一行；
│   │                       terminal 不经工厂（由 CLI 特殊管理）
│   ├── manager.ts          ChannelManager 单例：startAll 从数据库配置实例化并启动全部
│   │                       已启用渠道；按 boundAgentId 路由分发；
│   │                       dispatchAndReply/deliverOutbound（降级→分段→sendReply
│   │                       优先、超窗回退 sendMessage）
│   ├── runtime/            渠道运行时（全部渠道共用, 三期 M0）：dedupe（去重）、
│   │                       coalesce（防抖合并）、segmenter（块级贪心分段, 围栏块
│   │                       不可切）、markdown（降级）、typing（心跳）、media-cache
│   │                       （媒体缓存）、loop-guard（防自循环）、dispatch（管道组装,
│   │                       含四期 slash fast path——dedupe 后/媒体与防抖前, handler
│   │                       经 setSlashFastPath 注入）
│   ├── terminal/index.ts   本地 REPL 渠道（terminal-main）+ 斜杠命令；
│   │                       动态 prompt（agent·model·ctx%）+ 每轮统计行
│   │                       （↑↓ R/W 缓存 · CH 命中率 · ctx 上下文占比 · $ 耗时）
│   │                       + /status 可观测面板（会话累计）
│   ├── terminal/stats.ts   统计渲染纯函数（可测试）：数据源 = watchEvents 的
│                           usage_changed 事件（会话累计）+ 轮前 snapshot 差值；
│                           当前上下文 = 本轮 prompt 侧（累计值会虚高，勿改）
│   └── adapters/           feishu/wecom/qq/weixin/telegram（三期真实实现：飞书/
│                           企微/QQ 官方 SDK 或官方 API + 微信 iLink 协议自实现 +
│                           Telegram 基准渠道；全部 WS 长连接/长轮询免公网）
└── server/
    ├── server.ts           AdminWebServer：原生 node:http + REST API（providers/agents/
    │                       channels/skills/audit-logs(过滤+分页)/chat SSE 流式
    │                       (经 ChatOrchestrator 统一命令层)/chat/cancel/gateway/events
    │                       SSE 事件流/sessions 会话浏览/scheduled-tasks(创建+手动触发)),
    │                       默认监听 127.0.0.1、无 CORS + 注入式 token（见约束 6）；
    │                       WS upgrade 交给 attachWsGateway；静态服务 serveStatic()
    │                       提供 SPA 资源（HTML 注入 __BOT_TOKEN__）+ SPA 回退；
    │                       60s 周期渠道健康探测 → channel.health 事件
    ├── session-history.ts  会话浏览只读读取器：conversations.sqlite 仅 SELECT
    │                       (⚠️ head IS NOT NULL 的行是分支头标记——每会话仅少数几条,
    │                       全量条目读取**不过滤 head**, 与框架 readEntries 同语义;
    │                       record.model → user/assistant/tool 消息), 全文搜索 (LIKE)；
    │                       库不存在/打开失败一律空结果不抛错
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

### 消息流转（三期：统一入站管道 + 出站投递）

```
IM 渠道 adapter → InboundPipeline.submit（渠道运行时, src/channels/runtime/）
  ⓪ slash fast path（四期 M0, 访问策略与限流之后）: 以 / 开头即进命令注册表
      （dedupe 之后/媒体下载与防抖之前——命令即时响应，不被 5s 防抖合并），
      命中经 deliverOutbound 原路回信；未识别命令显式回复绝不送 LLM（终端例外）
  ① dedupe（messageId TTL 去重, 防平台重推）→ ② loop-guard（群聊防自循环熔断, 8 次/60s）
  → ③ 媒体入站即下载（media-cache: safeFetch 强制/CDN 白名单, 落 .bot/media/, 128MB 上限 24h TTL）
  → ④ coalesce（同 peer 防抖合并 5s/30s, 连发只派发一次）
  → ⑤ ChannelManager.dispatchAndReply
      → dispatchInbound：AgentManager.chat(`${channelInstanceId}:${peerId}`, …)
      → deliverOutbound：markdownMode 降级（full/limited/plain）→ maxMessageBytes 分段
        （segmenter: 块级贪心打包, 围栏块不可切）→ sendReply(replyContext) 优先,
        超窗/失败回退 sendMessage（主动）→ 多段间隔 300ms
```

被动回复窗口语义留在 adapter 内（`sendReply` 返回 false 即超窗）；飞书=引用回复、
QQ=msg_id+msg_seq（群 5min/单聊 60min）、微信=context_token、企微=原帧 req_id 流式。
终端/Web 渠道不经此管道（直连 chat）。

### 三期渠道（全部官方 SDK / 官方 API，WS 长连接免公网）

| 渠道 | type | 凭据 | 实现 |
|---|---|---|---|
| 飞书 | `feishu` | appId+appSecret | `@larksuiteoapi/node-sdk` WSClient；媒体经 `im.v1.image/file.get` → storeMediaBytes |
| 企微智能机器人 | `wecom` | botId+secret | `@wecom/aibot-node-sdk` WS 长连接；**全渠道唯一流式回复**（onChunk → replyStream 800ms 节流全量刷新，断流降级主动推送）；加密媒体 `ws.downloadFile(url, aeskey)` |
| QQ | `qq` | appId+clientSecret（`sandbox` 可选） | 自实现薄 WS 客户端（token 单飞刷新 → gateway → Hello/Identify/Resume/心跳，语义移植自 hermes qqbot adapter）；REST `/v2/users|groups/{id}/messages` |
| 微信个人号 | `weixin` | 无字段（**扫码登录**） | iLink Bot API 长轮询（协议移植自 hermes weixin.py）；context_token 落盘、-14 降级 tokenless 重发、AES-128-ECB 媒体；扫码端点 `POST /api/channels/:id/qr-login` |
| Telegram | `telegram` | botToken | Bot API 长轮询（零依赖基准渠道，验收运行时设施） |

渠道共性：adapter 声明 `maxMessageBytes`/`markdownMode`/`sendReply?`/`sendTyping?`/`healthCheck?`；
管理台表单按 `CHANNEL_FORM_SCHEMAS`（ChannelsView）声明式渲染凭据字段；微信凭据文件落
`.bot/channels/weixin/<accountId>/`（0600）。**通知兜底只投终端类渠道**（IM peerId 不可跨渠道移植）。

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

`/api/status`、`/api/bootstrap`（token 下发，豁免鉴权）、`/api/config`（GET/POST）、`/api/providers`（GET/POST/DELETE）、`/api/providers/fetch-models`、`/api/providers/test`、`/api/agents`（GET/POST/DELETE）、`/api/channels`（GET/POST/DELETE）、`/api/channels/:id/health`（adapter 健康检查）、`/api/channels/:id/qr-login` + `/qr-status`（微信 iLink 扫码, confirmed 自动并入凭据并热重启 adapter）、`/api/skills`、`/api/mcp-servers`（GET/POST/DELETE；headers/env 脱敏语义同渠道凭据）、`/api/mcp-servers/test`（连接试测，不落库）、`/api/scheduled-tasks`（GET / POST 创建与编辑(五模式人话编辑器) / DELETE 逻辑删除）、`/api/scheduled-tasks/trigger`（手动触发，异步执行结果回填任务记录）、`/api/audit-logs`（支持 event/agentId/since/until/limit/offset 过滤分页，返回 {items,total}）、`/api/sessions`（channel_sessions 列表）+ `/api/sessions/search?q=` + `/api/sessions/:conversationId/history`（conversations.sqlite 只读时间线）、`/api/chat`（POST，Accept: text/event-stream 时走 SSE 流式；经 ChatOrchestrator——slash 命令先行，未识别命令不送 LLM）、`/api/chat/reset`、`/api/chat/cancel`（显式取消生成）、`/api/gateway/events`（EventBus → SSE 事件流）、WS `/api/gateway/ws?token=`（SessionHub 第二传输）。

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
- **新渠道**：实现 `ChannelAdapter` 接口（出站可选声明 `sendReply`/`maxMessageBytes`/`markdownMode`/`sendTyping`/`healthCheck`），在 `factory.ts` 的 `CHANNEL_TYPES` 注册一行；入站走 `InboundPipeline`（渠道运行时自动获得去重/防抖/媒体/防自循环），终点为 `ChannelManager.dispatchAndReply`；渠道实例与 Agent 的绑定关系存 `channel_instances.bound_agent_id`；管理台凭据表单在 `ChannelsView` 的 `CHANNEL_FORM_SCHEMAS` 加声明（secret 字段沿用掩码还原语义）。
- **测试**：`test/` 下 13 个套件（paths/database/sandbox/skills/server/phase2/scheduler/notifications/phase3/phase4-m0/phase4-m12/phase4-m3 等），基于 `bun:test`，多为真实文件系统 + 真实 HTTP 端口的集成测试；server 测试已隔离到临时目录（测试顶部显式 `DatabaseManager.getInstance(临时路径)` + `logger.init(临时目录)`，新增测试套件须沿用此模式，勿写真实 cwd 的 `.bot/`）；**单例被全部套件共享（首个 getInstance 绑定生效），任何套件不得 rmSync 单例库文件所在目录**，否则并行套件会 disk I/O error。
- 代码中的中文注释/命名（如技能名称、终端 banner）是刻意为之，保持一致。
