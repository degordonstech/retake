export type Role = "screen" | "voice" | "camera" | "skip";

export interface Source {
  id: string;
  file: string;
  role: Role;
  duration: number;
  has_video: boolean;
  has_audio: boolean;
  width: number;
  height: number;
  fps: number;
  vcodec: string | null;
  size: number;
  proxy?: boolean;
  thumbs?: { every: number; cols: number; rows: number; height: number; count: number };
}

export interface Take {
  id: string;
  name: string;
  kind: "screen" | "camera" | "audio";
  voice: string;
  video: string | null;
  duration: number;
  offsets: [number, number][];
  sync_score: number | null;
  ready: boolean;
}

export interface MediaClip {
  id: string;
  take: string;
  a: number;
  b: number;
  kind?: undefined;
}
export interface TitleClip {
  id: string;
  kind: "title";
  text: string;
  sub: string;
  tag: string;
  dur: number;
}
export type Clip = MediaClip | TitleClip;

export interface Overlay {
  id: string;
  kind: "label" | "lower" | "caption";
  text: string;
  sub?: string;
  tag?: string;
  start: number;
  dur: number;
  chapter?: boolean;
}

export interface Edit {
  clips: Clip[];
  overlays: Overlay[];
}

export interface BrainResult {
  chapters?: { title: string; take: string; word: number }[];
  notes?: { take: string; word: number; note: string }[];
  title?: string;
  description?: string;
  source?: string;
}

export interface RenderResult {
  file: string;
  srt: string;
  duration: number;
  width: number;
  height: number;
  fps: number;
  created: number;
  chapters: string;
  leaks: { t: number; kind: string; label: string; preview: string }[];
}

export interface Project {
  id: string;
  name: string;
  folder: string;
  stage: "sources" | "edit" | "privacy" | "done";
  created: number;
  updated: number;
  sources: Source[];
  takes: Take[];
  edit: Edit;
  privacy: { dismissed?: string[]; manual?: Manual[]; scanned?: number };
  brain: BrainResult;
  output: { fps: number; quality: "high" | "standard" | "small" };
  renders: RenderResult[];
}

export interface ProjectSummary {
  id: string;
  name: string;
  folder: string;
  updated: number;
  stage: string;
  duration: number;
  sources: number;
  missing?: boolean;
}

export interface Word {
  w: string;
  s: number;
  e: number;
  i: number;
}
export interface Transcript {
  words: Word[];
  silences: [number, number][];
  peaks: number[];
  duration: number;
}

export interface Job {
  status: "idle" | "queued" | "running" | "done" | "error";
  kind?: string;
  progress?: number;
  message?: string;
  log?: { t: number; msg: string }[];
  error?: string | null;
  started?: number;
  finished?: number | null;
}

export interface Detection {
  id: string;
  key: string;
  src: string;
  kind: string;
  label: string;
  text: string;
  preview: string;
  t0: number;
  t1: number;
  boxes: number[][];
}
export interface Manual {
  id: string;
  src: string;
  t0: number;
  t1: number;
  box: number[];
}

export interface Settings {
  brain: "claude_code" | "anthropic" | "groq" | "none";
  claude_path: string;
  anthropic_key: string;
  anthropic_key_set?: boolean;
  anthropic_model: string;
  groq_key: string;
  groq_key_set?: boolean;
  groq_model: string;
  whisper_model: string;
  language: string;
  private_words: string[];
  brand: { accent: string; background: string; text: string; name: string };
}
