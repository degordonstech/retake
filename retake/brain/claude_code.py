"""Ask the user's own Claude Code (headless) to make the edit, on their plan."""

from __future__ import annotations

import glob
import json
import os
import shutil
import subprocess
from pathlib import Path

_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def find_claude(settings: dict) -> str | None:
    custom = (settings.get("claude_path") or "").strip()
    if custom and Path(custom).exists():
        return custom
    on_path = shutil.which("claude")
    if on_path:
        return on_path
    # The VS Code extension ships its own copy.
    home = Path.home()
    hits = sorted(glob.glob(str(home / ".vscode" / "extensions" / "anthropic.claude-code-*" / "resources"
                                / "native-binary" / "claude*")), reverse=True)
    return hits[0] if hits else None


def ask(system: str, prompt: str, schema: dict, settings: dict) -> dict:
    exe = find_claude(settings)
    if not exe:
        raise RuntimeError("Claude Code isn't installed, or Retake can't find it")
    cmd = [exe, "-p", "--output-format", "json", "--no-session-persistence",
           "--tools", "", "--json-schema", json.dumps(schema),
           "--append-system-prompt", system]
    env = {**os.environ}
    r = subprocess.run(cmd, input=prompt.encode("utf-8"), capture_output=True, timeout=900,
                       creationflags=_NO_WINDOW, env=env)
    out = r.stdout.decode("utf-8", "replace").strip()
    if not out:
        raise RuntimeError(r.stderr.decode("utf-8", "replace")[-400:] or "no answer")
    data = json.loads(out)
    if data.get("is_error"):
        raise RuntimeError(str(data.get("result") or data.get("subtype"))[:400])
    if isinstance(data.get("structured_output"), dict):
        return data["structured_output"]
    from . import parse_json

    return parse_json(str(data.get("result", "")))


def status(settings: dict) -> dict:
    exe = find_claude(settings)
    if not exe:
        return {"ok": False, "message": "Not found. Install Claude Code, or set its path."}
    try:
        r = subprocess.run([exe, "--version"], capture_output=True, timeout=20, creationflags=_NO_WINDOW)
        v = r.stdout.decode().strip().splitlines()[0] if r.stdout else "unknown version"
        return {"ok": True, "message": f"Found {v}", "path": exe}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "message": str(e)[:200]}
