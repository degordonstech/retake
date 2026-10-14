import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Blend, Captions, CheckCircle2, Copy, FileText, Film, Loader2, Minus, Music, Palette, Pause, Play, Plus, Redo2, Scissors, SkipBack,
  SkipForward, Trash2, Type, Undo2,
} from "lucide-react";
import { api, media } from "../api";
import type { Asset, CaptionLayout, CaptionSettings, Clip, Edit, Job, MediaClip, Overlay, Project, Transcript as Tr } from "../types";
import { clamp, fmtTime, uid } from "../util";
import { useToast } from "../ui";
import { useLooks } from "../looks";
import {
  clipDur, cutWords, isTitle, locate, moveClip, newAudio, newMedia, newOverlay, newText, newTitle, normalize, removeClips, restoreWords,
  speedOf, splitAt, srcAt, starts, totalDuration, trimClip,
} from "./model";
import Player, { type Pick, type PlayerHandle } from "./Player";
import Transcript from "./Transcript";
import Timeline, { type ItemKind, type Sel } from "./Timeline";
import { AudioItemPanel, ClipPanel, ClipsPanel, CutPanel, MediaItemPanel, OverlayPanel, Summary, TextItemPanel } from "./Inspector";
import { CaptionsPanel, FiltersPanel, MediaPanel, TextPanel, TransitionsPanel } from "./Panels";

interface Props {
  p: Project;
  setP: (p: Project) => void;
  job: Job;
  active: boolean;
  start: (kind: string, args?: Record<string, unknown>) => Promise<void>;
}

type Tool = "transcript" | "media" | "audio" | "text" | "captions" | "transitions" | "filters";
const TOOLS: [Tool, string, typeof FileText][] = [
  ["transcript", "Transcript", FileText],
  ["media", "Media", Film],
  ["audio", "Audio", Music],
  ["text", "Text", Type],
  ["captions", "Captions", Captions],
  ["transitions", "Transitions", Blend],
  ["filters", "Filters", Palette],
];
const ASPECTS: [string, string][] = [["16:9", "16:9"], ["9:16", "9:16"], ["1:1", "1:1"], ["4:5", "4:5"]];

/** Overlays and B-roll are pinned to the moment of a recording they sit on,
 *  so cutting or moving clips carries them along with their words. */
type Anchor = { clip: string; local: number } | { take: string; at: number } | null;
function anchorOf(clips: Clip[], start: number): Anchor {
  const { index, local } = locate(clips, start);
  const c = clips[index];
  if (!c || start > totalDuration(clips)) return null;
  if (isTitle(c)) return { clip: c.id, local };
  return { take: c.take, at: srcAt(c, local) };
}
function reanchor<T extends { start: number; dur: number }>(prev: Clip[], next: Clip[], items: T[]): T[] {
  const st = starts(next);
  return items.map((o) => {
    const a = anchorOf(prev, o.start);
    if (!a) return o;
    if ("clip" in a) {
      const i = next.findIndex((c) => c.id === a.clip);
      return i >= 0 ? { ...o, start: st[i] + a.local } : o;
    }
    for (let i = 0; i < next.length; i++) {
      const c = next[i];
      if (!isTitle(c) && c.take === a.take && a.at >= c.a - 0.01 && a.at <= c.b) return { ...o, start: st[i] + (a.at - c.a) / speedOf(c) };
    }
    // Its moment was cut: keep it at the next kept moment of that take.
    for (let i = 0; i < next.length; i++) {
      const c = next[i];
      if (!isTitle(c) && c.take === a.take && c.a >= a.at) return { ...o, start: st[i] };
    }
    return { ...o, start: Math.min(o.start, Math.max(0, totalDuration(next) - o.dur)) };
  });
}

export default function Editor({ p, setP }: Props) {
  const toast = useToast();
  const looks = useLooks();
  const [edit, setEdit] = useState<Edit>(() => normalize(p.edit));
  const past = useRef<Edit[]>([]);
  const future = useRef<Edit[]>([]);
  const liveBase = useRef<Edit | null>(null);
  const [, force] = useState(0);
  const [transcripts, setTranscripts] = useState<Record<string, Tr>>({});
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [zoom, setZoom] = useState(() => clamp(1100 / Math.max(totalDuration(p.edit.clips), 10), 4, 120));
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState<Sel>(null);
  const [tool, setTool] = useState<Tool>(() => (localStorage.getItem("retake.tool") as Tool) || "transcript");
  const [layout, setLayout] = useState<CaptionLayout | null>(null);
  const [transDur, setTransDur] = useState(0.5);
  const [importing, setImporting] = useState(false);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "dirty">("saved");
  const player = useRef<PlayerHandle>(null);
  const editRef = useRef(edit);
  editRef.current = edit;
  const pRef = useRef(p);
  pRef.current = p;

  const total = totalDuration(edit.clips);
  const aspect = edit.format?.aspect ?? "16:9";

  useEffect(() => { try { localStorage.setItem("retake.tool", tool); } catch { /* ignore */ } }, [tool]);

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

  // Caption layout comes from the engine (it knows the fonts the export uses).
  const capKey = JSON.stringify([edit.captions, edit.format?.aspect, p.brain.corrections?.length,
    edit.clips.map((c) => (isTitle(c) ? [c.id, c.dur] : [c.take, c.a, c.b, c.speed ?? 1]))]);
  useEffect(() => {
    if (!edit.captions?.on) { setLayout(null); return; }
    let alive = true;
    const h = setTimeout(() => {
      api.captionLayout(p.id, { clips: editRef.current.clips, captions: editRef.current.captions, format: editRef.current.format })
        .then((l) => alive && setLayout(l))
        .catch((e) => toast(`Captions: ${(e as Error).message}`, "bad"));
    }, 250);
    return () => { alive = false; clearTimeout(h); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capKey, p.id]);

  /** Apply a change. `commit` false = still dragging (no undo step yet). */
  const apply = useCallback((fn: (e: Edit) => Edit, commit = true) => {
    const base = liveBase.current ?? editRef.current;
    const cur = editRef.current;
    let next = fn(cur);
    if (next.clips !== cur.clips) {
      next = { ...next, overlays: reanchor(cur.clips, next.clips, next.overlays), media: reanchor(cur.clips, next.clips, next.media) };
    }
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

  const pickItem = (s: Sel) => { setSel(s); if (s) setSelected(new Set()); };
  const split = useCallback(() => apply((e) => splitAt(e, time)), [apply, time]);

  const removeItem = useCallback((kind: ItemKind, id: string) => {
    apply((e) => kind === "overlay" ? { ...e, overlays: e.overlays.filter((o) => o.id !== id) }
      : kind === "media" ? { ...e, media: e.media.filter((m) => m.id !== id) }
        : { ...e, audio: e.audio.filter((m) => m.id !== id) });
    setSel(null);
  }, [apply]);

  const deleteSelection = useCallback(() => {
    if (sel && sel.kind === "cut") {
      apply((e) => ({ ...e, clips: e.clips.map((c, k) => (k === sel.index ? { ...c, transition: undefined } : c)) }));
    } else if (sel) removeItem(sel.kind, sel.id);
    else if (selected.size) {
      apply((e) => removeClips(e, selected));
      setSelected(new Set());
    }
  }, [apply, sel, selected, removeItem]);

  const duplicate = useCallback(() => {
    if (!sel || sel.kind === "cut") return;
    const id = uid(sel.kind === "overlay" ? "o" : sel.kind === "media" ? "m" : "s");
    apply((e) => {
      const list = sel.kind === "overlay" ? e.overlays : sel.kind === "media" ? e.media : e.audio;
      const it = list.find((x) => x.id === sel.id);
      if (!it) return e;
      const copy = { ...it, id, start: it.start + it.dur };
      return sel.kind === "overlay" ? { ...e, overlays: [...e.overlays, copy as Overlay] }
        : sel.kind === "media" ? { ...e, media: [...e.media, copy as typeof e.media[0]] } : { ...e, audio: [...e.audio, copy as typeof e.audio[0]] };
    });
    setSel({ kind: sel.kind, id });
  }, [apply, sel]);

  /* -------------------------------------------------------------- adding --- */
  const addOverlay = (kind: Overlay["kind"]) => {
    const o = newOverlay(kind, time);
    apply((e) => ({ ...e, overlays: [...e.overlays, o] }));
    pickItem({ kind: "overlay", id: o.id });
  };
  const addText = (style: string) => {
    const o = newText(style, time);
    apply((e) => ({ ...e, overlays: [...e.overlays, o] }));
    pickItem({ kind: "overlay", id: o.id });
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
    setSel(null);
  };
  const addAsset = useCallback((a: Asset, music = false, at?: number) => {
    const t = at ?? time;
    const tot = totalDuration(editRef.current.clips);
    if (a.kind === "audio") {
      const it = music ? newAudio(a.id, 0, Math.max(1, tot), true) : newAudio(a.id, t, Math.max(0.3, a.duration ?? 3), false);
      if (music) it.loop = (a.duration ?? 0) < tot;
      else it.dur = Math.max(0.3, Math.min(a.duration ?? 3, 600));
      if (!music && !it.loop) it.dur = Math.min(it.dur, a.duration ?? it.dur);
      apply((e) => ({ ...e, audio: [...e.audio, it] }));
      pickItem({ kind: "audio", id: it.id });
    } else {
      const dur = a.kind === "video" ? Math.min(a.duration ?? 4, 6) : 4;
      const it = newMedia(a.id, t, dur, a.kind);
      apply((e) => ({ ...e, media: [...e.media, it] }));
      pickItem({ kind: "media", id: it.id });
    }
  }, [apply, time]);

  const importPaths = useCallback(async (paths: string[]) => {
    setImporting(true);
    try {
      const r = await api.importAssets(pRef.current.id, paths);
      setP({ ...r.project, edit: editRef.current });
      if (r.added.length) toast(`Added ${r.added.length} file${r.added.length > 1 ? "s" : ""} to Media`, "ok");
      else toast("Nothing new to add. Retake takes video, pictures and audio files.", "info");
      const kinds = r.project.assets.filter((a) => r.added.includes(a.id)).map((a) => a.kind);
      if (kinds.length && kinds.every((k) => k === "audio")) setTool("audio"); else if (kinds.length) setTool("media");
    } catch (e) { toast((e as Error).message, "bad"); } finally { setImporting(false); }
  }, [setP, toast]);
  const pickFiles = async () => {
    setImporting(true);
    try {
      const r = await api.pickAssets(p.id);
      setP({ ...r.project, edit: editRef.current });
      if (r.added.length) toast(`Added ${r.added.length} file${r.added.length > 1 ? "s" : ""}`, "ok");
    } catch (e) { toast((e as Error).message, "bad"); } finally { setImporting(false); }
  };
  const deleteAsset = async (a: Asset) => {
    try {
      const next = await api.deleteAsset(p.id, a.id);
      apply((e) => ({ ...e, media: e.media.filter((m) => m.asset !== a.id), audio: e.audio.filter((m) => m.asset !== a.id) }));
      setP({ ...next, edit: editRef.current });
    } catch (e) { toast((e as Error).message, "bad"); }
  };

  // Files dragged in from Explorer (the desktop window passes their paths).
  useEffect(() => {
    const h = (e: Event) => { const paths = (e as CustomEvent<string[]>).detail; if (paths?.length) importPaths(paths); };
    window.addEventListener("retake-drop", h);
    return () => window.removeEventListener("retake-drop", h);
  }, [importPaths]);
  // Wait for B-roll preview copies.
  useEffect(() => {
    if (!p.assets.some((a) => a.kind === "video" && !a.ready)) return;
    const h = setInterval(async () => {
      try { const next = await api.project(p.id); setP({ ...next, edit: editRef.current }); } catch { /* try again */ }
    }, 4000);
    return () => clearInterval(h);
  }, [p.assets, p.id, setP]);

  /* ------------------------------------------------- transitions, filters --- */
  const cutIndex = (): number | null => {
    if (sel?.kind === "cut") return sel.index;
    if (edit.clips.length < 2) return null;
    const st = starts(edit.clips);
    let best = 1;
    for (let k = 1; k < st.length; k++) if (Math.abs(st[k] - time) < Math.abs(st[best] - time)) best = k;
    return best;
  };
  const setTransition = (type: string | null) => {
    const k = cutIndex();
    if (k === null) return toast("Add at least two clips first.", "info");
    apply((e) => ({ ...e, clips: e.clips.map((c, i) => (i === k ? { ...c, transition: type ? { type, dur: transDur } : undefined } : c)) }));
    setSel({ kind: "cut", index: k });
    if (type) seek(Math.max(0, starts(editRef.current.clips)[k] - transDur));
  };
  const transitionAll = (type: string | null) =>
    apply((e) => ({ ...e, clips: e.clips.map((c, i) => (i === 0 ? c : { ...c, transition: type ? { type, dur: transDur } : undefined })) }));
  const filterTargets = (): Set<string> => {
    if (selected.size) return selected;
    const c = edit.clips[locate(edit.clips, time).index];
    return new Set(c ? [c.id] : []);
  };
  const setFilter = (id: string) => {
    const ids = filterTargets();
    apply((e) => ({ ...e, clips: e.clips.map((c) => (ids.has(c.id) && !isTitle(c) ? { ...c, filter: id } : c)) }));
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
      else if (mod && e.key.toLowerCase() === "d") { e.preventDefault(); duplicate(); }
      else if (!mod && e.key.toLowerCase() === "s") { e.preventDefault(); split(); }
      else if (e.key === "Delete" || e.key === "Backspace") { if (selected.size || sel) { e.preventDefault(); deleteSelection(); } }
      else if (e.key === "ArrowLeft") { e.preventDefault(); seek(time - (e.shiftKey ? 1 : 1 / 30)); }
      else if (e.key === "ArrowRight") { e.preventDefault(); seek(time + (e.shiftKey ? 1 : 1 / 30)); }
      else if (e.key === "Home") { e.preventDefault(); seek(0); }
      else if (e.key === "End") { e.preventDefault(); seek(total); }
      else if (e.key === "Escape") { setSel(null); setSelected(new Set()); }
      else if (e.key === "=" || e.key === "+") setZoom((z) => clamp(z * 1.25, 2, 400));
      else if (e.key === "-") setZoom((z) => clamp(z / 1.25, 2, 400));
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [toggle, undo, redo, split, deleteSelection, duplicate, seek, time, total, selected, sel]);

  const peaks = useMemo(() => Object.fromEntries(Object.entries(transcripts).map(([k, v]) => [k, v.peaks])), [transcripts]);
  const selectedClips = edit.clips.filter((c) => selected.has(c.id));
  const takeDur = (id: string) => p.takes.find((t) => t.id === id)?.duration ?? 1e9;
  const assets = useMemo(() => Object.fromEntries(p.assets.map((a) => [a.id, a])), [p.assets]);
  const size: [number, number] = layout && edit.captions?.on ? [layout.width, layout.height]
    : (looks?.aspects[aspect] as [number, number] | undefined) ?? (aspect === "9:16" ? [1080, 1920] : aspect === "1:1" ? [1080, 1080] : aspect === "4:5" ? [1080, 1350] : [1920, 1080]);
  const picked: Pick = sel && (sel.kind === "overlay" || sel.kind === "media") ? { kind: sel.kind, id: sel.id } : null;

  // A still of the clip under the playhead, for the filter cards.
  const frameUrl = useMemo(() => {
    const { index, local } = locate(edit.clips, time);
    const c = edit.clips[index];
    if (!c || isTitle(c)) return null;
    const tk = p.takes.find((t) => t.id === c.take);
    if (!tk?.video) return null;
    const vt = srcAt(c, local) + (tk.video === tk.voice ? 0 : tk.offsets[0]?.[1] ?? 0);
    return media.frame(p.id, tk.video, Math.round(vt * 2) / 2, 240);
    // Only refresh every half second of movement.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Math.round(time * 2), edit.clips, p.id]);
  const currentFilter = (() => {
    const ids = filterTargets();
    const c = edit.clips.find((x) => ids.has(x.id));
    return c && !isTitle(c) ? c.filter ?? "none" : null;
  })();
  const cutK = sel?.kind === "cut" ? sel.index : null;

  const ready = p.takes.some((t) => t.ready);
  if (!ready) {
    return <div className="page-inner muted row"><Loader2 size={16} className="spin" /> Your footage is still being prepared.</div>;
  }

  /* --------------------------------------------------------- inspector --- */
  let inspector: React.ReactNode;
  const onItemEdit = <T extends { id: string }>(kind: ItemKind) => (it: T, commit: boolean) =>
    apply((e) => kind === "overlay" ? { ...e, overlays: e.overlays.map((x) => (x.id === it.id ? (it as unknown as Overlay) : x)) }
      : kind === "media" ? { ...e, media: e.media.map((x) => (x.id === it.id ? (it as unknown as typeof x) : x)) }
        : { ...e, audio: e.audio.map((x) => (x.id === it.id ? (it as unknown as typeof x) : x)) }, commit);
  if (sel?.kind === "overlay") {
    const o = edit.overlays.find((x) => x.id === sel.id);
    if (o) inspector = o.kind === "text"
      ? <TextItemPanel o={o} looks={looks} onChange={onItemEdit("overlay")} onDelete={() => removeItem("overlay", o.id)} />
      : <OverlayPanel o={o} onChange={onItemEdit("overlay")} onDelete={() => removeItem("overlay", o.id)} />;
  } else if (sel?.kind === "media") {
    const m = edit.media.find((x) => x.id === sel.id);
    if (m) inspector = <MediaItemPanel m={m} a={assets[m.asset]} onChange={onItemEdit("media")} onDelete={() => removeItem("media", m.id)} />;
  } else if (sel?.kind === "audio") {
    const s = edit.audio.find((x) => x.id === sel.id);
    if (s) inspector = <AudioItemPanel s={s} a={assets[s.asset]} onChange={onItemEdit("audio")} onDelete={() => removeItem("audio", s.id)} />;
  } else if (sel?.kind === "cut" && edit.clips[sel.index]) {
    inspector = <CutPanel looks={looks} c={edit.clips[sel.index]} onChange={(c, commit) => apply((e) => ({ ...e, clips: e.clips.map((x) => (x.id === c.id ? c : x)) }), commit)} />;
  }
  if (!inspector) {
    if (selectedClips.length === 1) {
      inspector = <ClipPanel key={selectedClips[0].id} p={p} looks={looks} c={selectedClips[0]} aspect={aspect}
        onChange={(c, commit) => apply((e) => ({ ...e, clips: e.clips.map((x) => (x.id === c.id ? c : x)) }), commit)}
        onDelete={() => { apply((e) => removeClips(e, selected)); setSelected(new Set()); }}
        onNudge={async (take, delta) => {
          try {
            const next = await api.nudge(p.id, take, delta);
            setP({ ...next, edit: editRef.current });
            toast(delta < 0 ? "Picture moved earlier" : "Picture moved later", "ok");
          } catch (e) { toast((e as Error).message, "bad"); }
        }} />;
    } else if (selectedClips.length > 1) {
      inspector = <ClipsPanel clips={selectedClips} looks={looks}
        onBatch={(fn) => apply((e) => ({ ...e, clips: e.clips.map((c) => (selected.has(c.id) && !isTitle(c) ? fn(c as MediaClip) : c)) }))}
        onDelete={() => { apply((e) => removeClips(e, selected)); setSelected(new Set()); }} />;
    } else {
      inspector = <Summary p={p} clips={edit.clips} overlays={edit.overlays} transcripts={transcripts} onSeek={seek} />;
    }
  }
  const inspectorTitle = sel?.kind === "overlay" ? "Text" : sel?.kind === "media" ? "Overlay" : sel?.kind === "audio" ? "Audio"
    : sel?.kind === "cut" ? "Transition" : selectedClips.length ? (selectedClips.length > 1 ? "Clips" : "Clip") : "About this cut";

  return (
    <div className="editor">
      <div className="editor-top">
        <nav className="toolrail">
          {TOOLS.map(([id, label, Icon]) => (
            <button key={id} className={`tool-btn ${tool === id ? "on" : ""}`} onClick={() => setTool(id)} title={label}>
              <Icon size={18} /><span>{label}</span>
            </button>
          ))}
        </nav>
        <section className="toolpane">
          {tool === "transcript" && (Object.keys(transcripts).length ? (
            <Transcript p={p} transcripts={transcripts} clips={edit.clips} time={time} onSeek={seek}
              onCut={(take, i, j) => apply((e) => cutWords(e, take, transcripts[take], i, j))}
              onRestore={(take, i, j) => apply((e) => restoreWords(e, take, transcripts[take], i, j))}
              onFix={async (take, word, text) => {
                try { const next = await api.correct(p.id, take, word, text); setP({ ...next, edit: editRef.current }); }
                catch (e) { toast((e as Error).message, "bad"); }
              }} />
          ) : (
            <div className="row muted" style={{ padding: 16 }}><Loader2 size={15} className="spin" /> Loading the transcript</div>
          ))}
          {tool === "media" && <MediaPanel p={p} only="visual" importing={importing} onImport={pickFiles} onAdd={(a) => addAsset(a)} onDelete={deleteAsset} />}
          {tool === "audio" && <MediaPanel p={p} only="audio" importing={importing} onImport={pickFiles} onAdd={(a, music) => addAsset(a, music)} onDelete={deleteAsset}
            onSfx={async (name) => {
              try {
                const r = await api.addSfx(p.id, name);
                setP({ ...r.project, edit: editRef.current });
                const a = r.project.assets.find((x) => x.id === r.asset);
                if (a) addAsset(a, false);
              } catch (e) { toast((e as Error).message, "bad"); }
            }} />}
          {tool === "text" && <TextPanel looks={looks} onText={addText} onClassic={(k) => (k === "title" ? addTitle() : addOverlay(k))} />}
          {tool === "captions" && <CaptionsPanel looks={looks} s={edit.captions ?? {}} onChange={(s: CaptionSettings, commit) => apply((e) => ({ ...e, captions: s }), commit)} />}
          {tool === "transitions" && (
            <TransitionsPanel looks={looks} canApply={cutK !== null}
              current={cutK !== null ? edit.clips[cutK]?.transition?.type ?? null : null}
              dur={cutK !== null ? edit.clips[cutK]?.transition?.dur ?? transDur : transDur}
              onApply={setTransition} onAll={transitionAll}
              onDur={(d, commit) => {
                setTransDur(d);
                if (cutK !== null && edit.clips[cutK]?.transition) apply((e) => ({ ...e, clips: e.clips.map((c, i) => (i === cutK && c.transition ? { ...c, transition: { ...c.transition, dur: d } } : c)) }), commit);
              }} />
          )}
          {tool === "filters" && <FiltersPanel looks={looks} frameUrl={frameUrl} current={currentFilter} count={selected.size} onApply={setFilter}
            onAll={(id) => apply((e) => ({ ...e, clips: e.clips.map((c) => (isTitle(c) ? c : { ...c, filter: id })) }))} />}
        </section>
        <section className="previewpane">
          <div className="pane-head">
            <div className="seg" title="Shape of the video">
              {ASPECTS.map(([v, l]) => (
                <button key={v} className={aspect === v ? "on" : ""} onClick={() => apply((e) => ({ ...e, format: { ...e.format, aspect: v } }))}>
                  <span className={`ar ar-${v.replace(":", "x")}`} /> {l}
                </button>
              ))}
            </div>
            <span className="faint tiny" style={{ marginLeft: "auto" }}>Preview is lighter; the export is full quality.</span>
          </div>
          <div className="preview-wrap">
            <Player ref={player} p={p} edit={edit} size={size} time={time} layout={layout} looks={looks}
              picked={picked} onPick={(pk) => setSel(pk)}
              onOverlay={onItemEdit("overlay")} onMedia={onItemEdit("media")}
              onTime={setTime} onPlayingChange={setPlaying} />
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
              <span className="kbd">Space</span> play <span className="kbd">S</span> split <span className="kbd">Del</span> delete <span className="kbd">Ctrl D</span> copy
            </span>
          </div>
        </section>
        <section className="inspectpane">
          <div className="pane-head"><h3>{inspectorTitle}</h3></div>
          {inspector}
        </section>
      </div>

      <div className="tl">
        <div className="tl-bar">
          <button className="btn ghost sm icon" onClick={undo} disabled={!past.current.length} title="Undo (Ctrl Z)"><Undo2 size={15} /></button>
          <button className="btn ghost sm icon" onClick={redo} disabled={!future.current.length} title="Redo (Ctrl Y)"><Redo2 size={15} /></button>
          <div className="vsep" />
          <button className="btn sm" onClick={split} title="Split at the playhead (S)"><Scissors size={14} /> Split</button>
          <button className="btn sm" onClick={deleteSelection} disabled={!selected.size && !sel} title="Delete (Del)"><Trash2 size={14} /> Delete</button>
          <button className="btn sm" onClick={duplicate} disabled={!sel || sel.kind === "cut"} title="Duplicate (Ctrl D)"><Copy size={14} /> Duplicate</button>
          <div className="vsep" />
          <button className="btn sm" onClick={() => setTool("text")}><Type size={14} /> Text</button>
          <button className="btn sm" onClick={() => setTool("captions")}><Captions size={14} /> Captions {edit.captions?.on && <span className="dot" style={{ color: "var(--ok)" }} />}</button>
          <button className="btn sm" onClick={() => setTool("media")}><Film size={14} /> Media</button>
          <button className="btn sm" onClick={() => setTool("audio")}><Music size={14} /> Music</button>
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
        <Timeline p={p} edit={edit} time={time} zoom={zoom} setZoom={setZoom}
          selected={selected} sel={sel} peaks={peaks} playing={playing}
          onSeek={seek}
          onSelectClip={(id, additive) => {
            if (!id) return setSelected(new Set());
            setSel(null);
            setSelected((s) => {
              const n = new Set(additive ? s : []);
              if (additive && n.has(id)) n.delete(id); else n.add(id);
              return n;
            });
          }}
          onSel={(s) => { setSel(s); if (s && s.kind !== "cut") setSelected(new Set()); }}
          onTrim={(id, side, value, commit) => apply((e) => trimClip(e, id, side, value, { min: 0, max: takeDur((e.clips.find((c) => c.id === id) as { take?: string })?.take ?? "") }), commit)}
          onMove={(id, to) => apply((e) => moveClip(e, id, to))}
          onItem={(kind, id, s, d, inPoint, commit) => apply((e) => {
            const upd = <T extends { id: string; start: number; dur: number; in?: number }>(x: T): T =>
              x.id === id ? { ...x, start: s, dur: d, ...(inPoint !== undefined ? { in: inPoint } : {}) } : x;
            return kind === "overlay" ? { ...e, overlays: e.overlays.map(upd) } : kind === "media" ? { ...e, media: e.media.map(upd) } : { ...e, audio: e.audio.map(upd) };
          }, commit)}
          onDropAsset={(aid, track, t) => {
            const a = assets[aid];
            if (!a) return;
            if ((track === "audio") !== (a.kind === "audio")) return toast(a.kind === "audio" ? "Sound goes on the Audio track." : "Pictures and video go on the Overlay track.", "info");
            addAsset(a, false, t);
          }} />
      </div>
    </div>
  );
}
