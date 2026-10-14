import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { api, media } from "../api";
import type { Asset, AudioItem, CaptionLayout, Clip, Edit, Looks, MediaItem, Overlay, Project } from "../types";
import { isTitle, locate, speedOf, srcAt, totalDuration } from "./model";
import { TextLayer } from "./Layers";
import { compileScene, type Scene } from "../engine/scene";
import { Renderer } from "../engine/renderer";

export interface PlayerHandle {
  play: () => void;
  pause: () => void;
  seek: (t: number) => void;
  playing: () => boolean;
}

export type Pick = { kind: "overlay" | "media"; id: string } | null;

interface Props {
  p: Project;
  edit: Edit;
  size: [number, number]; // output frame, e.g. 1920 x 1080
  time: number;
  layout: CaptionLayout | null;
  looks: Looks | null;
  picked: Pick;
  onPick: (pick: Pick) => void;
  onOverlay: (o: Overlay, commit: boolean) => void;
  onMedia: (m: MediaItem, commit: boolean) => void;
  onTime: (t: number) => void;
  onPlayingChange: (playing: boolean) => void;
}

export { framingOf } from "../engine/scene";

/** CSS that approximates the export's colour, for the small filter cards. */
export function lookCss(adj: Record<string, number>): { filter: string; tint: string | null; vignette: number } {
  const b = adj.brightness ?? 0, c = adj.contrast ?? 0, s = adj.saturation ?? 0, t = adj.temperature ?? 0;
  const parts = [];
  if (b) parts.push(`brightness(${(1 + b * 0.8).toFixed(3)})`);
  if (c) parts.push(`contrast(${(1 + c).toFixed(3)})`);
  if (s) parts.push(`saturate(${Math.max(0, 1 + s).toFixed(3)})`);
  const tint = t > 0 ? `rgba(255,140,40,${Math.min(0.3, t * 0.2).toFixed(3)})` : t < 0 ? `rgba(50,130,255,${Math.min(0.3, -t * 0.2).toFixed(3)})` : null;
  return { filter: parts.join(" "), tint, vignette: adj.vignette ?? 0 };
}

export function clipAdjust(c: Clip, looks: Looks | null): Record<string, number> {
  if (isTitle(c)) return {};
  const base = { ...(looks?.filters.find((f) => f.id === (c.filter ?? "none"))?.adj ?? {}) } as Record<string, number>;
  for (const [k, v] of Object.entries(c.adjust ?? {})) base[k] = (base[k] ?? 0) + (v ?? 0);
  return base;
}

/**
 * The preview. Every frame is drawn by the engine (decoded exactly, framed,
 * coloured, blended and captioned the same way the export does it). Sound
 * plays from light audio elements that follow the clock.
 */
const Player = forwardRef<PlayerHandle, Props>(function Player(props, ref) {
  const { p, edit, size, time, layout, looks, picked, onPick, onOverlay, onMedia, onTime, onPlayingChange } = props;
  const [W, H] = size;
  const canvas = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<Renderer | null>(null);
  const sounds = useRef<Record<string, HTMLAudioElement | null>>({});
  const wrap = useRef<HTMLDivElement>(null);
  const state = useRef({ playing: false, anchor: 0, t0: 0, clip: -1, raf: 0, lastEmit: 0, now: 0 });
  const [box, setBox] = useState({ w: 640, h: 360 });
  const [, setHandles] = useState(0); // re-render the drag handles after playback stops
  const [failed, setFailed] = useState<string | null>(null);
  const [blurs, setBlurs] = useState<Record<string, number[][]>>({});
  useEffect(() => { api.blurSpans(p.id).then(setBlurs).catch(() => {}); }, [p.id, p.privacy.scanned, p.privacy.dismissed?.length, p.privacy.manual?.length]);
  const editRef = useRef(edit);
  editRef.current = edit;
  const assets = useMemo(() => Object.fromEntries(p.assets.map((a) => [a.id, a])), [p.assets]);
  const total = totalDuration(edit.clips);

  // The scene is rebuilt only when the edit changes.
  const scene: Scene = useMemo(() => compileScene({
    p, edit, looks, size,
    videoUrl: (sid) => media.proxy(p.id, sid),
    assetUrl: (a) => media.asset(p.id, a.id),
    stillUrl: (o) => media.overlay(p.id, o, Math.round(W / 1.5), Math.round(H / 1.5)),
    blurs,
  }), [p, edit, looks, size, W, H, blurs]);
  const sceneRef = useRef(scene);
  sceneRef.current = scene;
  const optsRef = useRef({ layout, looks, captions: !!edit.captions?.on });
  optsRef.current = { layout, looks, captions: !!edit.captions?.on };

  // Fit the frame inside the preview area.
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      const k = Math.min(r.width / W, r.height / H);
      setBox({ w: Math.max(2, Math.floor(W * k)), h: Math.max(2, Math.floor(H * k)) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [W, H]);
  const k = box.w / W;

  const draw = (t: number) => {
    const r = renderer.current;
    if (!r) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const s = state.current;
    r.render(sceneRef.current, t, { k: k * dpr, playing: s.playing, settle: !s.playing, ...optsRef.current });
  };
  const drawRef = useRef(draw);
  drawRef.current = draw;

  useEffect(() => {
    if (!canvas.current) return;
    let r: Renderer;
    try {
      r = new Renderer(canvas.current);
    } catch (e) {
      setFailed((e as Error).message);
      return;
    }
    renderer.current = r;
    let pending = false;
    r.onNeedRedraw = () => {
      if (state.current.playing || pending) return;
      pending = true;
      requestAnimationFrame(() => { pending = false; drawRef.current(state.current.now); });
    };
    const sweep = setInterval(() => {
      r.pool.sweep();
      const errs = r.pool.errors();
      setFailed(errs.length ? errs[0] : null);
    }, 4000);
    drawRef.current(state.current.now);
    return () => { clearInterval(sweep); r.dispose(); renderer.current = null; };
  }, []);

  /* ------------------------------------------------------------- sound --- */
  const pauseAll = () => Object.values(sounds.current).forEach((e) => e?.pause());

  /** Point every sound at timeline time t. */
  const cue = (t: number, play: boolean) => {
    const cl = editRef.current.clips;
    if (!cl.length) return;
    const { index, local } = locate(cl, t);
    const c = cl[index];
    const changed = state.current.clip !== index;
    state.current.clip = index;
    for (const tk of p.takes) {
      const el = sounds.current[`take:${tk.id}`];
      if (!el) continue;
      const on = !isTitle(c) && c.take === tk.id;
      if (!on) { el.pause(); continue; }
      const sp = speedOf(c);
      const want = srcAt(c, local);
      if (changed || Math.abs(el.currentTime - want) > (play ? 0.2 : 0.02)) el.currentTime = Math.max(0, want);
      if (el.playbackRate !== sp) el.playbackRate = sp;
      el.volume = c.mute ? 0 : Math.min(1, c.volume ?? 1);
      if (play) el.play().catch(() => {}); else el.pause();
    }
    const ed = editRef.current;
    const items: (MediaItem | AudioItem)[] = [...ed.media, ...ed.audio];
    for (const it of items) {
      const el = sounds.current[`item:${it.id}`];
      if (!el) continue;
      const on = t >= it.start && t < it.start + it.dur;
      if (!on) { el.pause(); continue; }
      const a = assets[it.asset];
      let want = (it.in ?? 0) + (t - it.start);
      if ("loop" in it && it.loop && a?.duration) want = want % a.duration;
      if (Math.abs(el.currentTime - want) > (play ? 0.3 : 0.03)) el.currentTime = Math.max(0, want);
      el.volume = Math.min(1, (it.volume ?? 0) * ("duck" in it && it.duck ? 0.6 : 1));
      if (play && el.volume > 0) el.play().catch(() => {}); else el.pause();
    }
  };

  /* ------------------------------------------------------------- clock --- */
  const loop = () => {
    const s = state.current;
    if (!s.playing) return;
    const t = s.t0 + (performance.now() - s.anchor) / 1000;
    const tot = totalDuration(editRef.current.clips);
    if (t >= tot) {
      stop();
      onTime(tot);
      return;
    }
    s.now = t;
    cue(t, true);
    drawRef.current(t);
    if (performance.now() - s.lastEmit > 60) {
      s.lastEmit = performance.now();
      onTime(t);
    }
    s.raf = requestAnimationFrame(loop);
  };

  const start = () => {
    const s = state.current;
    if (s.playing || !editRef.current.clips.length) return;
    let t = time;
    if (t >= totalDuration(editRef.current.clips) - 0.05) t = 0;
    s.playing = true;
    s.t0 = t;
    s.anchor = performance.now();
    s.clip = -1;
    onPlayingChange(true);
    cue(t, true);
    setHandles((x) => x + 1);
    s.raf = requestAnimationFrame(loop);
  };

  function stop() {
    const s = state.current;
    if (!s.playing) return;
    s.playing = false;
    cancelAnimationFrame(s.raf);
    pauseAll();
    onPlayingChange(false);
    const t = s.t0 + (performance.now() - s.anchor) / 1000;
    s.now = t;
    onTime(t);
    drawRef.current(t);
    setHandles((x) => x + 1);
  }

  useImperativeHandle(ref, () => ({
    play: start,
    pause: stop,
    playing: () => state.current.playing,
    seek: (t: number) => {
      const s = state.current;
      s.clip = -1;
      s.now = t;
      if (s.playing) {
        s.t0 = t;
        s.anchor = performance.now();
        cue(t, true);
      } else {
        cue(t, false);
        drawRef.current(t);
      }
      onTime(t);
    },
  }));

  // Redraw the still frame after edits, seeks and resizes.
  useEffect(() => {
    if (state.current.playing) return;
    const t = Math.min(time, Math.max(0, total - 0.001));
    state.current.now = t;
    state.current.clip = -1;
    cue(t, false);
    drawRef.current(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [time, scene, box, layout]);

  useEffect(() => () => cancelAnimationFrame(state.current.raf), []);

  const t = state.current.playing ? state.current.now : Math.min(time, Math.max(0, total - 0.001));
  const near = (it: { start: number; dur: number }) => t >= it.start - 0.1 && t < it.start + it.dur;
  const dpr = Math.min(2, typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1);

  return (
    <div className="stage-wrap" ref={wrap} onMouseDown={() => onPick(null)}>
      <div className="stage" style={{ width: box.w, height: box.h }} data-dpr={dpr}>
        <canvas ref={canvas} className="engine" style={{ width: box.w, height: box.h }} />
        {!state.current.playing && (
          <div className="frame handles" style={{ width: W, height: H, transform: `scale(${k})` }}>
            {edit.media.map((m) => near(m) && <MediaHandle key={m.id} m={m} a={assets[m.asset]} W={W} H={H} k={k}
              selected={picked?.kind === "media" && picked.id === m.id}
              onPick={() => onPick({ kind: "media", id: m.id })} onChange={onMedia} />)}
            <TextLayer items={edit.overlays} t={t} W={W} H={H} looks={looks} scale={k} settle ghost
              selected={picked?.kind === "overlay" ? picked.id : null}
              onSelect={(id) => onPick({ kind: "overlay", id })} onMove={onOverlay} />
          </div>
        )}
        {!edit.clips.length && (
          <div className="still" style={{ display: "grid", placeItems: "center" }}>
            <span className="faint">The timeline is empty</span>
          </div>
        )}
        {failed && <div className="engine-warn" title={failed}>Some media can't be shown in the preview. The export is not affected.</div>}
      </div>
      <div style={{ display: "none" }}>
        {p.takes.map((tk) => (
          <audio key={tk.id} ref={(el) => { sounds.current[`take:${tk.id}`] = el; }} src={media.proxy(p.id, tk.voice)} preload="auto" />
        ))}
        {edit.audio.map((s) => assets[s.asset] && (
          <audio key={s.id} ref={(el) => { sounds.current[`item:${s.id}`] = el; }} src={media.asset(p.id, s.asset)} preload="auto" />
        ))}
        {edit.media.map((m) => assets[m.asset]?.kind === "video" && (m.volume ?? 0) > 0 && (
          <audio key={m.id} ref={(el) => { sounds.current[`item:${m.id}`] = el; }} src={media.asset(p.id, m.asset)} preload="auto" />
        ))}
      </div>
    </div>
  );
});

export default Player;

/** An invisible box over a picture-in-picture item, to select, drag and resize it. */
function MediaHandle({ m, a, W, H, k, selected, onPick, onChange }: {
  m: MediaItem; a?: Asset; W: number; H: number; k: number; selected: boolean;
  onPick: () => void; onChange: (m: MediaItem, commit: boolean) => void;
}) {
  if (!a) return null;
  const full = m.mode === "full";
  const aw = a.width || 16, ah = a.height || 9;
  const w = full ? W : W * (m.scale ?? 0.4);
  const h = full ? H : (w * ah) / aw;
  const css: CSSProperties = full
    ? { left: 0, top: 0, width: W, height: H }
    : { left: (m.x ?? 0.72) * W - w / 2, top: (m.y ?? 0.32) * H - h / 2, width: w, height: h, borderRadius: Math.min(w, h) * (m.radius ?? 0.06) };
  const down = (ev: React.MouseEvent) => {
    ev.stopPropagation();
    onPick();
    if (full) return;
    const x0 = ev.clientX, y0 = ev.clientY, ox = m.x ?? 0.72, oy = m.y ?? 0.32;
    let last = m;
    const move = (e2: MouseEvent) => {
      last = { ...m, x: Math.min(1, Math.max(0, ox + (e2.clientX - x0) / k / W)), y: Math.min(1, Math.max(0, oy + (e2.clientY - y0) / k / H)) };
      onChange(last, false);
    };
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); onChange(last, true); };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  const wheel = (ev: React.WheelEvent) => {
    if (!selected || full) return;
    ev.stopPropagation();
    onChange({ ...m, scale: Math.min(1, Math.max(0.08, (m.scale ?? 0.4) * (ev.deltaY < 0 ? 1.06 : 1 / 1.06))) }, true);
  };
  return <div className={`mitem ${selected ? "sel" : ""}`} style={css} onMouseDown={down} onWheel={wheel} />;
}
