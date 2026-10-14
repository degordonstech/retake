"""ffmpeg and ffprobe helpers: probing, audio, proxies, thumbnails, waveforms."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from typing import Callable

import numpy as np

AUDIO_EXT = {".m4a", ".mp3", ".wav", ".aac", ".flac", ".ogg", ".opus", ".wma"}
VIDEO_EXT = {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v", ".mts"}

# On Windows, keep ffmpeg from flashing a console window for every call.
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


class MediaError(RuntimeError):
    pass


def have_ffmpeg() -> bool:
    return bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))


def run(cmd: list[str], *, capture: bool = False) -> bytes:
    r = subprocess.run(cmd, capture_output=True, creationflags=_NO_WINDOW)
    if r.returncode != 0:
        tail = r.stderr.decode("utf-8", "replace")[-1500:]
        raise MediaError(f"{Path(cmd[0]).name} failed: {tail}")
    return r.stdout if capture else b""


def run_progress(cmd: list[str], duration: float, on_progress: Callable[[float], None]) -> None:
    """Run ffmpeg and report 0..1 progress from its -progress output."""
    full = cmd[:1] + ["-progress", "pipe:1", "-nostats"] + cmd[1:]
    p = subprocess.Popen(full, stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=_NO_WINDOW)
    assert p.stdout is not None
    err_chunks: list[bytes] = []
    import threading

    def drain() -> None:
        assert p.stderr is not None
        for chunk in iter(lambda: p.stderr.read(4096), b""):
            err_chunks.append(chunk)
            if len(err_chunks) > 50:
                del err_chunks[:25]

    t = threading.Thread(target=drain, daemon=True)
    t.start()
    for raw in p.stdout:
        line = raw.decode("utf-8", "replace").strip()
        if line.startswith("out_time_us=") and duration > 0:
            try:
                on_progress(min(1.0, int(line.split("=")[1]) / 1e6 / duration))
            except ValueError:
                pass
    p.wait()
    t.join(timeout=2)
    if p.returncode != 0:
        tail = b"".join(err_chunks).decode("utf-8", "replace")[-1500:]
        raise MediaError(f"ffmpeg failed: {tail}")
    on_progress(1.0)


def probe(path: Path) -> dict:
    out = run(["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)],
              capture=True)
    data = json.loads(out or b"{}")
    v = next((s for s in data.get("streams", []) if s.get("codec_type") == "video"
              and s.get("disposition", {}).get("attached_pic") != 1), None)
    a = next((s for s in data.get("streams", []) if s.get("codec_type") == "audio"), None)
    fps = 0.0
    if v:
        def rate(key: str) -> float:
            num, _, den = (v.get(key) or "0/1").partition("/")
            try:
                return float(num) / float(den or 1)
            except (ValueError, ZeroDivisionError):
                return 0.0

        # Screen recorders skip frames when nothing moves, so the average
        # undersells them; the nominal rate is the real one.
        avg, nominal = rate("avg_frame_rate"), rate("r_frame_rate")
        fps = nominal if 0 < nominal <= 120 and nominal >= avg else (avg or nominal)
    width, height = (int(v.get("width", 0)), int(v.get("height", 0))) if v else (0, 0)
    rotate = 0
    if v:
        for sd in v.get("side_data_list", []) or []:
            if "rotation" in sd:
                rotate = int(sd["rotation"])
        rotate = int((v.get("tags") or {}).get("rotate", rotate) or rotate)
    if abs(rotate) in (90, 270):
        width, height = height, width
    return {
        "duration": float(data.get("format", {}).get("duration") or 0),
        "has_video": v is not None,
        "has_audio": a is not None,
        "width": width,
        "height": height,
        "fps": round(fps, 3),
        "vcodec": v.get("codec_name") if v else None,
        "pix_fmt": v.get("pix_fmt") if v else None,
        "color_range": v.get("color_range") if v else None,
        "color_transfer": v.get("color_transfer") if v else None,
        "size": int(data.get("format", {}).get("size") or 0),
    }


def load_audio(path: Path, rate: int = 16000) -> np.ndarray:
    raw = run(["ffmpeg", "-v", "error", "-i", str(path), "-vn", "-ac", "1", "-ar", str(rate), "-f", "s16le", "-"],
              capture=True)
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32)


HOP_S = 0.01  # 10 ms analysis frames everywhere


def level_db(x: np.ndarray, rate: int = 16000) -> np.ndarray:
    hop = int(rate * HOP_S)
    n = len(x) // hop
    if n == 0:
        return np.zeros(0, dtype=np.float32)
    return (20 * np.log10(np.sqrt((x[: n * hop].reshape(n, hop) ** 2).mean(axis=1)) + 1e-3)).astype(np.float32)


def envelope(x: np.ndarray, rate: int = 16000) -> np.ndarray:
    """Loudness pattern with slow level changes removed, for matching two recordings."""
    db = level_db(x, rate)
    if len(db) == 0:
        return db
    e = db - np.convolve(db, np.ones(200) / 200, mode="same")
    return ((e - e.mean()) / (e.std() + 1e-9)).astype(np.float32)


def silences(db: np.ndarray, min_len: float = 0.3) -> list[tuple[float, float]]:
    """Quiet stretches, judged against the recording's own room noise."""
    if len(db) == 0:
        return []
    floor = float(np.percentile(db, 20)) + 8
    quiet = db < floor
    out: list[tuple[float, float]] = []
    i, n = 0, len(quiet)
    while i < n:
        if quiet[i]:
            j = i
            while j < n and quiet[j]:
                j += 1
            if (j - i) * HOP_S >= min_len:
                out.append((round(i * HOP_S, 2), round(j * HOP_S, 2)))
            i = j
        else:
            i += 1
    return out


def waveform_peaks(db: np.ndarray, per_second: int = 50) -> list[int]:
    """0..100 loudness per bucket for drawing a waveform."""
    step = max(1, int(1 / HOP_S / per_second))
    n = len(db) // step
    if n == 0:
        return []
    b = db[: n * step].reshape(n, step).max(axis=1)
    lo, hi = float(np.percentile(b, 5)), float(np.percentile(b, 99.5))
    return [int(v) for v in np.clip((b - lo) / max(hi - lo, 1e-6) * 100, 0, 100)]


def make_proxy(src: Path, dst: Path, duration: float, has_video: bool, on_progress: Callable[[float], None]) -> None:
    """Small H.264/AAC copy that every webview can play, for the editor preview."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_name(dst.stem + ".part" + dst.suffix)
    if has_video:
        cmd = ["ffmpeg", "-y", "-v", "error", "-i", str(src),
               "-vf", "scale=-2:540:flags=bilinear,format=yuv420p", "-r", "30",
               "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28", "-g", "15",
               "-c:a", "aac", "-b:a", "96k", "-ac", "2", "-movflags", "+faststart", str(tmp)]
    else:
        cmd = ["ffmpeg", "-y", "-v", "error", "-i", str(src), "-vn", "-c:a", "aac", "-b:a", "96k", "-ac", "2",
               "-movflags", "+faststart", str(tmp)]
    run_progress(cmd, duration, on_progress)
    tmp.replace(dst)


def make_thumbs(src: Path, dst: Path, duration: float, every: float = 2.0, height: int = 72) -> dict:
    """One sprite sheet of small frames, `every` seconds apart, for timeline clips."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    count = max(1, int(duration / every) + 1)
    cols = 20
    rows = (count + cols - 1) // cols
    run(["ffmpeg", "-y", "-v", "error", "-i", str(src),
         "-vf", f"fps=1/{every},scale=-2:{height},tile={cols}x{rows}",
         "-frames:v", "1", "-q:v", "6", str(dst)])
    return {"every": every, "cols": cols, "rows": rows, "height": height, "count": count}


def frame_at(src: Path, t: float, width: int = 0) -> bytes:
    vf = ["-vf", f"scale={width}:-2"] if width else []
    return run(["ffmpeg", "-v", "error", "-ss", f"{max(0.0, t):.3f}", "-i", str(src), "-frames:v", "1", *vf,
                "-f", "image2", "-c:v", "mjpeg", "-q:v", "3", "-"], capture=True)


PREROLL = 20.0


def window_input(src: Path, start: float, dur: float) -> list[str]:
    """Input args for a stretch of video, decoding from a little earlier.

    Screen recordings only store a frame when something changes. Seeking
    straight to `start` drops the last frame before it, which is the one on
    screen at `start` if nothing moved for a while. So decoding starts up to
    PREROLL seconds early; `window_filter` then trims back to `start`."""
    start = max(0.0, start)
    s0 = max(0.0, start - PREROLL)
    return ["-ss", f"{s0:.3f}", "-t", f"{dur + (start - s0):.3f}", "-i", str(src)]


def window_filter(start: float, dur: float, fps: float) -> str:
    start = max(0.0, start)
    pre = start - max(0.0, start - PREROLL)
    return (f"fps={fps:g}:start_time=0,trim=start={pre:.3f}:duration={dur:.3f},setpts=PTS-STARTPTS")


def decode_frames(src: Path, start: float, dur: float, fps: float, size: tuple[int, int],
                  crop: tuple[int, int, int, int] | None = None):
    """Yield (time, RGB frame) decoded exactly the way the renderer cuts."""
    w, h = size
    vf = window_filter(start, dur, fps)
    if crop:
        cw, ch, cx, cy = crop
        vf += f",crop={cw}:{ch}:{cx}:{cy}"
        w, h = cw, ch
    cmd = ["ffmpeg", "-v", "error", *window_input(src, start, dur), "-vf", vf,
           "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, creationflags=_NO_WINDOW,
                         bufsize=w * h * 3 * 2)
    assert p.stdout is not None
    size = w * h * 3
    k = 0
    try:
        while True:
            buf = p.stdout.read(size)
            if len(buf) < size:
                break
            yield start + k / fps, np.frombuffer(buf, np.uint8).reshape(h, w, 3)
            k += 1
    finally:
        p.stdout.close()
        p.kill()
        p.wait()
