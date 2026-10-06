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

export interface SandboxedEnvOptions {
  cwd: string;
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
