# 二期设计：技能 / 插件 / 扩展的工具化支持

> 状态：**已交付**（2026-10）。M1（文档型技能）、M2（MCP 桥接）、M3（toolExposure/描述截断/连接测试）均已实现并经真实对话链路验证；M4（codemode/OAuth/热重载）仍为三期候选。
> 一期代码现状见 `TECHNICAL.md`；本文的 pi 参考实现均指 `../pi/packages/coding-agent`（源码路径随文标注）。
> 目标：把"技能"从当前的工具型 Extension 扩展为三类统一的能力体系，**至少交付 SKILL（文档型技能）与 MCP 接入**。

---

## 1. 目标与非目标

### 目标

1. **SKILL（文档型技能）**：支持 SKILL.md 格式（Agent Skills 规范）——纯知识/流程型能力，渐进披露注入，可直接复用 Claude Code 格式的既有技能资产
2. **MCP 接入**：管理台配置 MCP server（stdio / HTTP），其工具动态注册为 Agent 可用工具，按 Agent 选配
3. **统一技能模型**：三类能力（工具型 Extension / 文档型 SKILL / MCP server）在 SkillRegistry、Agent 选配、管理台三个层面统一呈现
4. 热更新语义保持：任何变更对既有会话下一条消息生效（一期已有的 configure extensions 链路复用）

### 非目标（三期及以后）

- codemode 暴露策略（模型写脚本经沙盒检索调用海量工具——pi 的 `codemode` 扩展形态，需要给沙盒脚本提供工具 API 桥，三期）
- MCP OAuth 完整流程（一期支持 header token / env 注入；OAuth 走 pi 的 `packages/mcp` oauth 模块后续接入）
- 技能市场 / 远程分发
- pi coding-agent 宿主扩展（`ExtensionAPI` 事件总线）的直接兼容——确认不可行，见 §2.3

---

## 2. 参考实现分析（pi coding-agent）

### 2.1 SKILL：`core/skills.ts`（约 400 行）

- **格式**：`SKILL.md` = YAML frontmatter（`name?` / `description?` / `disable-model-invocation?`）+ markdown 正文。name 缺省取目录名，按 Agent Skills 规范校验（`validateName`）
- **发现**：`loadSkillsFromDir` 递归扫描，遵守 ignore 文件、跳过 `.` 开头与 `node_modules`；SKILL.md 可位于根或任意子目录
- **注入（关键设计——渐进披露）**：`formatSkillsForPrompt()` 只把 `name/description/location` 渲染成 `<available_skills>` 块（每个技能约 3 行）进系统提示词；**正文不进上下文**，模型判断任务匹配后用 read 工具自己读 SKILL.md（相对路径解析规则也在提示里说明）。100 个技能 ≈ 几百 token 目录
- `disable-model-invocation: true` 的技能不进目录（仅供用户 slash 命令触发）

### 2.2 MCP：`core/mcp-servers.ts` + `extensions/mcp/{runtime,tools}.ts`（约 800 行）

- **配置模型**（union）：
  - stdio：`{ command, args?, env? }`（env 支持 `${VAR}` 与 `!cmd` 引用）
  - http：`{ url, headers?, oauth? }`
  - 公共：`exposure?` / `description?` / `toolExposure?` / `enabled?` / `timeout?`（progress 重置，默认 60s）
- **暴露策略（exposure——上下文经济学）**：
  - `direct`：工具像普通工具一样声明给模型
  - `codemode`（**默认**）：工具不声明给模型，模型在代码执行环境里用 `searchTools(query)/describeTool()/describeNamespace()` 检索后调用——工具数量不受上下文限制
  - `deferred` / `hidden`：注册但按需/不可达
- **工具命名**：`mcp__<server>__<tool>`，sanitize 后冲突加 sha256 前 8 位后缀（`createMcpToolName`）；命名空间 `mcp__<server>`
- **桥接运行时**（runtime.ts）：McpClient 懒连接 + `withClient` 失败重连；`listTools` → 工具定义（result schema 含 `structuredContent`）；`callTool` 转发；server instructions 作为组级说明；资源（resources）按需列举读取
- **接入点**：`ExtensionAPI.registerMcpServer(name, config)`——宿主把 MCP server 桥接成一个动态 Extension 装进注册中心

### 2.3 为什么不能直接复用 pi 的宿主扩展

pi 编码助手的 `ExtensionAPI`（`extensions/types.ts`，约 1600 行）是宿主事件总线（`session_before_compact`、`before_provider_request`、`agent_before_settle`…），深度绑定其 TUI/session/provider 层；pi-durable 的 Extension 是纯声明式注册（tools/sections/hooks/wraps/tasks）。两者 API 不兼容——**pi 扩展只能"参照移植"，MCP/SKILL 则按本文自行实现**（durable 只提供积木，宿主职责由本项目承担）。

---

## 3. 统一技能模型

### 3.1 三类能力，一个视图

| Kind | 载体 | 注册进 | 选配方式 | 模型可见形态 |
|---|---|---|---|---|
| `extension`（工具型，现有） | durable Extension（tools） | SkillRegistry → Registry | `agent.skills` 名单 | 工具声明 |
| `skill`（文档型，新增） | `SKILL.md` 文件（数据，不执行） | skills-catalog（见 §3.2） | `agent.skills` 名单 | section 中的目录条目 + read 按需读正文 |
| `mcp`（新增） | 动态构造的 durable Extension | SkillRegistry（bridge install） | `agent.skills` 名单（id=`mcp__<server>`） | 工具声明（direct）或 hidden |

统一不变量：**`agent.skills: string[]` 是唯一的选配真相**，三类条目混排其中；AgentManager 的 configure-extensions 链路（指纹含 skills）已支持热更新，无需新机制。

### 3.2 skills-catalog Extension（文档型技能的注入载体）

新增一个内置 Extension（id=`skills-catalog`），其 `section`（key=`available_skills`）在每次请求前动态渲染当前 Agent 选配的文档型技能目录：

```
<available_skills>
  <skill><name>frontend-design</name><description>…</description><location>/abs/.bot/skills/frontend-design/SKILL.md</location></skill>
</available_skills>
```

- 渲染函数从 `SkillRegistry` 读当前清单（registry 快照已可订阅变更）
- 提示词模板照抄 pi 的 `formatSkillsForPrompt`（含"相对路径按技能目录解析"的说明）
- 模型读正文走已有 read 工具——天然受沙盒 PathGuard 管束（见 §5.3 安全注意）
- 常驻 Extension（对所有 Agent 安装），但只渲染该 Agent 选配的条目——目录本身不泄露未选配技能

### 3.3 技能目录布局（`.bot/skills/` 扩展语义）

```
.bot/skills/
├── frontend-design/          # 文档型: 含 SKILL.md 即为 skill
│   └── SKILL.md
├── my-tools/                 # 工具型: 含 index.ts 即为 extension（现状不变）
│   └── index.ts
└── both/                     # 两者共存: SKILL.md 给知识, index.ts 给工具
    ├── SKILL.md
    └── index.ts
```

加载器（`skills/loader.ts`）扩展：扫到 `SKILL.md` → 注册文档型条目（id=目录名）；扫到 `index.ts` → 现状注册 Extension。技能 id 冲突时按 extension > skill 优先并记诊断。

---

## 4. SKILL 设计（M1）

### 4.1 解析与校验

`src/skills/document-skills.ts`（新）：

- frontmatter 解析：`name?`（缺省目录名，`/^[a-z0-9_-]+$/` 校验，对齐 Agent Skills 规范）、`description?`、`disable-model-invocation?`
- description 缺失 → 诊断（不注入目录，模型无法发现它）
- 不实现 pi 的 ignore 文件/嵌套扫描（我们的目录是 `.bot/skills/` 一级平铺，保持简单）

### 4.2 注入与读取

- skills-catalog section 渲染（§3.2）；正文由模型经 read 工具读取（绝对路径在目录条目中给出）
- 无需新增工具：read 已存在且受沙盒管束

### 4.3 管理台

- 技能区块（概览页 + Agent 表单选配列表）区分三类徽标：`tool` / `skill` / `mcp`
- 文档型技能展示 frontmatter 摘要与正文预览（read API 或随 providers 返回）

---

## 5. MCP 设计（M2）

### 5.1 配置模型（存业务库新表 `mcp_servers`）

```
mcp_servers(id TEXT PK, name TEXT, transport TEXT('stdio'|'http'), command TEXT, args TEXT/*json*/,
            env TEXT/*json*/, url TEXT, headers TEXT/*json*/, description TEXT,
            exposure TEXT('direct'|'hidden') DEFAULT 'direct', enabled INTEGER, updated_at INTEGER)
```

- 一期暴露策略只做 `direct` / `hidden`（`codemode` 留三期）；`toolExposure` per-tool 覆盖一并支持（pi 的模式匹配语义：精确名 > 模式，`hidden` 移除单工具）
- Agent 选配：`agent.skills` 中出现 `mcp__<server>` 即启用该 server 的工具
- 凭据（headers/env）沿用渠道的脱敏语义：响应掩码、掩码值提交还原

### 5.2 桥接模块 `src/skills/mcp/bridge.ts`（新）

- 依赖：**`@modelcontextprotocol/sdk`（官方 SDK，npm 稳定发布）**。pi 自带的 `packages/mcp` 未发布到 npm（`@earendil-works/mcp` 404，仅存在于本地 monorepo），不能作为构建依赖；其 `runtime.ts`/`tools.ts` 仍作为行为语义的参考实现（连接生命周期、exposure、命名、schema 转换）。协议是标准的，换 SDK 不影响设计
- 生命周期：
  - 懒连接：首次被某 Agent 选配并触发 configure 时连接；`withClient` 封装失败重连（对齐 pi runtime.ts 的模式）
  - `listTools` → 每工具构造 `defineTool`：name 用 `createMcpToolName` 同款（`mcp__<server>__<tool>` + hash 防冲突）、parameters 从 MCP inputSchema 转 typebox（MCP schema 即 JSON Schema，typebox 可兼容或走 `Type.Unsafe` 直通）、execute = `callTool` 转发 + 超时
  - 构造 `Extension { name: 'mcp__<server>', tools }` → `SkillRegistry.register`（category: `"mcp"`）
  - server 停用/删除 → uninstall；连接按引用计数关闭
- 沙盒关系：`callTool` 在**宿主进程**转发到外部 server——不经过本项目沙盒（外部进程有自己的隔离边界），**每次调用写审计**（server/tool/参数摘要/时长）

### 5.3 安全分析

| 风险 | 对策 |
|---|---|
| 工具描述注入提示（tool poisoning：MCP server 的 description 是不可信文本） | 目录与工具描述进入上下文前不做任何裁剪会被注入——一期：exposure 默认 direct 但 description 长度截断；管理台展示原始描述供人审；审计记录工具选择 |
| stdio command 是宿主进程执行 | 仅管理台可配置（管理员操作 = 信任边界），配置写入审计 |
| MCP http 出网 | 宿主进程 fetch，不经沙盒白名单——`url` 强制 http(s)，写审计；内网地址的管理台既有 Host 校验已覆盖 |
| 结果体积 | outputLimits（pi 同款 maxBytes/maxLines）默认限制，超大截断 |

### 5.4 管理台

- 新增「MCP 服务」区块：server 列表（transport/状态/工具数/启用开关）、新增/编辑表单（stdio: 命令+args+env；http: url+headers）、连接测试（listTools 试连）
- Agent 表单技能选配中 `mcp__<server>` 与其他技能混排，按 kind 分组展示

---

## 6. 里程碑与验收

| 里程碑 | 内容 | 验收 |
|---|---|---|
| **M1 文档型技能** | SKILL.md 解析 + skills-catalog section + 加载器扩展 + 管理台区分 | 放入 `.bot/skills/x/SKILL.md` 后，对话中模型能按目录主动 read 正文并遵循；已有工具型技能回归不受影响 |
| **M2 MCP 桥接** | 配置表 + bridge + direct/hidden + 管理台 | 配置一个 stdio MCP server（如 filesystem server），Agent 选配后工具可用且调用有审计；停用后下一条消息工具消失（热更新） |
| **M3 暴露策略增强** | toolExposure per-tool 过滤 + 描述截断 + 连接测试 UI | 大 server（50+ 工具）可只暴露子集 |
| **M4（三期候选）** | codemode（bash 沙盒承载 searchTools/callTool 脚本 API）、MCP OAuth、技能热重载（chokidar） | —— |

依赖风险：MCP inputSchema → typebox 的转换用 `Type.Unsafe` 直通 JSON Schema（typebox 支持）；官方 SDK 版本锁定后随常规升级。

---

## 7. 开放问题

1. **MCP server 的 Agent 级 vs 平台级**：本设计为"平台级注册 + Agent 选配"（与技能一致）。若出现"同一 server 不同 Agent 需不同凭据"，需升级为 per-agent 覆盖（类似 channel 凭据）——M2 暂不做
2. **内核网络白名单对 MCP http 无关**（宿主转发），但 stdio 子进程继承 bash 最小环境——MCP server 需要的 env 必须显式配在 `env` 字段（安全默认）
3. **文档型技能的沙盒可读性**：`platformDenyRead` 目前禁 `skillsDir`（工具源码不可读）。SKILL.md 正文需模型可读——调整为禁 `skills/*/index.ts`（代码）而放开 `SKILL.md`，横向隔离语义不变（skills 是平台共享资产）【已落地，含内核层同步；skills 代码 deny 模式不进 inode 指纹收集（glob 枚举会波及 SKILL.md）】

---

## 8. 实现备注（与设计的偏差与实测结论）

- **read_skill 工具（§4.2 的修正）**：设计假设"无需新增工具，read 已存在"——实测发现 `read` 属于 `coding-tools` 扩展，未选配它的 Agent（非编码类）读不了 SKILL.md，渐进披露断链。skills-catalog 因此自带 `read_skill(id)` 工具：只接受注册表内的技能 id，沙盒开启时优先经 `env.readTextFile` 走 PathGuard，**执行环境拒绝或调用方 Agent 解析失败一律 fail-closed 返回错误**；`disable-model-invocation: true` 的技能 read_skill 同样拒绝（仅供宿主触发）。目录提示词同步指向 read_skill。
- **热更新机制（实测确认）**：pi-durable 会话按**名字**解析扩展（`resolveAgent` 每次请求从 registry snapshot 取），故 MCP server 保存/停用后 `registry.install/uninstall` 即刻生效——既有会话的下一条消息自动使用新工具面，无需 reconfigure。SkillsCatalog 同理，但注意它必须显式 `registry.install`（不在 SkillRegistry 中）。**技能 reload 必须同时 reconcile AgentManager 的 durable registry**（`loadCustomSkills` 返回 added/updated/removed diff，server 层逐个 install/uninstall）——只改 SkillRegistry 是"假成功"。
- **技能语义边界（两轮评审后明确）**：技能是**平台共享知识资产**，选配控制的是"渐进披露目录中的可发现性 + read_skill 的工具层访问"，不是硬性安全隔离——沙盒对 SKILL.md 恒放行，拥有 read 工具的 Agent 可以直接读任何 SKILL.md。需要按 Agent 硬隔离技能正文时需另做 per-agent denyRead（当前无此需求）。
- **MCP 连接生命周期**：连接缓存 key = serverId + 配置指纹（配置变化必然 miss，旧连接关闭淘汰）；listTools 失败重连一次，**callTool 绝不重试**（外部 server 可能已执行副作用）；testServer 一次性连接不进缓存；停用/删除关闭连接回收 stdio 子进程；连接失败保留 last-known-good 工具面（不替换为 0）+ 60s 重试循环自动恢复；工具结果 20KB 中段截断 + outputLimits 双保险；工具名全局唯一（64 字符上限，净化冲突加 hash）。
- **定时任务语义：at-most-once**。先占坑（reserve 推进 next_run_at 后才执行）防重复触发；代价是进程在 reserve 后、执行完成前崩溃会**丢失该次触发**（不补发）。这是有意的取舍：重复触发（重复发消息/重复外部动作）比偶尔丢一次更不可接受。once 任务执行失败即终止（不重试）；创建/恢复过去时间的 once 被拒绝。
- **已知统计口径限制**：终端可观测性统计不含 compaction/summary 的 usage（durable 事件流不暴露其 usage 条目；pi footer 是扫全部 entries 实现的，我们走事件流增量）。/status 的会话累计为本进程生命周期内。
- **审计**：`mcp.call_tool`（server/tool/参数摘要 300 字符/时长/错误）、`mcp.server_saved/deleted/test`、`scheduler.*` 均入 audit_logs；`mcp_servers.headers/env` 响应脱敏（掩码提交=保留），复用渠道凭据语义。**url 不脱敏**——凭据不要放 url 查询参数，用 headers。
- **M3 提前并入 M2**：toolExposure（精确名 > 通配模式）、描述截断 500 字符（tool poisoning 缓解）、管理台连接测试 + exposure UI 已随 M2 交付。
- **测试**：`test/phase2.test.ts` 覆盖 frontmatter 解析/渐进披露/加载器（共存、upsert、builtin 保护、removed diff）/MCP 命名与 exposure/InMemoryTransport 全链路桥接（真实 callTool 转发与审计、不重试、配置重建、连续 sync 名字稳定）/SKILL.md 沙盒放行语义；`test/scheduler.test.ts`、`test/notifications.test.ts` 覆盖调度与通知。两轮对抗评审（herdr Claude+Codex）后新增 10 条回归。
