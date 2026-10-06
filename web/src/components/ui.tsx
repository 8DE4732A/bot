import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

/* ---------------- 图标（stroke 线条, lucide 风格） ---------------- */
type IconName =
  | "grid"
  | "users"
  | "zap"
  | "swap"
  | "message"
  | "shield"
  | "plus"
  | "x"
  | "send"
  | "trash"
  | "pencil"
  | "refresh"
  | "check"
  | "search"
  | "power"
  | "plug"
  | "clock";

const ICON_PATHS: Record<IconName, ReactNode> = {
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
  users: (
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M15 3.13a4 4 0 0 1 0 7.75" />
    </>
  ),
  zap: <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8Z" />,
  swap: (
    <>
      <path d="M8 3 4 7l4 4" />
      <path d="M4 7h16" />
      <path d="m16 21 4-4-4-4" />
      <path d="M20 17H4" />
    </>
  ),
  message: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10Z" />,
  shield: (
    <>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  plus: (
    <>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </>
  ),
  x: (
    <>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </>
  ),
  send: (
    <>
      <path d="m22 2-7 20-4-9-9-4Z" />
      <path d="M22 2 11 13" />
    </>
  ),
  trash: (
    <>
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </>
  ),
  pencil: (
    <>
      <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
      <path d="m15 5 4 4" />
    </>
  ),
  refresh: (
    <>
      <path d="M21 12a9 9 0 1 1-2.64-6.36L21 8" />
      <path d="M21 3v5h-5" />
    </>
  ),
  check: <path d="m5 13 4 4L19 7" />,
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </>
  ),
  power: (
    <>
      <path d="M12 2v10" />
      <path d="M18.4 6.6a9 9 0 1 1-12.77.04" />
    </>
  ),
  plug: (
    <>
      <path d="M12 22v-5" />
      <path d="M9 8V2" />
      <path d="M15 8V2" />
      <path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 3" />
    </>
  ),
};

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICON_PATHS[name]}
    </svg>
  );
}

/* ---------------- Toast ---------------- */
interface ToastItem {
  id: number;
  text: string;
  kind: "ok" | "risk";
}

const ToastCtx = createContext<(text: string, kind?: "ok" | "risk") => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const push = useCallback((text: string, kind: "ok" | "risk" = "ok") => {
    const id = ++seq.current;
    setItems((cur) => [...cur, { id, text, kind }]);
    setTimeout(() => setItems((cur) => cur.filter((t) => t.id !== id)), 3200);
  }, []);

  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast${t.kind === "risk" ? " toast--risk" : ""}`}>
            <span className="toast__dot" />
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

/* ---------------- Modal ---------------- */
export function Modal({
  title,
  onClose,
  foot,
  children,
}: {
  title: string;
  onClose: () => void;
  foot: ReactNode;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal__head">
          <div className="modal__title">{title}</div>
          <button className="btn btn--ghost btn--sm" onClick={onClose} aria-label="关闭">
            <Icon name="x" />
          </button>
        </div>
        <div className="modal__body">{children}</div>
        <div className="modal__foot">{foot}</div>
      </div>
    </div>
  );
}

/* ---------------- 二次点击确认删除（替代原生 confirm） ---------------- */
export function ConfirmButton({
  onConfirm,
  label = "删除",
  confirmLabel = "确认删除",
  timeout = 2600,
}: {
  onConfirm: () => void;
  label?: string;
  confirmLabel?: string;
  timeout?: number;
}) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), timeout);
    return () => clearTimeout(t);
  }, [armed, timeout]);

  return (
    <button
      className={`btn btn--danger btn--sm${armed ? " is-armed" : ""}`}
      onClick={() => {
        if (armed) {
          setArmed(false);
          onConfirm();
        } else {
          setArmed(true);
        }
      }}
    >
      {armed ? confirmLabel : label}
    </button>
  );
}

/* ---------------- 表单 Field ----------------
   注意: 用 div 而非 label——label 会把点击隐式路由到第一个 labelable
   后代控件, 当 Field 内含嵌套 Field / 开关 / TagInput 时会产生
   "点击块内任何地方都误触开关"的错误关联。 */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <span className="field__label">{label}</span>
      {children}
      {hint ? <span className="field__hint">{hint}</span> : null}
    </div>
  );
}

/* ---------------- 空状态 ---------------- */
export function Empty({
  mark,
  title,
  desc,
  action,
}: {
  mark: string;
  title: string;
  desc?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty__mark">{mark}</div>
      <div className="empty__title">{title}</div>
      {desc ? <div className="empty__desc">{desc}</div> : null}
      {action}
    </div>
  );
}

/* ---------------- 数据加载 hook ---------------- */
export function useAsync<T>(loader: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    loader()
      .then((d) => {
        if (alive) {
          setData(d);
          setError(null);
        }
      })
      .catch((e) => {
        if (alive) setError(e?.message || String(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}

/* ---------------- 列表视图的"新建/编辑弹窗"单状态 hook ----------------
   value === "new" 表示新建; 其余非空值表示正在编辑的记录; null 表示关闭。 */
export function useFormDialog<T>() {
  const [value, setValue] = useState<T | "new" | null>(null);
  return {
    value,
    /** 打开编辑; 不传参表示新建 */
    open: (item?: T) => setValue(item ?? "new"),
    close: useCallback(() => setValue(null), []),
  };
}

/* ---------------- 标签编辑器 (替代逗号分隔文本输入) ----------------
   回车/逗号添加、粘贴批量拆分、Backspace 删末尾、点 × 删除、去重。 */
export function TagInput({
  value,
  onChange,
  placeholder,
  suggestions,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  suggestions?: string[];
}) {
  const [draft, setDraft] = useState("");

  const add = (raw: string) => {
    const parts = raw
      .split(/[,\s]+/)
      .map((x) => x.trim())
      .filter(Boolean);
    if (parts.length === 0) return;
    const next = [...value];
    for (const p of parts) {
      if (!next.includes(p)) next.push(p);
    }
    onChange(next);
    setDraft("");
  };
  const removeAt = (i: number) => onChange(value.filter((_, idx) => idx !== i));

  const remainingSuggestions = (suggestions ?? []).filter((s) => !value.includes(s)).slice(0, 6);

  return (
    <div>
      <div className="taginput__tags">
        {value.map((tag, i) => (
          <span key={`${tag}-${i}`} className="chip">
            {tag}
            <button
              type="button"
              className="chip__x"
              aria-label={`移除 ${tag}`}
              onClick={() => removeAt(i)}
            >
              ✕
            </button>
          </span>
        ))}
        <input
          className="taginput__input"
          value={draft}
          placeholder={value.length === 0 ? placeholder : "输入后回车添加…"}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add(draft);
            } else if (e.key === "Backspace" && !draft && value.length > 0) {
              removeAt(value.length - 1);
            }
          }}
          onBlur={() => draft && add(draft)}
          onPaste={(e) => {
            const text = e.clipboardData.getData("text");
            if (/[,\s]/.test(text.trim())) {
              e.preventDefault();
              add(text);
            }
          }}
        />
      </div>
      {remainingSuggestions.length > 0 ? (
        <div className="taginput__suggestions">
          {remainingSuggestions.map((s) => (
            <button key={s} type="button" className="taginput__suggestion" onClick={() => add(s)}>
              + {s}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* ---------------- 技能类型徽标 (tool/doc/mcp 三类统一) ---------------- */
export function KindBadge({ kind }: { kind: string | undefined }) {
  if (kind === "skill") return <span className="badge" style={{ marginLeft: "auto", flexShrink: 0 }}>DOC</span>;
  if (kind === "mcp") return <span className="badge badge--live" style={{ marginLeft: "auto", flexShrink: 0 }}>MCP</span>;
  return <span className="badge badge--ink" style={{ marginLeft: "auto", flexShrink: 0 }}>TOOL</span>;
}

/* ---------------- 工具 ---------------- */
export function fmtTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function fmtUptime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function initials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  // 取前两个字符（中文姓名/英文单词均可）
  return trimmed.slice(0, 2).toUpperCase();
}
