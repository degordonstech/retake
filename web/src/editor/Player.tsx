import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { media } from "../api";
import type { Clip, Overlay, Project, Take } from "../types";
import { isTitle, locate, offsetAt, totalDuration } from "./model";

export interface PlayerHandle {
  play: () => void;
  pause: () => void;
  seek: (t: number) => void;
  playing: () => boolean;
}

interface Props {
  p: Project;
  clips: Clip[];
  overlays: Overlay[];
  time: number;
  onTime: (t: number) => void;
  onPlayingChange: (playing: boolean) => void;
}

interface Els {
  video?: HTMLVideoElement | null;
  audio?: HTMLAudioElement | null;
}

/**
 * Plays the edit straight from the preview copies. A clock drives the
 * timeline; at each cut the right take's video (and its separate voice, if
 * any) is cued to the right moment, and corrected if it drifts.
 */
const Player = forwardRef<PlayerHandle, Props>(function Player({ p, clips, overlays, time, onTime, onPlayingChange }, ref) {
  const els = useRef<Record<string, Els>>({});
  const state = useRef({ playing: false, anchor: 0, t0: 0, clip: -1, raf: 0, lastEmit: 0 });
  const clipsRef = useRef(clips);
  clipsRef.current = clips;
  const takes = useMemo(() => Object.fromEntries(p.takes.map((t) => [t.id, t])), [p.takes]);
  const total = totalDuration(clips);

  const separate = (t: Take) => !!t.video && t.video !== t.voice;

  const pauseAll = () => {
    Object.values(els.current).forEach((e) => {
      e.video?.pause();
      e.audio?.pause();
    });
  };

  /** Point the media of the clip at timeline time t at the right moment. */
  const cue = (t: number, play: boolean) => {
    const cl = clipsRef.current;
    if (!cl.length) return;
    const { index, local } = locate(cl, t);
    const c = cl[index];
    const changed = state.current.clip !== index;
    state.current.clip = index;
    // Show only the active take's picture.
    Object.entries(els.current).forEach(([tid, e]) => {
      const on = !isTitle(c) && c.take === tid;
      if (e.video) e.video.style.opacity = on ? "1" : "0";
      if (!on) {
        e.video?.pause();
        e.audio?.pause();
      }
    });
    if (isTitle(c)) return;
    const take = takes[c.take];
    const e = els.current[c.take];
    if (!take || !e) return;
    const voiceT = c.a + local;
    const vidT = voiceT + offsetAt(take, c.a);
    const v = e.video;
    const a = separate(take) || !take.video ? e.audio : null;
    const fix = (el: HTMLMediaElement, want: number, tol: number) => {
      if (changed || Math.abs(el.currentTime - want) > tol) el.currentTime = Math.max(0, want);
    };
    if (v) fix(v, take.video === take.voice ? voiceT : vidT, play ? 0.3 : 0.02);
    if (a) fix(a, voiceT, play ? 0.2 : 0.02);
    if (play) {
      v?.play().catch(() => {});
      a?.play().catch(() => {});
    } else {
      v?.pause();
      a?.pause();
    }
  };

  const loop = () => {
    const s = state.current;
    if (!s.playing) return;
    const t = s.t0 + (performance.now() - s.anchor) / 1000;
    const tot = totalDuration(clipsRef.current);
    if (t >= tot) {
      stop();
      onTime(tot);
      return;
    }
    cue(t, true);
    if (performance.now() - s.lastEmit > 60) {
      s.lastEmit = performance.now();
      onTime(t);
    }
    s.raf = requestAnimationFrame(loop);
  };

  const start = () => {
    const s = state.current;
    if (s.playing || !clipsRef.current.length) return;
    let t = time;
    if (t >= totalDuration(clipsRef.current) - 0.05) t = 0;
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
    onTime(s.t0 + (performance.now() - s.anchor) / 1000);
  }

  useImperativeHandle(ref, () => ({
    play: start,
    pause: stop,
    playing: () => state.current.playing,
    seek: (t: number) => {
      const s = state.current;
      if (s.playing) {
        s.t0 = t;
        s.anchor = performance.now();
        s.clip = -1;
        cue(t, true);
      } else {
        s.clip = -1;
        cue(t, false);
      }
      onTime(t);
    },
  }));

  // Show the right still when not playing (after edits or seeks).
  useEffect(() => {
    if (!state.current.playing) {
      state.current.clip = -1;
      cue(Math.min(time, Math.max(0, total - 0.01)), false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [time, clips]);

  useEffect(() => () => cancelAnimationFrame(state.current.raf), []);

  // What to draw at the current time.
  const { index } = clips.length ? locate(clips, Math.min(time, total - 0.001)) : { index: -1 };
  const cur = index >= 0 ? clips[index] : null;
  const activeOverlays = overlays.filter((o) => time >= o.start && time < o.start + o.dur && o.text);
  const audioOnly = cur && !isTitle(cur) && !takes[cur.take]?.video;

  return (
    <div className="stage">
      {p.takes.map((t) => (
        <div key={t.id}>
          {t.video && (
            <video
              ref={(el) => { els.current[t.id] = { ...els.current[t.id], video: el }; }}
              src={media.proxy(p.id, t.video)}
              preload="auto"
              muted={separate(t)}
              playsInline
              style={{ opacity: 0 }}
            />
          )}
          {(separate(t) || !t.video) && (
            <audio ref={(el) => { els.current[t.id] = { ...els.current[t.id], audio: el }; }} src={media.proxy(p.id, t.voice)} preload="auto" />
          )}
        </div>
      ))}
      {cur && isTitle(cur) && (
        <img className="still" alt="" src={media.overlay(p.id, { kind: "title", text: cur.text, sub: cur.sub, tag: cur.tag })} />
      )}
      {audioOnly && (
        <div className="still" style={{ display: "grid", placeItems: "center", background: "var(--bg-2)" }}>
          <span className="muted">{takes[(cur as { take: string }).take]?.name} (voice only)</span>
        </div>
      )}
      {activeOverlays.map((o) => (
        <img key={o.id + o.text + (o.sub ?? "") + (o.tag ?? "")} className="ov" alt="" src={media.overlay(p.id, o)} />
      ))}
      {!clips.length && (
        <div className="still" style={{ display: "grid", placeItems: "center" }}>
          <span className="faint">The timeline is empty</span>
        </div>
      )}
    </div>
  );
});

export default Player;
