import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Captions, CheckCircle2, Clapperboard, Heading, Loader2, Minus, Pause, Play, Plus, Redo2, Scissors, SkipBack, SkipForward,
  Trash2, Type, Undo2,
} from "lucide-react";
import { api } from "../api";
import type { Clip, Edit, Job, Overlay, Project, Transcript as Tr } from "../types";
import { clamp, fmtTime } from "../util";
import { useToast } from "../ui";
import {
  clipDur, cutWords, isTitle, locate, moveClip, newOverlay, newTitle, removeClips, restoreWords, splitAt, starts, totalDuration, trimClip,
} from "./model";
import Player, { type PlayerHandle } from "./Player";
import Transcript from "./Transcript";
import Timeline from "./Timeline";
import Inspector from "./Inspector";

interface Props {
  p: Project;
  setP: (p: Project) => void;
  job: Job;
  active: boolean;
  start: (kind: string, args?: Record<string, unknown>) => Promise<void>;
}

/** Overlays are pinned to the moment of a recording they sit on, so cutting
 *  or moving clips carries chapters and captions along with their words. */
type Anchor = { clip: string; local: number } | { take: string; at: number } | null;
function anchorsOf(clips: Clip[], overlays: Overlay[]): Anchor[] {
  return overlays.map((o) => {
    const { index, local } = locate(clips, o.start);
    const c = clips[index];
    if (!c) return null;
    if (isTitle(c)) return { clip: c.id, local };
    return { take: c.take, at: c.a + local };
  });
}
function reanchor(prev: Clip[], next: Clip[], overlays: Overlay[]): Overlay[] {
  const anchors = anchorsOf(prev, overlays);
  const st = starts(next);
  return overlays.map((o, k) => {
    const a = anchors[k];
    if (!a) return o;
    if ("clip" in a) {
      const i = next.findIndex((c) => c.id === a.clip);
      return i >= 0 ? { ...o, start: st[i] + a.local } : o;
    }
    for (let i = 0; i < next.length; i++) {
      const c = next[i];
      if (!isTitle(c) && c.take === a.take && a.at >= c.a - 0.01 && a.at <= c.b) return { ...o, start: st[i] + (a.at - c.a) };
    }
    // Its moment was cut: keep it at the next kept moment of that take.
    let best: number | null = null;
    for (let i = 0; i < next.length; i++) {
      const c = next[i];
      if (!isTitle(c) && c.take === a.take && c.a >= a.at) { best = st[i]; break; }
    }
    return { ...o, start: best ?? Math.min(o.start, Math.max(0, totalDuration(next) - o.dur)) };
  });
}

export default function Editor({ p }: Props) {
  const toast = useToast();
  const [edit, setEdit] = useState<Edit>(p.edit);
  const past = useRef<Edit[]>([]);
  const future = useRef<Edit[]>([]);
  const liveBase = useRef<Edit | null>(null);
  const [, force] = useState(0);
  const [transcripts, setTranscripts] = useState<Record<string, Tr>>({});
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [zoom, setZoom] = useState(() => {
    const total = totalDuration(p.edit.clips);
    return clamp(1100 / Math.max(total, 10), 4, 120);
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selOverlay, setSelOverlay] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "dirty">("saved");
  const player = useRef<PlayerHandle>(null);
  const editRef = useRef(edit);
  editRef.current = edit;

  const total = totalDuration(edit.clips);

  useEffect(() => {
    let alive = true;
    Promise.all(p.takes.filter((t) => t.ready).map(async (t) => [t.id, await api.transcript(p.id, t.id)] as const))
      .then((rows) => alive && setTranscripts(Object.fromEntries(rows)))
      .catch((e) => toast((e as Error).message, "bad"));
    return () => { alive = false; };
  }, [p.id, p.takes, toast]);

  // Autosave shortly after each change.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    setSaveState("dirty");
    const h = setTimeout(async () => {
      setSaveState("saving");
      try {
        await api.saveEdit(p.id, edit);
        p.edit = edit;
        setSaveState("saved");
      } catch (e) {
        toast(`Couldn't save: ${(e as Error).message}`, "bad");
        setSaveState("dirty");
      }
    }, 600);
    return () => clearTimeout(h);
  }, [edit, p, toast]);

  /** Apply a change. `commit` false = still dragging (no undo step yet). */
  const apply = useCallback((fn: (e: Edit) => Edit, commit = true) => {
    const base = liveBase.current ?? editRef.current;
    const cur = editRef.current;
    let next = fn(cur);
    if (next.clips !== cur.clips) next = { ...next, overlays: reanchor(cur.clips, next.clips, next.overlays) };
    if (!commit) {
      if (!liveBase.current) liveBase.current = cur;
      setEdit(next);
      return;
    }
    liveBase.current = null;
    if (next === base) return;
    past.current.push(base);
    if (past.current.length > 200) past.current.shift();
    future.current = [];
    setEdit(next);
    force((x) => x + 1);
  }, []);

  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (!prev) return;
    future.current.push(editRef.current);
    setEdit(prev);
    force((x) => x + 1);
  }, []);
  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next) return;
    past.current.push(editRef.current);
    setEdit(next);
    force((x) => x + 1);
  }, []);

  const seek = useCallback((t: number) => {
    const tt = clamp(t, 0, Math.max(0, totalDuration(editRef.current.clips) - 0.01));
    player.current?.seek(tt);
    setTime(tt);
  }, []);
  const toggle = useCallback(() => {
    if (player.current?.playing()) player.current.pause();
    else player.current?.play();
  }, []);

  const split = useCallback(() => apply((e) => splitAt(e, time)), [apply, time]);
  const deleteSelection = useCallback(() => {
    if (selOverlay) {
      apply((e) => ({ ...e, overlays: e.overlays.filter((o) => o.id !== selOverlay) }));
      setSelOverlay(null);
    } else if (selected.size) {
      apply((e) => removeClips(e, selected));
      setSelected(new Set());
    }
  }, [apply, selOverlay, selected]);

  const addOverlay = (kind: Overlay["kind"]) => {
    const o = newOverlay(kind, time);
    apply((e) => ({ ...e, overlays: [...e.overlays, o] }));
    setSelOverlay(o.id);
    setSelected(new Set());
  };
  const addTitle = () => {
    const c = newTitle();
    const { index } = locate(edit.clips, time);
    const st = starts(edit.clips);
    const at = edit.clips.length && time > st[index] + clipDur(edit.clips[index]) / 2 ? index + 1 : index;
    apply((e) => {
      const clips = [...e.clips];
      clips.splice(Math.max(0, at), 0, c);
      return { ...e, clips };
    });
    setSelected(new Set([c.id]));
    setSelOverlay(null);
  };

  // Keyboard shortcuts, like any editor.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const mod = e.ctrlKey || e.metaKey;
      if (e.code === "Space") { e.preventDefault(); toggle(); }
      else if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (mod && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) { e.preventDefault(); redo(); }
      else if (!mod && e.key.toLowerCase() === "s") { e.preventDefault(); split(); }
      else if (e.key === "Delete" || e.key === "Backspace") { if (selected.size || selOverlay) { e.preventDefault(); deleteSelection(); } }
      else if (e.key === "ArrowLeft") { e.preventDefault(); seek(time - (e.shiftKey ? 1 : 1 / 30)); }
      else if (e.key === "ArrowRight") { e.preventDefault(); seek(time + (e.shiftKey ? 1 : 1 / 30)); }
      else if (e.key === "Home") { e.preventDefault(); seek(0); }
      else if (e.key === "End") { e.preventDefault(); seek(total); }
      else if (e.key === "=" || e.key === "+") setZoom((z) => clamp(z * 1.25, 2, 400));
      else if (e.key === "-") setZoom((z) => clamp(z / 1.25, 2, 400));
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [toggle, undo, redo, split, deleteSelection, seek, time, total, selected, selOverlay]);

  const peaks = useMemo(() => Object.fromEntries(Object.entries(transcripts).map(([k, v]) => [k, v.peaks])), [transcripts]);
  const selectedClips = edit.clips.filter((c) => selected.has(c.id));
  const overlay = edit.overlays.find((o) => o.id === selOverlay) ?? null;
  const takeDur = (id: string) => p.takes.find((t) => t.id === id)?.duration ?? 1e9;

  const ready = p.takes.some((t) => t.ready);
  if (!ready) {
    return <div className="page-inner muted row"><Loader2 size={16} className="spin" /> Your footage is still being prepared.</div>;
  }

  return (
    <div className="editor">
      <div className="editor-top">
        <section>
          {Object.keys(transcripts).length ? (
            <Transcript p={p} transcripts={transcripts} clips={edit.clips} time={time} onSeek={seek}
              onCut={(take, i, j) => apply((e) => cutWords(e, take, transcripts[take], i, j))}
              onRestore={(take, i, j) => apply((e) => restoreWords(e, take, transcripts[take], i, j))} />
          ) : (
            <div className="row muted" style={{ padding: 16 }}><Loader2 size={15} className="spin" /> Loading the transcript</div>
          )}
        </section>
        <section>
          <div className="pane-head">
            <Clapperboard size={15} color="var(--text-2)" />
            <h3>Preview</h3>
            <span className="faint tiny" style={{ marginLeft: "auto" }}>Preview is lower quality; the export is full quality.</span>
          </div>
          <div className="preview-wrap">
            <Player ref={player} p={p} clips={edit.clips} overlays={edit.overlays} time={time} onTime={setTime} onPlayingChange={setPlaying} />
          </div>
          <div className="transport">
            <button className="btn ghost icon" onClick={() => seek(0)} aria-label="Go to start"><SkipBack size={16} /></button>
            <button className="btn primary icon" style={{ width: 42, height: 38, borderRadius: 11 }} onClick={toggle} aria-label={playing ? "Pause" : "Play"}>
              {playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
            </button>
            <button className="btn ghost icon" onClick={() => seek(total)} aria-label="Go to end"><SkipForward size={16} /></button>
            <span className="timecode" style={{ marginLeft: 8 }}>{fmtTime(time, true)}</span>
            <span className="faint mono small">/ {fmtTime(total)}</span>
            <span style={{ marginLeft: "auto" }} className="faint tiny row">
              <span className="kbd">Space</span> play <span className="kbd">S</span> split <span className="kbd">Del</span> delete <span className="kbd">Ctrl Z</span> undo
            </span>
          </div>
        </section>
        <section>
          <div className="pane-head"><h3>{overlay ? "Text" : selectedClips.length ? "Clip" : "About this cut"}</h3></div>
          <Inspector p={p} clips={edit.clips} overlays={edit.overlays} transcripts={transcripts} selectedClips={selectedClips} overlay={overlay}
            onSeek={seek}
            onClip={(c, commit) => apply((e) => ({ ...e, clips: e.clips.map((x) => (x.id === c.id ? c : x)) }), commit)}
            onOverlayEdit={(o, commit) => apply((e) => ({ ...e, overlays: e.overlays.map((x) => (x.id === o.id ? o : x)) }), commit)}
            onDeleteOverlay={(id) => { apply((e) => ({ ...e, overlays: e.overlays.filter((o) => o.id !== id) })); setSelOverlay(null); }}
            onDeleteClips={() => { apply((e) => removeClips(e, selected)); setSelected(new Set()); }} />
        </section>
      </div>

      <div className="tl">
        <div className="tl-bar">
          <button className="btn ghost sm icon" onClick={undo} disabled={!past.current.length} title="Undo (Ctrl Z)"><Undo2 size={15} /></button>
          <button className="btn ghost sm icon" onClick={redo} disabled={!future.current.length} title="Redo (Ctrl Y)"><Redo2 size={15} /></button>
          <div style={{ width: 1, height: 22, background: "var(--line)", margin: "0 4px" }} />
          <button className="btn sm" onClick={split} title="Split at the playhead (S)"><Scissors size={14} /> Split</button>
          <button className="btn sm" onClick={deleteSelection} disabled={!selected.size && !selOverlay} title="Delete (Del)"><Trash2 size={14} /> Delete</button>
          <div style={{ width: 1, height: 22, background: "var(--line)", margin: "0 4px" }} />
          <button className="btn sm" onClick={addTitle}><Heading size={14} /> Title card</button>
          <button className="btn sm" onClick={() => addOverlay("label")}><Type size={14} /> Chapter label</button>
          <button className="btn sm" onClick={() => addOverlay("lower")}><Type size={14} /> Lower third</button>
          <button className="btn sm" onClick={() => addOverlay("caption")}><Captions size={14} /> Caption</button>
          <div style={{ marginLeft: "auto" }} className="row">
            <span className="small faint row" style={{ gap: 6, minWidth: 92 }}>
              {saveState === "saved" ? <><CheckCircle2 size={14} color="var(--ok)" /> Saved</> : saveState === "saving" ? <><Loader2 size={14} className="spin" /> Saving</> : "Unsaved"}
            </span>
            <span className="mono small muted">{edit.clips.length} clips · {fmtTime(total)}</span>
            <button className="btn ghost sm icon" onClick={() => setZoom((z) => clamp(z / 1.25, 2, 400))} aria-label="Zoom out"><Minus size={14} /></button>
            <input type="range" min={0} max={100} value={Math.round((Math.log(zoom / 2) / Math.log(200)) * 100)}
              onChange={(e) => setZoom(2 * Math.pow(200, Number(e.target.value) / 100))} style={{ width: 120, accentColor: "var(--accent)" }} aria-label="Zoom" />
            <button className="btn ghost sm icon" onClick={() => setZoom((z) => clamp(z * 1.25, 2, 400))} aria-label="Zoom in"><Plus size={14} /></button>
          </div>
        </div>
        <Timeline p={p} clips={edit.clips} overlays={edit.overlays} time={time} zoom={zoom} setZoom={setZoom}
          selected={selected} selectedOverlay={selOverlay} peaks={peaks} playing={playing}
          onSeek={seek}
          onSelectClip={(id, additive) => {
            if (!id) return setSelected(new Set());
            setSelected((s) => {
              const n = new Set(additive ? s : []);
              if (additive && n.has(id)) n.delete(id); else n.add(id);
              return n;
            });
          }}
          onSelectOverlay={setSelOverlay}
          onTrim={(id, side, value, commit) => apply((e) => trimClip(e, id, side, value, { min: 0, max: takeDur((e.clips.find((c) => c.id === id) as { take?: string })?.take ?? "") }), commit)}
          onMove={(id, to) => apply((e) => moveClip(e, id, to))}
          onOverlay={(id, s, d, commit) => apply((e) => ({ ...e, overlays: e.overlays.map((o) => (o.id === id ? { ...o, start: s, dur: d } : o)) }), commit)} />
      </div>
    </div>
  );
}
