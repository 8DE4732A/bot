# 五期设计：工作区技能与工作区记忆

> 状态：设计稿（待评审）
> 评审：2026-10-18 经 herdr 同 tab Codex（空上下文）对抗评审；BLOCKING/MAJOR 已回写本文，逐条对应见 §13。
> 目标：让每个 Agent 的工作区成为它**私有、持久、可自我演进**的能力载体——Agent 自己在工作区里写/下载技能，后续所有会话自动生效；同时把工作区的 `AGENTS.md` 作为长期记忆自动注入。
> 参考：Agent Skills 规范（`../agentskills`）、pi coding agent 的技能与 context files 实现（`../pi/packages/coding-agent`）、hermes 的技能治理（`../hermes-agent`）。

---

## 0. 已确认的决策

| 编号 | 决策 | 说明 |
|---|---|---|
| D1 | **只做 Agent 私有技能，不做共享** | 现有 `.bot/skills/` 保持全局语义不变；本期只增加"工作区作用域"，不引入跨 Agent 共享目录 |
| D2 | **不做可执行技能的审批/提升** | 技能脚本与 Agent 自己写的脚本没有区别：都在沙盒里通过 bash 执行。工作区技能严格遵循 Agent Skills 规范（`SKILL.md` + `scripts/` 等），不把 bot 的平台级 `index.ts` 扩展机制引入工作区 |
| D3 | **下载技能不需要审批** | 下载只是把文件写进工作区；执行仍受沙盒网络/路径边界约束。保留审计与诊断即可 |
| D4 | **实现 `AGENTS.md` 自动加载** | 参考 pi coding agent 的 context files 行为，定位为"工作区记忆/附加指令" |
| D5 | **不新增配置文件** | 配置项继续走 `system_config`；本期不需要 schema 迁移 |
| D6 | **工作区技能优先** | 同名时工作区文档技能覆盖平台已选文档技能（项目级 > 用户级）；builtin 工具扩展、MCP 不受影响 |
| D7 | **AGENTS.md 仅扫工作区根** | 不遍历祖先目录；平台级共享记忆不在本期 |
| D8 | **引入 `yaml` 依赖** | 用于完整、健壮的 frontmatter 解析；配合大小与 alias 上限加固 |
| D9 | **新 Agent 工作区代际后缀** | 默认目录为 `.bot/workspaces/<safe-id>-<time>-<rand>/`；现有 Agent 路径不变，同 ID 重建不继承旧数据 |

---

## 1. 现状与差距

### 1.1 现有技能链路

| 环节 | 现状 | 位置 |
|---|---|---|
| 发现 | 只扫描平台级 `<cwd>/.bot/skills/`；启动时加载，`POST /api/skills/reload` 手动重扫 | `src/skills/loader.ts` |
| 选择 | `agent.skills: string[]` 是唯一选配真相，管理台勾选 | `src/skills/registry.ts` |
| 注入 | 常驻扩展 `skills-catalog` 渲染 `<available_skills>` 目录；`read_skill(id)` 按需读正文 | `src/skills/builtin/skills-catalog.ts` |
| 工具型 | 平台技能目录里的 `index.ts` 被 ESM `import()` 进宿主进程执行 | `src/skills/loader.ts` |
| 工作区 | 每 Agent 一个 `<cwd>/.bot/workspaces/<agent-id>/`，默认在 `allowWrite` 内 | `src/config/env-paths.ts:60`、`src/config/sandbox-defaults.ts:48` |
| 隔离 | 其他 Agent 的工作区在应用层与内核层均禁读 | `src/sandbox/execution-env.ts:125`、`src/sandbox/manager.ts:14` |

### 1.2 差距

1. **没有工作区作用域**：`SkillRegistry` 是全局单例，技能 id 全局唯一；
2. **没有自动发现**：工作区里的 `SKILL.md` 不会进入任何注册表；
3. **没有自动启用**：必须管理台勾选写进 `agent.skills`；
4. **没有热更新**：平台技能改完要手动 reload 或重启；
5. **没有工作区记忆**：`AGENTS.md` 不会进入提示词；
6. **解析器只覆盖旧子集**：当前 `parseSkillMd` 只认 `name/description/disable-model-invocation`，name 允许下划线、description 截断 500 字符，与 Agent Skills 规范不一致。

---

## 2. 目标与非目标

### 目标

- **G1** Agent 在 `<workspace>/.agents/skills/<name>/SKILL.md` 写入技能后，**下一轮对话**自动出现在技能目录并可按需激活；
- **G2** 工作区技能只属于该 Agent，其他 Agent 不可见、不可读；
- **G3** 技能符合 [Agent Skills 规范](https://agentskills.io/specification)：`SKILL.md` frontmatter、目录名约束、可选 `scripts/`、`references/`、`assets/`；
- **G4** Agent 用现有 `write` / `bash` 即可自写或下载技能，不需要新增宿主机写工具；
- **G5** `AGENTS.md`（及 pi 同款候选文件）作为工作区记忆，每个请求自动注入，修改后下一轮生效；
- **G6** 管理台可观测：看到每个 Agent 的工作区技能/记忆、诊断与遮蔽情况，可强制重扫；
- **G7** 所有读取仍经过 PathGuard（含 inode 硬链接防护），不因为"宿主侧扫描"打开新的泄漏面。

### 非目标

- **N1** 不做跨 Agent 共享技能目录；
- **N2** 不把平台级工具型扩展（`index.ts`）加载机制引入工作区；
- **N3** 不做技能下载审批、来源签名、quarantine；
- **N4** 不做工作区区之外的祖先目录 `AGENTS.md` 扫描（见 §4.7 的偏离说明）；
- **N5** 不做工作区技能的专用管理工具（创建/编辑/删除由 Agent 的通用文件工具完成）。

---

## 3. 规范对齐：Agent Skills

### 3.1 目录结构

```text
<agent.workspaceDir>/
├── .agents/skills/                 # 本期唯一默认扫描根（跨客户端约定）
│   └── <skill-name>/
│       ├── SKILL.md                # 必需：frontmatter + 正文
│       ├── scripts/                # 可选：可执行脚本（沙盒内 bash 运行）
│       ├── references/             # 可选：按需读取的参考文档
│       └── assets/                 # 可选：模板/图片/数据
├── AGENTS.md                       # 可选：工作区记忆/附加指令
└── AGENTS.override.md              # 可选：优先级更高的覆盖文件
```

- 默认根可通过 `system_config.workspace_skill_roots` 扩展（逗号分隔，相对工作区），例如追加 `.pi/skills`、`.claude/skills` 做生态兼容；
- 只扫描"根目录的直接子目录 + 其中的 SKILL.md"，不做深层递归；
- 当前 bot 平台级 `.bot/skills/` 的语义完全不变。

### 3.2 `SKILL.md` frontmatter 规范

| 字段 | 必需 | 约束 |
|---|---|---|
| `name` | 是 | 1–64 个 Unicode 码点；小写字母（含 Unicode `Ll`）/数字（`Nd`）/连字符；不能以连字符开头或结尾；不能有连续连字符；**必须等于父目录名**（双方 NFKC 归一化后比较） |
| `description` | 是 | 1–1024 个 Unicode 码点，非空；应同时说明"做什么"和"何时使用" |
| `license` | 否 | 许可证名称或指向同目录许可证文件 |
| `compatibility` | 否 | ≤500 个 Unicode 码点，环境要求（运行时/系统包/网络） |
| `metadata` | 否 | `map<string, string>`，客户端自定义元数据 |
| `allowed-tools` | 否 | 空格分隔的工具预授权字符串（实验性；本期只解析、不强制执行） |

**合规口径（重要，避免"严格规范"与"兼容扩展"混为一谈）：**

- 必需字段、`name`/`description`/`compatibility` 的约束以 agentskills 参考实现
  `skills-ref/src/skills_ref/validator.py` 为准（因此 `name` 接受 Unicode 小写字母/数字，
  不只是 ASCII）；
- 规范外的未知 frontmatter 字段按**警告但加载**处理，这是客户端的兼容扩展，不是规范的
  严格校验行为；
- `disable-model-invocation` 是本项目的客户端扩展字段，不属于 Agent Skills 规范；
- 所有长度限制按 **Unicode 码点**计数（`Array.from(str).length`），避免 JS UTF-16
  `String.length` 对 surrogate pair/emoji 的口径差异。

### 3.3 与当前实现的差异与升级

| 项 | 当前 | 五期 |
|---|---|---|
| frontmatter 解析 | 手写平铺 `key: value` + 块标量 | 引入 `yaml` 库解析（受限选项，见 §5.4），支持引号、嵌套 `metadata`、注释 |
| `name` 校验 | `^[a-z0-9_-]+$`，允许下划线，不要求与目录一致 | 按参考 validator：Unicode 小写字母/数字/连字符、NFKC、无首尾/连续连字符；工作区技能**严格要求 name == 目录名** |
| `description` 上限 | 500 字符截断 | 1024 个 Unicode 码点（规范值）；目录渲染可再按注入面截断 |
| 可选字段 | 不支持 | 解析并保存 `license`/`compatibility`/`metadata`/`allowed-tools` |
| 小写文件名 | 只认 `SKILL.md` | 兼容接受 `skill.md`（参考 parser 行为，**不是规范要求**）；两者同时存在时优先 `SKILL.md` |
| 资源清单 | 无 | 平台技能返回 `scripts/`/`references/`/`assets/` 相对路径清单；工作区技能不自动枚举（安全取舍） |
| 解析入口 | 单一 `parseSkillMd` | 拆为两个入口：`parseSkillMd`（平台宽松，保持现有签名/行为）与 `parseWorkspaceSkill`（工作区严格校验），避免新严格模式破坏 `test/phase2.test.ts` 的既有语义 |

### 3.4 渐进披露（沿用现有语义）

1. **目录层**：`<available_skills>` 每条包含 `name`、`description`、`location`，以及 bot 内部寻址用的 `<id>`（= 目录名 = 规范 `name`）；这与规范推荐的格式兼容，规范本身不强制是否携带 id；
2. **激活层**：模型判断匹配后调用 `read_skill(id)`，返回 SKILL.md 正文；
3. **资源层**：正文中引用的脚本/参考文件由模型按需用 `read` / `bash` 读取；相对路径以技能目录为基准。

---

## 4. 架构设计

### 4.1 作用域模型

`SkillRegistry` 增加一张**按 Agent 分区**的工作区表，与平台技能表互不干扰：

```ts
// 现有：平台技能
private skills = new Map<string, BotSkillMetadata>();

// 新增：agentId -> skillId(=目录名/name) -> metadata
private workspaceSkills = new Map<string, Map<string, BotSkillMetadata>>();
```

```ts
interface BotSkillMetadata {
  // ...现有字段
  scope: "platform" | "workspace";
  ownerAgentId?: string;      // workspace 技能必有
  sourcePath?: string;        // SKILL.md 绝对路径（诊断用）
  /** 内置文档技能：不依赖 agent.skills 勾选，目录恒可见（如 skill-creator） */
  autoEnabled?: boolean;
  spec?: {
    license?: string;
    compatibility?: string;
    metadata?: Record<string, string>;
    allowedTools?: string;
  };
}
```

- 工作区技能**不写入** `agent.skills`，不需要管理台勾选；
- 工作区技能**不注册成 durable Extension**（文档型技能是纯数据，`read_skill` 直接读池子里的条目）；
- id 只在"同一 Agent 内"唯一，天然避免跨 Agent 撞名；
- `autoEnabled` 的内置文档技能同样不写入 `agent.skills`，但会出现在每个 Agent 的技能目录中（见 §4.10）。

### 4.2 Agent 归属解析（避免循环依赖）

`skills-catalog` 与 `AgentManager` 互相 import 会形成直接循环。沿用项目已有的注入模式（类似 `setSlashFastPath`）：

```ts
// src/skills/agent-scope.ts
type Resolver = (conversationId: string) => string | undefined;
export function setAgentIdResolver(fn: Resolver): void;
export function resolveAgentId(conversationId: string): string | undefined;
```

接线点：`AgentManager.init()` 内（harness 就绪前即可设置）：

```ts
setAgentIdResolver((id) => AgentManager.getInstance().getAgentIdForConversation(id));
```

- `PromptInput.conversationId` 与 `ToolExecutionApi.conversationId` 都能拿到会话 id；
- 解析失败一律 **fail-closed**：不渲染工作区技能/记忆，`read_skill` 拒绝工作区技能。

### 4.3 发现：请求时惰性扫描

不需要文件监听、不需要 `conv.configure`、不需要重启。`skills-catalog` 的 section **每次请求前都会渲染**，`read_skill` 每次执行也都能拿到 `api.env`，因此：

```text
available_skills.render(input)
  ├─ agentId = resolveAgentId(input.conversationId)        // 失败 → 只渲染平台技能
  ├─ syncWorkspace(agentId, input.env)                     // 每次请求做指纹检查；解析结果缓存
  │    ├─ listDir workspace_skill_roots
  │    ├─ 逐个校验/解析 SKILL.md（经 readVerifiedText：平台硬规则 + 包含性 + no-follow）
  │    └─ 更新 SkillRegistry.workspaceSkills[agentId]
  └─ merge(平台已选文档技能, 工作区技能) → formatSkillsForPrompt
```

```text
read_skill.execute(args, api)
  ├─ agentId = resolveAgentId(api.conversationId)          // 失败 → 拒绝
  ├─ syncWorkspace(force) 或同一指纹检查
  ├─ 先查工作区（ownerAgentId === agentId），再查平台文档技能
  ├─ 读取经 readVerifiedText（平台硬规则 + 包含性 + O_NOFOLLOW + fstat）
  └─ 返回正文 + 技能目录（平台技能附资源清单）
```

**缓存与指纹（修正：TTL 不承担"下一轮生效"的正确性）**：

- 每 Agent 一个 `{ fingerprint, scannedAt, skills, diagnostics }`；
- **每次请求都做轻量指纹检查**：枚举 `workspace_skill_roots` 与各技能目录，读取
  `SKILL.md`/`AGENTS.md` 的 `(相对路径, size, mtimeMs)`；指纹未变时才复用已解析正文，
  指纹变化立即重新解析；
- TTL（如 1s）只用于"目录枚举结果的短缓存"这一优化，**不能**作为"跳过指纹检查"的
  依据——否则同一轮内刚写入、下一轮在 1 秒内开始时会漏掉变更；
- `read_skill` 执行前也必须做一次 `sync(force)`（或至少做同一指纹检查），不能只依赖
  上一次 section 渲染的结果；
- 同一 Agent 的 sync 用进程内单飞 Promise 合并并发请求；不同 Agent 独立；
- 扫描异常按单个技能降级为诊断，绝不把异常抛进提示词渲染链路。

**读取的原子性（修正：不能信任扫描时缓存的路径）**：

- 扫描阶段得到的 `sourcePath`/`realPath` 只用于目录展示与指纹，**每次实际读取**
  （`read_skill`、`AGENTS.md` 注入）都必须重新做一次：
  1. 平台硬规则（平台 deny + inode 指纹，独立于 `sandbox.enabled`，见 §5.2）；
  2. 目标真实路径必须位于该 Agent 工作区的真实路径之内；
  3. 以 `O_NOFOLLOW` 打开目标，`fstat` 校验打开后的 inode 与校验阶段一致，再从同一个
     文件句柄读取；
- 这一步用于封堵"扫描后把 SKILL.md 替换成 symlink/重新绑定路径"的 TOCTOU 窗口；
  具体实现放在 `SandboxedExecutionEnv` 的新 helper（如 `readVerifiedText`）里，而不是
  在扫描器里直接 `readFileSync`。

**为什么不用 `fs.watch`**：

- 只影响"管理台看到的实时性"，不影响对话生效（下一轮的指纹检查必然重新扫描）；
- 跨平台递归监听语义不一致，且工作区可能被外部进程（Git、编辑器）大量改写；
- 后续需要仪表盘实时刷新时再加 watcher 作为优化，而不是正确性依赖。

### 4.4 解析与校验（工作区专用严格模式）

对工作区技能逐项校验：

1. **扫描根校验**：`workspace_skill_roots` 的每一项必须是相对路径，拒绝绝对路径、
   `..`、空段；规范化后必须位于工作区真实路径之内；根必须是真实目录（不是 symlink）；
   多个根按真实路径去重并保持配置顺序；
2. `.agents/skills` 下的每个技能目录必须是真实目录（不是 symlink）；由于
   `fileInfo()` 会先经 PathGuard 解析 realPath、丢失"最后一级原本是 symlink"的信息，
   **最终类型判定必须使用父目录 `listDir()` 返回的 `kind`**（Dirent/lstat 语义），
   不能只依赖 `fileInfo`；
3. `SKILL.md`（或 `skill.md`）必须是真实普通文件，同上通过技能目录的 `listDir()`
   判定；同时校验 `canonicalPath` 位于技能目录真实路径之内；
4. 文件大小 ≤ 64KB；
5. frontmatter 必须是 YAML mapping；`name`/`description` 必需；
6. `name` 按 §3.2 校验，且 NFKC 后等于目录名；
7. `description` ≤1024、`compatibility` ≤500（均按 Unicode 码点）；`metadata` 值统一转字符串；
8. 单 Agent 技能数 ≤100；同名技能按扫描根顺序先到先得，后续记诊断；
9. 任一硬性校验失败 → 跳过该技能 + 诊断 + 审计（不静默）。

**平台硬规则不随 sandbox 关闭而失效**：`PathGuard.checkCanRead()` 在
`sandbox.enabled === false` 时整体短路（`src/sandbox/path-guard.ts:222-224`）。工作区
技能/记忆的读取必须走一个**独立的平台读取闸**（平台 deny + inode 指纹 + 工作区包含性 +
no-follow），不能复用 `enabled=false` 的 PathGuard 作为唯一防线；若该闸无法建立，则
工作区技能/记忆 fail-closed（不注入）。

平台技能维持现有宽松语义（警告但尽量加载），避免升级后存量技能突然消失；工作区技能
使用独立的严格入口 `parseWorkspaceSkill`，不要用 `strict` 参数复用并改变平台解析器行为。

### 4.5 注入与优先级

同一 Agent 可见的文档技能：

```text
builtin 工具扩展 / MCP        （不是文档技能，工作区无法覆盖）
平台文档技能（agent.skills 已选）
工作区文档技能                  ← 同名时覆盖平台文档技能
```

- 遵循 Agent Skills 的"项目级覆盖用户级"约定：工作区（项目作用域）优先；
- 只对**文档技能**生效；平台 `index.ts` 工具扩展、builtin、MCP 不受影响；
- 同名遮蔽记诊断并在管理台展示；
- `disable-model-invocation: true` 的工作区技能不进目录（仅供宿主/未来命令触发）。

### 4.6 `read_skill` 的行为升级

```xml
<skill_content name="pdf-processing" id="pdf-processing">
...SKILL.md 全文（含 frontmatter，超 20KB 中段截断并标注）...
</skill_content>

Skill directory: /path/to/workspace/.agents/skills/pdf-processing
Relative paths in this skill are relative to the skill directory.

<skill_resources>            <!-- 仅平台技能；工作区技能不自动枚举 -->
  <file>scripts/extract.py</file>
  <file>references/FORMS.md</file>
</skill_resources>
```

- **平台技能**的资源清单只列目录/文件**名称**，不读正文；最多 50 条，并过滤平台 deny 的 `*.ts/*.js`；
- **工作区技能不自动枚举资源**：`readdir` 本身仍存在祖先目录 symlink 竞态；模型按 SKILL.md
  中的相对路径用 `read`/`bash` 自行读取。这是明确的安全取舍（见 §5.2）；
- **寻址顺序必须是"工作区优先"**：先在该 Agent 的 workspace 分区按 `(agentId, id)` 查找，
  再回退到平台 `SkillRegistry.getSkill(id)`。不能反过来先查全局表，否则同 id 的平台文档技能
  会遮蔽工作区技能；
- **每次读取都重新校验并重新打开**（§4.3 的 `readVerifiedText`）：不信任扫描时缓存的
  `sourcePath`/`realPath`，防止扫描后 symlink 替换或路径重绑定；
- 工作区技能正文读取要求 `api.env` 存在；无 env 时工作区技能 **fail-closed**。
  实际读取由宿主 `readVerifiedText` 执行（从 workspace root 逐级 openat + 平台硬规则，
  与 env 的 PathGuard 同源）；平台技能同样要求 `api.env`，无 env 一律 fail-closed（不再宿主裸读）。
- `read_skill` 的选配校验：
  - 工作区技能：`ownerAgentId === 调用方 agentId`；
  - `autoEnabled` 内置文档技能（如 `skill-creator`）：无需勾选，但要求有效 agentId + `input.env` + 总开关；
  - 其他平台技能：沿用 `api.agent(context).extensions` 名单。

### 4.7 工作区记忆：`AGENTS.md`

#### pi coding agent 的行为（参考）

- 每个目录按顺序找第一个存在的：`AGENTS.override.md` → `AGENTS.md` → `AGENTS.MD` → `CLAUDE.md` → `CLAUDE.MD`；
- 先加载全局 `agentDir` 下的 context file，再从 `cwd` 向上走到根目录，**外层在前、内层在后**；
- 使用 canonical path 去重；
- 渲染为 `<project_context>` 内的 `<project_instructions path="...">` 块；
- 支持 `--no-context-files` 关闭；
- pi 的实现里 context files 读取本身不受 project trust 门控（受控的是项目扩展/项目技能资源）；
- 对 git worktree 有额外的"主仓库文件被 worktree 副本遮蔽"处理。

#### 本项目的适配

| 维度 | 决策 |
|---|---|
| 扫描根 | **只扫描 `<workspaceDir>` 根目录**，不向上遍历祖先 |
| 候选文件 | 与 pi 相同：`AGENTS.override.md` > `AGENTS.md` > `AGENTS.MD` > `CLAUDE.md` > `CLAUDE.MD` |
| 生效方式 | 常驻扩展 `workspace-context` 的 section（key: `workspace_context`），每个请求渲染前读取 |
| 修改生效 | 下一轮对话（每次请求做 mtime/size 指纹检查，无需重启） |
| 大小限制 | 单文件 ≤32KB；超限截断并附注（实现采用头部截断，避免为截断而读取超大文件） |
| 读取方式 | `input.env` + §4.3 的 `readVerifiedText`（平台硬规则 + 工作区包含性 + `O_NOFOLLOW`）；无 env → 省略并记 debug |
| 渲染顺序 | **在 durable 的 `instructions` 之前**：`resolveAgent()` 先收集全部扩展 section，最后才把 `instructions` 追加为最后一个 section（`dist/harness/agent.js:159-169`）。`workspace-context` 作为扩展 section 无法排到 instructions 之后；如果确需之后，只能把记忆拼进 `instructions`（需 reconfigure，牺牲热更新），本期不采用 |
| 注入内容 | 作为独立 section，不覆盖 Agent 的 `instructions` |

渲染形态：

```xml
<workspace_context>
The following instructions and memory come from the agent's workspace.

<project_instructions path="/.../workspace/AGENTS.md">
...文件内容...
</project_instructions>
</workspace_context>
```

#### 为什么不做祖先遍历（对 pi 的刻意偏离）

本项目 Agent 的 cwd 默认是 `<cwd>/.bot/workspaces/<agent-id>/`，它的祖先是：

```text
<cwd>/.bot/workspaces/<agent-id>   ← 本 Agent
<cwd>/.bot/workspaces              ← 所有 Agent 共享
<cwd>/.bot                         ← 平台自身（数据库/凭据/日志）
<cwd>                              ← 项目根
/ ...                              ← 文件系统
```

向上遍历会加载其他 Agent/平台共享的文件，直接违反 D1 的"只关心 Agent 自己"并且可能把平台级内容注入所有 Agent。pi 的 cwd 是项目根，祖先遍历是合理语义；本项目的工作区是 per-agent 叶子目录，因此默认不遍历。

如果未来确实需要"项目级共享记忆"，应显式增加一个**平台级、管理员维护**的文件（如 `<cwd>/.bot/AGENTS.md`），单独设计优先级与审计，而不是复用祖先遍历。

#### 为什么它属于"记忆"而不是"技能"

- 每个请求都会注入（不是按需激活），属于**持久行为约束/长期上下文**；
- **准确的持久化语义**：section 渲染结果会以 `pi.system` entry 追加到会话记录
  （`dist/harness/generation.js` 的 `appendEntry(SystemEntry, …)`），变更时只写增量 patch；
  它不是普通 user/assistant 消息，压缩序列化会**跳过 system message**
  （`dist/harness/compaction.js` 的 `serializeConversation`），因此不会进入压缩摘要正文，
  但仍保存在会话库中并在重放时恢复；
- 不要把它描述成"不进入 transcript"；正确说法是"作为 system section 持久化，不进入压缩摘要
  正文，每轮重新渲染，变更产生新的 system entry"；
- 写入后自动生效，适合 Agent 记录偏好、项目约定、长期事实；
- 代价是常驻 token，因此必须有大小上限与截断提示。

### 4.8 Agent 自写与下载

本期**不新增任何宿主侧技能管理工具**，复用现有能力：

| 动作 | 路径 |
|---|---|
| 自写技能 | `write` 工具写 `<workspace>/.agents/skills/<name>/SKILL.md`（自动创建父目录） |
| 写脚本/资源 | `write` / `bash` 写 `scripts/`、`references/`、`assets/` |
| 下载技能 | `fetch_url` 取文本后 `write`；或沙盒内 `bash curl`（受网络白名单约束） |
| 删除/修改 | `edit` / `write` / `bash rm` |

- 所有写操作仍经过 `SandboxedExecutionEnv.guardWrite`；工作区默认在 `allowWrite` 内；
- 下载的内容只是文件，不会在宿主进程执行；
- 技能的 `scripts/` 与 Agent 自己写的脚本完全同权：都由 `bash` 在沙盒内运行；
- 没有 `coding-tools` 的 Agent 不能自写技能——这是有意的能力边界；需要时由管理员为其启用 `coding-tools`，或后续再加一个窄能力的 `skill-manager` 扩展（非本期）。

### 4.9 生命周期与多 Agent

| 场景 | 行为 |
|---|---|
| 新会话/新渠道 | 同一个 Agent 的工作区相同，技能天然跨会话、跨渠道持久 |
| 进程重启 | 首个请求惰性扫描；无状态丢失 |
| 修改技能 | 下一轮请求指纹变化 → 重新解析 |
| 删除技能目录 | 下一轮从 registry 移除，目录/激活同步消失 |
| 删除 Agent | **归档默认工作区 + 清理 registry/缓存/映射**（见下） |
| 修改 workspaceDir | 清空旧条目、重扫新目录，并同步修正 `sandbox.filesystem.allowWrite`（见下） |
| 多 Agent 并发 | 每个 Agent 独立缓存/分区；扫描互不影响 |
| 自定义 workspaceDir | 生效，但必须通过唯一性与"新目录"校验（见下） |

#### 删除与同 ID 重建（修正 Codex B3）

现状是 `store.deleteAgent()` 只删数据库行、不删工作区；如果之后用同一 ID 新建 Agent，
默认路径又是 `.bot/workspaces/<id>`，新 Agent 会继承旧 Agent 的私有技能和 `AGENTS.md`。
本期必须补齐：

1. **默认工作区做"代际隔离"**：新建 Agent 的默认目录改为
   `.bot/workspaces/<safe-id>-<createdAt36>-<rand4>/`（现有 Agent 的路径不变）；这样同 ID
   重建必然得到新目录，不会继承旧数据；
2. **删除时归档默认工作区**：`DELETE /api/agents/:id` 在删除数据库行之前，把默认工作区
   `rename` 到 `.bot/workspaces/.archive/<id>-<timestamp>/`；DB 删除失败则回滚 rename；
   自定义 workspaceDir **不移动**（可能指向用户项目），只提示管理员自行处理；
3. **清理所有进程内状态**：`SkillRegistry.clearWorkspaceSkills(agentId)`、扫描缓存、
   `workspace-context` 缓存、`AgentManager.conversationToAgent` 中该 Agent 的映射；
4. **禁止无确认复用旧目录**：自定义 workspaceDir 如果已存在且包含 `.agents/skills` 或
   `AGENTS.md`，创建/迁移时必须显式带 `adoptExistingWorkspace: true`，否则 400 拒绝；
5. 回归测试：删除 → 同 ID 重建 → 新 Agent 的技能目录与记忆为空。

#### workspaceDir 唯一性（修正 Codex B4）

`platformDenyRead` 通过 `resolve(dir) !== self` 排除自身；如果两个 Agent 配置了**完全相同**
的 workspaceDir，两者都不会被对方的 deny 命中，per-agent 私有性不成立。因此：

- `saveAgent`（或 server 层）必须对 `workspaceDir` 做 `realpath` 规范化；
- 拒绝与任何其他 Agent 的规范化路径相同（大小写/符号链接归一后比较）；
- 拒绝 `.bot` 根、平台受保护路径、以及位于其他 Agent 工作区之内的路径；
- 已存在的重复配置在启动/管理台给出明确诊断（历史数据不做静默迁移）。

#### workspaceDir 变更（修正 Codex MAJOR）

- `saveAgent` 检测到 workspaceDir 变化时，必须在同一次保存中把
  `sandbox.filesystem.allowWrite` 里的旧工作区替换为新工作区（若旧值存在）；
- 确保新目录存在：默认路径由 `createAgentWorkspaceDir` 创建（0700）；显式自定义路径不存在时也自动 `mkdir -p`（0700，便于 API 客户端预创建项目目录）——这是已实现行为，不再是 400；
- `configFingerprint` 已包含 `workspaceDir`，下一轮会触发 `conv.configure` 更新 cwd；
  但 sandbox 配置是每次执行时从 DB 读取的，因此必须保证 DB 里的 allowWrite 已同步；
- 回归测试：改 workspaceDir 后 Agent 能在新目录自写技能，旧目录不再可写（除非仍在 allowWrite）。

### 4.10 内置 `skill-creator` 文档技能

Agent 能自写技能的前提是它知道"怎么写才算合格"。因此内置一个 **文档型技能**
`skill-creator`，用 Agent Skills 自己的渐进披露机制指导 Agent 创建技能——不是新增工具，
也不是把长篇规范塞进所有请求。

#### 定位与激活

| 项 | 决策 |
|---|---|
| 类型 | 内置文档技能（`kind: "skill"`，`builtin: true`，`autoEnabled: true`） |
| 是否需勾选 | **不需要**；所有 Agent 的技能目录恒包含它（受 `workspace_skills_enabled` 控制） |
| 目录注入 | `<available_skills>` 只放 name/description/location，约 50–100 token |
| 正文读取 | 模型判断要创建/修改技能时调用 `read_skill("skill-creator")` |
| 正文来源 | 代码内嵌（`src/skills/builtin/skill-creator.ts`），不依赖运行时磁盘文件；`read_skill` 直接返回 `document.body`，不执行文件 IO |
| 选择列表 | 管理台标记为"内置常驻"，不出现在 Agent 的可勾选技能列表中（避免"取消勾选但仍生效"的歧义） |
| 与工作区技能的关系 | 它只提供方法和规范，不替 Agent 创建文件；实际写入仍由 Agent 的 `write`/`bash` 完成 |

#### 正文结构（建议）

> 结构参考 Agent Skills 官方 `skill-creator`（Apache-2.0）与 `agentskills/docs/skill-creation/best-practices.mdx`；
> 正文按本项目"工作区 + 沙盒"的语义重写，不直接复制官方全文。

`skill-creator` 的 SKILL.md 应保持精简（目标 < 300 行），把细节留给 Agent 按需查阅
（workspace 技能本身就是最好的示例）。建议包含：

1. **何时使用**：用户要求创建/修改/优化技能，或 Agent 发现某套流程值得复用；
2. **技能目录约定**：`<workspace>/.agents/skills/<name>/SKILL.md`，可选
   `scripts/`、`references/`、`assets/`；
3. **frontmatter 模板与硬约束**：name 与目录一致、description 写清"做什么 + 何时用"、
   1024 码点上限、可选字段；
4. **渐进披露写法**：SKILL.md 保持 < 500 行；长参考资料放 `references/` 并在正文给出
   "何时读哪个文件"；确定性操作放 `scripts/` 并在正文列出来；
5. **写作风格**：祈使句、解释"为什么"、给出输入/输出示例、常见 gotchas、
   多步流程用 checklist、需要校验的流程设计"plan → validate → execute"循环；
6. **自检清单**：目录名/name 一致、description 非空且可触发、相对路径、脚本可在沙盒
   运行、无密钥、无网络假设未声明；
7. **迭代方法**：写 2–3 个真实测试 prompt → 用技能跑一遍 → 根据失败修正 →
   检查触发描述是否"undertrigger"；
8. **安全边界**：不写入密钥、不尝试绕过沙盒/网络白名单、脚本与 Agent 自己写的脚本同权
   （沙盒内执行）。

#### 实现要点

- `SkillRegistry.registerBuiltins()` 增加一个 `kind: "skill"`、`autoEnabled: true` 的条目；
- `skills-catalog` 的目录渲染条件从"已选配"扩展为
  `selected.has(id) || skill.autoEnabled`；
- `read_skill` 的选配校验对 `autoEnabled` 内置文档技能放行（但仍要求有效 agentId + `api.env` + 总开关，并校验 `disable-model-invocation`）；
- 内置文档技能的 `location` 为空，不在目录里渲染 `<location>`（避免模型去读一个不存在的路径）；
  目录条目只给 `name/description/id`，激活统一走 `read_skill`，正文来自 `document.body`；
- 正文内容用 `.ts` 常量或构建期嵌入，避免 `bun build --compile` 后读不到源文件；
- 如果未来内置文档技能变多，统一放在 `src/skills/builtin/docs/`，由注册表集中登记；
- 管理台 `/api/skills` 增加 `autoEnabled` 字段，AgentsView 的勾选列表过滤掉它们。

#### 为什么不做成工具型扩展

- 用户要的是"技能"，渐进披露的目录/正文机制正好匹配；
- 工具型扩展会常驻工具列表并占用工具选择面，而创建技能是低频、流程型任务；
- 文档技能可以引用 `references/`、`scripts/` 等 agentskills 资产，保持一致的心智模型。

---

## 5. 安全模型

### 5.1 威胁与对策

| 威胁 | 对策 |
|---|---|
| 工作区写 `index.ts` 期望宿主执行 | **本期不加载任何工作区代码**；只认 `SKILL.md` 等数据文件；`index.ts` 只作为普通资源存在，最多被沙盒 bash 执行 |
| symlink 指向其他 Agent 工作区/平台文件 | 根目录、技能目录、SKILL.md 全部要求真实类型（父目录 `listDir` 的 kind）+ 每次读取时重新 `canonicalPath` 包含性校验；不满足即拒绝 |
| 扫描后把 SKILL.md 换成 symlink/重绑路径（TOCTOU） | 每次读取重新校验，`O_NOFOLLOW` 打开并从同一 fd 读取，`fstat` 与校验阶段 inode 比对；不信任缓存路径 |
| 硬链接把 `bot.sqlite` 变成 `SKILL.md` | 宿主扫描**不得裸读**：平台硬规则（平台 deny + inode 指纹）**独立于 `sandbox.enabled`**；运行时与管理台都必须过这道闸。**实机新发现**：SQLite 的 WAL/rollback 连接在主库出现第二个硬链接后会持续返回 `disk I/O error`，`link(2)` 本身不受读 deny 约束——因此额外在 `exec` 入口阻断硬链接命令，并让 `DatabaseManager` 在 IO 错误时自动 reopen 恢复 |
| sandbox 关闭导致 PathGuard 短路 | 工作区技能/记忆使用独立的平台读取闸，不能复用 `enabled=false` 的 PathGuard 作为唯一防线；闸不可用则 fail-closed |
| 路径穿越/保留名 | 目录名按规范校验（无斜杠/点段）；拒绝 `..`、绝对路径、`skills-catalog`、`mcp__*`、`ws__*`；`workspace_skill_roots` 逐项规范化并限制在工作区内 |
| 超大文件/海量技能 DoS | 64KB/SKILL.md、100 技能/Agent、20KB read_skill 输出、平台技能资源清单 50 条、32KB 记忆；截断并提示 |
| 提示词注入（下载的技能） | 内容按不可信文本处理：XML 转义、描述截断、正文上限；执行仍受沙盒网络/路径边界约束；变更写审计；不做审批（D3） |
| 跨 Agent 读取 | registry 分区 + workspaceDir 唯一性校验 + `platformDenyRead`（应用层）+ `kernelDenyRead`（内核层） |
| 删除后同 ID 重建继承私有工作区 | 默认工作区代际隔离 + 删除时归档 + 清理 registry/缓存/映射；自定义目录需显式 `adoptExistingWorkspace` |
| 两个 Agent 配置相同 workspaceDir | saveAgent 拒绝规范化后的重复路径 |
| Agent 自修改记忆/技能 | 这是需求本身；写操作经 PathGuard 并审计，管理台可观测/删除 |

### 5.2 读取路径必须统一

工作区扫描器有两套运行环境，但必须共享同一个"工作区读取闸"：

1. **平台硬规则（无条件）**：平台 deny 清单 + inode 硬链接指纹。不能因为
   `sandbox.enabled === false` 而跳过——`PathGuard.checkCanRead()` 在 disabled 时
   整体短路，因此工作区读取统一传 `{ force: true }`，强制平台规则始终生效；
2. **工作区包含性**：目标 `canonicalPath` 必须位于该 Agent 的 `canonicalPath(workspaceDir)`
   之内；`workspace_skill_roots` 与技能目录同样适用；
3. **真实类型**：最终组件用父目录 `listDir()` 的 `kind` 判定（`fileInfo()` 会解析 realPath，
   丢失最后一级 symlink 信息）；
4. **原子读取（openat）**：`readVerifiedText` 从 `workspaceReal` 打开目录 fd，逐级
   `openat(2)`（每级 `O_NOFOLLOW|O_DIRECTORY`，最终文件 `O_NOFOLLOW`），再用 `fstat`
   + 同一 fd 读取。**不再用字符串路径 `open`**——祖先目录被替换为 symlink 也无法重定向；
   通过 `bun:ffi` 调用 libc `openat`（macOS/Linux），编译单二进制可用；失败时 fail-closed。
   用于 `read_skill`、`AGENTS.md` 注入、管理台扫描；
5. **失败 fail-closed**：任何一步失败只返回诊断，不注入内容。

运行时会话：

1. **运行时**（section/read_skill）：使用该会话的 `ExecutionEnv`（`input.env` / `api.env`），
   但它只作为底层 IO；平台硬规则 + 包含性 + no-follow 由 `readVerifiedText` 统一施加，
   不能假设 PathGuard 已经覆盖；
2. **管理台**（`/api/agents/:id/workspace-skills`）：没有会话 env，必须构造同样的
   `PlatformReadGuard`：
   - 复用 `platformDenyRead(workspaceDir, store)`（本期从 `execution-env.ts` 导出或抽到共享模块）；
   - 用 agent 的 `sandbox.filesystem` 配置 + 平台硬规则校验，但**平台硬规则不受
     `sandbox.enabled` 影响**；
   - 只读校验后的 realPath，并做工作区包含性；
   - 任一步失败只返回诊断，不返回文件内容。

**禁止**在扫描器里直接 `readFileSync` 用户可控路径。现有 `parseSkillMd` 的直接读取只保留给平台技能（平台目录管理员可控），工作区技能必须走受保护 reader。

### 5.3 审计

| 事件 | 时机 | 内容 |
|---|---|---|
| `workspace.skills.loaded` | 扫描结果指纹变化 | agentId、技能名列表、diagnostics 摘要 |
| `workspace.skill.rejected` | 校验/路径/读取失败 | agentId、路径、原因 |
| `workspace.memory.loaded` | 记忆文件指纹变化 | agentId、路径、字节数 |
| `workspace.memory.rejected` | 读取失败/超限 | agentId、路径、原因 |

- 不在每次读取时刷审计（避免噪音）；`skill.read` 只在 debug 日志；
- **审计不记录正文/metadata 内容**：拒绝事件只记录路径、原因、大小与技能名，避免把
  平台文件或被拒绝的内容写进审计表/日志；
- **审计写入失败不改变安全决定**：先完成安全判定与内容注入决策，审计失败只记 warn，
  不得因为审计失败而放行读取；反之，拒绝决定也不依赖审计成功；
- 管理台删除/重扫操作沿用现有审计风格。

### 5.4 YAML 解析加固

引入 `yaml`（纯 JS，无原生依赖）替代手写解析器，并限制：

- 输入先做 64KB 上限；
- `maxAliasCount` 设小（如 10），防止 alias 膨胀；
- 不做自定义 tag 求值；只接受普通 mapping/scalar；
- 解析结果必须是对象；`metadata` 只保留 `Record<string, string>`；
- 解析失败 → 跳过该技能 + 诊断。

> 已确认采用 `yaml`（D8）。若后续要回到零新增依赖，需要保留同样的测试矩阵，并接受跨客户端
> frontmatter（引号含冒号、嵌套 `metadata`、块标量）兼容性下降。

### 5.5 硬链接 DoS 与恢复（实机发现，2026-10-18）

实机验证时发现一个超出原评审范围的宿主稳定性问题：

- `ln .bot/bot.sqlite <workspace>/.../SKILL.md` 后，SQLite 的 **WAL 连接会持续返回
  `disk I/O error`**（rollback journal 模式下写入同样失败；只读查询在部分场景可用）。
  这不是"读到密钥"的数据泄露，而是 `link(2)` 本身让 SQLite 认为主库文件状态异常；
  PathGuard 的 inode 指纹只能阻止**读取**，阻止不了链接创建。
- 攻击面：Agent 的 bash 只要能在工作区创建文件，就能对 `.bot/bot.sqlite` /
  `conversations.sqlite` 做硬链接；沙盒关闭时更直接。数据库不可用会拖垮 gateway。

实现层修复：

1. **exec 硬链接闸**（`execution-env.ts` 的 `hardlinkBlocked`）：在命令进入 shell/ASRT
   之前，阻断 `ln`（非 `-s`）、`link`、`cp -l`/`--link`；独立于 `sandbox.enabled`。
   符号链接 `ln -s` 仍允许（读取侧由 PathGuard/inode 防护）。脚本内
   `os.link` / `perl link` / `bash -c` 等动态形态无法静态穷举，记为残余面。
2. **数据库自动恢复**（`database/index.ts`）：`Disk I/O error` 时关闭并重开连接、
   清空预编译语句缓存；`query/queryOne/run` 重试一次，`exec` 不重放事务（避免半程重入）。
   重开后 WAL 正常恢复，硬链接仍存在也不影响后续读写。
3. **实机验证**：创建指向 `bot.sqlite` 的硬链接后，第一次扫描触发 reopen 并返回
   "hard link to platform-protected data" 诊断；第二次扫描 200；`/api/status` 保持存活。

残余取舍：静态闸挡不住任意脚本形式的 `link(2)`；根治需要 OS 级用户隔离（Agent bash
以不同 UID 运行，或 `.bot` 放到独立文件系统），列入 backlog。自动 reopen 保证
"被攻击后服务可恢复"，但不能阻止攻击者反复制造瞬时错误。

---

## 6. 配置与数据

**本期不需要数据库迁移**。所有开关走现有 `system_config`：

| key | 默认 | 说明 |
|---|---|---|
| `workspace_skills_enabled` | `1` | 全局开关；关闭后不扫描/不注入 |
| `workspace_skill_roots` | `.agents/skills` | 逗号分隔的相对根；可追加 `.pi/skills`、`.claude/skills` |
| `workspace_skills_max_count` | `100` | 单 Agent 上限 |
| `workspace_skill_max_bytes` | `65536` | 单个 SKILL.md 上限 |
| `workspace_memory_enabled` | `1` | 工作区记忆开关 |
| `workspace_memory_max_bytes` | `32768` | 单个记忆文件上限 |

工作区技能的元数据以文件系统为唯一真相；不在 SQLite 建表/缓存（避免磁盘/数据库双源漂移）。按 Agent 的运行时缓存只在进程内。

`workspace_skill_roots` 的每一项必须经过校验：相对路径、非绝对路径、无 `..`/空段、
符号链接解析后仍位于工作区内、真实目录、按 canonical path 去重并保持配置顺序；非法项跳过
并记诊断，不能因为配置错误让扫描越界或让同名顺序不稳定。

---

## 7. API 与管理台

### 7.1 API

| 方法/路径 | 说明 |
|---|---|
| `GET /api/skills` | **保持不变**：只返回平台技能，避免污染现有"选配列表"语义 |
| `GET /api/agents/:id/workspace-skills` | 受保护扫描，返回 `{enabled, roots, skills[], diagnostics[], memory}`；`memory` 为对象（路径、大小、mtime、是否截断）或 `null`，**默认不返回正文预览** |
| `POST /api/agents/:id/workspace-skills/reload` | 清空该 Agent 缓存并强制重扫；返回同上 |
| `GET /api/agents/:id/workspace-memory` | 可选端点；如提供预览，必须走同一 `readVerifiedText` 并在响应中标注截断，且绝不写入审计 |

- 端点复用管理台 token/Host/Origin 校验；
- Agent 不存在 → 404；
- 扫描只读，不修改文件；
- 删除技能不在 API 提供（管理员可直接操作文件系统；避免管理台获得宽写能力）。

### 7.2 前端

- **Agent 卡片/编辑页**新增只读区块："工作区能力"
  - 技能列表：name、description、来源根、大小、修改时间、`spec` 摘要；
  - 诊断：无效/被平台同名遮蔽/symlink 拒绝等；
  - 记忆：加载中的 `AGENTS.md` 路径与大小；
  - 按钮：`重新扫描`；
- **Overview/Skills 区域**：平台技能列表保持不变；可在 Agent 行显示"工作区技能 N"；
- **内置常驻技能**：`skill-creator` 在技能库中标记为 `builtin + autoEnabled`，Agent 的勾选列表
  过滤掉它（它恒生效），避免"取消勾选但仍出现"的歧义；
- **视觉**：沿用现有状态语义（青绿=生效，琥珀=警告/遮蔽，砖红=无效）；机器数据用 `.mono`。

### 7.3 事件

- `workspace.skills.changed`（agentId）
- `workspace.memory.changed`（agentId）

经现有 EventBus / SSE 广播，管理台静默刷新，不引入新传输。

---

## 8. 代码改动清单

| 文件 | 改动 |
|---|---|
| `src/skills/document-skills.ts` | 升级解析器（YAML、规范字段、name 校验、description 1024）；拆出 `parseSkillMd`（平台宽松，保持签名/行为）与 `parseWorkspaceSkill`（严格）；提供"从字符串解析"的纯函数，支持受保护 reader 返回的内容 |
| `src/skills/workspace.ts`（新） | 工作区扫描/校验/缓存：`syncWorkspaceSkills(agentId, env, opts)`、`scanWorkspaceSkillsForAdmin(agentId)`、记忆文件发现与读取；每次请求做指纹检查、单飞、force 重扫 |
| `src/skills/registry.ts` | 增加 per-agent `workspaceSkills` 分区与 `register/replace/list/get/remove/clearWorkspaceSkills` API；`BotSkillMetadata` 增加 `scope/ownerAgentId/sourcePath/spec/autoEnabled`；`registerBuiltins()` 注册内置文档技能 `skill-creator` |
| `src/skills/builtin/skill-creator.ts`（新） | 内置文档技能正文（SKILL.md 内容以 `.ts` 常量或构建期嵌入；目标 <300 行），覆盖目录约定、frontmatter、渐进披露、自检与迭代方法 |
| `src/skills/agent-scope.ts`（新） | `setAgentIdResolver` / `resolveAgentId`（fail-closed） |
| `src/skills/builtin/skills-catalog.ts` | section 合并平台 + 工作区技能（工作区优先）；目录条件扩展为 `selected.has(id) \|\| autoEnabled`；`read_skill` 增加工作区寻址、归属校验、autoEnabled 放行、`readVerifiedText`（openat）、平台资源清单、包装标签 |
| `src/skills/builtin/workspace-context.ts`（新） | `AGENTS.md` section：候选文件、指纹刷新、大小截断、`readVerifiedText` |
| `src/core/agent-manager.ts` | `init()` 注册 `setAgentIdResolver`、安装 `workspace-context`；新增 `purgeAgent(agentId)` 清理 registry/扫描缓存/`conversationToAgent` 映射 |
| `src/sandbox/path-guard.ts` | `checkCanRead(rawPath, { force })`：`force` 时平台 deny + inode 指纹**不随 `enabled` 短路** |
| `src/sandbox/execution-env.ts` | 导出 `platformDenyRead`（或抽到 `sandbox/platform-paths.ts`）；新增 `readVerifiedText`（包含性 + `O_NOFOLLOW` + `fstat` + fd 读取）；管理台复用同一 guard |
| `src/config/database-store.ts` / `src/server/server.ts` | workspaceDir 规范化唯一性校验；变更时迁移 `allowWrite`；删除 Agent 时归档默认工作区并调用 `purgeAgent`；新增工作区技能/记忆端点；EventBus 事件 |
| `src/config/env-paths.ts` | 新 Agent 默认工作区带代际后缀（现有路径不变）；提供归档目录 helper |
| `web/src/types.ts`、`web/src/api.ts`、`web/src/views/AgentsView.tsx` | 类型、API 封装、Agent 详情只读区块与重扫按钮；勾选列表过滤 `autoEnabled` 技能，技能库标记"内置常驻" |
| `package.json` | 新增 `yaml` 依赖（D8） |
| `test/phase5-workspace.test.ts`（新） | 规范解析、扫描、隔离、热更新、记忆、安全回归 |

---

## 9. 测试计划

### 9.1 单元/解析

- 规范 frontmatter：必需字段、可选字段、引号含冒号、块标量、嵌套 `metadata`；
- name 校验矩阵：大小写、首尾连字符、连续连字符、超长、Unicode/NFKC、目录名不匹配；
- description 1024 边界；compatibility 500；未知字段警告；长度按 Unicode 码点计数（含 emoji/代理对）；
- CRLF/BOM；无 frontmatter；未闭合 frontmatter；非法 YAML；alias 膨胀拒绝；
- 平台 `parseSkillMd` 的既有宽松行为保持（`test/phase2.test.ts` 不改语义）；工作区严格入口单独断言。

### 9.2 发现与隔离

- 工作区写入 `SKILL.md` → **不 sleep**，下一次 render/read_skill 立即出现（验证每次请求做指纹检查，而不是依赖 TTL 过期）；
- 修改/删除 → 下一次 render/read_skill 立即更新/消失；
- 两个 Agent 各自技能互不可见；A 用 B 的技能 id 调 `read_skill` 失败；
- 平台文档技能与工作区同名 → 工作区覆盖 + 诊断；`read_skill` 先查工作区分区；
- 平台工具扩展/builtin/MCP 不被覆盖；
- 自定义 `workspaceDir` 生效且隔离正确；
- 两个 Agent 保存相同规范化 workspaceDir → 拒绝；
- 删除 Agent → 默认工作区归档 → 同 ID 重建 → 新 Agent 看不到旧技能/记忆；
- 多个 `workspace_skill_roots` 的优先级、去重与同名诊断；非法 root（绝对路径/`..`/symlink/越界）被跳过；
- **内置 `skill-creator`**：所有 Agent 的 `available_skills` 都包含它（无需 `agent.skills` 勾选）；
  `read_skill("skill-creator")` 可读；把它写进 `agent.skills` 或不写都不影响结果；管理台勾选列表
  不出现它；`workspace_skills_enabled=0` 时它与其他工作区能力一起关闭。

### 9.3 安全回归

- `.agents/skills`、技能目录、SKILL.md 为 symlink → 拒绝（用父目录 `listDir` 的 kind 判定，走生产 `SandboxedExecutionEnv`）；
- symlink 指向其他 Agent 工作区/`bot.sqlite` → 拒绝；
- **扫描后把 SKILL.md 换成 symlink/重绑路径 → `readVerifiedText` 重新校验并拒绝（TOCTOU）**；
- **硬链接到 `bot.sqlite` 作为 SKILL.md → 拒绝（inode 防护，走生产实现）**；
- **`sandbox.enabled=false` 时，平台 deny + inode + 工作区包含性仍然生效**（独立 `PlatformReadGuard`）；
- `..`、绝对路径、保留名 → 拒绝；
- 超过数量/大小上限 → 拒绝/诊断；
- 无 env / 无 Agent 解析 → 工作区技能不注入，`read_skill` fail-closed；
- 平台 `index.ts` 放在工作区 → 不被 import（只有沙盒 bash 可能执行它）；
- 管理台扫描不绕过 `PlatformReadGuard`，且审计/响应不包含被拒绝文件的正文。

### 9.4 记忆

- 候选优先级（override > AGENTS.md > CLAUDE.md）；
- 只在工作区根、不遍历祖先；
- 超限截断提示；
- 指纹变化后下一次请求生效（不 sleep）；
- **system entry 语义**：变更产生新的 `pi.system` entry；压缩后重放仍保留记忆，压缩摘要正文不包含它；
- 无 env/读取失败时省略且不破坏其他 section；
- `workspace-context` 作为扩展 section 排在 `instructions` 之前（按 durable 实际顺序断言）。

### 9.5 回归

- 现有平台技能加载、选配、reload、MCP、`read_skill` 未选配拒绝、沙盒放行语义全部保持；
- `bun test` 全绿；`bun run typecheck` 通过。

---

## 10. 分阶段实施

### M1：核心能力

- 规范解析器升级（`parseSkillMd` 平台宽松 / `parseWorkspaceSkill` 工作区严格）；
- `workspace.ts` 扫描器 + `PlatformReadGuard` + `readVerifiedText`（TOCTOU/硬链接/包含性）；
- `SkillRegistry` 分区 + `agent-scope` resolver + `clearWorkspaceSkills`；
- `skills-catalog` 合并与 `read_skill` 升级；
- 内置 `skill-creator` 文档技能（autoEnabled、正文内嵌、管理台标记）；
- `workspace-context`（`AGENTS.md`，按真实 section 顺序）；
- `system_config` 开关 + `workspace_skill_roots` 校验；
- 删除 Agent 的工作区归档/代际隔离/缓存清理；workspaceDir 唯一性与 allowWrite 迁移；
- 单测/集成/安全回归。

**验收**：默认 Agent 在 `.agents/skills/demo/SKILL.md` 写入技能后，下一次请求（不 sleep）目录出现、可读；`AGENTS.md` 写入后下一次请求提示词出现；其他 Agent 不可见；删除同 ID 重建不继承；sandbox 关闭时平台文件仍不可读。

### M2：可观测与管理台

- `GET /api/agents/:id/workspace-skills`、`POST reload`；
- Agent 详情只读区块、诊断、重扫；
- EventBus 事件 + SSE 静默刷新；
- 管理台扫描复用 `PlatformReadGuard`；
- 审计事件（不含正文）。

**验收**：管理台能看到每个 Agent 的工作区技能/记忆、无效诊断与遮蔽原因，并可重扫。

### M3：可选增强（backlog）

- `.pi/skills`、`.claude/skills` 生态根（配置项已留）；
- 激活去重、技能正文的压缩保护；
- per-agent 开关；
- 文件 watcher 实时刷新；
- 平台级共享记忆（显式设计，非祖先遍历）；
- `skill-manager` 专用工具（如果确认需要非编码 Agent 自写）；
- `allowed-tools` 的权限执行（当前只解析）。

---

## 11. 风险、取舍与 backlog

| 项 | 说明 |
|---|---|
| 提示词注入 | 工作区技能/记忆是 Agent 可写、可下载的不可信文本；沙盒限制了"执行面"，但无法阻止模型被说服去使用允许的工具。本期按 D3 不做审批；靠审计、大小限制与网络/路径边界收敛 |
| 上下文成本 | `AGENTS.md` 每轮常驻；技能目录每条约 50–100 token；已设上限并截断 |
| `allowed-tools` | 规范标注实验性；本期只解析展示，不改变工具的可用性 |
| Unicode 文件名 | macOS NFD/NFKC 可能造成目录名比较差异；统一 NFKC 后比较，路径仍用原始目录名；长度按 Unicode 码点计数 |
| 平台技能代码可读性 | 资源清单需过滤平台 deny 的 `*.ts/*.js`，避免把工具源码列给模型 |
| 管理台扫描 | 必须复用 `PlatformReadGuard`（平台 deny + inode + 包含性 + no-follow），且平台规则不受 `sandbox.enabled` 影响；这是最容易在实现时"图省事直接 readFile"而引入泄漏的点 |
| TOCTOU | 扫描与读取之间可能被替换；每次读取重新校验并用 `O_NOFOLLOW` + `fstat` 绑定同一 fd；残余竞态窗口在文档中明确 |
| 删除 Agent | 默认工作区归档 + 代际隔离 + 清理 registry/缓存/映射；自定义目录需显式 `adoptExistingWorkspace` |
| 祖先记忆 | 明确不做；若未来要做，必须区分"Agent 私有"与"平台共享" |
| 压缩保护 | 工作区记忆作为 `pi.system` entry 持久化；压缩摘要跳过 system message，但条目仍在会话库/重放中；`read_skill` 的正文仍可能被压缩，后续可加保护标记 |
| 工作区可执行扩展 | 明确不做；工作区只承载 Agent Skills 规范的数据/脚本，不承载 bot 的 `index.ts` 扩展 |
| AGENTS.md 注入顺序 | durable 先收集扩展 section、最后追加 `instructions`；`workspace_context` 实际排在 instructions 之前，文档与测试按真实顺序断言 |
| `skill-creator` 规范漂移 | 内置正文是对 Agent Skills 规范与最佳实践的摘要；规范演进时需要同步更新，并用"内置技能自检"测试守住 name/description/目录约定 |

---

## 附录 A：Agent Skills 合规检查表

- [ ] 技能目录包含 `SKILL.md`（兼容 `skill.md`，优先大写）
- [ ] frontmatter 以 `---` 开始和结束，解析为 YAML mapping
- [ ] `name`：1–64 个 Unicode 码点、小写字母/数字/连字符、无首尾/连续连字符、与目录名 NFKC 一致
- [ ] `description`：1–1024 个 Unicode 码点、非空
- [ ] 可选 `license` / `compatibility`（≤500）/ `metadata`（string→string）/ `allowed-tools`
- [ ] 正文为 Markdown，无格式限制
- [ ] 可选目录 `scripts/`、`references/`、`assets/` 不强制读取
- [ ] 渐进披露：目录含 name/description/location（bot 额外带 id 供 `read_skill` 寻址）；正文按需读取
- [ ] 相对路径以技能目录为基准
- [ ] 平台技能资源清单只列路径，不预读；工作区技能不自动枚举
- [ ] 客户端扩展：`disable-model-invocation` 不属于规范字段；未知字段警告但加载

## 附录 B：pi coding agent 参考行为

| 能力 | pi 行为 | 本项目适配 |
|---|---|---|
| 项目技能 | `<cwd>/.pi/skills` + `<cwd>/.agents/skills`（含祖先 `.agents/skills`） | 仅 `<workspace>/.agents/skills`（+ 可配置兼容根），不遍历祖先 |
| 用户技能 | `~/.pi/agent/skills`、`~/.agents/skills` | 现有平台 `.bot/skills` 对应"全局"，语义不变 |
| 技能冲突 | 项目级覆盖用户级 | 工作区覆盖平台文档技能 |
| context files | 每目录 `AGENTS.override.md` → `AGENTS.md` → ...，全局 + 祖先，外层在前 | 仅工作区根，同名候选顺序一致 |
| context files 开关 | `--no-context-files` | `system_config.workspace_memory_enabled` |
| context files 刷新 | durable prompt 按 cwd 缓存一次 | 每请求 mtime 指纹刷新（热更新） |
| project trust | 项目扩展/项目技能资源受 trust 约束；context files 读取本身不门控 | 工作区是 Agent 私有可写区，不做 trust 审批（D2/D3） |

---

## 12. 已确认决策与剩余默认项

### 已确认（2026-10-18）

1. **工作区技能优先**：同名时覆盖平台已选文档技能（D6）；builtin 工具扩展、MCP 不受影响；
2. **`AGENTS.md` 仅扫工作区根**（D7），不做祖先遍历，也不做平台级共享记忆；
3. **引入 `yaml` 依赖**（D8）；
4. **新 Agent 默认工作区使用代际后缀**（D9），现有 Agent 路径不变。

### 剩余默认项（不阻塞实现；如需调整请提出）

| 项 | 默认 |
|---|---|
| 管理台能力 | 只读列表 + 诊断 + 强制重扫；不提供删除/编辑（Agent 自管文件） |
| 工作区记忆上限 | 单文件 32KB，超限中段截断并提示 |
| `skill-creator` | 内置、`autoEnabled`、不可从勾选列表关闭；受 `workspace_skills_enabled` + 有效 agentId + 执行环境控制 |
| 工作区技能上限 | 100 个/Agent、单 SKILL.md 64KB、read_skill 输出 20KB、平台技能资源清单 50 条 |
| 工作区技能根 | 默认 `.agents/skills`；可通过 `system_config.workspace_skill_roots` 追加兼容根 |

---

## 13. Codex 对抗评审修正记录（2026-10-18）

> 评审方式：herdr 同 tab（`w5:t1` / pane `w5:p8`）Codex，空上下文直接 prompt；只读评审，未修改文件。
> 原结论：4 BLOCKING / 7 MAJOR / 6 MINOR。以下为逐条处理。

### BLOCKING

| # | 评审结论 | 本文修正 |
|---|---|---|
| B1 | 运行期没有证明读取目标仍在工作区内；`checkCanRead` 不要求包含性，且校验后按路径重开存在 TOCTOU | §4.3 新增"每次读取重新校验 + `readVerifiedText`（O_NOFOLLOW + fstat + fd 读取）"；§4.6/§4.7/§5.2 同步 |
| B2 | `sandbox.enabled=false` 时 `PathGuard` 整体短路，平台 deny/inode 全失效 | §4.4/§5.2 读取统一走 `checkCanRead(path, { force: true })`，平台硬规则不受 enabled 影响；不可用则 fail-closed |
| B3 | 删除 Agent 后同 ID 重建会继承旧工作区 | §4.9 默认工作区代际后缀 + 删除归档 + 清理 registry/缓存/映射 + 自定义目录 `adoptExistingWorkspace` |
| B4 | 两个 Agent 可配置相同 workspaceDir，per-agent 隔离不成立 | §4.9 新增 workspaceDir 规范化唯一性校验 |

### MAJOR

| # | 评审结论 | 本文修正 |
|---|---|---|
| M1 | `AGENTS.md` 作为扩展 section 实际排在 `instructions` 之前，与原文"之后"矛盾 | §4.7 按 `dist/harness/agent.js:159-169` 修正为"之前"，并说明否则只能牺牲热更新 |
| M2 | "不进入 transcript"不准确：section 会作为 `pi.system` entry 持久化 | §4.7 改为"作为 system entry 持久化、压缩摘要跳过 system message、重放保留"；§9.4 增加断言 |
| M3 | 规范符合性自相矛盾：Unicode name、未知字段、客户端扩展 | §3.2 明确合规口径：参考 validator 为准、未知字段警告加载、`disable-model-invocation` 是客户端扩展、长度按码点 |
| M4 | 目录只含 name/description/location 与按 id 寻址冲突 | §3.4/附录 A 明确目录含 `<id>`（= name = 目录名） |
| M5 | TTL 1s 可能导致"下一轮生效"失效 | §4.3 改为"每次请求做指纹检查，TTL 只缓存解析结果"；§9.2 用不 sleep 的测试 |
| M6 | workspaceDir 变更未同步 `allowWrite` | §4.9 新增保存时替换 allowWrite、创建/校验新目录、回归测试 |
| M7 | 现有 `fileInfo()` 会解析 symlink，无法实现"真实类型"检查 | §4.4/§5.2 改为用父目录 `listDir()` 的 `kind` 判定最终组件 |
| M8 | `workspace_skill_roots` 缺少绝对路径/`..`/symlink/去重约束 | §4.4/§6 新增逐项规范化、包含性、真实目录、canonical 去重与诊断 |

### MINOR

| # | 评审结论 | 本文修正 |
|---|---|---|
| m1 | 审计语义不清，可能记录正文 | §5.3 明确只记路径/原因/大小；审计失败不改变安全决定 |
| m2 | 管理台 memory 预览边界不一致 | §7.1 默认不返回预览；如提供必须走 `readVerifiedText` 且不入审计 |
| m3 | 缺少 per-agent clear/测试清理 API | §8 增加 `clearWorkspaceSkills(agentId)`；§8/§9 纳入测试 teardown |
| m4 | `skill.md` 是兼容行为而非规范 | §3.3/附录 A 标注；两者同时存在优先 `SKILL.md` |
| m5 | 长度口径 UTF-16 vs Unicode 码点 | §3.2 明确按 Unicode 码点计数 |
| m6 | 解析器升级可能破坏平台宽松语义 | §3.3/§8 拆 `parseSkillMd`（平台宽松）与 `parseWorkspaceSkill`（严格） |

### 仍未解决/实现注意

- **已确认**：D6 工作区优先、D7 仅工作区根、D8 引入 `yaml`、D9 代际后缀；
- B1/B2 的实现需要新增 `PlatformReadGuard` 与 `readVerifiedText`，属于对 `sandbox` 层的小幅扩展；实现时必须走生产 `SandboxedExecutionEnv` 测试，不能只测 `PathGuard`；
- `AGENTS.md` 排在 `instructions` 之前是 durable 机制决定的；如果产品上要求"记忆在后"，需要单独改造（不推荐，会牺牲热更新）；
- `skill-creator` 的正文需要按 §4.10 的结构实际撰写，并补"内置技能自检"测试。

---

## 14. 实机验证记录（2026-10-18）

> 环境：macOS；隔离目录中的 `.bot` 副本（含真实 provider 配置，不改动项目主库）；
> 本地 OpenAI-compatible 模型端点经日志代理转发；gateway 以 `--foreground --no-terminal` 启动。
> 自动化：`bun test` 197 pass / 0 fail；`bun run typecheck` 通过；`bun run build:web` 通过。

### 14.1 核心链路

| 验证 | 结果 |
|---|---|
| 工作区扫描 | `/api/agents/e2e-agent/workspace-skills` 返回 `demo` 技能与 `AGENTS.md` 记忆 |
| 目录注入 | 模型请求体包含 `<available_skills>`，其中有 `demo` 与内置 `skill-creator` |
| 记忆注入 | 请求体包含 `<workspace_context>` 与 `<project_instructions>`，含 `PINEAPPLE-7` |
| `read_skill` 激活 | 对话历史出现 `read_skill` 工具调用与 `<skill_content name="demo">` 结果，含 `BANANA-42` |
| 最终回答 | `BANANA-42`（技能正文）+ `PINEAPPLE-7`（工作区记忆） |
| 自写技能 | Agent 读取 `skill-creator` 后用 `write` 创建 `.agents/skills/hello/SKILL.md` |
| 跨会话生效 | 新 session 中 `read_skill("hello")` 生效，最终回答 `HELLO-OK` |
| 开关 | `workspace_skills_enabled=0` 时扫描返回 `enabled=false`、技能为空；记忆开关独立（已修复并加回归） |
| 删除/重建 | 删除 Agent 返回 `archivedWorkspace`；同 ID 重建得到新代际目录，工作区技能为空 |
| workspaceDir 变更 | 保存后 `sandbox.filesystem.allowWrite` 从旧目录迁移到新目录 |

### 14.2 实机发现并修复：硬链接 DoS

- 复现：在隔离环境对 `.bot/bot.sqlite` 创建硬链接后，SQLite WAL 连接持续
  `disk I/O error`；gateway 业务库读写失败。
- 修复：`hardlinkBlocked` 在 `exec` 入口阻断 `ln`/`link`/`cp -l`（独立于沙盒开关）；
  `DatabaseManager` 在 IO 错误时自动 reopen、清空语句缓存。
- 实测：硬链接仍存在时，扫描请求触发连接 reopen 后透明恢复，返回 200 与
  `hard link to platform-protected data` 诊断；第二次扫描 200；`/api/status` 存活。
- 回归：`test/sandbox.test.ts`（命令模式）、`test/database.test.ts`（reopen 恢复）、
  `test/phase5-workspace.test.ts`（沙盒关闭时 exec 仍阻断）。

### 14.3 测试资产

- `test/phase5-workspace.test.ts`：20 个用例（解析、发现、目录、read_skill、记忆、
  跨 Agent、symlink/hardlink、sandbox 关闭、roots 校验、代际路径）。
- 既有 159 个用例全部保持通过；新增/修改后总计 197。
- 实机测试使用临时 `.bot` 副本，测试结束后已清理；未修改项目主库。

---

## 15. Codex 实现评审修正记录（2026-10-18）

> 评审方式：herdr 同 tab Codex（沿用其设计评审上下文）对未提交实现做 code review。
> 原结论：4 BLOCKING / 7 MAJOR / 7 MINOR。以下为逐条处理；修正后 `bun test` 189 pass。

### BLOCKING

| # | 评审结论 | 修正 |
|---|---|---|
| B1 | `workspace_skills_enabled` 等配置未进入指纹，关闭开关后旧缓存仍提供技能 | `computeFingerprint` 纳入开关、roots、max count/bytes、memory max bytes；关闭后下一次 sync 立即失效并清空 registry；新增"关闭→恢复"回归 |
| B2 | `canonicalPath` 对不存在路径直接词法回退，symlink 父目录可绕过 workspaceDir 唯一性 | 逐级 realpath 已存在父目录再拼回尾部；server 测试覆盖 symlink 父目录 + 不存在子目录 |
| B3 | Agent ID 未净化即进入归档路径，`../` 可逃逸 `.archive` | POST 校验 `^[a-zA-Z0-9_-]+$`；归档使用 safe-id 并校验目标位于 archive root 内；新增 ID 穿越回归 |
| B4 | 自动 reopen 在显式事务中途可能重放语句，造成部分提交 | `DatabaseManager` 跟踪 `BEGIN/COMMIT/ROLLBACK`；事务中 IO 错误只 reopen（回滚）并抛出，绝不重放；新增事务恢复回归 |

### MAJOR

| # | 评审结论 | 修正 |
|---|---|---|
| M1 | 扫描根校验后仍用 `root.path`，资源枚举存在路径重绑定窗口 | 扫描/指纹全程使用 `root.real`；资源枚举逐层 `lstat` + canonical 包含性，跳过 symlink |
| M2 | 多 root 同名技能"后到优先"，与设计"先到先得"相反 | discovery 层按 id 去重，保留首个并生成冲突诊断；新增多 root 回归 |
| M3 | 总开关关闭/无 agentId 时 `read_skill("skill-creator")` 仍可读 | autoEnabled 文档技能要求有效 agentId + `workspace_skills_enabled` + `api.env`；新增关闭态/无 env 回归 |
| M4 | workspaceDir 只检查"新目录在旧工作区内"，未对称检查祖先 | 对称拒绝相等/嵌套/祖先关系；新增父目录包含回归 |
| M5 | `.archive` 被当作 managed 工作区，可绕过 adopt 确认 | 明确拒绝 `.archive`；adopt 检查不再豁免 managed 目录（新代际目录为空，不会触发） |
| M6 | 硬链接闸只匹配首词，wrapper/脚本可绕过 | 扩展 wrapper（env/command/busybox/sudo）、引号清洗、`bash -c`/`find -exec`、`os.link/linkSync` 形态；残余动态构造仍需 OS 级用户隔离（backlog） |
| M7 | 工作区正文走宿主 reader，未要求 `api.env`，无 env 未 fail-closed | section/read_skill 均要求 env 存在；读取仍由宿主 `readVerifiedText` 执行（与 env PathGuard 同源）；新增无 env 回归 |

### MINOR

- `compatibility` 提供但为空/非字符串时严格模式报错；`metadata` 非对象报错。
- `workspace_skill_roots` 显式拒绝双斜杠空段。
- `purgeAgent` 移到 `saveAgent` 成功之后，避免持久化失败时误清缓存。
- 审计补齐 `workspace.skill.rejected` / `workspace.memory.loaded` / `workspace.memory.rejected`（按指纹变化触发）。
- 文档命名统一：`readVerifiedText`、`skill-creator.ts`、`memory` 对象、`api.env` 契约。
- 管理台"重新扫描"仍可能产生 POST + GET + SSE 的重复请求（无无限循环），记为 minor backlog。

---

## 16. 第二轮 Codex 复审修正记录（2026-10-18）

> 第二轮复审结论：3 BLOCKING / 7 MAJOR / 6 MINOR。修正后 `bun test` 197 pass / 0 fail。

### BLOCKING

| # | 评审结论 | 修正 |
|---|---|---|
| B1 | Agent 的 `sandbox.denyRead/allowWrite/enabled` 未进入指纹；撤权后旧缓存记忆仍注入 | 指纹纳入 sandbox JSON；server 任意 Agent 保存后 `purgeAgent()`；新增“缓存后新增 denyRead 立即失效”回归 |
| B2 | 校验与 open 之间祖先目录可被换成 symlink（O_NOFOLLOW 只保护最终组件） | open 后 `fstat` 校验类型/inode/nlink，并将 `orig` 与 fd 的 dev/ino 绑定；open 后重新 `realOrResolve`，路径变化即拒绝；资源枚举逐层 canonical 包含性。残余窗口仍需 OS 级 openat/用户隔离，已记录 |
| B3 | YAML 解析错误消息可能包含源码敏感行，并写入审计/日志 | YAML 错误只保留稳定分类 + 行列号；审计 diagnostics 统一映射为分类码（`yaml_parse`/`symlink`/`hardlink`/`read_denied` 等），不再记录原文；新增敏感内容回归 |

### MAJOR

| # | 评审结论 | 修正 |
|---|---|---|
| M1 | `orig` 未与 fd 绑定、特殊文件/权限未复核 | open 后增加 `orig`/`fstat` dev+ino、nlink、类型校验；路径再解析校验 |
| M2 | 首个 root 同名目录无效时未占用名字，后续 root 可顶替 | 目录名一出现即 `seen.add(id)`；无效目录也先到先得；新增“首 root 无效”回归 |
| M3 | 历史重叠 workspaceDir 启动/管理台无诊断 | 启动时扫描并 `workspace.conflict` 审计 + 日志；`GET /api/agents` 返回 `workspaceConflict`；前端显示警告徽标 |
| M4 | ID 白名单阻断历史非白名单 ID 的编辑 | 仅新建时校验；编辑既有 Agent 放行；新增 legacy ID 编辑回归 |
| M5 | 平台旧格式技能（未加引号冒号/数字 description）在严格 YAML 下静默消失 | 平台宽松模式 YAML 失败时回退旧手写解析器；`description/name` 接受数字/布尔标量；新增兼容回归 |
| M6 | 硬链接闸误杀 `which/man`、漏掉引号命令名 | 增加只读查询豁免、去掉 token 内所有引号（`l"n"` → `ln`）；动态变量/脚本构造仍为残余 |
| M7 | 删除/改配置时在飞 turn 结束后旧 conversation/映射残留 | `purgeAgent` 改为 pending 语义；`chatLocked` finally 在最后一个 busy turn 结束后执行 `finishPendingPurge` |
| M8 | `exec` 多语句事务状态跟踪不完整 | 以 SQL 中最后一个 BEGIN/COMMIT/ROLLBACK 决定 `inTransaction`；新增单/多语句状态回归 |

### MINOR

- `GET /api/agents/:id/workspace-skills` 改为普通指纹同步，只有 `POST /reload` 强制全量扫描。
- 新建默认工作区目录统一 0700。
- 文档明确自定义 workspaceDir 不存在时自动创建（0700）。
- 仍未拆分技能指纹与记忆指纹（记忆变化会额外触发一次 skills.changed，属噪音级）；平台/工作区同名遮蔽诊断仍为 backlog。

---

## 17. 第三轮 Codex 复审修正记录（2026-10-18）

> 第三轮复审结论：1 BLOCKING（祖先目录 symlink TOCTOU）/ 7 MAJOR / 5 MINOR。
> 修正后 `bun test` 197 pass / 0 fail。

### BLOCKING：祖先目录 symlink TOCTOU

- **修复**：`readVerifiedText` 不再用字符串路径 `open`。它从 `workspaceReal` 打开目录 fd，
  逐级调用 libc `openat(2)`（每级 `O_NOFOLLOW|O_DIRECTORY`，最终 `O_NOFOLLOW`），再用
  `fstat` + 同一 fd 读取。实现通过 `bun:ffi`（macOS `libSystem.B.dylib` / Linux
  `libc.so.6`），编译单二进制实测可用；FFI 不可用时 fail-closed。
- **工作区资源枚举**：不再用 `readdir` 枚举工作区技能资源（`readdir` 仍有同样的祖先
  竞态）。`read_skill` 只返回正文 + 技能目录；模型按 SKILL.md 的相对路径用 `read`/`bash`
  自行读取。平台技能仍返回资源清单（管理员可控）。
- **信任锚**：`workspaceReal` 由 canonical realpath 得到，根目录以 `O_NOFOLLOW` 打开；
  默认工作区父目录 `.bot/workspaces` 不在 Agent 的 allowWrite 内，Agent 无法替换根目录。
  自定义 workspaceDir 的父目录可写性由管理员配置负责，记入运行约束。

### MAJOR

- **审计脱敏**：`workspace.skills.loaded` / `workspace.skill.rejected` 不再记录绝对路径；
  诊断只记录 `skill` id + 分类码；记忆审计只记录 basename/大小/截断。
- **指纹一致性**：`syncWorkspaceSkills` 复用同一次 `resolveRoots` 结果计算指纹与快照；
  指纹纳入目录条目（名称/mtime/ctime/inode/mode）与根目录 stat；文件指纹加入 `ctimeMs`。
- **事务词字面量**：`exec` 先剔除 SQL 字符串字面量与注释，再识别
  `BEGIN/COMMIT/ROLLBACK`；新增字面量回归。
- **编辑契约**：可选 `originalId` 必须等于 `id` 且目标存在，避免“以为在编辑、实际新建”。
- **历史冲突 fail-closed**：`getOrCreateConversation` 检测到 workspace 与其它 Agent
  重叠时拒绝聊天；`detectWorkspaceConflicts` 抽到 `src/config/workspace-conflicts.ts`，
  启动审计与 API/前端徽标共用。
- **pending purge**：配置变更/删除期间不再复用旧 conversation 缓存（同会话仍由
  sessionLock 串行），turn 收尾后 `finishPendingPurge` 清理映射。
- **平台宽松字段**：`license/compatibility/allowed-tools` 在平台模式使用 loose string
  （数字/布尔兼容）。

### MINOR

- `getAgentWorkspaceDir` 统一 0700。
- 新增 openat 中间目录 symlink 回归、历史冲突检测回归。
- 仍未拆分技能/记忆指纹（memory 变化会额外触发 skills.changed）；前端 reload 仍有
  一次多余 GET。均记为噪音级 backlog。

---

## 18. 第四轮 Codex 复审修正记录（2026-10-18）

> 第四轮结论：2 BLOCKING / 8 MAJOR / 10 MINOR。
> 修正后全量 `bun test` 连续三次 197 pass / 0 fail，指定四套件组合 55 pass / 0 fail。

### BLOCKING

| # | 评审结论 | 修正 |
|---|---|---|
| B1 | 共享 DatabaseManager 单例被 `server.test.ts` 删除 testHome，多文件并行稳定 22 fail | `server.test.ts` 不再删除 testHome（只 stop server）；保留全量/组合回归。根因是测试纪律，不是生产逻辑 |
| B2 | purge 后旧工作区扫描 Promise 可回写旧代际技能/cache | `workspace.ts` 增加 per-agent generation：purge 递增；写回前校验 generation + 重新读取 Agent（workspaceDir/sandbox 一致）否则丢弃。`syncWorkspaceSkills` 本身是同步扫描（无 await），该检查为未来引入异步的防御 |

### MAJOR

- **force 被 inflight 吞掉**：force 先等待所有在飞扫描结束再发起新扫描；inflight finally 加身份守卫；新增并发调用路径。
- **扫描枚举竞态**：root/entry 在 readdir 前后做 realpath 包含性校验（正文读取已由 openat 闭环；枚举残余列为明确边界）。
- **事务状态**：剔除单引号/双引号/反引号字面量与注释；`ROLLBACK TO` 不视为事务结束；补 savepoint/字面量回归。
- **记忆 symlink 候选**：遇到 symlink 跳过并继续下一个候选，与指纹选择一致；新增回归。
- **平台技能读取**：删除宿主 `readFileSync` 回退，统一要求 `api.env`（与工作区同一 fail-closed 契约）。
- **管理 API 路径脱敏**：workspace-skills 返回相对 workspace 的路径/文件名；诊断 reason 中的绝对 workspace 前缀替换为 `<workspace>`。
- **前端重复请求**：`useAsync` 增加 `setData`；强制重扫直接使用 POST 返回值，并在 1.2s 静默窗口内忽略自身 SSE 刷新。
- **审计噪音**：保留分类码脱敏；事件拆分/短窗口去重仍为 minor backlog。

### MINOR

- `openat` 的 Linux 库名探测增加 musl soname；不支持的平台 fail-closed 并告警。
- `readVerifiedText` 返回 openat 绑定的 canonical 路径，不再读取后二次 realpath。
- `license` 空值校验与 `compatibility` 对齐。
- 默认/自定义工作区权限仍只保证新建 0700；已存在目录不强制 chmod（避免管理员显式权限被覆盖），文档明确。

---

## 19. 第五轮 Codex 复审修正记录（2026-10-18）

> 第五轮结论：2 BLOCKING（均为 DatabaseManager 事务状态）/ 3 MAJOR / 6 MINOR。
> 修正后 `bun test` 连续两次 197 pass / 0 fail；二进制重建通过。

### BLOCKING：事务状态与真实连接分裂

- **根因**：`exec()` 只在成功路径按最后一个事务词更新 `inTransaction`；失败路径
  （多语句事务中途失败）不更新，且未覆盖 `END/SAVEPOINT/RELEASE`。
- **修复**：每次 `exec`（成功或失败）后读取底层 `DatabaseSync.isTransaction` 同步真实
  状态；不可用时 fallback 跟踪
  `BEGIN/COMMIT/ROLLBACK(非 TO)/END/SAVEPOINT/RELEASE`。失败事务在 IO 错误时仍按
  “事务中”处理，绝不透明重放。
- **回归**：新增失败多语句事务（管理器 true / 底层 true，ROLLBACK 后 false）、
  `END`、独立 `SAVEPOINT/RELEASE` 断言；原有“事务中 IO 错误不重放”保留。

### MAJOR

- **错误信息泄露**：`skills-catalog` 与工作区诊断不再透传 `err.message`/宿主路径；
  模型侧统一稳定错误码（`read_error`/`permission_denied`），完整异常只写服务端日志。
- **硬链接误杀**：`hardlinkBlocked` 改为只检查命令位置（首命令、wrapper 后的命令、
  `bash -c`/解释器 `-c/-e`、`find -exec`、`xargs`），参数中的 `link`
  （`git checkout link`/`rm link`/`chmod +x link`）不再误杀；`sudo -u`/`env PATH=`
  等 wrapper 仍能识别实际命令。
- **扫描枚举残余（明确记录，不再与正文读取混为一谈）**：正文读取已由 openat fd 链
  闭环；`readdir` 仍使用字符串路径并做前后 realpath 包含性校验。目录条目名泄露
  窗口列为已记录 MAJOR/安全边界，彻底修复需 fdopendir/readdir（或等价的目录 fd
  枚举），不在本轮引入。

### MINOR

- EventBus `workspace.memory.changed` detail 改为 basename，与 API 脱敏一致。
- 前端重扫静默窗口的 timer 在组件卸载时清理。
- 文档同步：平台技能也要求 `api.env`；工作区不自动枚举资源；read_skill 输出描述
  与实现一致。
- pending purge 的字符串前缀 key 对含冒号的历史 ID 仍有理论误判（新 ID 已白名单），
  记为 minor backlog。
- workspace_context 的 durable `pi.system` 重放顺序仍以实机请求证据为准，单元测试
  直接调用 section；真实 harness 重放断言列为测试缺口。

---

## 20. 第六轮 Codex 复审结论（2026-10-18）

> **NO BLOCKING ISSUES**。第五轮的两个事务状态 BLOCKING 已闭环：
> 失败多语句事务后 manager/raw 均为事务中；随后 IO 错误只 reopen 不重放；
> END/SAVEPOINT/RELEASE 状态与底层一致；硬链接命令位置解析未引入新的阻断性误杀。
>
> 第六轮仍列出的非阻断项：
> - **MAJOR 残余**：扫描枚举仍用字符串 `readdirSync`（正文读取已由 openat fd 链闭环），
>   可能泄露目录条目名；彻底修复需 fdopendir/readdir，已记入安全边界。
> - **MAJOR 残余**：内部快照/日志仍保留绝对路径；管理 API 与模型侧已脱敏。
> - **MAJOR 残余**：嵌套 wrapper（`find -exec sh -c 'ln ...'` 等）仍可能漏检；硬链接闸
>   是启发式，不是授权边界，最终兜底是 DatabaseManager reopen。
> - **MAJOR 测试缺口**：workspace_context 的 durable `pi.system` 重放顺序仍以实机请求
>   证据为准，未做真实 harness 断言。
> - MINOR：pending purge 前缀 key、指纹含绝对路径、EventBus 同名记忆、固定 1.2s 静默
>   窗口等。
>
> 本轮收尾修复：autoEnabled 内置技能（skill-creator）统一要求有效 agentId +
> `input.env`/`api.env` + 总开关，消除“工作区 fail-closed 但内置技能不要求 env”的
> 语义分叉。`bun test` 197 pass / 0 fail。
