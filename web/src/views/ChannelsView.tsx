import { useState } from "react";

import { api } from "../api";
import { ConfirmButton, Empty, Field, Icon, Modal, useFormDialog, useAsync, useToast } from "../components/ui";
import type { Agent, Channel } from "../types";

const CHANNEL_TYPES: { value: Channel["type"]; label: string; note: string }[] = [
  { value: "terminal", label: "终端交互 (Terminal)", note: "本地 REPL" },
  { value: "wecom", label: "企业微信机器人 (WeCom)", note: "二期接入" },
  { value: "weixin", label: "微信个人号 (Weixin)", note: "二期接入" },
  { value: "qq", label: "QQ 机器人 (QQ Bot)", note: "二期接入" },
];

function ChannelForm({
  edit,
  agents,
  onClose,
  onSaved,
}: {
  edit: Channel | null;
  agents: Agent[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [id, setId] = useState(edit?.id ?? "");
  const [name, setName] = useState(edit?.name ?? "");
  const [type, setType] = useState<Channel["type"]>(edit?.type ?? "wecom");
  const [boundAgentId, setBoundAgentId] = useState(edit?.boundAgentId ?? agents[0]?.id ?? "");
  const [creds, setCreds] = useState(edit ? JSON.stringify(edit.credentials ?? {}, null, 2) : "{}");
  const [enabled, setEnabled] = useState(edit?.enabled ?? true);

  const save = async () => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(creds || "{}");
    } catch {
      toast("凭证不是合法 JSON", "risk");
      return;
    }
    if (!id.trim() || !name.trim() || !boundAgentId) {
      toast("ID、名称与绑定 Agent 均为必填", "risk");
      return;
    }
    try {
      await api.saveChannel({
        id: id.trim(),
        name: name.trim(),
        type,
        boundAgentId,
        enabled,
        credentials: parsed,
      });
      toast(`已保存渠道「${name.trim()}」`);
      onSaved();
    } catch (e) {
      toast(`保存失败: ${(e as Error).message}`, "risk");
    }
  };

  return (
    <Modal
      title={edit ? `编辑渠道 · ${edit.name}` : "新增渠道实例"}
      onClose={onClose}
      foot={
        <>
          <div />
          <div className="modal__foot-group">
            <button className="btn btn--secondary" onClick={onClose}>
              取消
            </button>
            <button className="btn btn--primary" onClick={save}>
              保存渠道
            </button>
          </div>
        </>
      }
    >
      <div className="form-row">
        <Field label="渠道 ID" hint="英文标识，创建后不可修改">
          <input
            className="input"
            value={id}
            onChange={(e) => setId(e.target.value)}
            disabled={!!edit}
            placeholder="wecom-bot-hr"
          />
        </Field>
        <Field label="类型">
          <select
            className="select"
            value={type}
            onChange={(e) => setType(e.target.value as Channel["type"])}
          >
            {CHANNEL_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="form-row">
        <Field label="渠道名称">
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="HR 支持机器人"
          />
        </Field>
        <Field label="绑定的 Agent" hint="该渠道收到的消息将路由至此 Agent">
          <select
            className="select"
            value={boundAgentId}
            onChange={(e) => setBoundAgentId(e.target.value)}
          >
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.id})
              </option>
            ))}
          </select>
        </Field>
      </div>

      <Field label="渠道凭证 (JSON)" hint="由对应渠道适配器解读，如 {&quot;botId&quot;: …, &quot;secret&quot;: …}">
        <textarea
          className="textarea"
          rows={4}
          value={creds}
          onChange={(e) => setCreds(e.target.value)}
          spellCheck={false}
        />
      </Field>

      <label className="toggle" style={{ marginTop: 4 }}>
        <input
          type="checkbox"
          className="toggle__input"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        <span className="toggle__track" />
        <span style={{ fontSize: "0.85rem" }}>启用该渠道</span>
      </label>
    </Modal>
  );
}

export function ChannelsView() {
  const q = useAsync(() => api.listChannels(), []);
  const agentsQ = useAsync(() => api.listAgents(), []);
  const toast = useToast();
  const form = useFormDialog<Channel>();

  const channels = q.data ?? [];
  const agents = agentsQ.data ?? [];

  const remove = async (c: Channel) => {
    try {
      await api.deleteChannel(c.id);
      toast(`已删除渠道「${c.name}」`);
      q.reload();
    } catch (e) {
      toast(`删除失败: ${(e as Error).message}`, "risk");
    }
  };

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <div className="eyebrow">Channels</div>
          <h1 className="page__title">对话渠道</h1>
          <p className="page__desc">
            渠道实例与 Agent 解耦绑定：同一渠道类型的多个实例（如两个企微机器人）可分别对接不同 Agent。
          </p>
        </div>
        <div className="page__actions">
          <button className="btn btn--primary" onClick={() => form.open()}>
            <Icon name="plus" /> 新增渠道
          </button>
        </div>
      </div>

      {q.error ? (
        <Empty mark="ERROR" title="加载失败" desc={q.error} />
      ) : channels.length === 0 && !q.loading ? (
        <Empty
          mark="NO CHANNELS"
          title="没有渠道实例"
          desc="终端渠道 terminal-main 会在首次启动时自动创建；也可以在此新增企微 / 微信 / QQ 渠道占位并绑定 Agent。"
          action={
            <button className="btn btn--primary" onClick={() => form.open()}>
              <Icon name="plus" /> 新增渠道
            </button>
          }
        />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>渠道实例</th>
                <th>类型</th>
                <th>状态</th>
                <th>绑定 Agent</th>
                <th style={{ width: 180 }}></th>
              </tr>
            </thead>
            <tbody>
              {channels.map((c) => {
                const agent = agents.find((a) => a.id === c.boundAgentId);
                return (
                  <tr key={c.id}>
                    <td>
                      <div className="cell-main">{c.name}</div>
                      <div className="cell-sub mono mono--plain">{c.id}</div>
                    </td>
                    <td>
                      <span className="mono">{c.type}</span>
                    </td>
                    <td>
                      {c.enabled ? (
                        <span className="badge badge--live">
                          <span className="dot" /> 在线
                        </span>
                      ) : (
                        <span className="badge">已停用</span>
                      )}
                    </td>
                    <td>
                      {agent ? (
                        <span className="badge badge--ink">{agent.name}</span>
                      ) : (
                        <span className="badge badge--risk">未绑定</span>
                      )}
                    </td>
                    <td>
                      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                        <button
                          className="btn btn--secondary btn--sm"
                          onClick={() => form.open(c)}
                        >
                          <Icon name="pencil" size={13} /> 配置
                        </button>
                        {c.id !== "terminal-main" ? (
                          <ConfirmButton onConfirm={() => remove(c)} />
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {form.value !== null && (
        <ChannelForm
          edit={form.value === "new" ? null : form.value}
          agents={agents}
          onClose={form.close}
          onSaved={() => {
            form.close();
            q.reload();
          }}
        />
      )}
    </div>
  );
}
