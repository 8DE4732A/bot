# Bot Agent (基于 pi-durable 的轻量化多 Agent 平台)

一个基于 `@earendil-works/pi-durable` 与 Bun / Node.js 打造的现代化、轻量级、安全沙盒化、单二进制分发、零配置文件的多 Agent 对话网关与执行平台。

---

## 🌟 核心特性

1. **单二进制文件独立运行**：支持通过 `bun build --compile` 构建出单一原生可执行文件 `bin/bot`，无需外部安装 Node.js、Bun 或任何 node_modules，开箱即用。
2. **当前工作目录自包含 (`cwd/.bot/`)**：统一在当前工作目录下落地全部持久化数据：
   - `.bot/bot.sqlite`：业务 SQLite 数据库（系统配置、多 Agent 属性、渠道会话映射、审计日志）；
   - `.bot/conversations.sqlite`：会话状态机独立数据库（pi-durable 全权管理，删除即重置全部对话历史）；
   - `.bot/workspaces/<agent-id>/`：各 Agent 专属的工作目录；
   - `.bot/logs/`：系统日志与安全审计拦截日志；
   - `.bot/skills/`：本地自定义技能与扩展目录。
3. **多 Agent 独立自治管理**：
   - 单一控制台可配置多个独立 Agent（例如：内部研发助手、企微技术支持、微信个人助理）；
   - 每个 Agent 拥有独立的模型配置（DeepSeek/OpenAI/Claude/Gemini/OpenRouter）、独立的 System Prompt/Persona、独立的工作空间与专属沙盒策略。
4. **多渠道实例解耦绑定**：
   - 渠道实例（如两个不同的企业微信机器人、微信个人号、QQ 机器人、本地终端）可自由绑定到不同的 Agent，实现完全独立、互不干扰的对话流。
5. **技能与扩展 (Skills & Extensions) 动态选配**：
   - 内置代码编写工具包 (`coding-tools`: read, write, edit, bash)、联网检索与网页摘要 (`web-search`)、系统时间 (`datetime`)；
   - 支持从 `<cwd>/.bot/skills/` 动态加载自定义技能扩展；
   - 管理页面支持可视化卡片勾选，保存后下一条消息即按新技能集生效（技能列表在服务启动时扫描加载，新增技能文件后需重启）。
6. **双层安全沙盒防护体系**：
   - **内核级防护**：集成 Anthropic Sandbox Runtime (ASRT)，在 macOS (Apple Seatbelt) 和 Linux (Bubblewrap + Seccomp) 层面限制 `bash` 命令的文件读写范围与网络出网域名白名单；
   - **应用级防护**：`SandboxedExecutionEnv` 对 Agent 主动调用 `read`、`write`、`edit` 等工具实施前置路径边界检查。
7. **免密管理控制台 (Web Admin)**：
   - React 19 + Vite 构建的现代化单页管理面板（构建产物内嵌进单二进制，离线可用）；
   - 可视化调整模型 API Key（一键模板 + 端点模型自动探测）、Agent 属性、技能选配、渠道绑定与沙盒规则；
   - 内置对话调试 Playground：SSE 实时流式输出 + 工具调用轨迹，走与正式渠道一致的沙盒链路。

---

## 🚀 快速上手

### 1. 方式一：直接运行单二进制文件 (推荐)
```bash
# 1. 构建单二进制可执行文件
bun run build:binary

# 2. 将 bin/bot 加入 PATH 或直接在项目目录运行
./bin/bot

# 3. 查看当前目录状态
./bin/bot status

# 4. 查看管理面板地址
./bin/bot admin
```

### 2. 方式二：源码开发模式
```bash
# 依赖安装（框架依赖 @earendil-works/pi-durable 等已发布至 npm，可直接独立安装）
bun install

# 启动开发服务（后端 + 终端 REPL，使用已构建的管理界面）
bun run dev

# 前端开发模式（后端 :3000 + Vite HMR :5173，管理界面源码热更新）
bun run dev:web

# 运行自动化测试
bun test

# 类型检查（后端 + 前端）
bun run typecheck

# 构建管理界面并生成内嵌资源 (src/server/ui/generated.ts)
bun run build:web
```

> 开发者提示：若本机存在 `../pi` monorepo（pi 框架源码），`tsconfig.json` 的 `paths` 会自动优先使用其最新源码（便于跟进未发布改动）；否则回退到 npm 已发布版本，两种模式均可正常构建运行。

---

## 🛠️ CLI 命令行指南

```bash
bot [command] [options]

Commands:
  start          启动 Bot 平台服务 (默认命令)
  status         查看当前目录下的 Agent、渠道、数据库与工作区状态
  admin          打印 Web 管理后台访问地址

Options:
  --port <num>   指定 Web 管理后台监听端口 (默认: 3000 或数据库中保存的值)
  --host <addr>  指定 Web 管理后台监听地址 (默认: 127.0.0.1 或数据库中保存的 web_host)
  --no-terminal  后台服务模式，不启动终端交互 REPL
  --daemon       同 --no-terminal
```

---

## 💻 终端交互指令 (Terminal REPL)

在终端渠道交互时，支持以下快捷斜杠命令：
- `/agent`：列出当前系统所有可用的 Agent 列表及当前激活项；
- `/agent <id>`：在当前终端实时切换会话绑定的 Agent；
- `/reset`：重置当前 Agent 对话上下文；
- `/compact`：手动压缩对话历史上下文，释放 Token；
- `/status`：查看当前 Agent 的模型、工作区与沙盒规则；
- `/admin`：显示 Web 管理控制台链接；
- `/exit` 或 `/quit`：退出终端。

---

## 🖥️ Web 管理后台说明

服务启动后，浏览器打开 `http://127.0.0.1:3000` 即可进入免密管理面板（默认仅监听本机回环地址，保障 API Key 安全；需局域网访问时通过 `--host 0.0.0.0` 或管理配置 `web_host` 显式放开）：
1. **多 Agent 管理**：新建 Agent、配置各 Agent 的专属模型、Prompt 指令、工作空间与沙盒规则；
2. **技能选配 (Skills)**：在 Agent 卡片上勾选启用的技能（如 `coding-tools`、`web-search`）；
3. **模型与密钥**：可视化配置 OpenAI、DeepSeek、Anthropic、Gemini、OpenRouter 等供应商的 API Key 和 Base URL，点击“测试连接”实时测试网络连通性；
4. **对话渠道绑定**：查看各渠道运行状态，为不同的渠道分配所对接的目标 Agent；
5. **安全沙盒审计**：实时查看越界读写、非法网络出网的拦截日志记录。

---

## 📁 目录结构说明

```text
.
├── bin/
│   └── bot                        # Bun 单二进制打包产物
├── src/
│   ├── cli.ts                     # 命令行总入口
│   ├── config/
│   │   ├── env-paths.ts           # cwd/.bot/ 本地化存储路径管理
│   │   └── database-store.ts      # 零配置文件 SQLite 存储封装
│   ├── database/
│   │   ├── index.ts               # SQLite DatabaseSync 事务与连接池
│   │   └── migrations.ts          # 数据库迁移与初始自举
│   ├── core/
│   │   ├── agent-manager.ts       # 多 Agent 生命周期与 pi-durable 调度
│   │   └── model-factory.ts       # pi-ai 模型路由与连通性测试
│   ├── sandbox/
│   │   ├── manager.ts             # Anthropic Sandbox Runtime (ASRT)
│   │   ├── path-guard.ts          # 路径边界校验拦截器
│   │   └── execution-env.ts       # SandboxedExecutionEnv 沙盒执行环境
│   ├── skills/
│   │   ├── registry.ts            # 技能注册与 Extension 解析中心
│   │   ├── builtin/               # 内置技能: coding, web-search, datetime
│   │   └── loader.ts              # .bot/skills 本地自定义扩展加载器
│   ├── channels/
│   │   ├── base.ts                # 统一渠道抽象接口
│   │   ├── manager.ts             # 渠道路由与消息分发网关
│   │   ├── terminal/index.ts      # 本地终端流式交互渠道
│   │   └── adapters/              # 企微/微信/QQ 渠道插槽 (二期就绪)
│   └── server/
│       ├── server.ts              # 嵌入式 Web API 服务 (静态资源 + REST + SSE)
│       └── ui/generated.ts        # ⚠️ 自动生成: 内嵌前端构建产物 (勿手工编辑)
├── web/                           # 管理后台前端 (React 19 + Vite + TypeScript)
│   ├── src/
│   │   ├── App.tsx                # 应用壳 + hash 路由 + 边栏运行时读数
│   │   ├── api.ts                 # REST 封装 + SSE 流式对话解析
│   │   ├── components/ui.tsx      # 通用组件 (Toast/Modal/二次确认/表单/空状态)
│   │   ├── views/                 # 概览/Agent/模型服务商/渠道/对话调试/沙盒审计
│   │   └── styles/base.css        # 设计 token 与全部样式 (浅色工程工作台)
│   └── dist/                      # vite 构建产物 (经 embed-web.ts 内嵌进二进制)
├── scripts/
│   ├── dev-web.ts                 # 前端开发模式: 后端 + Vite HMR 并行
│   └── embed-web.ts               # web/dist → src/server/ui/generated.ts
└── test/                          # 自动化测试套件 (paths, db, sandbox, skills, server)
```
