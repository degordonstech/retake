"""Find private text in the kept footage, and check the finished video for leaks.

Frames are decoded with ffmpeg exactly as the renderer seeks (OpenCV's
seeking lands seconds off on screen recordings). Text is read with the
Windows built-in OCR when available (fast), else RapidOCR.
"""

from __future__ import annotations

import re
from typing import Callable

import numpy as np

from . import media
from .project import Project, clip_dur, new_id, offset_at

# --------------------------------------------------------------------- OCR --
_engine = None


def ocr(frame: np.ndarray) -> list[tuple[int, int, int, int, str]]:
    """Lines of text as (x0, y0, x1, y1, text) in frame pixels."""
    global _engine
    if _engine is None:
        try:
            import winocr  # noqa: F401

            _engine = "win"
        except ImportError:
            from rapidocr_onnxruntime import RapidOCR

            _engine = RapidOCR()
    from PIL import Image

    if _engine == "win":
        import winocr

        r = winocr.recognize_pil_sync(Image.fromarray(frame), "en")
        out = []
        for ln in r["lines"]:
            rs = [w["bounding_rect"] for w in ln["words"]]
            out.append((int(min(q["x"] for q in rs)), int(min(q["y"] for q in rs)),
                        int(max(q["x"] + q["width"] for q in rs)), int(max(q["y"] + q["height"] for q in rs)),
                        ln["text"]))
        return out
    res, _ = _engine(frame)
    out = []
    for box, text, _conf in res or []:
        xs = [pt[0] for pt in box]
        ys = [pt[1] for pt in box]
        out.append((int(min(xs)), int(min(ys)), int(max(xs)), int(max(ys)), text))
    return out


# ------------------------------------------------------------------- rules --
EMAIL = re.compile(r"[\w.+-]+@[\w-]+(\.[\w-]+)+", re.I)
PHONE = re.compile(r"(\+?\d[\d\s-]{9,15}\d)")
KEYS = re.compile(r"\b(sk-[A-Za-z0-9_-]{16,}|sk_(live|test)_[A-Za-z0-9]{10,}|pk_(live|test)_[A-Za-z0-9]{10,}"
                  r"|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}"
                  r"|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,})")
LONG_ID_URL = re.compile(r"(https?:|www\.|\.com|\.dev|\.app|\.io|\.xyz|/)\S*\d{9,}", re.I)
# A password prompt: "Password for the Key Store:" (OCR often misreads it, and
# never reads the stars after it), so the space after the colon is covered.
PASSWORD = re.compile(r"\bpas+\S{0,6}?\b[^:]{0,32}:", re.I)
# The same prompt read without its colon ("passM)rd for the Key Sto").
PROMPT_START = re.compile(r"^\W{0,3}(enter\s+(the\s+|your\s+|new\s+)?)?(key\s*store\s+)?(pas+\S{0,3}(rd|wd)\b|passw|passphrase)", re.I)
LOOKS = str.maketrans({"i": "l", "|": "l", "1": "l", "!": "l"})

# Bump when the rules change, so old scans are redone before a render.
RULES_VERSION = 7

KIND_LABEL = {
    "email": "Email address", "phone": "Phone number", "key": "API key or token", "url_id": "Link with an ID",
    "password": "Password", "word": "Private word", "file_picker": "File picker", "recent": "Recent projects list",
    "desktop": "Desktop icons", "link_preview": "Link preview", "manual": "Your blur",
}


def _mask(text: str) -> str:
    t = text.strip()
    if len(t) <= 4:
        return "•" * len(t)
    return t[:2] + "•" * min(10, len(t) - 4) + t[-2:]


def _span(x0, x1, text, m) -> tuple[int, int]:
    n = max(len(text), 1)
    return int(x0 + (x1 - x0) * m.start() / n), int(x0 + (x1 - x0) * m.end() / n)


def find(lines, frame_h: int, frame_w: int, private_words: list[str], allowed: set[str]) -> list[dict]:
    """Private things on one frame: [{kind, text, box}]."""
    hits: list[dict] = []
    words_re = None
    if private_words:
        alts = [re.escape(w.strip()).replace(r"\-", r"[-\s]*").replace(r"\ ", r"[-\s]*")
                for w in private_words if w.strip()]
        if alts:
            words_re = re.compile("|".join(alts), re.I)

    def add(kind, text, box):
        if text.strip().lower() in allowed:
            return
        hits.append({"kind": kind, "text": text.strip()[:80], "box": [int(v) for v in box]})

    for x0, y0, x1, y1, text in lines:
        flat = text.replace(" ", "")
        for m in EMAIL.finditer(flat):
            sx0, sx1 = _span(x0, x1, flat, m)
            add("email", m.group(0), (sx0 - 10, y0 - 5, sx1 + 10, y1 + 5))
        for m in KEYS.finditer(flat):
            add("key", m.group(0), (x0 - 6, y0 - 5, x1 + 10, y1 + 5))
        if LONG_ID_URL.search(flat):
            # In the address bar, cover the whole bar; elsewhere the line.
            right = max(x1 + 30, int(frame_w * 0.86)) if y0 < frame_h * 0.1 else x1 + 30
            add("url_id", text, (x0 - 6, y0 - 6, right, y1 + 6))
        digits = re.sub(r"[\s-]", "", text)
        if PHONE.search(text) and re.search(r"\d{10,13}", digits) and not re.search(r"\d{15,}", digits) \
                and not LONG_ID_URL.search(flat):
            m = PHONE.search(text)
            sx0, sx1 = _span(x0, x1, text, m)
            add("phone", m.group(0), (sx0 - 8, y0 - 5, sx1 + 8, y1 + 5))
        m = PASSWORD.search(text)
        # A prompt has nothing after the colon but the hidden typing (or OCR noise).
        rest = text[m.end():] if m else ""
        reach = int(340 * frame_h / 1080)
        if m and len(rest) <= 40 and not re.search(r"[A-Za-z]{3,}", rest):
            cx = int(x0 + (x1 - x0) * m.end() / max(len(text), 1))
            add("password", "password", (cx - 2, y0 - 6, cx + reach, y1 + 6))
        elif len(text) <= 48 and PROMPT_START.search(text.strip()):
            # No colon read: the typing starts where the read text ends.
            add("password", "password", (x1 - 12, y0 - 6, x1 + reach + 40, y1 + 6))
        if words_re:
            for m in words_re.finditer(text):
                sx0, sx1 = _span(x0, x1, text, m)
                add("word", m.group(0), (sx0 - 12, y0 - 6, sx1 + 12, y1 + 6))

    texts = [(ln, ln[4].strip()) for ln in lines]
    fn = next((ln for ln, t in texts if t.lower().startswith("file name")), None)
    if fn:
        org = next((ln for ln, t in texts if t.startswith("Organize")), None)
        cancel = next((ln for ln, t in texts if t == "Cancel"), None)
        left = (org[0] - 16) if org else max(0, fn[0] - 140)
        top = (org[1] - 70) if org else fn[1] - 560
        right = (cancel[2] + 16) if cancel else fn[2] + 720
        add("file_picker", "file picker", (left, top, right, fn[1] - 8))
    rec = next((ln for ln, t in texts if t == "Recent"), None)
    if rec:
        more = next((ln for ln, t in texts if t.startswith("More") and 0 < ln[1] - rec[1] < 260), None)
        add("recent", "recent projects", (rec[0] - 8, rec[3] + 3, rec[0] + 500, (more[1] - 2) if more else rec[3] + 150))
    if any(t.startswith("Recycle") for _, t in texts):
        add("desktop", "desktop icons", (0, 0, int(frame_w * 0.13), frame_h - 40))
    return [h for h in hits if h["box"][2] > h["box"][0] and h["box"][3] > h["box"][1]]


# ------------------------------------------------------------------ scan ----
# Ten frames a second, reading text again whenever the picture changes: brief
# redraws (a terminal reprinting a password prompt) last only a few frames.
SAMPLE_FPS = 10.0
STRIP_FPS = 10.0
HOLD = 0.3   # seconds of blur either side of each sighting


def scan(p: Project, settings: dict, on_progress: Callable[[float], None], log: Callable[[str], None]) -> list[dict]:
    """Every private thing on screen during the kept clips, grouped for review."""
    clips = [c for c in p.data["edit"]["clips"] if c.get("kind") != "title" and p.take(c["take"])["video"]]
    allowed = {a.lower() for a in p.data["privacy"].get("allowed", [])}
    words = settings.get("private_words") or []
    total = sum(c["b"] - c["a"] for c in clips) or 1
    done = 0.0
    samples: list[dict] = []  # {src, t, kind, text, box}
    for c in clips:
        take = p.take(c["take"])
        src_id = take["video"]
        src = p.source(src_id)
        size = (src["width"], src["height"])
        off = offset_at(take, c["a"])
        start, dur = c["a"] + off, c["b"] - c["a"]
        path = p.source_path(src_id)
        prev, prev_hits = None, []
        for t, fr in media.decode_frames(path, start, dur, SAMPLE_FPS, size):
            small = fr[::6, ::6].mean(axis=2)
            change = None if prev is None else float(np.abs(small - prev).mean())
            if change is None or change > 0.6:
                hits = find(ocr(fr), size[1], size[0], words, allowed)
                if change is not None and change < 2.5:
                    # A small change (typing, a cursor): one misread must not
                    # drop what was on screen a moment ago, so keep it too.
                    seen = {(h["kind"], tuple(h["box"])) for h in hits}
                    hits += [h for h in prev_hits if (h["kind"], tuple(h["box"])) not in seen]
                prev_hits = hits
                prev = small
            for h in prev_hits:
                samples.append({"src": src_id, "t": round(t, 2), **h})
        # Link previews flash by at the bottom-left of a browser between samples.
        if take["kind"] == "screen":
            sh, sw = min(48, size[1]), min(1100, size[0])
            prev, hit = None, False
            for t, fr in media.decode_frames(path, start, dur, STRIP_FPS, size,
                                             crop=(sw, sh, 0, size[1] - sh)):
                g = fr.mean(axis=2)
                if prev is None or np.abs(g - prev).mean() > 1.5:
                    from PIL import Image

                    big = np.asarray(Image.fromarray(fr).resize((sw * 2, sh * 2)))
                    text = " ".join(ln[4] for ln in ocr(big))
                    flat = text.replace(" ", "").lower()
                    hit = bool(re.search(r"https?:|www\.|\.com/|\.dev/|\.app/", flat)) and bool(
                        re.search(r"\d{6,}|/u/|console|dashboard|account|admin", flat.translate(LOOKS)))
                    prev = g
                if hit:
                    samples.append({"src": src_id, "t": round(t, 2), "kind": "link_preview", "text": "link preview",
                                    "box": [0, size[1] - sh, sw, size[1]]})
        done += dur
        on_progress(min(0.99, done / total))
    detections = group(samples)
    log(f"Found {len(detections)} private things across {len(clips)} clips")
    on_progress(1.0)
    return detections


def group(samples: list[dict]) -> list[dict]:
    """Join sightings of the same thing into one detection. Each detection
    keeps [t0, t1, x0, y0, x1, y1] runs: one per stretch it stayed in place."""
    out: list[dict] = []
    open_: dict[tuple, dict] = {}
    for s in sorted(samples, key=lambda s: (s["src"], s["t"])):
        key = (s["src"], s["kind"], s["text"].lower()[:40])
        d = open_.get(key)
        if d and s["t"] - d["t1"] <= 1.5:
            last = d["boxes"][-1]
            if last[2:] == s["box"] and s["t"] - last[1] <= 0.25:
                last[1] = s["t"]
            else:
                d["boxes"].append([s["t"], s["t"], *s["box"]])
            d["t1"] = s["t"]
        else:
            d = {"id": new_id("d"), "src": s["src"], "kind": s["kind"], "label": KIND_LABEL.get(s["kind"], s["kind"]),
                 "text": s["text"], "preview": _mask(s["text"]) if s["kind"] in ("email", "phone", "key", "word")
                 else KIND_LABEL.get(s["kind"], s["kind"]),
                 "t0": s["t"], "t1": s["t"], "boxes": [[s["t"], s["t"], *s["box"]]]}
            open_[key] = d
            out.append(d)
    for d in out:
        d["t0"], d["t1"] = round(max(0.0, d["t0"] - HOLD), 2), round(d["t1"] + HOLD, 2)
        d["key"] = det_key(d)
    return out


def det_key(d: dict) -> str:
    """Stable name for a detection, so 'leave this visible' survives a re-scan."""
    return f"{d['src']}|{d['kind']}|{d['text'].lower()[:40]}"


def blur_spans(p: Project, detections: list[dict]) -> dict[str, list[tuple[float, float, list[int]]]]:
    """Per source: (t0, t1, box) to blur, from kept detections and manual boxes."""
    skip = set(p.data["privacy"].get("dismissed", []))
    spans: dict[str, list] = {}
    for d in detections:
        if det_key(d) in skip:
            continue
        for t0, t1, *box in d["boxes"]:
            spans.setdefault(d["src"], []).append((t0 - HOLD, t1 + HOLD, box))
    for m in p.data["privacy"].get("manual", []):
        spans.setdefault(m["src"], []).append((m["t0"], m["t1"], m["box"]))
    return spans


# ---------------------------------------------------------------- verify ----
def verify(video_path, settings: dict, allowed: set[str], on_progress: Callable[[float], None]) -> list[dict]:
    """Read the finished video back and list anything private still readable."""
    info = media.probe(video_path)
    size = (info["width"], info["height"])
    leaks = []
    prev = None
    words = settings.get("private_words") or []
    for t, fr in media.decode_frames(video_path, 0, info["duration"], 1.0, size):
        small = fr[::6, ::6].mean(axis=2)
        if prev is not None and np.abs(small - prev).mean() < 0.8:
            continue
        prev = small
        for h in find(ocr(fr), size[1], size[0], words, allowed):
            # Context rules (a password label, a file picker's buttons) stay
            # readable after the blur by design; only real content counts.
            if h["kind"] not in ("email", "phone", "key", "url_id", "word"):
                continue
            leaks.append({"t": round(t, 1), "kind": h["kind"], "label": KIND_LABEL.get(h["kind"], h["kind"]),
                          "preview": _mask(h["text"])})
        on_progress(min(0.99, t / max(info["duration"], 1)))
    on_progress(1.0)
    return leaks
