"""The editing judgment: which words to keep, in what order, and why.

Every provider gets the same prompt and must return the same JSON shape
(SCHEMA). `propose()` picks the provider from the settings and falls back to
the rule-based editor when no AI is set up or the AI call fails.
"""

from __future__ import annotations

import json
from typing import Callable

from ..analysis import phrases
from . import heuristic

SCHEMA: dict = {
    "type": "object",
    "properties": {
        "keep": {
            "type": "array",
            "description": "The words to keep, as spans, in the order they should play.",
            "items": {
                "type": "object",
                "properties": {
                    "take": {"type": "string"},
                    "from_word": {"type": "integer"},
                    "to_word": {"type": "integer"},
                },
                "required": ["take", "from_word", "to_word"],
                "additionalProperties": False,
            },
        },
        "chapters": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "take": {"type": "string"},
                    "word": {"type": "integer"},
                },
                "required": ["title", "take", "word"],
                "additionalProperties": False,
            },
        },
        "notes": {
            "type": "array",
            "description": "Things the editor should check: factual slips, unclear audio, risky claims.",
            "items": {
                "type": "object",
                "properties": {
                    "take": {"type": "string"},
                    "word": {"type": "integer"},
                    "note": {"type": "string"},
                },
                "required": ["take", "word", "note"],
                "additionalProperties": False,
            },
        },
        "corrections": {
            "type": "array",
            "description": "Words the transcription misheard, with the right spelling, for captions.",
            "items": {
                "type": "object",
                "properties": {
                    "take": {"type": "string"},
                    "word": {"type": "integer"},
                    "text": {"type": "string"},
                },
                "required": ["take", "word", "text"],
                "additionalProperties": False,
            },
        },
        "title": {"type": "string"},
        "description": {"type": "string"},
    },
    "required": ["keep", "chapters", "notes", "corrections", "title", "description"],
    "additionalProperties": False,
}

SYSTEM = """You are a careful video editor for a creator who records long tutorials in one go and talks through mistakes.
You get the transcript of each recording ("take"), word by word, with each word's index. You decide what stays.

Cut:
- false starts, and earlier attempts at a sentence that the speaker says again better (keep the LAST good attempt)
- lines meant for the editor, like "this is where it starts", "cut this", "let me do that again"
- "I'll skip this part", "I'll be back when it's done", and waiting with nothing said
- filler that adds nothing ("um", "so so", repeated "alright"), rambling that goes nowhere
- factual slips you are sure of, when cutting them leaves a clean sentence; otherwise keep them and add a note

Keep:
- every real instruction and step, in a natural flow, in the speaker's own words
- the speaker's personality and short asides that land
- whole sentences: start a span at the start of a sentence and end it at the end of one

Order: normally keep each take's spans in time order and the takes in the order given. Move things only when a take clearly
belongs elsewhere (for example a camera intro recorded separately that should open the video, or an outro that should end it).

Chapters: 5 to 14 short titles in sentence case, each at the first kept word of a new section. The first chapter is at the very start.
Title: a curious, specific YouTube title, under 70 characters, no clickbait words, no emojis.
Description: two short plain paragraphs about what the video shows. No emojis, no hashtags, no em dashes.
Notes: anything the creator should double-check, each tied to a word index.
Corrections: words the transcription clearly misheard, for the captions, each as the word index and the right text
(for example product names: "cloud code" said as "Claude Code" means word "cloud" -> "Claude"). Only kept words, only when sure,
one word each, keeping its punctuation.
Word indices are per take. A span is inclusive. Never invent words: you can only keep words that are in the transcript."""


def build_prompt(takes: list[dict], transcripts: dict[str, dict]) -> str:
    parts = ["Here are the takes, in recording order.\n"]
    for t in takes:
        tr = transcripts.get(t["id"])
        if not tr:
            continue
        parts.append(f'\n=== take "{t["id"]}" ({t["kind"]}, {t["name"]}, {tr["duration"]:.0f} s) ===')
        for ph in phrases(tr["words"], tr["silences"]):
            ws = tr["words"][ph["first"]: ph["last"] + 1]
            parts.append(f"[{ph['s']:.1f}s] " + " ".join(f"{w['i']}:{w['w']}" for w in ws))
    parts.append("\nReturn the edit as JSON matching the schema.")
    return "\n".join(parts)


def propose(takes: list[dict], transcripts: dict[str, dict], settings: dict,
            log: Callable[[str], None]) -> dict:
    provider = settings.get("brain") or "none"
    prompt = build_prompt(takes, transcripts)
    if provider != "none":
        try:
            if provider == "claude_code":
                from .claude_code import ask
            elif provider == "anthropic":
                from .anthropic_api import ask
            elif provider == "groq":
                from .groq import ask
            else:
                raise ValueError(f"Unknown AI provider {provider!r}")
            log(f"Asking {label(provider)} to edit {sum(len(v['words']) for v in transcripts.values())} words")
            result = ask(SYSTEM, prompt, SCHEMA, settings)
            return clean(result, takes, transcripts, source=provider)
        except Exception as e:  # noqa: BLE001 - any failure falls back to the rules
            log(f"{label(provider)} didn't answer ({str(e)[:240]}). Using the built-in editor instead.")
    return clean(heuristic.propose(takes, transcripts), takes, transcripts, source="rules")


def label(provider: str) -> str:
    return {"claude_code": "Claude Code", "anthropic": "Claude (API key)", "groq": "Groq",
            "none": "the built-in editor"}.get(provider, provider)


def clean(result: dict, takes: list[dict], transcripts: dict[str, dict], source: str) -> dict:
    """Keep only spans that point at real words, so a confused answer can't break the edit."""
    ids = {t["id"] for t in takes}
    keep = []
    for k in result.get("keep", []):
        tr = transcripts.get(k.get("take"))
        if k.get("take") not in ids or not tr:
            continue
        n = len(tr["words"])
        a, b = int(k["from_word"]), int(k["to_word"])
        a, b = max(0, min(a, b)), min(n - 1, max(a, b))
        if 0 <= a <= b < n:
            keep.append({"take": k["take"], "from_word": a, "to_word": b})
    chapters = [c for c in result.get("chapters", []) if c.get("take") in ids and c.get("title")]
    notes = [n for n in result.get("notes", []) if n.get("take") in ids and n.get("note")]
    corrections = []
    for c in result.get("corrections", []) or []:
        tr = transcripts.get(c.get("take"))
        text = str(c.get("text", "")).strip()
        if tr and text and 0 <= int(c.get("word", -1)) < len(tr["words"]) and len(text) <= 40:
            corrections.append({"take": c["take"], "word": int(c["word"]), "text": text})
    return {
        "keep": keep,
        "chapters": chapters,
        "notes": notes,
        "title": (result.get("title") or "").strip(),
        "description": (result.get("description") or "").strip(),
        "corrections": corrections,
        "source": source,
    }


def parse_json(text: str) -> dict:
    """Pull a JSON object out of a model reply that may have extra text around it."""
    text = text.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1].rsplit("```", 1)[0]
    start, end = text.find("{"), text.rfind("}")
    return json.loads(text[start: end + 1])
