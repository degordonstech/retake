import type { AudioItem, Clip, Edit, MediaClip, MediaItem, Overlay, Take, TitleClip, Transcript, Word } from "../types";
import { uid } from "../util";

export const isTitle = (c: Clip): c is TitleClip => c.kind === "title";
export const speedOf = (c: Clip) => (isTitle(c) ? 1 : Math.min(4, Math.max(0.25, c.speed ?? 1)));
/** Length on the timeline (a sped-up clip is shorter). */
export const clipDur = (c: Clip) => (isTitle(c) ? c.dur : (c.b - c.a) / speedOf(c));
/** Recording time (voice time) at `local` seconds into a clip. */
export const srcAt = (c: MediaClip, local: number) => c.a + local * speedOf(c);

export function totalDuration(clips: Clip[]): number {
  return clips.reduce((s, c) => s + clipDur(c), 0);
}

export function starts(clips: Clip[]): number[] {
  let t = 0;
  return clips.map((c) => {
    const s = t;
    t += clipDur(c);
    return s;
  });
}

/** Which clip plays at timeline time t, and how far into it. */
export function locate(clips: Clip[], t: number): { index: number; local: number } {
  let acc = 0;
  for (let i = 0; i < clips.length; i++) {
    const d = clipDur(clips[i]);
    if (t < acc + d - 1e-6) return { index: i, local: Math.max(0, t - acc) };
    acc += d;
  }
  return { index: clips.length - 1, local: clips.length ? clipDur(clips[clips.length - 1]) : 0 };
}

export function offsetAt(take: Take, t: number): number {
  let off = take.offsets[0]?.[1] ?? 0;
  for (const [at, o] of take.offsets) {
    if (at <= t) off = o;
    else break;
  }
  return off;
}

/** Split the clip under timeline time t into two. */
export function splitAt(edit: Edit, t: number): Edit {
  const { index, local } = locate(edit.clips, t);
  const c = edit.clips[index];
  if (!c || local < 0.05 || clipDur(c) - local < 0.05) return edit;
  let a: Clip, b: Clip;
  if (isTitle(c)) {
    a = { ...c, dur: local };
    b = { ...c, id: uid("c"), dur: c.dur - local, transition: undefined };
  } else {
    a = { ...c, b: srcAt(c, local) };
    b = { ...c, id: uid("c"), a: srcAt(c, local), transition: undefined };
  }
  const clips = [...edit.clips];
  clips.splice(index, 1, a, b);
  return { ...edit, clips };
}

export function removeClips(edit: Edit, ids: Set<string>): Edit {
  return { ...edit, clips: edit.clips.filter((c) => !ids.has(c.id)) };
}

export function moveClip(edit: Edit, id: string, toIndex: number): Edit {
  const from = edit.clips.findIndex((c) => c.id === id);
  if (from < 0) return edit;
  const clips = [...edit.clips];
  const [c] = clips.splice(from, 1);
  clips.splice(toIndex > from ? toIndex - 1 : toIndex, 0, c);
  return { ...edit, clips };
}

/** Change a clip's in or out point (in its own source time). */
export function trimClip(edit: Edit, id: string, side: "a" | "b", value: number, limit: { min: number; max: number }): Edit {
  return {
    ...edit,
    clips: edit.clips.map((c) => {
      if (c.id !== id) return c;
      if (isTitle(c)) return side === "b" ? { ...c, dur: Math.max(0.5, value) } : c;
      if (side === "a") return { ...c, a: Math.min(Math.max(limit.min, value), c.b - 0.1) };
      return { ...c, b: Math.max(Math.min(limit.max, value), c.a + 0.1) };
    }),
  };
}

/* -------------------------------------------------- transcript editing --- */
export function wordKept(clips: Clip[], take: string, w: Word): boolean {
  for (const c of clips) {
    if (!isTitle(c) && c.take === take && w.s >= c.a - 0.03 && w.e <= c.b + 0.06) return true;
  }
  return false;
}

/** Where to cut before word i and after word j: halfway into the pauses around them. */
function cutBounds(words: Word[], i: number, j: number): [number, number] {
  const before = i > 0 ? (words[i - 1].e + words[i].s) / 2 : Math.max(0, words[i].s - 0.1);
  const after = j + 1 < words.length ? (words[j].e + words[j + 1].s) / 2 : words[j].e + 0.15;
  return [Math.max(before, words[i].s - 0.25), Math.min(after, words[j].e + 0.3)];
}

/** Remove words i..j of a take from every clip that holds them. */
export function cutWords(edit: Edit, take: string, tr: Transcript, i: number, j: number): Edit {
  const [x, y] = cutBounds(tr.words, i, j);
  const out: Clip[] = [];
  for (const c of edit.clips) {
    if (isTitle(c) || c.take !== take || c.b <= x || c.a >= y) {
      out.push(c);
      continue;
    }
    if (c.a < x - 0.04) out.push({ ...c, b: x });
    if (c.b > y + 0.04) out.push({ ...c, id: out.some((o) => o.id === c.id) ? uid("c") : c.id, a: y });
  }
  return { ...edit, clips: out };
}

/** Bring words i..j of a take back: grow a neighbouring clip, or add one in the right place. */
export function restoreWords(edit: Edit, take: string, tr: Transcript, i: number, j: number): Edit {
  const words = tr.words;
  const [x, y] = cutBounds(words, i, j);
  const clips = [...edit.clips] as Clip[];
  const media = (c: Clip): c is MediaClip => !isTitle(c) && c.take === take;
  // Grow a clip that ends near the start, or starts near the end.
  const endsNear = clips.findIndex((c) => media(c) && Math.abs(c.b - x) < 0.6);
  const startsNear = clips.findIndex((c) => media(c) && Math.abs(c.a - y) < 0.6);
  if (endsNear >= 0 && startsNear >= 0 && startsNear === endsNear + 1) {
    const a = clips[endsNear] as MediaClip;
    const b = clips[startsNear] as MediaClip;
    clips.splice(endsNear, 2, { ...a, b: b.b });
    return { ...edit, clips };
  }
  if (endsNear >= 0) {
    const a = clips[endsNear] as MediaClip;
    clips[endsNear] = { ...a, b: Math.max(a.b, y) };
    return { ...edit, clips };
  }
  if (startsNear >= 0) {
    const b = clips[startsNear] as MediaClip;
    clips[startsNear] = { ...b, a: Math.min(b.a, x) };
    return { ...edit, clips };
  }
  // A new clip, after the last clip of this take that comes before it.
  let at = -1;
  clips.forEach((c, k) => {
    if (media(c) && c.b <= x + 0.01) at = k;
  });
  if (at < 0) {
    const firstOfTake = clips.findIndex((c) => media(c));
    at = firstOfTake >= 0 ? firstOfTake - 1 : clips.length - 1;
  }
  clips.splice(at + 1, 0, { id: uid("c"), take, a: x, b: y });
  return { ...edit, clips };
}

/** Timeline time of a word of a take, if kept. */
export function wordTime(clips: Clip[], take: string, w: Word): number | null {
  let t = 0;
  for (const c of clips) {
    if (!isTitle(c) && c.take === take && w.s >= c.a - 0.03 && w.s <= c.b) return t + Math.max(0, w.s - c.a) / speedOf(c);
    t += clipDur(c);
  }
  return null;
}

export function newOverlay(kind: Overlay["kind"], start: number, text = ""): Overlay {
  return {
    id: uid("o"),
    kind,
    text: text || (kind === "label" ? "New chapter" : kind === "lower" ? "Your text here" : "Caption"),
    sub: kind === "lower" ? "Add a short line under it" : "",
    tag: kind === "label" ? "STEP" : kind === "lower" ? "NOTE" : "",
    start: Math.max(0, start),
    dur: kind === "caption" ? 3 : 4.5,
  };
}

export function newText(style: string, start: number, text = "Your text"): Overlay {
  return { id: uid("o"), kind: "text", text, style, start: Math.max(0, start), dur: 3, x: 0.5, y: 0.5, anim: "pop", out: "fade" };
}

export function newMedia(asset: string, start: number, dur: number, kind: "image" | "video"): MediaItem {
  return { id: uid("m"), asset, start: Math.max(0, start), dur, in: 0, mode: kind === "video" ? "full" : "pip",
    x: 0.72, y: 0.32, scale: 0.42, radius: 0.06, opacity: 1, anim: "fade", volume: 0 };
}

export function newAudio(asset: string, start: number, dur: number, music: boolean): AudioItem {
  return { id: uid("s"), asset, start: Math.max(0, start), dur, in: 0, volume: music ? 0.45 : 0.9,
    fadeIn: music ? 1 : 0, fadeOut: music ? 2 : 0, duck: music, loop: false };
}

/** Edits saved before media, music, captions and shapes existed. */
export function normalize(e: Partial<Edit>): Edit {
  return { clips: e.clips ?? [], overlays: e.overlays ?? [], media: e.media ?? [], audio: e.audio ?? [],
    captions: e.captions ?? {}, format: e.format ?? { aspect: "16:9" } };
}

export function newTitle(): TitleClip {
  return { id: uid("c"), kind: "title", text: "Your video title", sub: "", tag: "", dur: 3 };
}
