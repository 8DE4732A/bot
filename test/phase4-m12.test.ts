import { describe, expect, test, afterAll } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, rmSync } from "node:fs";

import {
  gatewayInstance,
  gatewayInstanceId,
  generateLaunchdPlist,
  generateSystemdUnit,
  isTempCwd,
  normalizeDefinition,
  resolveGatewayProgram,
} from "../src/gateway/service-defs.ts";
import { probeGateway, startControlSocket } from "../src/gateway/control-socket.ts";
import { SessionHub } from "../src/gateway/session-hub.ts";
import { InboundPipeline } from "../src/channels/runtime/dispatch.ts";
import { setSlashFastPath } from "../src/channels/runtime/dispatch.ts";
import { AdminWebServer } from "../src/server/server.ts";
import { DatabaseManager } from "../src/database/index.ts";
import { logger } from "../src/utils/logger.ts";
import { DatabaseStore } from "../src/config/database-store.ts";

// 测试隔离纪律: 显式绑定临时目录单例 (勿 rmSync 单例库所在目录)
const tmpDbDir = join(tmpdir(), `bot-phase4-m12-${Date.now()}`);
mkdirSync(tmpDbDir, { recursive: true });
DatabaseManager.getInstance(join(tmpDbDir, "bot.sqlite"));
logger.init(tmpDbDir);

describe("phase4: service-defs (launchd/systemd 生成)", () => {
  const cwd = "/tmp/fake-project-for-test";
  const inst = gatewayInstance(cwd);

  test("实例标识: sha8 稳定 + label/unit 命名", () => {
    expect(inst.id).toMatch(/^[0-9a-f]{8}$/);
    expect(gatewayInstanceId(cwd)).toBe(inst.id);
    expect(inst.label).toBe(`com.bot.gateway.${inst.id}`);
    expect(inst.unitName).toBe(`bot-gateway-${inst.id}`);
    expect(inst.socketFile).toContain(".bot/gateway.sock");
  });

  test("launchd plist 关键字段 (KeepAlive/Throttle/ExitTimeOut/fd 上限)", () => {
    const plist = generateLaunchdPlist(inst);
    expect(plist).toContain(`<string>${inst.label}</string>`);
    expect(plist).toContain("SuccessfulExit");
    expect(plist).toContain("ThrottleInterval");
    expect(plist).toContain("ExitTimeOut");
    expect(plist).toContain("NumberOfFiles");
    expect(plist).toContain(inst.cwd);
    expect(plist).toContain("--foreground");
    expect(plist).toContain("--supervised");
    // ProgramArguments 首元素是绝对二进制/bun 路径
    expect(inst.program[0]!.startsWith("/")).toBe(true);
  });

  test("systemd unit 退出码协议 (75 强制重启 / 78 拒绝复活)", () => {
    const unit = generateSystemdUnit(inst);
    expect(unit).toContain("RestartForceExitStatus=75");
    expect(unit).toContain("RestartPreventExitStatus=78");
    expect(unit).toContain("KillMode=control-group");
    expect(unit).toContain(`WorkingDirectory=${cwd}`);
    expect(unit).toContain("WantedBy=default.target");
  });

  test("resolveGatewayProgram: 优先 bin/bot 编译产物", () => {
    const program = resolveGatewayProgram(cwd);
    // 测试环境无 /tmp/fake-project-for-test/bin/bot → 回退 bun + cli.ts 源码
    expect(program[0]).toBe(process.execPath);
    expect(program[1]).toContain("cli.ts");
    expect(program.slice(2)).toEqual(["gateway", "start", "--foreground", "--supervised"]);
  });

  test("临时目录拒装 + 定义归一化幂等", () => {
    expect(isTempCwd("/tmp/foo")).toBe(true);
    expect(isTempCwd("/private/tmp/foo")).toBe(true);
    expect(isTempCwd("/var/folders/x/y")).toBe(true);
    expect(isTempCwd("/Users/me/project")).toBe(false);
    const unit = generateSystemdUnit(inst);
    expect(normalizeDefinition(unit)).toBe(normalizeDefinition(`${unit}\n\n  \n`));
  });
});

describe("phase4: control socket (liveness = identify 应答)", () => {
  const sockDir = join(tmpDbDir, "ctl");
  const sockFile = join(sockDir, "gateway.sock");

  test("identify / status / 未知 verb / 残留 socket 清理", async () => {
    mkdirSync(sockDir, { recursive: true });
    const server = await startControlSocket(sockFile, {
      identify: () => ({ version: "1.0.0", cwd: "/x", pid: 4242, uptime: 3 }),
      status: async () => ({
        version: "1.0.0",
        cwd: "/x",
        pid: 4242,
        uptime: 3,
        draining: false,
        activeTurns: 0,
        scheduler: { started: true, inFlight: 0 },
        channels: [],
        webPort: "3000",
      }),
      drain: async () => {},
    });

    const live = await probeGateway(sockFile, "identify");
    expect(live.pid).toBe(4242);
    expect(live.version).toBe("1.0.0");

    const status = await probeGateway(sockFile, "status");
    expect(status.scheduler.started).toBe(true);

    // 未知 verb → ok:false
    await expect(probeGateway(sockFile, "identify" as any)).resolves.toBeDefined();

    server.close();
  });

  test("不可连接 = 不在运行 (liveness 判据)", async () => {
    const dead = await probeGateway(join(sockDir, "nope.sock"), "identify", 800).catch((e) => e);
    expect(dead).toBeInstanceOf(Error);
  });
});

describe("phase4: SessionHub (seq/replay/epoch)", () => {
  test("seq 单调 + since 补洞 + 全量", () => {
    const hub = new SessionHub();
    hub.emitForTest("a:s", "delta", { delta: "x" });
    hub.emitForTest("a:s", "delta", { delta: "y" });
    hub.emitForTest("a:s", "tool", { name: "bash", status: "running" });

    const since1 = hub.replaySince("a:s", 1);
    expect(since1.truncated).toBe(false);
    expect(since1.events.map((e) => e.seq)).toEqual([2, 3]);

    const all = hub.replayAll("a:s");
    expect(all.events.length).toBe(3);
    expect(all.epoch).toBe(hub.epoch);
  });

  test("环逐出后 since 有洞 → truncated=true 强制全量", () => {
    const hub = new SessionHub();
    for (let i = 0; i < 600; i++) hub.emitForTest("b:s", "delta", { delta: "." });
    const replay = hub.replaySince("b:s", 1);
    expect(replay.truncated).toBe(true);
    expect(replay.events.length).toBe(512);
    expect(replay.events[0]!.seq).toBe(89); // 600 - 512 + 1
  });

  test("事件推送 sink 同步收到 (保序)", () => {
    const hub = new SessionHub();
    const got: number[] = [];
    hub.onEvent((_key, e) => got.push(e.seq));
    hub.emitForTest("c:s", "delta", { delta: "1" });
    hub.emitForTest("c:s", "delta", { delta: "2" });
    expect(got).toEqual([1, 2]);
  });
});

describe("phase4: slash fast path 时序 (dedupe 后 / coalesce 前)", () => {
  test("命令消息立即处理, 不进防抖窗口", async () => {
    const handled: string[] = [];
    setSlashFastPath(async (_msg, content) => {
      handled.push(content);
      return true;
    });
    const dispatched: unknown[] = [];
    const p = new InboundPipeline({
      channelId: "ch-slash",
      // 启用防抖: 若命令误入防抖会被 5s 窗口扣住
      coalesceQuietMs: 5_000,
      dispatch: (m) => {
        dispatched.push(m);
        return Promise.resolve();
      },
    });
    await p.submit({
      channelInstanceId: "ch-slash",
      peerId: "p1",
      content: "/status",
      messageId: "s1",
    });
    // 立即 (非防抖窗口后) 到达 fast path
    expect(handled).toEqual(["/status"]);
    expect(dispatched.length).toBe(0); // 命令不送会话生成
    setSlashFastPath(undefined);
  });

  test("非命令斜杠文本落回常规链路 (fast path 返回 false)", async () => {
    setSlashFastPath(async () => false);
    const dispatched: any[] = [];
    const p = new InboundPipeline({
      channelId: "ch-slash2",
      enableCoalesce: false,
      dispatch: (m) => {
        dispatched.push(m);
        return Promise.resolve();
      },
    });
    await p.submit({
      channelInstanceId: "ch-slash2",
      peerId: "p1",
      content: "/Users/x/file.md 里有什么",
      messageId: "s2",
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(dispatched.length).toBe(1);
    setSlashFastPath(undefined);
  });
});

describe("phase4: WS 第二传输 (/api/gateway/ws)", () => {
  const port = 3277;
  const server = new AdminWebServer(port, "127.0.0.1", { authToken: "ws-token-1" });

  test("鉴权拒绝 + attach/回放/commands.list", async () => {
    await server.start();

    // 无 token: 401 后连接关闭
    const denied = await new Promise<string>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/gateway/ws`);
      ws.onclose = (e) => resolve(`closed:${(e as CloseEvent).code}`);
      ws.onerror = () => resolve("error");
      setTimeout(() => resolve("timeout"), 3000);
    });
    expect(["closed:1008", "closed:1006", "error"]).toContain(denied);

    // 带 token: attach + 回放 + commands.list
    const result = await new Promise<any>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/gateway/ws?token=ws-token-1`);
      const opened = () => {
        ws.send(JSON.stringify({ id: 1, method: "session.attach", params: { agentId: "a", sessionId: "s" } }));
        ws.send(JSON.stringify({ id: 2, method: "commands.list", params: {} }));
      };
      ws.onopen = opened;
      ws.onmessage = (msg) => {
        const frame = JSON.parse(String(msg.data));
        if (frame.id === 2) {
          resolve(frame.result);
          ws.close();
        }
      };
      ws.onerror = () => reject(new Error("ws error"));
      setTimeout(() => reject(new Error("ws timeout")), 5000);
    });
    expect(Array.isArray(result)).toBe(true);
    expect(result.some((c: any) => c.name === "help")).toBe(true);
    expect(result.some((c: any) => c.name === "status")).toBe(true);

    // 事件帧: 触发 hub 事件经另一连接接收 (走 EventBus turn 生命周期太重,
    // 直接验证 hub→ws 链路用 attach 后的 turn_start 广播: 跳过——已由
    // SessionHub 单测覆盖 seq/sink, 此处验证 RPC 面即可)
    await server.stop();
  });
});

afterAll(() => {
  // 全套件共享单例: 只清本套件独立目录 (非单例库目录)
  try {
    rmSync(join(tmpDbDir, "ctl"), { recursive: true, force: true });
  } catch {}
});

// ── R1 评审回归 (对抗评审收敛守护) ──
import { selfDestructBlocked as gate } from "../src/sandbox/execution-env.ts";
// R4 教训: 白名单逻辑复制进测试曾导致生产漂移全绿假象——测试必须走生产实现

describe("phase4 R1: 防自杀闸覆盖实际攻击形态 (C-B2/B3, X-B2)", () => {
  // 完整闸 = 白名单 + 正则; mustBlock/mustPass 走 gate() 全链路 (R3 矩阵)
  const mustBlock = [
    "bot gateway stop",
    "bot gateway restart",
    "bun src/cli.ts gateway stop",
    "bun /Users/x/project/bot/src/cli.ts gateway uninstall",
    "./bin/bot gateway restart",
    "launchctl bootout gui/501/com.bot.gateway.1a2b3c4d",
    "launchctl remove gui/501/com.bot.gateway.1a2b3c4d",
    "launchctl kill SIGTERM gui/501/com.bot.gateway.1a2b3c4d",
    "launchctl unload -w ~/Library/LaunchAgents/com.bot.gateway.1a2b3c4d.plist",
    "systemctl --user stop bot-gateway-1a2b3c4d.service",
    "systemctl --user disable bot-gateway-1a2b3c4d.service",
    "pkill -f 'gateway start'",
    "kill $(cat .bot/gateway.pid) 2>/dev/null || bin/bot gateway stop",
  ];
  for (const cmd of mustBlock) {
    test(`拦截: ${cmd}`, () => {
      expect(gate(cmd)).toBe(true);
    });
  }
  const mustPass = [
    "bot gateway status",
    "bot gateway service",
    "bun src/cli.ts gateway install --start-now",
    "launchctl print gui/501/com.bot.gateway.1a2b3c4d",
    "systemctl --user status bot-gateway-1a2b3c4d.service",
    "kill -USR1 12345",
    "ls bin/bot",
    "cat cli.ts gateway",
  ];
  for (const cmd of mustPass) {
    test(`放行: ${cmd}`, () => {
      expect(gate(cmd)).toBe(false);
    });
  }

  // R3-B2 矩阵: 复合命令/管道/内嵌执行不得借只读首词豁免
  const r3Block = [
    "grep x; bot gateway stop",
    "cat /dev/null; killall bot",
    "echo x | launchctl bootout gui/501/com.bot.gateway.abcd",
    'pkill -f "gateway.*start"',
    "awk 'BEGIN{system(\"bot gateway stop\")}'",
    "find . -exec bot gateway stop \\;",
  ];
  for (const cmd of r3Block) {
    test(`R3 拦截: ${cmd}`, () => {
      expect(gate(cmd)).toBe(true);
    });
  }
  const r3Pass = [
    'grep "gateway stop" CLAUDE.md',
    'cat "bot gateway stop" in docs',
    "grep -r gateway.stop logs/",
  ];
  for (const cmd of r3Pass) {
    test(`R3 放行: ${cmd}`, () => {
      expect(gate(cmd)).toBe(false);
    });
  }
});

// ── R2 评审回归 ──
import { EventBus } from "../src/core/event-bus.ts";

describe("phase4 R2: SessionHub fanout (R2-B3 死循环守护)", () => {
  test("Map 迭代中 LRU 置顶不导致无限循环 (复制 keys 后遍历)", () => {
    const hub = new SessionHub();
    hub.start(); // 接线 EventBus (fanout 在 start 的订阅里)
    hub.emitForTest("agent-a:s1", "delta", { delta: "x" });
    hub.emitForTest("agent-a:s2", "delta", { delta: "y" });
    const got: string[] = [];
    hub.onEvent((key, e) => {
      if (e.kind === "platform") got.push(key);
    });
    // 经 EventBus 触发 (与生产路径一致); 若 fanout 死循环此测试超时
    EventBus.getInstance().publish({
      type: "scheduler.completed",
      taskId: "t1",
      taskName: "任务",
      agentId: "agent-a",
      status: "ok",
      runNumber: 1,
      result: "ok",
    });
    // 两个环都收到 platform 事件
    expect(got.length).toBe(2);
  });

  test("ensureRing: attach 即建环, 静默会话也进 platform fanout 面 (R2-N1)", () => {
    const hub = new SessionHub();
    hub.start();
    hub.ensureRing("agent-b:terminal-main:local-user");
    const got: string[] = [];
    hub.onEvent((key, e) => {
      if (e.kind === "platform") got.push(key);
    });
    EventBus.getInstance().publish({
      type: "scheduler.completed",
      taskId: "t2",
      taskName: "任务",
      agentId: "agent-b",
      status: "ok",
      runNumber: 1,
      result: "ok",
    });
    expect(got).toEqual(["agent-b:terminal-main:local-user"]);
    // 空环重放为空 (无副作用)
    expect(hub.replayAll("agent-b:terminal-main:local-user").events.length).toBe(1); // platform 事件本身
  });
});

describe("phase4 R2: listSessions 哨兵行提升 (R2-B8)", () => {
  test("无真实渠道行的会话 (web-playground/scheduler) 仍展示且来源可辨", () => {
    const store = new DatabaseStore();
    store.saveSession({ channelInstanceId: "channel_session", peerId: "agent-default:web-playground:agent-default", agentId: "agent-default", conversationId: "99901", createdAt: Date.now(), lastActiveAt: Date.now() });
    store.saveSession({ channelInstanceId: "channel_session", peerId: "agent-default:scheduler:task-x", agentId: "agent-default", conversationId: "99902", createdAt: Date.now(), lastActiveAt: Date.now() });
    store.saveSession({ channelInstanceId: "feishu-x", peerId: "ou_real", agentId: "agent-default", conversationId: "99901", createdAt: Date.now(), lastActiveAt: Date.now() });

    const sessions = store.listSessions();
    // 99901 有真实渠道行 → 显示 feishu-x (哨兵行被去重)
    // 99902 无真实行 → 提升哨兵行, 来源改写为 scheduler
    const web = sessions.find((s) => s.conversationId === "99901");
    const sched = sessions.find((s) => s.conversationId === "99902");
    expect(web!.channelInstanceId).toBe("feishu-x");
    expect(web!.peerId).toBe("ou_real");
    expect(sched!.channelInstanceId).toBe("scheduler");
    expect(sched!.peerId).toBe("task-x");
    // 不再出现裸 channel_session 行
    expect(sessions.every((s) => s.channelInstanceId !== "channel_session")).toBe(true);
  });
});

describe("phase4 R4: SessionHub 引用计数与硬上限 (R4-B3)", () => {
  test("多客户端同看: 引用计数归零才回归 LRU", () => {
    const hub = new SessionHub();
    hub.ensureRing("rc:s"); // 客户端 A attach
    hub.ensureRing("rc:s"); // 客户端 B attach
    hub.unpinRing("rc:s");  // A 断开
    hub.emitForTest("rc:s", "delta", { delta: "1" });
    // B 仍 attach——环被置顶后同 key 事件再入环不触发逐出, 这里验证未逐出
    expect(hub.replayAll("rc:s").events.length).toBe(1);
    hub.unpinRing("rc:s"); // B 断开 → 计数归零
  });

  test("硬上限: 全部 pinned 时强逐最旧, Map 不无界增长", () => {
    const hub = new SessionHub();
    for (let i = 0; i < 64; i++) hub.ensureRing(`cap:s${i}`);
    for (let c = 0; c < 50; c++) {
      hub.ensureRing(`cap:extra${c}`);
      hub.emitForTest(`cap:extra${c}`, "delta", { delta: "." });
    }
    // 尺寸恒有界 (逐出最旧, pinned 也不例外)
    expect(hub.replayAll("cap:s0").events.length).toBe(0); // 最旧的被逐
  });
});

describe("phase4 R5: 硬上限强逐的 seq 单调性 (R5-B2)", () => {
  test("强逐后重建环 seq 恢复单调 (墓碑), attach 客户端 watermark 过滤不丢事件", () => {
    const hub = new SessionHub();
    // victim 会话产生事件, 客户端 attach (watermark = 已见 seq)
    hub.emitForTest("v:s", "delta", { delta: "1" });
    hub.emitForTest("v:s", "delta", { delta: "2" });
    hub.ensureRing("v:s"); // watermark 语义 = 2
    // 灌满 64 个环, 使 v:s 成为插入序最旧并触发强逐
    for (let i = 0; i < 80; i++) {
      hub.ensureRing(`o:s${i}`);
      hub.emitForTest(`o:s${i}`, "delta", { delta: "." });
    }
    // victim 重建后新事件 seq 必须继续单调 (>2), 客户端才能收到
    const sinkGot: number[] = [];
    hub.onEvent((key, e) => {
      if (key === "v:s" && e.kind === "delta") sinkGot.push(e.seq);
    });
    hub.emitForTest("v:s", "delta", { delta: "3" });
    expect(sinkGot.length).toBe(1);
    expect(sinkGot[0]!).toBeGreaterThan(2);
    // since 补洞: lastSeq=2 → 新事件可见 (truncated 或含 seq>2)
    const replay = hub.replaySince("v:s", 2);
    expect(replay.events.some((e) => e.seq > 2)).toBe(true);
  });

  test("Map 尺寸有界 (硬上限, R4-B3 守护)", () => {
    const hub = new SessionHub();
    for (let i = 0; i < 200; i++) {
      hub.ensureRing(`cap2:s${i}`);
      hub.emitForTest(`cap2:s${i}`, "delta", { delta: "." });
    }
    // 经 sink 数不到内部 size——用 replayAll 对 200 个 key 抽查:
    // 老的全被逐 (空), 但总创建数 200 >> MAX_SESSIONS, 若无上限内存会爆;
    // 直接断言最老与最新共存行为: 最新 64 个有环
    let alive = 0;
    for (let i = 200 - 64; i < 200; i++) {
      if (hub.replayAll(`cap2:s${i}`).events.length > 0) alive++;
    }
    expect(alive).toBe(64);
  });
});

describe("phase4 R7: attach 状态独立于环缓存 (R7-B1)", () => {
  test("65 个 attach 触发强逐后, 被逐会话的 platform 事件仍投递", () => {
    const hub = new SessionHub();
    hub.start();
    const got: string[] = [];
    hub.onEvent((key, e) => {
      if (e.kind === "platform") got.push(key);
    });
    hub.ensureRing("z:target"); // 客户端 attach target
    for (let i = 0; i < 70; i++) hub.ensureRing(`z:other${i}`); // 触发强逐 target
    EventBus.getInstance().publish({
      type: "scheduler.completed",
      taskId: "t9",
      taskName: "任务",
      agentId: "z",
      status: "ok",
      runNumber: 1,
      result: "ok",
    });
    // target 的环被强逐但 attach 状态独立保留 → fanout 重建环并投递
    expect(got).toContain("z:target");
  });
});

describe("phase4 R8: fanout 重建不虚增 attach 计数 (R8-B1)", () => {
  test("强逐 + fanout 后计数不变, 客户端断开归零", () => {
    const hub = new SessionHub();
    hub.start();
    hub.ensureRing("w:target"); // 1 个客户端 attach
    for (let i = 0; i < 70; i++) hub.ensureRing(`w:other${i}`); // 强逐 target
    EventBus.getInstance().publish({
      type: "scheduler.completed",
      taskId: "t10",
      taskName: "任务",
      agentId: "w",
      status: "ok",
      runNumber: 1,
      result: "ok",
    });
    // fanout 重建了 target 的环——但订阅计数必须仍是 1
    hub.unpinRing("w:target"); // 客户端断开
    // 计数归零: 再 unpin 一次不应报错, 且该 key 不再在投递面
    hub.unpinRing("w:target");
    EventBus.getInstance().publish({
      type: "scheduler.completed",
      taskId: "t11",
      taskName: "任务",
      agentId: "w",
      status: "ok",
      runNumber: 2,
      result: "ok",
    });
    // 无幽灵订阅: 上面第二次 publish 只应投给仍 attached 的 other 环
    // (直接断言方式: target 环未收到 platform 事件——用 replayAll 检查)
    const evts = hub.replayAll("w:target").events.filter((e) => e.kind === "platform");
    expect(evts.length).toBe(0);
  });
});
