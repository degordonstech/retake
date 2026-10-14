"""The built-in editor, for when no AI is set up: rules, no network.

It drops filler-only phrases and earlier attempts at a sentence that is said
again right after, and keeps everything else in recording order.
"""

from __future__ import annotations

import re
from difflib import SequenceMatcher

from ..analysis import phrases

FILLER = {"um", "uh", "erm", "hmm", "ah", "okay", "ok", "alright", "all", "right", "so", "and", "yeah",
          "guys", "like", "you", "know", "the", "a"}
EDITOR_LINES = re.compile(r"\b(where it starts|cut (this|that)|start (again|over)|let me (do|say) (that|this) again"
                          r"|i'?ll (be )?skip(ping)? this|be back when|i'?m going to skip)\b", re.I)


def _norm(text: str) -> list[str]:
    return re.findall(r"[a-z0-9']+", text.lower())


def propose(takes: list[dict], transcripts: dict[str, dict]) -> dict:
    keep: list[dict] = []
    chapters: list[dict] = []
    for t in takes:
        tr = transcripts.get(t["id"])
        if not tr or not tr["words"]:
            continue
        phs = phrases(tr["words"], tr["silences"])
        drop = [False] * len(phs)
        for i, ph in enumerate(phs):
            words = _norm(ph["text"])
            if not words or all(w in FILLER for w in words):
                drop[i] = True
                continue
            if EDITOR_LINES.search(ph["text"]):
                drop[i] = True
                continue
            # A retake: the next phrase (or the one after) starts the same way.
            for j in (i + 1, i + 2):
                if j < len(phs):
                    nxt = _norm(phs[j]["text"])
                    head = min(len(words), len(nxt), 6)
                    if head >= 3 and SequenceMatcher(None, words[:head], nxt[:head]).ratio() > 0.75 \
                            and len(nxt) >= len(words) * 0.7:
                        drop[i] = True
                        break
        first = True
        for ph, d in zip(phs, drop):
            if d:
                continue
            if first:
                chapters.append({"title": t["name"], "take": t["id"], "word": ph["first"]})
                first = False
            if keep and keep[-1]["take"] == t["id"] and keep[-1]["to_word"] == ph["first"] - 1:
                keep[-1]["to_word"] = ph["last"]
            else:
                keep.append({"take": t["id"], "from_word": ph["first"], "to_word": ph["last"]})
    return {"keep": keep, "chapters": chapters, "notes": [], "title": "", "description": ""}
