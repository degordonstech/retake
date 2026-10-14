import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, EyeOff, Loader2, Plus, ScanEye, ShieldCheck, SquareDashedMousePointer, Trash2 } from "lucide-react";
import { api, media } from "../api";
import type { Detection, Job, Manual, Project } from "../types";
import { clamp, fmtTime } from "../util";
import { Empty, Modal, useToast } from "../ui";
import { isTitle, locate, offsetAt, starts, totalDuration } from "../editor/model";

interface Props {
  p: Project;
  job: Job;
  active: boolean;
  start: (kind: string, args?: Record<string, unknown>) => Promise<void>;
  reload: () => Promise<Project | null>;
  goExport: () => void;
}

/** Where a moment of a source video lands in the edit, if it's kept. */
function editTime(p: Project, src: string, t: number): number | null {
  const st = starts(p.edit.clips);
  for (let i = 0; i < p.edit.clips.length; i++) {
    const c = p.edit.clips[i];
    if (isTitle(c)) continue;
    const take = p.takes.find((x) => x.id === c.take);
    if (!take || take.video !== src) continue;
    const off = take.video === take.voice ? 0 : offsetAt(take, c.a);
    const vt = t - off;
    if (vt >= c.a - 0.05 && vt <= c.b + 0.05) return st[i] + Math.max(0, vt - c.a);
  }
  return null;
}

export default function Privacy({ p, job, active, start, reload, goExport }: Props) {
  const toast = useToast();
  const [data, setData] = useState<{ detections: Detection[]; dismissed?: string[]; manual?: Manual[]; scanned?: number } | null>(null);
  const [adding, setAdding] = useState(false);
  const scanning = active && (job.kind === "scan" || job.kind === "render");

  const load = () => api.privacy(p.id).then(setData).catch((e) => toast((e as Error).message, "bad"));
  useEffect(() => { load(); }, [p.id, p.privacy.scanned]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!active && job.kind === "scan" && job.status === "done") { load(); reload(); } }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  const dismissed = new Set(data?.dismissed ?? []);
  const dets = useMemo(() => (data?.detections ?? []).map((d) => ({ ...d, at: editTime(p, d.src, (d.t0 + d.t1) / 2) }))
    .sort((a, b) => (a.at ?? 1e9) - (b.at ?? 1e9)), [data, p]);
  const counts = dets.reduce<Record<string, number>>((m, d) => ({ ...m, [d.label]: (m[d.label] ?? 0) + 1 }), {});

  const toggle = async (d: Detection) => {
    try { setData(await api.dismiss(p.id, d.key, !dismissed.has(d.key))); } catch (e) { toast((e as Error).message, "bad"); }
  };

  return (
    <div className="page-inner" style={{ maxWidth: 1180 }}>
      <div className="spread" style={{ marginBottom: 22, alignItems: "flex-end" }}>
        <div className="col" style={{ gap: 6 }}>
          <span className="eyebrow">Step 3</span>
          <h1>Keep private things private</h1>
          <p className="muted">Retake reads every changing moment of the footage you kept and blurs what it finds. Check them, and add your own.</p>
        </div>
        <div className="row">
          <button className="btn" onClick={() => setAdding(true)} disabled={!p.edit.clips.length}><SquareDashedMousePointer size={16} /> Draw a blur</button>
          {data?.scanned ? (
            <>
              <button className="btn" onClick={() => start("scan")} disabled={scanning}><ScanEye size={16} /> Scan again</button>
              <button className="btn primary lg" onClick={goExport}>Continue to export <ArrowRight size={18} /></button>
            </>
          ) : (
            <button className="btn primary lg" onClick={() => start("scan")} disabled={scanning}><ScanEye size={18} /> Scan my footage</button>
          )}
        </div>
      </div>

      {scanning && (
        <div className="card pad rise col" style={{ gap: 12, marginBottom: 20 }}>
          <div className="row"><Loader2 size={18} className="spin" color="var(--privacy)" /><h3>{job.message}</h3><span className="mono muted" style={{ marginLeft: "auto" }}>{Math.round((job.progress ?? 0) * 100)}%</span></div>
          <div className="progress"><i style={{ width: `${(job.progress ?? 0) * 100}%`, background: "linear-gradient(90deg, var(--privacy), #cfc7ff)" }} /></div>
          <span className="faint small">It reads text ten times a second wherever the picture changes, so a password that flashes for a moment is still caught.</span>
        </div>
      )}

      {!data ? (
        <div className="muted row"><Loader2 size={16} className="spin" /> Loading</div>
      ) : !data.scanned && !scanning ? (
        <div className="card"><Empty icon={<ShieldCheck size={26} />} title="Not scanned yet">
          Scanning looks for emails, phone numbers, API keys, passwords, IDs in links, file pickers, desktop icons, link previews and your private words.
          It also runs again automatically before every export if the edit changed.
        </Empty></div>
      ) : (
        <>
          <div className="row wrap" style={{ gap: 8, marginBottom: 16 }}>
            {dets.length === 0 ? (
              <span className="pill ok"><ShieldCheck size={13} /> Nothing private found in the kept footage</span>
            ) : (
              Object.entries(counts).map(([k, n]) => <span key={k} className="pill privacy">{n} × {k}</span>)
            )}
            {(data.manual?.length ?? 0) > 0 && <span className="pill">{data.manual!.length} drawn by you</span>}
          </div>

          {(data.manual?.length ?? 0) > 0 && (
            <div className="col" style={{ gap: 10, marginBottom: 26 }}>
              <h3>Your blurs</h3>
              <div className="det-grid">
                {data.manual!.map((m) => <ManualCard key={m.id} p={p} m={m} onDelete={async () => setData(await api.delManual(p.id, m.id))} />)}
              </div>
            </div>
          )}

          {dets.length > 0 && <h3 style={{ marginBottom: 10 }}>Found by Retake</h3>}
          <div className="det-grid">
            {dets.map((d) => <DetCard key={d.id} p={p} d={d} at={d.at} off={dismissed.has(d.key)} onToggle={() => toggle(d)} />)}
          </div>
        </>
      )}

      {adding && <DrawBlur p={p} onClose={() => setAdding(false)} onSave={async (m) => { setData(await api.addManual(p.id, m)); setAdding(false); toast("Blur added", "ok"); }} />}
    </div>
  );
}

/** The frame, zoomed so the found spot fills a good part of the card. Click to see the whole frame. */
function Zoomed({ src, box, w, h }: { src: string; box: number[]; w: number; h: number }) {
  const [whole, setWhole] = useState(false);
  const [x0, y0, x1, y1] = box;
  const bw = (x1 - x0) / w, bh = (y1 - y0) / h;
  const scale = whole ? 1 : clamp(Math.min(0.55 / Math.max(bw, 0.01), 0.45 / Math.max(bh, 0.01)), 1, 5);
  const cx = (x0 + x1) / 2 / w, cy = (y0 + y1) / 2 / h;
  // Keep the zoomed image covering the card.
  const tx = clamp(0.5 - cx * scale, 1 - scale, 0), ty = clamp(0.5 - cy * scale, 1 - scale, 0);
  const tf = `translate(${tx * 100}%, ${ty * 100}%) scale(${scale})`;
  return (
    <div className="shot" onClick={() => setWhole((v) => !v)} title={whole ? "Zoom in" : "See the whole frame"} style={{ overflow: "hidden" }}>
      <div style={{ position: "absolute", inset: 0, transformOrigin: "0 0", transform: tf, transition: "transform .25s ease" }}>
        <img alt="" loading="lazy" src={src} style={{ position: "absolute", inset: 0 }} />
        <div className="box" style={{ left: `${(x0 / w) * 100}%`, top: `${(y0 / h) * 100}%`, width: `${bw * 100}%`, height: `${bh * 100}%`, borderWidth: 2 / scale }} />
      </div>
    </div>
  );
}

function srcSize(p: Project, sid: string) {
  const s = p.sources.find((x) => x.id === sid);
  return { w: s?.width || 1920, h: s?.height || 1080 };
}

function DetCard({ p, d, at, off, onToggle }: { p: Project; d: Detection; at: number | null; off: boolean; onToggle: () => void }) {
  const { w, h } = srcSize(p, d.src);
  const mid = (d.t0 + d.t1) / 2;
  const box = d.boxes.reduce((best, b) => (Math.abs((b[0] + b[1]) / 2 - mid) < Math.abs((best[0] + best[1]) / 2 - mid) ? b : best), d.boxes[0]);
  const [, , x0, y0, x1, y1] = box;
  const frameT = clamp(mid, box[0], box[1]);
  return (
    <div className={`det ${off ? "off" : ""}`}>
      <Zoomed src={media.frame(p.id, d.src, frameT, 1280)} box={[x0, y0, x1, y1]} w={w} h={h} />
      <div className="col" style={{ padding: 12, gap: 8 }}>
        <div className="spread">
          <b className="small">{d.label}</b>
          <span className="mono faint tiny">{at !== null ? `at ${fmtTime(at)}` : "in a cut part"}</span>
        </div>
        <span className="faint small ellipsis">{d.preview} · {(d.t1 - d.t0).toFixed(1)} s on screen</span>
        <label className="row small" style={{ gap: 8, cursor: "pointer", color: off ? "var(--text-3)" : "var(--privacy)" }}>
          <span className={`switch ${off ? "" : "on"}`} style={off ? undefined : { background: "var(--privacy)" }} onClick={onToggle} />
          {off ? "Left visible" : "Blurred"}
        </label>
      </div>
    </div>
  );
}

function ManualCard({ p, m, onDelete }: { p: Project; m: Manual; onDelete: () => void }) {
  const { w, h } = srcSize(p, m.src);
  const [x0, y0, x1, y1] = m.box;
  const at = editTime(p, m.src, m.t0);
  return (
    <div className="det">
      <Zoomed src={media.frame(p.id, m.src, (m.t0 + m.t1) / 2, 1280)} box={[x0, y0, x1, y1]} w={w} h={h} />
      <div className="spread" style={{ padding: 12 }}>
        <span className="small"><EyeOff size={13} style={{ verticalAlign: -2 }} /> {(m.t1 - m.t0).toFixed(1)} s {at !== null && <span className="faint mono">· at {fmtTime(at)}</span>}</span>
        <button className="btn ghost sm danger" onClick={onDelete}><Trash2 size={14} /> Remove</button>
      </div>
    </div>
  );
}

function DrawBlur({ p, onClose, onSave }: { p: Project; onClose: () => void; onSave: (m: Omit<Manual, "id">) => void }) {
  const total = totalDuration(p.edit.clips);
  const [t, setT] = useState(0);
  const [len, setLen] = useState(3);
  const [rect, setRect] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const img = useRef<HTMLDivElement>(null);

  const { index, local } = locate(p.edit.clips, t);
  const c = p.edit.clips[index];
  const take = c && !isTitle(c) ? p.takes.find((x) => x.id === c.take) : undefined;
  const src = take?.video ?? null;
  const vt = c && !isTitle(c) && take ? c.a + local + (take.video === take.voice ? 0 : offsetAt(take, c.a)) : 0;
  const size = src ? srcSize(p, src) : { w: 1920, h: 1080 };

  const down = (e: React.MouseEvent) => {
    const r = img.current!.getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
    setRect({ x0: fx, y0: fy, x1: fx, y1: fy });
    const move = (ev: MouseEvent) => setRect((q) => q && { ...q, x1: clamp((ev.clientX - r.left) / r.width, 0, 1), y1: clamp((ev.clientY - r.top) / r.height, 0, 1) });
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  const norm = rect && { x0: Math.min(rect.x0, rect.x1), y0: Math.min(rect.y0, rect.y1), x1: Math.max(rect.x0, rect.x1), y1: Math.max(rect.y0, rect.y1) };
  const valid = !!(src && norm && norm.x1 - norm.x0 > 0.01 && norm.y1 - norm.y0 > 0.01);

  return (
    <Modal onClose={onClose} width={860}>
      <div className="col" style={{ gap: 14 }}>
        <div className="row"><SquareDashedMousePointer size={18} color="var(--privacy)" /><h2>Draw a blur</h2></div>
        <p className="muted small">Pick the moment in your edit, then drag a box over what should be hidden.</p>
        <div ref={img} onMouseDown={down} style={{ position: "relative", aspectRatio: "16/9", background: "#000", borderRadius: 10, overflow: "hidden", cursor: "crosshair" }}>
          {src ? <img alt="" draggable={false} src={media.frame(p.id, src, vt, 1280)} style={{ width: "100%", height: "100%", objectFit: "contain", pointerEvents: "none" }} />
            : <div className="muted" style={{ display: "grid", placeItems: "center", height: "100%" }}>No picture at this moment</div>}
          {norm && <div className="box" style={{ position: "absolute", border: "2px solid var(--privacy)", background: "rgba(165,151,255,.3)", borderRadius: 3,
            left: `${norm.x0 * 100}%`, top: `${norm.y0 * 100}%`, width: `${(norm.x1 - norm.x0) * 100}%`, height: `${(norm.y1 - norm.y0) * 100}%` }} />}
        </div>
        <div className="row" style={{ gap: 14 }}>
          <span className="mono small" style={{ width: 54 }}>{fmtTime(t)}</span>
          <input type="range" min={0} max={Math.max(0.1, total - 0.05)} step={0.1} value={t} onChange={(e) => setT(Number(e.target.value))} style={{ flex: 1, accentColor: "var(--privacy)" }} />
          <label className="row small muted" style={{ gap: 8 }}>
            for
            <input className="input mono" type="number" min={0.5} step={0.5} value={len} onChange={(e) => setLen(Math.max(0.5, Number(e.target.value)))} style={{ width: 80, height: 32 }} />
            seconds
          </label>
        </div>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!valid} onClick={() => norm && src && onSave({
            src, t0: Math.max(0, vt - 0.2), t1: vt + len,
            box: [Math.round(norm.x0 * size.w), Math.round(norm.y0 * size.h), Math.round(norm.x1 * size.w), Math.round(norm.y1 * size.h)],
          })}><Plus size={16} /> Add blur</button>
        </div>
      </div>
    </Modal>
  );
}
