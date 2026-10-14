import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { AudioLines, Check, FileVideo, Image as ImageIcon, Loader2, Play, Plus, Trash2, Upload } from "lucide-react";
import { api, media } from "../api";
import type { Asset, CaptionSettings, Looks, Project, TextStyle } from "../types";
import { fmtTime } from "../util";
import { fontCss, hexA, inkCss } from "../looks";
import { CaptionSample } from "./Layers";
import { lookCss } from "./Player";

export function PanelHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="panel-head">
      <h3>{title}</h3>
      <div className="row" style={{ gap: 6 }}>{children}</div>
    </div>
  );
}

/* ---------------------------------------------------------------- media --- */
/** The built-in sounds: click to hear one, + to drop it at the playhead. */
function SoundEffects({ onAdd }: { onAdd: (name: string) => void }) {
  const [list, setList] = useState<{ id: string; name: string }[]>([]);
  const player = useRef<HTMLAudioElement | null>(null);
  useEffect(() => { api.sfx().then(setList).catch(() => {}); }, []);
  const hear = (id: string) => {
    player.current?.pause();
    player.current = new Audio(`/sfx/${id}.wav`);
    player.current.play().catch(() => {});
  };
  return (
    <div className="col" style={{ gap: 8 }}>
      <span className="eyebrow">Sound effects</span>
      <div className="sfx-grid">
        {list.map((s) => (
          <div key={s.id} className="sfx">
            <button className="sfx-play" onClick={() => hear(s.id)} title="Listen"><Play size={12} fill="currentColor" /> {s.name}</button>
            <button className="btn sm icon ghost" onClick={() => onAdd(s.id)} title="Add at the playhead"><Plus size={14} /></button>
          </div>
        ))}
      </div>
    </div>
  );
}

export function MediaPanel({ p, only, onImport, onAdd, onDelete, importing, onSfx }: {
  p: Project; only: "visual" | "audio"; importing: boolean;
  onImport: () => void; onAdd: (a: Asset, music?: boolean) => void; onDelete: (a: Asset) => void; onSfx?: (name: string) => void;
}) {
  const items = p.assets.filter((a) => (only === "audio" ? a.kind === "audio" && !a.sfx : a.kind !== "audio"));
  return (
    <div className="tool">
      <PanelHead title={only === "audio" ? "Music and sounds" : "Media"}>
        <button className="btn sm primary" onClick={onImport} disabled={importing}>
          {importing ? <Loader2 size={14} className="spin" /> : <Upload size={14} />} Import
        </button>
      </PanelHead>
      <div className="tool-body col" style={{ gap: 18 }}>
        {only === "audio" && onSfx && <SoundEffects onAdd={onSfx} />}
        {only === "audio" && <span className="eyebrow">Your music</span>}
        {!items.length ? (
          <div className="drop-hint">
            {only === "audio" ? <AudioLines size={26} /> : <FileVideo size={26} />}
            <b>{only === "audio" ? "Add music or sound effects" : "Add B-roll, pictures or clips"}</b>
            <span className="faint small">Drag files from Explorer onto this window, or press Import.</span>
          </div>
        ) : only === "audio" ? (
          <div className="col" style={{ gap: 6 }}>
            {items.map((a) => (
              <div key={a.id} className="arow" draggable onDragStart={(e) => { e.dataTransfer.setData("application/x-retake-asset", a.id); e.dataTransfer.effectAllowed = "copy"; }}>
                <span className="aic"><AudioLines size={16} /></span>
                <div className="grow col" style={{ gap: 1 }}>
                  <b className="small ellipsis">{a.name}</b>
                  <span className="faint tiny mono">{fmtTime(a.duration ?? 0)}{a.missing ? " · file moved" : ""}</span>
                </div>
                <button className="btn sm" onClick={() => onAdd(a, true)} title="Add under the whole video, quieter while you talk">Music</button>
                <button className="btn sm icon" onClick={() => onAdd(a, false)} title="Add at the playhead"><Plus size={14} /></button>
                <button className="btn ghost sm icon" onClick={() => onDelete(a)} title="Remove from project"><Trash2 size={14} /></button>
              </div>
            ))}
          </div>
        ) : (
          <div className="agrid">
            {items.map((a) => (
              <div key={a.id} className="acard" draggable onDragStart={(e) => { e.dataTransfer.setData("application/x-retake-asset", a.id); e.dataTransfer.effectAllowed = "copy"; }}
                onDoubleClick={() => onAdd(a)} title="Drag onto the Overlay track, or double-click to add at the playhead">
                <div className="athumb" style={{ backgroundImage: `url(${media.assetThumb(p.id, a.id)})` }}>
                  <span className="akind">{a.kind === "image" ? <ImageIcon size={11} /> : <FileVideo size={11} />}{a.kind === "video" ? ` ${fmtTime(a.duration ?? 0)}` : ""}</span>
                  {a.kind === "video" && !a.ready && <span className="aprep"><Loader2 size={12} className="spin" /> Preparing</span>}
                  <div className="aact">
                    <button className="btn sm icon primary" onClick={() => onAdd(a)} title="Add at the playhead"><Plus size={14} /></button>
                    <button className="btn sm icon" onClick={() => onDelete(a)} title="Remove from project"><Trash2 size={13} /></button>
                  </div>
                </div>
                <span className="tiny ellipsis">{a.name}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- text --- */
export function textStyleCss(st: TextStyle, looks: Looks, size: number): { wrap: CSSProperties; text: CSSProperties } {
  const box = st.box;
  return {
    wrap: box ? { background: hexA(box.color, box.alpha), padding: `${0.45 * box.pad * size}px ${box.pad * size}px`, borderRadius: box.radius * size } : {},
    text: { ...fontCss(looks, st.font), fontSize: size, lineHeight: 1.15, color: st.color, ...inkCss(size, st.outline, st.shadow, st.glow) },
  };
}

export function TextPanel({ looks, onText, onClassic }: {
  looks: Looks | null; onText: (style: string) => void; onClassic: (kind: "title" | "label" | "lower" | "caption") => void;
}) {
  return (
    <div className="tool">
      <PanelHead title="Text" />
      <div className="tool-body col" style={{ gap: 16 }}>
        <div className="col" style={{ gap: 8 }}>
          <span className="eyebrow">Styles</span>
          <div className="sgrid">
            {looks?.texts.map((st) => {
              const css = textStyleCss(st, looks, 22);
              return (
                <button key={st.id} className="scard" onClick={() => onText(st.id)} title={`Add "${st.name}" text at the playhead`}>
                  <span style={css.wrap}><span style={css.text}>{st.upper ? "ABC" : "Abc"}</span></span>
                  <i>{st.name}</i>
                </button>
              );
            })}
          </div>
        </div>
        <div className="col" style={{ gap: 8 }}>
          <span className="eyebrow">Tutorial graphics</span>
          <div className="col" style={{ gap: 6 }}>
            <button className="btn" style={{ justifyContent: "flex-start" }} onClick={() => onClassic("title")}>Title card (its own clip)</button>
            <button className="btn" style={{ justifyContent: "flex-start" }} onClick={() => onClassic("label")}>Chapter label</button>
            <button className="btn" style={{ justifyContent: "flex-start" }} onClick={() => onClassic("lower")}>Lower third</button>
            <button className="btn" style={{ justifyContent: "flex-start" }} onClick={() => onClassic("caption")}>Simple caption bar</button>
          </div>
        </div>
        <span className="faint tiny">Drag text in the preview to move it. Scroll over selected text to resize it.</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- captions --- */
const SWATCHES = ["#FFFFFF", "#FFE14D", "#FFD43B", "#3DFF8B", "#33E1FF", "#7C5CFF", "#FF4FD8", "#FF8A3D", "#FF6B6B", "#141414"];

export function Swatches({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div className="swatches">
      {SWATCHES.map((c) => (
        <button key={c} className={`sw ${value.toUpperCase() === c ? "on" : ""}`} style={{ background: c }} onClick={() => onChange(c)} aria-label={c} />
      ))}
      <label className="sw custom" title="Any colour">
        <input type="color" value={value} onChange={(e) => onChange(e.target.value.toUpperCase())} />
      </label>
    </div>
  );
}

export function Slider({ label, value, min, max, step, onChange, fmt }: {
  label: string; value: number; min: number; max: number; step: number; onChange: (v: number, commit: boolean) => void; fmt?: (v: number) => string;
}) {
  return (
    <label className="slider">
      <span className="spread"><span>{label}</span><span className="mono faint">{fmt ? fmt(value) : value.toFixed(2)}</span></span>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value), false)}
        onMouseUp={(e) => onChange(Number((e.target as HTMLInputElement).value), true)}
        onKeyUp={(e) => onChange(Number((e.target as HTMLInputElement).value), true)} />
    </label>
  );
}

export function CaptionsPanel({ looks, s, onChange }: { looks: Looks | null; s: CaptionSettings; onChange: (s: CaptionSettings, commit: boolean) => void }) {
  const [hover, setHover] = useState<string | null>(null);
  const tpl = looks?.captions.find((c) => c.id === (s.template ?? "pop")) ?? looks?.captions[0];
  const set = (patch: Partial<CaptionSettings>, commit = true) => onChange({ ...s, ...patch }, commit);
  return (
    <div className="tool">
      <PanelHead title="Captions">
        <label className="row small" style={{ gap: 8, cursor: "pointer" }} onClick={() => set({ on: !s.on })}>
          {s.on ? "On" : "Off"} <span className={`switch ${s.on ? "on" : ""}`} />
        </label>
      </PanelHead>
      <div className="tool-body col" style={{ gap: 16 }}>
        {!s.on && <div className="hint">Animated captions are made from your words, follow every cut, and are burned into the export. Pick a look to turn them on.</div>}
        <div className="cgrid">
          {looks?.captions.map((c) => (
            <button key={c.id} className={`ccard ${s.on && tpl?.id === c.id ? "on" : ""}`}
              onMouseEnter={() => setHover(c.id)} onMouseLeave={() => setHover(null)}
              onClick={() => set({ on: true, template: c.id, color: undefined, hi: undefined, font: undefined, upper: null, words: undefined, lines: undefined })}>
              <CaptionSample tpl={c} looks={looks} live={hover === c.id || (s.on === true && tpl?.id === c.id)} />
              <i>{c.name}{s.on && tpl?.id === c.id && <Check size={12} />}</i>
            </button>
          ))}
        </div>
        {s.on && tpl && (
          <div className="col" style={{ gap: 14 }}>
            <span className="eyebrow">Adjust</span>
            <Slider label="Size" value={s.scale ?? 1} min={0.5} max={1.8} step={0.05} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v, c) => set({ scale: v }, c)} />
            <Slider label="Height on screen" value={s.y ?? tpl.y} min={0.1} max={0.92} step={0.01} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v, c) => set({ y: v }, c)} />
            <Slider label="Words per caption" value={s.words ?? tpl.words} min={1} max={10} step={1} fmt={(v) => String(v)} onChange={(v, c) => set({ words: v }, c)} />
            <div className="row" style={{ gap: 8 }}>
              <div className="seg">
                {[[1, "1 line"], [2, "2 lines"]].map(([v, l]) => (
                  <button key={v} className={(s.lines ?? tpl.lines) === v ? "on" : ""} onClick={() => set({ lines: v as number })}>{l}</button>
                ))}
              </div>
              <div className="seg">
                {[[false, "Aa"], [true, "AA"]].map(([v, l]) => (
                  <button key={String(v)} className={(s.upper ?? tpl.upper ?? false) === v ? "on" : ""} onClick={() => set({ upper: v as boolean })}>{l as string}</button>
                ))}
              </div>
            </div>
            <label className="field">Text colour<Swatches value={s.color ?? tpl.color} onChange={(c) => set({ color: c })} /></label>
            {tpl.mode !== "plain" && <label className="field">Highlight<Swatches value={s.hi ?? tpl.hi} onChange={(c) => set({ hi: c })} /></label>}
            <label className="field">Font
              <select className="select" value={s.font ?? tpl.font} onChange={(e) => set({ font: e.target.value })}>
                {Object.keys(looks?.fonts ?? {}).map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </label>
            <span className="faint tiny">Fix a misheard word: double-click it in the transcript.</span>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------- transitions --- */
export function TransitionsPanel({ looks, current, dur, canApply, onApply, onAll, onDur }: {
  looks: Looks | null; current: string | null; dur: number; canApply: boolean;
  onApply: (type: string | null) => void; onAll: (type: string | null) => void; onDur: (d: number, commit: boolean) => void;
}) {
  const [hover, setHover] = useState<string | null>(null);
  return (
    <div className="tool">
      <PanelHead title="Transitions" />
      <div className="tool-body col" style={{ gap: 14 }}>
        <div className="hint">{canApply ? "Pick a transition for the selected cut." : "Select a cut on the timeline (the little marks between clips), or the transition goes on the cut nearest the playhead."}</div>
        <div className="tgrid">
          <button className={`tcard ${!current ? "on" : ""}`} onClick={() => onApply(null)}>
            <span className="tdemo none"><span>A</span><span>B</span></span><i>Cut</i>
          </button>
          {looks?.transitions.map((t) => (
            <button key={t.id} className={`tcard ${current === t.id ? "on" : ""}`} onClick={() => onApply(t.id)} onMouseEnter={() => setHover(t.id)} onMouseLeave={() => setHover(null)}>
              <span className={`tdemo ${t.id} ${hover === t.id ? "play" : ""}`}><span>A</span><span>B</span></span>
              <i>{t.name}</i>
            </button>
          ))}
        </div>
        <Slider label="Length" value={dur} min={0.2} max={2} step={0.05} fmt={(v) => `${v.toFixed(2)} s`} onChange={onDur} />
        <div className="row" style={{ gap: 6 }}>
          <button className="btn sm grow" onClick={() => onAll(current)} disabled={!current}>Use on every cut</button>
          <button className="btn sm ghost" onClick={() => onAll(null)}>Clear all</button>
        </div>
        <span className="faint tiny">The preview shows a quick version; the export blends the two clips for real.</span>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- filters --- */
export function FiltersPanel({ looks, frameUrl, current, count, onApply, onAll }: {
  looks: Looks | null; frameUrl: string | null; current: string | null; count: number;
  onApply: (id: string) => void; onAll: (id: string) => void;
}) {
  return (
    <div className="tool">
      <PanelHead title="Filters" />
      <div className="tool-body col" style={{ gap: 14 }}>
        <div className="hint">{count ? `Applies to the ${count} selected clip${count > 1 ? "s" : ""}.` : "Applies to the clip under the playhead. Select clips to colour several at once."}</div>
        <div className="fgrid">
          {looks?.filters.map((f) => {
            const css = lookCss(f.adj as Record<string, number>);
            return (
              <button key={f.id} className={`fcard ${current === f.id ? "on" : ""}`} onClick={() => onApply(f.id)}>
                <span className="fthumb" style={{ backgroundImage: frameUrl ? `url(${frameUrl})` : undefined, filter: css.filter || undefined }}>
                  {css.tint && <span style={{ position: "absolute", inset: 0, background: css.tint, mixBlendMode: "soft-light" }} />}
                  {css.vignette > 0 && <span style={{ position: "absolute", inset: 0, background: `radial-gradient(ellipse at center, transparent 40%, rgba(0,0,0,${css.vignette * 0.8}) 100%)` }} />}
                </span>
                <i>{f.name}</i>
              </button>
            );
          })}
        </div>
        <button className="btn sm" onClick={() => current && onAll(current)} disabled={!current}>Use this look on every clip</button>
        <span className="faint tiny">Fine-tune brightness, contrast, warmth and more on the clip panel on the right.</span>
      </div>
    </div>
  );
}
