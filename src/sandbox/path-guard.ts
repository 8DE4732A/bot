import { lstatSync, readlinkSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { BotSandboxConfig } from "../config/database-store.ts";
import { logger } from "../utils/logger.ts";

/** inode 指纹收集的 TTL 缓存: 清单变化低频, 收集 (目录枚举) 成本高 */
const INODE_CACHE_TTL = 60_000;
/** 单份清单的指纹数量上限 (防失控目录树) */
const INODE_ENTRY_LIMIT = 10_000;
/** 多槽缓存: 每个 Agent 的 deny 清单不同, 单槽会在多 Agent 交替下永久 miss */
const inodeCacheSlots = new Map<string, { inodes: Set<string>; at: number }>();

function collectInodesCached(entries: string[]): Set<string> {
  const key = entries.join("\u0000");
  const cached = inodeCacheSlots.get(key);
  if (cached && Date.now() - cached.at < INODE_CACHE_TTL) {
    inodeCacheSlots.delete(key);
    inodeCacheSlots.set(key, cached); // LRU 触摸
    return cached.inodes;
  }
  const inodes = new Set<string>();
  // lstat 不跟随 symlink: 遍历绝不能走出清单根目录——否则任何 Agent 在自己
  // workspace 里 ln -s / 即可让每次工具调用同步扫全盘 (平台级 DoS)。
  // 经 symlink 才可达的保护目标已由内核层路径 deny 兜底 (ASRT denyRead)。
  const collectEntry = (entry: string, depth: number, seen: Set<string>) => {
    if (inodes.size >= INODE_ENTRY_LIMIT) return;
    let st: import("node:fs").Stats | undefined;
    try {
      st = lstatSync(entry, { throwIfNoEntry: false });
    } catch {
      return;
    }
    if (st?.isFile()) {
      inodes.add(`${st.dev}:${st.ino}`);
      return;
    }
    if (st?.isDirectory()) {
      const dk = `${st.dev}:${st.ino}`;
      if (seen.has(dk) || depth > 12) return;
      seen.add(dk);
      let names: string[] = [];
      try {
        names = readdirSync(entry);
      } catch {
        return;
      }
      for (const name of names) collectEntry(join(entry, name), depth + 1, seen);
      return;
    }
    if (!entry.includes("*")) return;
    const parent = dirname(entry);
    let names: string[] = [];
    try {
      names = readdirSync(parent);
    } catch {
      return;
    }
    const prefix = entry.slice(0, entry.indexOf("*"));
    for (const name of names) {
      if (inodes.size >= INODE_ENTRY_LIMIT) return;
      const full = join(parent, name);
      if (!full.startsWith(prefix)) continue;
      try {
        const fst = lstatSync(full, { throwIfNoEntry: false });
        if (fst?.isFile()) inodes.add(`${fst.dev}:${fst.ino}`);
        else if (fst?.isDirectory()) collectEntry(full, depth + 1, seen);
      } catch {
        /* ignore */
      }
    }
  };
  const seen = new Set<string>();
  for (const e of entries) collectEntry(e, 0, seen);
  if (inodeCacheSlots.size > 8) {
    const oldest = inodeCacheSlots.keys().next().value;
    if (oldest !== undefined) inodeCacheSlots.delete(oldest);
  }
  inodeCacheSlots.set(key, { inodes, at: Date.now() });
  return inodes;
}

export class PathGuard {
  private config: BotSandboxConfig["filesystem"];
  private workspaceDir: string;
  private enabled: boolean;
  /** 平台级无条件禁读 (已归一化): 平台自身的数据库/日志/凭据文件, 不受 agent 配置影响 */
  private platformDenyRead: string[];
  /** 平台保护文件的 inode 指纹 ("dev:ino"): 硬链接是同一文件的第二个名字, 路径 deny 拦不住 */
  private protectedInodes: Set<string>;

  constructor(
    workspaceDir: string,
    config: BotSandboxConfig,
    platformDenyRead: string[] = [],
    /** 参与 inode 指纹收集的子集 (缺省同 platformDenyRead)。
     *  glob 条目会对目录整体枚举, 同目录的"放行"文件也会被收指纹——
     *  skills 源码 deny 模式必须排除 (否则 SKILL.md 无法读取), 见 execution-env */
    inodeProtect?: string[],
  ) {
    this.workspaceDir = resolve(workspaceDir);
    this.config = config.filesystem;
    this.enabled = config.enabled;
    this.platformDenyRead = platformDenyRead.map((p) => this.resolveReal(this.normalizePath(p)));
    // 对清单中的实际文件收集 inode 指纹 (目录不收: macOS 普通用户无法硬链接目录)。
    // 清单条目多为 glob (bot.sqlite*) 或目录 (logs/), 直接 stat 字符串收不到——
    // 先展开 glob (父目录 readdir + 前缀/正则匹配) 再逐文件指纹
    this.protectedInodes = collectInodesCached(
      (inodeProtect ?? platformDenyRead).map((p) => this.resolveReal(this.normalizePath(p))),
    );
  }


  /** 目标命中平台保护文件的 inode (硬链接绕过路径 deny 的封堵) */
  private checkInode(rawPath: string): string | undefined {
    if (this.protectedInodes.size === 0) return undefined;
    try {
      const st = statSync(rawPath, { throwIfNoEntry: false });
      if (st && this.protectedInodes.has(`${st.dev}:${st.ino}`)) {
        return `Read access denied: '${rawPath}' is a hard link to platform-protected data`;
      }
    } catch {
      /* ignore */
    }
    return undefined;
  }

  public normalizePath(rawPath: string): string {
    let p = rawPath.trim();
    if (p === "~") {
      p = homedir();
    } else if (p.startsWith("~/") || p.startsWith("~\\")) {
      p = resolve(homedir(), p.slice(2));
    } else if (!isAbsolute(p)) {
      p = resolve(this.workspaceDir, p);
    } else {
      p = resolve(p);
    }
    return p;
  }

  /**
   * 符号链接防护: 词法 resolve 会被 workspace 内的 symlink 绕过
   * (`ln -s .bot/bot.sqlite leak` 后读 leak; `ln -s ~/.ssh/x pwn` 后写 pwn,
   * 悬空 symlink 的 create 也会跟随链接落点)。逐段 lstat, 遇 symlink
   * 解析其目标并继续; 悬空 symlink 用其目标的词法路径参与策略匹配。
   */
  private resolveReal(normPath: string): string {
    // 统一迭代解析: 所有段 (含 symlink 目标) 都在同一逐段循环里处理,
    // 保证任意入口得到的真实路径坐标系一致 (如 /tmp -> /private/tmp)
    let pending = normPath.split("/").filter(Boolean);
    let base = "/";
    let hops = 0;

    while (pending.length > 0) {
      if (hops++ > 32) return base; // symlink 环防护
      const seg = pending.shift()!;
      if (seg === ".") continue;
      if (seg === "..") {
        base = dirname(base); // "/x/.." -> "/"; 根目录的 ".." 保持根
        continue;
      }
      const cur = base === "/" ? "/" + seg : base + "/" + seg;
      const st = lstatSync(cur, { throwIfNoEntry: false });
      if (st === undefined) {
        // 该段不存在: 剩余段词法拼接 (不存在处不可能再有 symlink 改道)
        return cur + (pending.length > 0 ? "/" + pending.join("/") : "");
      }
      if (st.isSymbolicLink()) {
        const target = readlinkSync(cur);
        const resolved = isAbsolute(target) ? target : resolve(dirname(cur), target);
        // 目标的段插回队列头部, 以根重新逐段解析 (目标可能又是 symlink)
        pending = [...resolved.split("/").filter(Boolean), ...pending];
        base = "/";
        continue;
      }
      base = cur;
    }
    return base;
  }

  private matchPattern(targetPath: string, pattern: string): boolean {
    const normPattern = this.normalizePath(pattern);
    if (pattern.endsWith("*")) {
      const prefix = normPattern.slice(0, -1);
      return targetPath.startsWith(prefix);
    }
    if (pattern.includes("*")) {
      const regexStr = "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$";
      return new RegExp(regexStr).test(targetPath);
    }
    // Directory prefix check
    return targetPath === normPattern || targetPath.startsWith(normPattern + "/");
  }

  /** 无 "/" 的相对模式 (如 .env*) 对路径任意目录层生效, 而非仅 workspace 顶层 */
  private matchRelativeDeep(norm: string, rawPattern: string): boolean {
    // 纯词法匹配: 不把 pattern 归一化到 workspace 绝对路径 (否则相对语义失效)
    const segments = norm.split("/");
    for (let i = 0; i < segments.length; i++) {
      const suffix = segments.slice(i).join("/");
      if (rawPattern.endsWith("*")) {
        if (suffix.startsWith(rawPattern.slice(0, -1))) return true;
      } else if (rawPattern.includes("*")) {
        const re = new RegExp(
          "^" + rawPattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$",
        );
        if (re.test(suffix)) return true;
      } else if (suffix === rawPattern || suffix.startsWith(rawPattern + "/")) {
        return true;
      }
    }
    return false;
  }

  private matchDeny(norm: string, rawPattern: string): boolean {
    return rawPattern.includes("/")
      ? this.matchPattern(norm, this.resolveReal(this.normalizePath(rawPattern)))
      : this.matchRelativeDeep(norm, rawPattern);
  }

  public checkCanRead(rawPath: string): { allowed: boolean; reason?: string; realPath?: string } {
    if (!this.enabled) return { allowed: true, realPath: this.resolveReal(this.normalizePath(rawPath)) };
    const norm = this.resolveReal(this.normalizePath(rawPath));

    // 硬链接与平台保护文件同 inode 时按路径 deny 无法识别, 用 inode 指纹拦截
    const inodeHit = this.checkInode(norm);
    if (inodeHit) return { allowed: false, reason: inodeHit, realPath: norm };

    // 平台自身数据 (密钥库/会话库/日志) 无条件禁读, 优先于一切 agent 配置
    for (const deny of this.platformDenyRead) {
      if (this.matchPattern(norm, deny)) {
        return {
          allowed: false,
          reason: `Read access denied by platform rule: '${rawPath}' is platform-protected`,
        };
      }
    }

    for (const deny of this.config.denyRead) {
      if (this.matchDeny(norm, deny)) {
        return {
          allowed: false,
          reason: `Read access denied by sandbox rule: '${deny}' matches '${rawPath}'`,
          realPath: norm,
        };
      }
    }

    return { allowed: true, realPath: norm };
  }

  public checkCanWrite(rawPath: string): { allowed: boolean; reason?: string; realPath?: string } {
    if (!this.enabled) return { allowed: true, realPath: this.resolveReal(this.normalizePath(rawPath)) };
    const norm = this.resolveReal(this.normalizePath(rawPath));

    // 与读侧相同的 inode 防护: 经硬链接改写平台数据文件同样必须拦截
    const inodeHit = this.checkInode(norm);
    if (inodeHit) return { allowed: false, reason: inodeHit.replace("Read", "Write"), realPath: norm };

    // 1. Check denyWrite first
    for (const deny of this.config.denyWrite) {
      if (this.matchDeny(norm, deny)) {
        return {
          allowed: false,
          reason: `Write access denied by sandbox denyWrite rule: '${deny}' matches '${rawPath}'`,
          realPath: norm,
        };
      }
    }

    // 2. Must be in allowWrite
    let allowedBySomeRule = false;
    for (const allow of this.config.allowWrite) {
      if (this.matchPattern(norm, this.resolveReal(this.normalizePath(allow)))) {
        allowedBySomeRule = true;
        break;
      }
    }

    if (!allowedBySomeRule) {
      return {
        allowed: false,
        reason: `Write access blocked: '${rawPath}' is outside allowed write paths [${this.config.allowWrite.join(", ")}]`,
        realPath: norm,
      };
    }

    return { allowed: true, realPath: norm };
  }

  public assertCanRead(rawPath: string) {
    const res = this.checkCanRead(rawPath);
    if (!res.allowed) {
      logger.warn("Sandbox", `Blocked read attempt: ${res.reason}`);
      throw new Error(res.reason);
    }
  }

  public assertCanWrite(rawPath: string) {
    const res = this.checkCanWrite(rawPath);
    if (!res.allowed) {
      logger.warn("Sandbox", `Blocked write attempt: ${res.reason}`);
      throw new Error(res.reason);
    }
  }
}
