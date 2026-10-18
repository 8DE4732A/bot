import { describe, expect, it } from "bun:test";
import { linkSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { PathGuard } from "../src/sandbox/path-guard.ts";
import { hardlinkBlocked } from "../src/sandbox/execution-env.ts";

describe("Sandbox hardlink guard", () => {
  it("blocks hardlink creation commands", () => {
    expect(hardlinkBlocked("ln a b")).toBe(true);
    expect(hardlinkBlocked("ln -f a b")).toBe(true);
    expect(hardlinkBlocked("/bin/ln a b")).toBe(true);
    expect(hardlinkBlocked("link a b")).toBe(true);
    expect(hardlinkBlocked("cp -l a b")).toBe(true);
    expect(hardlinkBlocked("cp --link a b")).toBe(true);
    expect(hardlinkBlocked("cp -rl a b")).toBe(true);
    expect(hardlinkBlocked("echo ok; ln a b")).toBe(true);
    // wrapper / 间接执行形态
    expect(hardlinkBlocked("env ln a b")).toBe(true);
    expect(hardlinkBlocked("command ln a b")).toBe(true);
    expect(hardlinkBlocked("busybox ln a b")).toBe(true);
    expect(hardlinkBlocked("sudo ln a b")).toBe(true);
    expect(hardlinkBlocked("bash -c 'ln a b'")).toBe(true);
    expect(hardlinkBlocked("find . -exec ln a b \\;")).toBe(true);
    expect(hardlinkBlocked("python3 -c 'os.link(\"a\", \"b\")'")).toBe(true);
    expect(hardlinkBlocked("node -e 'require(\"fs\").linkSync(\"a\",\"b\")'")).toBe(true);
    expect(hardlinkBlocked('l"n" a b')).toBe(true);
    expect(hardlinkBlocked('/bin/l""n a b')).toBe(true);
    expect(hardlinkBlocked("sudo -u root ln a b")).toBe(true);
    expect(hardlinkBlocked("env PATH=/tmp ln a b")).toBe(true);
    expect(hardlinkBlocked("xargs ln a b")).toBe(true);
  });

  it("allows symlinks, ordinary copies and read-only queries", () => {
    expect(hardlinkBlocked("ln -s a b")).toBe(false);
    expect(hardlinkBlocked("ln -sf a b")).toBe(false);
    expect(hardlinkBlocked("bash -c 'ln -s a b'")).toBe(false);
    expect(hardlinkBlocked("cp a b")).toBe(false);
    expect(hardlinkBlocked("cp -r a b")).toBe(false);
    expect(hardlinkBlocked("/bin/cp a b")).toBe(false);
    expect(hardlinkBlocked("grep ln file.txt")).toBe(false);
    expect(hardlinkBlocked("echo 'ln a b'")).toBe(false);
    expect(hardlinkBlocked("printf 'link'")).toBe(false);
    expect(hardlinkBlocked("which ln")).toBe(false);
    expect(hardlinkBlocked("man ln")).toBe(false);
    expect(hardlinkBlocked("command -v ln")).toBe(false);
    // 参数里出现 link 不应误杀
    expect(hardlinkBlocked("git checkout link")).toBe(false);
    expect(hardlinkBlocked("npm run link")).toBe(false);
    expect(hardlinkBlocked("rm link")).toBe(false);
    expect(hardlinkBlocked("chmod +x link")).toBe(false);
    expect(hardlinkBlocked("cp file link")).toBe(false);
  });
});

describe("Sandbox PathGuard", () => {
  const workspace = "/tmp/sandbox-agent-ws";
  const guard = new PathGuard(workspace, {
    enabled: true,
    network: { allowedDomains: ["github.com"], deniedDomains: [] },
    filesystem: {
      allowWrite: [workspace, "/tmp/allowed"],
      denyRead: ["~/.ssh", "~/.aws", ".env*"],
      denyWrite: [".git", "*.pem"],
    },
  });

  it("should allow writing inside allowed directories", () => {
    const res = guard.checkCanWrite(`${workspace}/index.ts`);
    expect(res.allowed).toBe(true);

    const resTmp = guard.checkCanWrite("/tmp/allowed/output.txt");
    expect(resTmp.allowed).toBe(true);
  });

  it("should block writing outside allowed directories", () => {
    const res = guard.checkCanWrite("/etc/hosts");
    expect(res.allowed).toBe(false);
    expect(res.reason).toContain("outside allowed write paths");
  });

  it("should block writing to denyWrite patterns", () => {
    const res = guard.checkCanWrite(`${workspace}/secret.pem`);
    expect(res.allowed).toBe(false);
    expect(res.reason).toContain("denyWrite");
  });

  it("should block reading sensitive denyRead patterns", () => {
    const res = guard.checkCanRead("~/.ssh/id_rsa");
    expect(res.allowed).toBe(false);
    expect(res.reason).toContain("Read access denied");

    const resEnv = guard.checkCanRead(`${workspace}/.env.production`);
    expect(resEnv.allowed).toBe(false);
  });

  it("should allow reading ordinary files in workspace", () => {
    const res = guard.checkCanRead(`${workspace}/README.md`);
    expect(res.allowed).toBe(true);
  });
});

describe("Sandbox PathGuard (hardened semantics)", () => {
  const ws = "/tmp/test-bot-guard-" + Date.now();
  const guard = new PathGuard(ws, {
    enabled: true,
    network: { allowedDomains: [], deniedDomains: [] },
    filesystem: {
      allowWrite: [ws],
      denyRead: ["~/.ssh", ".env*"],
      denyWrite: [".git"],
    },
  }, [ws + "/../guard-secret.sqlite"]);

  it("blocks platform deny list regardless of agent config", () => {
    const res = guard.checkCanRead(ws + "/../guard-secret.sqlite");
    expect(res.allowed).toBe(false);
    expect(res.reason).toContain("platform rule");
  });

  it("matches bare-name deny patterns at any directory depth", () => {
    expect(guard.checkCanRead(ws + "/.env.production").allowed).toBe(false);
    expect(guard.checkCanRead(ws + "/sub/dir/.env.local").allowed).toBe(false);
    // 同名语义对写侧 deny 也生效 (嵌套 .git)
    expect(guard.checkCanWrite(ws + "/sub/.git/config").allowed).toBe(false);
    // 非 deny 内容正常放行
    expect(guard.checkCanRead(ws + "/notes.txt").allowed).toBe(true);
  });

  it("collects inode fingerprints from glob and directory entries (hard link defense)", () => {
    mkdirSync(ws, { recursive: true });
    // 模拟生产清单形态: glob (bot.sqlite*) 与目录条目的文件都要进指纹集
    const guard2 = new PathGuard(ws, {
      enabled: true,
      network: { allowedDomains: [], deniedDomains: [] },
      filesystem: { allowWrite: [ws], denyRead: [], denyWrite: [] },
    }, [ws + "/../secret.sqlite*", ws + "/../guard-logs"]);
    writeFileSync(ws + "/../secret.sqlite", "keys");
    mkdirSync(ws + "/../guard-logs", { recursive: true });
    writeFileSync(ws + "/../guard-logs/bot.log", "log");

    // 硬链接 (同 inode 第二名字) 读必须被拒
    linkSync(ws + "/../secret.sqlite", ws + "/leak-hard");
    expect(guard2.checkCanRead(ws + "/leak-hard").allowed).toBe(false);
    linkSync(ws + "/../guard-logs/bot.log", ws + "/leak-log");
    expect(guard2.checkCanRead(ws + "/leak-log").allowed).toBe(false);
    // 非 protect 文件不受影响
    expect(guard2.checkCanRead(ws + "/plain.txt").allowed).toBe(true);
  });

  it("resolves symlinks before policy matching", () => {
    mkdirSync(ws, { recursive: true });
    // workspace 内的 symlink 指向平台保护文件: 读必须被拒
    symlinkSync(ws + "/../guard-secret.sqlite", ws + "/leak");
    const readRes = guard.checkCanRead(ws + "/leak");
    expect(readRes.allowed).toBe(false);

    // workspace 内的 symlink 指向 allowWrite 之外: 写必须被拒
    symlinkSync("/tmp/test-bot-guard-outside-target", ws + "/escape");
    const writeRes = guard.checkCanWrite(ws + "/escape");
    expect(writeRes.allowed).toBe(false);
  });
});
