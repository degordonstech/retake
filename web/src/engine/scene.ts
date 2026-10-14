/**
 * The scene: an edit turned into "what is on screen at time t".
 *
 * The editor's own data (clips in a row, plus items laid over them) is
 * compiled once per change into layers with plain numbers, and the renderer
 * only ever asks the scene what to draw at a moment. The rules here mirror
 * the ffmpeg export (render.py) so both agree: transitions are centred on
 * their cut and borrow picture from just outside each clip, speed changes
 * how fast the recording is read, and framing fits, fills or zooms.
 */
import type { Adjust, Asset, Clip, Edit, Looks, MediaClip, MediaItem, Overlay, Project, Take } from "../types";
import { clipDur, isTitle, speedOf, starts } from "../editor/model";

export type Ease = "linear" | "smooth";

export interface Framing {
  mode: "fit" | "fill";
  zoom: number;
  zoomTo: number;
  x: number;
  y: number;
  bg: "color" | "blur";
}

/** A picture source: a video read at some time, or a still image. */
export type Picture =
  | { kind: "video"; url: string; width: number; height: number; duration: number }
  | { kind: "image"; url: string; width: number; height: number };

/** One clip of the main row, as the renderer sees it. */
export interface MainLayer {
  id: string;
  index: number;
  /** Real start and length on the timeline. */
  start: number;
  dur: number;
  /** Visible from/until (wider than start..start+dur when a transition borrows frames). */
  from: number;
  until: number;
  picture: Picture;
  /** Time in the picture's file at timeline time t (held at the file's ends). */
  srcAt: (t: number) => number;
  framing: Framing;
  adjust: Adjust;
  /** Fade from/to black at its real edges (title cards with no transition). */
  softIn: boolean;
  softOut: boolean;
  /** Voice-only takes and title cards are drawn as stills. */
  still: boolean;
  /** Private areas: [from, to] in file seconds, then x0, y0, x1, y1 as 0..1 of the picture. */
  blurs: number[][];
}

export interface Cut {
  /** Index of the clip the transition goes into. */
  index: number;
  type: string;
  at: number; // the cut, on the timeline
  dur: number;
}

export interface OverlayLayer {
  id: string;
  start: number;
  dur: number;
  picture: Picture;
  srcAt: (t: number) => number;
  full: boolean;
  x: number;
  y: number;
  scale: number;
  radius: number;
  opacity: number;
  anim: string;
}

export interface GraphicLayer {
  id: string;
  start: number;
  dur: number;
  url: string; // a full-frame PNG from the engine (chapter label, lower third, caption bar)
}

export interface Scene {
  width: number;
  height: number;
  fps: number;
  duration: number;
  background: string;
  main: MainLayer[];
  cuts: Cut[];
  overlays: OverlayLayer[];
  graphics: GraphicLayer[];
  texts: Overlay[];
  fadeIn: boolean;
  fadeOut: boolean;
}

export interface SceneInput {
  p: Project;
  edit: Edit;
  looks: Looks | null;
  size: [number, number];
  fps?: number;
  background?: string;
  /** URL of a take's picture for this purpose (preview copy or full file). */
  videoUrl: (sourceId: string) => string;
  assetUrl: (a: Asset) => string;
  stillUrl: (o: { kind: string; text: string; sub?: string; tag?: string }) => string;
  /** Blur areas per source, in source pixels (from the privacy step). */
  blurs?: Record<string, number[][]>;
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

export function offsetAt(take: Take, t: number): number {
  let off = take.offsets[0]?.[1] ?? 0;
  for (const [at, o] of take.offsets) {
    if (at <= t) off = o;
    else break;
  }
  return off;
}

export function framingOf(c: MediaClip, take: Take | undefined, aspect: string): Framing {
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

export function adjustOf(c: Clip, looks: Looks | null): Adjust {
  if (isTitle(c)) return {};
  const base = { ...(looks?.filters.find((f) => f.id === (c.filter ?? "none"))?.adj ?? {}) } as Record<string, number>;
  for (const [k, v] of Object.entries(c.adjust ?? {})) base[k] = (base[k] ?? 0) + (v ?? 0);
  return base as Adjust;
}

/** Transition lengths into each clip, kept short enough that every clip
 *  still shows on its own for a moment (same rule as the export). */
export function transitionLengths(clips: Clip[], known: Set<string>): number[] {
  const out = clips.map(() => 0);
  for (let i = 1; i < clips.length; i++) {
    const tr = clips[i].transition;
    if (!tr?.type || !known.has(tr.type)) continue;
    const limit = 0.45 * Math.min(clipDur(clips[i - 1]), clipDur(clips[i]));
    const d = Math.max(0, Math.min(tr.dur || 0.5, limit, 2));
    out[i] = d < 0.1 ? 0 : d;
  }
  for (let i = 1; i < clips.length - 1; i++) {
    const room = clipDur(clips[i]) - 0.1;
    const need = out[i] / 2 + out[i + 1] / 2;
    if (need > room) {
      const s = room / Math.max(1e-6, need);
      out[i] *= s;
      out[i + 1] *= s;
    }
  }
  return out;
}

export function compileScene(inp: SceneInput): Scene {
  const { p, edit, looks } = inp;
  const [W, H] = inp.size;
  const aspect = edit.format?.aspect ?? "16:9";
  const takes = Object.fromEntries(p.takes.map((t) => [t.id, t]));
  const sources = Object.fromEntries(p.sources.map((s) => [s.id, s]));
  const assets = Object.fromEntries(p.assets.map((a) => [a.id, a]));
  const clips = edit.clips;
  const st = starts(clips);
  const known = new Set((looks?.transitions ?? []).map((t) => t.id));
  const trans = transitionLengths(clips, known);
  const duration = clips.reduce((s, c) => s + clipDur(c), 0);

  const main: MainLayer[] = clips.map((c, i) => {
    const dur = clipDur(c);
    const dIn = trans[i], dOut = trans[i + 1] ?? 0;
    const base = {
      id: c.id, index: i, start: st[i], dur, from: st[i] - dIn / 2, until: st[i] + dur + dOut / 2,
      softIn: !dIn, softOut: !dOut, blurs: [] as number[][],
    };
    if (isTitle(c)) {
      return {
        ...base, still: true, adjust: {}, srcAt: () => 0,
        picture: { kind: "image", url: inp.stillUrl({ kind: "title", text: c.text, sub: c.sub, tag: c.tag }), width: W, height: H },
        framing: { mode: "fill", zoom: 1, zoomTo: 1, x: 0.5, y: 0.5, bg: "color" },
      } as MainLayer;
    }
    const take = takes[c.take];
    const sp = speedOf(c);
    const voiceAt = (t: number) => c.a + (t - st[i]) * sp;
    if (!take?.video) {
      return {
        ...base, still: true, adjust: {}, srcAt: () => 0, softIn: false, softOut: false,
        picture: { kind: "image", url: inp.stillUrl({ kind: "title", text: take?.name ?? "", sub: "", tag: "" }), width: W, height: H },
        framing: { mode: "fill", zoom: 1, zoomTo: 1, x: 0.5, y: 0.5, bg: "color" },
      } as MainLayer;
    }
    const src = sources[take.video];
    const same = take.video === take.voice;
    const off = same ? 0 : offsetAt(take, c.a);
    const fileDur = src?.duration ?? take.duration + off;
    const sw = src?.width || 1920, sh = src?.height || 1080;
    const blurs = (inp.blurs?.[take.video] ?? []).map(([a, b, x0, y0, x1, y1]) => [a, b, x0 / sw, y0 / sh, x1 / sw, y1 / sh]);
    return {
      ...base, still: false, blurs,
      picture: { kind: "video", url: inp.videoUrl(take.video), width: src?.width || 1920, height: src?.height || 1080, duration: fileDur },
      srcAt: (t: number) => clamp(voiceAt(t) + off, 0, Math.max(0, fileDur - 0.001)),
      framing: framingOf(c, take, aspect),
      adjust: adjustOf(c, looks),
    } as MainLayer;
  });

  const cuts: Cut[] = [];
  for (let i = 1; i < clips.length; i++) {
    if (trans[i]) cuts.push({ index: i, type: clips[i].transition!.type, at: st[i], dur: trans[i] });
  }

  const overlays: OverlayLayer[] = [];
  for (const m of edit.media as MediaItem[]) {
    const a = assets[m.asset];
    if (!a || a.kind === "audio" || a.missing) continue;
    const picture: Picture = a.kind === "image"
      ? { kind: "image", url: inp.assetUrl(a), width: a.width || 1, height: a.height || 1 }
      : { kind: "video", url: inp.assetUrl(a), width: a.width || 16, height: a.height || 9, duration: a.duration ?? 0 };
    overlays.push({
      id: m.id, start: m.start, dur: m.dur, picture,
      srcAt: (t: number) => clamp((m.in ?? 0) + (t - m.start), 0, Math.max(0, (a.duration ?? 0) - 0.001)),
      full: m.mode === "full", x: m.x ?? 0.72, y: m.y ?? 0.32, scale: m.scale ?? 0.4, radius: m.radius ?? 0.06,
      opacity: m.opacity ?? 1, anim: m.anim ?? "fade",
    });
  }

  const graphics: GraphicLayer[] = edit.overlays
    .filter((o) => o.kind !== "text" && o.text)
    .map((o) => ({ id: o.id, start: o.start, dur: o.dur, url: inp.stillUrl(o) }));

  return {
    width: W, height: H, fps: inp.fps ?? 30, duration, background: inp.background ?? "#0a0e14",
    main, cuts, overlays, graphics, texts: edit.overlays.filter((o) => o.kind === "text"),
    fadeIn: !!edit.format?.fadeIn, fadeOut: !!edit.format?.fadeOut,
  };
}

/** Which main clips are on screen at t, and the transition between them if any. */
export function mainAt(scene: Scene, t: number): { a: MainLayer | null; b: MainLayer | null; cut: Cut | null; progress: number } {
  const ls = scene.main;
  // Binary search for the clip whose real span holds t.
  let lo = 0, hi = ls.length - 1, k = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ls[mid].start <= t) { k = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (k < 0) return { a: ls[0] ?? null, b: null, cut: null, progress: 0 };
  const cur = ls[k];
  // Inside the transition into this clip, or out of it into the next?
  for (const c of scene.cuts) {
    if (t >= c.at - c.dur / 2 && t < c.at + c.dur / 2) {
      return { a: ls[c.index - 1], b: ls[c.index], cut: c, progress: (t - (c.at - c.dur / 2)) / c.dur };
    }
  }
  return { a: cur, b: null, cut: null, progress: 0 };
}

/** The framing zoom at t (a Ken Burns push eases across the clip). */
export function zoomAt(l: MainLayer, t: number): number {
  const q = l.dur > 0 ? clamp((t - l.start) / l.dur, 0, 1) : 0;
  const e = (1 - Math.cos(Math.PI * q)) / 2;
  return l.framing.zoom + (l.framing.zoomTo - l.framing.zoom) * e;
}
