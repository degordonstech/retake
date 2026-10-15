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

export interface Adjust {
  brightness?: number;
  contrast?: number;
  saturation?: number;
  temperature?: number;
  vignette?: number;
  sharpen?: number;
}
export interface Framing {
  mode?: "fit" | "fill";
  zoom?: number;
  zoomTo?: number;
  x?: number;
  y?: number;
  bg?: "color" | "blur";
}
export interface Transition {
  type: string;
  dur: number;
}
export interface MediaClip {
  id: string;
  take: string;
  a: number;
  b: number;
  kind?: undefined;
  speed?: number;
  volume?: number;
  mute?: boolean;
  filter?: string;
  adjust?: Adjust;
  frame?: Framing;
  transition?: Transition;
}
export interface TitleClip {
  id: string;
  kind: "title";
  text: string;
  sub: string;
  tag: string;
  dur: number;
  transition?: Transition;
}
export type Clip = MediaClip | TitleClip;

export interface Overlay {
  id: string;
  kind: "label" | "lower" | "caption" | "text";
  text: string;
  sub?: string;
  tag?: string;
  start: number;
  dur: number;
  chapter?: boolean;
  // Styled text ("text" kind)
  style?: string;
  font?: string;
  size?: number;
  color?: string;
  accent?: string;
  upper?: boolean | null;
  x?: number;
  y?: number;
  anim?: string;
  out?: string;
}

export interface MediaItem {
  id: string;
  asset: string;
  start: number;
  dur: number;
  in?: number;
  mode?: "full" | "pip";
  x?: number;
  y?: number;
  scale?: number;
  radius?: number;
  opacity?: number;
  anim?: string;
  volume?: number;
}

export interface AudioItem {
  id: string;
  asset: string;
  start: number;
  dur: number;
  in?: number;
  volume?: number;
  fadeIn?: number;
  fadeOut?: number;
  duck?: boolean;
  loop?: boolean;
}

export interface CaptionSettings {
  on?: boolean;
  template?: string;
  scale?: number;
  y?: number;
  color?: string;
  hi?: string;
  font?: string;
  upper?: boolean | null;
  words?: number;
  lines?: number;
}

export interface FormatSettings {
  aspect?: string;
  fadeIn?: boolean;
  fadeOut?: boolean;
}

export interface Edit {
  clips: Clip[];
  overlays: Overlay[];
  media: MediaItem[];
  audio: AudioItem[];
  captions?: CaptionSettings;
  format?: FormatSettings;
}

export interface Asset {
  id: string;
  file: string;
  name: string;
  kind: "image" | "video" | "audio";
  width?: number;
  height?: number;
  duration?: number;
  has_audio?: boolean;
  ready?: boolean;
  missing?: boolean;
  sfx?: boolean;
  size?: number;
}

/* Looks served by the engine (same numbers as the export). */
export interface Stroke { color: string; w: number }
export interface Shadow { y: number; alpha: number }
export interface BoxLook { color: string; alpha: number; pad: number; radius: number }
export interface CaptionTemplate {
  id: string; name: string; font: string; size: number; upper?: boolean; strip?: boolean;
  color: string; hi: string; hi_text?: string; alt?: string[];
  outline?: Stroke; shadow?: Shadow; box?: BoxLook;
  words: number; lines: number; y: number; mode: string; grow?: number; past?: string; enter?: string;
}
export interface TextStyle {
  id: string; name: string; font: string; size: number; upper?: boolean; color: string;
  outline?: Stroke; shadow?: Shadow; box?: BoxLook; glow?: string;
}
export interface Looks {
  fonts: Record<string, { css: string; weight: number; file: string }>;
  captions: CaptionTemplate[];
  texts: TextStyle[];
  textAnims: string[];
  filters: { id: string; name: string; adj: Adjust }[];
  transitions: { id: string; name: string; xfade: string }[];
  aspects: Record<string, [number, number]>;
}
export interface CaptionWord { t: string; s: number; e: number; cx: number; cy: number; w: number }
export interface CaptionPage { t0: number; t1: number; words: CaptionWord[]; scale: number; box: number[] }
export interface CaptionLayout {
  width: number;
  height: number;
  style: CaptionTemplate & { em: number; pad: number; lh: number };
  pages: CaptionPage[];
}

export interface BrainResult {
  chapters?: { title: string; take: string; word: number }[];
  notes?: { take: string; word: number; note: string }[];
  corrections?: { take: string; word: number; text: string }[];
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
  quick?: boolean;
  assets: Asset[];
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
