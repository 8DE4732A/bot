import { memo, useEffect, useRef, useState } from "react";

import { api, chatStream, isGatewayEvent } from "../api";
import { Icon, useAsync, useToast } from "../components/ui";
import type { Agent, ChatChunk } from "../types";

interface ToolTrace {
  name: string;
  status: string;
}

interface MsgItem {
  role: "user" | "agent";
  text: string;
  tools: ToolTrace[];
  error?: boolean;
  streaming?: boolean;
}

interface UsageInfo {
  contextTokens: number;
  contextWindow: number;
  input: number;
  output: number;
  costTotal: number;
  durationMs: number;
  cacheHitRate?: number;
}

/** 消息行: memo 化, 流式期间只有最后一条变化时才重渲染它自己 */
const MsgRow = memo(function MsgRow({ m, agentName }: { m: MsgItem; agentName: string }) {
  return (
    <div className={`msg msg--${m.role}`}>
      <div className="msg__who">{m.role === "user" ? "我" : agentName.slice(0, 2)}</div>
      <div className="msg__col">
        {m.tools.map((t, j) => (
          <span key={j} className="tool-line">
            {t.status !== "done" && t.status !== "success" ? (
              <span className="t-spin" />
            ) : (
              <Icon name="check" size={10} />
            )}
            {t.name} · {t.status}
          </span>
        ))}
        {m.text ? (
          <div className={`msg__text${m.error ? " is-error" : ""}`}>{m.text}</div>
        ) : m.streaming ? (
          <div className="msg__text" style={{ color: "var(--ink-3)" }}>
            思考中…
          </div>
        ) : null}
        {m.streaming && m.text ? (
          <span className="dot" style={{ alignSelf: "flex-start" }} />
        ) : null}
      </div>
    </div>
  );
});

export function ChatView({ initialAgentId }: { initialAgentId?: string }) {
  const agentsQ = useAsync(() => api.listAgents(), []);
  const toast = useToast();
  const agents = agentsQ.data ?? [];

  const [agentId, setAgentId] = useState<string>(initialAgentId ?? "");
  const [messages, setMessages] = useState<MsgItem[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [usage, setUsage] = useState<UsageInfo | null>(null);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  // 初始选中: 路由参数 > 默认 Agent
  useEffect(() => {
    if (agents.length > 0 && !agents.some((a) => a.id === agentId)) {
      setAgentId(initialAgentId && agents.some((a) => a.id === initialAgentId) ? initialAgentId : agents[0].id);
    }
  }, [agents, agentId, initialAgentId]);

  // 切换 Agent: 清空本地视图并加载历史快照 (只读 conversation view,
  // 刷新不再丢上下文——四期 §6.2 #2)
  useEffect(() => {
    setMessages([]);
    setUsage(null);
    setHistoryLoaded(false);
    if (!agentId) return;
    let alive = true;
    (async () => {
      try {
        // 显式会话查找 (R1 评审 B6/B14: 后端按哨兵行/真实渠道行同一语义查,
        // 前端不再猜 peerId 字符串——旧写法 peerId 恒不匹配, 历史从未加载过)
        const row = await api.findSession(agentId, `web-playground:${agentId}`);
        if (!alive) return;
        if (row) {
          const hist = await api.sessionHistory(row.conversationId);
          if (!alive) return;
          if (hist.messages.length > 0) {
            setMessages(
              hist.messages.slice(-40).map((m) => ({
                role: m.role === "user" ? ("user" as const) : ("agent" as const),
                text: m.text,
                tools: [],
              })),
            );
          }
        }
      } catch {
        /* 历史加载失败不阻断输入 */
      } finally {
        if (alive) setHistoryLoaded(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [agentId]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [messages]);

  const agent: Agent | undefined = agents.find((a) => a.id === agentId);
  const agentName = agent?.name ?? "AI";

  /** 不可变地更新最后一条 agent 消息 */
  const updateLastAgentMsg = (fn: (m: MsgItem) => void) =>
    setMessages((cur) => {
      const last = cur[cur.length - 1];
      if (last?.role !== "agent") return cur;
      const copy: MsgItem = { ...last, tools: [...last.tools] };
      fn(copy);
      return [...cur.slice(0, -1), copy];
    });

  const send = async () => {
    const text = input.trim();
    if (!text || !agentId || sending) return;
    setInput("");
    setSending(true);
    setMessages((cur) => [
      ...cur,
      { role: "user", text, tools: [] },
      { role: "agent", text: "", tools: [], streaming: true },
    ]);

    try {
      // sessionId 不传, 由后端统一为 web-playground:<agentId> (与重置一致)
      await chatStream(agentId, undefined, text, (chunk: ChatChunk) => {
        if (chunk.usage) setUsage(chunk.usage);
        // /agent <id> 视图切换 (R2 评审 B7: 切换下一条消息的发送目标);
        // 同帧 delta 仍入气泡 (R3 评审 M-1: 切换命令的回复文本要显示)
        if (chunk.data?.switchTo) {
          setAgentId(chunk.data.switchTo);
        }
        updateLastAgentMsg((m) => {
          if (chunk.delta) m.text += chunk.delta;
          if (chunk.toolCall) {
            const t = chunk.toolCall;
            const existing = m.tools.findIndex((x) => x.name === t.name);
            if (existing >= 0) m.tools[existing] = { name: t.name, status: t.status };
            else m.tools.push({ name: t.name, status: t.status });
          }
          if (chunk.error) {
            m.error = true;
            m.text += chunk.error;
          }
        });
      });
      updateLastAgentMsg((m) => {
        m.streaming = false;
        if (!m.text) m.text = "（无返回内容）";
      });
    } catch (e) {
      updateLastAgentMsg((m) => {
        m.streaming = false;
        m.error = true;
        m.text = `请求失败: ${(e as Error).message}`;
      });
    } finally {
      setSending(false);
    }
  };

  const reset = async () => {
    if (!agentId) return;
    try {
      await api.resetChat(agentId, `web-playground:${agentId}`);
      setMessages([]);
      setUsage(null);
      toast("会话上下文已重置");
    } catch (e) {
      toast(`重置失败: ${(e as Error).message}`, "risk");
    }
  };

  /** 显式取消生成 (四期 §4.1: 取消是显式动作, 断开连接不再中止生成) */
  const cancel = async () => {
    if (!agentId || !sending) return;
    try {
      await api.cancelChat(agentId, `web-playground:${agentId}`);
    } catch {
      /* cancel 竞态可容忍: 流结束由 chatStream 兜底 */
    }
  };

  return (
    <div className="page" style={{ maxWidth: 900 }}>
      <div className="page__head">
        <div>
          <div className="eyebrow">Playground</div>
          <h1 className="page__title">对话调试</h1>
          <p className="page__desc">
            向任意 Agent 发起对话，实时查看流式输出与工具调用轨迹。消息经由与正式渠道相同的沙盒执行链路。
          </p>
        </div>
        <div className="page__actions">
          {sending && (
            <button className="btn btn--danger btn--sm" onClick={cancel}>
              <Icon name="x" size={13} /> 取消生成
            </button>
          )}
          <button className="btn btn--secondary" onClick={reset} disabled={!agentId}>
            <Icon name="refresh" size={13} /> 重置会话
          </button>
        </div>
      </div>

      <div className="chat">
        <div className="chat__bar">
          <div className="chat__bar-left">
            <span className="meta-label">目标 Agent</span>
            <select
              className="select"
              style={{ width: 240, padding: "4px 8px" }}
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
            >
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.id})
                </option>
              ))}
            </select>
          </div>
          {agent ? (
            <div className="chips">
              <span className="mono mono--plain">{agent.model.provider}</span>
              <span className="mono">{agent.model.modelId}</span>
              <span className="mono mono--plain">
                {agent.sandbox.enabled ? "sandbox:on" : "sandbox:off"}
              </span>
              {usage ? (
                <>
                  <span className="mono mono--plain" title={`上下文 ${usage.contextTokens} tokens`}>
                    ctx:{" "}
                    {usage.contextWindow > 0
                      ? `${Math.min(100, Math.round((usage.contextTokens / usage.contextWindow) * 100))}%`
                      : `${usage.contextTokens} tok`}
                  </span>
                  <span className="mono mono--plain" title={`↑${usage.input} ↓${usage.output} · 缓存命中 ${usage.cacheHitRate?.toFixed(0) ?? "—"}%`}>
                    ↑{usage.input} ↓{usage.output}
                  </span>
                  <span className="mono mono--plain" title={`本轮 ${(usage.durationMs / 1000).toFixed(1)}s`}>
                    ${usage.costTotal.toFixed(4)}
                  </span>
                </>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="chat__log" ref={logRef}>
          {messages.length === 0 ? (
            <div style={{ margin: "auto", textAlign: "center", color: "var(--ink-3)" }}>
              <div className="empty__mark" style={{ marginBottom: 8 }}>
                READY
              </div>
              {historyLoaded
                ? `输入消息开始调试${agent ? `「${agent.name}」` : ""}。`
                : "正在加载会话历史…"}
              <br />
              工具调用（沙盒命令执行、网页检索等）会以轨迹行实时显示。
            </div>
          ) : (
            messages.map((m, i) => (
              <MsgRow key={i} m={m} agentName={agentName} />
            ))
          )}
        </div>

        <div className="chat__input">
          <textarea
            value={input}
            placeholder="输入消息…"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            disabled={!agentId}
          />
          <span className="chat__hint">Enter 发送 · Shift+Enter 换行</span>
          <button className="btn btn--primary" onClick={send} disabled={!input.trim() || sending}>
            <Icon name="send" size={13} /> 发送
          </button>
        </div>
      </div>
    </div>
  );
}
