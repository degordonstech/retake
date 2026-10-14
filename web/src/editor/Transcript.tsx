import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Camera, Monitor, AudioLines, Scissors, Undo2 } from "lucide-react";
import type { Clip, Project, Transcript as Tr } from "../types";
import { isTitle, locate, srcAt, wordKept, wordTime } from "./model";

interface Props {
  p: Project;
  transcripts: Record<string, Tr>;
  clips: Clip[];
  time: number;
  onSeek: (t: number) => void;
  onCut: (take: string, i: number, j: number) => void;
  onRestore: (take: string, i: number, j: number) => void;
  onFix: (take: string, word: number, text: string) => void;
}

type Sel = { take: string; i: number; j: number } | null;
const ICON = { screen: Monitor, camera: Camera, audio: AudioLines };

export default function Transcript({ p, transcripts, clips, time, onSeek, onCut, onRestore, onFix }: Props) {
  const [sel, setSel] = useState<Sel>(null);
  const [fixing, setFixing] = useState<{ take: string; i: number; text: string; x: number; y: number; w: number } | null>(null);
  const drag = useRef<{ take: string; i: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const lastNow = useRef<HTMLElement | null>(null);
  const notes = useMemo(() => {
    const m = new Map<string, string>();
    (p.brain.notes ?? []).forEach((n) => m.set(`${n.take}:${n.word}`, n.note));
    return m;
  }, [p.brain.notes]);
  const fixes = useMemo(() => {
    const m = new Map<string, string>();
    (p.brain.corrections ?? []).forEach((c) => m.set(`${c.take}:${c.word}`, c.text));
    return m;
  }, [p.brain.corrections]);

  // Highlight the word being spoken without re-rendering thousands of words.
  useEffect(() => {
    if (!clips.length) return;
    const { index, local } = locate(clips, time);
    const c = clips[index];
    let el: HTMLElement | null = null;
    if (c && !isTitle(c)) {
      const tr = transcripts[c.take];
      const vt = srcAt(c, local);
      const w = tr?.words.find((x) => x.s <= vt + 0.02 && x.e >= vt - 0.02);
      if (w) el = box.current?.querySelector(`[data-k="${c.take}:${w.i}"]`) ?? null;
    }
    if (lastNow.current && lastNow.current !== el) lastNow.current.classList.remove("now");
    if (el && el !== lastNow.current) {
      el.classList.add("now");
      const r = el.getBoundingClientRect();
      const pr = box.current!.getBoundingClientRect();
      if (r.top < pr.top + 60 || r.bottom > pr.bottom - 40) el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
    lastNow.current = el;
  }, [time, clips, transcripts]);

  useEffect(() => {
    const up = () => (drag.current = null);
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!sel || (e.target as HTMLElement).closest("input, textarea, select")) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        e.stopPropagation();
        onCut(sel.take, sel.i, sel.j);
        setSel(null);
      } else if (e.key.toLowerCase() === "r") {
        e.preventDefault();
        e.stopPropagation();
        onRestore(sel.take, sel.i, sel.j);
        setSel(null);
      } else if (e.key === "Escape") setSel(null);
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [sel, onCut, onRestore]);

  const target = (e: React.MouseEvent) => {
    const k = (e.target as HTMLElement).closest("[data-k]")?.getAttribute("data-k");
    if (!k) return null;
    const [take, i] = k.split(":");
    return { take, i: Number(i) };
  };

  const onDown = (e: React.MouseEvent) => {
    const t = target(e);
    if (!t) return setSel(null);
    e.preventDefault();
    drag.current = t;
    setSel({ take: t.take, i: t.i, j: t.i });
  };
  const onMove = (e: React.MouseEvent) => {
    if (!drag.current || !(e.buttons & 1)) return;
    const t = target(e);
    if (!t || t.take !== drag.current.take) return;
    setSel({ take: t.take, i: Math.min(drag.current.i, t.i), j: Math.max(drag.current.i, t.i) });
  };
  const onUp = (e: React.MouseEvent) => {
    const t = target(e);
    if (t && sel && sel.i === sel.j && sel.i === t.i && sel.take === t.take) {
      // A plain click: jump there if the word is in the edit.
      const w = transcripts[t.take]?.words[t.i];
      const at = w ? wordTime(clips, t.take, w) : null;
      if (at !== null) {
        onSeek(at);
        setSel(null);
      }
    }
    drag.current = null;
  };

  /** Double-click a word to correct how it is spelled in captions. */
  const onDouble = (e: React.MouseEvent) => {
    const el = (e.target as HTMLElement).closest("[data-k]") as HTMLElement | null;
    if (!el || !box.current) return;
    const [take, i] = el.getAttribute("data-k")!.split(":");
    const r = el.getBoundingClientRect(), pr = box.current.getBoundingClientRect();
    setSel(null);
    setFixing({ take, i: Number(i), text: el.textContent ?? "", x: r.left - pr.left + box.current.scrollLeft, y: r.top - pr.top + box.current.scrollTop, w: r.width });
  };
  const saveFix = () => {
    if (!fixing) return;
    const orig = transcripts[fixing.take]?.words[fixing.i]?.w ?? "";
    const text = fixing.text.trim();
    onFix(fixing.take, fixing.i, text === orig ? "" : text);
    setFixing(null);
  };

  // Takes in the order they first play in the edit; unused takes last.
  const orderedTakes = useMemo(() => {
    const first = new Map<string, number>();
    clips.forEach((c, k) => { if (!isTitle(c) && !first.has(c.take)) first.set(c.take, k); });
    return [...p.takes].sort((a, b) => (first.get(a.id) ?? 1e9) - (first.get(b.id) ?? 1e9));
  }, [clips, p.takes]);

  const selKept = sel ? (() => {
    const tr = transcripts[sel.take];
    let kept = 0;
    for (let k = sel.i; k <= sel.j; k++) if (wordKept(clips, sel.take, tr.words[k])) kept++;
    return kept;
  })() : 0;

  return (
    <>
      <div className="pane-head">
        <h3>Transcript</h3>
        <span className="faint tiny">Click to jump · drag to select · double-click to fix a word</span>
        <div style={{ marginLeft: "auto" }} className="row">
          {sel && (
            <>
              {selKept > 0 && <button className="btn sm" onClick={() => { onCut(sel.take, sel.i, sel.j); setSel(null); }}><Scissors size={13} /> Cut <span className="kbd">Del</span></button>}
              {selKept < sel.j - sel.i + 1 && <button className="btn sm" onClick={() => { onRestore(sel.take, sel.i, sel.j); setSel(null); }}><Undo2 size={13} /> Bring back <span className="kbd">R</span></button>}
            </>
          )}
        </div>
      </div>
      <div className="transcript selectable" ref={box} onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onDoubleClick={onDouble}>
        {fixing && (
          <input className="input fixword" autoFocus value={fixing.text} style={{ left: fixing.x - 6, top: fixing.y - 4, width: Math.max(90, fixing.w + 40) }}
            onMouseDown={(e) => e.stopPropagation()} onChange={(e) => setFixing({ ...fixing, text: e.target.value })}
            onKeyDown={(e) => { if (e.key === "Enter") saveFix(); if (e.key === "Escape") setFixing(null); e.stopPropagation(); }}
            onBlur={saveFix} aria-label="Correct this word" />
        )}
        {orderedTakes.map((t) => {
          const tr = transcripts[t.id];
          if (!tr) return null;
          return <TakeWords key={t.id} take={t.id} name={t.name} kind={t.kind} tr={tr} clips={clips} sel={sel?.take === t.id ? sel : null} notes={notes} fixes={fixes} />;
        })}
      </div>
    </>
  );
}

const TakeWords = memo(function TakeWords({ take, name, kind, tr, clips, sel, notes, fixes }: {
  take: string; name: string; kind: "screen" | "camera" | "audio"; tr: Tr; clips: Clip[]; sel: Sel; notes: Map<string, string>;
  fixes: Map<string, string>;
}) {
  const I = ICON[kind];
  const kept = useMemo(() => tr.words.map((w) => wordKept(clips, take, w)), [tr, clips, take]);
  const keptCount = kept.filter(Boolean).length;
  return (
    <div style={{ marginBottom: 22 }}>
      <div className="take-head">
        <I size={14} color={`var(--${kind === "audio" ? "audio" : kind})`} />
        <b className="small ellipsis">{name}</b>
        <span className="faint tiny" style={{ marginLeft: "auto" }}>{keptCount} of {tr.words.length} words kept</span>
      </div>
      <div>
        {tr.words.map((w, k) => {
          const gap = k > 0 ? w.s - tr.words[k - 1].e : 0;
          const note = notes.get(`${take}:${w.i}`);
          const fixed = fixes.get(`${take}:${w.i}`);
          const cls = ["w", kept[k] ? "" : "cut", sel && k >= sel.i && k <= sel.j ? "sel" : "", note ? "note" : ""].join(" ");
          return (
            <span key={w.i}>
              {gap > 1.2 && <span className="gap">{gap.toFixed(1)}s</span>}
              <span className={cls} data-k={`${take}:${w.i}`} title={note ?? (fixed ? `Heard as "${w.w}"` : undefined)}
                style={fixed ? { textDecorationLine: kept[k] ? "underline" : "line-through", textDecorationStyle: "dotted", textDecorationColor: "var(--ok)" } : undefined}>
                {fixed ?? w.w}
              </span>{" "}
            </span>
          );
        })}
      </div>
    </div>
  );
});
