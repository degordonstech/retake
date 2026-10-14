import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Film, Type } from "lucide-react";
import { media } from "../api";
import type { Clip, MediaClip, Overlay, Project, Source, Take } from "../types";
import { clamp, fmtTime, KIND_COLOR } from "../util";
import { clipDur, isTitle, offsetAt, starts, totalDuration } from "./model";

const RULER = 28;
const MAIN_H = 104;
const TEXT_H = 46;

interface Props {
  p: Project;
  clips: Clip[];
  overlays: Overlay[];
  time: number;
  zoom: number; // pixels per second
  setZoom: (z: number) => void;
  selected: Set<string>;
  selectedOverlay: string | null;
  peaks: Record<string, number[]>;
  playing: boolean;
  onSeek: (t: number) => void;
  onSelectClip: (id: string | null, additive: boolean) => void;
  onSelectOverlay: (id: string | null) => void;
  onTrim: (id: string, side: "a" | "b", value: number, commit: boolean) => void;
  onMove: (id: string, toIndex: number) => void;
  onOverlay: (id: string, start: number, dur: number, commit: boolean) => void;
}

export default function Timeline(props: Props) {
  const { p, clips, overlays, time, zoom, setZoom, selected, selectedOverlay, peaks, playing } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const [drop, setDropState] = useState<{ index: number; x: number } | null>(null);
  const dropRef = useRef<{ index: number; x: number } | null>(null);
  const setDrop = (d: { index: number; x: number } | null) => { dropRef.current = d; setDropState(d); };
  const [dragId, setDragId] = useState<string | null>(null);
  const total = totalDuration(clips);
  const st = useMemo(() => starts(clips), [clips]);
  const width = Math.max(total * zoom + 400, 800);
  const takes = useMemo(() => Object.fromEntries(p.takes.map((t) => [t.id, t])), [p.takes]);
  const sources = useMemo(() => Object.fromEntries(p.sources.map((s) => [s.id, s])), [p.sources]);

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

  const tAt = useCallback((clientX: number) => {
    const el = scroller.current!;
    return clamp((clientX - el.getBoundingClientRect().left + el.scrollLeft) / zoom, 0, total);
  }, [zoom, total]);

  const seekDrag = (e: React.MouseEvent) => {
    props.onSeek(tAt(e.clientX));
    const move = (ev: MouseEvent) => props.onSeek(tAt(ev.clientX));
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  /* --------------------------------------------------- clip interactions */
  const startClipDrag = (e: React.MouseEvent, c: Clip, index: number) => {
    e.stopPropagation();
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    props.onSelectClip(c.id, additive);
    props.onSelectOverlay(null);
    const x0 = e.clientX;
    let moved = false;
    const move = (ev: MouseEvent) => {
      if (!moved && Math.abs(ev.clientX - x0) < 5) return;
      moved = true;
      setDragId(c.id);
      const t = tAt(ev.clientX);
      // Drop between clips: nearest boundary by midpoint.
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
    let last = base;
    const move = (ev: MouseEvent) => {
      const dt = (ev.clientX - x0) / zoom;
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

  /* ------------------------------------------------ overlay interactions */
  const startOverlay = (e: React.MouseEvent, o: Overlay, mode: "move" | "l" | "r") => {
    e.stopPropagation();
    props.onSelectOverlay(o.id);
    props.onSelectClip(null, false);
    const x0 = e.clientX;
    let ns = o.start, nd = o.dur;
    const move = (ev: MouseEvent) => {
      const dt = (ev.clientX - x0) / zoom;
      if (mode === "move") ns = clamp(o.start + dt, 0, Math.max(0, total - 0.2));
      if (mode === "l") { ns = clamp(o.start + dt, 0, o.start + o.dur - 0.5); nd = o.dur - (ns - o.start); }
      if (mode === "r") nd = Math.max(0.5, o.dur + dt);
      props.onOverlay(o.id, ns, nd, false);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      props.onOverlay(o.id, ns, nd, true);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return (
    <div className="tl-body">
      <div className="tl-heads">
        <div className="ruler-pad" />
        <div className="tl-head" style={{ height: MAIN_H }}><Film size={14} /> Video</div>
        <div className="tl-head" style={{ height: TEXT_H }}><Type size={14} /> Text</div>
      </div>
      <div className="tl-scroll" ref={scroller}>
        <div className="tl-inner" style={{ width }}>
          <Ruler zoom={zoom} width={width} onMouseDown={seekDrag} />
          <div className="track" style={{ height: MAIN_H }} onMouseDown={(e) => { props.onSelectClip(null, false); props.onSelectOverlay(null); seekDrag(e); }}>
            {clips.map((c, k) => (
              <ClipBlock key={c.id} c={c} left={st[k] * zoom} width={clipDur(c) * zoom} pid={p.id}
                take={isTitle(c) ? undefined : takes[c.take]} source={!isTitle(c) && takes[c.take]?.video ? sources[takes[c.take].video!] : undefined}
                peaks={!isTitle(c) ? peaks[c.take] : undefined} zoom={zoom}
                selected={selected.has(c.id)} dragging={dragId === c.id}
                onDown={(e) => startClipDrag(e, c, k)} onTrim={(e, side) => startTrim(e, c, side)} />
            ))}
            {drop && <div className="drop-marker" style={{ left: drop.x }} />}
          </div>
          <div className="track" style={{ height: TEXT_H }} onMouseDown={(e) => { props.onSelectOverlay(null); seekDrag(e); }}>
            {overlays.map((o) => (
              <div key={o.id} className={`ovl ${selectedOverlay === o.id ? "sel" : ""}`} style={{ left: o.start * zoom, width: Math.max(14, o.dur * zoom) }}
                onMouseDown={(e) => startOverlay(e, o, "move")} title={o.text}>
                <span className="handle l" onMouseDown={(e) => startOverlay(e, o, "l")} />
                {o.dur * zoom > 40 && <span className="ellipsis">{o.text}</span>}
                <span className="handle r" onMouseDown={(e) => startOverlay(e, o, "r")} />
              </div>
            ))}
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

const ClipBlock = memo(function ClipBlock({ c, left, width, pid, take, source, peaks, zoom, selected, dragging, onDown, onTrim }: {
  c: Clip; left: number; width: number; pid: string; take?: Take; source?: Source; peaks?: number[]; zoom: number;
  selected: boolean; dragging: boolean; onDown: (e: React.MouseEvent) => void; onTrim: (e: React.MouseEvent, side: "a" | "b") => void;
}) {
  const color = isTitle(c) ? KIND_COLOR.title : KIND_COLOR[take?.kind ?? "screen"];
  return (
    <div className={`clip ${selected ? "sel" : ""} ${dragging ? "dragging" : ""} ${isTitle(c) ? "title-clip" : ""}`}
      style={{ left, width: Math.max(4, width - 2) }} onMouseDown={onDown}
      title={isTitle(c) ? `Title card: ${c.text}` : `${take?.name}  ${fmtTime(c.a, true)} to ${fmtTime(c.b, true)}`}>
      {!isTitle(c) && source?.thumbs && take && <Thumbs c={c} take={take} source={source} pid={pid} width={width} zoom={zoom} />}
      {!isTitle(c) && peaks && <Wave c={c} peaks={peaks} width={width} color={color} />}
      <span className="stripe" style={{ background: color }} />
      {width > 50 && <span className="label ellipsis">{isTitle(c) ? c.text : take?.name}</span>}
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
  const n = Math.max(1, Math.ceil(width / tw));
  const off = take.video === take.voice ? 0 : offsetAt(take, c.a);
  const url = media.thumbs(pid, source.id);
  const tiles = [];
  for (let k = 0; k < n; k++) {
    const t = c.a + off + (k * tw + tw / 2) / zoom;
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
    const W = Math.max(1, Math.floor(width)), H = 40;
    cv.width = W * dpr;
    cv.height = H * dpr;
    const g = cv.getContext("2d")!;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, W, H);
    const css = getComputedStyle(document.documentElement);
    const col = color.startsWith("var(") ? css.getPropertyValue(color.slice(4, -1)).trim() : color;
    g.fillStyle = col || "#888";
    g.globalAlpha = 0.75;
    const per = 50; // peaks per second
    const a = c.a * per, b = c.b * per;
    for (let x = 0; x < W; x += 2) {
      const i0 = Math.floor(a + ((b - a) * x) / W), i1 = Math.max(i0 + 1, Math.floor(a + ((b - a) * (x + 2)) / W));
      let m = 0;
      for (let i = i0; i < i1 && i < peaks.length; i++) m = Math.max(m, peaks[i]);
      const h = Math.max(1, (m / 100) * (H - 6));
      g.fillRect(x, (H - h) / 2, 1.4, h);
    }
  }, [c.a, c.b, peaks, width, color]);
  return <canvas ref={ref} className="wave" style={{ height: "42%" }} />;
}
