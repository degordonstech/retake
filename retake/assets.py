"""Media brought into a project from anywhere: B-roll, pictures, music, sound effects.

Files stay where they are; the project keeps their path. Video the window
can't play as it is gets a small preview copy, made in the background.
"""

from __future__ import annotations

import threading
from pathlib import Path

from . import media
from .project import Project, commit, new_id

IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}

_busy: set[str] = set()


def kind_of(path: Path) -> str | None:
    ext = path.suffix.lower()
    if ext in IMAGE_EXT:
        return "image"
    if ext in media.VIDEO_EXT:
        return "video"
    if ext in media.AUDIO_EXT:
        return "audio"
    return None


def add(p: Project, paths: list[str]) -> list[dict]:
    """Add files to the project's media. Returns the new entries."""
    have = {a["file"].lower() for a in p.data.get("assets", [])}
    added: list[dict] = []
    for raw in paths:
        f = Path(raw.strip().strip('"'))
        kind = kind_of(f)
        if not kind or not f.is_file() or str(f).lower() in have:
            continue
        entry = {"id": new_id("a"), "file": str(f), "name": f.stem, "kind": kind, "size": f.stat().st_size}
        if kind == "image":
            from PIL import Image

            try:
                with Image.open(f) as im:
                    entry.update(width=im.width, height=im.height, duration=0.0)
            except OSError:
                continue
        else:
            try:
                info = media.probe(f)
            except media.MediaError:
                continue
            entry.update(width=info.get("width") or 0, height=info.get("height") or 0, duration=info["duration"],
                         has_audio=info["has_audio"], has_video=info["has_video"])
            if kind == "video" and not info["has_video"]:
                entry["kind"] = kind = "audio"
            entry["native"] = media.plays_natively(f, info)
        added.append(entry)
        have.add(str(f).lower())
    if added:
        commit(p, lambda d: d.setdefault("assets", []).extend(added))
        for a in added:
            if a["kind"] == "video" and not a.get("native"):
                _proxy_later(p, a)
    return added


def remove(p: Project, aid: str) -> None:
    def drop(d: dict) -> None:
        d["assets"] = [a for a in d.get("assets", []) if a["id"] != aid]
        ed = d.get("edit", {})
        ed["media"] = [m for m in ed.get("media", []) if m.get("asset") != aid]
        ed["audio"] = [m for m in ed.get("audio", []) if m.get("asset") != aid]

    commit(p, drop)


def preview_path(p: Project, a: dict) -> Path | None:
    """What the window plays for this item: the file, or its preview copy."""
    if a["kind"] != "video" or a.get("native"):
        return Path(a["file"])
    proxy = p.dir / "proxy" / f"{a['id']}.mp4"
    return proxy if proxy.exists() else None


def _proxy_later(p: Project, a: dict) -> None:
    if a["id"] in _busy:
        return
    _busy.add(a["id"])

    def work() -> None:
        try:
            media.make_proxy(Path(a["file"]), p.dir / "proxy" / f"{a['id']}.mp4", a.get("duration") or 1,
                             True, lambda f: None)
        except media.MediaError:
            pass
        finally:
            _busy.discard(a["id"])

    threading.Thread(target=work, daemon=True, name=f"proxy-{a['id']}").start()


def ensure_proxies(p: Project) -> None:
    for a in p.data.get("assets", []):
        if a["kind"] == "video" and not a.get("native") and not (p.dir / "proxy" / f"{a['id']}.mp4").exists():
            _proxy_later(p, a)
