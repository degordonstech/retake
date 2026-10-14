import { useState } from "react";
import { Bot, Check, Copy, ListOrdered, Trash2, TriangleAlert } from "lucide-react";
import type { Clip, Overlay, Project, Transcript } from "../types";
import { fmtTime } from "../util";
import { clipDur, isTitle, wordTime } from "./model";

interface Props {
  p: Project;
  clips: Clip[];
  overlays: Overlay[];
  transcripts: Record<string, Transcript>;
  selectedClips: Clip[];
  overlay: Overlay | null;
  onClip: (c: Clip, commit: boolean) => void;
  onOverlayEdit: (o: Overlay, commit: boolean) => void;
  onDeleteOverlay: (id: string) => void;
  onDeleteClips: () => void;
  onSeek: (t: number) => void;
  onNudge: (take: string, delta: number) => void;
}

const SOURCE_NAME: Record<string, string> = { claude_code: "Claude Code", anthropic: "Claude", groq: "Groq", rules: "the built-in editor" };

export default function Inspector({ p, clips, overlays, transcripts, selectedClips, overlay, onClip, onOverlayEdit, onDeleteOverlay, onDeleteClips, onSeek, onNudge }: Props) {
  if (overlay) return <OverlayPanel o={overlay} onChange={onOverlayEdit} onDelete={() => onDeleteOverlay(overlay.id)} />;
  if (selectedClips.length === 1) return <ClipPanel p={p} c={selectedClips[0]} onChange={onClip} onDelete={onDeleteClips} onNudge={onNudge} />;
  if (selectedClips.length > 1) {
    const d = selectedClips.reduce((s, c) => s + clipDur(c), 0);
    return (
      <div className="inspector">
        <span className="eyebrow">{selectedClips.length} clips selected</span>
        <p className="muted small">{fmtTime(d, true)} in total.</p>
        <button className="btn danger" onClick={onDeleteClips}><Trash2 size={15} /> Delete clips</button>
      </div>
    );
  }
  return <Summary p={p} clips={clips} overlays={overlays} transcripts={transcripts} onSeek={onSeek} />;
}

function Copyable({ label, text }: { label: string; text: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="spread">
        <span className="eyebrow">{label}</span>
        <button className="btn ghost sm" onClick={() => { navigator.clipboard.writeText(text).catch(() => {}); setDone(true); setTimeout(() => setDone(false), 1500); }}>
          {done ? <Check size={13} /> : <Copy size={13} />} {done ? "Copied" : "Copy"}
        </button>
      </div>
      <div className="small selectable" style={{ whiteSpace: "pre-wrap", color: "var(--text)" }}>{text}</div>
    </div>
  );
}

function Summary({ p, clips, overlays, transcripts, onSeek }: { p: Project; clips: Clip[]; overlays: Overlay[]; transcripts: Record<string, Transcript>; onSeek: (t: number) => void }) {
  const b = p.brain;
  const chapters = overlays.filter((o) => o.chapter || o.kind === "label").sort((x, y) => x.start - y.start);
  return (
    <div className="inspector">
      <div className="row"><Bot size={16} color="var(--accent)" /><b className="small">First cut by {SOURCE_NAME[b.source ?? ""] ?? "Retake"}</b></div>
      {b.title && <Copyable label="Suggested title" text={b.title} />}
      {b.description && <Copyable label="Suggested description" text={b.description} />}
      {(b.notes?.length ?? 0) > 0 && (
        <div className="col" style={{ gap: 8 }}>
          <span className="eyebrow row" style={{ gap: 6 }}><TriangleAlert size={12} /> Worth checking</span>
          {b.notes!.map((n, i) => {
            const w = transcripts[n.take]?.words[n.word];
            const at = w ? wordTime(clips, n.take, w) : null;
            return (
              <div key={i} className="note-card" onClick={() => at !== null && onSeek(at)} title={at !== null ? "Jump there" : "This part is cut"}>
                {at !== null && <span className="mono tiny" style={{ opacity: 0.7 }}>{fmtTime(at)} · </span>}
                {n.note}
              </div>
            );
          })}
        </div>
      )}
      {chapters.length > 0 && (
        <div className="col" style={{ gap: 6 }}>
          <span className="eyebrow row" style={{ gap: 6 }}><ListOrdered size={12} /> Chapters</span>
          {chapters.map((o) => (
            <button key={o.id} className="btn ghost sm" style={{ justifyContent: "flex-start" }} onClick={() => onSeek(o.start)}>
              <span className="mono faint">{fmtTime(Math.max(0, o.start - 0.2))}</span> <span className="ellipsis">{o.text}</span>
            </button>
          ))}
        </div>
      )}
      <div className="faint tiny" style={{ marginTop: "auto" }}>
        Tip: select a clip to trim it, or a label on the text track to change its words.
      </div>
    </div>
  );
}

function Num({ label, value, onChange, step = 0.1, min = 0 }: { label: string; value: number; onChange: (v: number, commit: boolean) => void; step?: number; min?: number }) {
  return (
    <label className="field" style={{ flex: 1 }}>
      {label}
      <input className="input mono" type="number" step={step} min={min} value={Number(value.toFixed(2))}
        onChange={(e) => onChange(Number(e.target.value), false)} onBlur={(e) => onChange(Number(e.target.value), true)} />
    </label>
  );
}

function ClipPanel({ p, c, onChange, onDelete, onNudge }: { p: Project; c: Clip; onChange: (c: Clip, commit: boolean) => void; onDelete: () => void; onNudge: (take: string, delta: number) => void }) {
  if (isTitle(c)) {
    return (
      <div className="inspector">
        <span className="eyebrow">Title card</span>
        <label className="field">Title<input className="input" value={c.text} onChange={(e) => onChange({ ...c, text: e.target.value }, false)} onBlur={() => onChange(c, true)} /></label>
        <label className="field">Line under it<input className="input" value={c.sub} onChange={(e) => onChange({ ...c, sub: e.target.value }, false)} onBlur={() => onChange(c, true)} /></label>
        <label className="field">Small tag above<input className="input" value={c.tag} placeholder="Optional" onChange={(e) => onChange({ ...c, tag: e.target.value }, false)} onBlur={() => onChange(c, true)} /></label>
        <Num label="Seconds" value={c.dur} min={0.5} onChange={(v, commit) => onChange({ ...c, dur: Math.max(0.5, v) }, commit)} />
        <button className="btn danger" onClick={onDelete}><Trash2 size={15} /> Delete</button>
      </div>
    );
  }
  const take = p.takes.find((t) => t.id === c.take);
  return (
    <div className="inspector">
      <span className="eyebrow">Clip</span>
      <b className="ellipsis">{take?.name}</b>
      <div className="row">
        <Num label="Starts at (s)" value={c.a} onChange={(v, commit) => onChange({ ...c, a: Math.min(Math.max(0, v), c.b - 0.1) }, commit)} />
        <Num label="Ends at (s)" value={c.b} onChange={(v, commit) => onChange({ ...c, b: Math.max(Math.min(take?.duration ?? v, v), c.a + 0.1) }, commit)} />
      </div>
      <span className="muted small">Length {fmtTime(c.b - c.a, true)} · times are in the original recording</span>
      <div className="row">
        {[-0.2, -0.05, 0.05, 0.2].map((d) => (
          <button key={d} className="btn sm grow" onClick={() => onChange({ ...c, a: Math.min(Math.max(0, c.a + d), c.b - 0.1) }, true)}>
            In {d > 0 ? "+" : ""}{d}
          </button>
        ))}
      </div>
      <div className="row">
        {[-0.2, -0.05, 0.05, 0.2].map((d) => (
          <button key={d} className="btn sm grow" onClick={() => onChange({ ...c, b: Math.max(c.a + 0.1, c.b + d) }, true)}>
            Out {d > 0 ? "+" : ""}{d}
          </button>
        ))}
      </div>
      {take && take.video && take.video !== take.voice && (
        <div className="col" style={{ gap: 8 }}>
          <span className="eyebrow">Picture timing</span>
          <span className="faint small">If the screen runs ahead of or behind your voice, shift it. This applies to the whole recording.</span>
          <div className="row">
            {[[-0.1, "Earlier 0.1 s"], [-1 / 30, "1 frame"], [1 / 30, "1 frame"], [0.1, "Later 0.1 s"]].map(([d, l], i) => (
              <button key={i} className="btn sm grow" onClick={() => onNudge(take.id, d as number)} title={(d as number) < 0 ? "Picture earlier" : "Picture later"}>
                {(d as number) < 0 ? "-" : "+"}{l}
              </button>
            ))}
          </div>
          <span className="faint tiny mono">Now {take.offsets[0][1] >= 0 ? "+" : ""}{take.offsets[0][1].toFixed(2)} s{take.offsets.length > 1 ? ` (${take.offsets.length - 1} jumps)` : ""}</span>
        </div>
      )}
      <button className="btn danger" onClick={onDelete}><Trash2 size={15} /> Delete clip</button>
    </div>
  );
}

function OverlayPanel({ o, onChange, onDelete }: { o: Overlay; onChange: (o: Overlay, commit: boolean) => void; onDelete: () => void }) {
  return (
    <div className="inspector">
      <span className="eyebrow">Text</span>
      <div className="seg" style={{ alignSelf: "flex-start" }}>
        {([["label", "Chapter"], ["lower", "Lower third"], ["caption", "Caption"]] as const).map(([k, l]) => (
          <button key={k} className={o.kind === k ? "on" : ""} onClick={() => onChange({ ...o, kind: k }, true)}>{l}</button>
        ))}
      </div>
      <label className="field">Text<input className="input" value={o.text} onChange={(e) => onChange({ ...o, text: e.target.value }, false)} onBlur={() => onChange(o, true)} /></label>
      {o.kind !== "caption" && (
        <label className="field">Small tag<input className="input" value={o.tag ?? ""} onChange={(e) => onChange({ ...o, tag: e.target.value }, false)} onBlur={() => onChange(o, true)} /></label>
      )}
      {o.kind === "lower" && (
        <label className="field">Line under it<input className="input" value={o.sub ?? ""} onChange={(e) => onChange({ ...o, sub: e.target.value }, false)} onBlur={() => onChange(o, true)} /></label>
      )}
      <div className="row">
        <Num label="Shows at (s)" value={o.start} onChange={(v, commit) => onChange({ ...o, start: Math.max(0, v) }, commit)} />
        <Num label="For (s)" value={o.dur} min={0.5} onChange={(v, commit) => onChange({ ...o, dur: Math.max(0.5, v) }, commit)} />
      </div>
      <label className="row small muted" style={{ gap: 8, cursor: "pointer" }}>
        <span className={`switch ${o.chapter ? "on" : ""}`} onClick={() => onChange({ ...o, chapter: !o.chapter }, true)} />
        Use as a YouTube chapter
      </label>
      <button className="btn danger" onClick={onDelete}><Trash2 size={15} /> Delete</button>
    </div>
  );
}
