import { useEffect, useMemo, useRef, useState } from "react";

import { api, ApiError } from "../api";
import { ConfirmButton, Empty, Field, Icon, Modal, useFormDialog, useAsync, useToast } from "../components/ui";
import type { Agent, Channel, ChannelFieldDescriptor, ChannelTypeDescriptor } from "../types";

const MASK_PREFIX = "••••";

/** 字段分组标题（descriptor.section 驱动，前端不感知具体渠道） */
const SECTION_LABEL: Record<string, string> = {
  basic: "",
  access: "访问控制",
  advanced: "高级",
};

function fieldValue(field: ChannelFieldDescriptor, raw: unknown): string {
  if (raw === undefined || raw === null) {
    if (field.type === "boolean") return "false";
    return "";
  }
  if (field.type === "list") return Array.isArray(raw) ? raw.join(", ") : String(raw);
  if (field.type === "boolean") return raw === true || raw === "true" ? "true" : "false";
  return String(raw);
}

function ChannelForm({
  edit,
  agents,
  types,
  onClose,
  onSaved,
}: {
  edit: Channel | null;
  agents: Agent[];
  types: ChannelTypeDescriptor[];
  onClose: () => void;
  onSaved: (saved: Channel) => void;
}) {
  const toast = useToast();
  const creatable = types.filter((t) => t.creatable || t.type === edit?.type);
  const [id, setId] = useState(edit?.id ?? "");
  const [name, setName] = useState(edit?.name ?? "");
  const [type, setType] = useState<string>(edit?.type ?? creatable[0]?.type ?? "");
  const [boundAgentId, setBoundAgentId] = useState(edit?.boundAgentId ?? agents[0]?.id ?? "");
  const [creds, setCreds] = useState<Record<string, unknown>>(edit?.credentials ?? {});
  const [enabled, setEnabled] = useState(edit?.enabled ?? true);

  const meta = types.find((t) => t.type === type);
  const schema = meta?.credentials ?? [];

  // 元数据异步到达 / 编辑时类型被过滤：补一个可创建类型，避免空下拉
  useEffect(() => {
    if (!type && creatable.length > 0) setType(creatable[0].type);
  }, [type, types.length]);

  const setField = (field: ChannelFieldDescriptor, value: string) =>
    setCreds((cur) => {
      const next = { ...cur };
      if (value === "") {
        delete next[field.key];
        return next;
      }
      if (field.type === "list") {
        next[field.key] = value.split(",").map((v) => v.trim()).filter(Boolean);
      } else if (field.type === "boolean") {
        next[field.key] = value === "true";
      } else {
        next[field.key] = value;
      }
      return next;
    });

  const save = async () => {
    if (!id.trim() || !name.trim() || !boundAgentId || !type) {
      toast("ID、名称、类型与绑定 Agent 均为必填", "risk");
      return;
    }
    try {
      const saved = {
        id: id.trim(),
        name: name.trim(),
        type,
        boundAgentId,
        enabled,
        credentials: creds,
      };
      await api.saveChannel(saved);
      toast(`已保存渠道「${name.trim()}」`);
      onSaved({ ...saved, updatedAt: Date.now() } as Channel);
    } catch (e) {
      toast(`保存失败: ${(e as Error).message}`, "risk");
    }
  };

  let lastSection = "basic";

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
            placeholder={`${type || "channel"}-main`}
          />
        </Field>
        <Field label="类型">
          <select
            className="select"
            value={type}
            onChange={(e) => {
              setType(e.target.value);
              setCreds({});
            }}
            disabled={!!edit}
          >
            {creatable.map((t) => (
              <option key={t.type} value={t.type}>
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
            placeholder={meta?.label ?? "渠道显示名"}
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

      {meta?.description ? (
        <div className="field__hint" style={{ marginBottom: 8 }}>{meta.description}</div>
      ) : null}
      {meta?.credentialHint ? (
        <div className="field__hint" style={{ marginBottom: 8 }}>{meta.credentialHint}</div>
      ) : null}

      {schema.length > 0
        ? schema.map((f) => {
            const section = f.section ?? "basic";
            const showHeading = section !== lastSection && SECTION_LABEL[section];
            lastSection = section;
            const display = fieldValue(f, creds[f.key]);
            return (
              <div key={f.key}>
                {showHeading ? (
                  <div className="eyebrow" style={{ margin: "10px 0 4px" }}>{SECTION_LABEL[section]}</div>
                ) : null}
                <Field
                  label={f.label}
                  hint={
                    f.type === "secret" && display.startsWith(MASK_PREFIX)
                      ? "已配置 (留空则保持不变)"
                      : f.hint
                  }
                >
                  {f.type === "select" ? (
                    <select
                      className="select"
                      value={display}
                      onChange={(e) => setField(f, e.target.value)}
                    >
                      {(f.options ?? []).map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  ) : f.type === "boolean" ? (
                    <select
                      className="select"
                      value={display}
                      onChange={(e) => setField(f, e.target.value)}
                    >
                      <option value="false">否</option>
                      <option value="true">是</option>
                    </select>
                  ) : (
                    <input
                      className="input"
                      type={f.type === "secret" && !display.startsWith(MASK_PREFIX) ? "password" : "text"}
                      value={display}
                      onChange={(e) => setField(f, e.target.value)}
                      placeholder={f.placeholder}
                      spellCheck={false}
                      autoComplete="off"
                    />
                  )}
                </Field>
              </div>
            );
          })
        : meta?.credentialHint ? (
            <Field label="凭据" hint={meta.credentialHint}>
              <div className="field__hint" style={{ padding: "8px 0" }}>
                {meta.credentialHint}
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

/** 通用扫码/认证弹窗: descriptor.auth 驱动（轮询间隔、标题均由后端元数据决定） */
function ChannelAuthModal({
  channel,
  auth,
  onClose,
  onDone,
}: {
  channel: Channel;
  auth: NonNullable<ChannelTypeDescriptor["auth"]>;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [qr, setQr] = useState<{ qrcode: string; qrcodeImgContent?: string; dataUrl?: string } | null>(null);
  const [status, setStatus] = useState<string>("wait");
  const timerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    api
      .startChannelAuth(channel.id)
      .then((r) => {
        if (cancelled) return;
        setQr(r);
        let redirectHost: string | undefined;
        timerRef.current = setInterval(async () => {
          try {
            const s = await api.pollChannelAuth(channel.id, r.qrcode, redirectHost);
            if (s.status === "scaned_but_redirect" && s.redirectHost) redirectHost = s.redirectHost;
            setStatus(s.status);
            if (s.status === "confirmed") {
              clearInterval(timerRef.current);
              toast(`${auth.label}成功，渠道已热重启`);
              onDone();
            } else if (s.status === "expired") {
              clearInterval(timerRef.current);
              setStatus("expired");
            }
          } catch (e) {
            // 4xx 是认证会话失效/渠道被编辑，继续轮询只会永远等待
            if (e instanceof ApiError && (e.status === 400 || e.status === 409)) {
              clearInterval(timerRef.current);
              setStatus("stale");
            }
            // 其他瞬时网络错误忽略，下一轮重试
          }
        }, auth.pollIntervalMs);
      })
      .catch((e) => {
        toast(`认证发起失败: ${(e as Error).message}`, "risk");
      });
    return () => {
      cancelled = true;
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [channel.id]);

  return (
    <Modal title={`${auth.label} · ${channel.name}`} onClose={onClose} foot={<div />}>
      {!qr ? (
        <p>正在请求二维码…</p>
      ) : status === "expired" || status === "stale" ? (
        <p style={{ color: "var(--risk, #b91c1c)" }}>
          {status === "expired"
            ? "二维码已过期，请关闭后重新发起扫码。"
            : "认证会话已失效（渠道被编辑/重启或二维码超时），请关闭后重新发起扫码。"}
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12, alignItems: "center" }}>
          <p>
            请扫码并确认
            {status === "scaned" ? "（已扫码，请在手机上确认…）" : ""}：
          </p>
          {qr.dataUrl ? <img src={qr.dataUrl} alt="扫码二维码" width={220} height={220} /> : null}
          <a
            className="mono field__hint"
            href={qr.qrcodeImgContent || qr.qrcode}
            target="_blank"
            rel="noreferrer"
            style={{ wordBreak: "break-all" }}
          >
            无法扫码？在手机中打开此链接
          </a>
          <div className="field__hint">{auth.hint ?? "确认成功后凭据自动保存，渠道随即热重启。"}</div>
        </div>
      )}
    </Modal>
  );
}

function formatActivity(ts?: number): string | undefined {
  return ts ? new Date(ts).toLocaleString() : undefined;
}

export function ChannelsView() {
  const q = useAsync(() => api.listChannels(), []);
  const agentsQ = useAsync(() => api.listAgents(), []);
  const typesQ = useAsync(() => api.listChannelTypes(), []);
  const toast = useToast();
  const form = useFormDialog<Channel>();
  const [authChannel, setAuthChannel] = useState<{ channel: Channel; auth: NonNullable<ChannelTypeDescriptor["auth"]> } | null>(null);
  const [healthMap, setHealthMap] = useState<
    Record<string, { ok: boolean; detail?: string; lastInboundAt?: number; lastSendAt?: number; checkedAt: number }>
  >({});

  const channels = q.data ?? [];
  const agents = agentsQ.data ?? [];
  const types = typesQ.data ?? [];
  const typeMap = useMemo(() => new Map(types.map((t) => [t.type, t])), [types]);

  useEffect(() => {
    const onEvent = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.type === "channel.health") {
        setHealthMap((m) => ({
          ...m,
          [detail.channelId]: {
            ok: Boolean(detail.ok),
            detail: detail.detail,
            lastInboundAt: detail.lastInboundAt,
            lastSendAt: detail.lastSendAt,
            checkedAt: detail.checkedAt,
          },
        }));
      } else if (detail?.type === "channel.status") {
        q.reload();
      }
    };
    window.addEventListener("bot:event", onEvent);
    return () => window.removeEventListener("bot:event", onEvent);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const checkHealth = async (c: Channel) => {
    try {
      const health = await api.channelHealth(c.id);
      const inbound = formatActivity(health.lastInboundAt);
      const sent = formatActivity(health.lastSendAt);
      const activity = [inbound ? `最后入站 ${inbound}` : null, sent ? `最后发送 ${sent}` : null]
        .filter(Boolean)
        .join(" · ");
      toast(
        health.ok
          ? `「${c.name}」连接正常${health.detail ? `: ${health.detail}` : ""}${activity ? ` · ${activity}` : ""}`
          : `「${c.name}」异常: ${health.detail ?? "unknown"}`,
        health.ok ? undefined : "risk",
      );
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
            渠道实例与 Agent 解耦绑定：同一渠道类型的多个实例可分别对接不同 Agent。类型、凭据字段与
            认证方式均由后端注册表下发，新增渠道无需改动管理台。
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
          desc="终端渠道 terminal-main 会在首次启动时自动创建；也可以在此新增渠道并绑定 Agent。"
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
                <th style={{ width: 300 }}></th>
              </tr>
            </thead>
            <tbody>
              {channels.map((c) => {
                const agent = agents.find((a) => a.id === c.boundAgentId);
                const meta = typeMap.get(c.type);
                return (
                  <tr key={c.id}>
                    <td>
                      <div className="cell-main">{c.name}</div>
                      <div className="cell-sub mono mono--plain">{c.id}</div>
                    </td>
                    <td>
                      <span className="mono">{meta?.label ?? c.type}</span>
                    </td>
                    <td>
                      <div style={{ display: "flex", flexDirection: "column", gap: 3, alignItems: "flex-start" }}>
                        {c.enabled ? (
                          <span className="badge badge--ink">
                            <span className="dot" /> 已启用
                          </span>
                        ) : (
                          <span className="badge">已停用</span>
                        )}
                        {c.enabled ? (
                          (() => {
                            const h = healthMap[c.id];
                            if (!h) return <span className="field__hint">连接态探测中…</span>;
                            const activity = formatActivity(h.lastInboundAt) ?? formatActivity(h.lastSendAt);
                            return h.ok ? (
                              <span className="badge badge--live" title={activity ? `最近活动 ${activity}` : undefined}>
                                <span className="dot" /> 已连接
                              </span>
                            ) : (
                              <span className="badge badge--warn" title={h.detail}>连接异常</span>
                            );
                          })()
                        ) : null}
                      </div>
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
                        {meta?.auth ? (
                          <button
                            className="btn btn--secondary btn--sm"
                            onClick={() => setAuthChannel({ channel: c, auth: meta.auth! })}
                          >
                            {meta.auth.label}
                          </button>
                        ) : null}
                        {meta?.managedBy !== "cli" ? (
                          <button className="btn btn--ghost btn--sm" onClick={() => checkHealth(c)}>
                            健康
                          </button>
                        ) : null}
                        <button className="btn btn--secondary btn--sm" onClick={() => form.open(c)}>
                          <Icon name="pencil" size={13} /> 配置
                        </button>
                        {meta?.deletable !== false ? (
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
          types={types}
          onClose={form.close}
          onSaved={(saved) => {
            form.close();
            q.reload();
            const meta = typeMap.get(saved.type);
            if (!meta?.auth || !saved.enabled) return;
            const missing = (meta.auth.readyFields ?? []).some((key) => {
              const value = saved.credentials?.[key];
              return value === undefined || value === null || String(value).trim() === "";
            });
            // 新建微信等「认证型」渠道后直接拉起二维码，不要求用户再找按钮
            if (missing) setAuthChannel({ channel: saved, auth: meta.auth });
          }}
        />
      )}

      {authChannel ? (
        <ChannelAuthModal
          channel={authChannel.channel}
          auth={authChannel.auth}
          onClose={() => setAuthChannel(null)}
          onDone={() => {
            setAuthChannel(null);
            q.reload();
          }}
        />
      ) : null}
    </div>
  );
}
