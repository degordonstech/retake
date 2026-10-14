"""Turn kept words into timeline clips, and work out timeline positions."""

from __future__ import annotations

import numpy as np

from .media import HOP_S
from .project import Project, clip_dur, new_id

PAD_IN, PAD_OUT = 0.10, 0.18      # breathing room around kept words
LONG_PAUSE, KEEP_OF_PAUSE = 0.9, 0.3


def _db(p: Project, take_id: str) -> np.ndarray | None:
    try:
        return np.load(p.dir / "takes" / f"{take_id}.db.npy")
    except OSError:
        return None


def snap(db: np.ndarray | None, t: float, lo: float, hi: float, reach: float = 0.12) -> float:
    """The quietest 10 ms near t (within [lo, hi]), so cuts land between sounds."""
    if db is None or len(db) == 0:
        return t
    a = max(lo, t - reach)
    b = min(hi, t + reach)
    ia, ib = int(a / HOP_S), int(b / HOP_S) + 1
    ia, ib = max(0, ia), min(len(db), ib)
    if ib <= ia:
        return t
    return round((ia + int(np.argmin(db[ia:ib]))) * HOP_S, 3)


def span_bounds(words: list[dict], first: int, last: int, duration: float) -> tuple[float, float]:
    prev_end = words[first - 1]["e"] if first > 0 else 0.0
    next_start = words[last + 1]["s"] if last + 1 < len(words) else duration
    a = max(prev_end, words[first]["s"] - PAD_IN)
    b = min(next_start, words[last]["e"] + PAD_OUT)
    # Halfway into a short gap rather than all the way to the next word.
    a = max(a, (prev_end + words[first]["s"]) / 2) if first > 0 else max(0.0, a)
    b = min(b, (words[last]["e"] + next_start) / 2) if last + 1 < len(words) else b
    return a, b


def build_clips(p: Project, keep: list[dict], transcripts: dict[str, dict]) -> list[dict]:
    clips: list[dict] = []
    for k in keep:
        tr = transcripts[k["take"]]
        words, dur = tr["words"], tr["duration"]
        db = _db(p, k["take"])
        # Split the span where it holds a long pause, keeping a little of it.
        runs: list[tuple[int, int]] = []
        start = k["from_word"]
        for i in range(k["from_word"], k["to_word"]):
            if words[i + 1]["s"] - words[i]["e"] > LONG_PAUSE:
                runs.append((start, i))
                start = i + 1
        runs.append((start, k["to_word"]))
        for first, last in runs:
            a, b = span_bounds(words, first, last, dur)
            if first > k["from_word"]:
                a = max(a, words[first]["s"] - KEEP_OF_PAUSE)
            if last < k["to_word"]:
                b = min(b, words[last]["e"] + KEEP_OF_PAUSE)
            lo = words[first - 1]["e"] if first > 0 else 0.0
            hi = words[last + 1]["s"] if last + 1 < len(words) else dur
            a = snap(db, a, lo, words[first]["s"])
            b = snap(db, b, words[last]["e"], hi)
            if b - a > 0.15:
                clips.append({"id": new_id("c"), "take": k["take"], "a": round(a, 3), "b": round(b, 3)})
    return split_at_offsets(p, clips)


def split_at_offsets(p: Project, clips: list[dict]) -> list[dict]:
    """A clip must use one sync offset; split it where the offset jumps."""
    out: list[dict] = []
    for c in clips:
        if c.get("kind") == "title":
            out.append(c)
            continue
        steps = [at for at, _ in p.take(c["take"])["offsets"][1:] if c["a"] < at < c["b"]]
        if not steps:
            out.append(c)
            continue
        edges = [c["a"], *steps, c["b"]]
        for x, y in zip(edges, edges[1:]):
            if y - x > 0.05:
                out.append({**c, "id": new_id("c"), "a": round(x, 3), "b": round(y, 3)})
    return out


def timeline_starts(clips: list[dict]) -> list[float]:
    t, out = 0.0, []
    for c in clips:
        out.append(round(t, 3))
        t += clip_dur(c)
    return out


def position_of(clips: list[dict], take: str, voice_t: float) -> float | None:
    """Where a moment of a take lands on the timeline, if it was kept."""
    t = 0.0
    for c in clips:
        if c.get("kind") != "title" and c["take"] == take and c["a"] - 0.05 <= voice_t <= c["b"]:
            return round(t + max(0.0, voice_t - c["a"]), 3)
        t += clip_dur(c)
    return None


def chapter_overlays(clips: list[dict], chapters: list[dict], transcripts: dict[str, dict]) -> list[dict]:
    out = []
    for ch in chapters:
        tr = transcripts.get(ch["take"])
        if not tr or not (0 <= ch["word"] < len(tr["words"])):
            continue
        at = position_of(clips, ch["take"], tr["words"][ch["word"]]["s"])
        if at is None:
            continue
        out.append({"id": new_id("o"), "kind": "label", "text": ch["title"], "start": round(at + 0.2, 2),
                    "dur": 4.5, "chapter": True})
    out.sort(key=lambda o: o["start"])
    return out
