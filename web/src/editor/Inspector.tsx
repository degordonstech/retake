import { useState } from "react";
import { AlignCenter, Bot, Check, Copy, ListOrdered, Trash2, TriangleAlert, Volume2, VolumeX } from "lucide-react";
import type { Adjust, Asset, AudioItem, Clip, Framing, Looks, MediaClip, MediaItem, Overlay, Project, Transcript } from "../types";
import { fmtTime } from "../util";
import { clipDur, isTitle, wordTime } from "./model";
import { framingOf } from "./Player";
import { Slider, Swatches } from "./Panels";

const SOURCE_NAME: Record<string, string> = { claude_code: "Claude Code", anthropic: "Claude", groq: "Groq", rules: "the built-in editor" };

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

export function Summary({ p, clips, overlays, transcripts, onSeek }: { p: Project; clips: Clip[]; overlays: Overlay[]; transcripts: Record<string, Transcript>; onSeek: (t: number) => void }) {
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
        Tip: select a clip to change its speed, colour or framing. Click a mark between two clips to add a transition.
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

function Seg<T extends string | number | boolean>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="seg">
      {options.map(([v, l]) => <button key={String(v)} className={value === v ? "on" : ""} onClick={() => onChange(v)}>{l}</button>)}
    </div>
  );
}

function Tabs<T extends string>({ value, tabs, onChange }: { value: T; tabs: [T, string][]; onChange: (t: T) => void }) {
  return (
    <div className="itabs">
      {tabs.map(([v, l]) => <button key={v} className={value === v ? "on" : ""} onClick={() => onChange(v)}>{l}</button>)}
    </div>
  );
}

function Toggle({ on, label, onChange }: { on: boolean; label: string; onChange: (v: boolean) => void }) {
  return (
    <label className="row small muted" style={{ gap: 8, cursor: "pointer" }} onClick={() => onChange(!on)}>
      <span className={`switch ${on ? "on" : ""}`} /> {label}
    </label>
  );
}

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

/* ----------------------------------------------------------------- clips --- */
interface ClipProps {
  p: Project;
  looks: Looks | null;
  c: Clip;
  aspect: string;
  onChange: (c: Clip, commit: boolean) => void;
  onDelete: () => void;
  onNudge: (take: string, delta: number) => void;
}

export function ClipPanel({ p, looks, c, aspect, onChange, onDelete, onNudge }: ClipProps) {
  const [tab, setTab] = useState<"edit" | "speed" | "audio" | "color" | "frame">("edit");
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
      <div className="spread">
        <b className="ellipsis">{take?.name}</b>
        <span className="faint tiny mono">{fmtTime(clipDur(c), true)}</span>
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[["edit", "Edit"], ["speed", "Speed"], ["audio", "Audio"], ["color", "Colour"], ["frame", "Frame"]]} />
      {tab === "edit" && <EditTab p={p} c={c} onChange={onChange} onNudge={onNudge} />}
      {tab === "speed" && <SpeedTab c={c} onChange={onChange} />}
      {tab === "audio" && <AudioTab c={c} onChange={onChange} />}
      {tab === "color" && <ColorTab looks={looks} c={c} onChange={onChange} />}
      {tab === "frame" && take?.video && <FrameTab c={c} f={framingOf(c, take, aspect)} raw={c.frame ?? {}} onChange={onChange} />}
      {tab === "frame" && !take?.video && <span className="faint small">This clip is voice only, so there's no picture to frame.</span>}
      <button className="btn danger" onClick={onDelete} style={{ marginTop: "auto" }}><Trash2 size={15} /> Delete clip</button>
    </div>
  );
}

function EditTab({ p, c, onChange, onNudge }: { p: Project; c: MediaClip; onChange: (c: Clip, commit: boolean) => void; onNudge: (take: string, delta: number) => void }) {
  const take = p.takes.find((t) => t.id === c.take);
  return (
    <>
      <div className="row">
        <Num label="Starts at (s)" value={c.a} onChange={(v, commit) => onChange({ ...c, a: Math.min(Math.max(0, v), c.b - 0.1) }, commit)} />
        <Num label="Ends at (s)" value={c.b} onChange={(v, commit) => onChange({ ...c, b: Math.max(Math.min(take?.duration ?? v, v), c.a + 0.1) }, commit)} />
      </div>
      <span className="muted small">Times are in the original recording.</span>
      <div className="row">
        {[-0.2, -0.05, 0.05, 0.2].map((d) => (
          <button key={d} className="btn sm grow" onClick={() => onChange({ ...c, a: Math.min(Math.max(0, c.a + d), c.b - 0.1) }, true)}>In {d > 0 ? "+" : ""}{d}</button>
        ))}
      </div>
      <div className="row">
        {[-0.2, -0.05, 0.05, 0.2].map((d) => (
          <button key={d} className="btn sm grow" onClick={() => onChange({ ...c, b: Math.max(c.a + 0.1, c.b + d) }, true)}>Out {d > 0 ? "+" : ""}{d}</button>
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
    </>
  );
}

function SpeedTab({ c, onChange }: { c: MediaClip; onChange: (c: Clip, commit: boolean) => void }) {
  const sp = c.speed ?? 1;
  return (
    <>
      <div className="speed-grid">
        {SPEEDS.map((s) => <button key={s} className={`btn sm ${sp === s ? "primary" : ""}`} onClick={() => onChange({ ...c, speed: s }, true)}>{s}x</button>)}
      </div>
      <Slider label="Speed" value={sp} min={0.25} max={4} step={0.05} fmt={(v) => `${v.toFixed(2)}x`} onChange={(v, commit) => onChange({ ...c, speed: Math.round(v * 100) / 100 }, commit)} />
      <span className="faint small">Your voice keeps its pitch. {sp !== 1 ? `This clip now runs ${fmtTime((c.b - c.a) / sp, true)} instead of ${fmtTime(c.b - c.a, true)}.` : "Speed up long waits, slow down a quick click."}</span>
    </>
  );
}

function AudioTab({ c, onChange }: { c: MediaClip; onChange: (c: Clip, commit: boolean) => void }) {
  const vol = c.volume ?? 1;
  return (
    <>
      <div className="row">
        <button className={`btn sm ${c.mute ? "primary" : ""}`} onClick={() => onChange({ ...c, mute: !c.mute }, true)}>
          {c.mute ? <VolumeX size={14} /> : <Volume2 size={14} />} {c.mute ? "Muted" : "Mute"}
        </button>
      </div>
      <Slider label="Volume" value={vol} min={0} max={2} step={0.05} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v, commit) => onChange({ ...c, volume: v }, commit)} />
      <span className="faint small">The whole video's sound is levelled at export, so small changes are enough.</span>
    </>
  );
}

const ADJ: [keyof Adjust, string, number, number][] = [
  ["brightness", "Brightness", -0.5, 0.5],
  ["contrast", "Contrast", -0.5, 0.6],
  ["saturation", "Saturation", -1, 1],
  ["temperature", "Warmth", -1, 1],
  ["vignette", "Vignette", 0, 1],
  ["sharpen", "Sharpen", 0, 1],
];

function ColorTab({ looks, c, onChange }: { looks: Looks | null; c: MediaClip; onChange: (c: Clip, commit: boolean) => void }) {
  const adj = c.adjust ?? {};
  return (
    <>
      <label className="field">Filter
        <select className="select" value={c.filter ?? "none"} onChange={(e) => onChange({ ...c, filter: e.target.value }, true)}>
          {looks?.filters.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
      </label>
      {ADJ.map(([k, label, min, max]) => (
        <Slider key={k} label={label} value={adj[k] ?? 0} min={min} max={max} step={0.01} fmt={(v) => `${v > 0 ? "+" : ""}${Math.round(v * 100)}`}
          onChange={(v, commit) => onChange({ ...c, adjust: { ...adj, [k]: v } }, commit)} />
      ))}
      <button className="btn sm ghost" onClick={() => onChange({ ...c, adjust: {}, filter: "none" }, true)}>Reset colour</button>
    </>
  );
}

function FrameTab({ c, f, raw, onChange }: { c: MediaClip; f: ReturnType<typeof framingOf>; raw: Framing; onChange: (c: Clip, commit: boolean) => void }) {
  const set = (patch: Partial<Framing>, commit = true) => onChange({ ...c, frame: { ...raw, ...patch } }, commit);
  const kb = (raw.zoomTo ?? raw.zoom ?? 1) !== (raw.zoom ?? 1);
  return (
    <>
      <label className="field">Fit
        <Seg value={f.mode} options={[["fit", "Show all"], ["fill", "Fill frame"]]} onChange={(v) => set({ mode: v as "fit" | "fill" })} />
      </label>
      {f.mode === "fit" && (
        <label className="field">Background
          <Seg value={f.bg} options={[["blur", "Blurred"], ["color", "Brand colour"]]} onChange={(v) => set({ bg: v as "blur" | "color" })} />
        </label>
      )}
      <Slider label={kb ? "Zoom at start" : "Zoom"} value={raw.zoom ?? 1} min={1} max={3} step={0.01} fmt={(v) => `${Math.round(v * 100)}%`}
        onChange={(v, commit) => set(kb ? { zoom: v } : { zoom: v, zoomTo: v }, commit)} />
      <Toggle on={kb} label="Slow zoom over the clip (Ken Burns)" onChange={(on) => set(on ? { zoomTo: Math.min(3, (raw.zoom ?? 1) + 0.25) } : { zoomTo: raw.zoom ?? 1 })} />
      {kb && <Slider label="Zoom at end" value={raw.zoomTo ?? 1} min={1} max={3} step={0.01} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v, commit) => set({ zoomTo: v }, commit)} />}
      <Slider label="Focus left to right" value={f.x} min={0} max={1} step={0.01} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v, commit) => set({ x: v }, commit)} />
      <Slider label="Focus top to bottom" value={f.y} min={0} max={1} step={0.01} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v, commit) => set({ y: v }, commit)} />
      <div className="row" style={{ gap: 6 }}>
        <button className="btn sm grow" onClick={() => set({ zoom: 1.6, zoomTo: 1.6 })}>Punch in</button>
        <button className="btn sm grow" onClick={() => set({ zoom: 1, zoomTo: 1.25 })}>Push in</button>
        <button className="btn sm ghost" onClick={() => onChange({ ...c, frame: undefined }, true)}>Reset</button>
      </div>
      <span className="faint tiny">Zoom into code or a button so it reads on a phone. The focus point moves towards the middle.</span>
    </>
  );
}

/* -------------------------------------------------------------- batches --- */
export function ClipsPanel({ clips, looks, onBatch, onDelete }: { clips: Clip[]; looks: Looks | null; onBatch: (fn: (c: MediaClip) => MediaClip) => void; onDelete: () => void }) {
  const d = clips.reduce((s, c) => s + clipDur(c), 0);
  return (
    <div className="inspector">
      <span className="eyebrow">{clips.length} clips selected</span>
      <p className="muted small">{fmtTime(d, true)} in total. Changes here apply to all of them.</p>
      <span className="eyebrow">Speed</span>
      <div className="speed-grid">
        {SPEEDS.map((s) => <button key={s} className="btn sm" onClick={() => onBatch((c) => ({ ...c, speed: s }))}>{s}x</button>)}
      </div>
      <label className="field">Filter
        <select className="select" defaultValue="" onChange={(e) => e.target.value && onBatch((c) => ({ ...c, filter: e.target.value }))}>
          <option value="" disabled>Choose a look</option>
          {looks?.filters.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
      </label>
      <div className="row" style={{ gap: 6 }}>
        <button className="btn sm grow" onClick={() => onBatch((c) => ({ ...c, mute: true }))}><VolumeX size={14} /> Mute</button>
        <button className="btn sm grow" onClick={() => onBatch((c) => ({ ...c, mute: false }))}><Volume2 size={14} /> Unmute</button>
      </div>
      <button className="btn danger" onClick={onDelete}><Trash2 size={15} /> Delete clips</button>
    </div>
  );
}

/* ------------------------------------------------------------------ cut --- */
export function CutPanel({ looks, c, onChange }: { looks: Looks | null; c: Clip; onChange: (c: Clip, commit: boolean) => void }) {
  const tr = c.transition;
  return (
    <div className="inspector">
      <span className="eyebrow">Transition into this clip</span>
      <div className="tlist">
        <button className={`btn sm ${!tr ? "primary" : ""}`} onClick={() => onChange({ ...c, transition: undefined }, true)}>Cut</button>
        {looks?.transitions.map((t) => (
          <button key={t.id} className={`btn sm ${tr?.type === t.id ? "primary" : ""}`} onClick={() => onChange({ ...c, transition: { type: t.id, dur: tr?.dur ?? 0.5 } }, true)}>{t.name}</button>
        ))}
      </div>
      {tr && <Slider label="Length" value={tr.dur} min={0.2} max={2} step={0.05} fmt={(v) => `${v.toFixed(2)} s`} onChange={(v, commit) => onChange({ ...c, transition: { ...tr, dur: v } }, commit)} />}
      <span className="faint tiny">The transition is centred on the cut and borrows a few frames from either side.</span>
    </div>
  );
}

/* ----------------------------------------------------------------- text --- */
export function TextItemPanel({ o, looks, onChange, onDelete }: { o: Overlay; looks: Looks | null; onChange: (o: Overlay, commit: boolean) => void; onDelete: () => void }) {
  const st = looks?.texts.find((s) => s.id === o.style) ?? looks?.texts[0];
  const set = (patch: Partial<Overlay>, commit = true) => onChange({ ...o, ...patch }, commit);
  return (
    <div className="inspector">
      <span className="eyebrow">Text</span>
      <textarea className="input" rows={3} value={o.text} onChange={(e) => set({ text: e.target.value }, false)} onBlur={() => onChange(o, true)} />
      <label className="field">Style
        <select className="select" value={o.style ?? "headline"} onChange={(e) => set({ style: e.target.value, color: undefined, accent: undefined, font: undefined, size: undefined })}>
          {looks?.texts.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </label>
      <label className="field">Font
        <select className="select" value={o.font ?? st?.font} onChange={(e) => set({ font: e.target.value })}>
          {Object.keys(looks?.fonts ?? {}).map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
      </label>
      <Slider label="Size" value={o.size ?? st?.size ?? 80} min={16} max={260} step={1} fmt={(v) => `${Math.round(v)}`} onChange={(v, commit) => set({ size: v }, commit)} />
      <label className="field">Colour<Swatches value={o.color ?? st?.color ?? "#FFFFFF"} onChange={(c) => set({ color: c })} /></label>
      {(st?.box || st?.glow) && <label className="field">{st?.box ? "Box" : "Glow"}<Swatches value={o.accent ?? st?.box?.color ?? st?.glow ?? "#FF8A3D"} onChange={(c) => set({ accent: c })} /></label>}
      <div className="row" style={{ gap: 8 }}>
        <Seg value={o.upper ?? st?.upper ?? false} options={[[false, "Aa"], [true, "AA"]]} onChange={(v) => set({ upper: v })} />
        <button className="btn sm" onClick={() => set({ x: 0.5, y: 0.5 })}><AlignCenter size={14} /> Centre</button>
      </div>
      <Slider label="Across" value={o.x ?? 0.5} min={0} max={1} step={0.005} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v, commit) => set({ x: v }, commit)} />
      <Slider label="Down" value={o.y ?? 0.5} min={0} max={1} step={0.005} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v, commit) => set({ y: v }, commit)} />
      <label className="field">Comes in
        <select className="select" value={o.anim ?? "pop"} onChange={(e) => set({ anim: e.target.value })}>
          {[["none", "Just appears"], ["fade", "Fade"], ["pop", "Pop"], ["up", "Rise up"], ["left", "Slide in"], ["type", "Typewriter"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </label>
      <label className="field">Goes out
        <Seg value={o.out ?? "fade"} options={[["fade", "Fade"], ["none", "Cut"]]} onChange={(v) => set({ out: v })} />
      </label>
      <div className="row">
        <Num label="Shows at (s)" value={o.start} onChange={(v, commit) => set({ start: Math.max(0, v) }, commit)} />
        <Num label="For (s)" value={o.dur} min={0.3} onChange={(v, commit) => set({ dur: Math.max(0.3, v) }, commit)} />
      </div>
      <button className="btn danger" onClick={onDelete}><Trash2 size={15} /> Delete</button>
    </div>
  );
}

export function OverlayPanel({ o, onChange, onDelete }: { o: Overlay; onChange: (o: Overlay, commit: boolean) => void; onDelete: () => void }) {
  return (
    <div className="inspector">
      <span className="eyebrow">Graphic</span>
      <Seg value={o.kind} options={[["label", "Chapter"], ["lower", "Lower third"], ["caption", "Caption"]]} onChange={(k) => onChange({ ...o, kind: k }, true)} />
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
      <Toggle on={!!o.chapter} label="Use as a YouTube chapter" onChange={(v) => onChange({ ...o, chapter: v }, true)} />
      <button className="btn danger" onClick={onDelete}><Trash2 size={15} /> Delete</button>
    </div>
  );
}

/* ---------------------------------------------------------------- media --- */
export function MediaItemPanel({ m, a, onChange, onDelete }: { m: MediaItem; a?: Asset; onChange: (m: MediaItem, commit: boolean) => void; onDelete: () => void }) {
  const set = (patch: Partial<MediaItem>, commit = true) => onChange({ ...m, ...patch }, commit);
  return (
    <div className="inspector">
      <span className="eyebrow">{a?.kind === "image" ? "Picture" : "Video"} overlay</span>
      <b className="ellipsis small">{a?.name ?? "Missing file"}</b>
      <label className="field">Show as
        <Seg value={m.mode ?? "pip"} options={[["full", "Full screen"], ["pip", "Picture in picture"]]} onChange={(v) => set({ mode: v as "full" | "pip" })} />
      </label>
      {m.mode !== "full" && (
        <>
          <Slider label="Size" value={m.scale ?? 0.4} min={0.08} max={1} step={0.01} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v, c) => set({ scale: v }, c)} />
          <Slider label="Across" value={m.x ?? 0.72} min={0} max={1} step={0.005} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v, c) => set({ x: v }, c)} />
          <Slider label="Down" value={m.y ?? 0.32} min={0} max={1} step={0.005} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v, c) => set({ y: v }, c)} />
          <Slider label="Rounded corners" value={m.radius ?? 0.06} min={0} max={0.5} step={0.01} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v, c) => set({ radius: v }, c)} />
          <div className="row" style={{ gap: 6 }}>
            {[["Top left", 0.22, 0.24], ["Top right", 0.78, 0.24], ["Bottom left", 0.22, 0.76], ["Bottom right", 0.78, 0.76]].map(([l, x, y]) => (
              <button key={l as string} className="btn sm grow" onClick={() => set({ x: x as number, y: y as number })} title={l as string}>{(l as string).split(" ").map((w) => w[0].toUpperCase()).join("")}</button>
            ))}
          </div>
        </>
      )}
      <Slider label="Opacity" value={m.opacity ?? 1} min={0.1} max={1} step={0.01} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v, c) => set({ opacity: v }, c)} />
      <label className="field">Comes in
        <Seg value={m.anim ?? "fade"} options={[["none", "Cut"], ["fade", "Fade"], ["up", "Rise"], ["left", "Slide"]]} onChange={(v) => set({ anim: v })} />
      </label>
      {a?.kind === "video" && a.has_audio && (
        <Slider label="Its sound" value={m.volume ?? 0} min={0} max={1.5} step={0.05} fmt={(v) => (v ? `${Math.round(v * 100)}%` : "Off")} onChange={(v, c) => set({ volume: v }, c)} />
      )}
      <div className="row">
        <Num label="Shows at (s)" value={m.start} onChange={(v, c) => set({ start: Math.max(0, v) }, c)} />
        <Num label="For (s)" value={m.dur} min={0.2} onChange={(v, c) => set({ dur: Math.max(0.2, v) }, c)} />
      </div>
      {a?.kind === "video" && <Num label="Starts from (s into the file)" value={m.in ?? 0} onChange={(v, c) => set({ in: Math.max(0, v) }, c)} />}
      <button className="btn danger" onClick={onDelete}><Trash2 size={15} /> Remove</button>
    </div>
  );
}

export function AudioItemPanel({ s, a, onChange, onDelete }: { s: AudioItem; a?: Asset; onChange: (s: AudioItem, commit: boolean) => void; onDelete: () => void }) {
  const set = (patch: Partial<AudioItem>, commit = true) => onChange({ ...s, ...patch }, commit);
  return (
    <div className="inspector">
      <span className="eyebrow">Audio</span>
      <b className="ellipsis small">{a?.name ?? "Missing file"}</b>
      <Slider label="Volume" value={s.volume ?? 0.5} min={0} max={1.5} step={0.01} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v, c) => set({ volume: v }, c)} />
      <Toggle on={s.duck ?? false} label="Quieter while I talk (ducking)" onChange={(v) => set({ duck: v })} />
      <Toggle on={s.loop ?? false} label="Loop to fill its length" onChange={(v) => set({ loop: v })} />
      <Slider label="Fade in" value={s.fadeIn ?? 0} min={0} max={6} step={0.1} fmt={(v) => `${v.toFixed(1)} s`} onChange={(v, c) => set({ fadeIn: v }, c)} />
      <Slider label="Fade out" value={s.fadeOut ?? 0} min={0} max={8} step={0.1} fmt={(v) => `${v.toFixed(1)} s`} onChange={(v, c) => set({ fadeOut: v }, c)} />
      <div className="row">
        <Num label="Starts at (s)" value={s.start} onChange={(v, c) => set({ start: Math.max(0, v) }, c)} />
        <Num label="For (s)" value={s.dur} min={0.2} onChange={(v, c) => set({ dur: Math.max(0.2, v) }, c)} />
      </div>
      <Num label="From (s into the file)" value={s.in ?? 0} onChange={(v, c) => set({ in: Math.max(0, v) }, c)} />
      <button className="btn danger" onClick={onDelete}><Trash2 size={15} /> Remove</button>
    </div>
  );
}
