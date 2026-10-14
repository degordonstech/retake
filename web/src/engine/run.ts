/**
 * Export the open project from this window with the engine, streaming the
 * file to the desktop engine as it is made.
 */
import { ALL_FORMATS, Input, UrlSource } from "mediabunny";
import { api, media } from "../api";
import type { Looks, Project } from "../types";
import { normalize } from "../editor/model";
import { compileAudio } from "./audio";
import { exportVideo } from "./export";
import { compileScene } from "./scene";

/** The full-quality original if this device can decode it, else the preview copy. */
async function bestUrl(pid: string, sid: string): Promise<string> {
  const original = media.source(pid, sid);
  try {
    const input = new Input({ formats: ALL_FORMATS, source: new UrlSource(original) });
    const track = await input.getPrimaryVideoTrack();
    const ok = !!track && (await track.canDecode());
    input.dispose();
    if (ok) return original;
  } catch { /* fall back */ }
  return media.proxy(pid, sid);
}

export async function exportInWindow(p: Project, looks: Looks | null, onProgress: (f: number, msg: string) => void,
  signal: AbortSignal): Promise<Project> {
  const edit = normalize(p.edit);
  const out = await api.output(p.id);
  const W = out.auto.width, H = out.auto.height, fps = out.auto.fps;
  onProgress(0, "Getting ready");
  const layout = edit.captions?.on ? await api.captionLayout(p.id, { clips: edit.clips, captions: edit.captions, format: edit.format }) : null;
  const blurs = await api.blurSpans(p.id).catch(() => ({}));
  const urls: Record<string, string> = {};
  for (const t of p.takes) if (t.video && !urls[t.video]) urls[t.video] = await bestUrl(p.id, t.video);
  const scene = compileScene({
    p, edit, looks, size: [W, H], fps,
    videoUrl: (sid) => urls[sid] ?? media.proxy(p.id, sid),
    assetUrl: (a) => media.asset(p.id, a.id),
    stillUrl: (o) => media.overlay(p.id, o, W, H),
    blurs,
  });
  const audio = compileAudio(p, edit, (sid) => media.proxy(p.id, sid), (aid) => media.asset(p.id, aid));
  const start = await api.streamStart(p.id, edit.format?.aspect ?? "16:9");
  await exportVideo({
    scene, audio, layout, captions: !!edit.captions?.on, looks, signal, onProgress,
    write: async (data, position) => {
      const r = await fetch(`/api/projects/${p.id}/stream-render/${start.token}?pos=${position}`, { method: "PUT", body: data });
      if (!r.ok) throw new Error(`Saving the file failed (${r.status})`);
    },
  });
  return api.streamDone(p.id, start.token, { duration: scene.duration, width: W, height: H, fps });
}
