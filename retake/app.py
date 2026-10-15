"""The local API the Retake window talks to. Listens on 127.0.0.1 only."""

from __future__ import annotations

import io
import mimetypes
import os
import re
import subprocess
import time
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import __version__, assets, captions, config, graphics, jobs, looks, media, project
from .brain import claude_code
from .project import Project, guess_takes, new_id

app = FastAPI(title="Retake", version=__version__)
WEB = Path(__file__).parent.parent / "web" / "dist"

# Set by main.py when running inside the desktop window.
window_api: dict[str, Any] = {"pick_folder": None, "pick_files": None, "focus": None, "seen": 0.0}


@app.middleware("http")
async def _seen(request, call_next):
    # The launcher watches this to tell a loaded window from a blank one.
    window_api["seen"] = time.time()
    return await call_next(request)


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
    d["assets"] = [{**a, "ready": assets.preview_path(p, a) is not None, "missing": not Path(a["file"]).exists()}
                   for a in d.get("assets", [])]
    ed = d.setdefault("edit", {})
    for k in ("overlays", "media", "audio"):
        ed.setdefault(k, [])
    return d


# ---------------------------------------------------------------- basics ----
@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "version": __version__, "ffmpeg": media.have_ffmpeg(), "window": bool(window_api["pick_folder"])}


@app.post("/api/focus")
def focus() -> dict:
    """A second launch asks the running app to come to the front."""
    fn = window_api["focus"]
    if fn:
        fn()
    return {"ok": bool(fn)}


@app.get("/api/looks")
def get_looks() -> dict:
    return looks.all_looks()


@app.get("/fonts/{name}")
def font_file(name: str) -> Response:
    f = captions.FONT_DIR / Path(name).name
    if not f.is_file():
        raise HTTPException(404)
    return FileResponse(f, media_type="font/ttf", headers={"Cache-Control": "max-age=86400"})


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


class FromFiles(BaseModel):
    paths: list[str]
    name: str | None = None
    mode: str = "edit"  # "edit": straight to the timeline; "ai": prepare for a first cut


@app.post("/api/projects/from-files")
def create_from_files(body: FromFiles) -> dict:
    try:
        p = project.create_from_files(body.paths, body.name)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if body.mode == "edit":
        jobs.start(p.id, "quickstart", {})
    return _full(p)


@app.post("/api/pick-files")
def pick_files_any() -> dict:
    fn = window_api["pick_files"]
    if not fn:
        raise HTTPException(400, "Choosing files needs the desktop window. Drag files in instead.")
    return {"paths": list(fn() or [])}


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


class Nudge(BaseModel):
    delta: float


@app.post("/api/projects/{pid}/takes/{tid}/nudge")
def nudge_take(pid: str, tid: str, body: Nudge) -> dict:
    """Shift the picture of a take against its voice (positive = picture later)."""
    p = _project(pid)
    try:
        t = p.take(tid)
    except KeyError:
        raise HTTPException(404, "Take not found")
    if not t["video"] or t["video"] == t["voice"]:
        raise HTTPException(400, "This take's picture and sound come from the same file.")
    d = max(-5.0, min(5.0, body.delta))
    t["offsets"] = [[at, round(o - d, 3)] for at, o in t["offsets"]]
    p.save()
    return _full(p)


class EditBody(BaseModel):
    clips: list[dict]
    overlays: list[dict]
    media: list[dict] = []
    audio: list[dict] = []
    captions: dict | None = None
    format: dict | None = None


CLIP_EXTRA = ("speed", "volume", "mute", "filter", "adjust", "frame", "transition")


@app.put("/api/projects/{pid}/edit")
def save_edit(pid: str, body: EditBody) -> dict:
    p = _project(pid)
    clean_clips = []
    for c in body.clips:
        if c.get("kind") == "title":
            clean_clips.append({"id": c.get("id") or new_id("c"), "kind": "title", "text": str(c.get("text", "")),
                                "sub": str(c.get("sub", "")), "tag": str(c.get("tag", "")),
                                "dur": max(0.5, float(c.get("dur", 3))),
                                **({"transition": c["transition"]} if c.get("transition") else {})})
            continue
        try:
            take = p.take(c["take"])
        except KeyError:
            continue
        a, b = max(0.0, float(c["a"])), min(float(c["b"]), take["duration"])
        if b - a > 0.04:
            extra = {k: c[k] for k in CLIP_EXTRA if c.get(k) not in (None, "", {})}
            if "speed" in extra:
                extra["speed"] = min(4.0, max(0.25, float(extra["speed"])))
            clean_clips.append({"id": c.get("id") or new_id("c"), "take": c["take"], "a": round(a, 3), "b": round(b, 3),
                                **extra})
    p.data["edit"] = {"clips": clean_clips, "overlays": body.overlays, "media": body.media, "audio": body.audio,
                      "captions": body.captions or {}, "format": body.format or {"aspect": "16:9"}}
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


class Correction(BaseModel):
    take: str
    word: int
    text: str


@app.post("/api/projects/{pid}/corrections")
def correct_word(pid: str, body: Correction) -> dict:
    """Spell a word differently in captions (empty text undoes it)."""
    p = _project(pid)

    def fix(d: dict) -> None:
        brain = d.setdefault("brain", {})
        rows = [c for c in brain.get("corrections", []) if not (c["take"] == body.take and c["word"] == body.word)]
        if body.text.strip():
            rows.append({"take": body.take, "word": body.word, "text": body.text.strip()[:40]})
        brain["corrections"] = rows

    project.commit(p, fix)
    return _full(p)


class LayoutBody(BaseModel):
    clips: list[dict]
    captions: dict | None = None
    format: dict | None = None


@app.post("/api/projects/{pid}/captions/layout")
def caption_layout(pid: str, body: LayoutBody) -> dict:
    """Where every caption word goes, for the preview (same as the export)."""
    p = _project(pid)
    p.data["edit"] = {**p.data["edit"], "clips": body.clips, "format": body.format or {}}
    from .render import output_format

    W, H, _ = output_format(p)
    words = captions.timeline_words(p, body.clips)
    lay = captions.layout(words, body.captions or {}, W, H)
    return {"width": W, "height": H, **lay}


class TextLayout(BaseModel):
    overlays: list[dict]
    format: dict | None = None


@app.post("/api/projects/{pid}/text/layout")
def text_layout(pid: str, body: TextLayout) -> dict:
    p = _project(pid)
    p.data["edit"] = {**p.data["edit"], "format": body.format or {}}
    from .render import output_format

    W, H, _ = output_format(p)
    out = {}
    for o in body.overlays:
        if o.get("kind") == "text":
            L = captions.text_layout(o, W, H)
            out[o["id"]] = {"em": L["em"], "lh": L["lh"], "lines": L["lines"], "widths": L["widths"], "font": L["font"]}
    return {"width": W, "height": H, "items": out}


# ---------------------------------------------------------------- assets ----
class Paths(BaseModel):
    paths: list[str]


@app.post("/api/projects/{pid}/assets")
def import_assets(pid: str, body: Paths) -> dict:
    p = _project(pid)
    added = assets.add(p, body.paths)
    return {"added": [a["id"] for a in added], "project": _full(project.by_id(pid))}


@app.post("/api/projects/{pid}/assets/pick")
def pick_assets(pid: str) -> dict:
    fn = window_api["pick_files"]
    if not fn:
        raise HTTPException(400, "Choosing files needs the desktop window. Drag files in, or paste their paths.")
    paths = fn() or []
    return import_assets(pid, Paths(paths=list(paths)))


@app.delete("/api/projects/{pid}/assets/{aid}")
def delete_asset(pid: str, aid: str) -> dict:
    p = _project(pid)
    assets.remove(p, aid)
    return _full(project.by_id(pid))


@app.get("/media/{pid}/asset/{aid}")
def asset_file(pid: str, aid: str, request: Request) -> Response:
    p = _project(pid)
    a = next((x for x in p.data.get("assets", []) if x["id"] == aid), None)
    if not a:
        raise HTTPException(404)
    path = assets.preview_path(p, a)
    if not path:
        raise HTTPException(404, "Preview copy not ready yet")
    return _ranged(path, request)


@app.get("/api/sfx")
def sfx_list() -> list:
    from . import sfx

    return sfx.catalog()


@app.get("/sfx/{name}.wav")
def sfx_file(name: str) -> Response:
    from . import sfx

    try:
        return FileResponse(sfx.path(name), media_type="audio/wav")
    except KeyError:
        raise HTTPException(404)


@app.post("/api/projects/{pid}/sfx/{name}")
def add_sfx(pid: str, name: str) -> dict:
    """Put a built-in sound in the project's media, ready to place."""
    from . import sfx

    p = _project(pid)
    try:
        f = str(sfx.path(name))
    except KeyError:
        raise HTTPException(404, "No such sound")
    existing = next((a for a in p.data.get("assets", []) if a["file"].lower() == f.lower()), None)
    if not existing:
        added = assets.add(p, [f])
        if not added:
            raise HTTPException(500, "Couldn't add that sound")
        existing = added[0]
        label = dict((k, v[0]) for k, v in sfx.SOUNDS.items())[name]

        def rename(d: dict) -> None:
            for a in d.get("assets", []):
                if a["id"] == existing["id"]:
                    a["name"] = label
                    a["sfx"] = True

        project.commit(p, rename)
    return {"asset": existing["id"], "project": _full(project.by_id(pid))}


@app.get("/media/{pid}/asset/{aid}/peaks")
def asset_peaks(pid: str, aid: str) -> dict:
    """Loudness, 50 values a second, for drawing a sound's waveform."""
    import json as _json

    p = _project(pid)
    a = next((x for x in p.data.get("assets", []) if x["id"] == aid), None)
    if not a or not (a["kind"] == "audio" or a.get("has_audio")):
        raise HTTPException(404)
    f = p.dir / "thumbs" / f"{aid}.peaks.json"
    if f.exists():
        return _json.loads(f.read_text(encoding="utf-8"))
    x = media.load_audio(Path(a["file"]))
    out = {"per": 50, "peaks": media.waveform_peaks(media.level_db(x), 50)}
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(_json.dumps(out), encoding="utf-8")
    return out


@app.get("/media/{pid}/asset/{aid}/thumb.jpg")
def asset_thumb(pid: str, aid: str) -> Response:
    p = _project(pid)
    a = next((x for x in p.data.get("assets", []) if x["id"] == aid), None)
    if not a or a["kind"] == "audio":
        raise HTTPException(404)
    f = p.dir / "thumbs" / f"{aid}.jpg"
    if not f.exists():
        f.parent.mkdir(parents=True, exist_ok=True)
        try:
            if a["kind"] == "image":
                from PIL import Image

                with Image.open(a["file"]) as im:
                    im = im.convert("RGB")
                    im.thumbnail((320, 320))
                    im.save(f, "JPEG", quality=82)
            else:
                f.write_bytes(media.frame_at(Path(a["file"]), min(1.0, (a.get("duration") or 2) / 3), 320))
        except (OSError, media.MediaError) as e:
            raise HTTPException(404, str(e)[:200])
    return FileResponse(f, media_type="image/jpeg", headers={"Cache-Control": "max-age=3600"})


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


@app.get("/media/{pid}/source/{sid}")
def source_file(pid: str, sid: str, request: Request) -> Response:
    """The original recording, for exports made in the window."""
    p = _project(pid)
    try:
        return _ranged(p.source_path(sid), request)
    except KeyError:
        raise HTTPException(404)


@app.get("/api/projects/{pid}/blur-spans")
def get_blur_spans(pid: str) -> dict:
    """What to blur, per source: [start, end, x0, y0, x1, y1] in source pixels and seconds."""
    from .privacy import blur_spans

    p = _project(pid)
    spans = blur_spans(p, p.read_json("privacy", "detections.json", default=[]) or [])
    return {src: [[round(t0, 3), round(t1, 3), *[int(v) for v in box]] for t0, t1, box in rows] for src, rows in spans.items()}


# Exports made in the window stream here in pieces, each at its byte position.
_streams: dict[str, Path] = {}


class StreamStart(BaseModel):
    aspect: str = "16:9"


@app.post("/api/projects/{pid}/stream-render")
def stream_start(pid: str, body: StreamStart) -> dict:
    from .render import _safe_name

    p = _project(pid)
    out_dir = p.folder / "Retake exports"
    out_dir.mkdir(exist_ok=True)
    stamp = time.strftime("%Y-%m-%d %H.%M.%S")
    suffix = "" if body.aspect == "16:9" else f" ({body.aspect.replace(':', 'x')})"
    out = out_dir / f"{_safe_name(p.data['name'])}{suffix} {stamp}.mp4"
    out.write_bytes(b"")
    token = new_id("st")
    _streams[token] = out
    return {"token": token, "file": str(out)}


@app.put("/api/projects/{pid}/stream-render/{token}")
async def stream_piece(pid: str, token: str, pos: int, request: Request) -> dict:
    out = _streams.get(token)
    if not out:
        raise HTTPException(404, "Unknown export")
    data = await request.body()
    with open(out, "r+b") as f:
        f.seek(pos)
        f.write(data)
    return {"ok": True}


class StreamDone(BaseModel):
    duration: float
    width: int
    height: int
    fps: float


@app.post("/api/projects/{pid}/stream-render/{token}/done")
def stream_done(pid: str, token: str, body: StreamDone) -> dict:
    """Finish an export made in the window: captions, chapters, and a record of it."""
    from .render import chapters_text

    out = _streams.pop(token, None)
    if not out or not out.exists():
        raise HTTPException(404, "Unknown export")
    p = _project(pid)
    words = captions.timeline_words(p, p.data["edit"]["clips"])
    srt = out.with_suffix(".srt")
    srt.write_text(captions.srt(words), encoding="utf-8")
    chapters = chapters_text(p.data["edit"]["clips"], p.data["edit"].get("overlays", []))
    out.with_suffix(".chapters.txt").write_text(chapters, encoding="utf-8")
    result = {"file": str(out), "srt": str(srt), "duration": round(body.duration, 2), "width": body.width,
              "height": body.height, "fps": body.fps, "created": time.time(), "chapters": chapters, "leaks": [],
              "engine": "window"}
    project.commit(p, lambda d: (d["renders"].insert(0, result), d.update(stage="done")))
    return _full(project.by_id(pid))


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
