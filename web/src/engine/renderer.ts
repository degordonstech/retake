/**
 * Draws one moment of a scene.
 *
 * Same rules as the export: a clip fits or fills the frame, then zooms
 * towards its focus point; a transition draws both clips into their own
 * frames and blends them; B-roll, graphics, text and captions go on top.
 * Pictures that aren't decoded yet are simply not drawn this time; the
 * renderer is asked again as soon as they arrive.
 */
import type { CaptionLayout, Looks } from "../types";
import { Compositor } from "./gl";
import type { Frame } from "./media";
import { MediaPool } from "./media";
import type { MainLayer, Scene } from "./scene";
import { mainAt, zoomAt } from "./scene";
import { drawCaptions, drawTexts } from "./text";

export interface RenderOpts {
  /** Output pixels per frame pixel (preview is smaller than the export). */
  k: number;
  playing: boolean;
  settle: boolean;
  layout: CaptionLayout | null;
  captions: boolean;
  looks: Looks | null;
  /** Exporting: a stand-in frame counts as missing. */
  exact?: boolean;
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** Counters for tests and the debug overlay. */
export const stats = { frames: 0, missing: 0 };
(globalThis as { __retake?: typeof stats }).__retake = stats;

export class Renderer {
  readonly comp: Compositor;
  readonly pool: MediaPool;
  private ink: OffscreenCanvas | null = null;
  /** Pictures still missing in the last frame drawn. */
  missing = 0;
  onNeedRedraw: (() => void) | null = null;

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas, pool?: MediaPool) {
    this.comp = new Compositor(canvas);
    this.pool = pool ?? new MediaPool();
    this.pool.onFrame = () => this.onNeedRedraw?.();
  }

  render(scene: Scene, t: number, o: RenderOpts) {
    const { comp } = this;
    const W = Math.max(2, Math.round(scene.width * o.k)), H = Math.max(2, Math.round(scene.height * o.k));
    this.missing = 0;
    stats.frames++;
    comp.begin(W, H, "#000000");
    const at = mainAt(scene, t);
    if (at.cut && at.a && at.b) {
      comp.bind("A");
      comp.clear("#000000");
      this.main(scene, at.a, t, o);
      comp.bind("B");
      comp.clear("#000000");
      this.main(scene, at.b, t, o);
      comp.bind(null);
      comp.transition("A", "B", at.cut.type, at.progress);
    } else if (at.a) {
      this.main(scene, at.a, t, o);
    }
    if (o.playing) this.prefetch(scene, t);
    this.overlays(scene, t, o);
    this.graphics(scene, t, o);
    this.text(scene, t, o, W, H);
    // Fade in from and out to black.
    let black = 0;
    if (!o.settle) {
      if (scene.fadeIn && t < 0.6) black = Math.max(black, 1 - t / 0.6);
      if (scene.fadeOut && t > scene.duration - 0.8) black = Math.max(black, (t - (scene.duration - 0.8)) / 0.8);
    }
    if (black > 0) comp.rect(0, 0, scene.width * o.k, scene.height * o.k, "#000000", clamp(black, 0, 1));
    stats.missing += this.missing;
  }

  /** The next clip's first frame, decoded just before its cut. */
  private prefetch(scene: Scene, t: number) {
    const at = mainAt(scene, t);
    const cur = at.b ?? at.a;
    if (!cur) return;
    const next = scene.main[cur.index + 1];
    if (next && next.picture.kind === "video" && next.from - t < 0.6 && next.from > t) {
      this.pool.video(next.picture.url, next.srcAt(next.from), true, next.index % 2);
    }
  }

  private main(scene: Scene, l: MainLayer, t: number, o: RenderOpts) {
    const { comp } = this;
    const k = o.k;
    const W = scene.width, H = scene.height;
    let f: Frame | null;
    if (l.picture.kind === "image") f = this.pool.image(l.picture.url);
    else f = this.pool.video(l.picture.url, l.srcAt(t), o.playing, l.index % 2);
    if (!f) { this.missing++; return; }
    if (o.exact && !f.exact) this.missing++;
    const sw = f.width, sh = f.height;
    const fr = l.framing;
    const z = zoomAt(l, t);
    // Where the zoom window sits, in frame pixels.
    const zw = W / z, zh = H / z;
    const L = clamp(fr.x * W - zw / 2, 0, W - zw), T = clamp(fr.y * H - zh / 2, 0, H - zh);
    const place = (x: number, y: number, w: number, h: number) => ({ x: (x - L) * z * k, y: (y - T) * z * k, w: w * z * k, h: h * z * k });
    const still = l.picture.kind === "image";
    let rect: { x: number; y: number; w: number; h: number };
    if (fr.mode === "fill") {
      const s = Math.max(W / sw, H / sh);
      const w = sw * s, h = sh * s;
      rect = place(-(w - W) * fr.x, -(h - H) * fr.y, w, h);
      comp.picture(f.source, { ...rect, rotation: f.rotation, adj: l.adjust }, still);
    } else {
      if (fr.bg === "blur") {
        // Fill a frame an eighth the size, then stretch it back up softly.
        const prev = comp.current;
        const small: [number, number] = [Math.max(8, W * k / 8), Math.max(8, H * k / 8)];
        comp.bind("bgsmall", small);
        const s = Math.max(W / sw, H / sh);
        const w = sw * s * k / 8, h = sh * s * k / 8;
        comp.picture(f.source, { x: (small[0] - w) / 2, y: (small[1] - h) / 2, w, h, rotation: f.rotation,
          adj: { brightness: -0.16, saturation: 0.1 } }, still);
        comp.bind(prev);
        comp.target("bgsmall", { ...place(0, 0, W, H), blur: 1.6 });
      } else {
        const p = place(0, 0, W, H);
        comp.rect(p.x, p.y, p.w, p.h, scene.background, 1);
      }
      const s = Math.min(W / sw, H / sh);
      const w = sw * s, h = sh * s;
      rect = place((W - w) / 2, (H - h) / 2, w, h);
      comp.picture(f.source, { ...rect, rotation: f.rotation, adj: l.adjust }, still);
    }
    // Private areas: the same part of the picture, blurred, on top.
    if (l.blurs.length && !still) {
      const ft = l.srcAt(t);
      for (const [a, b, x0, y0, x1, y1] of l.blurs) {
        if (ft < a || ft > b) continue;
        comp.picture(f.source, {
          x: rect.x + x0 * rect.w, y: rect.y + y0 * rect.h, w: (x1 - x0) * rect.w, h: (y1 - y0) * rect.h,
          crop: [x0, y0, x1, y1], rotation: f.rotation, adj: l.adjust, blur: Math.max(sw, sh) / 90,
        }, still);
      }
    }
    // Title cards fade from and to black where there's no transition.
    if (l.still && l.picture.kind === "image" && !o.settle) {
      let a = 0;
      if (l.softIn && t < l.start + 0.3) a = Math.max(a, 1 - (t - l.start) / 0.3);
      if (l.softOut && t > l.start + l.dur - 0.35) a = Math.max(a, (t - (l.start + l.dur - 0.35)) / 0.35);
      if (a > 0) comp.rect(0, 0, W * k, H * k, "#000000", clamp(a, 0, 1));
    }
  }

  private overlays(scene: Scene, t: number, o: RenderOpts) {
    const W = scene.width, H = scene.height, k = o.k;
    for (const m of scene.overlays) {
      // Keep B-roll decoders warm a moment before they show.
      if (m.picture.kind === "video" && t >= m.start - 0.5 && t < m.start) this.pool.video(m.picture.url, m.srcAt(m.start), o.playing, 2);
      if (t < m.start || t >= m.start + m.dur) continue;
      const f = m.picture.kind === "image" ? this.pool.image(m.picture.url) : this.pool.video(m.picture.url, m.srcAt(t), o.playing, 2);
      if (!f) { this.missing++; continue; }
      if (o.exact && !f.exact) this.missing++;
      const e = o.settle ? Math.max(t - m.start, 0.6) : t - m.start;
      const left = o.settle ? Math.max(m.start + m.dur - t, 0.6) : m.start + m.dur - t;
      let op = m.opacity, dx = 0, dy = 0;
      if (m.anim !== "none") op *= clamp(Math.min(e / 0.25, left / 0.25), 0, 1);
      if (m.anim === "up") dy = H * 0.06 * Math.max(0, 1 - e / 0.3);
      if (m.anim === "left") dx = W * 0.06 * Math.max(0, 1 - e / 0.3);
      const still = m.picture.kind === "image";
      if (m.full) {
        const s = Math.max(W / f.width, H / f.height);
        const w = f.width * s, h = f.height * s;
        this.comp.picture(f.source, { x: (W - w) / 2 * k, y: (H - h) / 2 * k, w: w * k, h: h * k, rotation: f.rotation, opacity: op }, still);
      } else {
        const w = W * m.scale, h = (w * f.height) / f.width;
        this.comp.picture(f.source, {
          x: (m.x * W - w / 2 + dx) * k, y: (m.y * H - h / 2 + dy) * k, w: w * k, h: h * k,
          rotation: f.rotation, opacity: op, radius: Math.min(w, h) * m.radius * k,
        }, still);
      }
    }
  }

  private graphics(scene: Scene, t: number, o: RenderOpts) {
    for (const g of scene.graphics) {
      if (t < g.start || t >= g.start + g.dur) continue;
      const f = this.pool.image(g.url);
      if (!f) { this.missing++; continue; }
      const e = o.settle ? 1 : t - g.start, left = o.settle ? 1 : g.start + g.dur - t;
      const op = clamp(Math.min(e / 0.25, left / 0.3), 0, 1);
      this.comp.picture(f.source, { x: 0, y: 0, w: scene.width * o.k, h: scene.height * o.k, opacity: op }, true);
    }
  }

  private text(scene: Scene, t: number, o: RenderOpts, W: number, H: number) {
    const hasText = scene.texts.some((x) => t >= x.start && t < x.start + x.dur);
    const hasCaps = o.captions && !!o.layout;
    if (!hasText && !hasCaps) return;
    if (!this.ink || this.ink.width !== W || this.ink.height !== H) this.ink = new OffscreenCanvas(W, H);
    const ctx = this.ink.getContext("2d")!;
    ctx.clearRect(0, 0, W, H);
    const redraw = () => this.onNeedRedraw?.();
    let drew = false;
    if (hasText) drew = drawTexts(ctx, scene.texts, o.looks, scene.width, scene.height, t, o.k, o.settle, redraw) || drew;
    if (hasCaps) drew = drawCaptions(ctx, o.layout!, o.looks, t, o.k, redraw) || drew;
    if (drew) this.comp.picture(this.ink, { x: 0, y: 0, w: W, h: H });
  }

  dispose() {
    this.comp.dispose();
    this.pool.dispose();
  }
}
