import { useEffect, useState } from "react";
import { Check, Copy, FileText, FolderOpen, Loader2, Rocket, ShieldAlert, ShieldCheck } from "lucide-react";
import { api, media } from "../api";
import type { Job, Project } from "../types";
import { ago, fmtDuration, fmtTime } from "../util";
import { useToast } from "../ui";
import { totalDuration } from "../editor/model";

interface Props {
  p: Project;
  setP: (p: Project) => void;
  job: Job;
  active: boolean;
  start: (kind: string, args?: Record<string, unknown>) => Promise<void>;
  reload: () => Promise<Project | null>;
}

function CopyBtn({ text, label = "Copy" }: { text: string; label?: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button className="btn sm" onClick={() => { navigator.clipboard.writeText(text).catch(() => {}); setOk(true); setTimeout(() => setOk(false), 1500); }}>
      {ok ? <Check size={14} /> : <Copy size={14} />} {ok ? "Copied" : label}
    </button>
  );
}

export default function Export({ p, job, active, start }: Props) {
  const toast = useToast();
  const [out, setOut] = useState<{ fps: number; quality: string; auto: { width: number; height: number; fps: number } } | null>(null);
  const rendering = active && job.kind === "render";
  const total = totalDuration(p.edit.clips);
  const last = p.renders[0];

  useEffect(() => { api.output(p.id).then(setOut).catch(() => {}); }, [p.id]);
  const save = async (o: { fps?: number; quality?: string }) => {
    try { setOut(await api.saveOutput(p.id, o)); } catch (e) { toast((e as Error).message, "bad"); }
  };

  const phases = ["Re-checking privacy", "Cutting clip", "Finishing", "Checking for leaks"];
  const msg = job.message ?? "";
  const pi = Math.max(0, phases.findIndex((x) => msg.startsWith(x) || msg.includes(x)));

  return (
    <div className="page-inner" style={{ maxWidth: 1180 }}>
      <div className="spread" style={{ marginBottom: 22, alignItems: "flex-end" }}>
        <div className="col" style={{ gap: 6 }}>
          <span className="eyebrow">Step 4</span>
          <h1>Export</h1>
          <p className="muted">{fmtDuration(total)} · {p.edit.clips.length} clips · {p.edit.overlays.length} graphics</p>
        </div>
        <button className="btn primary lg" onClick={() => start("render")} disabled={rendering || !p.edit.clips.length}>
          {rendering ? <Loader2 size={18} className="spin" /> : <Rocket size={18} />} {rendering ? "Exporting" : last ? "Export again" : "Export video"}
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "320px 1fr", gap: 18, alignItems: "start" }}>
        <section className="card pad col" style={{ gap: 18 }}>
          <h3>Output</h3>
          <label className="field">
            Quality
            <div className="seg">
              {[["high", "High"], ["standard", "Standard"], ["small", "Small file"]].map(([v, l]) => (
                <button key={v} className={out?.quality === v ? "on" : ""} onClick={() => save({ quality: v })}>{l}</button>
              ))}
            </div>
          </label>
          <label className="field">
            Frame rate
            <select className="select" value={out?.fps ?? 0} onChange={(e) => save({ fps: Number(e.target.value) })}>
              <option value={0}>Match my footage{out ? ` (${out.auto.fps} fps)` : ""}</option>
              {[24, 25, 30, 50, 60].map((f) => <option key={f} value={f}>{f} fps</option>)}
            </select>
          </label>
          {out && <span className="faint small">{out.auto.width}×{out.auto.height}, H.264 with AAC sound, loudness levelled for YouTube. Captions (.srt) and a chapters list are saved next to it.</span>}
          <div className="divider" />
          <div className="col" style={{ gap: 6 }}>
            <span className="row small" style={{ gap: 8 }}><ShieldCheck size={15} color="var(--privacy)" /> Privacy is re-checked first if the edit changed</span>
            <span className="row small" style={{ gap: 8 }}><ShieldCheck size={15} color="var(--privacy)" /> The finished video is read back to catch leaks</span>
          </div>
          <button className="btn" onClick={() => api.openExports(p.id)}><FolderOpen size={16} /> Open exports folder</button>
        </section>

        <section className="col" style={{ gap: 18 }}>
          {rendering && (
            <div className="card pad col rise" style={{ gap: 12 }}>
              <div className="spread"><h3>{msg}</h3><span className="mono muted">{Math.round((job.progress ?? 0) * 100)}%</span></div>
              <div className="progress"><i style={{ width: `${(job.progress ?? 0) * 100}%` }} /></div>
              <div className="row wrap" style={{ gap: 6 }}>
                {phases.map((ph, i) => (
                  <span key={ph} className={`pill ${i < pi ? "ok" : i === pi ? "accent" : ""}`}>{i < pi ? <Check size={12} /> : i === pi ? <Loader2 size={12} className="spin" /> : null} {ph}</span>
                ))}
              </div>
            </div>
          )}

          {last ? (
            <div className="card" style={{ overflow: "hidden" }}>
              <video key={last.file} src={media.render(p.id, 0)} controls style={{ width: "100%", display: "block", background: "#000", aspectRatio: "16/9" }} />
              <div className="col" style={{ padding: 18, gap: 14 }}>
                <div className="spread">
                  <div className="col" style={{ gap: 3 }}>
                    <b className="ellipsis" title={last.file}>{last.file.split(/[\\/]/).pop()}</b>
                    <span className="faint small">{fmtTime(last.duration)} · {last.width}×{last.height} · {last.fps} fps · {ago(last.created)}</span>
                  </div>
                  <button className="btn" onClick={() => api.reveal(last.file)}><FolderOpen size={16} /> Show file</button>
                </div>
                {last.leaks.length === 0 ? (
                  <div className="pill ok" style={{ height: 34, borderRadius: 10, alignSelf: "flex-start" }}><ShieldCheck size={15} /> Read back after export: nothing private is readable</div>
                ) : (
                  <div className="col" style={{ gap: 6 }}>
                    <div className="pill bad" style={{ height: 34, borderRadius: 10, alignSelf: "flex-start" }}><ShieldAlert size={15} /> {last.leaks.length} things still readable. Check them, then add a blur.</div>
                    <div className="log">{last.leaks.map((l, i) => <div key={i}>{fmtTime(l.t)}  {l.label}  {l.preview}</div>)}</div>
                  </div>
                )}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                  <div className="panel col" style={{ padding: 14, gap: 8 }}>
                    <div className="spread"><span className="eyebrow">YouTube chapters</span><CopyBtn text={last.chapters} /></div>
                    <pre className="mono small selectable" style={{ margin: 0, whiteSpace: "pre-wrap", color: "var(--text-2)" }}>{last.chapters}</pre>
                  </div>
                  <div className="panel col" style={{ padding: 14, gap: 8 }}>
                    <div className="spread"><span className="eyebrow">Title and description</span>
                      {(p.brain.title || p.brain.description) && <CopyBtn text={`${p.brain.title ?? ""}\n\n${p.brain.description ?? ""}\n\n${last.chapters}`} label="Copy all" />}
                    </div>
                    {p.brain.title ? <b className="small selectable">{p.brain.title}</b> : <span className="faint small">Use an AI editor to get a suggested title.</span>}
                    {p.brain.description && <span className="small muted selectable" style={{ whiteSpace: "pre-wrap" }}>{p.brain.description}</span>}
                  </div>
                </div>
                <button className="btn ghost sm" style={{ alignSelf: "flex-start" }} onClick={() => api.reveal(last.srt)}><FileText size={14} /> Captions file (.srt)</button>
              </div>
            </div>
          ) : !rendering && (
            <div className="card pad col" style={{ alignItems: "center", textAlign: "center", gap: 10, padding: 50 }}>
              <Rocket size={30} color="var(--accent)" />
              <h2>Ready when you are</h2>
              <p className="muted small" style={{ maxWidth: 420 }}>Exporting cuts every clip at full quality, applies the blurs and graphics, levels the sound and checks the result.</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
