"""A Retake project: a folder of recordings plus the edit made from them.

Everything Retake makes lives in `<folder>/.retake/`, so the recordings
themselves are never touched and a project can be moved with its folder.

Terms used throughout:
  source  one media file in the folder
  take    one piece of narration and the picture that goes with it:
          a voice (an audio track, from any file) plus, optionally, a video
          from another file at a time offset. A face-cam recording is a take
          whose voice and video are the same file.
  clip    a stretch of one take, placed on the timeline. Clip times are in
          the take's VOICE time; the video plays at voice time + offset.
"""

from __future__ import annotations

import json
import os
import secrets
import threading
import time
from pathlib import Path
from typing import Any

from . import config
from .media import AUDIO_EXT, VIDEO_EXT, probe

DATA_DIR = ".retake"

_locks: dict[str, threading.RLock] = {}


def _lock_for(folder: str) -> threading.RLock:
    return _locks.setdefault(folder, threading.RLock())


def new_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(4)}"


class Project:
    def __init__(self, folder: Path, data: dict[str, Any]):
        self.folder = folder
        self.data = data

    # ---------------------------------------------------------------- paths --
    @property
    def dir(self) -> Path:
        return self.folder / DATA_DIR

    @property
    def id(self) -> str:
        return self.data["id"]

    def path(self, *parts: str) -> Path:
        p = self.dir.joinpath(*parts)
        p.parent.mkdir(parents=True, exist_ok=True)
        return p

    def source(self, sid: str) -> dict[str, Any]:
        for s in self.data["sources"]:
            if s["id"] == sid:
                return s
        raise KeyError(sid)

    def source_path(self, sid: str) -> Path:
        return self.folder / self.source(sid)["file"]

    def take(self, tid: str) -> dict[str, Any]:
        for t in self.data["takes"]:
            if t["id"] == tid:
                return t
        raise KeyError(tid)

    # ------------------------------------------------------------- storage --
    def save(self) -> None:
        with _lock_for(str(self.folder)):
            self.data["updated"] = time.time()
            f = self.path("project.json")
            tmp = f.with_suffix(".tmp")
            tmp.write_text(json.dumps(self.data, indent=1), encoding="utf-8")
            tmp.replace(f)
        config.remember_project(self.summary())

    def summary(self) -> dict[str, Any]:
        d = self.data
        return {
            "id": d["id"],
            "name": d["name"],
            "folder": str(self.folder),
            "updated": d.get("updated", d.get("created")),
            "stage": d.get("stage", "new"),
            "duration": round(sum(clip_dur(c) for c in d.get("edit", {}).get("clips", [])), 2),
            "sources": len(d.get("sources", [])),
        }

    def read_json(self, *parts: str, default: Any = None) -> Any:
        try:
            return json.loads(self.dir.joinpath(*parts).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return default

    def write_json(self, data: Any, *parts: str) -> None:
        f = self.path(*parts)
        tmp = f.with_suffix(".tmp")
        tmp.write_text(json.dumps(data), encoding="utf-8")
        tmp.replace(f)


# ------------------------------------------------------------------ open ----
def load(folder: str | Path) -> Project:
    folder = Path(folder)
    f = folder / DATA_DIR / "project.json"
    with _lock_for(str(folder)):
        data = json.loads(f.read_text(encoding="utf-8"))
    return Project(folder, data)


def commit(p: Project, fn) -> None:
    """Apply `fn` to the latest saved data and save it. Jobs run for minutes;
    this way edits made in the window meanwhile are never overwritten."""
    with _lock_for(str(p.folder)):
        fresh = load(p.folder)
        fn(fresh.data)
        fresh.save()
        p.data = fresh.data


def by_id(project_id: str) -> Project:
    for p in config.list_projects():
        if p["id"] == project_id:
            return load(p["folder"])
    raise KeyError(project_id)


def create(folder: str | Path, name: str | None = None) -> Project:
    folder = Path(folder).resolve()
    if not folder.is_dir():
        raise ValueError("That folder doesn't exist.")
    existing = folder / DATA_DIR / "project.json"
    if existing.exists():
        p = load(folder)
        config.remember_project(p.summary())
        return p
    files = sorted(f for f in folder.iterdir()
                   if f.is_file() and f.suffix.lower() in AUDIO_EXT | VIDEO_EXT and not f.name.startswith("."))
    if not files:
        raise ValueError("No video or audio files in that folder.")
    sources = []
    for f in files:
        info = probe(f)
        if info["duration"] <= 0.5:
            continue
        sources.append({"id": new_id("src"), "file": f.name, **info, "role": guess_role(f, info)})
    data = {
        "id": new_id("prj"),
        "name": name or folder.name,
        "created": time.time(),
        "stage": "sources",
        "sources": sources,
        "takes": [],
        "edit": {"clips": [], "overlays": [], "media": [], "audio": []},
        "privacy": {"detections": [], "manual": [], "allowed": []},
        "brain": {},
        "output": {"fps": 0, "quality": "high", "captions": False},
        "renders": [],
        "assets": [],
    }
    p = Project(folder, data)
    p.data["takes"] = guess_takes(p.data["sources"])
    p.save()
    return p


def create_from_files(paths: list[str], name: str | None = None) -> Project:
    """A project made from files anywhere on the computer. The files stay
    where they are; a project folder is made in Documents/Retake Projects."""
    files = []
    for raw in paths:
        f = Path(raw.strip().strip('"'))
        if f.is_file() and f.suffix.lower() in AUDIO_EXT | VIDEO_EXT:
            files.append(f.resolve())
    if not files:
        raise ValueError("Drop video or audio files (mp4, mov, mkv, mp3, wav and so on).")
    base = Path(os.environ.get("RETAKE_PROJECTS") or Path.home() / "Documents" / "Retake Projects")
    title = (name or files[0].stem).strip() or "New video"
    stamp = time.strftime("%d %b %Y")
    folder = base / f"{title} {stamp}"
    n = 2
    while (folder / DATA_DIR / "project.json").exists():
        folder = base / f"{title} {stamp} ({n})"
        n += 1
    folder.mkdir(parents=True, exist_ok=True)
    sources = []
    for f in files:
        info = probe(f)
        if info["duration"] <= 0.1:
            continue
        sources.append({"id": new_id("src"), "file": str(f), **info, "role": guess_role(f, info)})
    if not sources:
        raise ValueError("Those files have no video or sound Retake can read.")
    data = {
        "id": new_id("prj"), "name": title, "created": time.time(), "stage": "sources", "sources": sources,
        "takes": [], "edit": {"clips": [], "overlays": [], "media": [], "audio": []},
        "privacy": {"detections": [], "manual": [], "allowed": []}, "brain": {},
        "output": {"fps": 0, "quality": "high", "captions": False}, "renders": [], "assets": [],
    }
    p = Project(folder, data)
    p.data["takes"] = guess_takes(p.data["sources"])
    p.save()
    return p


# ------------------------------------------------------------- guessing ----
def guess_role(f: Path, info: dict) -> str:
    """screen | voice | camera | skip. The user can change any of these."""
    name = f.name.lower()
    if "edit" in name or "retake" in name or "export" in name:
        return "skip"  # likely a previous render sitting in the folder
    if not info["has_video"]:
        return "voice" if info["has_audio"] else "skip"
    portrait = info["height"] > info["width"]
    phone_codec = (info.get("vcodec") in ("hevc", "h265")) or f.suffix.lower() == ".mov"
    if portrait or phone_codec or "face" in name or "cam" in name or name.startswith("img_"):
        return "camera"
    return "screen"


def guess_takes(sources: list[dict]) -> list[dict]:
    """Pair each screen recording with a separate voice track, in file order;
    screens with no voice partner use their own audio; cameras stand alone."""
    voices = [s for s in sources if s["role"] == "voice"]
    screens = [s for s in sources if s["role"] == "screen"]
    takes: list[dict] = []
    used: set[str] = set()
    for scr in screens:
        # The voice whose length is closest, among those not yet used, in order.
        best = None
        for v in voices:
            if v["id"] in used:
                continue
            diff = abs(v["duration"] - scr["duration"]) / max(scr["duration"], 1)
            if diff < 0.25 and (best is None or diff < best[0]):
                best = (diff, v)
        if best:
            used.add(best[1]["id"])
            takes.append(_take(best[1], scr))
        elif scr["has_audio"]:
            takes.append(_take(scr, scr))
    for v in voices:
        if v["id"] not in used:
            takes.append(_take(v, None))
    for cam in (s for s in sources if s["role"] == "camera"):
        takes.append(_take(cam, cam))
    order = {s["id"]: i for i, s in enumerate(sources)}
    takes.sort(key=lambda t: order.get(t["video"] or t["voice"], 0))
    return takes


def _take(voice: dict, video: dict | None) -> dict:
    kind = "camera" if video and video["role"] == "camera" else ("screen" if video else "audio")
    return {
        "id": new_id("tk"),
        "name": Path((video or voice)["file"]).stem,
        "kind": kind,
        "voice": voice["id"],
        "video": video["id"] if video else None,
        "duration": voice["duration"],
        # Video time = voice time + offset. A list of [voice_time, offset]
        # steps, because recorders paused separately drift apart in jumps.
        "offsets": [[0.0, 0.0]],
        "sync_score": None,
        "ready": False,
    }


def clip_dur(c: dict) -> float:
    """Length of a timeline clip on the timeline: a stretch of a take (shorter
    when sped up), or a title card."""
    if c.get("kind") == "title":
        return float(c.get("dur", 3))
    return (c["b"] - c["a"]) / clip_speed(c)


def clip_speed(c: dict) -> float:
    return min(4.0, max(0.25, float(c.get("speed") or 1.0)))


def offset_at(take: dict, t: float) -> float:
    off = take["offsets"][0][1] if take["offsets"] else 0.0
    for at, o in take["offsets"]:
        if at <= t:
            off = o
        else:
            break
    return off
