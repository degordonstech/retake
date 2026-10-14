"""Render the edit to a finished MP4 (plus captions and chapters).

Two passes, both at high quality:
  1. every clip is cut, blurred, retimed, coloured and framed for the output
     size (cached, so changing one clip re-renders only that clip). Where two
     clips meet with a transition, a short piece is made from both: the end
     of one blended into the start of the next.
  2. the pieces are joined, then B-roll, graphics, captions and text are laid
     on top, music is mixed under the voice, and the sound is levelled.
"""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import time
from pathlib import Path
from typing import Callable

from . import captions, graphics, media
from .looks import ASPECTS, filter_adj, transition
from .privacy import blur_spans
from .project import Project, clip_dur, clip_speed, offset_at

# Bump when clip rendering changes, so cached clips are made again.
RENDER_VERSION = 4

QUALITY = {"high": 16, "standard": 20, "small": 24}
PRESET = {"high": "veryfast", "standard": "veryfast", "small": "medium"}
LEVEL = "highpass=f=70,afftdn=nf=-25,acompressor=threshold=-20dB:ratio=3:attack=5:release=120,loudnorm=I=-16:TP=-1.5:LRA=9"


def output_format(p: Project) -> tuple[int, int, float]:
    """The frame size for the chosen shape (1080p, or 720p for small 16:9
    footage), at the frame rate most of the footage uses."""
    vids = [s for s in p.data["sources"] if s["has_video"] and s["role"] != "skip"]
    aspect = (p.data["edit"].get("format") or {}).get("aspect", "16:9")
    W, H = ASPECTS.get(aspect, ASPECTS["16:9"])
    if aspect == "16:9" and vids and max(s["height"] for s in vids) < 1080 and max(s["width"] for s in vids) < 1920:
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
    # Pieces are encoded again at the end, so fast and nearly lossless here.
    return ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "10", "-pix_fmt", "yuv420p", "-r", f"{fps:g}",
            "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2"]


# ------------------------------------------------------------ clip looks ----
def adjustments(c: dict) -> dict:
    """The clip's colour: its filter's values plus its own adjustments."""
    adj = dict(filter_adj(c.get("filter") or "none"))
    for k, v in (c.get("adjust") or {}).items():
        adj[k] = adj.get(k, 0.0) + float(v or 0)
    return {k: v for k, v in adj.items() if abs(v) > 1e-3}


def adjust_filter(adj: dict) -> str:
    parts = []
    b, ct, sat = adj.get("brightness", 0), adj.get("contrast", 0), adj.get("saturation", 0)
    if b or ct or sat:
        parts.append(f"eq=brightness={b * 0.5:.3f}:contrast={1 + ct:.3f}:saturation={max(0.0, 1 + sat):.3f}")
    if adj.get("temperature"):
        parts.append(f"colortemperature=temperature={6500 - 3200 * adj['temperature']:.0f}")
    if adj.get("sharpen", 0) > 0:
        parts.append(f"unsharp=5:5:{min(2.0, adj['sharpen'] * 1.4):.2f}")
    if adj.get("vignette", 0) > 0:
        parts.append(f"vignette=angle={0.25 + 0.55 * min(1.0, adj['vignette']):.3f}")
    return ",".join(parts)


def frame_of(c: dict, take: dict | None, aspect: str) -> dict:
    """How the picture sits in the frame. Portrait output fills with face-cam
    footage by default and fits screen recordings."""
    f = dict(c.get("frame") or {})
    if "mode" not in f:
        f["mode"] = "fill" if (take and take.get("kind") == "camera" and aspect in ("9:16", "4:5")) else "fit"
    f.setdefault("zoom", 1.0)
    f.setdefault("x", 0.5)
    f.setdefault("y", 0.5)
    f.setdefault("bg", "blur" if aspect != "16:9" else "color")
    return f


def frame_filter(f: dict, W: int, H: int, fps: float, plen: float, bg_hex: str) -> str:
    """[in] -> [framed]: fit or fill the output, then any zoom and pan."""
    fx, fy = min(1.0, max(0.0, float(f["x"]))), min(1.0, max(0.0, float(f["y"])))
    z0 = max(1.0, float(f.get("zoom") or 1.0))
    z1 = max(1.0, float(f.get("zoomTo") or z0))
    bg = bg_hex.replace("#", "0x")
    if f["mode"] == "fill":
        chain = (f"[fin]scale={W}:{H}:force_original_aspect_ratio=increase,"
                 f"crop={W}:{H}:x='(iw-{W})*{fx:.3f}':y='(ih-{H})*{fy:.3f}',setsar=1[based]")
    elif f.get("bg") == "blur":
        chain = (f"[fin]split=2[fga][bga];[bga]scale={W // 8}:{H // 8}:force_original_aspect_ratio=increase,"
                 f"crop={W // 8}:{H // 8},boxblur=6:2,scale={W}:{H},eq=brightness=-0.08:saturation=1.1[bgb];"
                 f"[fga]scale={W}:{H}:force_original_aspect_ratio=decrease[fgb];"
                 f"[bgb][fgb]overlay=(W-w)/2:(H-h)/2,setsar=1[based]")
    else:
        chain = (f"[fin]scale={W}:{H}:force_original_aspect_ratio=decrease,"
                 f"pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:color={bg},setsar=1[based]")
    if z0 == 1.0 and z1 == 1.0:
        return chain + ";[based]null[framed]"
    if abs(z1 - z0) < 1e-3:
        cw, ch = int(W / z0) // 2 * 2, int(H / z0) // 2 * 2
        cx = min(max(0, int(fx * W - cw / 2)), W - cw)
        cy = min(max(0, int(fy * H - ch / 2)), H - ch)
        return chain + f";[based]crop={cw}:{ch}:{cx}:{cy},scale={W}:{H},setsar=1[framed]"
    # A slow push in or out: eased, drawn from a 2x frame so it doesn't shimmer.
    n = max(2, int(round(plen * fps)))
    ease = f"(1-cos(PI*min(on/{n - 1},1)))/2"
    z = f"({z0:.4f}+({z1 - z0:.4f})*{ease})"
    return chain + (f";[based]scale={W * 2}:{H * 2},zoompan=z='{z}':d=1:s={W}x{H}:fps={fps:g}"
                    f":x='clip({fx:.3f}*iw-iw/zoom/2,0,iw-iw/zoom)':y='clip({fy:.3f}*ih-ih/zoom/2,0,ih-ih/zoom)',"
                    f"setsar=1[framed]")


def atempo(speed: float) -> str:
    parts, s = [], speed
    while s > 2.0:
        parts.append("atempo=2.0")
        s /= 2.0
    while s < 0.5:
        parts.append("atempo=0.5")
        s /= 0.5
    if abs(s - 1.0) > 1e-3:
        parts.append(f"atempo={s:.4f}")
    return ",".join(parts)


# ---------------------------------------------------------------- pieces ----
def render_piece(p: Project, c: dict, lt0: float, lt1: float, spans, fmt, brand: dict, aspect: str,
                 soft_in: bool = True, soft_out: bool = True) -> Path:
    """The stretch [lt0, lt1] of a clip, in its own timeline seconds. lt0 may
    be below 0 and lt1 above the clip's length: that is a transition borrowing
    picture from just outside the clip (its sound stays silent there)."""
    W, H, fps = fmt
    dur = clip_dur(c)
    plen = round(lt1 - lt0, 3)
    r0, r1 = -lt0, dur - lt0  # the clip's real start and end, in piece time

    def audio_chain(src: str, pre: str, vol: float, head: float) -> str:
        """Sound for the piece: silent outside the real clip, soft at the real cuts."""
        f = [x for x in (pre,) if x]
        if abs(vol - 1) > 1e-3:
            f.append(f"volume={vol:.3f}")
        if head > 0:
            f.append(f"adelay={int(head * 1000)}:all=1")
        if r0 > 0.001 or r1 < plen - 0.001:
            f.append(f"volume=0:enable='lt(t,{max(0.0, r0):.3f})+gt(t,{r1:.3f})'")
        if 0 <= r0 < plen:
            f.append(f"afade=t=in:st={max(0.0, r0):.3f}:d=0.02")
        if 0 < r1 <= plen:
            f.append(f"afade=t=out:st={max(0.0, r1 - 0.04):.3f}:d=0.04")
        f.append(f"apad,atrim=0:{plen:.3f}")
        return f"[{src}]" + ",".join(f) + "[a]"

    if c.get("kind") == "title":
        key = hashlib.sha1(json.dumps([RENDER_VERSION, c, lt0, lt1, fmt, brand, soft_in, soft_out],
                                      sort_keys=True).encode()).hexdigest()[:16]
        out = p.path("clips", f"title_{key}.mkv")
        if out.exists():
            return out
        png = p.path("gfx", f"title_{key}.png")
        graphics.title_card(c.get("text", ""), c.get("sub", ""), c.get("tag", ""), brand, W, H).save(png)
        vf = [f"fps={fps:g}", "format=yuv420p"]
        if soft_in and 0 <= r0 < plen:
            vf.append(f"fade=t=in:st={r0:.3f}:d=0.3")
        if soft_out and 0 < r1 <= plen:
            vf.append(f"fade=t=out:st={max(0.0, r1 - 0.35):.3f}:d=0.35")
        tmp = out.with_name(out.stem + ".part.mkv")
        media.run(["ffmpeg", "-y", "-v", "error", "-loop", "1", "-t", f"{plen:.3f}", "-i", str(png),
                   "-f", "lavfi", "-t", f"{plen:.3f}", "-i", "anullsrc=r=48000:cl=stereo",
                   "-filter_complex", f"[0:v]{','.join(vf)}[v]", "-map", "[v]", "-map", "1:a", "-t", f"{plen:.3f}",
                   *_enc(fps), str(tmp)])
        tmp.replace(out)
        return out

    take = p.take(c["take"])
    sp = clip_speed(c)
    voice = level_voice(p, take["voice"])
    off = offset_at(take, c["a"])
    # The stretch of recording this piece needs, kept inside the recording;
    # anything past either end is held on the first or last frame.
    want_a, want_b = c["a"] + lt0 * sp, c["a"] + lt1 * sp
    src_a, src_b = max(0.0, want_a), min(take["duration"], want_b)
    head = max(0.0, (src_a - want_a) / sp)
    tail = max(0.0, (want_b - src_b) / sp)
    src_len = max(0.05, src_b - src_a)
    adj = adjustments(c)
    vol = 0.0 if c.get("mute") else float(c.get("volume", 1.0))
    frm = frame_of(c, take, aspect)

    boxes = []
    if take["video"]:
        s0 = src_a + off
        for t0, t1, box in spans.get(take["video"], []):
            if t1 >= s0 and t0 <= s0 + src_len:
                boxes.append((box, (max(0.0, t0 - s0), min(src_len, t1 - s0))))
    key = hashlib.sha1(json.dumps([RENDER_VERSION, take["video"], take["voice"], c["a"], c["b"], lt0, lt1, off, boxes,
                                   fmt, brand["background"], sp, vol, adj, frm, aspect, take["duration"]],
                                  sort_keys=True).encode()).hexdigest()[:16]
    out = p.path("clips", f"{key}.mkv")
    if out.exists():
        return out
    tmp = out.with_name(out.stem + ".part.mkv")

    retime = f",setpts=(PTS-STARTPTS)/{sp:.4f}" if abs(sp - 1) > 1e-3 else ""
    look = adjust_filter(adj)
    pad = ""
    if head > 0.001 or tail > 0.001:
        pad = f",tpad=start_duration={head:.3f}:start_mode=clone:stop_duration={tail:.3f}:stop_mode=clone"
    tempo = atempo(sp)
    if take["video"]:
        src = p.source(take["video"])
        conform = ""
        if src.get("color_range") == "pc" or (src.get("pix_fmt") or "").startswith("yuvj"):
            conform = "scale=out_range=tv,"  # phone footage: full range to standard
        vstart = src_a + off
        # Screen recordings skip frames while nothing moves, so they are read
        # from well before the cut; camera footage has every frame.
        pre = 1.0 if src.get("role") == "camera" else media.PREROLL
        cmd = ["ffmpeg", "-y", "-v", "error", *media.window_input(p.source_path(take["video"]), vstart, src_len, pre),
               "-ss", f"{src_a:.3f}", "-t", f"{src_len:.3f}", "-i", str(voice)]
        fc = (f"[0:v]{media.window_filter(vstart, src_len, fps * sp, pre)},{conform}format=yuv420p[v0];"
              + _blur_chain(boxes, (src["width"], src["height"]))
              + f";[vb]null{retime}{(',' + look) if look else ''}[fin];"
              + frame_filter(frm, W, H, fps, plen, brand["background"])
              + f";[framed]fps={fps:g}{pad},trim=0:{plen:.3f},setpts=PTS-STARTPTS,format=yuv420p[v];"
              + audio_chain("1:a", tempo, vol, head))
    else:
        # Voice only: the brand background with the take's name.
        png = p.path("gfx", f"audio_{take['id']}_{W}x{H}.png")
        if not png.exists():
            graphics.title_card(take["name"], "", "", brand, W, H).save(png)
        cmd = ["ffmpeg", "-y", "-v", "error", "-loop", "1", "-t", f"{plen:.3f}", "-i", str(png),
               "-ss", f"{src_a:.3f}", "-t", f"{src_len:.3f}", "-i", str(voice)]
        fc = (f"[0:v]fps={fps:g},format=yuv420p[v];"
              + audio_chain("1:a", tempo, vol, head))
    cmd += ["-filter_complex", fc, "-map", "[v]", "-map", "[a]", "-t", f"{plen:.3f}", *_enc(fps), str(tmp)]
    media.run(cmd)
    tmp.replace(out)
    return out


def render_transition(p: Project, a: dict, b: dict, d: float, kind: str, spans, fmt, brand: dict, aspect: str) -> Path:
    """The d seconds around a cut, with the end of `a` blended into `b`."""
    W, H, fps = fmt
    da = clip_dur(a)
    pa = render_piece(p, a, da - d / 2, da + d / 2, spans, fmt, brand, aspect, False, False)
    pb = render_piece(p, b, -d / 2, d / 2, spans, fmt, brand, aspect, False, False)
    xf = (transition(kind) or {"xfade": "fade"})["xfade"]
    key = hashlib.sha1(json.dumps([RENDER_VERSION, pa.name, pb.name, xf, d]).encode()).hexdigest()[:16]
    out = p.path("clips", f"tr_{key}.mkv")
    if out.exists():
        return out
    tmp = out.with_name(out.stem + ".part.mkv")
    media.run(["ffmpeg", "-y", "-v", "error", "-i", str(pa), "-i", str(pb), "-filter_complex",
               f"[0:v][1:v]xfade=transition={xf}:duration={d:.3f}:offset=0,trim=0:{d:.3f},setpts=PTS-STARTPTS[v];"
               f"[0:a][1:a]amix=inputs=2:normalize=0:duration=longest,atrim=0:{d:.3f}[a]",
               "-map", "[v]", "-map", "[a]", "-t", f"{d:.3f}", *_enc(fps), str(tmp)])
    tmp.replace(out)
    return out


def transitions_of(clips: list[dict]) -> list[float]:
    """The length of the transition into each clip (0 for a hard cut), kept
    short enough that every clip still shows on its own for a moment."""
    out = [0.0] * len(clips)
    for i in range(1, len(clips)):
        tr = clips[i].get("transition") or {}
        if not tr.get("type") or not transition(tr["type"]):
            continue
        d = float(tr.get("dur") or 0.5)
        limit = 0.45 * min(clip_dur(clips[i - 1]), clip_dur(clips[i]))
        out[i] = round(max(0.0, min(d, limit, 2.0)), 3)
        if out[i] < 0.1:
            out[i] = 0.0
    # Two transitions must not eat one clip completely.
    for i in range(1, len(clips) - 1):
        room = clip_dur(clips[i]) - 0.1
        if out[i] / 2 + out[i + 1] / 2 > room:
            scale = room / max(1e-6, out[i] / 2 + out[i + 1] / 2)
            out[i] *= scale
            out[i + 1] *= scale
    return out


def _safe_name(name: str) -> str:
    return re.sub(r'[<>:"/\\|?*]+', "", name).strip() or "Retake"


def _fonts_for(p: Project) -> None:
    """libass reads fonts from a folder next to the subtitle file."""
    dst = p.dir / "fonts"
    dst.mkdir(exist_ok=True)
    for f in captions.FONT_DIR.glob("*.ttf"):
        target = dst / f.name
        if not target.exists() or target.stat().st_size != f.stat().st_size:
            shutil.copy2(f, target)


def _rounded_mask(path: Path, w: int, h: int, radius: int) -> None:
    from PIL import Image, ImageDraw

    m = Image.new("L", (w, h), 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, w - 1, h - 1), radius, fill=255)
    m.save(path)


# --------------------------------------------------------------- render ----
def render(p: Project, settings: dict, on_progress: Callable[[float, str], None]) -> dict:
    edit = p.data["edit"]
    clips = edit["clips"]
    if not clips:
        raise ValueError("The timeline is empty.")
    brand = settings["brand"]
    fmt = output_format(p)
    W, H, fps = fmt
    aspect = (edit.get("format") or {}).get("aspect", "16:9")
    detections = p.read_json("privacy", "detections.json", default=[]) or []
    spans = blur_spans(p, detections)

    trans = transitions_of(clips)
    total = sum(clip_dur(c) for c in clips)
    done = 0.0
    files = []
    for i, c in enumerate(clips):
        d_in = trans[i]
        d_out = trans[i + 1] if i + 1 < len(clips) else 0.0
        if d_in:
            kind = clips[i]["transition"]["type"]
            files.append(render_transition(p, clips[i - 1], c, d_in, kind, spans, fmt, brand, aspect))
        files.append(render_piece(p, c, d_in / 2, clip_dur(c) - d_out / 2, spans, fmt, brand, aspect,
                                  soft_in=not d_in, soft_out=not d_out))
        done += clip_dur(c)
        on_progress(0.7 * done / total, f"Cutting clip {i + 1} of {len(clips)}")

    lst = p.path("clips", "list.txt")
    lst.write_text("".join(f"file '{f.name}'\n" for f in files), encoding="utf-8")
    joined = p.path("clips", "joined.mkv")
    media.run(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy", str(joined)])

    on_progress(0.72, "Finishing: captions, graphics and sound")
    # Inputs are numbered as they are added; filters refer to them by number.
    cmd = ["ffmpeg", "-y", "-v", "error", "-i", str(joined)]
    n_in = 1

    def add_input(*args: str) -> int:
        nonlocal n_in
        cmd.extend(args)
        n_in += 1
        return n_in - 1

    fc: list[str] = []
    cur = "0:v"
    assets = {a["id"]: a for a in p.data.get("assets", [])}
    gdir = p.path("gfx", "x").parent
    audio_parts: list[str] = []

    # B-roll and picture-in-picture, under the text.
    for k, m in enumerate(edit.get("media", [])):
        a = assets.get(m.get("asset", ""))
        if not a or not Path(a["file"]).exists():
            continue
        st, ln = float(m["start"]), float(m.get("dur", 3))
        if st >= total or ln <= 0.05:
            continue
        ln = min(ln, total - st)
        full = m.get("mode", "pip") == "full"
        aw, ah = a.get("width") or 1920, a.get("height") or 1080
        if full:
            size = f"scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H}"
            ow, oh = W, H
        else:
            ow = int(W * float(m.get("scale", 0.4))) // 2 * 2
            oh = int(ow * ah / aw) // 2 * 2
            size = f"scale={ow}:{oh}"
        shift = f",setpts=PTS-STARTPTS+{st:.3f}/TB"
        if a["kind"] == "image":
            idx = add_input("-framerate", f"{fps:g}", "-loop", "1", "-t", f"{ln:.3f}", "-i", a["file"])
            src = f"[{idx}:v]{size},format=rgba"
        else:
            idx = add_input("-ss", f"{float(m.get('in', 0)):.3f}", "-t", f"{ln:.3f}", "-i", a["file"])
            src = f"[{idx}:v]fps={fps:g},{size},format=rgba"
            if a.get("has_audio") and float(m.get("volume", 0)) > 0:
                audio_parts.append(f"[{idx}:a]volume={float(m['volume']):.3f},adelay={int(st * 1000)}:all=1")
        if not full and float(m.get("radius", 0.06)) > 0:
            mask = gdir / f"mask_{ow}x{oh}_{int(float(m.get('radius', 0.06)) * 100)}.png"
            if not mask.exists():
                _rounded_mask(mask, ow, oh, int(min(ow, oh) * float(m.get("radius", 0.06))))
            mi = add_input("-framerate", f"{fps:g}", "-loop", "1", "-t", f"{ln:.3f}", "-i", str(mask))
            fc.append(f"{src}[mv{k}];[{mi}:v]format=gray[mm{k}];[mv{k}][mm{k}]alphamerge[ma{k}]")
            src = f"[ma{k}]null"
        op = float(m.get("opacity", 1.0))
        opacity = f",colorchannelmixer=aa={op:.3f}" if op < 0.999 else ""
        # Fades run on the overlay's own clock, before it is moved into place.
        fade = (f",fade=t=in:st=0:d=0.25:alpha=1,fade=t=out:st={max(0.0, ln - 0.25):.3f}:d=0.25:alpha=1"
                if m.get("anim", "fade") != "none" else "")
        fc.append(f"{src}{opacity}{fade}{shift}[m{k}]")
        if full:
            x, y = "0", "0"
        else:
            x = f"{float(m.get('x', 0.75)) * W:.1f}-w/2"
            y = f"{float(m.get('y', 0.3)) * H:.1f}-h/2"
        if m.get("anim") == "up":
            y = f"{y}+{H * 0.06:.0f}*max(0\\,1-(t-{st:.3f})/0.3)"
        elif m.get("anim") == "left":
            x = f"{x}+{W * 0.06:.0f}*max(0\\,1-(t-{st:.3f})/0.3)"
        fc.append(f"[{cur}][m{k}]overlay=x='{x}':y='{y}':eof_action=pass[mo{k}]")
        cur = f"mo{k}"

    # Graphics: each one a cropped still, looped for its own few seconds,
    # faded, and moved to its time. Once it ends the video passes through.
    overlays = [o for o in edit.get("overlays", []) if o.get("text") and o.get("kind") in ("label", "lower", "caption")]
    for k, o in enumerate(overlays):
        img = graphics.render_overlay(o, brand, W, H)
        bbox = img.getbbox()
        if not bbox:
            continue
        x0, y0 = bbox[0] // 2 * 2, bbox[1] // 2 * 2
        png = gdir / f"ov_{k}.png"
        img.crop((x0, y0, bbox[2], bbox[3])).save(png)
        st, ln = float(o["start"]), float(o.get("dur", 4))
        if st >= total:
            continue
        ln = min(ln, total - st)
        idx = add_input("-framerate", f"{fps:g}", "-loop", "1", "-t", f"{ln:.3f}", "-i", str(png))
        fc.append(f"[{idx}:v]format=rgba,fade=t=in:st=0:d=0.25:alpha=1,"
                  f"fade=t=out:st={max(0.0, ln - 0.3):.3f}:d=0.3:alpha=1,setpts=PTS-STARTPTS+{st:.3f}/TB[g{idx}]")
        fc.append(f"[{cur}][g{idx}]overlay={x0}:{y0}:eof_action=pass[o{idx}]")
        cur = f"o{idx}"

    # Captions and styled text, drawn by libass.
    cap = edit.get("captions") or {}
    words = captions.timeline_words(p, clips)
    lay = captions.layout(words, cap, W, H) if cap.get("on") else None
    texts = [o for o in edit.get("overlays", []) if o.get("kind") == "text"]
    ass = p.path("clips", "captions.ass")
    if captions.write_ass(ass, W, H, lay, texts):
        _fonts_for(p)
        fc.append(f"[{cur}]ass=clips/captions.ass:fontsdir=fonts[cap]")
        cur = "cap"

    fmt_opts = edit.get("format") or {}
    tail = []
    if fmt_opts.get("fadeIn"):
        tail.append("fade=t=in:st=0:d=0.6")
    if fmt_opts.get("fadeOut"):
        tail.append(f"fade=t=out:st={max(0.0, total - 0.8):.3f}:d=0.8")
    tail.append("format=yuv420p")
    fc.append(f"[{cur}]{','.join(tail)}[v]")

    # Sound: the voice, plus music and sound effects (ducked under the voice
    # if asked), plus any B-roll sound.
    duck, plain = [], []
    for k, s in enumerate(edit.get("audio", [])):
        a = assets.get(s.get("asset", ""))
        if not a or not Path(a["file"]).exists():
            continue
        st, ln = float(s["start"]), float(s.get("dur", 5))
        if st >= total or ln <= 0.05:
            continue
        ln = min(ln, total - st)
        loop = ["-stream_loop", "-1"] if s.get("loop") else []
        idx = add_input(*loop, "-ss", f"{float(s.get('in', 0)):.3f}", "-t", f"{ln:.3f}", "-i", a["file"])
        f = [f"aresample=48000,aformat=channel_layouts=stereo,volume={float(s.get('volume', 0.6)):.3f}"]
        if float(s.get("fadeIn", 0)) > 0:
            f.append(f"afade=t=in:st=0:d={float(s['fadeIn']):.2f}")
        if float(s.get("fadeOut", 0)) > 0:
            f.append(f"afade=t=out:st={max(0.0, ln - float(s['fadeOut'])):.3f}:d={float(s['fadeOut']):.2f}")
        f.append(f"adelay={int(st * 1000)}:all=1")
        (duck if s.get("duck", True) else plain).append(f"[{idx}:a]" + ",".join(f))
    mix = ["[voice]"]
    if duck:
        fc.append("[0:a]asplit=2[voice][side]")
        for i, chain in enumerate(duck):
            fc.append(f"{chain}[d{i}]")
        if len(duck) > 1:
            fc.append("".join(f"[d{i}]" for i in range(len(duck))) + f"amix=inputs={len(duck)}:normalize=0[dbus]")
        else:
            fc.append("[d0]anull[dbus]")
        fc.append("[dbus][side]sidechaincompress=threshold=0.025:ratio=9:attack=25:release=420:makeup=1[ducked]")
        mix.append("[ducked]")
    else:
        fc.append("[0:a]anull[voice]")
    for i, chain in enumerate(plain + audio_parts):
        fc.append(f"{chain}[x{i}]")
        mix.append(f"[x{i}]")
    if len(mix) > 1:
        fc.append("".join(mix) + f"amix=inputs={len(mix)}:normalize=0:duration=first[mixed]")
        fc.append("[mixed]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[a]")
    else:
        fc.append("[voice]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[a]")

    out_dir = p.folder / "Retake exports"
    out_dir.mkdir(exist_ok=True)
    stamp = time.strftime("%Y-%m-%d %H.%M")
    base = _safe_name(p.data["name"])
    suffix = "" if aspect == "16:9" else f" ({aspect.replace(':', 'x')})"
    out = out_dir / f"{base}{suffix} {stamp}.mp4"
    quality = p.data["output"].get("quality", "high")
    crf = QUALITY.get(quality, 16)
    script = p.path("clips", "final.filter")
    script.write_text(";\n".join(fc), encoding="utf-8")
    cmd += ["-/filter_complex", str(script.relative_to(p.dir)).replace("\\", "/"), "-map", "[v]", "-map", "[a]",
            "-t", f"{total:.3f}", "-c:v", "libx264", "-preset", PRESET.get(quality, "fast"), "-crf", str(crf), "-pix_fmt", "yuv420p",
            "-r", f"{fps:g}", "-movflags", "+faststart", "-c:a", "aac", "-b:a", "192k", str(out)]
    media.run_progress(cmd, total, lambda f: on_progress(0.72 + 0.28 * f, "Finishing: captions, graphics and sound"),
                       cwd=p.dir)

    srt = out.with_suffix(".srt")
    srt.write_text(captions.srt(words), encoding="utf-8")
    chapters = chapters_text(clips, edit.get("overlays", []))
    (out.with_suffix(".chapters.txt")).write_text(chapters, encoding="utf-8")
    return {"file": str(out), "srt": str(srt), "duration": round(total, 2), "width": W, "height": H, "fps": fps,
            "created": time.time(), "chapters": chapters}


def chapters_text(clips: list[dict], overlays: list[dict]) -> str:
    rows = [(0.0, "Intro")]
    for o in sorted(overlays, key=lambda o: float(o.get("start", 0))):
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

