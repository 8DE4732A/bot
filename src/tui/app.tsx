import { Box, Text, Static, useApp, useInput } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";
import { GatewayClient, type TuiEvent, type TurnUsageInfo } from "./client.ts";

/**
 * TUI MVP (四期 M2, 设计 §4.3): Ink + React 纯客户端——会话权威在 gateway
 * (attach 语义), 退出/崩溃零影响服务端。渲染模型: <Static> 承接已完成块
 * (append-only, 长会话不重渲染不 OOM), live 区只承载流式 delta + composer。
 * slash ghost 补全: 唯一前缀命中 Tab 采纳; busy 输入自动入队 (预览提示)。
 */

interface Block {
  id: number;
  role: "user" | "assistant" | "tool" | "system" | "error";
  text: string;
  ts: number;
}

let blockSeq = 0;
const makeBlock = (role: Block["role"], text: string): Block => ({ id: ++blockSeq, role, text, ts: Date.now() });

const ROLE_STYLE: Record<Block["role"], { label: string; color: string }> = {
  user: { label: "你", color: "cyan" },
  assistant: { label: "Agent", color: "green" },
  tool: { label: "Tool", color: "yellow" },
  system: { label: "系统", color: "gray" },
  error: { label: "错误", color: "red" },
};

function BlockView({ block }: { block: Block }) {
  const style = ROLE_STYLE[block.role];
  const time = new Date(block.ts).toLocaleTimeString("zh-CN", { hour12: false });
  return (
    <Box marginBottom={1} flexDirection="column">
      <Text>
        <Text color={style.color} bold>
          {style.label}
        </Text>
        <Text dimColor> · {time}</Text>
      </Text>
      <Text color={block.role === "error" ? "red" : undefined}>{block.text}</Text>
    </Box>
  );
}

const LOCAL_COMMANDS = new Set(["/exit", "/quit", "/clear", "/quit-all"]);

export function TuiApp({ client }: { client: GatewayClient }) {
  const { exit } = useApp();
  const [blocks, setBlocks] = useState<Block[]>([
    makeBlock("system", `已连接 gateway · 会话 ${client.sessionId} · Agent ${client.agentId}`),
  ]);
  const [live, setLive] = useState("");
  const [toolTrail, setToolTrail] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [queued, setQueued] = useState(0);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<"connecting" | "online" | "offline" | "reset">("connecting");
  const [usage, setUsage] = useState<TurnUsageInfo | undefined>(undefined);
  const [commands, setCommands] = useState<{ name: string; aliases: string[]; description: string; argsHint?: string }[]>([]);
  const liveRef = useRef("");

  const push = (role: Block["role"], text: string) => setBlocks((prev) => [...prev, makeBlock(role, text)]);

  useEffect(() => {
    client.onEvent = (e: TuiEvent) => {
      switch (e.kind) {
        case "turn_start":
          setBusy(true);
          liveRef.current = "";
          setLive("");
          break;
        case "delta": {
          liveRef.current += String(e.data?.delta ?? "");
          setLive(liveRef.current);
          break;
        }
        case "tool": {
          const { name, status: st } = e.data ?? {};
          if (st === "running") setToolTrail(`🔧 [${name}] 执行中…`);
          else {
            setToolTrail(undefined);
            if (name) push("tool", `🔧 ${name} ✓`);
          }
          break;
        }
        case "usage":
          setUsage(e.data as TurnUsageInfo);
          break;
        case "turn_end": {
          setBusy(false);
          setToolTrail(undefined);
          if (liveRef.current.trim()) {
            push("assistant", liveRef.current);
          }
          liveRef.current = "";
          setLive("");
          if (e.data?.error) push("error", `上一轮生成失败: ${e.data.error}`);
          break;
        }
        case "platform": {
          const d = e.data ?? {};
          if (d.commandEcho) {
            push(d.ok ? "system" : "error", `${d.commandEcho}\n${String(d.text ?? "")}`);
            break;
          }
          if (d.taskName) push("system", `⏱ 定时任务「${d.taskName}」${d.status === "error" ? "执行失败" : "完成"}\n${String(d.result ?? d.error ?? "").slice(0, 400)}`);
          break;
        }
      }
    };
    client.onStatus = (s) => {
      setStatus(s);
      if (s === "reset") {
        // 清屏全量重建 (断线事件超重放环 / gateway 重启, R1 评审 B8)
        setBlocks([makeBlock("system", "⚠ 会话事件流已全量重建 (断线补洞有洞或 gateway 已重启)")]);
        liveRef.current = "";
        setLive("");
        setBusy(false);
      }
      if (s === "offline") push("system", "⚠ 连接断开, 正在重连…");
      if (s === "online") {
        // 恢复服务端真实排队数 (R1 评审 M16: 服务端队列随 detach 保留)
        void client.rpc("session.status", { agentId: client.agentId, sessionId: client.sessionId })
          .then((r) => setQueued(r.queued ?? 0))
          .catch(() => {});
      }
    };
    client.onTurnEnd = () => {
      // 服务端队列出队后刷新本地排队计数 (尽力而为)
      void client.rpc("session.status", { agentId: client.agentId, sessionId: client.sessionId })
        .then((r) => setQueued(r.queued ?? 0))
        .catch(() => {});
    };

    void client
      .rpc("commands.list", {})
      .then((r) => setCommands(r ?? []))
      .catch(() => {});

    return () => {
      client.onEvent = undefined;
      client.onStatus = undefined;
      client.onTurnEnd = undefined;
    };
  }, [client]);

  const submit = async (raw: string) => {
    const text = raw.trim();
    if (!text) return;
    setInput("");
    const lowered = text.toLowerCase();

    // 本地命令双表分治 (设计 §4.3): 只影响客户端, 不经 RPC
    if (LOCAL_COMMANDS.has(lowered)) {
      if (lowered === "/clear") {
        setBlocks([makeBlock("system", "本地视图已清空 (会话历史不受影响)")]);
        return;
      }
      push("system", "退出 TUI (gateway 继续运行; IM 渠道与会话不受影响)");
      exit();
      return;
    }

    if (text.startsWith("/")) {
      // 服务端命令 (RPC): 与 IM/Web 语义一致
      try {
        const result = await client.execCommand(text);
        push(result.ok ? "system" : "error", result.content ?? "(无输出)");
        // /agent <id> 视图切换 (R1 评审 B10: data.switchTo 不再被丢弃)
        const target = (result.data as { switchTo?: string } | undefined)?.switchTo;
        if (target) {
          client.switchAgent(target);
          setUsage(undefined);
          push("system", `已切换视图到 Agent ${target} (切换 = 另一个会话上下文)`);
        }
      } catch (err) {
        push("error", `命令失败: ${err instanceof Error ? err.message : err}`);
      }
      return;
    }

    push("user", text);
    try {
      const accepted = await client.submit(text, "queue");
      if (accepted.accepted === "queued") setQueued((q) => q + 1);
    } catch (err) {
      push("error", `发送失败: ${err instanceof Error ? err.message : err}`);
    }
  };

  useInput((ch, key) => {
    if (key.ctrl && ch === "c") {
      if (busy) {
        void client
          .cancel()
          .then(() => setBlocks((prev) => [...prev, makeBlock("system", "已请求中断当前生成")]))
          .catch(() => {});
      } else {
        exit();
      }
      return;
    }
    if (key.tab && ghost) {
      setInput(input + ghost);
      return;
    }
    if (key.return) {
      void submit(input);
      return;
    }
    if (key.backspace || key.delete) {
      setInput((v) => v.slice(0, -1));
      return;
    }
    if (key.upArrow || key.downArrow) return; // 历史回放留待后续
    if (ch && !key.ctrl && !key.meta) {
      setInput((v) => v + ch);
    }
  });

  // slash 补全 ghost (设计 §4.3): 唯一前缀命中展示余下部分, Tab 采纳
  const ghost = useMemo(() => {
    if (!input.startsWith("/") || input.includes(" ")) return "";
    const partial = input.slice(1).toLowerCase();
    const names = [...commands.flatMap((c) => [c.name, ...c.aliases])];
    const hits = names.filter((n) => n.startsWith(partial) && n !== partial);
    if (hits.length !== 1) return "";
    return hits[0]!.slice(partial.length);
  }, [input, commands]);

  const statusColor = status === "online" ? "green" : status === "connecting" ? "yellow" : "red";
  const statusLabel = status === "online" ? "已连接" : status === "connecting" ? "连接中" : status === "reset" ? "已重置" : "离线";
  const ctxPct =
    usage && usage.contextWindow > 0 ? Math.min(100, Math.round((usage.contextTokens / usage.contextWindow) * 100)) : null;

  return (
    <Box flexDirection="column">
      <Static items={blocks}>{(block) => <BlockView key={block.id} block={block} />}</Static>
      <Box flexDirection="column" borderTop paddingTop={1}>
        {toolTrail && (
          <Text color="yellow" dimColor>
            {"  "}
            {toolTrail}
          </Text>
        )}
        {live && <Text>{live}</Text>}
        {busy && (
          <Text dimColor>
            {"  "}⏳ 生成中{queued > 0 ? ` · ${queued} 条排队` : ""} (Ctrl+C 中断)
          </Text>
        )}
        <Text>
          <Text color="cyan" bold>
            ❯{" "}
          </Text>
          {input}
          <Text dimColor>{ghost}</Text>
        </Text>
        <Box marginTop={0}>
          <Text dimColor>
            {client.agentId} · <Text color={statusColor}>{statusLabel}</Text>
            {ctxPct !== null ? ` · ctx ${ctxPct}%` : usage ? ` · ctx ${usage.contextTokens} tok` : ""}
            {usage ? ` · ↑${usage.input} ↓${usage.output} · $${usage.costTotal.toFixed(4)}` : ""}
            {` · /help 命令 · Ctrl+C ${busy ? "中断" : "退出"}`}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
