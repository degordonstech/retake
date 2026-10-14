import { useEffect, useRef, useState } from "react";
import { Captions, Check, Copy, FileText, FolderOpen, Loader2, Rocket, ShieldAlert, ShieldCheck, Square, Zap } from "lucide-react";
import { useLooks } from "../looks";
import { exportInWindow } from "../engine/run";
import { api, media } from "../api";
import type { Job, Project } from "../types";
import { ago, fmtDuration, fmtTime } from "../util";
import { useToast } from "../ui";
import { normalize, totalDuration } from "../editor/model";
import type { FormatSettings } from "../types";

const SHAPES: [string, string, string][] = [
  ["16:9", "YouTube", "Landscape 16:9"],
  ["9:16", "Shorts, TikTok, Reels", "Portrait 9:16"],
  ["1:1", "Square", "1:1 for feeds"],
  ["4:5", "Instagram feed", "Portrait 4:5"],
];

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

export default function Export({ p, setP, job, active, start }: Props) {
  const toast = useToast();
  const [out, setOut] = useState<{ fps: number; quality: string; auto: { width: number; height: number; fps: number } } | null>(null);
  const rendering = active && job.kind === "render";
  const looks = useLooks();
  const [fast, setFast] = useState<{ f: number; msg: string } | null>(null);
  const stopper = useRef<AbortController | null>(null);
  const runFast = async () => {
    const ctl = new AbortController();
    stopper.current = ctl;
    setFast({ f: 0, msg: "Getting ready" });
    try {
      const next = await exportInWindow(p, looks, (f, msg) => setFast({ f, msg }), ctl.signal);
      setP(next);
      toast("Your video is ready", "ok");
    } catch (e) {
      const err = e as Error;
      toast(err.name === "AbortError" ? "Export stopped" : `Export failed: ${err.message}`, err.name === "AbortError" ? "info" : "bad");
    } finally {
      setFast(null);
      stopper.current = null;
    }
  };
  const total = totalDuration(p.edit.clips);
  const last = p.renders[0];

  useEffect(() => { api.output(p.id).then(setOut).catch(() => {}); }, [p.id]);
  const save = async (o: { fps?: number; quality?: string }) => {
    try { setOut(await api.saveOutput(p.id, o)); } catch (e) { toast((e as Error).message, "bad"); }
  };
  const fmt = p.edit.format ?? { aspect: "16:9" };
  const setFormat = async (f: Partial<FormatSettings>) => {
    const edit = { ...normalize(p.edit), format: { ...fmt, ...f } };
    try {
      await api.saveEdit(p.id, edit);
      setP({ ...p, edit });
      setOut(await api.output(p.id));
    } catch (e) { toast((e as Error).message, "bad"); }
  };
  const caps = p.edit.captions;

  const phases = ["Re-checking privacy", "Cutting clip", "Finishing", "Checking for leaks"];
  const msg = job.message ?? "";
  const pi = Math.max(0, phases.findIndex((x) => msg.startsWith(x) || msg.includes(x)));

  return (
    <div className="page-inner" style={{ maxWidth: 1180 }}>
      <div className="spread" style={{ marginBottom: 22, alignItems: "flex-end" }}>
        <div className="col" style={{ gap: 6 }}>
          <span className="eyebrow">Step 4</span>
          <h1>Export</h1>
          <p className="muted">{fmtDuration(total)} · {p.edit.clips.length} clips · {p.edit.overlays.length} text and graphics · {(p.edit.media ?? []).length} overlays · {(p.edit.audio ?? []).length} sounds</p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn lg" onClick={runFast} disabled={rendering || !!fast || !p.edit.clips.length}
            title="Made right here by the editor's own engine, using your graphics chip. Fast, but the privacy read-back check is skipped.">
            <Zap size={18} /> Fast export
          </button>
          <button className="btn primary lg" onClick={() => start("render")} disabled={rendering || !!fast || !p.edit.clips.length}>
            {rendering ? <Loader2 size={18} className="spin" /> : <Rocket size={18} />} {rendering ? "Exporting" : last ? "Export again" : "Export video"}
          </button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "320px 1fr", gap: 18, alignItems: "start" }}>
        <section className="card pad col" style={{ gap: 18 }}>
          <h3>Output</h3>
          <label className="field">
            Shape
            <div className="col" style={{ gap: 6 }}>
              {SHAPES.map(([v, name, sub]) => (
                <button key={v} className={`shape ${(fmt.aspect ?? "16:9") === v ? "on" : ""}`} onClick={() => setFormat({ aspect: v })}>
                  <span className={`ar ar-${v.replace(":", "x")}`} />
                  <span className="col" style={{ gap: 0, alignItems: "flex-start" }}><b className="small">{name}</b><span className="faint tiny">{sub}</span></span>
                  {(fmt.aspect ?? "16:9") === v && <Check size={15} style={{ marginLeft: "auto" }} />}
                </button>
              ))}
            </div>
          </label>
          <div className="col" style={{ gap: 8 }}>
            <label className="row small muted" style={{ gap: 8, cursor: "pointer" }} onClick={() => setFormat({ fadeIn: !fmt.fadeIn })}>
              <span className={`switch ${fmt.fadeIn ? "on" : ""}`} /> Fade in from black
            </label>
            <label className="row small muted" style={{ gap: 8, cursor: "pointer" }} onClick={() => setFormat({ fadeOut: !fmt.fadeOut })}>
              <span className={`switch ${fmt.fadeOut ? "on" : ""}`} /> Fade out at the end
            </label>
          </div>
          <span className="row small" style={{ gap: 8 }}><Captions size={15} color={caps?.on ? "var(--ok)" : "var(--text-3)"} />
            {caps?.on ? "Animated captions are burned in" : "No burned-in captions (turn them on in the editor)"}</span>
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
          {out && <span className="faint small">{out.auto.width}×{out.auto.height} at {out.auto.fps} fps, H.264 with AAC sound, loudness levelled for YouTube. Captions (.srt) and a chapters list are saved next to it.</span>}
          <div className="divider" />
          <div className="col" style={{ gap: 6 }}>
            <span className="row small" style={{ gap: 8 }}><ShieldCheck size={15} color="var(--privacy)" /> Privacy is re-checked first if the edit changed</span>
            <span className="row small" style={{ gap: 8 }}><ShieldCheck size={15} color="var(--privacy)" /> The finished video is read back to catch leaks</span>
          </div>
          <button className="btn" onClick={() => api.openExports(p.id)}><FolderOpen size={16} /> Open exports folder</button>
        </section>

        <section className="col" style={{ gap: 18 }}>
          {fast && (
            <div className="card pad col rise" style={{ gap: 12 }}>
              <div className="spread"><h3>{fast.msg}</h3>
                <div className="row"><span className="mono muted">{Math.round(fast.f * 100)}%</span>
                  <button className="btn sm" onClick={() => stopper.current?.abort()}><Square size={12} /> Stop</button></div>
              </div>
              <div className="progress"><i style={{ width: `${fast.f * 100}%` }} /></div>
              <span className="faint small">Fast export: drawn and encoded in this window. Keep Retake open until it finishes.</span>
            </div>
          )}
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
              <video key={last.file} src={media.render(p.id, 0)} controls style={{ width: "100%", display: "block", background: "#000", aspectRatio: `${last.width}/${last.height}`, maxHeight: 560 }} />
              <div className="col" style={{ padding: 18, gap: 14 }}>
                <div className="spread">
                  <div className="col" style={{ gap: 3 }}>
                    <b className="ellipsis" title={last.file}>{last.file.split(/[\\/]/).pop()}</b>
                    <span className="faint small">{fmtTime(last.duration)} · {last.width}×{last.height} · {last.fps} fps · {ago(last.created)}</span>
                  </div>
                  <button className="btn" onClick={() => api.reveal(last.file)}><FolderOpen size={16} /> Show file</button>
                </div>
                {(last as { engine?: string }).engine === "window" ? (
                  <div className="pill" style={{ height: 34, borderRadius: 10, alignSelf: "flex-start" }}><Zap size={15} /> Fast export: blurs applied, read-back check not run</div>
                ) : last.leaks.length === 0 ? (
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
