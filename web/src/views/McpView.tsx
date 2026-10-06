import { useState } from "react";

import { api } from "../api";
import { ConfirmButton, Empty, Field, Icon, Modal, TagInput, useFormDialog, useAsync, useToast } from "../components/ui";
import type { McpServer, McpTransport, McpExposure } from "../types";

const KIND_BADGE: Record<string, string> = {
  stdio: "badge",
  http: "badge badge--live",
};


/** 键值对编辑 (MCP env/headers 共用): 行内 key/value 输入 + 添加/删除 */
function PairsField({
  label,
  keyPlaceholder,
  valuePlaceholder,
  pairs,
  onChange,
}: {
  label: string;
  keyPlaceholder: string;
  valuePlaceholder: string;
  pairs: { key: string; value: string }[];
  onChange: (v: { key: string; value: string }[]) => void;
}) {
  const last = pairs[pairs.length - 1];
  const add = () => {
    if (last && last.key.trim() === "" && last.value.trim() === "") return;
    onChange([...pairs, { key: "", value: "" }]);
  };
  const drop = (i: number) => onChange(pairs.filter((_, idx) => idx !== i));
  const update = (i: number, part: "key" | "value", v: string) =>
    onChange(pairs.map((x, idx) => (idx === i ? { ...x, [part]: v } : x)));
  return (
    <Field label={label}>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {pairs.map((p, i) => (
          <div key={i} style={{ display: "flex", gap: 6 }}>
            <input
              className="input mono"
              style={{ flex: 2 }}
              value={p.key}
              placeholder={keyPlaceholder}
              onChange={(e) => update(i, "key", e.target.value)}
            />
            <input
              className="input mono"
              style={{ flex: 3 }}
              value={p.value}
              placeholder={valuePlaceholder}
              onChange={(e) => update(i, "value", e.target.value)}
            />
            <button className="btn btn--ghost btn--sm" onClick={() => drop(i)} aria-label={`删除 ${label} 条目`}>
              <Icon name="x" size={13} />
            </button>
          </div>
        ))}
        <button className="btn btn--ghost btn--sm" style={{ alignSelf: "flex-start" }} onClick={add}>
          <Icon name="plus" size={13} /> 添加
        </button>
      </div>
    </Field>
  );
}

/* ---------------- MCP Server 编辑表单 ---------------- */
function McpServerForm({
  edit,
  onClose,
  onSaved,
}: {
  edit: McpServer | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [id, setId] = useState(edit?.id ?? "");
  const [name, setName] = useState(edit?.name ?? "");
  const [transport, setTransport] = useState<McpTransport>(edit?.transport ?? "stdio");
  const [command, setCommand] = useState(edit?.command ?? "");
  const [args, setArgs] = useState<string[]>(edit?.args ?? []);
  const [envPairs, setEnvPairs] = useState<{ key: string; value: string }[]>(
    Object.entries(edit?.env ?? {}).map(([key, value]) => ({ key, value })),
  );
  const [url, setUrl] = useState(edit?.url ?? "");
  const [headerPairs, setHeaderPairs] = useState<{ key: string; value: string }[]>(
    Object.entries(edit?.headers ?? {}).map(([key, value]) => ({ key, value })),
  );
  const [desc, setDesc] = useState(edit?.description ?? "");
  const [enabled, setEnabled] = useState(edit?.enabled ?? true);
  const [exposure, setExposure] = useState<McpExposure>(edit?.exposure ?? "direct");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  const pairsToObj = (pairs: { key: string; value: string }[]) => {
    const out: Record<string, string> = {};
    for (const { key, value } of pairs) {
      if (key.trim()) out[key.trim()] = value;
    }
    return out;
  };

  const payload = () => ({
    ...(edit ?? {}),
    id: id.trim(),
    name: name.trim(),
    transport,
    command: transport === "stdio" ? command.trim() : undefined,
    args: transport === "stdio" ? args : undefined,
    env: transport === "stdio" ? pairsToObj(envPairs) : undefined,
    url: transport === "http" ? url.trim() : undefined,
    headers: transport === "http" ? pairsToObj(headerPairs) : undefined,
    description: desc.trim() || undefined,
    exposure,
    enabled,
  });

  const test = async () => {
    if (transport === "stdio" && !command.trim()) {
      toast("请先填写启动命令", "risk");
      return;
    }
    if (transport === "http" && !url.trim()) {
      toast("请先填写 URL", "risk");
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const r = await api.testMcpServer(payload());
      setTestResult(
        r.ok
          ? `连接成功 · ${r.toolCount} 个工具: ${(r.tools ?? []).slice(0, 8).join(", ")}${(r.tools ?? []).length > 8 ? " …" : ""}`
          : `连接失败: ${r.error}`,
      );
    } catch (e) {
      setTestResult(`连接失败: ${(e as Error).message}`);
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    if (!id.trim() || !name.trim()) {
      toast("请填写 Server ID 与名称", "risk");
      return;
    }
    if (transport === "stdio" && !command.trim()) {
      toast("stdio 传输需要启动命令", "risk");
      return;
    }
    if (transport === "http" && !url.trim()) {
      toast("http 传输需要 URL", "risk");
      return;
    }
    try {
      await api.saveMcpServer(payload());
      toast(`已保存 MCP 服务「${name.trim()}」`);
      onSaved();
    } catch (e) {
      toast(`保存失败: ${(e as Error).message}`, "risk");
    }
  };

  return (
    <Modal
      title={edit ? `编辑 MCP 服务 · ${edit.name}` : "接入 MCP 服务"}
      onClose={onClose}
      foot={
        <>
          <button className="btn btn--secondary" onClick={test} disabled={testing}>
            <Icon name="refresh" size={13} /> {testing ? "测试中…" : "测试连接"}
          </button>
          <div className="modal__foot-group">
            <button className="btn btn--secondary" onClick={onClose}>
              取消
            </button>
            <button className="btn btn--primary" onClick={save}>
              保存
            </button>
          </div>
        </>
      }
    >
      {testResult ? (
        <div className={`toast${testResult.startsWith("连接成功") ? "" : " toast--risk"}`} style={{ position: "static", marginBottom: 12 }}>
          <span className="toast__dot" />
          {testResult}
        </div>
      ) : null}

      <div className="form-row">
        <Field label="Server ID" hint="工具命名空间 mcp__<id>__<tool>; Agent 据此选配">
          <input className="input mono" value={id} onChange={(e) => setId(e.target.value)} disabled={!!edit} placeholder="filesystem" />
        </Field>
        <Field label="名称">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="文件系统服务" />
        </Field>
      </div>

      <div className="form-row">
        <Field label="传输方式">
          <select className="select" value={transport} onChange={(e) => setTransport(e.target.value as McpTransport)}>
            <option value="stdio">stdio（本地子进程）</option>
            <option value="http">HTTP（远程服务）</option>
          </select>
        </Field>
        <Field label="描述">
          <input className="input" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="给 Agent 看的一句话说明" />
        </Field>
      </div>

      {transport === "stdio" ? (
        <>
          <Field label="启动命令" hint="在宿主进程执行 = 信任边界, 仅限管理员操作; 写入审计">
            <input className="input mono" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" />
          </Field>
          <Field label="命令参数">
            <TagInput value={args} onChange={setArgs} placeholder="-y @modelcontextprotocol/server-filesystem /tmp" />
          </Field>
          <PairsField
            label="环境变量"
            keyPlaceholder="KEY"
            valuePlaceholder="value"
            pairs={envPairs}
            onChange={setEnvPairs}
          />
        </>
      ) : (
        <>
          <Field label="服务 URL" hint="强制 http(s)">
            <input className="input mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" />
          </Field>
          <PairsField
            label="请求头"
            keyPlaceholder="Authorization"
            valuePlaceholder="Bearer ••••"
            pairs={headerPairs}
            onChange={setHeaderPairs}
          />
        </>
      )}

      <div className="form-row">
        <Field label="暴露策略" hint="hidden = 注册但不把工具声明给模型">
          <select className="select" value={exposure} onChange={(e) => setExposure(e.target.value as McpExposure)}>
            <option value="direct">direct（工具声明给模型）</option>
            <option value="hidden">hidden（隐藏工具面）</option>
          </select>
        </Field>
        <Field label="启用">
          <label className="toggle" style={{ width: "fit-content" }}>
            <input type="checkbox" className="toggle__input" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            <span className="toggle__track" />
            <span style={{ fontSize: "0.85rem" }}>启用后 Agent 选配 mcp__{id || "<id>"} 即生效</span>
          </label>
        </Field>
      </div>

      {edit?.toolExposure && Object.keys(edit.toolExposure).length > 0 ? (
        <Field label="Per-tool 暴露覆盖 (toolExposure)" hint="当前生效的规则; 精确名优先于通配模式, 修改请走 API">
          <div className="mono mono--plain" style={{ fontSize: "0.78rem", color: "var(--ink-2, #565860)" }}>
            {Object.entries(edit.toolExposure).map(([k, v]) => `${k} → ${v}`).join(" · ")}
          </div>
        </Field>
      ) : null}
    </Modal>
  );
}

/* ---------------- MCP Server 列表 ---------------- */
export function McpView() {
  const serversQ = useAsync(() => api.listMcpServers(), []);
  const skillsQ = useAsync(() => api.listSkills(), []);
  const toast = useToast();
  const form = useFormDialog<McpServer>();

  const servers = serversQ.data ?? [];
  const skills = skillsQ.data ?? [];

  const remove = async (s: McpServer) => {
    try {
      await api.deleteMcpServer(s.id);
      toast(`已删除 MCP 服务「${s.name}」`);
      serversQ.reload();
      skillsQ.reload();
    } catch (e) {
      toast(`删除失败: ${(e as Error).message}`, "risk");
    }
  };

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <div className="eyebrow">MCP</div>
          <h1 className="page__title">MCP 服务</h1>
          <p className="page__desc">
            Model Context Protocol 服务器的工具经桥接注册为 Agent 技能（命名空间 <span className="mono">mcp__&lt;id&gt;</span>）。
            保存即刻生效——已有会话的下一条消息自动使用新工具面。
          </p>
        </div>
        <div className="page__actions">
          <button className="btn btn--primary" onClick={() => form.open()}>
            <Icon name="plus" /> 接入 MCP 服务
          </button>
        </div>
      </div>

      {serversQ.error ? (
        <Empty mark="ERROR" title="加载失败" desc={serversQ.error} />
      ) : servers.length === 0 && !serversQ.loading ? (
        <Empty
          mark="NO MCP"
          title="尚未接入 MCP 服务"
          desc="接入一个 stdio 或 HTTP MCP server，其工具将作为技能出现，可在 Agent 配置中选配。"
          action={
            <button className="btn btn--primary" onClick={() => form.open()}>
              <Icon name="plus" /> 接入 MCP 服务
            </button>
          }
        />
      ) : (
        <div className="grid">
          {servers.map((s) => {
            const skill = skills.find((x) => x.id === `mcp__${s.id}`);
            const toolCount = skill?.toolCount;
            return (
              <div key={s.id} className={`card card--rail ${s.enabled ? "live" : "warn"}`}>
                <div className="card__head">
                  <div className="card__ident mono mono--plain">M</div>
                  <div className="card__title-wrap">
                    <div className="card__title">
                      {s.name}
                      <span className="mono mono--plain">mcp__{s.id}</span>
                    </div>
                    <div className="card__sub">{s.description || "（未填写描述）"}</div>
                  </div>
                </div>

                <div className="meta-list">
                  <div className="meta-row">
                    <span className="meta-label">传输</span>
                    <span className="meta-val">
                      <span className={`badge ${KIND_BADGE[s.transport]}`}>
                        <span className="mono mono--plain">{s.transport}</span>
                      </span>
                      <span className="mono mono--plain">
                        {s.transport === "stdio" ? [s.command, ...(s.args ?? [])].slice(0, 2).join(" ") : s.url}
                      </span>
                    </span>
                  </div>
                  <div className="meta-row">
                    <span className="meta-label">状态</span>
                    <span className="meta-val">
                      {s.enabled ? (
                        <span className="badge badge--live">
                          <span className="dot" /> 已桥接
                        </span>
                      ) : (
                        <span className="badge badge--warn">已停用</span>
                      )}
                      {toolCount ? <span className="mono mono--plain">{toolCount} 工具</span> : null}
                    </span>
                  </div>
                </div>

                <div className="card__foot">
                  <div />
                  <div style={{ display: "flex", gap: 6 }}>
                    <button className="btn btn--secondary btn--sm" onClick={() => form.open(s)}>
                      <Icon name="pencil" size={13} /> 配置
                    </button>
                    <ConfirmButton onConfirm={() => remove(s)} />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {form.value !== null && (
        <McpServerForm
          edit={form.value === "new" ? null : form.value}
          onClose={form.close}
          onSaved={() => {
            form.close();
            serversQ.reload();
            skillsQ.reload();
          }}
        />
      )}
    </div>
  );
}
