import { useEffect, useState } from "react";

import { api } from "../api";
import { ConfirmButton, Empty, Field, Icon, Modal, useFormDialog, useAsync, useToast } from "../components/ui";
import type { ModelMetadataCandidate, ModelMetadataRow, ModelProtocol, ModelProvider } from "../types";

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
  const [paramsProvider, setParamsProvider] = useState<ModelProvider | null>(null);

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
                  <button className="btn btn--ghost btn--sm" onClick={() => setParamsProvider(p)}>
                    参数
                  </button>
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

      {paramsProvider && (
        <ModelParamsModal
          provider={paramsProvider}
          onClose={() => setParamsProvider(null)}
          onChanged={() => q.reload()}
        />
      )}
    </div>
  );
}

/* ---------------- 模型参数 ---------------- */

function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

function formatPrice(n: number): string {
  return Number.isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: 4 }) : "—";
}

function sourceLabel(source: string): string {
  if (source === "models.dev") return "自动";
  if (source === "builtin") return "内置";
  if (source === "manual") return "手动";
  if (source === "fallback") return "fallback";
  return "未知";
}

function sourceTone(source: string): string {
  if (source === "manual") return "warn";
  if (source === "models.dev") return "live";
  return "ink";
}

function editorIdFor(modelId: string): string {
  return `model-params-${modelId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function ModelParamsModal(props: {
  provider: ModelProvider;
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [rows, setRows] = useState<ModelMetadataRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<ModelMetadataRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<ModelMetadataCandidate[]>([]);
  const [candidateCatalogReady, setCandidateCatalogReady] = useState<boolean | null>(null);
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  const [candidateQuery, setCandidateQuery] = useState("");
  const [showReference, setShowReference] = useState(false);
  const [applyingReference, setApplyingReference] = useState<string | null>(null);
  const [draft, setDraft] = useState<{
    contextWindow: number;
    maxOutputTokens: number;
    text: boolean;
    image: boolean;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning: boolean;
  } | null>(null);

  const load = async (): Promise<ModelMetadataRow[]> => {
    setLoading(true);
    try {
      const res = await api.listModelMetadata(props.provider.id);
      setRows(res.models);
      return res.models;
    } catch (err) {
      toast(String(err), "risk");
      return [];
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.provider.id]);

  const draftFromRow = (row: ModelMetadataRow) => ({
    contextWindow: row.contextWindow,
    maxOutputTokens: row.maxOutputTokens,
    text: row.inputModalities.includes("text"),
    image: row.inputModalities.includes("image"),
    input: row.cost.input,
    output: row.cost.output,
    cacheRead: row.cost.cacheRead,
    cacheWrite: row.cost.cacheWrite,
    reasoning: row.reasoning,
  });

  const loadCandidates = async (modelId: string) => {
    setCandidates([]);
    setCandidateCatalogReady(null);
    setCandidatesLoading(true);
    try {
      const res = await api.listModelMetadataCandidates(props.provider.id, modelId);
      setCandidates(res.candidates);
      setCandidateCatalogReady(Boolean(res.catalog));
    } catch (err) {
      toast(String(err), "risk");
    } finally {
      setCandidatesLoading(false);
    }
  };

  const openEditor = (row: ModelMetadataRow) => {
    if (editing?.modelId === row.modelId) {
      setEditing(null);
      setDraft(null);
      return;
    }
    setEditing(row);
    setDraft(draftFromRow(row));
    setCandidateQuery("");
    setShowReference(!row.priced || Boolean(row.reference));
    void loadCandidates(row.modelId);
    // 让展开的编辑器进入视野（长列表里点击靠下的行时尤其需要）
    requestAnimationFrame(() => {
      document.getElementById(editorIdFor(row.modelId))?.scrollIntoView({ block: "nearest" });
    });
  };

  const closeEditor = () => {
    setEditing(null);
    setDraft(null);
  };

  const save = async () => {
    if (!editing || !draft) return;
    setSaving(true);
    try {
      await api.saveModelMetadata({
        providerId: props.provider.id,
        modelId: editing.modelId,
        overrides: {
          contextWindow: draft.contextWindow,
          maxOutputTokens: draft.maxOutputTokens,
          inputModalities: (() => {
            const modalities = [
              ...(draft.text ? ["text"] : []),
              ...(draft.image ? ["image"] : []),
            ];
            return modalities.length > 0 ? modalities : ["text"];
          })(),
          reasoning: draft.reasoning,
          cost: {
            input: draft.input,
            output: draft.output,
            cacheRead: draft.cacheRead,
            cacheWrite: draft.cacheWrite,
          },
        },
      });
      toast("模型参数已保存", "ok");
      closeEditor();
      await load();
      props.onChanged();
    } catch (err) {
      toast(String(err), "risk");
    } finally {
      setSaving(false);
    }
  };

  const reset = async (row: ModelMetadataRow) => {
    try {
      await api.saveModelMetadata({ providerId: props.provider.id, modelId: row.modelId, reset: true });
      toast("已恢复自动匹配值", "ok");
      if (editing?.modelId === row.modelId) closeEditor();
      await load();
      props.onChanged();
    } catch (err) {
      toast(String(err), "risk");
    }
  };

  const applyReference = async (candidate: ModelMetadataCandidate) => {
    if (!editing) return;
    const key = `${candidate.providerKey}/${candidate.modelKey}`;
    setApplyingReference(key);
    try {
      await api.saveModelMetadata({
        providerId: props.provider.id,
        modelId: editing.modelId,
        reference: { providerId: candidate.providerKey, modelId: candidate.modelKey },
      });
      toast(`已应用参考价：${candidate.providerName ?? candidate.providerKey}`, "ok");
      const updatedRows = await load();
      const updated = updatedRows.find((row) => row.modelId === editing.modelId);
      if (updated) {
        setEditing(updated);
        setDraft(draftFromRow(updated));
        setShowReference(true);
      }
      props.onChanged();
    } catch (err) {
      toast(String(err), "risk");
    } finally {
      setApplyingReference(null);
    }
  };

  const refresh = async () => {
    setRefreshing(true);
    try {
      const stats = await api.refreshModelMetadata();
      toast(`目录已刷新：匹配 ${stats.matched}，内置 ${stats.builtin}，fallback ${stats.fallback}`, "ok");
      await load();
      props.onChanged();
    } catch (err) {
      toast(String(err), "risk");
    } finally {
      setRefreshing(false);
    }
  };

  const trimmed = query.trim().toLowerCase();
  const filtered = trimmed
    ? rows.filter((row) =>
        [row.modelId, row.displayName, row.matchedProvider, row.matchedModel]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(trimmed)),
      )
    : rows;
  const maxWindow = Math.max(1, ...rows.map((row) => (Number.isFinite(row.contextWindow) ? row.contextWindow : 0)));
  const counts = filtered.reduce(
    (acc, row) => {
      if (row.reference) acc.reference++;
      else if (row.source === "manual") acc.manual++;
      else if (row.source === "models.dev") acc.auto++;
      else if (row.source === "builtin") acc.builtin++;
      else acc.fallback++;
      return acc;
    },
    { auto: 0, builtin: 0, fallback: 0, reference: 0, manual: 0 },
  );
  const candidateFilter = candidateQuery.trim().toLowerCase();
  const visibleCandidates = candidateFilter
    ? candidates.filter((candidate) =>
        [candidate.providerKey, candidate.providerName, candidate.modelKey, candidate.displayName, candidate.canonicalModelId]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(candidateFilter)),
      )
    : candidates;

  return (
    <Modal
      wide
      title={`模型参数 · ${props.provider.name}`}
      onClose={props.onClose}
      foot={
        <div className="page__actions" style={{ width: "100%", justifyContent: "space-between" }}>
          <button className="btn btn--secondary btn--sm" type="button" disabled={refreshing} onClick={() => void refresh()}>
            <Icon name="refresh" size={13} /> {refreshing ? "刷新中…" : "刷新模型目录"}
          </button>
          <button className="btn btn--ghost btn--sm" type="button" onClick={props.onClose}>
            关闭
          </button>
        </div>
      }
    >
      <div className="param-note">自动匹配来自 models.dev 与 pi-ai 内置目录；手动值优先，可随时恢复自动。</div>

      {loading && <Empty mark="…" title="加载模型参数…" />}
      {!loading && rows.length === 0 && <Empty mark="—" title="该服务商还没有模型" desc="先在编辑页添加模型 ID。" />}
      {!loading && rows.length > 0 && (
        <>
          <div className="param-toolbar">
            <div className="search-field">
              <Icon name="search" size={13} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索模型 ID 或匹配名称"
                aria-label="搜索模型"
              />
              {query ? (
                <button type="button" className="search-field__clear" aria-label="清除搜索" onClick={() => setQuery("")}>
                  ✕
                </button>
              ) : null}
            </div>
            <div className="param-counts" aria-live="polite">
              <span className="param-counts__item">
                {trimmed ? `${filtered.length} / ${rows.length} 个模型` : `${rows.length} 个模型`}
              </span>
              {counts.auto > 0 ? <span className="param-counts__item">自动 {counts.auto}</span> : null}
              {counts.builtin > 0 ? <span className="param-counts__item">内置 {counts.builtin}</span> : null}
              {counts.fallback > 0 ? <span className="param-counts__item">fallback {counts.fallback}</span> : null}
              {counts.reference > 0 ? (
                <span className="param-counts__item param-counts__manual">参考 {counts.reference}</span>
              ) : null}
              {counts.manual > 0 ? (
                <span className="param-counts__item param-counts__manual">手动 {counts.manual}</span>
              ) : null}
            </div>
          </div>

          {filtered.length === 0 ? (
            <div className="param-empty">
              <div className="param-empty__title">没有匹配「{query.trim()}」的模型</div>
              <button className="btn btn--secondary btn--sm" type="button" onClick={() => setQuery("")}>
                清除搜索
              </button>
            </div>
          ) : (
            <div className="param-list">
              {filtered.map((row) => {
                const isEditing = editing?.modelId === row.modelId;
                const editorId = editorIdFor(row.modelId);
                const windowPct = row.contextWindow > 0 ? Math.max(3, Math.round((row.contextWindow / maxWindow) * 100)) : 0;
                return (
                  <div key={row.modelId} className={`param-item${isEditing ? " is-open" : ""}`}>
                    <div className="param-item__main">
                      <div className="param-ident">
                        <div className="param-ident__line">
                          <span className="param-ident__id">{row.modelId}</span>
                          <span className={`badge badge--${row.reference ? "warn" : sourceTone(row.source)}`}>
                            {row.reference
                              ? `参考 · ${row.reference.providerName ?? row.reference.providerId}`
                              : sourceLabel(row.source)}
                          </span>
                        </div>
                        {row.displayName && row.displayName !== row.modelId ? (
                          <div className="param-ident__name">{row.displayName}</div>
                        ) : null}
                        {row.matchedProvider ? (
                          <div className="param-ident__match mono mono--plain">
                            {row.matchedProvider}/{row.matchedModel}
                          </div>
                        ) : null}
                      </div>

                      <div className="param-metrics">
                        <div className="param-metric">
                          <span className="param-metric__label">上下文窗口</span>
                          <span className="param-window">
                            <span className={`param-metric__value${row.contextWindow > 0 ? "" : " is-muted"}`}>
                              {row.contextWindow > 0 ? formatCount(row.contextWindow) : "未知"}
                            </span>
                            <span className="param-window__bar" aria-hidden="true">
                              <span className="param-window__fill" style={{ width: `${windowPct}%` }} />
                            </span>
                          </span>
                        </div>
                        <div className="param-metric">
                          <span className="param-metric__label">最大输出</span>
                          <span className="param-metric__value">{formatCount(row.maxOutputTokens)}</span>
                        </div>
                        <div className="param-metric">
                          <span className="param-metric__label">输入模态</span>
                          <span className="param-metric__value">
                            {row.inputModalities.join(" / ") || "text"}
                            {row.reasoning ? <span className="param-metric__tag">reasoning</span> : null}
                          </span>
                        </div>
                        <div className="param-metric">
                          <span className="param-metric__label">价格 · USD/1M</span>
                          <span
                            className={`param-metric__value${row.priced ? "" : " is-muted"}`}
                            title={row.priced ? "输入 / 输出" : "models.dev 未提供价格"}
                          >
                            {row.priced ? `${formatPrice(row.cost.input)} / ${formatPrice(row.cost.output)}` : "未定价"}
                          </span>
                        </div>
                      </div>

                      <div className="param-actions">
                        <button
                          className="btn btn--ghost btn--sm"
                          type="button"
                          aria-expanded={isEditing}
                          aria-controls={editorId}
                          onClick={() => openEditor(row)}
                        >
                          {isEditing ? "收起" : "编辑参数"}
                        </button>
                        <button
                          className="btn btn--ghost btn--sm"
                          type="button"
                          disabled={!row.manual}
                          title={row.manual ? "清除手动覆盖，恢复自动匹配值" : "当前没有手动覆盖"}
                          onClick={() => void reset(row)}
                        >
                          恢复自动
                        </button>
                      </div>
                    </div>

                    {isEditing && draft ? (
                      <div className="param-editor" id={editorId}>
                        <div className="param-editor__head">
                          <div>
                            <div className="param-editor__title">编辑 {row.modelId}</div>
                            <div className="param-editor__sub">手动值覆盖自动匹配，保存后立即生效。</div>
                          </div>
                        </div>

                        <div className="param-editor__grid">
                          <section className="param-group">
                            <div className="param-group__title">能力</div>
                            <div className="param-group__grid">
                              <Field label="上下文窗口" hint="tokens">
                                <input
                                  className="input mono"
                                  type="number"
                                  min={1}
                                  value={draft.contextWindow}
                                  onChange={(e) => setDraft({ ...draft, contextWindow: Number(e.target.value) })}
                                />
                              </Field>
                              <Field label="最大输出" hint="tokens">
                                <input
                                  className="input mono"
                                  type="number"
                                  min={1}
                                  value={draft.maxOutputTokens}
                                  onChange={(e) => setDraft({ ...draft, maxOutputTokens: Number(e.target.value) })}
                                />
                              </Field>
                              <div className="param-group__span">
                                <Field label="输入模态" hint="至少保留 text">
                                  <div className="chips">
                                    <label className="toggle">
                                      <input type="checkbox" className="toggle__input" checked={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.checked })} />
                                      <span className="toggle__track" />
                                      <span className="toggle__label">text</span>
                                    </label>
                                    <label className="toggle">
                                      <input type="checkbox" className="toggle__input" checked={draft.image} onChange={(e) => setDraft({ ...draft, image: e.target.checked })} />
                                      <span className="toggle__track" />
                                      <span className="toggle__label">image</span>
                                    </label>
                                  </div>
                                </Field>
                              </div>
                            </div>
                          </section>

                          <section className="param-group">
                            <div className="param-group__title">价格 · USD / 1M tokens</div>
                            <div className="param-group__grid">
                              <Field label="输入">
                                <input
                                  className="input mono"
                                  type="number"
                                  step="0.0001"
                                  min={0}
                                  value={draft.input}
                                  onChange={(e) => setDraft({ ...draft, input: Number(e.target.value) })}
                                />
                              </Field>
                              <Field label="输出">
                                <input
                                  className="input mono"
                                  type="number"
                                  step="0.0001"
                                  min={0}
                                  value={draft.output}
                                  onChange={(e) => setDraft({ ...draft, output: Number(e.target.value) })}
                                />
                              </Field>
                              <Field label="缓存读">
                                <input
                                  className="input mono"
                                  type="number"
                                  step="0.0001"
                                  min={0}
                                  value={draft.cacheRead}
                                  onChange={(e) => setDraft({ ...draft, cacheRead: Number(e.target.value) })}
                                />
                              </Field>
                              <Field label="缓存写">
                                <input
                                  className="input mono"
                                  type="number"
                                  step="0.0001"
                                  min={0}
                                  value={draft.cacheWrite}
                                  onChange={(e) => setDraft({ ...draft, cacheWrite: Number(e.target.value) })}
                                />
                              </Field>
                            </div>
                            <div className="param-group__hint">四项全为 0 时显示「未定价」。</div>
                          </section>
                        </div>

                        <div className="param-reference">
                          <div className="param-reference__head">
                            <div>
                              <div className="param-group__title">目录参考价</div>
                              <div className="param-reference__sub">
                                {candidatesLoading
                                  ? "加载目录候选…"
                                  : candidateCatalogReady === false
                                    ? "模型目录尚未刷新，先点底部「刷新模型目录」"
                                    : candidates.length > 0
                                      ? `models.dev 有 ${candidates.length} 个供应商提供该模型`
                                      : "models.dev 没有该模型的其它供应商条目"}
                              </div>
                            </div>
                            {candidates.length > 0 ? (
                              <button
                                className="btn btn--ghost btn--sm"
                                type="button"
                                onClick={() => setShowReference((value) => !value)}
                              >
                                {showReference ? "收起列表" : "选择参考"}
                              </button>
                            ) : null}
                          </div>

                          {row.reference ? (
                            <div className="param-reference__current">
                              <span className="badge badge--warn">参考</span>
                              <span className="param-reference__current-name">
                                {row.reference.providerName ?? row.reference.providerId}
                              </span>
                              <span className="mono mono--plain">
                                {row.reference.providerId}/{row.reference.modelId}
                              </span>
                            </div>
                          ) : null}

                          {showReference && candidates.length > 0 ? (
                            <>
                              {candidates.length > 8 ? (
                                <div className="search-field param-reference__search">
                                  <Icon name="search" size={13} />
                                  <input
                                    value={candidateQuery}
                                    onChange={(e) => setCandidateQuery(e.target.value)}
                                    placeholder="搜索供应商 / 模型"
                                    aria-label="搜索目录候选"
                                  />
                                  {candidateQuery ? (
                                    <button
                                      type="button"
                                      className="search-field__clear"
                                      aria-label="清除搜索"
                                      onClick={() => setCandidateQuery("")}
                                    >
                                      ✕
                                    </button>
                                  ) : null}
                                </div>
                              ) : null}
                              <div className="param-reference__list">
                                {visibleCandidates.length === 0 ? (
                                  <div className="param-reference__hint">没有匹配的供应商</div>
                                ) : (
                                  visibleCandidates.map((candidate) => {
                                    const current =
                                      row.reference?.providerId === candidate.providerKey &&
                                      row.reference.modelId === candidate.modelKey;
                                    const key = `${candidate.providerKey}/${candidate.modelKey}`;
                                    return (
                                      <div key={key} className={`param-candidate${current ? " is-current" : ""}`}>
                                        <div className="param-candidate__ident">
                                          <span className="param-candidate__title">
                                            <span className="param-candidate__provider">
                                              {candidate.providerName ?? candidate.providerKey}
                                            </span>
                                            <span
                                              className={`badge badge--${candidate.match === "exact" ? "live" : "ink"}`}
                                            >
                                              {candidate.match === "exact" ? "精确 ID" : "归一化"}
                                            </span>
                                          </span>
                                          <span className="mono mono--plain param-candidate__model">
                                            {candidate.modelKey}
                                          </span>
                                        </div>
                                        <div className="param-candidate__numbers">
                                          <span>输入 {formatPrice(candidate.cost.input)}</span>
                                          <span>输出 {formatPrice(candidate.cost.output)}</span>
                                          <span>缓存 {formatPrice(candidate.cost.cacheRead)}</span>
                                          <span>
                                            窗口{" "}
                                            {candidate.contextWindow ? formatCount(candidate.contextWindow) : "—"}
                                          </span>
                                        </div>
                                        <button
                                          className="btn btn--secondary btn--sm"
                                          type="button"
                                          disabled={current || applyingReference !== null}
                                          onClick={() => void applyReference(candidate)}
                                        >
                                          {current
                                            ? "当前参考"
                                            : applyingReference === key
                                              ? "应用中…"
                                              : "应用为参考"}
                                        </button>
                                      </div>
                                    );
                                  })
                                )}
                              </div>
                              <div className="param-reference__hint">
                                参考价会连同窗口、最大输出与模态写入手动覆盖；「恢复自动」可清除。
                              </div>
                            </>
                          ) : null}
                        </div>

                        <div className="param-editor__foot">
                          <label className="toggle">
                            <input type="checkbox" className="toggle__input" checked={draft.reasoning} onChange={(e) => setDraft({ ...draft, reasoning: e.target.checked })} />
                            <span className="toggle__track" />
                            <span className="toggle__label">支持 reasoning</span>
                          </label>
                          <div className="param-editor__actions">
                            <button
                              className="btn btn--ghost btn--sm"
                              type="button"
                              disabled={!row.manual}
                              title={row.manual ? "清除手动覆盖，恢复自动匹配值" : "当前没有手动覆盖"}
                              onClick={() => void reset(row)}
                            >
                              恢复自动
                            </button>
                            <button className="btn btn--secondary btn--sm" type="button" onClick={closeEditor}>
                              取消
                            </button>
                            <button className="btn btn--primary btn--sm" type="button" disabled={saving} onClick={() => void save()}>
                              {saving ? "保存中…" : "保存参数"}
                            </button>
                          </div>
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
