import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { media } from "../api";
import type { Asset, AudioItem, CaptionLayout, Clip, Edit, Looks, MediaClip, MediaItem, Overlay, Project, Take } from "../types";
import { clipDur, isTitle, locate, offsetAt, speedOf, srcAt, totalDuration } from "./model";
import { CaptionLayer, TextLayer } from "./Layers";

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

interface Els {
  video?: HTMLVideoElement | null;
  audio?: HTMLAudioElement | null;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const ease = (q: number) => (1 - Math.cos(Math.PI * clamp01(q))) / 2;

/** Which way a clip is framed (same defaults as the export). */
export function framingOf(c: MediaClip, take: Take | undefined, aspect: string) {
  const f = c.frame ?? {};
  return {
    mode: f.mode ?? (take?.kind === "camera" && (aspect === "9:16" || aspect === "4:5") ? "fill" : "fit"),
    zoom: Math.max(1, f.zoom ?? 1),
    zoomTo: Math.max(1, f.zoomTo ?? f.zoom ?? 1),
    x: f.x ?? 0.5,
    y: f.y ?? 0.5,
    bg: f.bg ?? (aspect !== "16:9" ? "blur" : "color"),
  };
}

/** CSS that does what the export's crop-and-scale zoom does: the chosen
 *  point is brought towards the middle, never past the frame's edge. */
function zoomCss(z: number, fx: number, fy: number): CSSProperties {
  if (z <= 1.0001) return {};
  const ox = (Math.min(Math.max(0, fx - 1 / (2 * z)), 1 - 1 / z) * z) / (z - 1);
  const oy = (Math.min(Math.max(0, fy - 1 / (2 * z)), 1 - 1 / z) * z) / (z - 1);
  return { transform: `scale(${z})`, transformOrigin: `${ox * 100}% ${oy * 100}%` };
}

/** CSS that approximates the export's colour: a filter plus warm/cool tint. */
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
 * Plays the edit straight from the preview copies. A clock drives the
 * timeline; at each cut the right take's video (and its separate voice, if
 * any) is cued to the right moment, and corrected if it drifts.
 */
const Player = forwardRef<PlayerHandle, Props>(function Player(props, ref) {
  const { p, edit, size, time, layout, looks, picked, onPick, onOverlay, onMedia, onTime, onPlayingChange } = props;
  const [W, H] = size;
  const clips = edit.clips;
  const aspect = edit.format?.aspect ?? "16:9";
  const els = useRef<Record<string, Els>>({});
  const extra = useRef<Record<string, HTMLMediaElement | null>>({});
  const blur = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const state = useRef({ playing: false, anchor: 0, t0: 0, clip: -1, raf: 0, lastEmit: 0 });
  const [now, setNow] = useState(time);
  const [box, setBox] = useState({ w: 640, h: 360 });
  const editRef = useRef(edit);
  editRef.current = edit;
  const takes = useMemo(() => Object.fromEntries(p.takes.map((t) => [t.id, t])), [p.takes]);
  const assets = useMemo(() => Object.fromEntries(p.assets.map((a) => [a.id, a])), [p.assets]);
  const total = totalDuration(clips);

  // Fit the frame inside the preview area.
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      const k = Math.min(r.width / W, r.height / H);
      setBox({ w: Math.floor(W * k), h: Math.floor(H * k) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [W, H]);
  const k = box.w / W;

  const separate = (t: Take) => !!t.video && t.video !== t.voice;

  const pauseAll = () => {
    Object.values(els.current).forEach((e) => { e.video?.pause(); e.audio?.pause(); });
    Object.values(extra.current).forEach((e) => e?.pause());
  };

  /** Point the media of the clip at timeline time t at the right moment. */
  const cue = (t: number, play: boolean) => {
    const cl = editRef.current.clips;
    if (!cl.length) return;
    const { index, local } = locate(cl, t);
    const c = cl[index];
    const changed = state.current.clip !== index;
    state.current.clip = index;
    Object.entries(els.current).forEach(([tid, e]) => {
      const on = !isTitle(c) && c.take === tid;
      if (e.video) e.video.style.visibility = on ? "visible" : "hidden";
      if (!on) { e.video?.pause(); e.audio?.pause(); }
    });
    if (!isTitle(c)) {
      const take = takes[c.take];
      const e = els.current[c.take];
      if (take && e) {
        const sp = speedOf(c);
        const voiceT = srcAt(c, local);
        const vidT = voiceT + offsetAt(take, c.a);
        const v = e.video;
        const a = separate(take) || !take.video ? e.audio : null;
        const fix = (el: HTMLMediaElement, want: number, tol: number) => {
          if (changed || Math.abs(el.currentTime - want) > tol) el.currentTime = Math.max(0, want);
          if (el.playbackRate !== sp) el.playbackRate = sp;
        };
        const vol = c.mute ? 0 : Math.min(1, c.volume ?? 1);
        if (v) { fix(v, take.video === take.voice ? voiceT : vidT, play ? 0.3 : 0.02); if (!separate(take)) v.volume = vol; }
        if (a) { fix(a, voiceT, play ? 0.2 : 0.02); a.volume = vol; }
        if (play) { v?.play().catch(() => {}); a?.play().catch(() => {}); } else { v?.pause(); a?.pause(); }
        drawBlur(v ?? null);
      }
    }
    cueExtras(t, play);
  };

  /** B-roll videos and music follow the clock too. */
  const cueExtras = (t: number, play: boolean) => {
    const ed = editRef.current;
    const items: (MediaItem | AudioItem)[] = [...ed.media, ...ed.audio];
    for (const it of items) {
      const el = extra.current[it.id];
      if (!el) continue;
      const on = t >= it.start && t < it.start + it.dur;
      if (!on) { el.pause(); continue; }
      const a = assets[it.asset];
      let want = (it.in ?? 0) + (t - it.start);
      if ("loop" in it && it.loop && a?.duration) want = want % a.duration;
      if (Math.abs(el.currentTime - want) > (play ? 0.3 : 0.03)) el.currentTime = Math.max(0, want);
      const vol = Math.min(1, (it.volume ?? 0) * ("duck" in it && it.duck ? 0.6 : 1));
      el.volume = vol;
      el.muted = vol <= 0;
      if (play) el.play().catch(() => {}); else el.pause();
    }
  };

  const drawBlur = (v: HTMLVideoElement | null) => {
    const cv = blur.current;
    if (!cv || !v || v.readyState < 2) return;
    const g = cv.getContext("2d");
    if (!g) return;
    const vw = v.videoWidth || 16, vh = v.videoHeight || 9;
    const s = Math.max(cv.width / vw, cv.height / vh);
    try { g.drawImage(v, (cv.width - vw * s) / 2, (cv.height - vh * s) / 2, vw * s, vh * s); } catch { /* not ready */ }
  };

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
    cue(t, true);
    setNow(t);
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
    setNow(t);
    onTime(t);
  }

  useImperativeHandle(ref, () => ({
    play: start,
    pause: stop,
    playing: () => state.current.playing,
    seek: (t: number) => {
      const s = state.current;
      s.clip = -1;
      if (s.playing) {
        s.t0 = t;
        s.anchor = performance.now();
        cue(t, true);
      } else cue(t, false);
      setNow(t);
      onTime(t);
    },
  }));

  // Show the right still when not playing (after edits or seeks).
  useEffect(() => {
    if (!state.current.playing) {
      state.current.clip = -1;
      const t = Math.min(time, Math.max(0, total - 0.01));
      cue(t, false);
      setNow(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [time, edit]);

  useEffect(() => () => cancelAnimationFrame(state.current.raf), []);

  // ---------------------------------------------------------------- draw ---
  const t = state.current.playing ? now : Math.min(time, Math.max(0, total - 0.001));
  const { index, local } = clips.length ? locate(clips, t) : { index: -1, local: 0 };
  const cur = index >= 0 ? clips[index] : null;
  const curTake = cur && !isTitle(cur) ? takes[cur.take] : undefined;
  const audioOnly = cur && !isTitle(cur) && !curTake?.video;

  // Framing and colour of the clip on screen.
  let videoCss: CSSProperties = {};
  let bgBlur = false;
  let look = { filter: "", tint: null as string | null, vignette: 0 };
  if (cur && !isTitle(cur) && curTake?.video) {
    const f = framingOf(cur, curTake, aspect);
    const dur = clipDur(cur);
    const z = f.zoom + (f.zoomTo - f.zoom) * ease(dur > 0 ? local / dur : 0);
    videoCss = {
      objectFit: f.mode === "fill" ? "cover" : "contain",
      objectPosition: f.mode === "fill" ? `${f.x * 100}% ${f.y * 100}%` : "50% 50%",
      ...zoomCss(z, f.x, f.y),
    };
    bgBlur = f.mode === "fit" && f.bg === "blur";
    look = lookCss(clipAdjust(cur, looks));
  }

  // A simple stand-in for the transition around this moment.
  let layerFx: CSSProperties = {};
  let dip: string | null = null;
  if (cur) {
    const d = clipDur(cur);
    const tin = cur.transition && index > 0 ? Math.min(cur.transition.dur, 0.45 * Math.min(d, clipDur(clips[index - 1]))) : 0;
    const nx = clips[index + 1];
    const tout = nx?.transition ? Math.min(nx.transition.dur, 0.45 * Math.min(d, clipDur(nx))) : 0;
    let type: string | null = null, q = 0, side: "in" | "out" = "in";
    if (tin && local < tin / 2) { type = cur.transition!.type; q = 0.5 + local / tin; side = "in"; }
    else if (tout && local > d - tout / 2) { type = nx!.transition!.type; q = (local - (d - tout / 2)) / tout; side = "out"; }
    if (type) {
      const peak = 1 - Math.abs(q - 0.5) * 2; // 0 far from the cut, 1 at the cut
      const qq = side === "in" ? (q - 0.5) * 2 : 0;
      if (type === "black") dip = `rgba(0,0,0,${peak})`;
      else if (type === "white") dip = `rgba(255,255,255,${peak})`;
      else if (type === "fade") dip = `rgba(0,0,0,${peak * 0.45})`;
      else if (type === "blur" || type === "pixel") layerFx = { filter: `blur(${(peak * 14).toFixed(1)}px)` };
      else if (type === "zoom") { layerFx = { transform: `scale(${1 + peak * 0.18})` }; dip = `rgba(0,0,0,${peak * 0.25})`; }
      else if (side === "in") {
        if (type === "slide" || type === "smooth") layerFx = { transform: `translateX(${((1 - qq) * 100).toFixed(1)}%)` };
        else if (type === "push") layerFx = { transform: `translateY(${((1 - qq) * 100).toFixed(1)}%)` };
        else if (type === "wipe") layerFx = { clipPath: `inset(0 0 0 ${((1 - qq) * 100).toFixed(1)}%)` };
        else if (type === "circle" || type === "radial") layerFx = { clipPath: `circle(${(qq * 75).toFixed(1)}% at 50% 50%)` };
      } else dip = `rgba(0,0,0,${peak * 0.2})`;
    }
  }

  const activeOverlays = edit.overlays.filter((o) => o.kind !== "text" && t >= o.start && t < o.start + o.dur && o.text);
  const near = (it: { start: number; dur: number }) => t >= it.start - 3 && t < it.start + it.dur + 0.5;
  const fmt = edit.format;
  const fadeIn = fmt?.fadeIn && t < 0.6 ? 1 - t / 0.6 : 0;
  const fadeOut = fmt?.fadeOut && t > total - 0.8 ? (t - (total - 0.8)) / 0.8 : 0;
  const ovW = Math.round(W / 1.5), ovH = Math.round(H / 1.5);

  return (
    <div className="stage-wrap" ref={wrap} onMouseDown={() => onPick(null)}>
      <div className="stage" style={{ width: box.w, height: box.h }}>
        <canvas ref={blur} className="bgblur" width={W >= H ? 96 : 54} height={W >= H ? 54 : 96} style={{ opacity: bgBlur ? 1 : 0 }} />
        <div className="vlayer" style={{ ...layerFx, filter: [look.filter, layerFx.filter].filter(Boolean).join(" ") || undefined }}>
          {p.takes.map((tk) => (
            <div key={tk.id}>
              {tk.video && (
                <video
                  ref={(el) => { els.current[tk.id] = { ...els.current[tk.id], video: el }; }}
                  src={media.proxy(p.id, tk.video)}
                  preload="auto"
                  muted={separate(tk)}
                  playsInline
                  style={{ visibility: "hidden", ...(curTake?.id === tk.id ? videoCss : {}) }}
                />
              )}
              {(separate(tk) || !tk.video) && (
                <audio ref={(el) => { els.current[tk.id] = { ...els.current[tk.id], audio: el }; }} src={media.proxy(p.id, tk.voice)} preload="auto" />
              )}
            </div>
          ))}
          {look.tint && <div className="fx" style={{ background: look.tint, mixBlendMode: "soft-light" }} />}
          {look.vignette > 0 && <div className="fx" style={{ background: `radial-gradient(ellipse at center, transparent 45%, rgba(0,0,0,${Math.min(0.85, look.vignette * 0.8)}) 100%)` }} />}
          {cur && isTitle(cur) && <img className="still" alt="" src={media.overlay(p.id, { kind: "title", text: cur.text, sub: cur.sub, tag: cur.tag }, ovW, ovH)} />}
          {audioOnly && (
            <div className="still" style={{ display: "grid", placeItems: "center", background: "var(--bg-2)" }}>
              <span className="muted">{curTake?.name} (voice only)</span>
            </div>
          )}
        </div>
        {dip && <div className="fx" style={{ background: dip }} />}

        <div className="frame" style={{ width: W, height: H, transform: `scale(${k})` }}>
          {edit.media.map((m) => near(m) && <MediaLayer key={m.id} m={m} a={assets[m.asset]} pid={p.id} t={t} W={W} H={H} k={k} settle={!state.current.playing}
            selected={picked?.kind === "media" && picked.id === m.id}
            onRef={(el) => { extra.current[m.id] = el; }}
            onPick={() => onPick({ kind: "media", id: m.id })} onChange={onMedia} />)}
          {activeOverlays.map((o) => (
            <img key={o.id + o.text + (o.sub ?? "") + (o.tag ?? "")} className="ov" alt="" src={media.overlay(p.id, o, ovW, ovH)} />
          ))}
          <TextLayer items={edit.overlays} t={t} W={W} H={H} looks={looks} scale={k} settle={!state.current.playing}
            selected={picked?.kind === "overlay" ? picked.id : null}
            onSelect={(id) => onPick({ kind: "overlay", id })} onMove={onOverlay} />
          {edit.captions?.on && <CaptionLayer layout={layout} t={t} looks={looks} />}
        </div>
        {(fadeIn > 0 || fadeOut > 0) && <div className="fx" style={{ background: `rgba(0,0,0,${Math.max(fadeIn, fadeOut)})` }} />}
        {!clips.length && (
          <div className="still" style={{ display: "grid", placeItems: "center" }}>
            <span className="faint">The timeline is empty</span>
          </div>
        )}
      </div>
      <div style={{ display: "none" }}>
        {edit.audio.map((s) => assets[s.asset] && (
          <audio key={s.id} ref={(el) => { extra.current[s.id] = el; }} src={media.asset(p.id, s.asset)} preload="auto" />
        ))}
      </div>
    </div>
  );
});

export default Player;

function MediaLayer({ m, a, pid, t, W, H, k, settle, selected, onRef, onPick, onChange }: {
  m: MediaItem; a?: Asset; pid: string; t: number; W: number; H: number; k: number; settle: boolean; selected: boolean;
  onRef: (el: HTMLMediaElement | null) => void; onPick: () => void; onChange: (m: MediaItem, commit: boolean) => void;
}) {
  if (!a) return null;
  const on = t >= m.start && t < m.start + m.dur;
  const full = m.mode === "full";
  const aw = a.width || 16, ah = a.height || 9;
  const w = full ? W : W * (m.scale ?? 0.4);
  const h = full ? H : (w * ah) / aw;
  const e = settle ? Math.max(t - m.start, 0.6) : t - m.start;
  const left = settle ? Math.max(m.start + m.dur - t, 0.6) : m.start + m.dur - t;
  const anim = m.anim ?? "fade";
  let op = m.opacity ?? 1, dx = 0, dy = 0;
  if (anim !== "none") op *= Math.min(1, Math.max(0, e / 0.25), Math.max(0, left / 0.25));
  if (anim === "up") dy = H * 0.06 * Math.max(0, 1 - e / 0.3);
  if (anim === "left") dx = W * 0.06 * Math.max(0, 1 - e / 0.3);
  const css: CSSProperties = full
    ? { left: 0, top: 0, width: W, height: H, objectFit: "cover" }
    : { left: (m.x ?? 0.72) * W - w / 2 + dx, top: (m.y ?? 0.32) * H - h / 2 + dy, width: w, height: h, borderRadius: Math.min(w, h) * (m.radius ?? 0.06) };
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
  const style: CSSProperties = { ...css, opacity: on ? op : 0, pointerEvents: on ? "auto" : "none" };
  return a.kind === "image" ? (
    <img className={`mitem ${selected ? "sel" : ""}`} alt="" src={media.asset(pid, a.id)} style={style} onMouseDown={down} onWheel={wheel} draggable={false} />
  ) : (
    <video ref={onRef} className={`mitem ${selected ? "sel" : ""}`} src={media.asset(pid, a.id)} style={style} muted playsInline preload="auto" onMouseDown={down} onWheel={wheel} />
  );
}
