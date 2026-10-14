export function fmtTime(t: number, frac = false): string {
  if (!isFinite(t) || t < 0) t = 0;
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const base = h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
  return frac ? `${base}.${String(Math.floor((t % 1) * 10))}` : base;
}

export function fmtDuration(t: number): string {
  if (t < 60) return `${Math.round(t)} s`;
  const m = Math.floor(t / 60);
  const s = Math.round(t % 60);
  if (m < 60) return s ? `${m} min ${s} s` : `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export function fmtBytes(n: number): string {
  if (n < 1024 ** 2) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(0)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

export function ago(ts: number): string {
  const d = Date.now() / 1000 - ts;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  const days = Math.floor(d / 86400);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

export function uid(prefix: string): string {
  return `${prefix}_${Math.random().toString(16).slice(2, 10)}`;
}

export const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

export const KIND_COLOR: Record<string, string> = {
  screen: "var(--screen)",
  camera: "var(--camera)",
  audio: "var(--audio)",
  title: "var(--title)",
};
