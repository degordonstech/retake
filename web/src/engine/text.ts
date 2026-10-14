/**
 * Captions and styled text, drawn on a 2D canvas the size of the frame.
 *
 * The look of every word comes from looks.ts (wordLook / textLook), which
 * follows the same timing as the export's subtitle file. Text is vertically
 * centred the way the browser centres a one-line box, so the canvas and the
 * editor's draggable handles line up.
 */
import type { CaptionLayout, Looks, Overlay, Shadow, Stroke } from "../types";
import { hexA, pageAt, textLook, wordLook } from "../looks";

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const loaded = new Set<string>();
const loading = new Set<string>();

/** True when the font is ready to draw; starts loading it if not. */
export function fontReady(css: string, onLoad: () => void): boolean {
  if (loaded.has(css)) return true;
  if (typeof document === "undefined" || !document.fonts) return true;
  if (!loading.has(css)) {
    loading.add(css);
    document.fonts.load(css).then(() => { loaded.add(css); onLoad(); }).catch(() => { loaded.add(css); });
  }
  return false;
}

function fontString(looks: Looks | null, name: string, px: number): string {
  const f = looks?.fonts[name];
  return `${f?.weight ?? 800} ${px.toFixed(2)}px "${f?.css ?? "Poppins"}"`;
}

/** Draw one line of text centred on (cx, cy) with outline, shadow and glow. */
function ink(ctx: Ctx, text: string, cx: number, cy: number, em: number, color: string, outline?: Stroke, shadow?: Shadow,
  glow?: string, alignLeftAt?: number) {
  const m = ctx.measureText(text);
  const asc = m.fontBoundingBoxAscent ?? em * 0.8, desc = m.fontBoundingBoxDescent ?? em * 0.2;
  const base = cy + (asc - desc) / 2;
  const x = alignLeftAt ?? cx;
  ctx.textAlign = alignLeftAt !== undefined ? "left" : "center";
  ctx.textBaseline = "alphabetic";
  const ow = (outline?.w ?? 0) * em;
  if (glow) {
    ctx.save();
    ctx.shadowColor = glow;
    ctx.fillStyle = color;
    for (const b of [0.12, 0.3, 0.5]) {
      ctx.shadowBlur = em * b;
      ctx.fillText(text, x, base);
    }
    ctx.restore();
  }
  if (shadow && shadow.alpha > 0) {
    ctx.save();
    ctx.shadowColor = `rgba(0,0,0,${shadow.alpha})`;
    ctx.shadowOffsetY = shadow.y * em;
    ctx.shadowBlur = 0;
    if (ow > 0) {
      ctx.lineWidth = ow * 2;
      ctx.lineJoin = "round";
      ctx.strokeStyle = outline!.color;
      ctx.strokeText(text, x, base);
    } else {
      ctx.fillStyle = color;
      ctx.fillText(text, x, base);
    }
    ctx.restore();
  }
  if (ow > 0) {
    ctx.lineWidth = ow * 2;
    ctx.lineJoin = "round";
    ctx.strokeStyle = outline!.color;
    ctx.strokeText(text, x, base);
  }
  ctx.fillStyle = color;
  ctx.fillText(text, x, base);
}

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.max(0, Math.min(r, w / 2, h / 2)));
  ctx.fill();
}

/** Captions at time t. `k` scales frame pixels to canvas pixels. */
export function drawCaptions(ctx: Ctx, layout: CaptionLayout, looks: Looks | null, t: number, k: number, redraw: () => void): boolean {
  const pi = pageAt(layout.pages, t);
  if (pi < 0) return false;
  const page = layout.pages[pi];
  const st = layout.style;
  const em = st.em * page.scale;
  const font = fontString(looks, st.font, em * k);
  if (!fontReady(font, redraw)) return true;
  ctx.font = font;
  if (st.mode === "plain" && st.box) {
    const [x0, y0, x1, y1] = page.box;
    const bp = st.box.pad * em;
    const w = x1 - x0 + 2 * bp, h = y1 - y0 + bp;
    const fade = Math.min(1, Math.max(0, (t - page.t0) / 0.08), Math.max(0, (page.t1 - t) / 0.08));
    ctx.save();
    ctx.globalAlpha = fade;
    ctx.fillStyle = hexA(st.box.color, st.box.alpha);
    roundRect(ctx, ((x0 + x1) / 2 - w / 2) * k, ((y0 + y1) / 2 - h / 2) * k, w * k, h * k, st.box.radius * em * k);
    ctx.restore();
  }
  page.words.forEach((w, i) => {
    const L = wordLook(st, page, pi, i, t);
    if (!L.visible || L.opacity <= 0.001) return;
    ctx.save();
    ctx.globalAlpha = L.opacity;
    ctx.translate((w.cx + L.dx) * k, (w.cy + L.dy) * k);
    ctx.scale(L.scale, L.scale);
    if (L.box) {
      ctx.fillStyle = L.box.color;
      roundRect(ctx, (-L.box.w / 2) * k, (-L.box.h / 2) * k, L.box.w * k, L.box.h * k, L.box.r * k);
    }
    if (L.marker) {
      ctx.fillStyle = L.marker.color;
      roundRect(ctx, (-L.marker.w / 2) * k, (-L.marker.h / 2) * k, L.marker.w * L.marker.progress * k, L.marker.h * k, L.marker.r * k);
    }
    const plainInk = L.marker && L.marker.progress > 0.5;
    ink(ctx, w.t, 0, 0, em * k, L.color, plainInk ? undefined : st.outline, plainInk ? undefined : st.shadow, L.glow);
    ctx.restore();
  });
  return true;
}

/** Styled text items at time t. `settle` shows each fully (paused editing). */
export function drawTexts(ctx: Ctx, items: Overlay[], looks: Looks | null, W: number, H: number, t: number, k: number,
  settle: boolean, redraw: () => void): boolean {
  if (!looks) return false;
  let any = false;
  for (const o of items) {
    if (o.kind !== "text" || !o.text || t < o.start || t >= o.start + o.dur) continue;
    const st = looks.texts.find((s) => s.id === o.style) ?? looks.texts[0];
    const tt = settle ? Math.min(Math.max(t, o.start + Math.min(0.6, o.dur / 2)), o.start + o.dur - Math.min(0.25, o.dur / 2)) : t;
    const L = textLook(o, st, W, H, tt);
    const font = fontString(looks, L.font, L.em * k);
    any = true;
    if (!fontReady(font, redraw)) continue;
    ctx.save();
    ctx.font = font;
    ctx.globalAlpha = L.opacity;
    const cx = ((o.x ?? 0.5) * W + L.dx) * k, cy = ((o.y ?? 0.5) * H + L.dy) * k;
    ctx.translate(cx, cy);
    ctx.scale(L.scale, L.scale);
    const em = L.em * k, lh = 1.18 * em;
    const widths = L.lines.map((ln) => ctx.measureText(ln).width);
    const block = lh * L.lines.length;
    if (st.box) {
      const bp = st.box.pad * em;
      const bw = Math.max(0, ...widths) + 2 * bp, bh = block + bp * 0.9;
      ctx.fillStyle = hexA(L.accent, st.box.alpha);
      roundRect(ctx, -bw / 2, -bh / 2, bw, bh, st.box.radius * em);
    }
    let shown = 0;
    L.lines.forEach((ln, i) => {
      const y = -block / 2 + lh * (i + 0.5);
      if (!ln) return;
      const visible = Math.max(0, Math.min(ln.length, L.chars - shown));
      shown += ln.length;
      if (visible <= 0) return;
      const text = visible < ln.length ? ln.slice(0, visible) : ln;
      ink(ctx, text, 0, y, em, L.color, st.outline, st.shadow, st.glow ? L.accent : undefined,
        visible < ln.length ? -widths[i] / 2 : undefined);
    });
    ctx.restore();
  }
  return any;
}
