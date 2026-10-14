import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AudioLines, Film, Gauge, Image as ImageIcon, Music, Sparkles, Type } from "lucide-react";
import { api, media } from "../api";
import type { Asset, Clip, Edit, MediaClip, Project, Source, Take } from "../types";
import { clamp, fmtTime, KIND_COLOR } from "../util";
import { clipDur, isTitle, offsetAt, speedOf, starts, totalDuration } from "./model";

const RULER = 28;
const MAIN_H = 92;
const TEXT_H = 38;
const MEDIA_H = 44;
const AUDIO_H = 44;

export type ItemKind = "overlay" | "media" | "audio";

/** Stack overlapping items into rows, first come first served. */
function lanes<T extends { id: string; start: number; dur: number }>(items: T[]): { lane: Record<string, number>; count: number } {
  const ends: number[] = [];
  const lane: Record<string, number> = {};
  for (const it of [...items].sort((a, b) => a.start - b.start)) {
    let k = ends.findIndex((e) => e <= it.start + 1e-3);
    if (k < 0) { k = ends.length; ends.push(0); }
    ends[k] = it.start + it.dur;
    lane[it.id] = k;
  }
  return { lane, count: Math.max(1, ends.length) };
}
export type Sel = { kind: ItemKind; id: string } | { kind: "cut"; index: number } | null;

interface Props {
  p: Project;
  edit: Edit;
  time: number;
  zoom: number; // pixels per second
  setZoom: (z: number) => void;
  selected: Set<string>;
  sel: Sel;
  peaks: Record<string, number[]>;
  playing: boolean;
  onSeek: (t: number) => void;
  onSelectClip: (id: string | null, additive: boolean) => void;
  onSel: (s: Sel) => void;
  onTrim: (id: string, side: "a" | "b", value: number, commit: boolean) => void;
  onMove: (id: string, toIndex: number) => void;
  onItem: (kind: ItemKind, id: string, start: number, dur: number, inPoint: number | undefined, commit: boolean) => void;
  onDropAsset: (assetId: string, track: "media" | "audio", t: number) => void;
}

export default function Timeline(props: Props) {
  const { p, edit, time, zoom, setZoom, selected, sel, peaks, playing } = props;
  const clips = edit.clips;
  const scroller = useRef<HTMLDivElement>(null);
  const [drop, setDropState] = useState<{ index: number; x: number } | null>(null);
  const dropRef = useRef<{ index: number; x: number } | null>(null);
  const setDrop = (d: { index: number; x: number } | null) => { dropRef.current = d; setDropState(d); };
  const [dragId, setDragId] = useState<string | null>(null);
  const [hotTrack, setHotTrack] = useState<string | null>(null);
  const total = totalDuration(clips);
  const st = useMemo(() => starts(clips), [clips]);
  const ends = Math.max(total, ...edit.media.map((m) => m.start + m.dur), ...edit.audio.map((a) => a.start + a.dur), ...edit.overlays.map((o) => o.start + o.dur));
  const width = Math.max(ends * zoom + 400, 800);
  const takes = useMemo(() => Object.fromEntries(p.takes.map((t) => [t.id, t])), [p.takes]);
  const sources = useMemo(() => Object.fromEntries(p.sources.map((s) => [s.id, s])), [p.sources]);
  const assets = useMemo(() => Object.fromEntries(p.assets.map((a) => [a.id, a])), [p.assets]);

  // Keep the playhead in view while playing.
  useEffect(() => {
    const el = scroller.current;
    if (!el || !playing) return;
    const x = time * zoom;
    if (x > el.scrollLeft + el.clientWidth - 80 || x < el.scrollLeft) el.scrollLeft = x - 120;
  }, [time, zoom, playing]);

  // Ctrl + wheel zooms around the mouse; plain wheel scrolls sideways.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (e.ctrlKey) {
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const tAtMouse = (el.scrollLeft + mx) / zoom;
        const next = clamp(zoom * (e.deltaY < 0 ? 1.18 : 1 / 1.18), 2, 400);
        setZoom(next);
        requestAnimationFrame(() => (el.scrollLeft = tAtMouse * next - mx));
      } else if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        el.scrollLeft += e.deltaY;
      }
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [zoom, setZoom]);

  const tAt = useCallback((clientX: number, limit = total) => {
    const el = scroller.current!;
    return clamp((clientX - el.getBoundingClientRect().left + el.scrollLeft) / zoom, 0, limit);
  }, [zoom, total]);

  const seekDrag = (e: React.MouseEvent) => {
    props.onSeek(tAt(e.clientX));
    const move = (ev: MouseEvent) => props.onSeek(tAt(ev.clientX));
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  /** Edges an item snaps to: the playhead, clip cuts, and other items. */
  const snaps = useMemo(() => {
    const s = [0, total, ...st];
    edit.media.forEach((m) => s.push(m.start, m.start + m.dur));
    edit.overlays.forEach((o) => s.push(o.start, o.start + o.dur));
    edit.audio.forEach((a) => s.push(a.start, a.start + a.dur));
    return s;
  }, [st, total, edit.media, edit.overlays, edit.audio]);
  const snap = (v: number, self: number[] = []) => {
    const tol = 8 / zoom;
    let best = v, dist = tol;
    for (const s of [...snaps, time]) {
      if (self.some((x) => Math.abs(x - s) < 1e-6)) continue;
      if (Math.abs(s - v) < dist) { best = s; dist = Math.abs(s - v); }
    }
    return best;
  };

  /* --------------------------------------------------- clip interactions */
  const startClipDrag = (e: React.MouseEvent, c: Clip, index: number) => {
    e.stopPropagation();
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    props.onSelectClip(c.id, additive);
    const x0 = e.clientX;
    let moved = false;
    const move = (ev: MouseEvent) => {
      if (!moved && Math.abs(ev.clientX - x0) < 5) return;
      moved = true;
      setDragId(c.id);
      const t = tAt(ev.clientX);
      let idx = clips.length;
      for (let k = 0; k < clips.length; k++) {
        if (t < st[k] + clipDur(clips[k]) / 2) { idx = k; break; }
      }
      const x = (idx < clips.length ? st[idx] : total) * zoom;
      setDrop({ index: idx, x });
    };
    const up = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      setDragId(null);
      const d = dropRef.current;
      if (moved && d && d.index !== index && d.index !== index + 1) props.onMove(c.id, d.index);
      setDrop(null);
      if (!moved) props.onSeek(tAt(ev.clientX));
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const startTrim = (e: React.MouseEvent, c: Clip, side: "a" | "b") => {
    e.stopPropagation();
    props.onSelectClip(c.id, false);
    const x0 = e.clientX;
    const base = isTitle(c) ? c.dur : side === "a" ? c.a : c.b;
    const sp = speedOf(c);
    let last = base;
    const move = (ev: MouseEvent) => {
      const dt = ((ev.clientX - x0) / zoom) * sp;
      last = isTitle(c) ? Math.max(0.5, base + dt) : base + dt;
      props.onTrim(c.id, side, last, false);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      props.onTrim(c.id, side, last, true);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  /* ---------------------------------------------- items: text/media/audio */
  const startItem = (e: React.MouseEvent, kind: ItemKind, it: { id: string; start: number; dur: number; in?: number }, mode: "move" | "l" | "r", maxLen?: number) => {
    e.stopPropagation();
    props.onSel({ kind, id: it.id });
    props.onSelectClip(null, false);
    const x0 = e.clientX;
    let ns = it.start, nd = it.dur, ni = it.in;
    let moved = false;
    const move = (ev: MouseEvent) => {
      const dt = (ev.clientX - x0) / zoom;
      if (Math.abs(ev.clientX - x0) > 3) moved = true;
      if (mode === "move") ns = Math.max(0, snap(it.start + dt, [it.start]));
      if (mode === "move" && ns === it.start + dt) {
        // Snap the end too.
        const se = snap(it.start + dt + it.dur, [it.start + it.dur]);
        ns = Math.max(0, se - it.dur);
      }
      if (mode === "l") {
        ns = clamp(snap(it.start + dt, [it.start]), 0, it.start + it.dur - 0.2);
        if (it.in !== undefined) { ni = Math.max(0, it.in + (ns - it.start)); ns = it.start + (ni - it.in); }
        nd = it.dur - (ns - it.start);
      }
      if (mode === "r") {
        nd = Math.max(0.2, snap(it.start + it.dur + dt, [it.start + it.dur]) - it.start);
        if (maxLen !== undefined) nd = Math.min(nd, maxLen - (it.in ?? 0));
      }
      props.onItem(kind, it.id, ns, nd, ni, false);
    };
    const up = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      if (moved) props.onItem(kind, it.id, ns, nd, ni, true);
      else props.onSeek(tAt(ev.clientX, ends));
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const dropOn = (track: "media" | "audio") => ({
    onDragOver: (e: React.DragEvent) => {
      if (e.dataTransfer.types.includes("application/x-retake-asset")) { e.preventDefault(); setHotTrack(track); }
    },
    onDragLeave: () => setHotTrack(null),
    onDrop: (e: React.DragEvent) => {
      setHotTrack(null);
      const id = e.dataTransfer.getData("application/x-retake-asset");
      if (id) { e.preventDefault(); props.onDropAsset(id, track, snap(tAt(e.clientX, ends + 60))); }
    },
  });

  const selId = sel && sel.kind !== "cut" ? sel.id : null;
  const textL = useMemo(() => lanes(edit.overlays), [edit.overlays]);
  const mediaL = useMemo(() => lanes(edit.media), [edit.media]);
  const audioL = useMemo(() => lanes(edit.audio), [edit.audio]);
  const textH = TEXT_H * textL.count, mediaH = MEDIA_H * mediaL.count, audioH = AUDIO_H * audioL.count;
  const laneStyle = (k: number, h: number) => ({ top: k * h + 4, bottom: "auto", height: h - 8 });

  return (
    <div className="tl-body">
      <div className="tl-heads">
        <div className="ruler-pad" />
        <div className="tl-head" style={{ height: textH }}><Type size={14} /> Text</div>
        <div className="tl-head" style={{ height: mediaH }}><ImageIcon size={14} /> Overlay</div>
        <div className="tl-head" style={{ height: MAIN_H }}><Film size={14} /> Video</div>
        <div className="tl-head" style={{ height: audioH }}><Music size={14} /> Audio</div>
      </div>
      <div className="tl-scroll" ref={scroller}>
        <div className="tl-inner" style={{ width }}>
          <Ruler zoom={zoom} width={width} onMouseDown={seekDrag} />
          <div className="track" style={{ height: textH }} onMouseDown={(e) => { props.onSel(null); seekDrag(e); }}>
            {edit.overlays.map((o) => (
              <div key={o.id} className={`item text ${selId === o.id ? "sel" : ""} ${o.kind}`} style={{ left: o.start * zoom, width: Math.max(14, o.dur * zoom), ...laneStyle(textL.lane[o.id] ?? 0, TEXT_H) }}
                onMouseDown={(e) => startItem(e, "overlay", o, "move")} title={o.text}>
                <span className="handle l" onMouseDown={(e) => startItem(e, "overlay", o, "l")} />
                {o.dur * zoom > 40 && <span className="ellipsis">{o.kind === "text" ? <Sparkles size={11} /> : <Type size={11} />} {o.text.split("\n")[0]}</span>}
                <span className="handle r" onMouseDown={(e) => startItem(e, "overlay", o, "r")} />
              </div>
            ))}
          </div>
          <div className={`track ${hotTrack === "media" ? "hot" : ""}`} style={{ height: mediaH }} onMouseDown={(e) => { props.onSel(null); seekDrag(e); }} {...dropOn("media")}>
            {edit.media.map((m) => {
              const a = assets[m.asset];
              return (
                <div key={m.id} className={`item media ${selId === m.id ? "sel" : ""}`} style={{ left: m.start * zoom, width: Math.max(14, m.dur * zoom), ...laneStyle(mediaL.lane[m.id] ?? 0, MEDIA_H) }}
                  onMouseDown={(e) => startItem(e, "media", m, "move")} title={a?.name}>
                  {a && a.kind !== "audio" && <span className="mthumb" style={{ backgroundImage: `url(${media.assetThumb(p.id, a.id)})` }} />}
                  <span className="handle l" onMouseDown={(e) => startItem(e, "media", m, "l")} />
                  {m.dur * zoom > 50 && <span className="ellipsis" style={{ position: "relative" }}>{a?.name ?? "Missing"}{m.mode === "pip" ? " · PiP" : ""}</span>}
                  <span className="handle r" onMouseDown={(e) => startItem(e, "media", m, "r", a?.kind === "video" ? a.duration : undefined)} />
                </div>
              );
            })}
          </div>
          <div className="track" style={{ height: MAIN_H }} onMouseDown={(e) => { props.onSelectClip(null, false); props.onSel(null); seekDrag(e); }}>
            {clips.map((c, k) => (
              <ClipBlock key={c.id} c={c} left={st[k] * zoom} width={clipDur(c) * zoom} pid={p.id}
                take={isTitle(c) ? undefined : takes[c.take]} source={!isTitle(c) && takes[c.take]?.video ? sources[takes[c.take].video!] : undefined}
                peaks={!isTitle(c) ? peaks[c.take] : undefined} zoom={zoom}
                selected={selected.has(c.id)} dragging={dragId === c.id}
                onDown={(e) => startClipDrag(e, c, k)} onTrim={(e, side) => startTrim(e, c, side)} />
            ))}
            {clips.map((c, k) => k > 0 && (
              <button key={`cut${c.id}`} className={`cut ${c.transition ? "has" : ""} ${sel?.kind === "cut" && sel.index === k ? "sel" : ""}`}
                style={{ left: st[k] * zoom - (c.transition ? Math.max(16, c.transition.dur * zoom) : 16) / 2, width: c.transition ? Math.max(16, c.transition.dur * zoom) : 16 }}
                title={c.transition ? `Transition: ${c.transition.type}` : "Add a transition"}
                onMouseDown={(e) => { e.stopPropagation(); props.onSelectClip(null, false); props.onSel({ kind: "cut", index: k }); }}>
                <i />
              </button>
            ))}
            {drop && <div className="drop-marker" style={{ left: drop.x }} />}
          </div>
          <div className={`track ${hotTrack === "audio" ? "hot" : ""}`} style={{ height: audioH }} onMouseDown={(e) => { props.onSel(null); seekDrag(e); }} {...dropOn("audio")}>
            {edit.audio.map((s) => {
              const a = assets[s.asset];
              return (
                <div key={s.id} className={`item audio ${selId === s.id ? "sel" : ""}`} style={{ left: s.start * zoom, width: Math.max(14, s.dur * zoom), ...laneStyle(audioL.lane[s.id] ?? 0, AUDIO_H) }}
                  onMouseDown={(e) => startItem(e, "audio", s, "move")} title={a?.name}>
                  <AudioWave pid={p.id} aid={s.asset} width={s.dur * zoom} from={s.in ?? 0} dur={s.dur} loop={!!s.loop} length={a?.duration ?? 0} vol={s.volume ?? 0.5} />
                  <span className="handle l" onMouseDown={(e) => startItem(e, "audio", s, "l")} />
                  {s.dur * zoom > 50 && <span className="ellipsis" style={{ position: "relative" }}><AudioLines size={11} /> {a?.name ?? "Missing"}{s.duck ? " · ducks" : ""}</span>}
                  <span className="handle r" onMouseDown={(e) => startItem(e, "audio", s, "r", s.loop ? undefined : a?.duration)} />
                </div>
              );
            })}
          </div>
          <div className="playhead" style={{ left: time * zoom }} />
        </div>
      </div>
    </div>
  );
}

const Ruler = memo(function Ruler({ zoom, width, onMouseDown }: { zoom: number; width: number; onMouseDown: (e: React.MouseEvent) => void }) {
  // A label every ~90 px, on a round number of seconds.
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const major = steps.find((s) => s * zoom >= 90) ?? 600;
  const minor = major / 5;
  const ticks = [];
  for (let t = 0; t * zoom < width; t += minor) {
    const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
    ticks.push(
      <div key={t.toFixed(2)} className={`tick ${isMajor ? "" : "minor"}`} style={{ left: t * zoom }}>
        {isMajor ? fmtTime(t) : ""}
      </div>,
    );
  }
  return <div className="ruler" style={{ height: RULER }} onMouseDown={onMouseDown}>{ticks}</div>;
});

const peakCache = new Map<string, Promise<{ per: number; peaks: number[] }>>();

/** The real waveform of a music or sound item, repeated if it loops. */
const AudioWave = memo(function AudioWave({ pid, aid, width, from, dur, loop, length, vol }: {
  pid: string; aid: string; width: number; from: number; dur: number; loop: boolean; length: number; vol: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [data, setData] = useState<{ per: number; peaks: number[] } | null>(null);
  useEffect(() => {
    let alive = true;
    const key = `${pid}/${aid}`;
    if (!peakCache.has(key)) peakCache.set(key, api.peaks(pid, aid));
    peakCache.get(key)!.then((d) => alive && setData(d)).catch(() => peakCache.delete(key));
    return () => { alive = false; };
  }, [pid, aid]);
  useLayoutEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const W = Math.max(1, Math.min(6000, Math.floor(width))), H = 30;
    const dpr = window.devicePixelRatio || 1;
    cv.width = W * dpr;
    cv.height = H * dpr;
    const g = cv.getContext("2d")!;
    g.scale(dpr, dpr);
    g.fillStyle = "rgba(61,220,151,0.6)";
    if (!data?.peaks.length) return;
    const n = data.peaks.length, len = length || n / data.per;
    const gain = Math.min(1.3, 0.4 + vol);
    for (let x = 0; x < W; x += 2) {
      let t = from + (x / W) * dur;
      if (loop && len > 0) t = t % len;
      const i = Math.floor(t * data.per);
      const v = i < n ? data.peaks[i] / 100 : 0;
      const h = Math.max(1, Math.min(1, v * gain) * H);
      g.fillRect(x, (H - h) / 2, 1.4, h);
    }
  }, [data, width, from, dur, loop, length, vol]);
  return <canvas ref={ref} className="abars" style={{ width: "100%" }} />;
});

const ClipBlock = memo(function ClipBlock({ c, left, width, pid, take, source, peaks, zoom, selected, dragging, onDown, onTrim }: {
  c: Clip; left: number; width: number; pid: string; take?: Take; source?: Source; peaks?: number[]; zoom: number;
  selected: boolean; dragging: boolean; onDown: (e: React.MouseEvent) => void; onTrim: (e: React.MouseEvent, side: "a" | "b") => void;
}) {
  const color = isTitle(c) ? KIND_COLOR.title : KIND_COLOR[take?.kind ?? "screen"];
  const sp = speedOf(c);
  const fx = !isTitle(c) && (c.filter && c.filter !== "none" || c.adjust && Object.keys(c.adjust).length);
  return (
    <div className={`clip ${selected ? "sel" : ""} ${dragging ? "dragging" : ""} ${isTitle(c) ? "title-clip" : ""}`}
      style={{ left, width: Math.max(4, width - 2) }} onMouseDown={onDown}
      title={isTitle(c) ? `Title card: ${c.text}` : `${take?.name}  ${fmtTime(c.a, true)} to ${fmtTime(c.b, true)}${sp !== 1 ? `  (${sp}x)` : ""}`}>
      {!isTitle(c) && source?.thumbs && take && <Thumbs c={c} take={take} source={source} pid={pid} width={width} zoom={zoom} />}
      {!isTitle(c) && peaks && <Wave c={c} peaks={peaks} width={width} color={color} />}
      <span className="stripe" style={{ background: color }} />
      {width > 50 && <span className="label ellipsis">{isTitle(c) ? c.text : take?.name}</span>}
      {width > 34 && (sp !== 1 || fx || (!isTitle(c) && c.mute)) && (
        <span className="badges">
          {sp !== 1 && <b><Gauge size={10} /> {sp}x</b>}
          {fx && <b>FX</b>}
          {!isTitle(c) && c.mute && <b>Muted</b>}
        </span>
      )}
      <span className="handle l" onMouseDown={(e) => onTrim(e, "a")} />
      <span className="handle r" onMouseDown={(e) => onTrim(e, "b")} />
    </div>
  );
});

function Thumbs({ c, take, source, pid, width, zoom }: { c: MediaClip; take: Take; source: Source; pid: string; width: number; zoom: number }) {
  const info = source.thumbs!;
  const h = (MAIN_H - 12) * 0.58;
  const aspect = source.width && source.height ? source.width / source.height : 16 / 9;
  const tw = h * aspect;
  const sw = info.height * aspect; // sprite frame width
  const n = Math.max(1, Math.min(200, Math.ceil(width / tw)));
  const off = take.video === take.voice ? 0 : offsetAt(take, c.a);
  const sp = speedOf(c);
  const url = media.thumbs(pid, source.id);
  const tiles = [];
  for (let k = 0; k < n; k++) {
    const t = c.a + off + ((k * tw + tw / 2) / zoom) * sp;
    const idx = clamp(Math.floor(t / info.every), 0, info.count - 1);
    const col = idx % info.cols, row = Math.floor(idx / info.cols);
    const scale = h / info.height;
    tiles.push(
      <span key={k} style={{
        width: tw, backgroundImage: `url(${url})`,
        backgroundSize: `${info.cols * sw * scale}px ${info.rows * info.height * scale}px`,
        backgroundPosition: `${-col * sw * scale}px ${-row * info.height * scale}px`,
      }} />,
    );
  }
  return <div className="thumbs">{tiles}</div>;
}

function Wave({ c, peaks, width, color }: { c: MediaClip; peaks: number[]; width: number; color: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.min(8000, Math.floor(width))), H = 40;
    cv.width = W * dpr;
    cv.height = H * dpr;
    const g = cv.getContext("2d")!;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, W, H);
    const css = getComputedStyle(document.documentElement);
    const col = color.startsWith("var(") ? css.getPropertyValue(color.slice(4, -1)).trim() : color;
    g.fillStyle = col || "#888";
    g.globalAlpha = c.mute ? 0.2 : 0.75;
    const per = 50; // peaks per second
    const a = c.a * per, b = c.b * per;
    const gain = c.mute ? 0 : Math.min(2, c.volume ?? 1);
    for (let x = 0; x < W; x += 2) {
      const i0 = Math.floor(a + ((b - a) * x) / W), i1 = Math.max(i0 + 1, Math.floor(a + ((b - a) * (x + 2)) / W));
      let m = 0;
      for (let i = i0; i < i1 && i < peaks.length; i++) m = Math.max(m, peaks[i]);
      const h = Math.max(1, Math.min(1, (m / 100) * (gain || 0.15)) * (H - 6));
      g.fillRect(x, (H - h) / 2, 1.4, h);
    }
  }, [c.a, c.b, c.mute, c.volume, peaks, width, color]);
  return <canvas ref={ref} className="wave" style={{ height: "42%" }} />;
}

export type { Asset };
