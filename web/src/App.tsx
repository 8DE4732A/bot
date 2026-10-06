import { useCallback, useEffect, useState, type ReactNode } from "react";

import { api } from "./api";
import { Icon, ToastProvider, fmtUptime } from "./components/ui";
import type { SystemStatus } from "./types";
import { AgentsView } from "./views/AgentsView";
import { AuditView } from "./views/AuditView";
import { ChannelsView } from "./views/ChannelsView";
import { ChatView } from "./views/ChatView";
import { McpView } from "./views/McpView";
import { OverviewView } from "./views/OverviewView";
import { ProvidersView } from "./views/ProvidersView";
import { ScheduledTasksView } from "./views/ScheduledTasksView";

/* ---------------- 视图注册表: 新增视图只需在此加一行 ---------------- */

type IconName = Parameters<typeof Icon>[0]["name"];

interface ViewDef {
  view: string;
  label: string;
  icon: IconName;
  render: (ctx: { navigate: (v: string) => void; agentId?: string }) => ReactNode;
}

const VIEWS: ViewDef[] = [
  { view: "overview", label: "概览", icon: "grid", render: ({ navigate }) => <OverviewView onNavigate={navigate} /> },
  { view: "agents", label: "Agent", icon: "users", render: () => <AgentsView /> },
  { view: "providers", label: "模型服务商", icon: "zap", render: () => <ProvidersView /> },
  { view: "channels", label: "对话渠道", icon: "swap", render: () => <ChannelsView /> },
  { view: "mcp", label: "MCP 服务", icon: "plug", render: () => <McpView /> },
  { view: "tasks", label: "定时任务", icon: "clock", render: () => <ScheduledTasksView /> },
  { view: "chat", label: "对话调试", icon: "message", render: ({ agentId }) => <ChatView initialAgentId={agentId} /> },
  { view: "audit", label: "沙盒审计", icon: "shield", render: () => <AuditView /> },
];

const VIEW_IDS = new Set(VIEWS.map((v) => v.view));

/* ---------------- 极简 hash 路由: #/<view>[/<param>] ---------------- */

interface Route {
  view: string;
  agentId?: string;
}

function parseHash(): Route {
  const raw = location.hash.replace(/^#\/?/, "");
  const [view, param] = raw.split("/");
  if (VIEW_IDS.has(view)) {
    return { view, agentId: param ? decodeURIComponent(param) : undefined };
  }
  return { view: "overview" };
}

export function navigate(path: string) {
  location.hash = path;
}

function useRoute(): Route {
  const [route, setRoute] = useState<Route>(parseHash);
  useEffect(() => {
    const onChange = () => setRoute(parseHash());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

/* ---------------- 边栏运行时读数（10s 轮询） ---------------- */
function useRuntime() {
  const [status, setStatus] = useState<SystemStatus | null>(null);

  useEffect(() => {
    let alive = true;
    const poll = () => {
      api
        .status()
        .then((s) => alive && setStatus(s))
        .catch(() => {});
    };
    poll();
    const timer = setInterval(poll, 10000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  return status;
}

function Shell() {
  const route = useRoute();
  const status = useRuntime();

  const goto = useCallback((v: string) => navigate(`/${v}`), []);
  const current = VIEWS.find((v) => v.view === route.view) ?? VIEWS[0];

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar__brand">
          <div className="sidebar__logo" aria-hidden="true">
            ▮
          </div>
          <span className="sidebar__title">Bot 控制台</span>
          <span className="badge badge--ink sidebar__ver">v1</span>
        </div>

        <nav className="sidebar__nav" aria-label="主导航">
          {VIEWS.map((item) => (
            <button
              key={item.view}
              className={`nav-item${current.view === item.view ? " is-active" : ""}`}
              onClick={() => goto(item.view)}
              aria-current={current.view === item.view ? "page" : undefined}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar__runtime">
          <div className="runtime-row">
            <span className="runtime-live">
              <span className="dot" />
              运行中
            </span>
            <span className="rt-val">{status ? fmtUptime(status.uptime) : "—"}</span>
          </div>
          <div className="runtime-row">
            <span>内存</span>
            <span className="rt-val">{status ? `${status.memoryMb} MB` : "—"}</span>
          </div>
          <div className="runtime-row">
            <span>SQLite</span>
            <span className="rt-val">{status ? `${status.stats.agentsCount} agent` : "—"}</span>
          </div>
        </div>
      </aside>

      <main className="main">{current.render({ navigate: goto, agentId: route.agentId })}</main>
    </div>
  );
}

export function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}
