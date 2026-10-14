"""App settings and the list of known projects.

Settings live in the user's app data folder, never inside a project, so keys
are not copied around with footage. API keys are stored there in plain text,
like most desktop tools do; the UI never sends them back once saved.
"""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any

APP_DIR = Path(os.environ.get("APPDATA") or Path.home() / ".config") / "Retake"
SETTINGS_FILE = APP_DIR / "settings.json"
PROJECTS_FILE = APP_DIR / "projects.json"

DEFAULTS: dict[str, Any] = {
    # Which AI makes the editing calls: claude_code | anthropic | groq | none
    "brain": "claude_code",
    "claude_path": "",          # empty means: find `claude` on PATH
    "anthropic_key": "",
    "anthropic_model": "claude-opus-5-5",
    "groq_key": "",
    "groq_model": "openai/gpt-oss-120b",
    "whisper_model": "small",   # tiny | base | small | medium
    "language": "en",
    # Words that must never be readable on screen (project names, emails...).
    "private_words": [],
    # The look of labels, title cards and captions.
    "brand": {
        "accent": "#ff8a3d",
        "background": "#0a0e14",
        "text": "#f0f2f5",
        "name": "",
    },
}

SECRET_KEYS = ("anthropic_key", "groq_key")

_lock = threading.Lock()


def _read(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def _write(path: Path, data: Any) -> None:
    APP_DIR.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    tmp.replace(path)


def load_settings() -> dict[str, Any]:
    with _lock:
        stored = _read(SETTINGS_FILE, {})
    merged = {**DEFAULTS, **stored}
    merged["brand"] = {**DEFAULTS["brand"], **(stored.get("brand") or {})}
    return merged


def public_settings() -> dict[str, Any]:
    """Settings safe to show in the UI: secrets become a yes/no."""
    s = load_settings()
    for k in SECRET_KEYS:
        s[k + "_set"] = bool(s.get(k))
        s[k] = ""
    return s


def save_settings(changes: dict[str, Any]) -> dict[str, Any]:
    with _lock:
        current = {**DEFAULTS, **_read(SETTINGS_FILE, {})}
        for k, v in changes.items():
            if k not in DEFAULTS:
                continue
            # An empty secret from the UI means "leave it as it is".
            if k in SECRET_KEYS and not v:
                continue
            if k == "brand":
                current["brand"] = {**current.get("brand", {}), **(v or {})}
            else:
                current[k] = v
        _write(SETTINGS_FILE, current)
    return public_settings()


def clear_secret(key: str) -> None:
    if key not in SECRET_KEYS:
        return
    with _lock:
        current = _read(SETTINGS_FILE, {})
        current[key] = ""
        _write(SETTINGS_FILE, current)


def list_projects() -> list[dict[str, Any]]:
    with _lock:
        return _read(PROJECTS_FILE, [])


def remember_project(entry: dict[str, Any]) -> None:
    with _lock:
        items = [p for p in _read(PROJECTS_FILE, []) if p.get("id") != entry["id"]]
        items.insert(0, entry)
        _write(PROJECTS_FILE, items[:50])


def forget_project(project_id: str) -> None:
    with _lock:
        items = [p for p in _read(PROJECTS_FILE, []) if p.get("id") != project_id]
        _write(PROJECTS_FILE, items)
