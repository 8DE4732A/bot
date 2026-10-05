import { memo, useEffect, useRef, useState } from "react";

import { api, chatStream } from "../api";
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
  const logRef = useRef<HTMLDivElement>(null);

  // 初始选中: 路由参数 > 默认 Agent
  useEffect(() => {
    if (agents.length > 0 && !agents.some((a) => a.id === agentId)) {
      setAgentId(initialAgentId && agents.some((a) => a.id === initialAgentId) ? initialAgentId : agents[0].id);
    }
  }, [agents, agentId, initialAgentId]);

  // 切换 Agent 清空本地视图（会话上下文仍在后端，可用「重置」清掉）
  useEffect(() => {
    setMessages([]);
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
      toast("会话上下文已重置");
    } catch (e) {
      toast(`重置失败: ${(e as Error).message}`, "risk");
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
            </div>
          ) : null}
        </div>

        <div className="chat__log" ref={logRef}>
          {messages.length === 0 ? (
            <div style={{ margin: "auto", textAlign: "center", color: "var(--ink-3)" }}>
              <div className="empty__mark" style={{ marginBottom: 8 }}>
                READY
              </div>
              输入消息开始调试{agent ? `「${agent.name}」` : ""}。
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
