/**
 * Export an edit to MP4 entirely in the browser: the renderer draws every
 * frame, WebCodecs encodes it (on the graphics chip where there is one) and
 * Mediabunny writes the file. Sound is mixed a second at a time alongside.
 *
 * The file streams out in pieces to whatever `target` is (a file on disk,
 * the desktop engine, a download), so a long video never sits in memory.
 */
import { AudioSample, AudioSampleSource, CanvasSource, Mp4OutputFormat, Output, Quality, StreamTarget, canEncodeVideo } from "mediabunny";
import type { CaptionLayout, Looks } from "../types";
import { Mixer, RATE, type AudioSeg } from "./audio";
import { Renderer } from "./renderer";
import type { Scene } from "./scene";

export interface ExportOptions {
  scene: Scene;
  audio: AudioSeg[];
  layout: CaptionLayout | null;
  captions: boolean;
  looks: Looks | null;
  /** Video bits per second (default: about 12 Mbps at 1080p, scaled by size and rate). */
  bitrate?: number;
  /** Where the file goes: called with each piece and its byte position. */
  write: (data: Uint8Array, position: number) => Promise<void>;
  onProgress?: (fraction: number, message: string) => void;
  signal?: AbortSignal;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fonts must be loaded before text is drawn into a frame. */
async function loadFonts(looks: Looks | null) {
  if (!looks || typeof document === "undefined") return;
  await Promise.all(Object.values(looks.fonts).map((f) => document.fonts.load(`${f.weight} 40px "${f.css}"`).catch(() => [])));
}

export async function exportVideo(o: ExportOptions): Promise<{ frames: number; seconds: number }> {
  const { scene } = o;
  const W = scene.width - (scene.width % 2), H = scene.height - (scene.height % 2);
  const fps = scene.fps;
  const frames = Math.max(1, Math.round(scene.duration * fps));
  const say = (f: number, m: string) => o.onProgress?.(Math.min(1, Math.max(0, f)), m);
  const started = performance.now();

  const bitrate = o.bitrate ?? Math.round(12e6 * (W * H) / (1920 * 1080) * Math.max(1, fps / 30) ** 0.6);
  if (!(await canEncodeVideo("avc", { width: W, height: H, bitrate }))) {
    throw new Error("This device can't encode H.264 video at this size.");
  }
  await loadFonts(o.looks);

  const canvas = new OffscreenCanvas(W, H);
  const renderer = new Renderer(canvas);
  const output = new Output({
    format: new Mp4OutputFormat(),
    target: new StreamTarget(new WritableStream({ write: (chunk) => o.write(chunk.data, chunk.position) }), { chunked: true, chunkSize: 8 * 2 ** 20 }),
  });
  const video = new CanvasSource(canvas, { codec: "avc", quality: new Quality({ bitrate }), keyFrameInterval: 2 });
  output.addVideoTrack(video, { frameRate: fps });
  const sound = new AudioSampleSource({ codec: "aac", quality: new Quality({ bitrate: 192e3 }) });
  output.addAudioTrack(sound);

  const mixer = new Mixer(o.audio, scene.duration);
  try {
    say(0, "Measuring loudness");
    await mixer.measure((f) => say(0.08 * f, "Measuring loudness"));
    await output.start();
    let audioDone = 0;
    const pushAudio = async (until: number) => {
      while (audioDone < Math.min(until, scene.duration) - 1e-6) {
        const t1 = Math.min(scene.duration, audioDone + 1);
        const [L, R] = await mixer.window(audioDone, t1);
        const data = new Float32Array(L.length * 2);
        data.set(L, 0);
        data.set(R, L.length);
        const sample = new AudioSample({ data, format: "f32-planar", numberOfChannels: 2, sampleRate: RATE, timestamp: audioDone });
        await sound.add(sample);
        sample.close();
        audioDone = t1;
      }
    };

    for (let i = 0; i < frames; i++) {
      if (o.signal?.aborted) throw new DOMException("Export stopped", "AbortError");
      const t = i / fps;
      const opts = { k: 1, playing: true, settle: false, layout: o.layout, captions: o.captions, looks: o.looks, exact: true };
      // Draw, and draw again until every picture for this moment has decoded.
      const deadline = performance.now() + 8000;
      renderer.render(scene, t, opts);
      while (renderer.missing > 0 && performance.now() < deadline) {
        await sleep(1);
        renderer.render(scene, t, opts);
      }
      await video.add(t, 1 / fps);
      if (i % Math.round(fps) === 0) {
        await pushAudio(t + 2);
        const el = (performance.now() - started) / 1000;
        const left = i > 0 ? (el / i) * (frames - i) : 0;
        say(0.08 + 0.9 * (i / frames), `Frame ${i} of ${frames}${i > fps * 3 ? `, about ${Math.ceil(left / 60)} min left` : ""}`);
      }
    }
    await pushAudio(scene.duration);
    video.close();
    sound.close();
    say(0.99, "Finishing the file");
    await output.finalize();
    say(1, "Done");
    return { frames, seconds: (performance.now() - started) / 1000 };
  } catch (e) {
    await output.cancel().catch(() => {});
    throw e;
  } finally {
    renderer.dispose();
  }
}
