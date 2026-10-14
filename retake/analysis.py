"""Transcribe each take and find how its picture lines up with its voice."""

from __future__ import annotations

import os
import threading
from typing import Callable

import numpy as np

from . import media
from .project import Project

_model_lock = threading.Lock()
_models: dict[str, object] = {}


def _whisper(size: str):
    with _model_lock:
        if size not in _models:
            from faster_whisper import WhisperModel

            threads = max(2, (os.cpu_count() or 4) - 1)
            try:
                os.environ.setdefault("HF_HUB_OFFLINE", "1")
                _models[size] = WhisperModel(size, device="cpu", compute_type="int8", cpu_threads=threads)
            except Exception:
                # Not cached yet: allow the one-time download.
                os.environ.pop("HF_HUB_OFFLINE", None)
                _models[size] = WhisperModel(size, device="cpu", compute_type="int8", cpu_threads=threads)
        return _models[size]


# ------------------------------------------------------------ transcript ----
def transcribe_take(p: Project, take: dict, settings: dict, on_progress: Callable[[float], None]) -> dict:
    voice_path = p.source_path(take["voice"])
    audio = media.load_audio(voice_path)
    db = media.level_db(audio)
    sil = media.silences(db, 0.3)
    duration = len(audio) / 16000

    model = _whisper(settings.get("whisper_model") or "small")
    segments, _ = model.transcribe(audio / 32768.0, language=settings.get("language") or None,
                                   word_timestamps=True, vad_filter=False, beam_size=5,
                                   condition_on_previous_text=False)
    words: list[dict] = []
    for seg in segments:
        for w in seg.words or []:
            text = w.word.strip()
            if text:
                words.append({"w": text, "s": round(w.start, 2), "e": round(w.end, 2)})
        on_progress(min(0.99, seg.end / max(duration, 1)))
    words = _fit_to_silences(words, sil)
    for i, w in enumerate(words):
        w["i"] = i

    data = {
        "words": words,
        "silences": sil,
        "peaks": media.waveform_peaks(db),
        "duration": duration,
    }
    p.write_json(data, "takes", f"{take['id']}.json")
    np.save(p.path("takes", f"{take['id']}.db.npy"), db)
    on_progress(1.0)
    return data


def _fit_to_silences(words: list[dict], sil: list[tuple[float, float]]) -> list[dict]:
    """Whisper's word times drift by up to half a second. Real pauses are
    measured from the audio, so a word never starts or ends inside one."""
    if not sil:
        return words
    import bisect

    starts = [a for a, _ in sil]
    for w in words:
        k = bisect.bisect_right(starts, w["s"]) - 1
        if k >= 0:
            a, b = sil[k]
            if a <= w["s"] < b and w["e"] > b:
                w["s"] = b
        k = bisect.bisect_right(starts, w["e"]) - 1
        if k >= 0:
            a, b = sil[k]
            if a < w["e"] <= b and w["s"] < a:
                w["e"] = a
        if w["e"] <= w["s"]:
            w["e"] = round(w["s"] + 0.08, 2)
    return words


def phrases(words: list[dict], sil: list[tuple[float, float]], gap: float = 0.35) -> list[dict]:
    """Group words into phrases split at real pauses, for reading and for the AI."""
    # Words were fitted to the measured pauses, so the gap between two words
    # is the pause between them.
    out: list[dict] = []
    cur: list[dict] = []
    for w in words:
        if cur and w["s"] - cur[-1]["e"] >= gap:
            out.append(_phrase(cur))
            cur = []
        cur.append(w)
    if cur:
        out.append(_phrase(cur))
    return out


def _phrase(ws: list[dict]) -> dict:
    return {"first": ws[0]["i"], "last": ws[-1]["i"], "s": ws[0]["s"], "e": ws[-1]["e"],
            "text": " ".join(w["w"] for w in ws)}


# ------------------------------------------------------------------ sync ----
def sync_take(p: Project, take: dict, on_progress: Callable[[float], None]) -> None:
    """Find video time = voice time + offset, allowing for jumps where the
    two recorders were paused at slightly different moments."""
    if not take["video"] or take["video"] == take["voice"]:
        take["offsets"], take["sync_score"] = [[0.0, 0.0]], None
        return
    vid = p.source(take["video"])
    if not vid["has_audio"]:
        take["offsets"], take["sync_score"] = [[0.0, 0.0]], None
        return
    fps = 1 / media.HOP_S
    voice = media.envelope(media.load_audio(p.source_path(take["voice"])))
    on_progress(0.3)
    video = media.envelope(media.load_audio(p.source_path(take["video"])))
    on_progress(0.6)

    # 1. Strongest whole-file offsets.
    L = max(len(voice), len(video))
    nfft = 1 << int(np.ceil(np.log2(2 * L)))
    c = np.fft.irfft(np.fft.rfft(video, nfft) * np.conj(np.fft.rfft(voice, nfft)), nfft)
    lags = np.concatenate([np.arange(0, L), np.arange(-L, 0)])
    c = np.concatenate([c[:L], c[-L:]])
    best_global = float(lags[int(np.argmax(c))] / fps)

    # 2. Offset per 20 s window, searching +-30 s around each window.
    win, step, reach = int(20 * fps), int(10 * fps), int(30 * fps)
    rows: list[tuple[float, float, float]] = []
    for st in range(0, max(1, len(voice) - win), step):
        seg = voice[st: st + win]
        lo = max(0, st + int(best_global * fps) - reach)
        region = video[lo: st + int(best_global * fps) + win + reach]
        if len(region) < len(seg) or len(seg) < win // 2:
            continue
        cc = np.correlate(region, seg, mode="valid")
        k = int(np.argmax(cc))
        rows.append((st / fps, (lo + k - st) / fps, float(cc[k] / len(seg))))
    on_progress(0.8)

    good = [r for r in rows if r[2] > 0.3]
    if not good:
        take["offsets"], take["sync_score"] = [[0.0, round(best_global, 2)]], 0.0
        return

    # 3. Cluster the window offsets into the handful of real values.
    clusters: list[float] = []
    for _, o, _ in sorted(good, key=lambda r: -r[2]):
        if all(abs(o - c0) > 0.15 for c0 in clusters):
            clusters.append(o)
    snap = lambda o: min(clusters, key=lambda c0: abs(c0 - o))  # noqa: E731

    # 4. Walk the windows in time; switch offset when two strong windows agree.
    steps: list[list[float]] = []
    current = snap(good[0][1])
    steps.append([0.0, round(current, 2)])
    pending: tuple[float, float] | None = None
    for t, o, s in rows:
        if s <= 0.3:
            continue
        o = snap(o)
        if abs(o - current) < 0.15:
            pending = None
            continue
        if pending and abs(pending[1] - o) < 0.15:
            at = _refine_boundary(voice, video, fps, current, o, steps[-1][0], t + 20)
            steps.append([round(at, 2), round(o, 2)])
            current, pending = o, None
        else:
            pending = (t, o)
    take["offsets"] = steps
    take["sync_score"] = round(float(np.mean([r[2] for r in good])), 3)
    on_progress(1.0)


def _refine_boundary(voice, video, fps, old, new, lo_t, hi_t) -> float:
    """The switch point between two offsets: where 'old before, new after'
    fits the audio best, to the nearest half second."""
    a, b = int(max(0, lo_t) * fps), int(hi_t * fps)

    def prod(off):
        o = int(round(off * fps))
        idx = np.arange(a, min(b, len(voice)))
        j = idx + o
        ok = (j >= 0) & (j < len(video))
        out = np.zeros(len(idx), dtype=np.float32)
        out[ok] = voice[idx[ok]] * video[j[ok]]
        return out

    po, pn = prod(old), prod(new)
    if len(po) == 0:
        return lo_t
    co, cn = np.cumsum(po), np.cumsum(pn)
    total_n = cn[-1]
    best_i, best_v = 0, -1e18
    for i in range(0, len(po), int(fps / 2)):
        v = co[i] + (total_n - cn[i])
        if v > best_v:
            best_v, best_i = v, i
    return (a + best_i) / fps
