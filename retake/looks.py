"""The ready-made looks: caption templates, text styles, filters and transitions.

Defined once here; the window gets them from /api/looks and draws its preview
from the same numbers the export uses. Sizes are in pixels for a 1080 px tall
(or wide, if portrait) frame; outlines, shadows and paddings are fractions of
the font size, so every look scales cleanly.
"""

from __future__ import annotations

# Font name (as the export knows it) -> file in assets/fonts, and the CSS
# family + weight the window uses for the same face.
FONTS: dict[str, dict] = {
    "Poppins Black": {"file": "Poppins-Black.ttf", "css": "Poppins", "weight": 900},
    "Poppins ExtraBold": {"file": "Poppins-ExtraBold.ttf", "css": "Poppins", "weight": 800},
    "Poppins SemiBold": {"file": "Poppins-SemiBold.ttf", "css": "Poppins", "weight": 600},
    "Anton": {"file": "Anton-Regular.ttf", "css": "Anton", "weight": 400},
    "Bebas Neue": {"file": "BebasNeue-Regular.ttf", "css": "Bebas Neue", "weight": 400},
    "Bangers": {"file": "Bangers-Regular.ttf", "css": "Bangers", "weight": 400},
    "Archivo Black": {"file": "ArchivoBlack-Regular.ttf", "css": "Archivo Black", "weight": 400},
    "Luckiest Guy": {"file": "LuckiestGuy-Regular.ttf", "css": "Luckiest Guy", "weight": 400},
    "Permanent Marker": {"file": "PermanentMarker-Regular.ttf", "css": "Permanent Marker", "weight": 400},
    "DM Serif Display": {"file": "DMSerifDisplay-Regular.ttf", "css": "DM Serif Display", "weight": 400},
}

# Caption modes:
#   karaoke  every word of the line shows; the spoken word changes colour
#   pop      like karaoke, and the spoken word grows a little
#   box      the spoken word sits in a coloured box
#   marker   a highlighter sweeps behind the spoken word
#   glow     the spoken word glows
#   reveal   words appear as they are said
#   single   one big word at a time
#   fade     the line shows dim and lights up as it is said
#   plain    a classic subtitle line, no word timing
CAPTIONS: list[dict] = [
    {"id": "pop", "name": "Pop", "font": "Poppins Black", "size": 78, "upper": True, "strip": True,
     "color": "#FFFFFF", "hi": "#3DFF8B", "outline": {"color": "#000000", "w": 0.11}, "shadow": {"y": 0.07, "alpha": 0.55},
     "words": 3, "lines": 1, "y": 0.78, "mode": "pop", "grow": 1.14},
    {"id": "karaoke", "name": "Karaoke", "font": "Poppins ExtraBold", "size": 64, "upper": False, "strip": False,
     "color": "#FFFFFF", "hi": "#FFD43B", "outline": {"color": "#000000", "w": 0.09}, "shadow": {"y": 0.06, "alpha": 0.5},
     "words": 6, "lines": 2, "y": 0.8, "mode": "karaoke", "past": "hi"},
    {"id": "box", "name": "Word box", "font": "Poppins ExtraBold", "size": 66, "upper": True, "strip": True,
     "color": "#FFFFFF", "hi": "#7C5CFF", "hi_text": "#FFFFFF", "outline": {"color": "#000000", "w": 0.08},
     "shadow": {"y": 0.06, "alpha": 0.5}, "words": 4, "lines": 1, "y": 0.78, "mode": "box", "grow": 1.06},
    {"id": "impact", "name": "Impact", "font": "Anton", "size": 104, "upper": True, "strip": True,
     "color": "#FFFFFF", "hi": "#FFE600", "outline": {"color": "#000000", "w": 0.1}, "shadow": {"y": 0.08, "alpha": 0.6},
     "words": 2, "lines": 1, "y": 0.72, "mode": "pop", "grow": 1.1},
    {"id": "comic", "name": "Comic", "font": "Bangers", "size": 92, "upper": True, "strip": True,
     "color": "#FFFFFF", "hi": "#FF4FD8", "outline": {"color": "#111111", "w": 0.12}, "shadow": {"y": 0.09, "alpha": 0.7},
     "words": 3, "lines": 1, "y": 0.76, "mode": "pop", "grow": 1.18},
    {"id": "highlighter", "name": "Highlighter", "font": "Poppins ExtraBold", "size": 62, "upper": False, "strip": False,
     "color": "#FFFFFF", "hi": "#FFE14D", "hi_text": "#141414", "outline": {"color": "#000000", "w": 0.07},
     "shadow": {"y": 0.05, "alpha": 0.45}, "words": 5, "lines": 2, "y": 0.8, "mode": "marker"},
    {"id": "neon", "name": "Neon", "font": "Poppins SemiBold", "size": 64, "upper": False, "strip": False,
     "color": "#F4F7FF", "hi": "#33E1FF", "outline": {"color": "#0A1830", "w": 0.05}, "shadow": {"y": 0.0, "alpha": 0.0},
     "words": 5, "lines": 2, "y": 0.8, "mode": "glow"},
    {"id": "reveal", "name": "Reveal", "font": "Archivo Black", "size": 64, "upper": False, "strip": False,
     "color": "#FFFFFF", "hi": "#FF8A3D", "outline": {"color": "#000000", "w": 0.08}, "shadow": {"y": 0.06, "alpha": 0.5},
     "words": 7, "lines": 2, "y": 0.8, "mode": "reveal"},
    {"id": "oneword", "name": "One word", "font": "Luckiest Guy", "size": 124, "upper": True, "strip": True,
     "color": "#FFFFFF", "hi": "#FFE14D", "alt": ["#FFFFFF", "#FFE14D", "#3DFF8B", "#FF6B6B"],
     "outline": {"color": "#000000", "w": 0.1}, "shadow": {"y": 0.08, "alpha": 0.6},
     "words": 1, "lines": 1, "y": 0.62, "mode": "single", "grow": 1.0},
    {"id": "tall", "name": "Tall", "font": "Bebas Neue", "size": 104, "upper": True, "strip": True,
     "color": "#FFFFFF", "hi": "#FF8A3D", "outline": {"color": "#000000", "w": 0.06}, "shadow": {"y": 0.06, "alpha": 0.6},
     "words": 4, "lines": 1, "y": 0.78, "mode": "karaoke", "enter": "up"},
    {"id": "elegant", "name": "Elegant", "font": "DM Serif Display", "size": 70, "upper": False, "strip": False,
     "color": "#FFFFFF", "hi": "#FFFFFF", "outline": {"color": "#000000", "w": 0.03}, "shadow": {"y": 0.06, "alpha": 0.6},
     "words": 6, "lines": 2, "y": 0.8, "mode": "fade"},
    {"id": "subtitle", "name": "Subtitle", "font": "Poppins SemiBold", "size": 50, "upper": False, "strip": False,
     "color": "#FFFFFF", "hi": "#FFFFFF", "outline": {"color": "#000000", "w": 0.0}, "shadow": {"y": 0.0, "alpha": 0.0},
     "box": {"color": "#000000", "alpha": 0.62, "pad": 0.36, "radius": 0.3},
     "words": 10, "lines": 2, "y": 0.86, "mode": "plain"},
]

# Free text on screen.
TEXT_STYLES: list[dict] = [
    {"id": "headline", "name": "Headline", "font": "Poppins Black", "size": 96, "color": "#FFFFFF",
     "outline": {"color": "#000000", "w": 0.0}, "shadow": {"y": 0.07, "alpha": 0.55}},
    {"id": "outline", "name": "Outline", "font": "Anton", "size": 120, "upper": True, "color": "#FFFFFF",
     "outline": {"color": "#000000", "w": 0.1}, "shadow": {"y": 0.06, "alpha": 0.5}},
    {"id": "boxed", "name": "Boxed", "font": "Poppins ExtraBold", "size": 64, "color": "#141414",
     "box": {"color": "#FFE14D", "alpha": 1.0, "pad": 0.4, "radius": 0.28}},
    {"id": "dark", "name": "Dark pill", "font": "Poppins SemiBold", "size": 52, "color": "#FFFFFF",
     "box": {"color": "#0B0D12", "alpha": 0.82, "pad": 0.5, "radius": 0.9}},
    {"id": "neon", "name": "Neon", "font": "Poppins SemiBold", "size": 84, "color": "#F4F7FF", "glow": "#FF3DCB",
     "outline": {"color": "#2A0A24", "w": 0.04}},
    {"id": "marker", "name": "Marker", "font": "Permanent Marker", "size": 88, "color": "#FFE14D",
     "outline": {"color": "#000000", "w": 0.06}, "shadow": {"y": 0.05, "alpha": 0.5}},
    {"id": "comic", "name": "Comic", "font": "Bangers", "size": 110, "upper": True, "color": "#FFE600",
     "outline": {"color": "#111111", "w": 0.12}, "shadow": {"y": 0.09, "alpha": 0.7}},
    {"id": "serif", "name": "Serif", "font": "DM Serif Display", "size": 92, "color": "#FFFFFF",
     "shadow": {"y": 0.06, "alpha": 0.6}},
    {"id": "tall", "name": "Tall", "font": "Bebas Neue", "size": 140, "upper": True, "color": "#FFFFFF",
     "shadow": {"y": 0.05, "alpha": 0.6}},
    {"id": "fun", "name": "Fun", "font": "Luckiest Guy", "size": 100, "upper": True, "color": "#FFFFFF",
     "outline": {"color": "#FF4FD8", "w": 0.1}, "shadow": {"y": 0.08, "alpha": 0.6}},
]

TEXT_ANIMS = ["none", "fade", "pop", "up", "left", "type"]

# Colour looks for clips. Values are added to the clip's own adjustments.
FILTERS: list[dict] = [
    {"id": "none", "name": "Original", "adj": {}},
    {"id": "vivid", "name": "Vivid", "adj": {"saturation": 0.35, "contrast": 0.08}},
    {"id": "warm", "name": "Warm", "adj": {"temperature": 0.45, "saturation": 0.1}},
    {"id": "cool", "name": "Cool", "adj": {"temperature": -0.45, "contrast": 0.05}},
    {"id": "punch", "name": "Punchy", "adj": {"contrast": 0.22, "saturation": 0.2, "vignette": 0.35}},
    {"id": "film", "name": "Film", "adj": {"contrast": -0.08, "saturation": -0.22, "temperature": 0.2, "vignette": 0.45}},
    {"id": "fade", "name": "Faded", "adj": {"contrast": -0.2, "brightness": 0.05, "saturation": -0.15}},
    {"id": "mono", "name": "Mono", "adj": {"saturation": -1.0, "contrast": 0.12}},
    {"id": "noir", "name": "Noir", "adj": {"saturation": -1.0, "contrast": 0.4, "brightness": -0.04, "vignette": 0.6}},
    {"id": "crisp", "name": "Crisp", "adj": {"sharpen": 0.6, "contrast": 0.06}},
    {"id": "bright", "name": "Bright", "adj": {"brightness": 0.08, "saturation": 0.08}},
    {"id": "moody", "name": "Moody", "adj": {"brightness": -0.06, "saturation": -0.1, "temperature": -0.25, "vignette": 0.5}},
]

# Transitions into a clip: our name -> ffmpeg xfade name.
TRANSITIONS: list[dict] = [
    {"id": "fade", "name": "Crossfade", "xfade": "fade"},
    {"id": "black", "name": "Dip to black", "xfade": "fadeblack"},
    {"id": "white", "name": "Flash", "xfade": "fadewhite"},
    {"id": "slide", "name": "Slide", "xfade": "slideleft"},
    {"id": "push", "name": "Push up", "xfade": "slideup"},
    {"id": "wipe", "name": "Wipe", "xfade": "wipeleft"},
    {"id": "smooth", "name": "Smooth", "xfade": "smoothleft"},
    {"id": "zoom", "name": "Zoom", "xfade": "zoomin"},
    {"id": "circle", "name": "Circle", "xfade": "circleopen"},
    {"id": "blur", "name": "Blur", "xfade": "hblur"},
    {"id": "pixel", "name": "Pixels", "xfade": "pixelize"},
    {"id": "radial", "name": "Radial", "xfade": "radial"},
]

ASPECTS = {"16:9": (1920, 1080), "9:16": (1080, 1920), "1:1": (1080, 1080), "4:5": (1080, 1350)}


def caption_template(cid: str) -> dict:
    return next((c for c in CAPTIONS if c["id"] == cid), CAPTIONS[0])


def text_style(sid: str) -> dict:
    return next((s for s in TEXT_STYLES if s["id"] == sid), TEXT_STYLES[0])


def transition(tid: str) -> dict | None:
    return next((t for t in TRANSITIONS if t["id"] == tid), None)


def filter_adj(fid: str) -> dict:
    return next((f["adj"] for f in FILTERS if f["id"] == fid), {})


def all_looks() -> dict:
    return {"fonts": {k: {"css": v["css"], "weight": v["weight"], "file": v["file"]} for k, v in FONTS.items()},
            "captions": CAPTIONS, "texts": TEXT_STYLES, "textAnims": TEXT_ANIMS,
            "filters": FILTERS, "transitions": TRANSITIONS, "aspects": {k: list(v) for k, v in ASPECTS.items()}}
