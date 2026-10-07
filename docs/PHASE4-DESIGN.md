# 四期设计：用户体验（Gateway 服务化 / TUI 分离 / 统一命令 / 管理台 2.0）

> 状态：设计稿（2026-10）。三期现状见 `TECHNICAL.md` 与 `PHASE3-DESIGN.md`。
> 调研输入（三方独立，全文见 `/tmp/phase4-*.md` 归档）：
> ① **hermes 参照系**（`hermes_cli/gateway.py` 5786 行服务族、`ui-tui` React19+Ink fork、`tui_gateway` JSON-RPC 协议、18 页 dashboard、COMMAND_REGISTRY 命令体系）；
> ② **bot 现状剖析**（cli.ts 编排链路 / slash 流转 / 管理台代码走查 / launchd+systemd 约束 / 测试影响面）；
> ③ **管理台截图走查**（Chrome headless 实拍概览/渠道/对话/定时任务/审计五页）。
> 核心结论先行：**gateway daemon（launchd/systemd 托管）+ TUI 纯客户端（WS 同一 dispatch 第二传输）+ CommandDef 注册表（管道层拦截）+ 注入式 token 与事件流驱动的管理台**——四期不引入新进程间协议族，WS 复用服务端全部既有能力。

---

## 1. 目标与非目标

### 目标

1. **服务化**：`bot gateway install/uninstall/start/stop/restart/status/service`——launchd（macOS）/ systemd user unit（Linux）托管的后台持久服务；`bot gateway start --foreground` 供开发
2. **TUI 分离**：`bot`（裸命令）连接 gateway 进入 TUI 会话；TUI 退出/崩溃/断网**零影响**服务端与 IM 渠道；多客户端（TUI + Web）可同时观看同一会话
3. **统一 slash command**：`/status /reset /compact /agent /help` 在**全部渠道**（终端 TUI / 飞书 / 企微 / QQ / 微信 / Telegram / Web）语义一致；未识别命令显式回复而非送 LLM
4. **管理台 2.0**：注入式 token 加固、gateway 事件流驱动实时刷新、会话浏览页、chat 页补齐（历史/取消/用量）、状态语义修正、定时任务人话编辑器

### 非目标

- 不做 xterm/PTY 内嵌 TUI（hermes 的"内嵌真 TUI"模式需要先有 Ink TUI 资产，四期目标正是建设它；管理台 chat 页维持原生 SSE 气泡流）
- 不做 slash worker 子进程 + side-effect mirror（hermes 双 CLI 实现并存的历史包袱；bot 单进程 TS 一套实现天然一致）
- 不做 OAuth/OIDC、多 profile fleet 管理、i18n 多语言 catalog、compute_host GIL 隔离（Bun 无此约束）
- Windows 服务化（schtasks 方案，需要时另行设计）

---

## 2. 调研结论（设计依据）

### 2.1 hermes 的四条全局不变量（采纳为四期评审准绳）

1. **Per-conversation prompt caching is sacred**——改历史/工具集/系统提示词的操作默认延迟生效（下个会话），`--now` 显式立即；唯一例外压缩。bot 的 `conv.configure` 每消息全量同步已在缓存边缘，四期 TUI 的 agent 切换提示必须显式说明"切换 = 新会话上下文"
2. **The core is a narrow waist**——新能力优先级：扩展现有代码 → CLI 命令 + skill → 服务门控 → 插件 → 新核心工具（最后手段）
3. **能力可见性是会话的属性，绝不由进程环境变量决定**
4. **liveness = "connectable socket with a well-formed identify answer"，never a TCP port、never PID-reuse heuristics**——文件系统 ACL 即鉴权边界

### 2.2 bot 现状的五个关键事实（缺口）

| # | 事实 | 证据 |
|---|---|---|
| F1 | `--daemon` 只是"不建 TerminalChannel"，进程仍前台常驻，无服务模型 | `cli.ts:151-158` |
| F2 | `status` 只读 SQLite 配置，不探测进程/端口/健康——应称"配置状态" | `cli.ts:31-54` |
| F3 | slash 是终端私有逻辑：IM 渠道 `/status` 直达 LLM（用户实测），Web 同样绕过 | `terminal/index.ts:105-107` vs `server.ts:735-760` |
| F4 | `/api/chat` 是"一次 POST 一轮流"：无订阅式会话流、无多客户端广播、**断线即 abort 生成**（违背 TUI 不影响服务端）、无事件回放 | `server.ts:744-780` |
| F5 | `/agent <id>` 改的是 `terminal-main` 的 DB 绑定（影响整个渠道），而非客户端视图选择 | `terminal/index.ts:180-195` |

### 2.3 管理台截图走查（实拍五页）

- **概览**：沙盒事件 JSON 原文堆叠（command 全文撑爆列宽）；五路 API 并行请求一次性加载，无自动刷新
- **渠道**："在线"徽章实际只反映 `enabled`（语义误导）；健康检查需手动逐个点击；无最近入站时间
- **对话调试**：大片空白无引导；无会话历史（刷新即丢本地 messages）；无 usage/上下文展示（终端有 /status 面板而 Web 没有）；无生成中断按钮；后端客户端断开会杀死生成
- **定时任务**：空态文案好，但无"手动创建"入口（只能靠 agent 对话建）；无下次运行倒计时
- **审计**：JSON 原文无过滤器（事件类型/Agent/时间）、无分页、`sysctl-read` 类重复噪音事件刷屏、badge 同色无法区分严重度
- **全局**：手动刷新为主（仅侧栏 10s 轮询 /api/status）；浅色 only；Modal 无 focus trap；保存按钮无 busy 态

---

## 3. 设计一：Gateway 服务化

### 3.1 命令面

```
bot gateway start [--foreground]     # 前台 gateway（开发模式；无 --foreground 即 daemon 化日志输出）
bot gateway stop | restart | status [--deep]
bot gateway install [--start-now]    # 注册 launchd LaunchAgent / systemd user unit
bot gateway uninstall [--keep-data]  # 默认保留 .bot 数据；--purge 才删
bot gateway service                  # service manager 视角：installed/enabled/active/PID/最近退出
bot                                  # 连接 gateway 进 TUI；未运行时提示 `bot gateway install`
bot tui                              # 同上（显式）
```

- `bot start` 保留别名 = `bot gateway start --foreground`（兼容现有习惯与 dev 脚本）
- 服务实例按 cwd 派生标识：label `com.bot.gateway.<sha8(cwd)>`，一机多项目互不干扰
- **install 幂等**：已装且定义一致 → 提示；定义过期 → 重写 + reload（hermes 的 staleness 自愈：期望文本归一化对比，升级后服务定义自动收敛）
- **防自杀闸**：沙盒内 bash 执行 `bot gateway stop/uninstall/restart` 直接拒绝并审计（hermes `_refuse_from_inside_gateway`——防模型自毁服务）

### 3.2 服务定义（代码生成而非模板）

`generateLaunchdPlist(instance)` / `generateSystemdUnit(instance)` 纯函数，字段照抄 hermes 验证过的取值：

| launchd | 值 | systemd | 值 |
|---|---|---|---|
| Label | com.bot.gateway.\<sha8\> | unit | bot-gateway-\<sha8\>.service（user 级） |
| ProgramArguments | 绝对二进制路径 + `gateway start` | ExecStart | 同左（Type=simple） |
| WorkingDirectory | 项目绝对路径（.bot 跟随 cwd） | WorkingDirectory | 同左 |
| RunAtLoad | true | WantedBy | default.target |
| KeepAlive | `{SuccessfulExit: false}`——干净退出不复活 | Restart | on-failure + RestartSec=5 |
| ThrottleInterval | 30（防 respawn 风暴） | StartLimitInterval/Sec | 同意图 |
| ExitTimeOut | 60（≥ graceful stop 预算） | TimeoutStopSec | 由 stop 预算推算 |
| StandardOut/ErrorPath | `.bot/logs/gateway.{log,error.log}` | journal | `journalctl --user -u <unit>` |
| SoftResourceLimits.NumberOfFiles | 抬高（launchd 默认 256 会 EMFILE，MCP stdio 需要） | KillMode | control-group（MCP 子进程一并回收） |

**退出码协议**：`exit 75` = 请监管者重启我（RestartForceExitStatus=75 / KeepAlive 判定）；`exit 78` = 致命配置错**不**重启（RestartPreventExitStatus=78——防配置错死循环复活）。

**install 前置检查**：HTTP health 探测防双 gateway（两个进程共享 SQLite 但各持 ChannelManager/Scheduler → 重复长连接 + 调度竞态）；临时目录 cwd 拒装（`_refuse_temp_home` 同款）。

### 3.3 liveness 与 status

- **控制 socket**：`<cwd>/.bot/gateway.sock`（0600，unix domain），启动即监听，应答 JSON 动词 `identify`（version/cwd/pid/uptime）与 `status`（渠道健康/scheduler/MCP 摘要）——"可连接 + 合法 identify 应答 = 活着"
- **status 三源合一**：①socket identify ②服务管理器状态（`launchctl print` / `systemctl --user show`）③HTTP `/api/status` 深探测（`--deep` 附日志 tail）。输出含：service 态、PID、uptime、Admin URL、渠道健康摘要（enabled/connected/error）、Scheduler/MCP 态、最近错误日志
- PID 文件（`.bot/gateway.pid` JSON：pid/argv/start_time，O_EXCL 原子写）仅作 status 展示，不作 liveness 判据

### 3.4 restart = drain 协议

`bot gateway restart` 不在 gateway 进程内自杀，而是走 service manager（`launchctl kickstart -k` / `systemctl --user restart`）；gateway 自身支持 `SIGUSR1` = drain-and-restart（与 systemd reload 同路）：

1. 置 draining 拒新任务（`_running` 保持 true 让在飞 turn 交付完最终响应——AgentManager 同会话串行锁天然契合）
2. 等 in-flight：活跃 chat turn + **Scheduler 到期任务 drain 下限单列**（"被中断的定时任务是永久失败"——bot 的 catch-up 只补跑一次，drain 必须覆盖它）
3. stop → exit 75 → 监管者复活
4. **成功判据 = 观测到新 PID / socket identify 应答变化**（轮询 15s，未出现强制 kickstart），而非命令退出码 0

### 3.5 顺带修复（服务化前置）

- SIGINT/SIGTERM handler 注册提前到组件启动前（现在启动窗口期信号走默认退出，无法保证清理）——`cli.ts:111`
- `AdminWebServer.start()` 补 listen error handler 与端口预检（现在端口占用会让 start promise 永不结束）——`server.ts:134-147`
- 日志轮转（gateway.log 按大小 5MB×N，hermes 同款）

---

## 4. 设计二：TUI 分离

### 4.1 进程模型与传输

```
launchd/systemd ──► bot gateway daemon（既有全部服务端组件 + SessionHub + CommandRouter）
                        ▲                ▲
             WS (同一 dispatch 第二传输)   │ HTTP/SSE (既有)
                        │                │
   bot / bot tui ───────┘          browser 管理台（既有 + SessionHub 事件）
   （Ink/React TUI 纯客户端）
```

- **WS 不是第二套 API，而是同一 dispatch 的第二传输**（hermes tui_gateway 的核心架构结论）：TUI 与 Web 看到同一套 method/event 面
- `bot` 启动 → 读 `.bot/gateway.sock` 探测 → WS 连接（`ws://127.0.0.1:<port>/api/gateway/ws?token=<gateway-token>`）→ 未运行时输出 `bot gateway install` 提示
- **断开语义 = detach 而非销毁**：TUI 退出/崩溃对 gateway 零影响（服务端策略管理会话：孤儿宽限 20s → idle TTL 6h → LRU 软上限；重连 resume 即取消收割）；`/api/chat` 的"客户端 close 即 abort 生成"改为**显式 cancel 端点**（`POST /api/sessions/:id/cancel`）
- 鉴权：gateway 启动生成 `.bot/gateway-token`（0600）；TUI 读取后 WS query 参数携带；管理台同 token（见 §6.1）

### 4.2 SessionHub 与事件协议（bot 全栈 TS，zod 单一 protocol.ts 声明）

核心帧四类（JSON-RPC 2.0 每行/每帧一消息）：

1. client→server 请求：`session.attach` / `prompt.submit` / `command.exec` / `session.cancel` / `session.reset`…
2. server→client 响应
3. **事件通知帧**（无 id，method 恒为 `event`，事件名在 `params.type`）：`message.start/delta/complete`、`tool.start/complete`、`usage`、`command.result`、`channel.status`、`task.updated`…——出站盖 **per-session 单调 seq**
4. **server→client 请求**（反向 RPC）：工具审批 UI 的正解——`srq-` 前缀字符串 id + 响应帧识别（"有 id 有 result/error 无 method"）+ 超时只发一条 `request.cancel` 事件；**不发明 `*.request` 通知 + `*.respond` 方法对**

事件流四件套（hermes event_replay.py 不足 180 行可整体移植，纯内存）：

- per-session **单调 seq** + 有界重放缓冲（512 事件/4MB，序列化冻结入环）
- `replay_epoch`（进程 UUID）：客户端检测服务端重启 → 重置 seq 水位（seq 重启归 1，"events_since(97) returning [] with truncated=false forever" 是实测事故）
- `session.events.since(lastSeq)` 补洞；**truncated=true 强制全量拉**（绝不信任有洞的 replay；seq 计数器永不随逐出重置）
- delta 类事件 33ms 合帧（仅 message.delta 等三类高频 display-only）；非流帧插入前先刷合帧缓冲（保序永不超车）

会话层三防坑：`session.attach` **双 id**（运行时键 vs `channel_sessions.conversation_id` 存储语义分离——bot 已是后者）；`prompt.submit` **繁忙三模式**（interrupt / queue / steer，不硬拒；排队消息受理即落库）；截断类操作（reset/compact）busy 时显式确认。

多客户端广播：会话 transport 槽单客户端 → 第二个 attach 自动升级 Fanout（每 peer 有界邮箱 256 帧/4MB，**慢客户端溢出即踢自己重连 replay，不影响他人**）；控制类 RPC 校验"成员资格"而非槽同一性。

### 4.3 TUI 形态（MVP → 完整）

技术栈：**Bun + React 19 + Ink**（Bun 兼容 spawn/readline；hermes fork Ink 是因为原版缺 AlternateScreen/ScrollBox/鼠标/选择/backpressure——MVP 朴素形态不需要 fork，遇到长会话 OOM 再评估）。

```
┌ AlternateScreen ──────────────────────────────────────┐
│ [agent·model·ctx% 状态栏]        [渠道状态点]           │
│ ── TranscriptPane（虚拟滚动 + stickyScroll）──          │
│   多轮分隔 / 流式文本 / 工具 trail（8s+ 环境文案）        │
│ ── ComposerPane ──                                     │
│   排队消息预览（busy 时输入自动入队）                     │
│   ❯ 输入行（slash 补全 ghost text；/ 命令即时执行不入队） │
└────────────────────────────────────────────────────────┘
```

- 渲染性能四层照抄：16ms delta 合帧、transcript 虚拟滚动（每次 commit 最多新挂 12 行）、live 尾部字符预算（16K）、resize 32ms 合并
- slash 补全：`/` 开头 60ms debounce 查注册表（tier = exact/prefix/substring + 描述 token 命中），唯一前缀命中自动改写，多候选报 ambiguous
- 本地命令（/exit 只退 TUI 不杀 gateway、/clear、/connect）与服务端命令（/status 等 RPC）双表分治
- 会话/agent 切换显式提示"切换 = 另一个会话上下文"（不变量 1）

### 4.4 terminal-main 的语义收敛

`terminal-main` 保留为**逻辑 channel**（DB 种子/绑定/会话映射兼容），gateway 内不再有 readline adapter；通知兜底从"terminal adapter"改为"SessionHub 事件订阅 + 离线忽略"（TUI 在线才收，离线不积压）。`test/notifications.test.ts` 的 fake terminal adapter 改为 fake SessionHub subscriber。

---

## 5. 设计三：统一 slash command

### 5.1 CommandDef 注册表（单一真相源）

```ts
// src/core/commands.ts
interface CommandDef {
  name: string;                    // canonical，不带斜杠
  aliases?: string[];              // /reset = /new 别名
  description: string;             // 帮助/补全/渠道菜单的文案源
  category: "Session" | "Info" | "Config" | "Exit";
  argsHint?: string;
  channels: "all" | "terminal-only" | ("tui"|"im"|"web")[];  // 泛化 hermes 的 cli_only/gateway_only
  busyPolicy: "dispatch" | "reject" | "interrupt-then-dispatch";  // busy 时语义（必答题）
  handler: (ctx: CommandContext) => Promise<CommandResult>;
}
interface CommandResult {
  ok: boolean;
  content?: string;                // 渠道回复文本（走 deliverOutbound 降级/分段链）
  data?: unknown;                  // 结构化数据（TUI/Web 渲染卡片）
  broadcast?: SessionEvent[];      // reset/compact 需通知所有观看者
}
```

首批命令：`/help`（按渠道过滤可见项——不向将被拒的用户广告会被拒的命令）、`/status`（busy 也放行——hermes pre-gate 语义）、`/reset`（interrupt-then-dispatch + EphemeralReply 横幅）、`/compact`、`/agent`（列表）、`/agent <id>`（**语义修正**：TUI/Web 中只改客户端当前视图选择，不改 channel 绑定；channel 绑定是管理台动作）、`/tasks`（列出本 agent 定时任务，IM 可达的自助）。后续对齐技能模型：技能命令 = 展开为 prompt 落入 agent 回合（与 read_skill 渐进披露同构）。

### 5.2 拦截位置

- **IM 渠道**：`InboundPipeline` 加 slash 阶段——**插在 dedupe 之后、媒体下载与 coalesce 之前**（命令必须即时响应，不能被 5s 防抖合并、不能等媒体下载）；通过 `dispatchAndReply` 的既有链路回信（markdown 降级/分段/被动回复优先全部免费复用）
- **Web/TUI**：抽出 `ChatOrchestrator.handleInbound()`——`ChannelManager.dispatchInbound()` 与 `/api/chat`（及 WS dispatch）都调用它；内部顺序 = `CommandRouter.tryHandle()` → `AgentManager.chat()`。修复 F3 的同时把 Web 从"绕过 ChannelManager 直连 AgentManager"的旁路上拉回（获得 enabled/bound 校验）
- **终端 TUI**：本地命令表优先（/exit /clear），其余走 `command.exec` RPC 到 gateway——与 hermes 四段瀑布（本地表 → widget → 模糊改写 → RPC）同构

判定健壮性（hermes event.py 逐条搬）：`/cmd@botname` 剥离（Telegram 群）；首词含第二个 `/` 拒绝（防 `/Users/x/file.md` 路径形态）；`allowGatewayControl=false` 的注入消息（scheduler 通知等）不得触发命令；**未识别命令显式回复"未知命令，/help 查看可用命令"，绝不送 LLM**（"LLM 会发明工具调用"）；终端 REPL 可保留未知斜杠当普通文本的自由（现状），IM 一律 fail-closed。

### 5.3 渠道菜单派生

注册表派生各平台原生命令菜单（commands_platforms 模式）：Telegram `setMyCommands`（sanitize：`[a-z0-9_]` 32 字符，中文命令名直接放弃菜单项）、飞书/企微机器人命令菜单同理；`/help` 输出与菜单同源。

---

## 6. 设计四：管理台 2.0

### 6.1 安全与实时（性价比最高的两件）

1. **注入式 session token**（hermes 最值得抄的一条，~100 行）：启动生成 `token_urlsafe(32)`，serveStatic 出 HTML 时 `</head>` 前插 `window.__BOT_TOKEN__`；前端 fetch 层统一附 header；API 校验（常量时间比较）。**保留 127.0.0.1 免密输入体验**，但挡住本机其他进程与恶意页面的 no-cors 调用（管理 API 暴露 provider key）。token 失效（gateway 重启）→ 前端 401 检测自动 reload
2. **`/api/gateway/events` SSE**：EventBus 事件（chat 完成/渠道状态/任务更新/审计/skills reload）广播给前端；列表页订阅做**静默刷新**（跳 spinner 保滚动位置——hermes 用轮询模拟的效果，bot 单进程 EventBus 是天然优势），断线 fallback 轮询

### 6.2 页面级改进（按截图走查 + 代码证据排序）

| # | 改进 | 依据 |
|---|---|---|
| 1 | **会话浏览页**（新）：channel_sessions 列表（来源图标着色：飞书/QQ/终端…）→ 时间线（role 着色气泡 + 工具调用折叠 + 压缩记录降级为 muted "Context handoff" 行）+ 全文搜索 | conversations.sqlite 只读可达；hermes SessionsPage 验证过的形态 |
| 2 | **Chat 页补齐**：进入加载历史 snapshot（durable conversation view）→ 订阅 live 事件；usage footer（token/缓存/上下文进度条——数据源 SessionHub，与终端 /status 同源）；生成中**取消按钮**；页面常驻不卸载（切视图 display:none） | 走查 #3 + F4 |
| 3 | **渠道状态语义**：`enabled` 徽章改名"已启用"；gateway 周期 healthCheck 经事件流推送，徽章 = enabled + connected + 最近入站时间 | 走查 #2 |
| 4 | **审计页过滤器**：事件类型 × Agent × 时间范围组合过滤 + 分页（游标）；同型重复事件聚合（sysctl-read 噪音折叠为 "×N"）；badge 按严重度着色 | 走查 #5 |
| 5 | **定时任务人话编辑器**：五模式 ScheduleBuilder（interval/daily/weekly/monthly/once + custom 平级逃生门，模式切换保留已填状态）+ 通知目标选择器 + 下次运行倒计时 + 手动触发（防连点）+ 运行历史 | hermes ScheduleBuilder 直接映射 bot 三类型 |
| 6 | **保存/删除交互**：mutation 期间按钮 busy 禁用、失败错误保留区（toast 3.2s 不够回看）、表单脏关闭前确认 | 代码证据 C.3 |
| 7 | **技能卡/Agent 卡跳转**：概览卡片可点入详情；技能"已启用"列表可跳转 Agent 编辑 | 走查 #1 |
| 8 | **暗色模式 + 响应式**：`prefers-color-scheme` token 组 + anti-flash 关键 CSS 内联；<980px 表格卡片化、Modal 底部 sheet | 走查 #6 |

### 6.3 结构性约定

- `CHANNEL_FORM_SCHEMAS` 泛化为全局 schema 驱动表单机制（schema 后端常量表 + @bot-core 前端共享，零配置文件原则不变）
- `web/src/types.ts` 加 drift 检测测试（对照后端 API 定义），不做全量代码生成
- 统一 PageHeader 插槽 + Modal 焦点还原（useModalBehavior）

---

## 7. 里程碑与验收

| 里程碑 | 内容 | 验收 |
|---|---|---|
| **M0 统一命令 + SessionHub 地基** | CommandDef 注册表 + ChatOrchestrator + InboundPipeline slash fast path + `/api/gateway/events` SSE + 注入式 token | 飞书发 `/status` 返回会话状态卡片（用户实测场景）；终端/IM/Web 三渠道 `/reset` 语义一致；未识别命令显式回复 |
| **M1 Gateway 服务化** | gateway 命令族 + launchd/systemd 生成器 + gateway.sock + drain 协议 + 防自杀闸 + cli 修复 | `bot gateway install` 后重启机器服务自愈；`restart` 观测到新 PID；沙盒内 `bot gateway stop` 被拒并审计 |
| **M2 TUI 客户端** | WS dispatch 第二传输 + SessionHub（seq/replay/epoch/Fanout）+ Ink TUI MVP（transcript/composer/状态栏/补全）+ busy 三模式 | `bot` 进 TUI 对话；TUI Ctrl-C 后 IM 渠道照常收发；Web 与 TUI 同时观看同一会话；断网重连 replay 补洞 |
| **M3 管理台 2.0** | 会话浏览页 + Chat 页补齐（历史/取消/usage）+ 状态语义 + 审计过滤器 + ScheduleBuilder + 暗色模式 | 截图对照走查清单逐项闭环；事件流驱动静默刷新（无手动刷新按钮） |

依赖风险：Ink 在 Bun 下的兼容性（M2 首周验证，readline/AlternateScreen；不满足则回退 blessed 或纯 readline 增强）；launchctl 新旧 API 差异（bootstrap/kickstart 优先，探测降级）；conversations.sqlite 只读会话历史 API 的边界（框架无删除 API，仅读）。

---

## 8. 开放问题

1. **多实例管理**：一机多项目各装 gateway 服务时，`bot` 在项目 cwd 内连接"本项目的" gateway——跨项目列表（`bot gateway list`）是否需要？M1 先做单实例，list 记 backlog
2. **TUI 是否需要 agent 内嵌执行**（hermes spawn 模式：TUI 自持 AIAgent 独立于 gateway 会话）？四期明确不做——bot 的 TUI 是纯观看/交互客户端，会话权威在 gateway（attach 语义）；若未来要"离线 TUI 会话"另议
3. **通知兜底的离线队列**：TUI 拆出后 terminal 通知兜底消失，定时任务结果在"TUI 离线 + 无 IM 渠道"时仅存任务记录——是否需要离线通知队列（gateway 重启/TUI 重连时补投）？M2 实测再定
4. **gateway-token 与局域网模式的关系**：`--host 0.0.0.0` 时是否强制升级为 hermes 式 OAuth？四期先 token 全覆盖，OAuth 记 backlog
