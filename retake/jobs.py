"""Background jobs, one at a time, with progress the UI can poll."""

from __future__ import annotations

import queue
import threading
import time
import traceback
from typing import Callable

from . import analysis, brain, config, edit, media, privacy, render
from .project import Project, by_id

_jobs: dict[str, dict] = {}            # project id -> latest job
_queue: "queue.Queue[tuple[str, str, dict]]" = queue.Queue()
_lock = threading.Lock()


def status(project_id: str) -> dict | None:
    with _lock:
        j = _jobs.get(project_id)
        return dict(j, log=list(j["log"][-40:])) if j else None


def start(project_id: str, kind: str, args: dict | None = None) -> dict:
    with _lock:
        cur = _jobs.get(project_id)
        if cur and cur["status"] in ("queued", "running"):
            return dict(cur, log=list(cur["log"]))
        job = {"kind": kind, "status": "queued", "progress": 0.0, "message": "Waiting to start",
               "log": [], "started": time.time(), "finished": None, "error": None, "steps": []}
        _jobs[project_id] = job
    _queue.put((project_id, kind, args or {}))
    return dict(job)


def _worker() -> None:
    while True:
        pid, kind, args = _queue.get()
        job = _jobs[pid]
        job["status"] = "running"

        def progress(f: float, msg: str | None = None) -> None:
            job["progress"] = round(max(0.0, min(1.0, f)), 4)
            if msg:
                job["message"] = msg

        def log(msg: str) -> None:
            job["log"].append({"t": time.time(), "msg": msg})

        try:
            p = by_id(pid)
            RUNNERS[kind](p, args, progress, log)
            job["status"] = "done"
            job["progress"] = 1.0
        except Exception as e:  # noqa: BLE001
            job["status"] = "error"
            job["error"] = str(e)[:600]
            job["message"] = "Something went wrong"
            log("Error: " + str(e)[:600])
            traceback.print_exc()
        job["finished"] = time.time()


Progress = Callable[..., None]


# ----------------------------------------------------------------- steps ----
def run_prepare(p: Project, args: dict, progress: Progress, log: Callable[[str], None]) -> None:
    """Proxies, thumbnails, transcripts and sync for every take, then a first cut."""
    settings = config.load_settings()
    takes = p.data["takes"]
    if not takes:
        raise ValueError("Add at least one recording with a voice.")
    used = {s for t in takes for s in (t["voice"], t["video"]) if s}
    srcs = [s for s in p.data["sources"] if s["id"] in used]
    # Weights: proxies are quick, transcription is the long part.
    units = sum(s["duration"] * 0.3 for s in srcs) + sum(t["duration"] * 1.0 for t in takes) or 1
    done = 0.0

    for s in srcs:
        proxy = p.dir / "proxy" / f"{s['id']}.mp4"
        if not proxy.exists():
            msg = f"Making a preview copy of {s['file']}"
            log(msg)
            base = done
            media.make_proxy(p.source_path(s["id"]), proxy, s["duration"], s["has_video"],
                             lambda f, b=base, d=s["duration"]: progress((b + f * d * 0.3) / units, msg))
        if s["has_video"] and not (p.dir / "thumbs" / f"{s['id']}.jpg").exists():
            info = media.make_thumbs(proxy, p.path("thumbs", f"{s['id']}.jpg"), s["duration"])
            s["thumbs"] = info
        done += s["duration"] * 0.3
    p.save()

    for t in takes:
        if not (p.dir / "takes" / f"{t['id']}.json").exists():
            msg = f"Listening to {t['name']}"
            log(msg)
            base = done
            analysis.transcribe_take(p, t, settings,
                                     lambda f, b=base, d=t["duration"]: progress((b + f * d * 0.85) / units, msg))
        if t["video"] and t["video"] != t["voice"] and t.get("sync_score") is None:
            msg = f"Lining up the screen with the voice in {t['name']}"
            log(msg)
            analysis.sync_take(p, t, lambda f: None)
            jumps = len(t["offsets"]) - 1
            log(f"{t['name']}: picture is {t['offsets'][0][1]:+.2f} s from the voice"
                + (f", with {jumps} jump{'s' if jumps != 1 else ''} where recording paused" if jumps else ""))
        t["ready"] = True
        done += t["duration"]
        p.save()
        progress(done / units)

    p.data["stage"] = "edit"
    p.save()
    if not p.data["edit"]["clips"]:
        run_autoedit(p, {}, progress, log)


def run_autoedit(p: Project, args: dict, progress: Progress, log: Callable[[str], None]) -> None:
    settings = config.load_settings()
    if args.get("brain"):
        settings["brain"] = args["brain"]
    takes = [t for t in p.data["takes"] if t.get("ready")]
    transcripts = {t["id"]: p.read_json("takes", f"{t['id']}.json") for t in takes}
    transcripts = {k: v for k, v in transcripts.items() if v}
    progress(0.1, f"{brain.label(settings['brain'])} is making the first cut")
    result = brain.propose(takes, transcripts, settings, log)
    clips = edit.build_clips(p, result["keep"], transcripts)
    overlays = edit.chapter_overlays(clips, result["chapters"], transcripts)
    for i, o in enumerate(overlays, 1):
        o["tag"] = f"STEP {i:02d}"
    p.data["edit"] = {"clips": clips, "overlays": overlays}
    p.data["brain"] = {k: result[k] for k in ("chapters", "notes", "title", "description", "source")}
    kept = sum(c["b"] - c["a"] for c in clips)
    raw = sum(t["duration"] for t in takes)
    log(f"First cut ready: {kept / 60:.1f} min kept from {raw / 60:.1f} min recorded, {len(clips)} clips")
    p.data["stage"] = "edit"
    p.save()
    progress(1.0, "First cut ready")


def run_scan(p: Project, args: dict, progress: Progress, log: Callable[[str], None]) -> None:
    settings = config.load_settings()
    progress(0.0, "Reading the screen for private things")
    dets = privacy.scan(p, settings, lambda f: progress(f, "Reading the screen for private things"), log)
    p.write_json(dets, "privacy", "detections.json")
    p.data["privacy"]["scanned"] = time.time()
    p.data["privacy"]["scanned_edit"] = _edit_fingerprint(p)
    p.data["stage"] = "privacy"
    p.save()


def run_render(p: Project, args: dict, progress: Progress, log: Callable[[str], None]) -> None:
    settings = config.load_settings()
    if p.data["privacy"].get("scanned_edit") != _edit_fingerprint(p):
        log("The edit changed since the last privacy scan, so it runs again first")
        run_scan(p, args, lambda f, m=None: progress(0.3 * f, "Re-checking privacy"), log)
        base, span = 0.3, 0.55
    else:
        base, span = 0.0, 0.85
    result = render.render(p, settings, lambda f, m: progress(base + span * f, m))
    log(f"Rendered {result['file']}")
    progress(0.86, "Reading the finished video back to check for leaks")
    allowed = {a.lower() for a in p.data["privacy"].get("allowed", [])}
    leaks = privacy.verify(result["file"], settings, allowed, lambda f: progress(0.86 + 0.14 * f, "Checking for leaks"))
    result["leaks"] = leaks
    log("Leak check: " + ("nothing private found" if not leaks else f"{len(leaks)} things to look at"))
    p.data["renders"].insert(0, result)
    p.data["stage"] = "done"
    p.save()


def _edit_fingerprint(p: Project) -> str:
    import hashlib
    import json

    clips = [(c.get("take"), c.get("a"), c.get("b")) for c in p.data["edit"]["clips"] if c.get("kind") != "title"]
    words = sorted(config.load_settings().get("private_words") or [])
    return hashlib.sha1(json.dumps([clips, words, privacy.RULES_VERSION]).encode()).hexdigest()[:12]


RUNNERS = {"prepare": run_prepare, "autoedit": run_autoedit, "scan": run_scan, "render": run_render}

threading.Thread(target=_worker, daemon=True, name="retake-jobs").start()
