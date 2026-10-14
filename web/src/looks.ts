import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { api } from "./api";
import type { CaptionLayout, CaptionPage, Looks, Overlay, Shadow, Stroke, TextStyle } from "./types";

let cached: Looks | null = null;
let pending: Promise<Looks> | null = null;

/** The caption templates, text styles, filters and transitions (from the engine). */
export function useLooks(): Looks | null {
  const [looks, setLooks] = useState<Looks | null>(cached);
  useEffect(() => {
    if (cached) return;
    pending ??= api.looks().then((l) => (cached = l));
    let alive = true;
    pending.then((l) => alive && setLooks(l)).catch(() => { pending = null; });
    return () => { alive = false; };
  }, []);
  return looks;
}

export function fontCss(looks: Looks | null, font: string): CSSProperties {
  const f = looks?.fonts[font];
  return { fontFamily: `"${f?.css ?? "Poppins"}", "Inter Variable", sans-serif`, fontWeight: f?.weight ?? 800 };
}

/** CSS for an ASS-style outline and drop shadow, `em` being the font size in px.
 *  libass draws the outline outside the letters; a CSS stroke is centred on
 *  the edge, so it is drawn twice as wide with the fill painted on top. */
export function inkCss(em: number, outline?: Stroke, shadow?: Shadow, glow?: string): CSSProperties {
  const css: CSSProperties = {};
  const w = (outline?.w ?? 0) * em;
  if (w > 0) {
    css.WebkitTextStroke = `${(w * 2).toFixed(1)}px ${outline!.color}`;
    css.paintOrder = "stroke fill";
  }
  const shadows: string[] = [];
  if (shadow && shadow.alpha > 0) shadows.push(`0 ${(shadow.y * em).toFixed(1)}px 0 rgba(0,0,0,${shadow.alpha})`);
  if (glow) shadows.push(`0 0 ${(em * 0.12).toFixed(1)}px ${glow}`, `0 0 ${(em * 0.3).toFixed(1)}px ${glow}`, `0 0 ${(em * 0.5).toFixed(1)}px ${glow}`);
  if (shadows.length) css.textShadow = shadows.join(", ");
  return css;
}

export function hexA(hex: string, alpha: number): string {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export interface WordLook {
  visible: boolean;
  color: string;
  opacity: number;
  scale: number;
  dx: number;
  dy: number;
  glow?: string;
  box?: { w: number; h: number; r: number; color: string };
  marker?: { w: number; h: number; r: number; color: string; progress: number };
}

/** How one caption word looks at time t: the same rules the export writes. */
export function wordLook(st: CaptionLayout["style"], page: CaptionPage, pageIndex: number, i: number, t: number): WordLook {
  const ws = page.words;
  const w = ws[i];
  const em = st.em * page.scale;
  const s = Math.max(page.t0, w.s);
  const nxt = i + 1 < ws.length ? Math.max(s, Math.min(page.t1, ws[i + 1].s)) : page.t1;
  const state = t < s ? "future" : t < nxt ? "active" : "past";
  const look: WordLook = { visible: true, color: st.color, opacity: 1, scale: 1, dx: 0, dy: 0 };
  // Page in and out.
  const inF = clamp01((t - page.t0) / 0.09);
  const outF = clamp01((page.t1 - t) / 0.09);
  look.opacity = Math.min(inF, outF);
  if (st.enter === "up") look.dy = em * 0.4 * (1 - clamp01((t - page.t0) / 0.17));
  const mode = st.mode;
  const since = t - s;
  const grow = (g: number) => 1 + (g - 1) * clamp01(since / 0.09);

  if (mode === "plain") return look;
  if (mode === "single") {
    const alt = st.alt?.length ? st.alt : [st.color];
    look.color = alt[pageIndex % alt.length];
    const e = t - page.t0;
    look.scale = e < 0.08 ? 0.7 + (1.08 - 0.7) * (e / 0.08) : e < 0.15 ? 1.08 - 0.08 * ((e - 0.08) / 0.07) : 1;
    return look;
  }
  if (state === "future") {
    if (mode === "reveal") look.visible = false;
    if (mode === "fade") look.opacity *= 0.58;
    return look;
  }
  if (state === "active") {
    if (mode === "reveal") {
      look.color = st.hi;
      look.opacity = clamp01(since / 0.09) * outF;
      look.dy = em * 0.16 * (1 - clamp01(since / 0.11));
      return look;
    }
    if (mode === "karaoke") look.color = st.hi;
    if (mode === "pop") { look.color = st.hi; look.scale = grow(st.grow ?? 1); }
    if (mode === "box") {
      look.color = st.hi_text ?? "#FFFFFF";
      look.scale = grow(st.grow ?? 1);
      look.box = { w: w.w, h: em * 1.24, r: em * 0.22, color: st.hi };
    }
    if (mode === "marker") {
      const pr = clamp01(since / 0.12);
      look.color = pr > 0.5 ? (st.hi_text ?? "#141414") : st.color;
      look.marker = { w: w.w, h: em * 0.98, r: em * 0.14, color: st.hi, progress: pr };
    }
    if (mode === "glow") look.glow = st.hi;
    return look;
  }
  // Already said.
  if (mode === "karaoke" && st.past === "hi") look.color = st.hi;
  return look;
}

/** Find the caption showing at t (pages are in time order). */
export function pageAt(pages: CaptionPage[], t: number): number {
  let lo = 0, hi = pages.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pages[mid].t0 <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans >= 0 && t < pages[ans].t1 ? ans : -1;
}

export interface TextLook {
  em: number;
  lines: string[];
  opacity: number;
  scale: number;
  dx: number;
  dy: number;
  chars: number; // letters shown so far (typewriter)
  font: string;
  color: string;
  accent: string;
}

/** A styled text item at time t, for a W x H frame. */
export function textLook(o: Overlay, st: TextStyle, W: number, H: number, t: number): TextLook {
  const em = (o.size ?? st.size) * Math.min(W, H) / 1080;
  const upper = o.upper ?? st.upper ?? false;
  const lines = (upper ? o.text.toUpperCase() : o.text).split("\n");
  const e = t - o.start;
  const left = o.start + o.dur - t;
  const anim = o.anim ?? "pop";
  const fin = ["fade", "pop", "up", "left"].includes(anim) ? 0.22 : 0;
  const fout = (o.out ?? "fade") === "fade" ? 0.22 : 0;
  let opacity = 1;
  if (fin) opacity = Math.min(opacity, clamp01(e / fin));
  if (fout) opacity = Math.min(opacity, clamp01(left / fout));
  let scale = 1, dx = 0, dy = 0;
  if (anim === "pop") scale = e < 0.15 ? 0.45 + (1.06 - 0.45) * (e / 0.15) : e < 0.23 ? 1.06 - 0.06 * ((e - 0.15) / 0.08) : 1;
  if (anim === "up") dy = em * 0.7 * (1 - clamp01(e / 0.28));
  if (anim === "left") dx = W * 0.07 * (1 - clamp01(e / 0.28));
  let chars = Infinity;
  if (anim === "type") {
    const total = lines.reduce((n, l) => n + l.length, 0) || 1;
    const perChar = Math.round(Math.min(6, Math.max(2, (o.dur * 1000 * 0.45) / 10 / total))) / 100;
    chars = Math.floor(e / perChar) + 1;
  }
  return {
    em, lines, opacity, scale, dx, dy, chars,
    font: o.font || st.font,
    color: o.color || st.color,
    accent: o.accent || st.box?.color || st.glow || "#FF8A3D",
  };
}
