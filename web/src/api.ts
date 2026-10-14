import type { Detection, Edit, Job, Manual, Project, ProjectSummary, Settings, Transcript } from "./types";

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const j = await res.json();
      if (j?.detail) msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail);
    } catch {
      /* not json */
    }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

export const api = {
  health: () => call<{ ok: boolean; version: string; ffmpeg: boolean; window: boolean }>("GET", "/api/health"),
  settings: () => call<Settings>("GET", "/api/settings"),
  saveSettings: (s: Partial<Settings>) => call<Settings>("POST", "/api/settings", s),
  clearSecret: (key: string) => call<Settings>("POST", "/api/settings/clear-secret", { key }),
  brainStatus: () => call<Record<string, { ok: boolean; message: string; path?: string }>>("GET", "/api/brain/status"),
  pickFolder: () => call<{ folder: string | null }>("POST", "/api/pick-folder"),

  projects: () => call<ProjectSummary[]>("GET", "/api/projects"),
  create: (folder: string, name?: string) => call<Project>("POST", "/api/projects", { folder, name }),
  forget: (id: string) => call<{ ok: boolean }>("DELETE", `/api/projects/${id}`),
  project: (id: string) => call<Project>("GET", `/api/projects/${id}`),
  rename: (id: string, name: string) => call<Project>("POST", `/api/projects/${id}/rename`, { name }),
  setRole: (id: string, sid: string, role: string) => call<Project>("POST", `/api/projects/${id}/sources/${sid}`, { role }),
  setTakes: (id: string, takes: { id?: string; voice: string; video: string | null }[]) =>
    call<Project>("POST", `/api/projects/${id}/takes`, { takes }),
  nudge: (id: string, tid: string, delta: number) => call<Project>("POST", `/api/projects/${id}/takes/${tid}/nudge`, { delta }),
  transcript: (id: string, tid: string) => call<Transcript>("GET", `/api/projects/${id}/takes/${tid}`),
  saveEdit: (id: string, edit: Edit) => call<{ ok: boolean }>("PUT", `/api/projects/${id}/edit`, edit),
  output: (id: string) =>
    call<{ fps: number; quality: string; auto: { width: number; height: number; fps: number } }>("GET", `/api/projects/${id}/output`),
  saveOutput: (id: string, o: { fps?: number; quality?: string }) =>
    call<{ fps: number; quality: string; auto: { width: number; height: number; fps: number } }>("PUT", `/api/projects/${id}/output`, o),

  startJob: (id: string, kind: string, args?: Record<string, unknown>) => call<Job>("POST", `/api/projects/${id}/jobs/${kind}`, args ?? {}),
  job: (id: string) => call<Job>("GET", `/api/projects/${id}/job`),

  privacy: (id: string) =>
    call<{ detections: Detection[]; dismissed?: string[]; manual?: Manual[]; scanned?: number }>("GET", `/api/projects/${id}/privacy`),
  dismiss: (id: string, key: string, on: boolean) => call<{ detections: Detection[]; dismissed?: string[]; manual?: Manual[] }>(
    "POST", `/api/projects/${id}/privacy/dismiss`, { key, on }),
  addManual: (id: string, m: Omit<Manual, "id">) => call<{ detections: Detection[]; dismissed?: string[]; manual?: Manual[] }>(
    "POST", `/api/projects/${id}/privacy/manual`, m),
  delManual: (id: string, mid: string) => call<{ detections: Detection[]; dismissed?: string[]; manual?: Manual[] }>(
    "DELETE", `/api/projects/${id}/privacy/manual/${mid}`),
  openExports: (id: string) => call<{ ok: boolean }>("POST", `/api/projects/${id}/open-exports`),
  reveal: (path: string) => call<{ ok: boolean }>("POST", "/api/reveal", { path }),
};

export const media = {
  proxy: (pid: string, sid: string) => `/media/${pid}/proxy/${sid}.mp4`,
  thumbs: (pid: string, sid: string) => `/media/${pid}/thumbs/${sid}.jpg`,
  frame: (pid: string, sid: string, t: number, w = 640) => `/api/projects/${pid}/frame?src=${sid}&t=${t.toFixed(2)}&w=${w}`,
  render: (pid: string, i: number) => `/media/${pid}/render/${i}`,
  overlay: (pid: string, o: { kind: string; text: string; sub?: string; tag?: string }) =>
    `/api/projects/${pid}/overlay.png?kind=${encodeURIComponent(o.kind)}&text=${encodeURIComponent(o.text)}` +
    `&sub=${encodeURIComponent(o.sub ?? "")}&tag=${encodeURIComponent(o.tag ?? "")}`,
};
