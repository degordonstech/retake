"""Make the edit with a free Groq key (OpenAI-compatible endpoint)."""

from __future__ import annotations

import httpx

from . import parse_json

URL = "https://api.groq.com/openai/v1/chat/completions"


def ask(system: str, prompt: str, schema: dict, settings: dict) -> dict:
    key = settings.get("groq_key")
    if not key:
        raise RuntimeError("No Groq API key saved")
    body = {
        "model": settings.get("groq_model") or "openai/gpt-oss-120b",
        "max_tokens": 16000,
        "temperature": 0.2,
        "reasoning_effort": "medium",
        "include_reasoning": False,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": system + "\n\nAnswer with one JSON object only, with the keys: "
                                                   "keep, chapters, notes, corrections, title, description."},
            {"role": "user", "content": prompt},
        ],
    }
    r = httpx.post(URL, json=body, headers={"Authorization": f"Bearer {key}"}, timeout=300)
    if r.status_code != 200:
        msg = r.json().get("error", {}).get("message", r.text[:200]) if r.headers.get(
            "content-type", "").startswith("application/json") else r.text[:200]
        raise RuntimeError(f"Groq {r.status_code}: {msg}")
    return parse_json(r.json()["choices"][0]["message"]["content"])
