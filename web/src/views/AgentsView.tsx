import { useMemo, useState } from "react";

import { api } from "../api";
import {
  ConfirmButton,
  Empty,
  Field,
  Icon,
  KindBadge,
  Modal,
  TagInput,
  useFormDialog,
  initials,
  useAsync,
  useToast,
} from "../components/ui";
import { navigate } from "../App";
import { defaultSandbox } from "@bot-core/config/sandbox-defaults";
import type { Agent, SandboxConfig, Skill } from "../types";

/* ---------------- Agent 编辑表单 ---------------- */
function AgentForm({
  edit,
  providers,
  skills,
  onClose,
  onSaved,
}: {
  edit: Agent | null;
  providers: { id: string; name: string; models: string[] }[];
  skills: Skill[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [id, setId] = useState(edit?.id ?? "");
  const [name, setName] = useState(edit?.name ?? "");
  const [desc, setDesc] = useState(edit?.description ?? "");
  const [providerId, setProviderId] = useState(
    edit?.model.provider || providers[0]?.id || "deepseek",
  );
  const provider = providers.find((p) => p.id === providerId);
  const modelOptions = useMemo(() => {
    const list = provider?.models?.length ? provider.models : ["default"];
    // 已配置的模型即使不在服务商列表里也可保留
    if (edit && edit.model.provider === providerId && !list.includes(edit.model.modelId)) {
      list.unshift(edit.model.modelId);
    }
    return list;
  }, [provider, edit, providerId]);
  const [modelId, setModelId] = useState(edit?.model.modelId || modelOptions[0] || "default");
  const [customModel, setCustomModel] = useState("");
  const useCustom = modelId === "__custom__";
  const [instructions, setInstructions] = useState(
    edit?.instructions ?? "You are a helpful, precise, and proactive AI assistant.",
  );
  const [pickedSkills, setPickedSkills] = useState<string[]>(edit?.skills ?? []);
  const [sandbox, setSandbox] = useState<SandboxConfig>(edit?.sandbox ?? defaultSandbox(""));

  const toggleSkill = (sid: string) =>
    setPickedSkills((cur) => (cur.includes(sid) ? cur.filter((x) => x !== sid) : [...cur, sid]));

  const save = async () => {
    if (!id.trim() || !name.trim()) {
      toast("请填写 Agent ID 与名称", "risk");
      return;
    }
    const finalModel = useCustom ? customModel.trim() : modelId;
    if (!finalModel) {
      toast("请选择或输入模型 ID", "risk");
      return;
    }
    try {
      await api.saveAgent({
        ...(edit ?? {}),
        id: id.trim(),
        name: name.trim(),
        description: desc.trim(),
        model: {
          provider: providerId,
          modelId: finalModel,
          temperature: edit?.model.temperature ?? 0.7,
          thinkingLevel: edit?.model.thinkingLevel ?? "medium",
        },
        instructions,
        workspaceDir: edit?.workspaceDir ?? "",
        sandbox,
        skills: pickedSkills,
      });
      toast(`已保存 Agent「${name.trim()}」`);
      onSaved();
    } catch (e) {
      toast(`保存失败: ${(e as Error).message}`, "risk");
    }
  };

  return (
    <Modal
      title={edit ? `编辑 Agent · ${edit.name}` : "新建 Agent"}
      onClose={onClose}
      foot={
        <>
          <div />
          <div className="modal__foot-group">
            <button className="btn btn--secondary" onClick={onClose}>
              取消
            </button>
            <button className="btn btn--primary" onClick={save}>
              保存 Agent
            </button>
          </div>
        </>
      }
    >
      <div className="form-row">
        <Field label="Agent ID" hint="英数标识，创建后不可修改">
          <input
            className="input"
            value={id}
            onChange={(e) => setId(e.target.value)}
            disabled={!!edit}
            placeholder="dev-assistant"
          />
        </Field>
        <Field label="名称">
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="研发效能助手"
          />
        </Field>
      </div>

      <Field label="职责描述" hint="说明该 Agent 的业务场景与分工（显示在卡片上）">
        <input
          className="input"
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          placeholder="面向内部研发的代码与检索助手"
        />
      </Field>

      <div className="form-row">
        <Field label="模型服务商">
          <select
            className="select"
            value={providerId}
            onChange={(e) => {
              setProviderId(e.target.value);
              const p = providers.find((x) => x.id === e.target.value);
              setModelId(p?.models?.[0] || "default");
            }}
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.id})
              </option>
            ))}
          </select>
        </Field>
        <Field label="模型 ID">
          <select
            className="select"
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
          >
            {modelOptions.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
            <option value="__custom__">+ 手动输入模型 ID…</option>
          </select>
          {useCustom ? (
            <input
              className="input"
              style={{ marginTop: 6 }}
              value={customModel}
              onChange={(e) => setCustomModel(e.target.value)}
              placeholder="模型 ID，如 deepseek-chat"
            />
          ) : null}
        </Field>
      </div>

      <Field label="系统提示词 (Persona / Instructions)">
        <textarea
          className="textarea textarea--ui"
          rows={4}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
        />
      </Field>

      <Field label={`技能选配 · 已选 ${pickedSkills.length} 项`} hint="TOOL = 工具扩展 · DOC = 文档型技能 (SKILL.md) · MCP = MCP 服务工具集">
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {skills.map((s) => (
            <div
              key={s.id}
              className={`skill-row${pickedSkills.includes(s.id) ? " is-on" : ""}`}
              onClick={() => toggleSkill(s.id)}
              role="checkbox"
              aria-checked={pickedSkills.includes(s.id)}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === " " || e.key === "Enter") {
                  e.preventDefault();
                  toggleSkill(s.id);
                }
              }}
            >
              <span className="skill-row__check">
                {pickedSkills.includes(s.id) ? <Icon name="check" size={11} /> : null}
              </span>
              <span style={{ minWidth: 0, flex: 1 }}>
                <span className="skill-row__name">
                  {s.name}
                  <span className="mono mono--plain">{s.id}</span>
                </span>
                <span className="skill-row__desc" style={{ display: "block" }}>
                  {s.description}
                </span>
              </span>
              <KindBadge kind={s.kind} />
            </div>
          ))}
        </div>
      </Field>

      <Field label="安全沙盒">
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 10,
            border: "1px solid var(--line)",
            borderRadius: "var(--radius-m)",
            padding: "12px 14px",
          }}
        >
          <label className="toggle">
            <input
              type="checkbox"
              className="toggle__input"
              checked={sandbox.enabled}
              onChange={(e) => setSandbox({ ...sandbox, enabled: e.target.checked })}
            />
            <span className="toggle__track" />
            <span style={{ fontSize: "0.85rem" }}>
              启用沙盒（OS 内核级 ASRT + 路径边界校验）
            </span>
          </label>

          <Field label="出网域名白名单" hint="回车添加，支持通配符（*.example.com）">
            <TagInput
              value={sandbox.network.allowedDomains}
              onChange={(v) =>
                setSandbox({
                  ...sandbox,
                  network: { ...sandbox.network, allowedDomains: v },
                })
              }
              placeholder="github.com"
              suggestions={[
                "github.com",
                "*.github.com",
                "registry.npmjs.org",
                "*.npmjs.org",
                "api.deepseek.com",
                "api.siliconflow.cn",
              ]}
            />
          </Field>
          <div className="form-row">
            <Field label="禁止读取路径" hint="回车添加，支持通配符；裸文件名对任意深度生效">
              <TagInput
                value={sandbox.filesystem.denyRead}
                onChange={(v) =>
                  setSandbox({
                    ...sandbox,
                    filesystem: { ...sandbox.filesystem, denyRead: v },
                  })
                }
                placeholder="~/.ssh"
                suggestions={[".env*", "~/.ssh", "~/.aws", "~/.gnupg"]}
              />
            </Field>
            <Field label="禁止写入路径" hint="回车添加，支持通配符">
              <TagInput
                value={sandbox.filesystem.denyWrite}
                onChange={(v) =>
                  setSandbox({
                    ...sandbox,
                    filesystem: { ...sandbox.filesystem, denyWrite: v },
                  })
                }
                placeholder=".git"
                suggestions={[".git", "*.pem", "*.key"]}
              />
            </Field>
          </div>
          <Field label="允许写入路径" hint="回车添加；. 表示当前工作区，/tmp 通常需要保留">
            <TagInput
              value={sandbox.filesystem.allowWrite}
              onChange={(v) =>
                setSandbox({
                  ...sandbox,
                  filesystem: { ...sandbox.filesystem, allowWrite: v },
                })
              }
              placeholder="."
              suggestions={[".", "/tmp"]}
            />
          </Field>
        </div>
      </Field>
    </Modal>
  );
}

/* ---------------- Agent 列表视图 ---------------- */
export function AgentsView() {
  const agentsQ = useAsync(() => api.listAgents(), []);
  const skillsQ = useAsync(() => api.listSkills(), []);
  const providersQ = useAsync(() => api.listProviders(), []);
  const toast = useToast();
  const form = useFormDialog<Agent>();

  const agents = agentsQ.data ?? [];
  const skills = skillsQ.data ?? [];
  const providers = providersQ.data ?? [];

  const remove = async (a: Agent) => {
    try {
      await api.deleteAgent(a.id);
      toast(`已删除 Agent「${a.name}」`);
      agentsQ.reload();
    } catch (e) {
      toast(`删除失败: ${(e as Error).message}`, "risk");
    }
  };

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <div className="eyebrow">Agents</div>
          <h1 className="page__title">Agent 管理</h1>
          <p className="page__desc">
            每个 Agent 拥有独立的模型、提示词、工作区、技能与沙盒规则，渠道实例可将消息路由到任意一个。
          </p>
        </div>
        <div className="page__actions">
          <button className="btn btn--primary" onClick={() => form.open()}>
            <Icon name="plus" /> 新建 Agent
          </button>
        </div>
      </div>

      {agentsQ.error ? (
        <Empty mark="ERROR" title="加载失败" desc={agentsQ.error} />
      ) : agents.length === 0 && !agentsQ.loading ? (
        <Empty
          mark="NO AGENTS"
          title="还没有 Agent"
          desc="新建一个 Agent，为它选择模型、配置人格与技能，然后通过终端或 Web 渠道对话。"
          action={
            <button className="btn btn--primary" onClick={() => form.open()}>
              <Icon name="plus" /> 新建 Agent
            </button>
          }
        />
      ) : (
        <div className="grid">
          {agents.map((a) => {
            const provName = providers.find((p) => p.id === a.model.provider)?.name ?? a.model.provider;
            const rail = a.sandbox.enabled ? "live" : "warn";
            return (
              <div key={a.id} className={`card card--rail ${rail}`}>
                <div className="card__head">
                  <div className="card__ident">{initials(a.name)}</div>
                  <div className="card__title-wrap">
                    <div className="card__title">
                      {a.name}
                      <span className="mono mono--plain">{a.id}</span>
                    </div>
                    <div className="card__sub mono mono--plain" title={a.workspaceDir}>
                      {a.workspaceDir ? a.workspaceDir.split("/").slice(-2).join("/") : ""}
                    </div>
                  </div>
                </div>

                <div className="card__body">{a.description || "（未填写职责描述）"}</div>

                <div className="meta-list">
                  <div className="meta-row">
                    <span className="meta-label">模型</span>
                    <span className="meta-val">
                      <span className="mono">{provName}</span>
                      <span className="mono">{a.model.modelId}</span>
                    </span>
                  </div>
                  <div className="meta-row">
                    <span className="meta-label">沙盒</span>
                    <span className="meta-val">
                      {a.sandbox.enabled ? (
                        <span className="badge badge--live">
                          <span className="dot" /> 开启
                        </span>
                      ) : (
                        <span className="badge badge--warn">关闭</span>
                      )}
                    </span>
                  </div>
                  <div className="meta-row">
                    <span className="meta-label">技能</span>
                    <span className="meta-val">
                      {a.skills.length > 0
                        ? a.skills.map((s) => <span key={s} className="mono mono--plain">{s}</span>)
                        : "—"}
                    </span>
                  </div>
                </div>

                <div className="card__foot">
                  <button
                    className="btn btn--ghost btn--sm"
                    onClick={() => navigate(`/chat/${encodeURIComponent(a.id)}`)}
                  >
                    <Icon name="message" size={13} /> 对话
                  </button>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button className="btn btn--secondary btn--sm" onClick={() => form.open(a)}>
                      <Icon name="pencil" size={13} /> 配置
                    </button>
                    {a.id !== "agent-default" ? (
                      <ConfirmButton onConfirm={() => remove(a)} />
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {form.value !== null && (
        <AgentForm
          edit={form.value === "new" ? null : form.value}
          providers={providers.map((p) => ({ id: p.id, name: p.name, models: p.models }))}
          skills={skills}
          onClose={form.close}
          onSaved={() => {
            form.close();
            agentsQ.reload();
          }}
        />
      )}
    </div>
  );
}
