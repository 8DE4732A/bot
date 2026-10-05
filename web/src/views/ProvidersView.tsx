import { useState } from "react";

import { api } from "../api";
import { ConfirmButton, Empty, Field, Icon, Modal, useFormDialog, useAsync, useToast } from "../components/ui";
import type { ModelProtocol, ModelProvider } from "../types";

/* ---------------- 常用服务商模板 ---------------- */
interface Tpl {
  id: string;
  name: string;
  protocol: ModelProtocol;
  apiBase: string;
  apiKey?: string;
  models: string[];
}
const TEMPLATES: Tpl[] = [
  {
    id: "deepseek",
    name: "DeepSeek 官方",
    protocol: "openai-completions",
    apiBase: "https://api.deepseek.com",
    models: ["deepseek-chat", "deepseek-reasoner"],
  },
  {
    id: "siliconflow",
    name: "硅基流动 (SiliconFlow)",
    protocol: "openai-completions",
    apiBase: "https://api.siliconflow.cn/v1",
    models: ["deepseek-ai/DeepSeek-V3", "deepseek-ai/DeepSeek-R1", "Qwen/Qwen2.5-72B-Instruct"],
  },
  {
    id: "openai",
    name: "OpenAI 官方",
    protocol: "openai-responses",
    apiBase: "https://api.openai.com/v1",
    models: ["gpt-4o", "gpt-4o-mini", "o1", "o3-mini"],
  },
  {
    id: "ollama",
    name: "本地 Ollama",
    protocol: "openai-completions",
    apiBase: "http://localhost:11434/v1",
    apiKey: "ollama",
    models: ["llama3.3", "qwen2.5-coder", "deepseek-r1:8b"],
  },
  {
    id: "kimi",
    name: "月之暗面 (Kimi)",
    protocol: "openai-completions",
    apiBase: "https://api.moonshot.cn/v1",
    models: ["moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k"],
  },
];

const PROTOCOLS: { value: ModelProtocol; label: string }[] = [
  { value: "openai-completions", label: "OpenAI 兼容 · /v1/chat/completions（最通用）" },
  { value: "openai-responses", label: "OpenAI Responses · /v1/responses" },
  { value: "anthropic-messages", label: "Anthropic Messages · /v1/messages" },
  { value: "google", label: "Google Gemini · generateContent" },
];

/* ---------------- 服务商表单 ---------------- */
function ProviderForm({
  edit,
  onClose,
  onSaved,
}: {
  edit: ModelProvider | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [id, setId] = useState(edit?.id ?? "");
  const [name, setName] = useState(edit?.name ?? "");
  const [protocol, setProtocol] = useState<ModelProtocol>(edit?.protocol ?? "openai-completions");
  const [apiBase, setApiBase] = useState(edit?.apiBase ?? "");
  // 脱敏: 后端不回传明文 key, 编辑态留空表示保留已存密钥
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState<string[]>(edit?.models ?? []);
  const [manualModel, setManualModel] = useState("");
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<"fetch" | "test" | null>(null);

  const applyTpl = (t: Tpl) => {
    if (!edit) {
      setId(t.id);
      setName(t.name);
    }
    setProtocol(t.protocol);
    setApiBase(t.apiBase);
    if (t.apiKey) setApiKey(t.apiKey);
    setModels(t.models);
  };

  const addManual = () => {
    const v = manualModel.trim();
    if (v && !models.includes(v)) setModels((cur) => [...cur, v]);
    setManualModel("");
  };

  const fetchModels = async () => {
    if (!apiBase.trim()) {
      setFeedback({ ok: false, text: "请先填写 API Base URL" });
      return;
    }
    setBusy("fetch");
    setFeedback({ ok: true, text: "正在请求 /models 端点…" });
    try {
      const res = await api.fetchRemoteModels(apiBase.trim(), apiKey.trim(), edit?.id);
      if (res.success && res.models.length > 0) {
        setModels((cur) => Array.from(new Set([...cur, ...res.models])));
        setFeedback({ ok: true, text: `已获取 ${res.models.length} 个模型并合并进列表` });
      } else {
        setFeedback({ ok: false, text: res.error || "端点未返回模型列表，请手工添加" });
      }
    } catch (e) {
      setFeedback({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    const testModel = models[0] || "default";
    setBusy("test");
    setFeedback({ ok: true, text: `正在用 ${testModel} 测试连通性…` });
    try {
      const res = await api.testProvider({
        providerId: id || "custom",
        modelId: testModel,
        apiBase: apiBase.trim(),
        apiKey: apiKey.trim() || undefined,
        protocol,
      });
      setFeedback(
        res.success
          ? { ok: true, text: `连接正常，延迟 ${res.latencyMs}ms` }
          : { ok: false, text: `失败: ${res.error}` },
      );
    } catch (e) {
      setFeedback({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!id.trim() || !name.trim() || !apiBase.trim()) {
      setFeedback({ ok: false, text: "ID、名称与 API Base URL 均为必填" });
      return;
    }
    try {
      await api.saveProvider({
        id: id.trim(),
        name: name.trim(),
        protocol,
        apiBase: apiBase.trim(),
        apiKey: apiKey.trim(),
        models,
        createdAt: edit?.createdAt,
      });
      toast(`已保存服务商「${name.trim()}」`);
      onSaved();
    } catch (e) {
      toast(`保存失败: ${(e as Error).message}`, "risk");
    }
  };

  return (
    <Modal
      title={edit ? `编辑服务商 · ${edit.name}` : "添加模型服务商 (BYOK)"}
      onClose={onClose}
      foot={
        <>
          <button className="btn btn--secondary" onClick={test} disabled={busy !== null}>
            <Icon name="zap" size={13} />
            {busy === "test" ? "测试中…" : "测试连接"}
          </button>
          <div className="modal__foot-group">
            <button className="btn btn--secondary" onClick={onClose}>
              取消
            </button>
            <button className="btn btn--primary" onClick={save}>
              保存服务商
            </button>
          </div>
        </>
      }
    >
      {!edit ? (
        <Field label="常用模板" hint="一键填充端点与协议，再补充你的 API Key 即可">
          <div className="chips" style={{ gap: 6 }}>
            {TEMPLATES.map((t) => (
              <button key={t.id} className="btn btn--secondary btn--sm" onClick={() => applyTpl(t)}>
                {t.name}
              </button>
            ))}
          </div>
        </Field>
      ) : null}

      <div className="form-row">
        <Field label="服务商 ID" hint="英文标识，创建后不可修改">
          <input
            className="input"
            value={id}
            onChange={(e) => setId(e.target.value)}
            disabled={!!edit}
            placeholder="siliconflow"
          />
        </Field>
        <Field label="显示名称">
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="硅基流动"
          />
        </Field>
      </div>

      <Field label="接口协议">
        <select
          className="select"
          value={protocol}
          onChange={(e) => setProtocol(e.target.value as ModelProtocol)}
        >
          {PROTOCOLS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </Field>

      <div className="form-row">
        <Field label="API Base URL">
          <input
            className="input"
            value={apiBase}
            onChange={(e) => setApiBase(e.target.value)}
            placeholder="https://api.siliconflow.cn/v1"
          />
        </Field>
        <Field label="API Key" hint="明文存于本地 SQLite，仅本机可见">
          <input
            className="input"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-…"
            autoComplete="off"
          />
        </Field>
      </div>

      <Field
        label={`模型列表 · ${models.length} 个`}
        hint="Agent 配置页将从这份清单中选择模型 ID"
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 8,
            marginBottom: 6,
          }}
        >
          <div style={{ display: "flex", gap: 6, flex: 1 }}>
            <input
              className="input"
              value={manualModel}
              onChange={(e) => setManualModel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addManual();
                }
              }}
              placeholder="输入模型 ID 回车添加"
            />
            <button className="btn btn--secondary btn--sm" onClick={addManual}>
              添加
            </button>
          </div>
          <button
            className="btn btn--secondary btn--sm"
            onClick={fetchModels}
            disabled={busy !== null}
          >
            <Icon name="search" size={13} />
            {busy === "fetch" ? "探测中…" : "从端点获取"}
          </button>
        </div>
        {models.length > 0 ? (
          <div className="chips">
            {models.map((m) => (
              <span key={m} className="chip">
                {m}
                <button
                  className="chip__x"
                  aria-label={`移除 ${m}`}
                  onClick={() => setModels((cur) => cur.filter((x) => x !== m))}
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        ) : (
          <span className="field__hint">尚无模型，可手动添加或从端点获取</span>
        )}
      </Field>

      {feedback ? (
        <div
          className="field__hint"
          style={{
            color: feedback.ok ? "var(--live-deep)" : "var(--risk)",
            fontWeight: 500,
          }}
        >
          {feedback.ok ? "✓" : "✗"} {feedback.text}
        </div>
      ) : null}
    </Modal>
  );
}

/* ---------------- 服务商列表 ---------------- */
export function ProvidersView() {
  const q = useAsync(() => api.listProviders(), []);
  const toast = useToast();
  const form = useFormDialog<ModelProvider>();

  const providers = q.data ?? [];

  const ping = async (p: ModelProvider) => {
    toast(`正在测试 ${p.name} …`);
    try {
      const res = await api.testProvider({
        providerId: p.id,
        modelId: p.models[0] || "default",
        apiBase: p.apiBase,
        apiKey: undefined,
        protocol: p.protocol,
      });
      if (res.success) toast(`${p.name} 连接正常 · ${res.latencyMs}ms`);
      else toast(`${p.name} 连接失败: ${res.error}`, "risk");
    } catch (e) {
      toast(`请求异常: ${(e as Error).message}`, "risk");
    }
  };

  const remove = async (p: ModelProvider) => {
    try {
      await api.deleteProvider(p.id);
      toast(`已删除服务商「${p.name}」`);
      q.reload();
    } catch (e) {
      toast(`删除失败: ${(e as Error).message}`, "risk");
    }
  };

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <div className="eyebrow">Model Providers</div>
          <h1 className="page__title">模型服务商 (BYOK)</h1>
          <p className="page__desc">
            自带密钥接入任意 OpenAI 兼容 / Anthropic / Gemini 端点，密钥仅保存在本地 SQLite。
          </p>
        </div>
        <div className="page__actions">
          <button className="btn btn--primary" onClick={() => form.open()}>
            <Icon name="plus" /> 添加服务商
          </button>
        </div>
      </div>

      {q.error ? (
        <Empty mark="ERROR" title="加载失败" desc={q.error} />
      ) : providers.length === 0 && !q.loading ? (
        <Empty
          mark="NO PROVIDERS"
          title="尚未配置模型服务商"
          desc="添加 DeepSeek、硅基流动、OpenAI 或本地 Ollama 等端点，填入 API Key 后即可在 Agent 中选用。"
          action={
            <button className="btn btn--primary" onClick={() => form.open()}>
              <Icon name="plus" /> 添加服务商
            </button>
          }
        />
      ) : (
        <div className="grid">
          {providers.map((p) => (
            <div key={p.id} className="card">
              <div className="card__head">
                <div className="card__ident" aria-hidden="true">
                  <Icon name="zap" size={16} />
                </div>
                <div className="card__title-wrap">
                  <div className="card__title">
                    {p.name}
                    <span className="mono mono--plain">{p.id}</span>
                  </div>
                  <div className="card__sub mono mono--plain" title={p.apiBase}>
                    {p.apiBase}
                  </div>
                </div>
              </div>

              <div className="meta-list">
                <div className="meta-row">
                  <span className="meta-label">协议</span>
                  <span className="meta-val">
                    <span className="mono mono--plain">{p.protocol}</span>
                  </span>
                </div>
                <div className="meta-row">
                  <span className="meta-label">密钥</span>
                  <span className="meta-val">
                    {p.apiKey ? (
                      <span className="mono">••••{p.apiKey.slice(-4)}</span>
                    ) : (
                      <span className="badge badge--warn">未配置</span>
                    )}
                  </span>
                </div>
              </div>

              <div>
                <div className="meta-label" style={{ marginBottom: 5 }}>
                  模型 · {p.models.length} 个
                </div>
                <div className="chips">
                  {p.models.length > 0 ? (
                    p.models.slice(0, 8).map((m) => (
                      <span className="mono mono--plain" key={m}>
                        {m}
                      </span>
                    ))
                  ) : (
                    <span className="field__hint">无</span>
                  )}
                  {p.models.length > 8 ? (
                    <span className="field__hint">+{p.models.length - 8} 更多</span>
                  ) : null}
                </div>
              </div>

              <div className="card__foot">
                <button className="btn btn--ghost btn--sm" onClick={() => ping(p)}>
                  <Icon name="zap" size={13} /> 测速
                </button>
                <div style={{ display: "flex", gap: 6 }}>
                  <button className="btn btn--secondary btn--sm" onClick={() => form.open(p)}>
                    <Icon name="pencil" size={13} /> 编辑
                  </button>
                  <ConfirmButton onConfirm={() => remove(p)} />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {form.value !== null && (
        <ProviderForm
          edit={form.value === "new" ? null : form.value}
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
