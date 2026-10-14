"""Built-in sound effects, made here from scratch (no samples, no licences).

Each one is synthesised the first time it is used and kept in the app's data
folder, so it can be added to any project like an imported file.
"""

from __future__ import annotations

import wave
from pathlib import Path

import numpy as np

from .config import APP_DIR

RATE = 48000
DIR = APP_DIR / "sfx"
_rng = np.random.default_rng(7)


def _t(seconds: float) -> np.ndarray:
    return np.arange(int(seconds * RATE)) / RATE


def _env(n: int, attack: float, decay: float) -> np.ndarray:
    t = np.arange(n) / RATE
    a = np.clip(t / max(attack, 1e-4), 0, 1)
    return a * np.exp(-np.maximum(0, t - attack) / max(decay, 1e-4))


def _sweep(f0: float, f1: float, seconds: float, curve: float = 1.0) -> np.ndarray:
    t = _t(seconds)
    f = f0 + (f1 - f0) * (t / seconds) ** curve
    return np.sin(2 * np.pi * np.cumsum(f) / RATE)


def _lowpass(x: np.ndarray, cutoff: np.ndarray | float) -> np.ndarray:
    """One-pole low-pass; the cutoff may change over time."""
    c = np.broadcast_to(np.asarray(cutoff, dtype=float), x.shape)
    a = 1 - np.exp(-2 * np.pi * c / RATE)
    y = np.empty_like(x)
    acc = 0.0
    for i in range(len(x)):
        acc += a[i] * (x[i] - acc)
        y[i] = acc
    return y


def pop() -> np.ndarray:
    s = _sweep(1100, 260, 0.09, 0.5) * _env(int(0.09 * RATE), 0.002, 0.03)
    return s


def click() -> np.ndarray:
    n = int(0.03 * RATE)
    noise = _rng.standard_normal(n) * _env(n, 0.0005, 0.004)
    tone = np.sin(2 * np.pi * 2400 * _t(0.03)) * _env(n, 0.0005, 0.008) * 0.5
    return noise * 0.6 + tone


def ding() -> np.ndarray:
    t = _t(1.6)
    e = _env(len(t), 0.003, 0.45)
    return (np.sin(2 * np.pi * 1318.5 * t) + 0.35 * np.sin(2 * np.pi * 2637 * t) + 0.15 * np.sin(2 * np.pi * 3955 * t)) * e * 0.6


def whoosh() -> np.ndarray:
    d = 0.75
    t = _t(d)
    noise = _rng.standard_normal(len(t))
    shape = np.sin(np.pi * t / d) ** 2
    cutoff = 300 + 5200 * shape
    return _lowpass(noise, cutoff) * shape * 2.2


def rise() -> np.ndarray:
    d = 1.1
    t = _t(d)
    s = _sweep(180, 1500, d, 2.0) * (t / d) ** 1.5
    trem = 0.75 + 0.25 * np.sin(2 * np.pi * 18 * t)
    return s * trem * 0.6 * np.minimum(1, (d - t) / 0.04)


def boom() -> np.ndarray:
    d = 1.5
    n = int(d * RATE)
    body = _sweep(90, 38, d, 0.4) * _env(n, 0.004, 0.42)
    thump = _lowpass(_rng.standard_normal(n), 400) * _env(n, 0.001, 0.05) * 3
    return np.tanh((body + thump) * 1.6) * 0.8


def notify() -> np.ndarray:
    out = []
    for f, d in ((880, 0.12), (1318.5, 0.32)):
        t = _t(d)
        out.append((np.sin(2 * np.pi * f * t) + 0.2 * np.sin(4 * np.pi * f * t)) * _env(len(t), 0.004, d / 3) * 0.6)
    return np.concatenate(out)


def success() -> np.ndarray:
    out = []
    for f in (523.25, 659.25, 783.99, 1046.5):
        t = _t(0.16 if f < 1000 else 0.6)
        out.append((np.sin(2 * np.pi * f * t) + 0.25 * np.sin(4 * np.pi * f * t)) * _env(len(t), 0.003, 0.09 if f < 1000 else 0.25) * 0.55)
    return np.concatenate(out)


def error() -> np.ndarray:
    out = []
    for f in (220, 185):
        t = _t(0.22)
        sq = np.sign(np.sin(2 * np.pi * f * t))
        out.append(_lowpass(sq, 1800) * _env(len(t), 0.004, 0.12) * 0.35)
        out.append(np.zeros(int(0.04 * RATE)))
    return np.concatenate(out)


def typing() -> np.ndarray:
    d = 1.8
    x = np.zeros(int(d * RATE))
    t = 0.05
    while t < d - 0.05:
        k = click() * (0.5 + 0.5 * _rng.random())
        i = int(t * RATE)
        x[i:i + len(k)] += k[: len(x) - i]
        t += 0.07 + 0.11 * _rng.random()
    return x * 0.8


def shutter() -> np.ndarray:
    def snap(n: int) -> np.ndarray:
        return _lowpass(_rng.standard_normal(n), 3000) * _env(n, 0.0005, 0.012)

    n = int(0.05 * RATE)
    return np.concatenate([snap(n) * 1.4, np.zeros(int(0.06 * RATE)), snap(n)])


def glitch() -> np.ndarray:
    parts = []
    for _ in range(9):
        d = 0.02 + 0.05 * _rng.random()
        t = _t(d)
        f = 120 + 1600 * _rng.random()
        parts.append(np.sign(np.sin(2 * np.pi * f * t)) * 0.3 * (0.4 + 0.6 * _rng.random()))
    return np.concatenate(parts)


SOUNDS = {
    "pop": ("Pop", pop), "click": ("Click", click), "ding": ("Ding", ding), "whoosh": ("Whoosh", whoosh),
    "rise": ("Rise", rise), "boom": ("Boom", boom), "notify": ("Notification", notify), "success": ("Success", success),
    "error": ("Wrong", error), "typing": ("Typing", typing), "shutter": ("Camera", shutter), "glitch": ("Glitch", glitch),
}


def path(name: str) -> Path:
    """The sound's file, made on first use."""
    if name not in SOUNDS:
        raise KeyError(name)
    f = DIR / f"{name}.wav"
    if not f.exists():
        DIR.mkdir(parents=True, exist_ok=True)
        x = SOUNDS[name][1]().astype(np.float64)
        # Same peak for all, and none much louder than the rest.
        peak = float(np.max(np.abs(x))) or 1.0
        rms = float(np.sqrt(np.mean(x ** 2))) or 1.0
        x = x / max(peak / 0.85, rms / 0.22)
        tail = np.zeros(int(0.02 * RATE))
        x = np.concatenate([x, tail])
        pcm = (np.clip(x, -1, 1) * 32767).astype("<i2")
        stereo = np.repeat(pcm[:, None], 2, axis=1)
        tmp = f.with_suffix(".part.wav")
        with wave.open(str(tmp), "wb") as w:
            w.setnchannels(2)
            w.setsampwidth(2)
            w.setframerate(RATE)
            w.writeframes(stereo.tobytes())
        tmp.replace(f)
    return f


def catalog() -> list[dict]:
    return [{"id": k, "name": v[0]} for k, v in SOUNDS.items()]
