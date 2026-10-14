"""On-screen graphics drawn as transparent PNGs: labels, lower thirds, title cards."""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

FONTS = Path(__file__).parent / "assets" / "fonts"


def _font(name: str, size: int, weight: int) -> ImageFont.FreeTypeFont:
    f = ImageFont.truetype(str(FONTS / name), size)
    try:
        f.set_variation_by_axes([weight])
    except Exception:  # noqa: BLE001 - static fonts have no axes
        pass
    return f


def grotesk(size: int, weight: int = 700) -> ImageFont.FreeTypeFont:
    return _font("SpaceGrotesk.ttf", size, weight)


def mono(size: int, weight: int = 700) -> ImageFont.FreeTypeFont:
    return _font("JetBrainsMono.ttf", size, weight)


def _rgb(hex_color: str, alpha: int = 255) -> tuple[int, int, int, int]:
    h = hex_color.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), alpha


def _shadowed(img: Image.Image, box, radius: int) -> Image.Image:
    sh = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(sh)
    x0, y0, x1, y1 = box
    d.rounded_rectangle((x0, y0 + 10, x1, y1 + 10), radius, fill=(0, 0, 0, 150))
    return Image.alpha_composite(sh.filter(ImageFilter.GaussianBlur(18)), img)


def _fit(d: ImageDraw.ImageDraw, text: str, font_fn, size: int, max_w: int, weight: int = 700):
    while size > 18:
        f = font_fn(size, weight)
        if d.textlength(text, font=f) <= max_w:
            return f
        size -= 2
    return font_fn(size, weight)


def label(text: str, tag: str, brand: dict, W: int, H: int) -> Image.Image:
    """Top-left chapter label: small coloured tag over a bold title."""
    s = H / 1080
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    f_tag = mono(int(26 * s))
    f_title = _fit(d, text, grotesk, int(46 * s), int(W * 0.62))
    w = int(max(d.textlength(text, font=f_title), d.textlength(tag, font=f_tag), 200 * s) + 64 * s)
    x0, y0 = int(56 * s), int(56 * s)
    box = (x0, y0, x0 + w, y0 + int(126 * s))
    d.rounded_rectangle(box, int(22 * s), fill=_rgb(brand["background"], 228), outline=(255, 255, 255, 28),
                        width=max(1, int(2 * s)))
    d.rounded_rectangle((x0, y0 + int(22 * s), x0 + int(6 * s), y0 + int(104 * s)), int(3 * s),
                        fill=_rgb(brand["accent"]))
    d.text((x0 + int(32 * s), y0 + int(20 * s)), tag, font=f_tag, fill=_rgb(brand["accent"]))
    d.text((x0 + int(32 * s), y0 + int(54 * s)), text, font=f_title, fill=_rgb(brand["text"]))
    return _shadowed(img, box, int(22 * s))


def lower_third(title: str, sub: str, kicker: str, brand: dict, W: int, H: int) -> Image.Image:
    s = H / 1080
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    f_k, f_s = mono(int(24 * s)), grotesk(int(30 * s), 500)
    f_t = _fit(d, title, grotesk, int(50 * s), int(W * 0.7))
    w = max(d.textlength(title, font=f_t), d.textlength(sub or "", font=f_s), d.textlength(kicker or "", font=f_k),
            240 * s) + 72 * s
    h = (166 if sub else 116) * s
    x0, y1 = int(64 * s), int(H - 70 * s)
    box = (x0, int(y1 - h), x0 + int(w), y1)
    d.rounded_rectangle(box, int(22 * s), fill=_rgb(brand["background"], 228), outline=(255, 255, 255, 28),
                        width=max(1, int(2 * s)))
    top = box[1]
    if kicker:
        d.text((x0 + int(36 * s), top + int(20 * s)), kicker.upper(), font=f_k, fill=_rgb(brand["accent"]))
    d.text((x0 + int(36 * s), top + int((50 if kicker else 30) * s)), title, font=f_t, fill=_rgb(brand["text"]))
    if sub:
        d.text((x0 + int(36 * s), top + int(108 * s)), sub, font=f_s, fill=_rgb(brand["text"], 170))
    return _shadowed(img, box, int(22 * s))


def title_card(title: str, sub: str, kicker: str, brand: dict, W: int, H: int) -> Image.Image:
    s = H / 1080
    img = Image.new("RGBA", (W, H), _rgb(brand["background"]))
    d = ImageDraw.Draw(img)
    lines = _wrap(d, title, grotesk(int(104 * s)), int(W * 0.82))
    f_t = grotesk(int(104 * s)) if len(lines) <= 2 else grotesk(int(84 * s))
    lines = _wrap(d, title, f_t, int(W * 0.82))
    line_h = int(f_t.size * 1.22)
    block = line_h * len(lines)
    y = H / 2 - block / 2 - (30 * s if sub else 0)
    if kicker:
        d.text((W / 2, y - 70 * s), kicker.upper(), font=mono(int(30 * s)), fill=_rgb(brand["accent"]), anchor="mm")
    for i, ln in enumerate(lines):
        color = _rgb(brand["accent"]) if (i == len(lines) - 1 and len(lines) > 1) else _rgb(brand["text"])
        d.text((W / 2, y + line_h * i + line_h / 2), ln, font=f_t, fill=color, anchor="mm")
    if sub:
        d.text((W / 2, y + block + 60 * s), sub, font=grotesk(int(42 * s), 500), fill=_rgb(brand["text"], 160),
               anchor="mm")
    return img


def caption(text: str, brand: dict, W: int, H: int) -> Image.Image:
    s = H / 1080
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    f = _fit(d, text, grotesk, int(54 * s), int(W * 0.84), 700)
    tw = d.textlength(text, font=f)
    cx, cy = W / 2, H - 120 * s
    pad_x, pad_y = 28 * s, 16 * s
    box = (int(cx - tw / 2 - pad_x), int(cy - f.size / 2 - pad_y), int(cx + tw / 2 + pad_x), int(cy + f.size / 2 + pad_y))
    d.rounded_rectangle(box, int(16 * s), fill=(0, 0, 0, 170))
    d.text((cx, cy), text, font=f, fill=(255, 255, 255, 255), anchor="mm")
    return img


def _wrap(d, text: str, font, max_w: int) -> list[str]:
    words, lines, cur = text.split(), [], ""
    for w in words:
        trial = (cur + " " + w).strip()
        if d.textlength(trial, font=font) <= max_w or not cur:
            cur = trial
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def render_overlay(o: dict, brand: dict, W: int, H: int) -> Image.Image:
    kind = o.get("kind", "label")
    if kind == "label":
        return label(o.get("text", ""), o.get("tag") or "", brand, W, H)
    if kind == "lower":
        return lower_third(o.get("text", ""), o.get("sub", ""), o.get("tag", ""), brand, W, H)
    if kind == "caption":
        return caption(o.get("text", ""), brand, W, H)
    raise ValueError(kind)
