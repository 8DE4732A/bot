import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getBotPaths } from "../config/env-paths.ts";

/**
 * Gateway 服务定义生成器 (四期 M1, 设计 §3.2):
 * launchd LaunchAgent / systemd user unit 纯函数生成——字段照抄 hermes
 * 生产验证过的取值。定义文本用于 install 的 staleness 对比 (期望归一化
 * 相等则幂等跳过, 不一致则重写收敛)。
 *
 * 退出码协议: exit 75 = 请监管者重启我 (launchd KeepAlive 判定 /
 * systemd RestartForceExitStatus); exit 78 = 致命配置错不重启
 * (systemd RestartPreventExitStatus; launchd 由 bootstrap-guard 标记
 * 文件实现——重启后见标记 exit 0, KeepAlive {SuccessfulExit:false} 链条终止)。
 */

export const EXIT_RESTART = 75;
export const EXIT_CONFIG_ERROR = 78;

export interface GatewayInstance {
  /** 解析后的项目绝对路径 (.bot 跟随) */
  cwd: string;
  /** 实例标识 sha8(cwd)——一机多项目互不干扰 */
  id: string;
  /** launchd Label */
  label: string;
  /** systemd user unit 名 (不含 .service) */
  unitName: string;
  /** ProgramArguments / ExecStart */
  program: string[];
  logFile: string;
  errorLogFile: string;
  pidFile: string;
  socketFile: string;
  configErrorMarker: string;
}

/** 实例标识: cwd 的 sha8 (与 hermes 同款, 稳定且不泄路径) */
export function gatewayInstanceId(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 8);
}

/**
 * gateway 程序解析: 优先项目内编译产物 bin/bot; 开发环境回退
 * 当前 bun + cli.ts 源码入口。服务管理器下恒为 foreground 模式
 * (launchd/systemd 就是监管者, 不允许中间 daemonize 父进程);
 * --supervised 启用 bootstrap-guard (exit 78 配置错 → 重启见标记 exit 0,
 * KeepAlive 链条终止, 防配置错死循环复活)。
 */
export function resolveGatewayProgram(cwd: string): string[] {
  const bin = join(cwd, "bin", "bot");
  if (existsSync(bin)) {
    return [bin, "gateway", "start", "--foreground", "--supervised"];
  }
  return [process.execPath, join(cwd, "src", "cli.ts"), "gateway", "start", "--foreground", "--supervised"];
}

export function gatewayInstance(cwd: string = process.cwd()): GatewayInstance {
  const paths = getBotPaths(cwd);
  const id = gatewayInstanceId(cwd);
  return {
    cwd,
    id,
    label: `com.bot.gateway.${id}`,
    unitName: `bot-gateway-${id}`,
    program: resolveGatewayProgram(cwd),
    logFile: join(paths.logsDir, "gateway.log"),
    errorLogFile: join(paths.logsDir, "gateway.error.log"),
    pidFile: join(paths.dotBot, "gateway.pid"),
    socketFile: join(paths.dotBot, "gateway.sock"),
    configErrorMarker: join(paths.dotBot, "gateway.config-error"),
  };
}

/** 临时目录 cwd 拒装 (hermes _refuse_temp_home 同款): 服务跟着临时目录消失 */
export function isTempCwd(cwd: string): boolean {
  return (
    cwd.startsWith("/tmp/") ||
    cwd.startsWith("/private/tmp/") ||
    cwd.startsWith("/var/folders/") ||
    cwd.startsWith("/var/tmp/")
  );
}

export function launchdPlistPath(instance: GatewayInstance): string {
  return join(homedir(), "Library", "LaunchAgents", `${instance.label}.plist`);
}

export function systemdUnitPath(instance: GatewayInstance): string {
  return join(homedir(), ".config", "systemd", "user", `${instance.unitName}.service`);
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** launchd LaunchAgent (设计 §3.2 字段表) */
export function generateLaunchdPlist(instance: GatewayInstance): string {
  const args = instance.program.map((a) => `    <string>${xmlEscape(a)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${instance.label}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(instance.cwd)}</string>
  <key>RunAtLoad</key>
  <true/>
  <!-- 非 0 退出复活 (含 drain 协议的 75); 干净退出 (手动 bootout) 不复活 -->
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <!-- 防 respawn 风暴: 两次拉起至少间隔 30s -->
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <!-- ≥ graceful stop 预算 (drain 等待在飞 turn 上限 50s) -->
  <key>ExitTimeOut</key>
  <integer>60</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(instance.logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(instance.errorLogFile)}</string>
  <!-- launchd 默认 256 fd 会 EMFILE (MCP stdio 子进程多) -->
  <key>SoftResourceLimits</key>
  <dict>
    <key>NumberOfFiles</key>
    <integer>4096</integer>
  </dict>
</dict>
</plist>
`;
}

/** systemd user unit (设计 §3.2 字段表) */
export function generateSystemdUnit(instance: GatewayInstance): string {
  const exec = instance.program.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ");
  return `[Unit]
Description=Bot Gateway (${instance.cwd})
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${instance.cwd}
ExecStart=${exec}
# 退出码协议: 75=请重启 (强制), 78=致命配置错 (禁止复活, 防死循环)
RestartForceExitStatus=75
RestartPreventExitStatus=78
Restart=on-failure
RestartSec=5
StartLimitIntervalSec=300
StartLimitBurst=10
TimeoutStopSec=60
# MCP stdio 子进程一并回收
KillMode=control-group

[Install]
WantedBy=default.target
`;
}

/** install 幂等对比: 定义文本归一化 (去空行/trim 尾空白) 后相等视为一致 */
export function normalizeDefinition(text: string): string {
  return text
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0)
    .join("\n");
}
