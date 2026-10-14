import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { AlertCircle, CheckCircle2, X } from "lucide-react";
import { api } from "./api";
import type { Job } from "./types";

/* --------------------------------------------------------------- toasts --- */
type Toast = { id: number; text: string; tone: "ok" | "bad" | "info" };
const ToastCtx = createContext<(text: string, tone?: Toast["tone"]) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: Toast["tone"] = "info") => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, text, tone }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), tone === "bad" ? 7000 : 3600);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.tone}`}>
            {t.tone === "bad" ? (
              <AlertCircle size={18} color="var(--bad)" style={{ flex: "none", marginTop: 1 }} />
            ) : (
              <CheckCircle2 size={18} color="var(--ok)" style={{ flex: "none", marginTop: 1 }} />
            )}
            <div className="grow small">{t.text}</div>
            <button className="btn ghost sm icon" onClick={() => setItems((x) => x.filter((y) => y.id !== t.id))} aria-label="Dismiss">
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

/* ---------------------------------------------------------------- modal --- */
export function Modal({ onClose, children, width }: { onClose: () => void; children: ReactNode; width?: number }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={width ? { width: `min(${width}px, calc(100vw - 40px))` } : undefined}>
        {children}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- logo --- */
export function Logo({ size = 38 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-label="Retake" className="logo">
      <defs>
        <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffb07a" />
          <stop offset="1" stopColor="#ff7a2e" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="17" fill="#161a23" />
      <rect x="0.5" y="0.5" width="63" height="63" rx="16.5" fill="none" stroke="rgba(255,255,255,.08)" />
      <path d="M22 17v30M22 17h12.5a9.5 9.5 0 0 1 0 19H22M33.5 36l10.5 11" fill="none" stroke="url(#lg)" strokeWidth="6"
        strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* ------------------------------------------------------------- job hook --- */
export function useJob(projectId: string | null, onFinish?: (j: Job) => void) {
  const [job, setJob] = useState<Job>({ status: "idle" });
  const finishRef = useRef(onFinish);
  finishRef.current = onFinish;
  const wasActive = useRef(false);

  useEffect(() => {
    if (!projectId) return;
    let stop = false;
    let timer: number;
    const tick = async () => {
      try {
        const j = await api.job(projectId);
        if (stop) return;
        setJob(j);
        const active = j.status === "queued" || j.status === "running";
        if (wasActive.current && !active) finishRef.current?.(j);
        wasActive.current = active;
        timer = window.setTimeout(tick, active ? 700 : 2500);
      } catch {
        timer = window.setTimeout(tick, 3000);
      }
    };
    tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [projectId]);

  const start = useCallback(
    async (kind: string, args?: Record<string, unknown>) => {
      if (!projectId) return;
      const j = await api.startJob(projectId, kind, args);
      wasActive.current = true;
      setJob(j);
    },
    [projectId],
  );
  return { job, start, active: job.status === "queued" || job.status === "running" };
}

export function Empty({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="col" style={{ alignItems: "center", textAlign: "center", padding: "50px 20px", gap: 12 }}>
      <div style={{ width: 54, height: 54, borderRadius: 16, display: "grid", placeItems: "center", background: "var(--raised)", color: "var(--text-2)" }}>
        {icon}
      </div>
      <h3>{title}</h3>
      {children && <div className="muted small" style={{ maxWidth: 420 }}>{children}</div>}
    </div>
  );
}
