import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Context } from "@earendil-works/chord";
import { err, ExecutionError, FileError } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
// 注意: BinaryReader/DirReader/WatchChange/WatchTarget 在 npm 1.0.2 的类型面
// 尚未导出 (本地 ../pi 源码才有)——这里只用 1.0.2 的导出, 差异点用最小结构 +
// @ts-ignore 标注, 保证有无本地 pi 两种模式 typecheck 均通过
import type {
  FileInfo,
  Result,
  ShellExecOptions,
  ShellExecResult,
  TextLineReader,
} from "@earendil-works/pi-durable/env";

/** 1.0.2 兼容的最小 watch 目标结构 (框架完整定义见本地 pi 源码 WatchTarget) */
interface WatchTargetLike {
  path: string;
  [key: string]: unknown;
}
import type { BotSandboxConfig } from "../config/database-store.ts";
import { DatabaseStore } from "../config/database-store.ts";
import { buildChildProcessEnv } from "../config/sandbox-defaults.ts";
import { getBotPaths } from "../config/env-paths.ts";
import { logger } from "../utils/logger.ts";
import { SandboxRuntimeManager } from "./manager.ts";
import { PathGuard } from "./path-guard.ts";

/**
 * 防自杀闸模式 (四期 §3.1): 拦"停掉/卸载 gateway"的破坏面, 不误伤
 * "gateway status" 等只读命令。覆盖四类形态 (R1 评审 B2/B3 + R2 评审 B2):
 * ① bot 二进制或源码入口的 gateway 破坏性子命令 (bun .../cli.ts gateway stop 同样命中);
 * ② launchctl 直杀——实际 label 是 com.bot.gateway.<sha8>, 以及旧 API unload;
 * ③ systemctl 直杀 bot-gateway-* unit;
 * ④ kill/pkill/killall 指向 gateway 进程特征 (含 pgrep -f 任意 pattern 形态、
 *    编译单二进制进程名 bot)。
 * 固有局限 (记录): plain `kill <pid>` 无法静态判定目标进程; shell 转义
 * (boot\out) 可绕过字面匹配——纵深靠 gateway-token/pid/lock 全禁读断链 +
 * 黑名单只覆盖可直接枚举的形态 (hermes 同款取舍)。
 */
export const SELF_DESTRUCT_PATTERN = new RegExp(
  [
    // ① gateway 破坏性子命令 (bot / bun src/cli.ts / bin/bot 任意入口前缀)
    String.raw`gateway\s+(start\s+)?(stop|restart|uninstall|kill|bootout|disable)\b`,
    // ② launchctl bootout/remove/kill/unload 指向本项目 label
    String.raw`launchctl\s+[^|;&]*\b(bootout|remove|kill|unload)\b[^|;&]*(com\.bot\.gateway|bot-gateway)`,
    // ③ systemctl stop/kill/disable/reset-failed 指向 bot-gateway unit
    String.raw`systemctl\s+[^|;&]*\b(stop|kill|disable|reset-failed)\b[^|;&]*bot-gateway`,
    // ④ kill/pkill/killall 指向 gateway 进程特征 (label / 启动特征 / 单二进制名)
    String.raw`\b(kill|pkill|killall)\b[^|;&]*(com\.bot\.gateway|gateway.{0,3}start|cli\.ts|bin/bot|\bbot\b)`,
  ].join("|"),
);

/** 只读白名单 (R2 评审 M-5 → R3 评审 B2 收敛): 命令文本出现 gateway 破坏性
 *  字样通常是检索项目文档 (grep "gateway stop" CLAUDE.md)。**仅当整条命令
 *  不含 shell 元字符** (分隔符/管道/重定向/命令替换/反引号) 时才豁免——
 *  否则 `grep x; bot gateway stop`、`echo x | launchctl bootout ...` 会借
 *  白名单整条绕过 (R3/R4 实测)。含元字符的复合命令一律走正则检查。
 *  不含 awk/find 等可执行任意子命令的工具 (system()/-exec)。 */
const READONLY_FIRST_WORDS = new Set([
  "grep", "rg", "ag", "cat", "less", "more", "head", "tail", "echo", "ls", "wc",
]);

/** 防自杀闸完整判定 (导出供回归测试直接使用——R4 教训: 测试复制本函数
 *  逻辑导致生产漂移全绿假象, 测试必须走生产实现)。 */
export function selfDestructBlocked(commandText: string): boolean {
  if (/[;&|<>`$\n]/.test(commandText)) return SELF_DESTRUCT_PATTERN.test(commandText);
  const first = commandText.trim().split(/\s+/, 1)[0] ?? "";
  if (READONLY_FIRST_WORDS.has(first)) return false;
  return SELF_DESTRUCT_PATTERN.test(commandText);
}




export interface SandboxedEnvOptions {  cwd: string;
  agentId: string;
  sandboxConfig: BotSandboxConfig;
}

/**
 * 子进程环境白名单: bash 等工具默认 inheritEnv, 会把宿主 process.env
 * (含所有 provider API Key) 泄漏给沙盒内命令。这里只放行非敏感基础变量,
 * 强制 inheritEnv:false 后, 子进程永远拿不到宿主完整环境。
 */
function sandboxShellEnv(): Record<string, string> {
  return buildChildProcessEnv();
}

/**
 * 平台级无条件禁读清单: 密钥库/会话库/日志/宿主凭据文件,
 * 以及其他 Agent 的工作区与技能源码 (多 Agent 数据横向隔离)。
 * skills 目录只禁代码 (*.ts/*.js/node_modules)——文档型技能 SKILL.md
 * 的正文需模型经 read 工具读取 (渐进披露), 代码与数据分别对待。
 */
function platformDenyRead(agentWorkspace: string, store: DatabaseStore): string[] {
  const paths = getBotPaths();
  const deny = [
    join(paths.dotBot, "bot.sqlite*"),
    join(paths.dotBot, "conversations.sqlite*"),
    // 四期新增 host 凭据 (R1 评审 B1/B4): gateway-token 是管理 API + WS
    // 的根凭据; pid 文件断掉 "cat pid → kill" 自毁链; config-error 无害
    // 但同族一并覆盖。与 kernelDenyRead 同步演进 (约束 7)
    join(paths.dotBot, "gateway-token"),
    join(paths.dotBot, "gateway.pid"),
    join(paths.dotBot, "gateway.sock"),
    join(paths.dotBot, "gateway.config-error"),
    join(paths.dotBot, "gateway.lock"),
    // 渠道持久化凭据 (微信 bot_token/context_token 等)——0600 只防其他 OS 用户,
    // 沙盒 Agent 同一 OS 用户, 必须靠路径 deny (与 kernelDenyRead 同步演进)
    join(paths.dotBot, "channels"),
    paths.logsDir,
    join(paths.root, ".env*"),
    join(paths.root, ".git-credentials"),
    join(paths.skillsDir, "*.ts"),
    join(paths.skillsDir, "*.js"),
    join(paths.skillsDir, "*", "*.ts"),
    join(paths.skillsDir, "*", "*.js"),
    join(paths.skillsDir, "*", "node_modules"),
  ];
  // 其他 Agent 的工作区 (含已删除 Agent 的残留目录)
  const self = resolve(agentWorkspace);
  try {
    for (const entry of readdirSync(paths.workspacesDir, { withFileTypes: true })) {
      const dir = join(paths.workspacesDir, entry.name);
      if (resolve(dir) !== self) deny.push(dir);
    }
  } catch {
    // workspaces 目录不存在时无需隔离项
  }
  // 自定义 workspace 的其他 agent (表内枚举兜底)
  try {
    for (const a of store.listAgents()) {
      if (!a.workspaceDir) continue;
      const dir = resolve(a.workspaceDir);
      if (dir !== self) deny.push(dir);
    }
  } catch {
    // store 不可用时保持基础清单
  }
  return deny;
}

/**
 * 双层防护的应用层: 在 pi-durable 执行环境上统一拦截全部文件访问与命令执行。
 * 覆盖是机制级的——基类 FileSystem 接口的每个带路径方法都归入 read/write 两类
 * 检查 (guardRead/guardWrite), 上游新增方法时按同一模式接入, 不存在枚举遗漏。
 * - 读类 → PathGuard.checkCanRead; 写类 → checkCanWrite (deny 优先于 allowWrite)
 * - 命令执行 → ASRT 内核沙盒包装, 包装失败 fail-closed 拒绝执行
 * 所有拦截均写入 audit_logs 表 (Web 审计页数据源)。
 */
export class SandboxedExecutionEnv extends NodeExecutionEnv {
  private agentId: string;
  private sandboxConfig: BotSandboxConfig;
  private pathGuard: PathGuard;
  private audit: DatabaseStore;

  constructor(options: SandboxedEnvOptions) {
    super({ cwd: options.cwd, shellEnv: sandboxShellEnv() });
    this.agentId = options.agentId;
    this.sandboxConfig = options.sandboxConfig;
    this.audit = new DatabaseStore();
    const denyRead = platformDenyRead(options.cwd, this.audit);
    // skills 源码 deny 模式不进 inode 指纹: glob 收集会枚举整个技能目录,
    // 把需要放行的 SKILL.md 一并指纹化; 源码无机密, 路径 deny 已足够
    const skillsDir = getBotPaths().skillsDir;
    this.pathGuard = new PathGuard(
      options.cwd,
      options.sandboxConfig,
      denyRead,
      denyRead.filter((p) => !p.startsWith(skillsDir)),
    );
  }

  /** 拦截闭环: 越界尝试写入结构化审计存储, 审计失败不阻断主流程。 */
  private auditBlocked(op: "read" | "write" | "exec", target: string, reason: string): void {
    logger.warn("SandboxEnv", `[${this.agentId}] Blocked ${op}: ${reason}`);
    try {
      this.audit.recordAudit("sandbox.blocked", { op, target, reason }, this.agentId);
    } catch (err) {
      logger.warn("SandboxEnv", `Failed to record audit entry: ${err}`);
    }
  }

  // go() 收到检查时刻解析出的真实路径: 校验与执行同一路径, 符号链接
  // 在校验后被翻转的 TOCTOU 竞态在结构上失效
  private async guardRead<R>(
    path: string,
    go: (realPath: string) => Promise<Result<R, FileError>>,
  ): Promise<Result<R, FileError>> {
    const check = this.pathGuard.checkCanRead(path);
    if (check.allowed) {
      const result = await go(check.realPath ?? path);
      // 兼容调用 (npm 1.0.2 基类缺方法) 返回 undefined 时保持 Result 契约
      return result ?? err(new FileError("not_supported", "operation not supported by this execution env", path));
    }
    this.auditBlocked("read", path, check.reason!);
    return err(new FileError("permission_denied", check.reason!, path));
  }

  private async guardWrite<R>(
    path: string,
    go: (realPath: string) => Promise<Result<R, FileError>>,
  ): Promise<Result<R, FileError>> {
    const check = this.pathGuard.checkCanWrite(path);
    if (check.allowed) {
      const result = await go(check.realPath ?? path);
      return result ?? err(new FileError("not_supported", "operation not supported by this execution env", path));
    }
    this.auditBlocked("write", path, check.reason!);
    return err(new FileError("permission_denied", check.reason!, path));
  }

  // --- Shell Execution with OS-level ASRT Sandbox ---
  public override async exec(
    command: string | readonly string[],
    options?: ShellExecOptions,
    context?: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    // 防自杀闸 (四期 §3.1, hermes _refuse_from_inside_gateway 同款):
    // 模型经 bash 执行 gateway 停止/重启/卸载直接拒绝并审计——
    // 防模型自毁宿主服务 (对宿主服务的运维是用户终端/管理台的事)。
    // 独立于沙盒开关 (宿主保护不随 sandbox.enabled 关闭); argv 数组
    // 形态 join 后同样匹配 (R1 评审 C-M9)
    const execText = typeof command === "string" ? command : command.join(" ");
    if (selfDestructBlocked(execText)) {
      this.auditBlocked("exec", execText, "gateway self-destruct command refused from inside sandbox");
      return err(
        new ExecutionError(
          "unknown",
          "Command blocked: gateway 生命周期命令 (stop/restart/uninstall) 不能由 Agent 在沙盒内执行；请让用户在终端运行或使用管理台。",
        ),
      );
    }

    let finalCommand = command;

    if (this.sandboxConfig.enabled) {
      // argv 数组命令无法经 ASRT 字符串包装, 沙盒启用时 fail-closed 拒绝
      if (typeof command !== "string") {
        const reason = "argv-array commands cannot be sandboxed";
        this.auditBlocked("exec", JSON.stringify(command), reason);
        return err(new ExecutionError("unknown", `Command blocked: ${reason}`));
      }
      if (!SandboxRuntimeManager.isSupported) {
        // 不支持内核沙盒的平台上拒绝执行 (fail-closed), 不静默裸跑
        const reason = `OS sandbox unsupported on ${process.platform}`;
        this.auditBlocked("exec", command, reason);
        return err(new ExecutionError("unknown", `Command blocked: ${reason}`));
      }
      logger.debug("SandboxEnv", `[${this.agentId}] Sandboxing command: ${command}`);
      try {
        // 平台红线 (含其他 Agent 工作区隔离) 同步进内核层——ASRT 读策略是
        // "默认放行 + deny 列表", 只给应用层拦 bash 仍然 cat 得到
        finalCommand = await SandboxRuntimeManager.wrapCommand(
          command,
          this.sandboxConfig,
          this.cwd,
          platformDenyRead(this.cwd, this.audit),
          this.agentId,
        );
      } catch (wrapErr) {
        // fail-closed: 沙盒包装失败不降级为裸执行
        const reason = wrapErr instanceof Error ? wrapErr.message : String(wrapErr);
        this.auditBlocked("exec", command, reason);
        return err(
          new ExecutionError("unknown", `Command blocked: sandbox wrap failed: ${reason}`),
        );
      }
    }

    return super.exec(
      finalCommand as string,
      // 强制最小环境: 即使调用方要求继承, 子进程也只拿到白名单变量,
      // 宿主 process.env 中的 API Key 等机密不会进入沙盒命令
      { ...options, inheritEnv: false, env: { ...sandboxShellEnv(), ...(options?.env ?? {}) } },
      context!,
    );
  }

  // --- Read-class interception ---
  public override async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
    return this.guardRead(path, (rp) => super.readTextFile(rp, context));
  }

  public override async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
    return this.guardRead(path, (rp) => super.readBinaryFile(rp, context));
  }

  public override async openTextLineReader(
    path: string,
    context: Context,
  ): Promise<Result<TextLineReader, FileError>> {
    return this.guardRead(path, (rp) => super.openTextLineReader(rp, context));
  }

  // @ts-ignore 1.0.2 基类暂无 openBinaryReader (本地源码模式有); 守卫必须前置
  public async openBinaryReader(
    path: string,
    options: { noFollow?: boolean } | undefined,
    context: Context,
  ): Promise<Result<any, FileError>> {
    return this.guardRead(path, (rp) =>
      (NodeExecutionEnv.prototype as any).openBinaryReader?.call(this, rp, options, context),
    );
  }

  public override async fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
    return this.guardRead(path, (rp) => super.fileInfo(rp, context));
  }

  public override async listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
    return this.guardRead(path, (rp) => super.listDir(rp, context));
  }

  // @ts-ignore 同 openBinaryReader
  public async openDirReader(
    path: string,
    context: Context,
  ): Promise<Result<any, FileError>> {
    return this.guardRead(path, (rp) =>
      (NodeExecutionEnv.prototype as any).openDirReader?.call(this, rp, context));
  }

  public override async canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
    return this.guardRead(path, (rp) => super.canonicalPath(rp, context));
  }

  public override async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
    return this.guardRead(path, (rp) => super.exists(rp, context));
  }

  // @ts-ignore 1.0.2 基类暂无 watch (本地源码模式有)
  public async watch(
    targets: readonly WatchTargetLike[],
    onChange: (change: any) => void,
    context: Context,
  ): Promise<Result<any, FileError>> {
    const resolved: WatchTargetLike[] = [];
    for (const target of targets) {
      const check = this.pathGuard.checkCanRead(target.path);
      if (!check.allowed) {
        this.auditBlocked("read", target.path, check.reason!);
        return err(new FileError("permission_denied", check.reason!, target.path));
      }
      // 监控目标以校验时刻的真实路径注册 (与读/写同语义)
      resolved.push({ ...target, path: check.realPath ?? target.path });
    }
    return (NodeExecutionEnv.prototype as any).watch?.call(this, resolved, onChange, context) ??
      err(new FileError("unknown", "watch is not supported by this execution env", resolved[0]?.path));
  }

  // --- Write-class interception ---
  public override async writeFile(
    path: string,
    content: string | Uint8Array,
    context: Context,
  ): Promise<Result<void, FileError>> {
    return this.guardWrite(path, (rp) => super.writeFile(rp, content, context));
  }

  public override async appendFile(
    path: string,
    content: string | Uint8Array,
    context: Context,
  ): Promise<Result<void, FileError>> {
    return this.guardWrite(path, (rp) => super.appendFile(rp, content, context));
  }

  public override async truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
    return this.guardWrite(path, (rp) => super.truncateFile(rp, size, context));
  }

  public override async flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
    return this.guardWrite(path, (rp) => super.flushFile(rp, context));
  }

  public override async renameFile(
    sourcePath: string,
    destinationPath: string,
    context: Context,
  ): Promise<Result<void, FileError>> {
    const checkSource = this.pathGuard.checkCanWrite(sourcePath);
    if (!checkSource.allowed) {
      this.auditBlocked("write", sourcePath, checkSource.reason!);
      return err(new FileError("permission_denied", checkSource.reason!, sourcePath));
    }
    return this.guardWrite(destinationPath, (rpDest) => {
      // source 同样以校验时刻解析出的真实路径执行 (与 dest 一致的 TOCTOU 语义)
      return this.guardWrite(sourcePath, (rpSrc) =>
        super.renameFile(rpSrc, rpDest, context),
      );
    });
  }

  public override async createDir(
    path: string,
    options: { recursive?: boolean } | undefined,
    context: Context,
  ): Promise<Result<void, FileError>> {
    return this.guardWrite(path, (rp) => super.createDir(rp, options, context));
  }

  public override async remove(
    path: string,
    options: { recursive?: boolean; force?: boolean } | undefined,
    context: Context,
  ): Promise<Result<void, FileError>> {
    return this.guardWrite(path, (rp) => super.remove(rp, options, context));
  }

  // 临时资源是执行环境的机制需求 (bash spill 落盘、大输出保留), 不套用业务
  // allowWrite — macOS 的 tmpdir 不在默认白名单, 若校验会杀死超限命令。直接放行。
  public override async createTempDir(
    prefix: string | undefined,
    context: Context,
  ): Promise<Result<string, FileError>> {
    return super.createTempDir(prefix, context);
  }

  public override async createTempFile(
    options: { prefix?: string; suffix?: string } | undefined,
    context: Context,
  ): Promise<Result<string, FileError>> {
    return super.createTempFile(options, context);
  }
}
