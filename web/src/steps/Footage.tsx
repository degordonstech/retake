import { useEffect, useState } from "react";
import { ArrowDown, ArrowRight, ArrowUp, AudioLines, Camera, Check, Clapperboard, FileAudio, Loader2, Monitor, RefreshCw, Scissors, Sparkles, Wand2 } from "lucide-react";
import { api, media } from "../api";
import type { Job, Project, Role, Settings, Take } from "../types";
import { fmtBytes, fmtDuration } from "../util";
import { Modal, useToast } from "../ui";

const ROLES: { id: Role; label: string }[] = [
  { id: "screen", label: "Screen recording" },
  { id: "voice", label: "Voice track" },
  { id: "camera", label: "Camera" },
  { id: "skip", label: "Leave out" },
];

const TAKE_ICON = { screen: Monitor, camera: Camera, audio: AudioLines };

interface Props {
  p: Project;
  setP: (p: Project) => void;
  job: Job;
  active: boolean;
  start: (kind: string, args?: Record<string, unknown>) => Promise<void>;
  goEdit: () => void;
}

export default function Footage({ p, setP, job, active, start, goEdit }: Props) {
  const toast = useToast();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [recut, setRecut] = useState(false);
  useEffect(() => { api.settings().then(setSettings).catch(() => {}); }, []);

  const prepared = p.takes.length > 0 && p.takes.every((t) => t.ready);
  const running = active && (job.kind === "prepare" || job.kind === "autoedit" || job.kind === "quickstart");
  const src = (id: string | null) => p.sources.find((s) => s.id === id);
  const videos = p.sources.filter((s) => s.has_video && s.role !== "skip");

  const setRole = async (sid: string, role: Role) => {
    try { setP(await api.setRole(p.id, sid, role)); } catch (e) { toast((e as Error).message, "bad"); }
  };
  const saveTakes = async (takes: Take[]) => {
    try { setP(await api.setTakes(p.id, takes.map((t) => ({ id: t.id, voice: t.voice, video: t.video })))); }
    catch (e) { toast((e as Error).message, "bad"); }
  };
  const move = (i: number, d: number) => {
    const t = [...p.takes];
    const j = i + d;
    if (j < 0 || j >= t.length) return;
    [t[i], t[j]] = [t[j], t[i]];
    saveTakes(t);
  };

  return (
    <div className="page-inner" style={{ maxWidth: 1180 }}>
      <div className="spread" style={{ marginBottom: 22, alignItems: "flex-end" }}>
        <div className="col" style={{ gap: 6 }}>
          <span className="eyebrow">Step 1</span>
          <h1>Your footage</h1>
          <p className="muted">Check what each file is. Retake pairs each voice with its picture and lines them up by sound.</p>
        </div>
        {!running && (prepared && p.edit.clips.length ? (
          <div className="row">
            {p.quick ? (
              <button className="btn" onClick={() => start("prepare")} title="Listen to every file for captions, editing by text and an AI first cut">
                <Wand2 size={16} /> Transcribe for captions
              </button>
            ) : (
              <button className="btn" onClick={() => setRecut(true)}><RefreshCw size={16} /> New first cut</button>
            )}
            <button className="btn primary lg" onClick={goEdit}>Open the editor <ArrowRight size={18} /></button>
          </div>
        ) : (
          <div className="row">
            <button className="btn lg" onClick={() => start("quickstart")} disabled={!p.sources.length}
              title="Every file goes on the timeline as it is, ready in seconds. No AI, no transcription.">
              <Scissors size={18} /> Just edit
            </button>
            <button className="btn primary lg" onClick={() => start("prepare")} disabled={!p.takes.length}>
              <Wand2 size={18} /> Make my first cut
            </button>
          </div>
        ))}
      </div>

      {running && <Progress job={job} brain={settings?.brain} />}

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.1fr) minmax(0, 1fr)", gap: 18, alignItems: "start" }}>
        <section className="card" style={{ overflow: "hidden" }}>
          <div className="pane-head"><h3>Files in the folder</h3><span className="faint small mono ellipsis" style={{ marginLeft: "auto", maxWidth: 300 }} title={p.folder}>{p.folder}</span></div>
          <div className="col" style={{ gap: 0 }}>
            {p.sources.map((s) => (
              <div key={s.id} className="row" style={{ padding: "12px 14px", borderBottom: "1px solid var(--line)", gap: 14, opacity: s.role === "skip" ? 0.5 : 1 }}>
                <div style={{ width: 96, aspectRatio: "16/9", borderRadius: 8, overflow: "hidden", background: "var(--bg-2)", flex: "none", display: "grid", placeItems: "center", border: "1px solid var(--line)" }}>
                  {s.has_video ? (
                    <img alt="" loading="lazy" src={media.frame(p.id, s.id, Math.min(s.duration * 0.3, 30), 240)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  ) : (
                    <FileAudio size={22} color="var(--audio)" />
                  )}
                </div>
                <div className="col grow" style={{ gap: 3 }}>
                  <b className="ellipsis" title={s.file}>{s.file}</b>
                  <span className="faint small">
                    {fmtDuration(s.duration)} · {s.has_video ? `${s.width}×${s.height} · ${Math.round(s.fps)} fps` : "audio only"} · {fmtBytes(s.size)}
                  </span>
                </div>
                <select className="select" style={{ width: 170, height: 34 }} value={s.role} disabled={running}
                  onChange={(e) => setRole(s.id, e.target.value as Role)}>
                  {ROLES.filter((r) => s.has_video || r.id === "voice" || r.id === "skip").map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                </select>
              </div>
            ))}
          </div>
        </section>

        <section className="col" style={{ gap: 12 }}>
          <div className="spread"><h3>How they play, in order</h3><span className="faint small">{p.takes.length} take{p.takes.length === 1 ? "" : "s"}</span></div>
          {p.takes.length === 0 && <div className="card pad muted small">Mark at least one file as a screen recording, voice track or camera.</div>}
          {p.takes.map((t, i) => {
            const I = TAKE_ICON[t.kind];
            const voice = src(t.voice);
            const separate = t.video && t.video !== t.voice;
            return (
              <div key={t.id} className="card" style={{ padding: 14, display: "flex", gap: 12 }}>
                <div className="col" style={{ gap: 4, alignItems: "center" }}>
                  <span className="mono faint tiny">{String(i + 1).padStart(2, "0")}</span>
                  <button className="btn ghost sm icon" disabled={i === 0 || running} onClick={() => move(i, -1)} aria-label="Move up"><ArrowUp size={14} /></button>
                  <button className="btn ghost sm icon" disabled={i === p.takes.length - 1 || running} onClick={() => move(i, 1)} aria-label="Move down"><ArrowDown size={14} /></button>
                </div>
                <div className="col grow" style={{ gap: 8 }}>
                  <div className="row">
                    <div style={{ width: 30, height: 30, borderRadius: 9, display: "grid", placeItems: "center", background: "var(--raised-2)", color: `var(--${t.kind === "audio" ? "audio" : t.kind})` }}>
                      <I size={16} />
                    </div>
                    <b className="ellipsis grow">{t.name}</b>
                    {t.ready ? <span className="pill ok"><Check size={12} /> Ready</span> : <span className="pill">Not listened to yet</span>}
                  </div>
                  <div className="col small" style={{ gap: 4 }}>
                    <span className="muted row" style={{ gap: 6 }}><AudioLines size={13} /> Voice from <b className="ellipsis">{voice?.file}</b></span>
                    {separate ? (
                      <div className="row" style={{ gap: 6 }}>
                        <Monitor size={13} color="var(--text-2)" /><span className="muted">Picture from</span>
                        <select className="select" style={{ height: 28, fontSize: 12.5, flex: 1 }} value={t.video ?? ""} disabled={running}
                          onChange={(e) => saveTakes(p.takes.map((x) => (x.id === t.id ? { ...x, id: "", video: e.target.value || null } : x)))}>
                          {videos.map((v) => <option key={v.id} value={v.id}>{v.file}</option>)}
                          <option value="">No picture</option>
                        </select>
                      </div>
                    ) : t.kind === "camera" ? (
                      <span className="muted row" style={{ gap: 6 }}><Camera size={13} /> Picture and sound from the same file</span>
                    ) : t.kind === "audio" ? (
                      <span className="faint">No picture: your brand background shows instead</span>
                    ) : null}
                    {separate && t.sync_score !== null && (
                      <span className="faint tiny">
                        Lined up: picture {t.offsets[0][1] >= 0 ? "+" : ""}{t.offsets[0][1].toFixed(2)} s
                        {t.offsets.length > 1 && `, ${t.offsets.length - 1} jump${t.offsets.length > 2 ? "s" : ""} where recording paused`}
                        {t.sync_score < 0.3 && " · weak match, check it in the editor"}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
          {vid0Hint(p) && <p className="faint tiny">Tip: a separate voice track is matched to its screen recording by length; change the picture above if a pair is wrong.</p>}
        </section>
      </div>

      {recut && (
        <Modal onClose={() => setRecut(false)}>
          <div className="col" style={{ gap: 14 }}>
            <div className="row"><Sparkles size={18} color="var(--accent)" /><h2>Make a new first cut?</h2></div>
            <p className="muted">This replaces the current timeline, including any changes you made in the editor. Transcripts and sync are kept, so it only takes a minute.</p>
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button className="btn ghost" onClick={() => setRecut(false)}>Cancel</button>
              <button className="btn primary" onClick={() => { setRecut(false); start("autoedit"); }}><Wand2 size={16} /> Replace the timeline</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function vid0Hint(p: Project) {
  return p.takes.some((t) => t.video && t.video !== t.voice);
}

function Progress({ job, brain }: { job: Job; brain?: string }) {
  const msg = job.message || "";
  const phases = [
    { key: "Making a preview copy", label: "Making smooth preview copies" },
    { key: "Listening", label: "Listening to every word" },
    { key: "Lining up", label: "Lining up picture and voice" },
    { key: "first cut", label: brain === "none" ? "Cutting retakes and pauses" : "Your AI editor is making the first cut" },
  ];
  const idx = Math.max(0, phases.findIndex((ph) => msg.includes(ph.key)));
  return (
    <div className="card pad rise" style={{ marginBottom: 20, display: "grid", gridTemplateColumns: "1fr 1.2fr", gap: 24 }}>
      <div className="col" style={{ gap: 14 }}>
        <div className="row"><Clapperboard size={18} color="var(--accent)" /><h2>Working on your first cut</h2></div>
        <div className="progress"><i style={{ width: `${Math.round((job.progress ?? 0) * 100)}%` }} /></div>
        <span className="muted small">{msg}</span>
        <div className="checklist">
          {phases.map((ph, i) => (
            <div key={ph.key} className={`check ${i < idx ? "done" : i === idx ? "on" : ""}`}>
              <span className="ic">{i < idx ? <Check size={13} /> : i === idx ? <Loader2 size={13} className="spin" /> : null}</span>
              {ph.label}
            </div>
          ))}
        </div>
      </div>
      <div className="col" style={{ gap: 8 }}>
        <span className="eyebrow">What's happening</span>
        <div className="log" style={{ maxHeight: 220 }}>
          {(job.log ?? []).map((l, i) => <div key={i}>{l.msg}</div>)}
        </div>
        <span className="faint tiny">You can keep using your computer. Long recordings take a while the first time; after that Retake reuses the work.</span>
      </div>
    </div>
  );
}
