"""Render the edit to a finished MP4 (plus captions and chapters).

Two passes, both at high quality:
  1. every clip is cut, blurred and conformed to the output size and frame
     rate (cached, so changing one clip re-renders only that clip)
  2. the clips are joined, graphics are laid on top, audio is levelled
"""

from __future__ import annotations

import hashlib
import json
import re
import time
from pathlib import Path
from typing import Callable

from . import graphics, media
from .edit import timeline_starts
from .privacy import blur_spans
from .project import Project, offset_at

# Bump when clip rendering changes, so cached clips are made again.
RENDER_VERSION = 2

QUALITY = {"high": 16, "standard": 20, "small": 24}
LEVEL = "highpass=f=70,afftdn=nf=-25,acompressor=threshold=-20dB:ratio=3:attack=5:release=120,loudnorm=I=-16:TP=-1.5:LRA=9"


def output_format(p: Project) -> tuple[int, int, float]:
    """1080p (or the largest source if smaller), at the frame rate most of the footage uses."""
    vids = [s for s in p.data["sources"] if s["has_video"] and s["role"] != "skip"]
    W, H = 1920, 1080
    if vids and max(s["height"] for s in vids) < 1080 and max(s["width"] for s in vids) < 1920:
        W, H = 1280, 720
    fps = float(p.data["output"].get("fps") or 0)
    if not fps:
        weight: dict[float, float] = {}
        for s in vids:
            f = s["fps"] or 30
            f = 30.0 if 29 <= f <= 31 else 60.0 if 59 <= f <= 61 else 50.0 if 49 <= f <= 51 \
                else 25.0 if 24 <= f <= 26 else 24.0 if 23 <= f <= 24.5 else 30.0
            weight[f] = weight.get(f, 0) + s["duration"]
        fps = max(weight, key=weight.get) if weight else 30.0
    return W, H, fps


def level_voice(p: Project, source_id: str) -> Path:
    """Each voice source levelled once, over its whole length."""
    out = p.path("audio", f"{source_id}.wav")
    if not out.exists():
        tmp = out.with_suffix(".part.wav")
        media.run(["ffmpeg", "-y", "-v", "error", "-i", str(p.source_path(source_id)), "-vn", "-af", LEVEL,
                   "-ar", "48000", "-ac", "2", str(tmp)])
        tmp.replace(out)
    return out


def _merge_boxes(boxes: list[tuple[list[int], tuple[float, float]]]):
    out: list[list] = []
    for box, win in sorted(boxes, key=lambda bw: bw[1][0]):
        x0, y0, x1, y1 = box
        for m in out:
            mb, mw = m
            ix = min(x1, mb[2]) - max(x0, mb[0])
            iy = min(y1, mb[3]) - max(y0, mb[1])
            small = min((x1 - x0) * (y1 - y0), (mb[2] - mb[0]) * (mb[3] - mb[1]))
            if ix > 0 and iy > 0 and ix * iy >= 0.6 * small and win[0] <= mw[1] + 0.3 and win[1] >= mw[0] - 0.3:
                m[0] = [min(x0, mb[0]), min(y0, mb[1]), max(x1, mb[2]), max(y1, mb[3])]
                m[1] = (min(win[0], mw[0]), max(win[1], mw[1]))
                break
        else:
            out.append([list(box), win])
    return out


def _blur_chain(boxes, size) -> str:
    """Blur once, copy patches: cheap however many boxes there are."""
    if not boxes:
        return "[v0]null[vb]"
    boxes = _merge_boxes(boxes)
    W, H = size
    n = len(boxes)
    parts = [f"[v0]split=2[base][tmp];[tmp]boxblur=22:6[blr];[blr]split={n}" + "".join(f"[k{i}]" for i in range(n))]
    cur = "base"
    for i, (box, win) in enumerate(boxes):
        x0, y0, x1, y1 = [max(0, int(v)) for v in box]
        x1, y1 = min(x1, W), min(y1, H)
        w, h = max(8, x1 - x0) // 2 * 2, max(8, y1 - y0) // 2 * 2
        x0, y0 = max(0, min(x0, W - w)), max(0, min(y0, H - h))
        parts.append(f"[k{i}]crop={w}:{h}:{x0}:{y0}[c{i}];[{cur}][c{i}]overlay={x0}:{y0}"
                     f":enable='between(t,{win[0]:.3f},{win[1]:.3f})'[o{i}]")
        cur = f"o{i}"
    parts.append(f"[{cur}]null[vb]")
    return ";".join(parts)


def _enc(fps: float) -> list[str]:
    return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "12", "-pix_fmt", "yuv420p", "-r", f"{fps:g}",
            "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2"]


def render_clip(p: Project, c: dict, spans, fmt, brand: dict) -> Path:
    W, H, fps = fmt
    dur = round(c["b"] - c["a"], 3) if c.get("kind") != "title" else float(c.get("dur", 3))
    fade = f"afade=t=in:d=0.02,afade=t=out:st={max(0.0, dur - 0.04):.3f}:d=0.04"
    pad = (f"scale={W}:{H}:force_original_aspect_ratio=decrease,pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:"
           f"color={brand['background'].replace('#', '0x')}")

    if c.get("kind") == "title":
        key = hashlib.sha1(json.dumps([c, fmt, brand], sort_keys=True).encode()).hexdigest()[:16]
        out = p.path("clips", f"title_{key}.mkv")
        if out.exists():
            return out
        png = p.path("gfx", f"title_{key}.png")
        graphics.title_card(c.get("text", ""), c.get("sub", ""), c.get("tag", ""), brand, W, H).save(png)
        media.run(["ffmpeg", "-y", "-v", "error", "-loop", "1", "-t", f"{dur:.3f}", "-i", str(png),
                   "-f", "lavfi", "-t", f"{dur:.3f}", "-i", "anullsrc=r=48000:cl=stereo",
                   "-filter_complex", f"[0:v]fps={fps:g},format=yuv420p,fade=t=in:d=0.3,"
                                      f"fade=t=out:st={dur - 0.35:.3f}:d=0.35[v]",
                   "-map", "[v]", "-map", "1:a", "-t", f"{dur:.3f}", *_enc(fps), str(out)])
        return out

    take = p.take(c["take"])
    voice = level_voice(p, take["voice"])
    off = offset_at(take, c["a"])
    boxes = []
    if take["video"]:
        s0 = c["a"] + off
        for t0, t1, box in spans.get(take["video"], []):
            if t1 >= s0 and t0 <= s0 + dur:
                boxes.append((box, (max(0.0, t0 - s0), min(dur, t1 - s0))))
    key = hashlib.sha1(json.dumps([RENDER_VERSION, take["video"], take["voice"], c["a"], c["b"], off, boxes, fmt,
                                   brand["background"]], sort_keys=True).encode()).hexdigest()[:16]
    out = p.path("clips", f"{key}.mkv")
    if out.exists():
        return out
    tmp = out.with_name(out.stem + ".part.mkv")

    if take["video"]:
        src = p.source(take["video"])
        conform = ""
        if src.get("color_range") == "pc" or (src.get("pix_fmt") or "").startswith("yuvj"):
            conform = "scale=out_range=tv,"  # phone footage: full range to standard
        vstart = c["a"] + off
        cmd = ["ffmpeg", "-y", "-v", "error", *media.window_input(p.source_path(take["video"]), vstart, dur),
               "-ss", f"{c['a']:.3f}", "-t", f"{dur:.3f}", "-i", str(voice)]
        fc = (f"[0:v]{media.window_filter(vstart, dur, fps)},{conform}format=yuv420p[v0];"
              + _blur_chain(boxes, (src["width"], src["height"]))
              + f";[vb]{pad},setsar=1[v];[1:a]{fade}[a]")
    else:
        # Voice only: the brand background with the take's name.
        png = p.path("gfx", f"audio_{take['id']}.png")
        graphics.title_card(take["name"], "", "", brand, W, H).save(png)
        cmd = ["ffmpeg", "-y", "-v", "error", "-loop", "1", "-t", f"{dur:.3f}", "-i", str(png),
               "-ss", f"{c['a']:.3f}", "-t", f"{dur:.3f}", "-i", str(voice)]
        fc = f"[0:v]fps={fps:g},format=yuv420p[v];[1:a]{fade}[a]"
    cmd += ["-filter_complex", fc, "-map", "[v]", "-map", "[a]", "-t", f"{dur:.3f}", *_enc(fps), str(tmp)]
    media.run(cmd)
    tmp.replace(out)
    return out


def _safe_name(name: str) -> str:
    return re.sub(r'[<>:"/\\|?*]+', "", name).strip() or "Retake"


def render(p: Project, settings: dict, on_progress: Callable[[float, str], None]) -> dict:
    edit = p.data["edit"]
    clips = edit["clips"]
    if not clips:
        raise ValueError("The timeline is empty.")
    brand = settings["brand"]
    fmt = output_format(p)
    W, H, fps = fmt
    detections = p.read_json("privacy", "detections.json", default=[]) or []
    spans = blur_spans(p, detections)

    total = sum(_clip_dur(c) for c in clips)
    done = 0.0
    files = []
    for i, c in enumerate(clips):
        files.append(render_clip(p, c, spans, fmt, brand))
        done += _clip_dur(c)
        on_progress(0.75 * done / total, f"Cutting clip {i + 1} of {len(clips)}")

    lst = p.path("clips", "list.txt")
    lst.write_text("".join(f"file '{f.name}'\n" for f in files), encoding="utf-8")
    joined = p.path("clips", "joined.mkv")
    media.run(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy", str(joined)])

    # Graphics: each one a cropped still, looped for the whole video and faded
    # in and out at its times. (A disabled overlay stops pulling frames and an
    # input that ends early stalls ffmpeg, so neither trick is used.)
    from PIL import Image

    overlays = [o for o in edit.get("overlays", []) if o.get("text")]
    gdir = p.path("gfx", "x").parent
    cmd = ["ffmpeg", "-y", "-v", "error", "-i", str(joined)]
    fc, cur = [], "0:v"
    for k, o in enumerate(overlays):
        img = graphics.render_overlay(o, brand, W, H)
        bbox = img.getbbox()
        if not bbox:
            continue
        x0, y0 = bbox[0] // 2 * 2, bbox[1] // 2 * 2
        png = gdir / f"ov_{k}.png"
        img.crop((x0, y0, bbox[2], bbox[3])).save(png)
        cmd += ["-framerate", f"{fps:g}", "-loop", "1", "-t", f"{total:.3f}", "-i", str(png)]
        idx = sum(1 for a in cmd if a == "-i") - 1  # this graphic's input number
        st, ln = float(o["start"]), float(o.get("dur", 4))
        fc.append(f"[{idx}:v]format=rgba,fade=t=in:st={st:.3f}:d=0.25:alpha=1,"
                  f"fade=t=out:st={max(st, st + ln - 0.3):.3f}:d=0.3:alpha=1[g{idx}]")
        fc.append(f"[{cur}][g{idx}]overlay={x0}:{y0}[o{idx}]")
        cur = f"o{idx}"
    fc.append(f"[{cur}]format=yuv420p[v]")
    fc.append("[0:a]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[a]")

    out_dir = p.folder / "Retake exports"
    out_dir.mkdir(exist_ok=True)
    stamp = time.strftime("%Y-%m-%d %H.%M")
    base = _safe_name(p.data["name"])
    out = out_dir / f"{base} {stamp}.mp4"
    crf = QUALITY.get(p.data["output"].get("quality", "high"), 16)
    cmd += ["-filter_complex", ";".join(fc), "-map", "[v]", "-map", "[a]",
            "-c:v", "libx264", "-preset", "medium", "-crf", str(crf), "-pix_fmt", "yuv420p", "-r", f"{fps:g}",
            "-movflags", "+faststart", "-c:a", "aac", "-b:a", "192k", str(out)]
    media.run_progress(cmd, total, lambda f: on_progress(0.75 + 0.25 * f, "Finishing: graphics and sound"))

    srt = out.with_suffix(".srt")
    srt.write_text(captions_srt(p, clips), encoding="utf-8")
    chapters = chapters_text(clips, overlays)
    (out.with_suffix(".chapters.txt")).write_text(chapters, encoding="utf-8")
    result = {"file": str(out), "srt": str(srt), "duration": round(total, 2), "width": W, "height": H, "fps": fps,
              "created": time.time(), "chapters": chapters}
    return result


def _clip_dur(c: dict) -> float:
    return float(c.get("dur", 3)) if c.get("kind") == "title" else c["b"] - c["a"]


def _ts(t: float, sep: str = ",") -> str:
    h, rem = divmod(max(0.0, t), 3600)
    m, s = divmod(rem, 60)
    return f"{int(h):02d}:{int(m):02d}:{int(s):02d}{sep}{int(round((s % 1) * 1000)) % 1000:03d}"


def captions_srt(p: Project, clips: list[dict]) -> str:
    """Captions for the kept words, timed to the edit, about 7 words a line."""
    starts = timeline_starts([{**c, "a": 0, "b": _clip_dur(c)} if c.get("kind") == "title" else c for c in clips])
    cues: list[tuple[float, float, str]] = []
    cache: dict[str, list] = {}
    for c, st in zip(clips, starts):
        if c.get("kind") == "title":
            continue
        words = cache.setdefault(c["take"], (p.read_json("takes", f"{c['take']}.json", default={}) or {}).get("words", []))
        line: list[dict] = []
        for w in words:
            if w["s"] >= c["a"] - 0.02 and w["e"] <= c["b"] + 0.05:
                line.append(w)
                if len(line) >= 7 or w["w"].endswith((".", "?", "!")):
                    cues.append((st + line[0]["s"] - c["a"], st + line[-1]["e"] - c["a"], " ".join(x["w"] for x in line)))
                    line = []
        if line:
            cues.append((st + line[0]["s"] - c["a"], st + line[-1]["e"] - c["a"], " ".join(x["w"] for x in line)))
    return "".join(f"{i}\n{_ts(a)} --> {_ts(max(b, a + 0.5))}\n{text}\n\n" for i, (a, b, text) in enumerate(cues, 1))


def chapters_text(clips: list[dict], overlays: list[dict]) -> str:
    rows = [(0.0, "Intro")]
    for o in overlays:
        if o.get("chapter"):
            t = max(0.0, float(o["start"]) - 0.2)
            if t < 1:
                rows[0] = (0.0, o["text"])
            else:
                rows.append((t, o["text"]))
    lines = []
    for t, name in rows:
        m, s = divmod(int(t), 60)
        h, m = divmod(m, 60)
        lines.append(f"{h}:{m:02d}:{s:02d} {name}" if h else f"{m}:{s:02d} {name}")
    return "\n".join(lines) + "\n"
