"""Animated captions and on-screen text, written as one ASS file for libass.

The layout (which words share a caption, where each word sits) is worked out
here once, with the real fonts. The export draws from it, and the window's
preview asks for the same layout, so what you see while editing is what the
export burns in. Every word is placed on its own, which is what lets a single
word pop, glow, or sit in a box without the rest of the line moving.
"""

from __future__ import annotations

import re
from functools import lru_cache
from pathlib import Path

from PIL import ImageFont

from .looks import FONTS, caption_template, text_style
from .project import Project, clip_dur, clip_speed

FONT_DIR = Path(__file__).parent / "assets" / "fonts"
LINE_H = 1.22


# ----------------------------------------------------------------- fonts ----
def font_file(name: str) -> Path:
    return FONT_DIR / FONTS.get(name, FONTS["Poppins ExtraBold"])["file"]


@lru_cache(maxsize=64)
def _pil(name: str) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(font_file(name)), 200)


@lru_cache(maxsize=64)
def cell_ratio(name: str) -> float:
    """libass sizes a font by its Windows ascent + descent, not its em; this
    converts an em size (what the layout and the browser use) to an ASS size."""
    from fontTools.ttLib import TTFont

    f = TTFont(str(font_file(name)), lazy=True)
    os2 = f["OS/2"]
    return (os2.usWinAscent + os2.usWinDescent) / f["head"].unitsPerEm


def width(name: str, em: float, text: str) -> float:
    return _pil(name).getlength(text) * em / 200


# ---------------------------------------------------------------- words ----
def timeline_words(p: Project, clips: list[dict]) -> list[dict]:
    """Every kept word with its time on the timeline (corrections applied)."""
    fixes = {(c["take"], c["word"]): c["text"] for c in (p.data.get("brain") or {}).get("corrections", [])}
    cache: dict[str, list] = {}
    out: list[dict] = []
    t = 0.0
    for c in clips:
        d = clip_dur(c)
        if c.get("kind") == "title":
            t += d
            continue
        if c["take"] not in cache:
            cache[c["take"]] = (p.read_json("takes", f"{c['take']}.json", default={}) or {}).get("words", [])
        sp = clip_speed(c)
        for w in cache[c["take"]]:
            if w["s"] >= c["a"] - 0.02 and w["e"] <= c["b"] + 0.05:
                s = t + max(0.0, w["s"] - c["a"]) / sp
                e = t + (min(c["b"], w["e"]) - c["a"]) / sp
                out.append({"text": fixes.get((c["take"], w["i"]), w["w"]), "s": round(s, 3), "e": round(max(e, s + 0.06), 3)})
        t += d
    return out


def resolve(settings: dict | None) -> dict:
    """The caption template with the user's changes laid over it."""
    s = settings or {}
    cfg = dict(caption_template(s.get("template", "pop")))
    for k in ("color", "hi", "font", "y"):
        if s.get(k) not in (None, ""):
            cfg[k] = s[k]
    if s.get("upper") is not None:
        cfg["upper"] = bool(s["upper"])
    if s.get("words"):
        cfg["words"] = max(1, min(12, int(s["words"])))
    if s.get("lines"):
        cfg["lines"] = 1 if int(s["lines"]) <= 1 else 2
    cfg["size"] = cfg["size"] * float(s.get("scale") or 1.0)
    if cfg["font"] not in FONTS:
        cfg["font"] = "Poppins ExtraBold"
    return cfg


def _clean(text: str, cfg: dict) -> str:
    t = text.strip()
    if cfg.get("strip"):
        t = re.sub(r"[.,!?;:]+$", "", t).strip("\"'")
    return t.upper() if cfg.get("upper") else t


def _split(items: list[dict], maxw: float, gap: float, lines: int) -> list[list[dict]] | None:
    total = sum(i["w"] for i in items) + gap * (len(items) - 1)
    if total <= maxw or len(items) == 1:
        return [items]
    if lines < 2:
        return None
    best, score = None, None
    for k in range(1, len(items)):
        a, b = items[:k], items[k:]
        wa = sum(i["w"] for i in a) + gap * (len(a) - 1)
        wb = sum(i["w"] for i in b) + gap * (len(b) - 1)
        if wa <= maxw and wb <= maxw and (score is None or max(wa, wb) < score):
            best, score = [a, b], max(wa, wb)
    return best


def layout(words: list[dict], settings: dict | None, W: int, H: int) -> dict:
    """Group words into captions and place every word. Returns the resolved
    style too, so the preview can draw it."""
    cfg = resolve(settings)
    font = cfg["font"]
    em = cfg["size"] * min(W, H) / 1080
    maxw = W * (0.86 if W <= H else 0.74)
    pad = em * 0.2 if cfg["mode"] in ("box", "marker") else 0.0
    # Room for a growing word, so it never touches its neighbours.
    gap = width(font, em, " ") * (0.85 if pad else 1.0)
    grow = max(0.0, cfg.get("grow", 1.0) - 1.0)
    if grow:
        # Rough room for a growing word while choosing line breaks; the exact
        # room per pair of words is given when the words are placed.
        gap += em * grow * 3
    lh = em * LINE_H

    groups: list[list[dict]] = []
    cur: list[dict] = []
    for w in words:
        t = _clean(w["text"], cfg)
        if not t:
            continue
        item = {"t": t, "s": w["s"], "e": w["e"], "raw": w["text"], "w": width(font, em, t) + 2 * pad}
        if cur:
            pause = w["s"] - cur[-1]["e"]
            sentence = re.search(r"[.!?]['\"]?$", cur[-1]["raw"]) is not None
            if (len(cur) >= cfg["words"] or pause > 0.6 or sentence
                    or _split(cur + [item], maxw, gap, cfg["lines"]) is None):
                groups.append(cur)
                cur = []
        cur.append(item)
    if cur:
        groups.append(cur)

    pages = []
    for k, g in enumerate(groups):
        lines = _split(g, maxw, gap, cfg["lines"]) or [g]
        widest = max(sum(i["w"] for i in ln) + gap * (len(ln) - 1) for ln in lines)
        scale = min(1.0, maxw / widest) if widest > maxw else 1.0
        block = lh * scale * len(lines)
        top = min(max(H * cfg["y"] - block / 2, H * 0.04), H * 0.96 - block)
        placed = []
        for li, ln in enumerate(lines):
            base_gap = gap - (em * grow * 3 if grow else 0)
            # A growing word swells by grow/2 of its width on each side.
            gaps = [base_gap + max(a["w"], b["w"]) * grow / 2 for a, b in zip(ln, ln[1:])]
            lw = (sum(i["w"] for i in ln) + sum(gaps)) * scale
            x = (W - lw) / 2
            cy = top + lh * scale * (li + 0.5)
            for j, it in enumerate(ln):
                ww = it["w"] * scale
                placed.append({"t": it["t"], "s": it["s"], "e": it["e"], "cx": round(x + ww / 2, 1), "cy": round(cy, 1),
                               "w": round(ww, 1)})
                x += ww + (gaps[j] * scale if j < len(gaps) else 0)
        pages.append({"words": placed, "scale": scale,
                      "box": [round((W - widest * scale) / 2, 1), round(top, 1), round((W + widest * scale) / 2, 1),
                              round(top + block, 1)]})
    # Show each caption a moment before its first word and hold it after the
    # last, without overlapping its neighbours.
    for k, pg in enumerate(pages):
        first, last = pg["words"][0]["s"], pg["words"][-1]["e"]
        prev_end = pages[k - 1]["t1"] if k else 0.0
        nxt = pages[k + 1]["words"][0]["s"] if k + 1 < len(pages) else last + 10
        pg["t0"] = round(max(prev_end, first - 0.08), 3)
        pg["t1"] = round(min(last + 0.45, nxt - 0.08 if nxt - 0.08 > last else nxt), 3)
        if pg["t1"] <= pg["t0"]:
            pg["t1"] = round(pg["t0"] + 0.2, 3)
    return {"style": {**cfg, "em": round(em, 2), "pad": round(pad, 2), "lh": round(lh, 2)}, "pages": pages}


# ------------------------------------------------------------------ ASS -----
def _c(hex_color: str) -> str:
    h = (hex_color or "#FFFFFF").lstrip("#")
    if len(h) == 3:
        h = "".join(ch * 2 for ch in h)
    return f"&H{h[4:6]}{h[2:4]}{h[0:2]}&".upper()


def _a(opacity: float) -> str:
    return f"&H{round(255 * (1 - max(0.0, min(1.0, opacity)))):02X}&"


def _ts(t: float) -> str:
    t = max(0.0, t)
    cs = int(round(t * 100))
    h, cs = divmod(cs, 360000)
    m, cs = divmod(cs, 6000)
    s, cs = divmod(cs, 100)
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def _esc(text: str) -> str:
    return text.replace("\\", "/").replace("{", "(").replace("}", ")")


def rrect(w: float, h: float, r: float) -> str:
    """An ASS drawing of a rounded rectangle, w by h."""
    r = max(0.0, min(r, w / 2, h / 2))
    k = 0.5523 * r
    f = lambda v: f"{v:.1f}"  # noqa: E731
    return (f"m {f(r)} 0 l {f(w - r)} 0 b {f(w - r + k)} 0 {f(w)} {f(r - k)} {f(w)} {f(r)} "
            f"l {f(w)} {f(h - r)} b {f(w)} {f(h - r + k)} {f(w - r + k)} {f(h)} {f(w - r)} {f(h)} "
            f"l {f(r)} {f(h)} b {f(r - k)} {f(h)} 0 {f(h - r + k)} 0 {f(h - r)} "
            f"l 0 {f(r)} b 0 {f(r - k)} {f(r - k)} 0 {f(r)} 0")


class Doc:
    def __init__(self, W: int, H: int):
        self.W, self.H = W, H
        self.lines: list[str] = []

    def add(self, layer: int, t0: float, t1: float, text: str) -> None:
        if t1 - t0 >= 0.01:
            self.lines.append(f"Dialogue: {layer},{_ts(t0)},{_ts(t1)},Base,,0,0,0,,{text}")

    def text(self) -> str:
        return (
            "[Script Info]\nScriptType: v4.00+\nWrapStyle: 2\nScaledBorderAndShadow: yes\nYCbCr Matrix: TV.709\n"
            f"PlayResX: {self.W}\nPlayResY: {self.H}\n\n"
            "[V4+ Styles]\n"
            "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, "
            "Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, "
            "MarginR, MarginV, Encoding\n"
            "Style: Base,Poppins ExtraBold,60,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1\n\n"
            "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
            + "\n".join(self.lines) + "\n"
        )


def _look(font: str, em: float, color: str, outline: dict | None, shadow: dict | None) -> str:
    ow = (outline or {}).get("w", 0) * em
    sy = (shadow or {}).get("y", 0) * em
    sa = (shadow or {}).get("alpha", 0)
    return (f"\\fn{font}\\fs{em * cell_ratio(font):.1f}\\b0\\i0\\bord{ow:.1f}\\3c{_c((outline or {}).get('color', '#000000'))}"
            f"\\xshad0\\yshad{sy:.1f}\\4c&H000000&\\4a{_a(sa)}\\1c{_c(color)}")


def caption_events(doc: Doc, lay: dict) -> None:
    st = lay["style"]
    mode = st["mode"]
    font, em0, pad = st["font"], st["em"], st["pad"]
    grow = st.get("grow", 1.0)
    alt = st.get("alt") or []
    count = 0
    for pg in lay["pages"]:
        em = em0 * pg["scale"]
        ws = pg["words"]
        t0, t1 = pg["t0"], pg["t1"]
        if mode == "plain" and st.get("box"):
            b = st["box"]
            x0, y0, x1, y1 = pg["box"]
            bp = b["pad"] * em
            w, h = x1 - x0 + 2 * bp, y1 - y0 + bp
            doc.add(0, t0, t1, f"{{\\an5\\pos({(x0 + x1) / 2:.1f},{(y0 + y1) / 2:.1f})\\bord0\\shad0\\1c{_c(b['color'])}"
                               f"\\1a{_a(b['alpha'])}\\fad(80,80)\\p1}}{rrect(w, h, b['radius'] * em)}{{\\p0}}")
        for i, w in enumerate(ws):
            count += 1
            s = max(t0, w["s"])
            nxt = max(s, min(t1, ws[i + 1]["s"])) if i + 1 < len(ws) else t1
            cx, cy = w["cx"], w["cy"]
            text = _esc(w["t"])
            base = _look(font, em, st["color"], st.get("outline"), st.get("shadow"))
            pos = f"\\an5\\pos({cx:.1f},{cy:.1f})"

            def enter(at: float, end: float) -> str:
                """Page entrance and exit on whichever event touches them."""
                fin = 90 if abs(at - t0) < 1e-3 else 0
                fout = 90 if abs(end - t1) < 1e-3 else 0
                tag = f"\\fad({fin},{fout})" if fin or fout else ""
                if fin and st.get("enter") == "up":
                    return tag + f"\\an5\\move({cx:.1f},{cy + em * 0.4:.1f},{cx:.1f},{cy:.1f},0,170)"
                return tag + pos

            if mode == "plain":
                doc.add(2, t0, t1, f"{{{enter(t0, t1)}{base}}}{text}")
                continue
            if mode == "single":
                col = alt[(count - 1) % len(alt)] if alt else st["color"]
                look = _look(font, em, col, st.get("outline"), st.get("shadow"))
                doc.add(2, t0, t1, f"{{{enter(t0, t1)}{look}\\fscx70\\fscy70\\t(0,80,\\fscx108\\fscy108)"
                                   f"\\t(80,150,\\fscx100\\fscy100)}}{text}")
                continue

            # Before the word is said.
            if mode not in ("reveal",) and s > t0:
                look = base + (f"\\1a{_a(0.42)}\\3a{_a(0.42)}\\4a{_a(0.2)}" if mode == "fade" else "")
                doc.add(2, t0, s, f"{{{enter(t0, s)}{look}}}{text}")
            # While it is being said.
            act_col = st["hi"]
            extra = ""
            if mode in ("pop", "box") and grow != 1.0:
                g = round(100 * grow)
                extra = f"\\fscx100\\fscy100\\t(0,90,\\fscx{g}\\fscy{g})"
            if mode == "box":
                act_col = st.get("hi_text", "#FFFFFF")
            if mode == "marker":
                # Ink darkens as the highlighter passes under it.
                extra = f"\\t(0,120,\\1c{_c(st.get('hi_text', '#141414'))}\\3a&HFF&\\4a&HFF&)"
            if mode in ("glow", "fade"):
                act_col = st["color"]
            if mode == "reveal":
                extra = f"\\move({cx:.1f},{cy + em * 0.16:.1f},{cx:.1f},{cy:.1f},0,110)\\fad(90,0)"
                look = _look(font, em, st["hi"], st.get("outline"), st.get("shadow"))
                doc.add(2, s, nxt, f"{{\\an5{look}{extra}}}{text}")
            else:
                look = _look(font, em, act_col, st.get("outline"), st.get("shadow"))
                doc.add(2, s, nxt, f"{{{enter(s, nxt)}{look}{extra}}}{text}")
            if mode == "box":
                bw, bh = w["w"], em * 1.24
                doc.add(0, s, nxt, f"{{{pos}\\bord0\\shad0\\1c{_c(st['hi'])}{extra}\\p1}}{rrect(bw, bh, em * 0.22)}{{\\p0}}")
            if mode == "marker":
                bw, bh = w["w"], em * 0.98
                x0, y0 = cx - bw / 2, cy - bh / 2
                doc.add(0, s, nxt, f"{{{pos}\\bord0\\shad0\\1c{_c(st['hi'])}\\clip({x0:.0f},{y0:.0f},{x0 + 1:.0f},{y0 + bh:.0f})"
                                   f"\\t(0,120,\\clip({x0:.0f},{y0:.0f},{x0 + bw:.0f},{y0 + bh:.0f}))\\p1}}"
                                   f"{rrect(bw, bh, em * 0.14)}{{\\p0}}")
            if mode == "glow":
                doc.add(1, s, nxt, f"{{{pos}\\fn{font}\\fs{em * cell_ratio(font):.1f}\\bord{em * 0.14:.1f}\\3c{_c(st['hi'])}"
                                   f"\\3a&H20&\\1a&HFF&\\shad0\\blur{em * 0.2:.1f}}}{text}")
            # After it was said.
            if nxt < t1:
                col = st["hi"] if st.get("past") == "hi" or mode == "reveal" else st["color"]
                if mode == "reveal":
                    col = st["color"]
                look = _look(font, em, col, st.get("outline"), st.get("shadow"))
                doc.add(2, nxt, t1, f"{{{enter(nxt, t1)}{look}}}{text}")


# ------------------------------------------------------------ free text -----
def text_layout(o: dict, W: int, H: int) -> dict:
    st = text_style(o.get("style", "headline"))
    font = o.get("font") or st["font"]
    if font not in FONTS:
        font = st["font"]
    em = float(o.get("size") or st["size"]) * min(W, H) / 1080
    upper = st.get("upper", False) if o.get("upper") is None else bool(o["upper"])
    raw = o.get("text", "")
    lines = [ln for ln in (raw.upper() if upper else raw).split("\n")]
    lh = em * 1.18
    widths = [width(font, em, ln) for ln in lines]
    cx, cy = float(o.get("x", 0.5)) * W, float(o.get("y", 0.5)) * H
    return {"font": font, "em": em, "lh": lh, "lines": lines, "widths": widths, "cx": cx, "cy": cy, "style": st,
            "color": o.get("color") or st["color"], "accent": o.get("accent") or (st.get("box") or {}).get("color")
            or st.get("glow") or "#FF8A3D"}


def text_events(doc: Doc, o: dict) -> None:
    W, H = doc.W, doc.H
    L = text_layout(o, W, H)
    st, em, lh = L["style"], L["em"], L["lh"]
    t0 = float(o["start"])
    t1 = t0 + float(o.get("dur", 3))
    anim = o.get("anim", "pop")
    out = o.get("out", "fade")
    n = len(L["lines"])
    dur_ms = int((t1 - t0) * 1000)

    def motion(x: float, y: float) -> str:
        fin = 220 if anim in ("fade", "pop", "up", "left") else 0
        fout = 220 if out == "fade" else 0
        fad = f"\\fad({fin},{fout})" if fin or fout else ""
        if anim == "up":
            return f"\\an5\\move({x:.1f},{y + em * 0.7:.1f},{x:.1f},{y:.1f},0,280){fad}"
        if anim == "left":
            return f"\\an5\\move({x + W * 0.07:.1f},{y:.1f},{x:.1f},{y:.1f},0,280){fad}"
        pop = "\\fscx45\\fscy45\\t(0,150,\\fscx106\\fscy106)\\t(150,230,\\fscx100\\fscy100)" if anim == "pop" else ""
        return f"\\an5\\pos({x:.1f},{y:.1f}){fad}{pop}"

    block_h = lh * n
    top = L["cy"] - block_h / 2
    if st.get("box"):
        b = st["box"]
        bp = b["pad"] * em
        bw = max(L["widths"] or [0]) + 2 * bp
        bh = block_h + bp * 0.9
        doc.add(0, t0, t1, f"{{{motion(L['cx'], L['cy'])}\\bord0\\shad0\\1c{_c(L['accent'])}\\1a{_a(b['alpha'])}\\p1}}"
                           f"{rrect(bw, bh, b['radius'] * em)}{{\\p0}}")
    typed = 0
    per_char = min(6.0, max(2.0, (dur_ms * 0.45) / 10 / max(1, sum(len(x) for x in L["lines"]))))
    for i, ln in enumerate(L["lines"]):
        if not ln.strip():
            typed += 1
            continue
        y = top + lh * (i + 0.5)
        look = _look(L["font"], em, L["color"], st.get("outline"), st.get("shadow"))
        body = _esc(ln)
        if anim == "type":
            delay = round(typed * per_char)
            body = (f"{{\\ko{delay}}}" if delay else "") + "".join(f"{{\\ko{round(per_char)}}}{_esc(ch)}" for ch in ln)
            look += "\\2a&HFF&"
            typed += len(ln)
        if st.get("glow"):
            doc.add(1, t0, t1, f"{{{motion(L['cx'], y)}\\fn{L['font']}\\fs{em * cell_ratio(L['font']):.1f}\\bord{em * 0.16:.1f}"
                               f"\\3c{_c(L['accent'])}\\3a&H10&\\1a&HFF&\\2a&HFF&\\shad0\\blur{em * 0.24:.1f}\\q2}}{body}")
        doc.add(2, t0, t1, f"{{{motion(L['cx'], y)}{look}\\q2}}{body}")


def write_ass(path: Path, W: int, H: int, caption_layout: dict | None, texts: list[dict]) -> bool:
    doc = Doc(W, H)
    if caption_layout:
        caption_events(doc, caption_layout)
    for o in texts:
        if o.get("text", "").strip():
            text_events(doc, o)
    if not doc.lines:
        return False
    path.write_text(doc.text(), encoding="utf-8")
    return True


# ------------------------------------------------------------------- SRT ----
def srt(words: list[dict]) -> str:
    """Plain captions for YouTube: about 7 words a line."""
    def ts(t: float) -> str:
        ms = int(round(max(0.0, t) * 1000))
        h, ms = divmod(ms, 3600000)
        m, ms = divmod(ms, 60000)
        s, ms = divmod(ms, 1000)
        return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"

    cues, line = [], []
    for w in words:
        if line and (w["s"] - line[-1]["e"] > 0.8):
            cues.append(line)
            line = []
        line.append(w)
        if len(line) >= 7 or w["text"].endswith((".", "?", "!")):
            cues.append(line)
            line = []
    if line:
        cues.append(line)
    return "".join(f"{i}\n{ts(c[0]['s'])} --> {ts(max(c[-1]['e'], c[0]['s'] + 0.5))}\n{' '.join(x['text'] for x in c)}\n\n"
                   for i, c in enumerate(cues, 1))
