import { memo, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { CaptionLayout, CaptionTemplate, Looks, Overlay } from "../types";
import { fontCss, hexA, inkCss, pageAt, textLook, wordLook } from "../looks";

/* ------------------------------------------------------------- captions --- */
export const CaptionLayer = memo(function CaptionLayer({ layout, t, looks }: { layout: CaptionLayout | null; t: number; looks: Looks | null }) {
  if (!layout) return null;
  const k = pageAt(layout.pages, t);
  if (k < 0) return null;
  const page = layout.pages[k];
  const st = layout.style;
  const em = st.em * page.scale;
  const font = fontCss(looks, st.font);
  const ink = inkCss(em, st.outline, st.shadow);
  let pageBox: CSSProperties | null = null;
  if (st.mode === "plain" && st.box) {
    const [x0, y0, x1, y1] = page.box;
    const bp = st.box.pad * em;
    const w = x1 - x0 + 2 * bp, h = y1 - y0 + bp;
    const fade = Math.min(1, Math.max(0, (t - page.t0) / 0.08), Math.max(0, (page.t1 - t) / 0.08));
    pageBox = {
      position: "absolute", left: (x0 + x1) / 2 - w / 2, top: (y0 + y1) / 2 - h / 2, width: w, height: h,
      borderRadius: st.box.radius * em, background: hexA(st.box.color, st.box.alpha), opacity: fade,
    };
  }
  return (
    <div className="layer">
      {pageBox && <div style={pageBox} />}
      {page.words.map((w, i) => {
        const L = wordLook(st, page, k, i, t);
        if (!L.visible || L.opacity <= 0.001) return null;
        return (
          <div key={i} className="cap-word" style={{
            left: w.cx, top: w.cy, opacity: L.opacity,
            transform: `translate(-50%, -50%) translate(${L.dx}px, ${L.dy}px) scale(${L.scale})`,
          }}>
            {L.box && <div className="cap-box" style={{ width: L.box.w, height: L.box.h, marginLeft: -L.box.w / 2, marginTop: -L.box.h / 2, borderRadius: L.box.r, background: L.box.color }} />}
            {L.marker && <div className="cap-box" style={{ width: L.marker.w * L.marker.progress, height: L.marker.h, marginLeft: -L.marker.w / 2, marginTop: -L.marker.h / 2, borderRadius: L.marker.r, background: L.marker.color }} />}
            <span style={{ ...font, fontSize: em, color: L.color, ...(L.marker && L.marker.progress > 0.5 ? {} : ink), ...(L.glow ? inkCss(em, st.outline, undefined, L.glow) : {}) }}>{w.t}</span>
          </div>
        );
      })}
    </div>
  );
});

/* ------------------------------------------------------------ free text --- */
interface TextProps {
  items: Overlay[];
  t: number;
  W: number;
  H: number;
  looks: Looks | null;
  selected: string | null;
  scale: number; // screen px per frame px, for dragging
  settle: boolean; // paused: show each item fully, not mid-animation
  onSelect: (id: string) => void;
  onMove: (o: Overlay, commit: boolean) => void;
}

export const TextLayer = memo(function TextLayer({ items, t, W, H, looks, selected, scale, settle, onSelect, onMove }: TextProps) {
  if (!looks) return null;
  return (
    <div className="layer">
      {items.map((o) => {
        if (o.kind !== "text" || t < o.start || t >= o.start + o.dur || !o.text) return null;
        const st = looks.texts.find((s) => s.id === o.style) ?? looks.texts[0];
        const tt = settle ? Math.min(Math.max(t, o.start + Math.min(0.6, o.dur / 2)), o.start + o.dur - Math.min(0.25, o.dur / 2)) : t;
        const L = textLook(o, st, W, H, tt);
        const ink = inkCss(L.em, st.outline, st.shadow, st.glow ? L.accent : undefined);
        let shown = 0;
        const box = st.box;
        const down = (e: React.MouseEvent) => {
          e.stopPropagation();
          onSelect(o.id);
          const x0 = e.clientX, y0 = e.clientY, ox = o.x ?? 0.5, oy = o.y ?? 0.5;
          let last = o;
          const move = (ev: MouseEvent) => {
            last = { ...o, x: Math.min(1, Math.max(0, ox + (ev.clientX - x0) / scale / W)), y: Math.min(1, Math.max(0, oy + (ev.clientY - y0) / scale / H)) };
            onMove(last, false);
          };
          const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); onMove(last, true); };
          window.addEventListener("mousemove", move);
          window.addEventListener("mouseup", up);
        };
        const wheel = (e: React.WheelEvent) => {
          if (selected !== o.id) return;
          e.stopPropagation();
          const size = Math.round(Math.min(400, Math.max(16, (o.size ?? st.size) * (e.deltaY < 0 ? 1.06 : 1 / 1.06))));
          onMove({ ...o, size }, true);
        };
        return (
          <div key={o.id} className={`txt ${selected === o.id ? "sel" : ""}`} onMouseDown={down} onWheel={wheel} style={{
            left: (o.x ?? 0.5) * W + L.dx, top: (o.y ?? 0.5) * H + L.dy, opacity: L.opacity,
            transform: `translate(-50%, -50%) scale(${L.scale})`,
          }}>
            <div style={{
              background: box ? hexA(L.accent, box.alpha) : undefined,
              padding: box ? `${0.45 * box.pad * L.em}px ${box.pad * L.em}px` : 0,
              borderRadius: box ? box.radius * L.em : 0,
            }}>
              {L.lines.map((line, li) => (
                <div key={li} style={{ ...fontCss(looks, L.font), fontSize: L.em, lineHeight: `${1.18 * L.em}px`, color: L.color, whiteSpace: "pre", textAlign: "center", ...ink }}>
                  {line.split("").map((ch, ci) => {
                    shown++;
                    return shown <= L.chars ? ch : <span key={ci} style={{ color: "transparent", WebkitTextStroke: "0 transparent", textShadow: "none" }}>{ch}</span>;
                  })}
                  {!line && " "}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
});

/* -------------------------------------------- gallery card: a live sample --- */
const SAMPLE = ["Make", "it", "look", "amazing", "today"];

/** A small looping demo of a caption template, for the template picker. */
export function CaptionSample({ tpl, looks, live }: { tpl: CaptionTemplate; looks: Looks | null; live: boolean }) {
  const [t, setT] = useState(0.35);
  const raf = useRef(0);
  useEffect(() => {
    if (!live) { setT(0.35); return; }
    const t0 = performance.now();
    const tick = () => { setT(((performance.now() - t0) / 1000) % 2.6); raf.current = requestAnimationFrame(tick); };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [live]);
  const n = Math.min(tpl.words, tpl.mode === "single" ? 1 : 3);
  const all = SAMPLE.map((w) => (tpl.upper ? w.toUpperCase() : w));
  // Words every 0.4 s; captions of n words.
  const idx = Math.min(all.length - 1, Math.floor(t / 0.42));
  const start = Math.floor(idx / n) * n;
  const words = all.slice(start, start + n);
  const em = 21;
  const ink = inkCss(em, tpl.outline, tpl.shadow);
  return (
    <div className="cap-sample" style={{ ...fontCss(looks, tpl.font) }}>
      <div style={{ display: "flex", gap: tpl.mode === "box" || tpl.mode === "marker" ? 4 : 6, alignItems: "center", justifyContent: "center", flexWrap: "wrap",
        background: tpl.box ? hexA(tpl.box.color, tpl.box.alpha) : undefined, padding: tpl.box ? "4px 10px" : 0, borderRadius: tpl.box ? 8 : 0 }}>
        {words.map((w, i) => {
          const k = start + i;
          const s = k * 0.42;
          const active = t >= s && (k === idx);
          const past = t >= s && !active;
          const since = t - s;
          let color = tpl.color, scale = 1, opacity = 1, bg: string | undefined;
          const mode = tpl.mode;
          if (mode === "reveal" && t < s) opacity = 0;
          if (mode === "fade" && t < s) opacity = 0.55;
          if (active) {
            if (["karaoke", "pop", "reveal"].includes(mode)) color = tpl.hi;
            if (mode === "pop" || mode === "box") scale = 1 + ((tpl.grow ?? 1) - 1) * Math.min(1, since / 0.09);
            if (mode === "box" || mode === "marker") { bg = tpl.hi; color = tpl.hi_text ?? "#fff"; }
          }
          if (past && mode === "karaoke" && tpl.past === "hi") color = tpl.hi;
          if (mode === "single") { color = (tpl.alt ?? [tpl.color])[k % (tpl.alt?.length ?? 1)]; scale = since < 0.08 ? 0.7 + 0.38 * (since / 0.08) : 1; }
          return (
            <span key={k} style={{
              fontSize: mode === "single" ? em * 1.35 : em, color, opacity, transform: `scale(${scale})`, display: "inline-block",
              background: bg, borderRadius: bg ? 5 : 0, padding: bg ? "0 4px" : 0, lineHeight: 1.15,
              ...(bg ? {} : ink), ...(active && mode === "glow" ? inkCss(em, tpl.outline, undefined, tpl.hi) : {}),
            }}>{w}</span>
          );
        })}
      </div>
    </div>
  );
}
