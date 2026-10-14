/**
 * Frame-accurate pictures from video and image files.
 *
 * Each open video keeps one decoder. While playing, it reads forward
 * frame by frame (cheap); when you jump, it seeks to the frame that is on
 * screen at that moment, which for screen recordings may have been stored
 * long before (they only save a frame when something changes). Only the
 * newest request matters: a scrub that has moved on drops older requests.
 * Every frame is closed as soon as a newer one replaces it, so memory stays
 * flat however long the video is.
 */
import { ALL_FORMATS, Input, UrlSource, VideoSampleSink } from "mediabunny";
import type { VideoSample } from "mediabunny";

export type Drawable = VideoFrame | ImageBitmap | OffscreenCanvas | HTMLCanvasElement;

export interface Frame {
  source: Drawable;
  /** Size as displayed (after the file's rotation). */
  width: number;
  height: number;
  /** Quarter turns to apply when drawing (phone video stores this separately). */
  rotation: number;
  timestamp: number;
  /** False while an older frame stands in for the one asked for. */
  exact: boolean;
}

class VideoReader {
  private input: Input;
  private sink: Promise<VideoSampleSink | null>;
  private current: VideoSample | null = null;
  private next: VideoSample | null = null;
  private iter: AsyncGenerator<VideoSample, void, unknown> | null = null;
  private busy = false;
  private wanted = -1;
  private wantSeq = false;
  lastUsed = 0;
  failed: string | null = null;
  onFrame: (() => void) | null = null;

  constructor(readonly url: string) {
    this.input = new Input({ formats: ALL_FORMATS, source: new UrlSource(url) });
    this.sink = this.input.getPrimaryVideoTrack().then(async (track) => {
      if (!track) throw new Error("No video in this file");
      if (!(await track.canDecode())) throw new Error("This video can't be decoded here");
      return new VideoSampleSink(track);
    }).catch((e) => { this.failed = String(e?.message ?? e); return null; });
  }

  /** The frame on screen at t, if decoded. Starts work to get it if not. */
  frameAt(t: number, playing: boolean): Frame | null {
    this.lastUsed = performance.now();
    this.wanted = t;
    this.wantSeq = playing;
    if (!this.busy) void this.pump();
    const s = this.current;
    if (!s) return null;
    const turned = s.rotation % 180 !== 0;
    return {
      source: s.toCanvasImageSource() as Drawable,
      width: turned ? s.squarePixelHeight : s.squarePixelWidth,
      height: turned ? s.squarePixelWidth : s.squarePixelHeight,
      rotation: s.rotation, timestamp: s.timestamp, exact: this.covers(s, t) || this.atEnd(s, t),
    };
  }

  /** Past the last frame of the file: the last frame is the right one. */
  private atEnd(s: VideoSample, t: number) {
    return this.ended && t >= s.timestamp;
  }
  private ended = false;

  private covers(s: VideoSample | null, t: number) {
    return !!s && s.timestamp <= t + 1e-4 && t < s.timestamp + Math.max(s.duration, 1e-3) - 1e-4;
  }

  private async pump() {
    this.busy = true;
    try {
      const sink = await this.sink;
      if (!sink) return;
      for (let guard = 0; guard < 600; guard++) {
        const t = this.wanted;
        if (this.covers(this.current, t)) break;
        // Close enough ahead while playing: read forward instead of seeking.
        if (this.wantSeq && this.iter && this.current && t > this.current.timestamp && t - this.current.timestamp < 2.5) {
          if (!this.next) {
            const r = await this.iter.next();
            if (r.done) { this.iter = null; this.ended = true; break; }
            this.next = r.value;
          }
          if (this.next.timestamp <= t + 1e-4) {
            this.replace(this.next);
            this.next = null;
            continue;
          }
          break; // the next frame isn't due yet; keep showing the current one
        }
        // A jump: find the frame on screen at t, then (if playing) read on from there.
        this.stopIter();
        const s = await sink.getSample(Math.max(0, t));
        if (!s) break;
        // A frame that ends before t means t is past the end of the file.
        this.ended = s.timestamp + Math.max(s.duration, 1e-3) <= t;
        this.replace(s);
        if (this.wantSeq) this.iter = sink.samples(s.timestamp + Math.max(s.duration, 1e-3) / 2);
        if (Math.abs(this.wanted - t) < 1e-6) break;
      }
    } catch (e) {
      this.failed = String((e as Error)?.message ?? e);
    } finally {
      this.busy = false;
    }
    // A request arrived while busy that the current frame doesn't satisfy.
    if (!this.covers(this.current, this.wanted) && !this.failed && performance.now() - this.lastUsed < 1000) {
      setTimeout(() => { if (!this.busy) void this.pump(); }, 0);
    }
  }

  private replace(s: VideoSample) {
    const old = this.current;
    this.current = s;
    if (old && old !== s) old.close();
    this.onFrame?.();
  }

  private stopIter() {
    if (this.next) { this.next.close(); this.next = null; }
    if (this.iter) { void this.iter.return(undefined); this.iter = null; }
  }

  dispose() {
    this.stopIter();
    this.current?.close();
    this.current = null;
    this.input.dispose();
  }
}

class ImageReader {
  bitmap: ImageBitmap | null = null;
  failed: string | null = null;
  lastUsed = 0;
  onFrame: (() => void) | null = null;
  constructor(readonly url: string) {
    fetch(url)
      .then((r) => { if (!r.ok) throw new Error(`${r.status}`); return r.blob(); })
      .then((b) => createImageBitmap(b, { premultiplyAlpha: "none" }))
      .then((bm) => { this.bitmap = bm; this.onFrame?.(); })
      .catch((e) => { this.failed = String(e?.message ?? e); });
  }
  frame(): Frame | null {
    this.lastUsed = performance.now();
    const b = this.bitmap;
    return b ? { source: b, width: b.width, height: b.height, rotation: 0, timestamp: 0, exact: true } : null;
  }
  dispose() { this.bitmap?.close(); this.bitmap = null; }
}

/** All open pictures. A video can be open twice ("lanes") when a transition
 *  shows two moments of the same recording at once. */
export class MediaPool {
  private videos = new Map<string, VideoReader>();
  private images = new Map<string, ImageReader>();
  onFrame: (() => void) | null = null;

  video(url: string, t: number, playing: boolean, lane = 0): Frame | null {
    const key = `${lane}|${url}`;
    let r = this.videos.get(key);
    if (!r) {
      r = new VideoReader(url);
      r.onFrame = () => this.onFrame?.();
      this.videos.set(key, r);
    }
    return r.frameAt(t, playing);
  }

  image(url: string): Frame | null {
    let r = this.images.get(url);
    if (!r) {
      r = new ImageReader(url);
      r.onFrame = () => this.onFrame?.();
      this.images.set(url, r);
    }
    return r.frame();
  }

  errors(): string[] {
    return [...this.videos.values(), ...this.images.values()].filter((r) => r.failed).map((r) => `${r.url}: ${r.failed}`);
  }

  /** Close decoders nobody asked for in a while (keeps memory and GPU use low). */
  sweep(idleMs = 8000) {
    const now = performance.now();
    for (const [k, r] of this.videos) if (now - r.lastUsed > idleMs) { r.dispose(); this.videos.delete(k); }
    for (const [k, r] of this.images) if (now - r.lastUsed > idleMs * 6) { r.dispose(); this.images.delete(k); }
  }

  dispose() {
    for (const r of this.videos.values()) r.dispose();
    for (const r of this.images.values()) r.dispose();
    this.videos.clear();
    this.images.clear();
  }
}
