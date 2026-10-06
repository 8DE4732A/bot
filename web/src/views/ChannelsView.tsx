import { useEffect, useRef, useState } from "react";

import { api } from "../api";
import { ConfirmButton, Empty, Field, Icon, Modal, useFormDialog, useAsync, useToast } from "../components/ui";
import type { Agent, Channel } from "../types";

const CHANNEL_TYPES: { value: Channel["type"]; label: string; note: string }[] = [
  { value: "feishu", label: "飞书 (Feishu)", note: "SDK WebSocket 长连接" },
  { value: "wecom", label: "企业微信智能机器人 (WeCom)", note: "SDK 长连接 + 流式回复" },
  { value: "qq", label: "QQ 机器人 (QQ Bot)", note: "官方 Bot API v2" },
  { value: "weixin", label: "微信个人号 (Weixin iLink)", note: "扫码登录, 仅私聊" },
  { value: "telegram", label: "Telegram (基准渠道)", note: "Bot API 长轮询" },
];

/**
 * 渠道凭据字段声明式差异 (设计 §5): label + secret 标志 + placeholder。
 * secret 字段保存空值/掩码值时由后端 unmaskCredentials 还原旧值。
 * 微信无凭据字段 (扫码流程); terminal 无需配置。
 */
const CHANNEL_FORM_SCHEMAS: Record<string, { key: string; label: string; secret?: boolean; placeholder?: string; hint?: string }[]> = {
  feishu: [
    { key: "appId", label: "App ID", placeholder: "cli_xxx" },
    { key: "appSecret", label: "App Secret", secret: true, placeholder: "飞书开放平台应用密钥" },
    { key: "allowFrom", label: "白名单 (可选)", placeholder: "open_id, 另一个 open_id", hint: "逗号分隔的 peer open_id (不可变 id, 勿填昵称); 留空=允许所有会话" },
  ],
  qq: [
    { key: "appId", label: "App ID", placeholder: "QQ 开放平台机器人 AppID" },
    { key: "clientSecret", label: "Client Secret", secret: true, placeholder: "机器人密钥" },
    { key: "sandbox", label: "沙箱环境", placeholder: "true / false (留空=正式)" },
    { key: "allowFrom", label: "白名单 (可选)", placeholder: "openid_1, openid_2", hint: "逗号分隔的 peer openid (不可变 id, 勿填昵称); 留空=允许所有会话" },
  ],
  wecom: [
    { key: "botId", label: "Bot ID", placeholder: "企业微信后台智能机器人的 bot id" },
    { key: "secret", label: "Secret", secret: true, placeholder: "智能机器人 Secret" },
    { key: "welcomeMessage", label: "欢迎语 (可选)", placeholder: "进入会话时自动回复" },
    { key: "allowFrom", label: "白名单 (可选)", placeholder: "userid_1, userid_2", hint: "逗号分隔的 userid (不可变 id, 勿填昵称); 留空=允许所有会话" },
  ],
  weixin: [
    { key: "allowFrom", label: "白名单 (可选)", placeholder: "wxid_1, wxid_2", hint: "逗号分隔的 iLink user id (不可变 id, 勿填昵称); 留空=允许所有会话" },
  ],
  telegram: [
    { key: "botToken", label: "Bot Token", secret: true, placeholder: "123456:ABC-DEF… (@BotFather 获取)" },
    { key: "allowFrom", label: "白名单 (可选)", placeholder: "123456789, 987654321", hint: "逗号分隔的 chat_id (不可变 id, 勿填昵称); 留空=允许所有会话" },
  ],
  terminal: [],
};

const MASK_PREFIX = "••••";

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
  const [type, setType] = useState<Channel["type"]>(edit?.type ?? "feishu");
  const [boundAgentId, setBoundAgentId] = useState(edit?.boundAgentId ?? agents[0]?.id ?? "");
  const [creds, setCreds] = useState<Record<string, unknown>>(edit?.credentials ?? {});
  const [enabled, setEnabled] = useState(edit?.enabled ?? true);

  const schema = CHANNEL_FORM_SCHEMAS[type] ?? [];
  const setField = (key: string, value: string) =>
    setCreds((cur) => {
      const next = { ...cur };
      if (value === "") delete next[key];
      else if (key === "allowFrom")
        next[key] = value.split(",").map((v) => v.trim()).filter(Boolean);
      else next[key] = key === "sandbox" ? value === "true" : value;
      return next;
    });

  const save = async () => {
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
        credentials: creds,
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
            placeholder="feishu-main"
          />
        </Field>
        <Field label="类型">
          <select
            className="select"
            value={type}
            onChange={(e) => {
              setType(e.target.value as Channel["type"]);
              setCreds({});
            }}
            disabled={!!edit}
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
            placeholder="飞书研发群机器人"
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

      {schema.length > 0 ? (
        schema.map((f) => {
          const raw = creds[f.key];
          const value = f.key === "allowFrom" && Array.isArray(raw) ? raw.join(", ") : raw;
          const display = value == null ? "" : typeof value === "string" ? value : String(value);
          return (
            <Field
              key={f.key}
              label={f.label}
              hint={
                f.secret && display.startsWith(MASK_PREFIX)
                  ? "已配置 (留空则保持不变)"
                  : f.hint
              }
            >
              <input
                className="input"
                type={f.secret && !display.startsWith(MASK_PREFIX) ? "password" : "text"}
                value={display}
                onChange={(e) => setField(f.key, e.target.value)}
                placeholder={f.placeholder}
                spellCheck={false}
                autoComplete="off"
              />
            </Field>
          );
        })
      ) : type === "weixin" ? (
        <Field label="凭据" hint="微信 iLink 无手工凭据——保存后通过渠道列表的「扫码登录」完成认证">
          <div className="field__hint" style={{ padding: "8px 0" }}>
            扫码后 bot_token 自动落盘 (0600)
          </div>
        </Field>
      ) : null}

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

/** 微信扫码弹窗: 发起 → 展示二维码链接 → 轮询状态 → confirmed 自动保存并关闭 */
function WeixinQrModal({ channel, onClose, onDone }: { channel: Channel; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [qr, setQr] = useState<{ qrcode: string; qrcodeImgContent: string; dataUrl?: string } | null>(null);
  const [status, setStatus] = useState<string>("wait");
  const timerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    api
      .weixinQrLogin(channel.id)
      .then((r) => {
        if (cancelled) return;
        setQr(r);
        let redirectHost: string | undefined;
        timerRef.current = setInterval(async () => {
          try {
            const s = await api.weixinQrStatus(channel.id, r.qrcode, redirectHost);
            if (s.status === "scaned_but_redirect" && s.redirectHost) redirectHost = s.redirectHost;
            setStatus(s.status);
            if (s.status === "confirmed") {
              clearInterval(timerRef.current);
              toast(`微信登录成功，已绑定账号`);
              onDone();
            } else if (s.status === "expired") {
              clearInterval(timerRef.current);
              setStatus("expired");
            }
          } catch {
            // 轮询瞬时失败忽略
          }
        }, 2_000);
      })
      .catch((e) => {
        toast(`扫码发起失败: ${(e as Error).message}`, "risk");
      });
    return () => {
      cancelled = true;
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [channel.id]);

  return (
    <Modal title={`微信扫码登录 · ${channel.name}`} onClose={onClose} foot={<div />}>
      {!qr ? (
        <p>正在向 iLink 请求二维码…</p>
      ) : status === "expired" ? (
        <p style={{ color: "var(--risk, #b91c1c)" }}>二维码已过期，请关闭后重新发起扫码。</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12, alignItems: "center" }}>
          <p>
            请用微信扫描二维码并确认
            {status === "scaned" ? "（已扫码，请在微信里确认…）" : ""}：
          </p>
          {qr.dataUrl ? (
            <img src={qr.dataUrl} alt="微信扫码二维码" width={220} height={220} />
          ) : null}
          <a className="mono field__hint" href={qr.qrcodeImgContent || qr.qrcode} target="_blank" rel="noreferrer" style={{ wordBreak: "break-all" }}>
            无法扫码？在手机微信中打开此链接
          </a>
          <div className="field__hint">确认成功后凭据自动保存，渠道随即热重启。</div>
        </div>
      )}
    </Modal>
  );
}

export function ChannelsView() {
  const q = useAsync(() => api.listChannels(), []);
  const agentsQ = useAsync(() => api.listAgents(), []);
  const toast = useToast();
  const form = useFormDialog<Channel>();
  const [qrChannel, setQrChannel] = useState<Channel | null>(null);

  const channels = q.data ?? [];
  const agents = agentsQ.data ?? [];

  const checkHealth = async (c: Channel) => {
    try {
      const health = await api.channelHealth(c.id);
      toast(health.ok ? `「${c.name}」连接正常${health.detail ? `: ${health.detail}` : ""}` : `「${c.name}」异常: ${health.detail ?? "unknown"}`, health.ok ? undefined : "risk");
    } catch (e) {
      toast(`健康检查失败: ${(e as Error).message}`, "risk");
    }
  };

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
            渠道实例与 Agent 解耦绑定：同一渠道类型的多个实例可分别对接不同 Agent。四渠道全部官方
            SDK/WS 长连接收发，免公网部署。
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
          desc="终端渠道 terminal-main 会在首次启动时自动创建；也可以在此新增飞书 / 企微 / QQ / 微信 / Telegram 渠道并绑定 Agent。"
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
                <th style={{ width: 280 }}></th>
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
                        {c.type === "weixin" ? (
                          <button className="btn btn--secondary btn--sm" onClick={() => setQrChannel(c)}>
                            扫码登录
                          </button>
                        ) : null}
                        {c.id !== "terminal-main" && c.type !== "terminal" ? (
                          <button className="btn btn--ghost btn--sm" onClick={() => checkHealth(c)}>
                            健康
                          </button>
                        ) : null}
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

      {qrChannel ? (
        <WeixinQrModal
          channel={qrChannel}
          onClose={() => setQrChannel(null)}
          onDone={() => {
            setQrChannel(null);
            q.reload();
          }}
        />
      ) : null}
    </div>
  );
}
