"""The local API the Retake window talks to. Listens on 127.0.0.1 only."""

from __future__ import annotations

import io
import mimetypes
import os
import re
import subprocess
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import __version__, config, graphics, jobs, media, project
from .brain import claude_code
from .project import Project, guess_takes, new_id

app = FastAPI(title="Retake", version=__version__)
WEB = Path(__file__).parent.parent / "web" / "dist"

# Set by main.py when running inside the desktop window.
window_api: dict[str, Any] = {"pick_folder": None}


def _project(pid: str) -> Project:
    try:
        return project.by_id(pid)
    except (KeyError, OSError, ValueError):
        raise HTTPException(404, "Project not found. Was its folder moved or deleted?")


def _full(p: Project) -> dict:
    d = dict(p.data)
    d["folder"] = str(p.folder)
    for s in d["sources"]:
        s["proxy"] = bool(s.get("native")) or (p.dir / "proxy" / f"{s['id']}.mp4").exists()
    return d


# ---------------------------------------------------------------- basics ----
@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "version": __version__, "ffmpeg": media.have_ffmpeg(), "window": bool(window_api["pick_folder"])}


@app.get("/api/settings")
def get_settings() -> dict:
    return config.public_settings()


@app.post("/api/settings")
def set_settings(changes: dict) -> dict:
    return config.save_settings(changes)


class Key(BaseModel):
    key: str


@app.post("/api/settings/clear-secret")
def clear_secret(body: Key) -> dict:
    config.clear_secret(body.key)
    return config.public_settings()


@app.get("/api/brain/status")
def brain_status() -> dict:
    s = config.load_settings()
    return {
        "claude_code": claude_code.status(s),
        "anthropic": {"ok": bool(s.get("anthropic_key")), "message": "Key saved" if s.get("anthropic_key") else "No key yet"},
        "groq": {"ok": bool(s.get("groq_key")), "message": "Key saved" if s.get("groq_key") else "No key yet"},
        "none": {"ok": True, "message": "Always available"},
    }


@app.post("/api/pick-folder")
def pick_folder() -> dict:
    fn = window_api["pick_folder"]
    if not fn:
        raise HTTPException(400, "Folder picker needs the desktop window. Paste the folder path instead.")
    return {"folder": fn()}


# -------------------------------------------------------------- projects ----
@app.get("/api/projects")
def list_projects() -> list:
    out, seen = [], set()
    for item in config.list_projects():
        item = dict(item)
        f = Path(item["folder"]) / ".retake" / "project.json"
        item["missing"] = not f.exists()
        if not item["missing"]:
            try:
                import json as _json

                real = _json.loads(f.read_text(encoding="utf-8")).get("id")
            except (OSError, ValueError):
                real = None
            # The folder now holds a different project (it was reset): drop the old entry.
            if real and real != item["id"]:
                config.forget_project(item["id"])
                continue
        if item["folder"].lower() in seen:
            continue
        seen.add(item["folder"].lower())
        out.append(item)
    return out


class NewProject(BaseModel):
    folder: str
    name: str | None = None


@app.post("/api/projects")
def create_project(body: NewProject) -> dict:
    folder = body.folder.strip().strip('"')
    try:
        p = project.create(folder, body.name)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return _full(p)


@app.delete("/api/projects/{pid}")
def forget_project(pid: str) -> dict:
    config.forget_project(pid)
    return {"ok": True}


@app.get("/api/projects/{pid}")
def get_project(pid: str) -> dict:
    return _full(_project(pid))


class Rename(BaseModel):
    name: str


@app.post("/api/projects/{pid}/rename")
def rename(pid: str, body: Rename) -> dict:
    p = _project(pid)
    p.data["name"] = body.name.strip() or p.data["name"]
    p.save()
    return _full(p)


class SourceRole(BaseModel):
    role: str


@app.post("/api/projects/{pid}/sources/{sid}")
def set_role(pid: str, sid: str, body: SourceRole) -> dict:
    if body.role not in ("screen", "voice", "camera", "skip"):
        raise HTTPException(400, "Unknown role")
    p = _project(pid)
    p.source(sid)["role"] = body.role
    _retake(p)
    return _full(p)


class Pairing(BaseModel):
    takes: list[dict]


@app.post("/api/projects/{pid}/takes")
def set_takes(pid: str, body: Pairing) -> dict:
    """Reorder takes, or pair a voice with a different screen recording."""
    p = _project(pid)
    old = {t["id"]: t for t in p.data["takes"]}
    ids = {s["id"] for s in p.data["sources"]}
    out = []
    for t in body.takes:
        if t.get("voice") not in ids or (t.get("video") and t["video"] not in ids):
            continue
        prev = old.get(t.get("id", ""))
        if prev and prev["voice"] == t["voice"] and prev["video"] == t.get("video"):
            out.append(prev)
            continue
        voice = p.source(t["voice"])
        video = p.source(t["video"]) if t.get("video") else None
        from .project import _take

        out.append(_take(voice, video))
    p.data["takes"] = out
    p.save()
    return _full(p)


def _retake(p: Project) -> None:
    """Rebuild the voice/picture pairs after roles change, keeping finished work."""
    old = {(t["voice"], t["video"]): t for t in p.data["takes"]}
    new = []
    for t in guess_takes([s for s in p.data["sources"] if s["role"] != "skip"]):
        new.append(old.get((t["voice"], t["video"]), t))
    p.data["takes"] = new
    p.save()


@app.get("/api/projects/{pid}/takes/{tid}")
def get_take(pid: str, tid: str) -> dict:
    p = _project(pid)
    data = p.read_json("takes", f"{tid}.json")
    if not data:
        raise HTTPException(404, "Not transcribed yet")
    return data


class EditBody(BaseModel):
    clips: list[dict]
    overlays: list[dict]


@app.put("/api/projects/{pid}/edit")
def save_edit(pid: str, body: EditBody) -> dict:
    p = _project(pid)
    clean_clips = []
    for c in body.clips:
        if c.get("kind") == "title":
            clean_clips.append({"id": c.get("id") or new_id("c"), "kind": "title", "text": str(c.get("text", "")),
                                "sub": str(c.get("sub", "")), "tag": str(c.get("tag", "")),
                                "dur": max(0.5, float(c.get("dur", 3)))})
            continue
        try:
            take = p.take(c["take"])
        except KeyError:
            continue
        a, b = max(0.0, float(c["a"])), min(float(c["b"]), take["duration"])
        if b - a > 0.04:
            clean_clips.append({"id": c.get("id") or new_id("c"), "take": c["take"], "a": round(a, 3), "b": round(b, 3)})
    p.data["edit"] = {"clips": clean_clips, "overlays": body.overlays}
    p.save()
    return {"ok": True, "updated": p.data["updated"]}


class Output(BaseModel):
    fps: float | None = None
    quality: str | None = None


@app.put("/api/projects/{pid}/output")
def save_output(pid: str, body: Output) -> dict:
    p = _project(pid)
    if body.fps is not None:
        p.data["output"]["fps"] = body.fps
    if body.quality in ("high", "standard", "small"):
        p.data["output"]["quality"] = body.quality
    p.save()
    from .render import output_format

    W, H, fps = output_format(p)
    return {**p.data["output"], "auto": {"width": W, "height": H, "fps": fps}}


@app.get("/api/projects/{pid}/output")
def get_output(pid: str) -> dict:
    p = _project(pid)
    from .render import output_format

    W, H, fps = output_format(p)
    return {**p.data["output"], "auto": {"width": W, "height": H, "fps": fps}}


# ------------------------------------------------------------------ jobs ----
@app.post("/api/projects/{pid}/jobs/{kind}")
def start_job(pid: str, kind: str, args: dict | None = None) -> dict:
    if kind not in jobs.RUNNERS:
        raise HTTPException(400, "Unknown job")
    _project(pid)
    return jobs.start(pid, kind, args or {})


@app.get("/api/projects/{pid}/job")
def job_status(pid: str) -> dict:
    return jobs.status(pid) or {"status": "idle"}


# --------------------------------------------------------------- privacy ----
@app.get("/api/projects/{pid}/privacy")
def get_privacy(pid: str) -> dict:
    p = _project(pid)
    return {**p.data["privacy"], "detections": p.read_json("privacy", "detections.json", default=[]) or []}


class Toggle(BaseModel):
    key: str
    on: bool


@app.post("/api/projects/{pid}/privacy/dismiss")
def dismiss(pid: str, body: Toggle) -> dict:
    p = _project(pid)
    cur = set(p.data["privacy"].get("dismissed", []))
    (cur.add if body.on else cur.discard)(body.key)
    p.data["privacy"]["dismissed"] = sorted(cur)
    p.save()
    return get_privacy(pid)


class Manual(BaseModel):
    src: str
    t0: float
    t1: float
    box: list[int]


@app.post("/api/projects/{pid}/privacy/manual")
def add_manual(pid: str, body: Manual) -> dict:
    p = _project(pid)
    p.data["privacy"].setdefault("manual", []).append({"id": new_id("m"), **body.model_dump()})
    p.save()
    return get_privacy(pid)


@app.delete("/api/projects/{pid}/privacy/manual/{mid}")
def del_manual(pid: str, mid: str) -> dict:
    p = _project(pid)
    p.data["privacy"]["manual"] = [m for m in p.data["privacy"].get("manual", []) if m["id"] != mid]
    p.save()
    return get_privacy(pid)


@app.get("/api/projects/{pid}/frame")
def frame(pid: str, src: str, t: float, w: int = 0) -> Response:
    p = _project(pid)
    try:
        data = media.frame_at(p.source_path(src), t, w)
    except (KeyError, media.MediaError) as e:
        raise HTTPException(404, str(e)[:200])
    return Response(data, media_type="image/jpeg", headers={"Cache-Control": "max-age=3600"})


@app.get("/api/projects/{pid}/overlay.png")
def overlay_png(pid: str, kind: str = "label", text: str = "", sub: str = "", tag: str = "",
                w: int = 1280, h: int = 720) -> Response:
    brand = config.load_settings()["brand"]
    if kind == "title":
        img = graphics.title_card(text, sub, tag, brand, w, h)
    else:
        img = graphics.render_overlay({"kind": kind, "text": text, "sub": sub, "tag": tag}, brand, w, h)
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return Response(buf.getvalue(), media_type="image/png")


@app.post("/api/projects/{pid}/open-exports")
def open_exports(pid: str) -> dict:
    p = _project(pid)
    folder = p.folder / "Retake exports"
    folder.mkdir(exist_ok=True)
    _reveal(folder)
    return {"ok": True}


class Reveal(BaseModel):
    path: str


@app.post("/api/reveal")
def reveal(body: Reveal) -> dict:
    path = Path(body.path)
    if not path.exists():
        raise HTTPException(404, "File not found")
    _reveal(path)
    return {"ok": True}


def _reveal(path: Path) -> None:
    if os.name == "nt":
        if path.is_file():
            subprocess.Popen(["explorer", "/select,", str(path)])
        else:
            os.startfile(str(path))  # type: ignore[attr-defined]
    else:
        subprocess.Popen(["open" if os.uname().sysname == "Darwin" else "xdg-open", str(path)])


# ----------------------------------------------------------------- media ----
def _ranged(path: Path, request: Request) -> Response:
    """Serve a file with HTTP range support, so the editor can seek video."""
    if not path.exists():
        raise HTTPException(404)
    size = path.stat().st_size
    ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    rng = request.headers.get("range")
    if not rng:
        return FileResponse(path, media_type=ctype, headers={"Accept-Ranges": "bytes"})
    m = re.match(r"bytes=(\d*)-(\d*)", rng)
    start = int(m.group(1)) if m and m.group(1) else 0
    end = int(m.group(2)) if m and m.group(2) else size - 1
    end = min(end, size - 1, start + 8 * 1024 * 1024 - 1)
    if start > end:
        return Response(status_code=416, headers={"Content-Range": f"bytes */{size}"})

    def chunks():
        with open(path, "rb") as f:
            f.seek(start)
            left = end - start + 1
            while left > 0:
                buf = f.read(min(256 * 1024, left))
                if not buf:
                    break
                left -= len(buf)
                yield buf

    return StreamingResponse(chunks(), status_code=206, media_type=ctype, headers={
        "Content-Range": f"bytes {start}-{end}/{size}", "Accept-Ranges": "bytes",
        "Content-Length": str(end - start + 1)})


@app.get("/media/{pid}/proxy/{sid}.mp4")
def proxy_file(pid: str, sid: str, request: Request) -> Response:
    """The preview copy, or the original when the window can play it as it is."""
    p = _project(pid)
    proxy = p.dir / "proxy" / f"{sid}.mp4"
    if proxy.exists():
        return _ranged(proxy, request)
    try:
        src = p.source(sid)
    except KeyError:
        raise HTTPException(404)
    path = p.source_path(sid)
    if src.get("native") or media.plays_natively(path, src):
        return _ranged(path, request)
    raise HTTPException(404, "No preview copy yet")


@app.get("/media/{pid}/thumbs/{sid}.jpg")
def thumbs_file(pid: str, sid: str) -> Response:
    p = _project(pid)
    f = p.dir / "thumbs" / f"{sid}.jpg"
    if not f.exists():
        raise HTTPException(404)
    return FileResponse(f, media_type="image/jpeg")


@app.get("/media/{pid}/render/{index}")
def render_file(pid: str, index: int, request: Request) -> Response:
    p = _project(pid)
    try:
        return _ranged(Path(p.data["renders"][index]["file"]), request)
    except IndexError:
        raise HTTPException(404)


@app.exception_handler(media.MediaError)
def media_error(_: Request, exc: media.MediaError) -> JSONResponse:
    return JSONResponse({"detail": str(exc)[:400]}, status_code=500)


# ------------------------------------------------------------------ web -----
if WEB.exists():
    app.mount("/assets", StaticFiles(directory=WEB / "assets"), name="assets")

    @app.get("/{path:path}")
    def spa(path: str) -> Response:
        f = WEB / path
        if path and f.is_file():
            return FileResponse(f)
        return FileResponse(WEB / "index.html")
