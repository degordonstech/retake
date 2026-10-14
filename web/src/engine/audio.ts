/**
 * The sound of an edit, mixed in short windows so a long video never needs
 * its whole soundtrack in memory.
 *
 * Voice clips play their stretch of the recording (sped up or slowed down
 * without changing pitch), with tiny fades at the cuts. Music and sound
 * effects sit on top, and music marked "duck" dips while someone talks.
 * The whole mix is measured once, then levelled to a steady loudness.
 */
import { ALL_FORMATS, AudioBufferSink, Input, UrlSource } from "mediabunny";
import type { Edit, Project } from "../types";
import { clipDur, isTitle, speedOf, starts } from "../editor/model";

export const RATE = 48000;

export interface AudioSeg {
  url: string;
  /** Where it plays on the timeline, and for how long. */
  at: number;
  dur: number;
  /** Where it starts in its file. */
  from: number;
  speed: number;
  gain: number;
  fadeIn: number;
  fadeOut: number;
  /** Length of the file, when the sound repeats to fill its time. */
  loopLen: number | null;
  kind: "voice" | "music" | "effect";
  duck: boolean;
}

export function compileAudio(p: Project, edit: Edit, url: (sourceId: string) => string, assetUrl: (aid: string) => string): AudioSeg[] {
  const segs: AudioSeg[] = [];
  const st = starts(edit.clips);
  const takes = Object.fromEntries(p.takes.map((t) => [t.id, t]));
  edit.clips.forEach((c, i) => {
    if (isTitle(c) || c.mute) return;
    const take = takes[c.take];
    if (!take) return;
    segs.push({
      url: url(take.voice), at: st[i], dur: clipDur(c), from: c.a, speed: speedOf(c), gain: c.volume ?? 1,
      fadeIn: 0.02, fadeOut: 0.04, loopLen: null, kind: "voice", duck: false,
    });
  });
  const assets = Object.fromEntries(p.assets.map((a) => [a.id, a]));
  for (const s of edit.audio) {
    const a = assets[s.asset];
    if (!a || a.missing) continue;
    segs.push({
      url: assetUrl(a.id), at: s.start, dur: s.dur, from: s.in ?? 0, speed: 1, gain: s.volume ?? 0.6,
      fadeIn: s.fadeIn ?? 0, fadeOut: s.fadeOut ?? 0, loopLen: s.loop ? a.duration ?? null : null,
      kind: a.sfx ? "effect" : "music", duck: s.duck ?? false,
    });
  }
  for (const m of edit.media) {
    const a = assets[m.asset];
    if (!a || a.kind !== "video" || !a.has_audio || !(m.volume ?? 0)) continue;
    segs.push({
      url: assetUrl(a.id), at: m.start, dur: m.dur, from: m.in ?? 0, speed: 1, gain: m.volume ?? 0,
      fadeIn: 0.05, fadeOut: 0.05, loopLen: null, kind: "effect", duck: false,
    });
  }
  return segs;
}

/* --------------------------------------------------------------- decoding */
class Decoder {
  private sink: Promise<AudioBufferSink | null>;
  constructor(url: string) {
    const input = new Input({ formats: ALL_FORMATS, source: new UrlSource(url) });
    this.sink = input.getPrimaryAudioTrack().then((t) => (t ? new AudioBufferSink(t) : null)).catch(() => null);
  }

  /** Stereo samples at 48 kHz covering [t0, t1) of the file. */
  async read(t0: number, t1: number): Promise<[Float32Array, Float32Array]> {
    const n = Math.max(0, Math.round((t1 - t0) * RATE));
    const L = new Float32Array(n), R = new Float32Array(n);
    const sink = await this.sink;
    if (!sink || n === 0) return [L, R];
    for await (const { buffer, timestamp } of sink.buffers(Math.max(0, t0 - 0.05), t1 + 0.05)) {
      const sr = buffer.sampleRate;
      const a = buffer.getChannelData(0);
      const b = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : a;
      // Resample (linear) and place by timestamp.
      const step = sr / RATE;
      const first = Math.max(0, Math.ceil((timestamp - t0) * RATE));
      const last = Math.min(n, Math.floor((timestamp + buffer.duration - t0) * RATE));
      for (let i = first; i < last; i++) {
        const pos = (t0 + i / RATE - timestamp) * sr;
        const j = Math.floor(pos);
        if (j < 0 || j >= a.length) continue;
        const f = pos - j;
        const j2 = Math.min(a.length - 1, j + 1);
        L[i] = a[j] + (a[j2] - a[j]) * f;
        R[i] = b[j] + (b[j2] - b[j]) * f;
      }
      void step;
    }
    return [L, R];
  }
}

/* -------------------------------------------------------------- stretching */
/** Change speed without changing pitch (waveform-similarity overlap-add). */
export function stretch(ch: Float32Array[], speed: number): Float32Array[] {
  if (Math.abs(speed - 1) < 1e-3) return ch;
  const frame = 1920, hopOut = frame / 2, search = 480;
  const hopIn = hopOut * speed;
  const n = ch[0].length;
  const outLen = Math.floor(n / speed);
  const out = ch.map(() => new Float32Array(outLen + frame));
  const win = new Float32Array(frame);
  for (let i = 0; i < frame; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / frame);
  const mono = ch.length > 1 ? ch[0].map((v, i) => (v + ch[1][i]) / 2) : ch[0];
  let prev = 0; // input position of the last frame used
  for (let o = 0; o + frame <= out[0].length; o += hopOut) {
    const nominal = Math.round((o / hopOut) * hopIn);
    let best = nominal;
    if (o > 0) {
      // Pick the input position near nominal whose start best continues the last frame.
      const want = prev + hopOut;
      let bestScore = -Infinity;
      for (let d = -search; d <= search; d += 16) {
        const pos = nominal + d;
        if (pos < 0 || pos + frame >= n) continue;
        let score = 0;
        for (let k = 0; k < hopOut; k += 8) score += mono[pos + k] * (want + k < n ? mono[want + k] : 0);
        if (score > bestScore) { bestScore = score; best = pos; }
      }
    }
    if (best + frame >= n) break;
    for (let c = 0; c < ch.length; c++) {
      const src = ch[c], dst = out[c];
      for (let k = 0; k < frame; k++) dst[o + k] += src[best + k] * win[k];
    }
    prev = best;
  }
  return out.map((x) => x.subarray(0, outLen));
}

/* ------------------------------------------------------------------ mixing */
export class Mixer {
  private decoders = new Map<string, Decoder>();
  private stretched = new Map<AudioSeg, Promise<Float32Array[]>>();
  private duckGain = 1;
  /** Gain applied to the whole mix, set by measure(). */
  level = 1;

  constructor(readonly segs: AudioSeg[], readonly duration: number) {}

  private dec(url: string) {
    let d = this.decoders.get(url);
    if (!d) { d = new Decoder(url); this.decoders.set(url, d); }
    return d;
  }

  /** A voice clip played at another speed is stretched once, whole. */
  private stretchedSeg(s: AudioSeg) {
    let pr = this.stretched.get(s);
    if (!pr) {
      pr = this.dec(s.url).read(s.from, s.from + s.dur * s.speed).then((ch) => stretch(ch, s.speed));
      this.stretched.set(s, pr);
    }
    return pr;
  }

  /** The samples of one sound for timeline [t0, t1). */
  private async segment(s: AudioSeg, t0: number, t1: number): Promise<Float32Array[] | null> {
    const a = Math.max(t0, s.at), b = Math.min(t1, s.at + s.dur);
    if (b <= a) return null;
    if (s.speed !== 1) {
      const all = await this.stretchedSeg(s);
      const i0 = Math.round((a - s.at) * RATE), i1 = Math.round((b - s.at) * RATE);
      return all.map((c) => c.subarray(i0, Math.min(c.length, i1)));
    }
    if (s.loopLen && s.loopLen > 0) {
      const n = Math.round((b - a) * RATE);
      const L = new Float32Array(n), R = new Float32Array(n);
      let done = 0;
      while (done < n) {
        const pos = (s.from + (a - s.at) + done / RATE) % s.loopLen;
        const take = Math.min(n - done, Math.round((s.loopLen - pos) * RATE));
        if (take <= 0) break;
        const [l, r] = await this.dec(s.url).read(pos, pos + take / RATE);
        L.set(l.subarray(0, take), done);
        R.set(r.subarray(0, take), done);
        done += take;
      }
      return [L, R];
    }
    const from = s.from + (a - s.at);
    return this.dec(s.url).read(from, from + (b - a));
  }

  /** Mix timeline [t0, t1) into two channels. */
  async window(t0: number, t1: number): Promise<[Float32Array, Float32Array]> {
    const n = Math.round((t1 - t0) * RATE);
    const voice = [new Float32Array(n), new Float32Array(n)];
    const bed = [new Float32Array(n), new Float32Array(n)];
    const ducked = [new Float32Array(n), new Float32Array(n)];
    for (const s of this.segs) {
      const part = await this.segment(s, t0, t1);
      if (!part) continue;
      const off = Math.max(0, Math.round((s.at - t0) * RATE));
      const target = s.kind === "voice" ? voice : s.duck ? ducked : bed;
      const startInSeg = Math.max(t0, s.at) - s.at;
      for (let c = 0; c < 2; c++) {
        const src = part[Math.min(c, part.length - 1)], dst = target[c];
        for (let i = 0; i < src.length && off + i < n; i++) {
          const ts = startInSeg + i / RATE;
          let g = s.gain;
          if (s.fadeIn > 0 && ts < s.fadeIn) g *= ts / s.fadeIn;
          if (s.fadeOut > 0 && ts > s.dur - s.fadeOut) g *= Math.max(0, (s.dur - ts) / s.fadeOut);
          dst[off + i] += src[i] * g;
        }
      }
    }
    // Duck: follow the voice's level, dip the music while it's loud.
    const out: [Float32Array, Float32Array] = [new Float32Array(n), new Float32Array(n)];
    const block = 480; // 10 ms
    for (let i = 0; i < n; i += block) {
      let e = 0;
      const end = Math.min(n, i + block);
      for (let j = i; j < end; j++) e += voice[0][j] * voice[0][j];
      const rms = Math.sqrt(e / Math.max(1, end - i));
      const target = rms > 0.025 ? 0.28 : 1;
      const coef = target < this.duckGain ? 0.35 : 0.024; // ~25 ms down, ~420 ms back up
      this.duckGain += (target - this.duckGain) * coef;
      for (let j = i; j < end; j++) {
        for (let c = 0; c < 2; c++) {
          const v = (voice[c][j] + bed[c][j] + ducked[c][j] * this.duckGain) * this.level;
          // Gentle limiter so nothing clips.
          out[c][j] = Math.abs(v) > 0.84 ? Math.sign(v) * (0.84 + 0.16 * Math.tanh((Math.abs(v) - 0.84) / 0.16)) : v;
        }
      }
    }
    return out;
  }

  /** Measure the mix the way loudness meters do (ITU-R BS.1770: K-weighted,
   *  400 ms blocks, gated) and set a gain that brings it to -14 LUFS. */
  async measure(onProgress?: (f: number) => void, step = 10) {
    this.level = 1;
    const k = [new KWeight(), new KWeight()];
    const blocks: number[] = []; // mean square per 100 ms
    for (let t = 0; t < this.duration; t += step) {
      const ch = await this.window(t, Math.min(this.duration, t + step));
      const hop = RATE / 10;
      const n = ch[0].length;
      const sq = new Float64Array(Math.ceil(n / hop));
      for (let c = 0; c < 2; c++) {
        const f = k[c].run(ch[c]);
        for (let i = 0; i < n; i++) sq[Math.floor(i / hop)] += f[i] * f[i];
      }
      for (let b = 0; b < sq.length; b++) blocks.push(sq[b] / hop);
      onProgress?.(Math.min(1, (t + step) / this.duration));
    }
    this.duckGain = 1;
    // 400 ms blocks with 75 % overlap, from the 100 ms pieces.
    const z: number[] = [];
    for (let i = 0; i + 4 <= blocks.length; i++) z.push((blocks[i] + blocks[i + 1] + blocks[i + 2] + blocks[i + 3]) / 4);
    const lufs = (ms: number) => -0.691 + 10 * Math.log10(Math.max(ms, 1e-12));
    const abs = z.filter((v) => lufs(v) > -70);
    if (!abs.length) return;
    const rel = lufs(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
    const gated = abs.filter((v) => lufs(v) > rel);
    const loud = lufs(gated.reduce((a, b) => a + b, 0) / Math.max(1, gated.length));
    this.level = Math.min(8, Math.pow(10, (-14 - loud) / 20));
  }
}

/** The K-weighting filter of ITU-R BS.1770 at 48 kHz (a high shelf, then a high-pass). */
class KWeight {
  private s = [0, 0, 0, 0, 0, 0, 0, 0];
  run(x: Float32Array): Float32Array {
    const y = new Float32Array(x.length);
    // Stage 1: shelf. Stage 2: high-pass. Coefficients from the standard (48 kHz).
    const b0 = 1.53512485958697, b1 = -2.69169618940638, b2 = 1.19839281085285, a1 = -1.69065929318241, a2 = 0.73248077421585;
    const c0 = 1.0, c1 = -2.0, c2 = 1.0, d1 = -1.99004745483398, d2 = 0.99007225036621;
    let [x1, x2, y1, y2, u1, u2, v1, v2] = this.s;
    for (let i = 0; i < x.length; i++) {
      const xi = x[i];
      const yi = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = xi; y2 = y1; y1 = yi;
      const vi = c0 * yi + c1 * u1 + c2 * u2 - d1 * v1 - d2 * v2;
      u2 = u1; u1 = yi; v2 = v1; v1 = vi;
      y[i] = vi;
    }
    this.s = [x1, x2, y1, y2, u1, u2, v1, v2];
    return y;
  }
}
