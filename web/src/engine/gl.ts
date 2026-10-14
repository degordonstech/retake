/**
 * The compositor: draws pictures into a frame with WebGL2.
 *
 * Everything is premultiplied alpha. A "picture" is drawn into a rectangle
 * of the frame, optionally cropped, rotated (phone video stores its
 * orientation separately), with rounded corners, a colour adjustment, a
 * vignette and a blur. Transitions draw both clips into their own frames and
 * blend them with a second shader.
 */
import type { Drawable } from "./media";

export interface Adj {
  brightness?: number;
  contrast?: number;
  saturation?: number;
  temperature?: number;
  vignette?: number;
}

export interface DrawOpts {
  /** Destination rectangle in frame pixels (top-left origin). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Source crop in the picture's displayed orientation, 0..1. */
  crop?: [number, number, number, number];
  rotation?: number; // 0, 90, 180, 270
  opacity?: number;
  radius?: number; // px
  adj?: Adj;
  blur?: number; // texels
  premultiplied?: boolean; // the source already has premultiplied alpha
}

export const TRANSITION_IDS: Record<string, number> = {
  fade: 0, black: 1, white: 2, slide: 3, push: 4, wipe: 5, smooth: 6, zoom: 7, circle: 8, blur: 9, pixel: 10, radial: 11,
};

const VERT = `#version 300 es
in vec2 aPos;
uniform vec4 uDst;      // x, y, w, h in frame px
uniform vec2 uFrame;    // frame size in px
out vec2 vUv;
out vec2 vLocal;
void main() {
  vec2 px = uDst.xy + aPos * uDst.zw;
  vUv = aPos;
  vLocal = aPos * uDst.zw;
  vec2 clip = px / uFrame * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}`;

const DRAW_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
in vec2 vLocal;
uniform sampler2D uTex;
uniform vec4 uCrop;      // u0, v0, u1, v1 in displayed orientation
uniform int uRot;        // quarter turns
uniform float uOpacity;
uniform vec4 uAdj;       // brightness, contrast, saturation, temperature
uniform float uVignette;
uniform float uRadius;
uniform vec2 uSize;      // destination size in px
uniform vec2 uBlur;      // texel step; 0 = sharp
uniform bool uPremul;
out vec4 outColor;

vec2 coded(vec2 d) {
  if (uRot == 1) return vec2(d.y, 1.0 - d.x);
  if (uRot == 2) return vec2(1.0 - d.x, 1.0 - d.y);
  if (uRot == 3) return vec2(1.0 - d.y, d.x);
  return d;
}
vec4 tap(vec2 uv) {
  vec4 c = texture(uTex, coded(clamp(uv, 0.0, 1.0)));
  return uPremul ? c : vec4(c.rgb * c.a, c.a);
}
void main() {
  vec2 uv = mix(uCrop.xy, uCrop.zw, vUv);
  vec4 c;
  if (uBlur.x > 0.0) {
    c = vec4(0.0);
    float wsum = 0.0;
    for (int i = -3; i <= 3; i++) {
      for (int j = -3; j <= 3; j++) {
        float w = exp(-float(i * i + j * j) / 8.0);
        c += tap(uv + vec2(float(i), float(j)) * uBlur) * w;
        wsum += w;
      }
    }
    c /= wsum;
  } else {
    c = tap(uv);
  }
  vec3 rgb = c.a > 0.0 ? c.rgb / c.a : vec3(0.0);
  // Brightness, contrast, saturation, warmth: the same direction and roughly
  // the same strength as the export's eq and colortemperature filters.
  rgb += uAdj.x * 0.5;
  rgb = (rgb - 0.5) * (1.0 + uAdj.y) + 0.5;
  float l = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  rgb = mix(vec3(l), rgb, max(0.0, 1.0 + uAdj.z));
  rgb *= vec3(1.0 + 0.16 * uAdj.w, 1.0 + 0.02 * uAdj.w, 1.0 - 0.2 * uAdj.w);
  if (uVignette > 0.0) {
    vec2 q = vUv - 0.5;
    float d = length(q * vec2(uSize.x / max(uSize.x, uSize.y), uSize.y / max(uSize.x, uSize.y))) * 1.6;
    rgb *= 1.0 - uVignette * 0.75 * smoothstep(0.35, 1.05, d);
  }
  float a = c.a * uOpacity;
  if (uRadius > 0.0) {
    vec2 h = uSize * 0.5;
    vec2 p = abs(vLocal - h) - (h - uRadius);
    float dist = length(max(p, 0.0)) + min(max(p.x, p.y), 0.0) - uRadius;
    a *= clamp(0.5 - dist, 0.0, 1.0);
  }
  outColor = vec4(clamp(rgb, 0.0, 1.0) * a, a);
}`;

const FILL_FRAG = `#version 300 es
precision highp float;
uniform vec4 uColor; // premultiplied
out vec4 outColor;
void main() { outColor = uColor; }`;

const MIX_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uA;
uniform sampler2D uB;
uniform int uType;
uniform float uP;
uniform vec2 uSize;
out vec4 outColor;
vec4 A(vec2 uv) { return texture(uA, vec2(uv.x, 1.0 - uv.y)); }
vec4 B(vec2 uv) { return texture(uB, vec2(uv.x, 1.0 - uv.y)); }
float ease(float t) { return t * t * (3.0 - 2.0 * t); }
void main() {
  vec2 uv = vUv;
  float p = clamp(uP, 0.0, 1.0);
  float e = ease(p);
  vec4 c;
  if (uType == 0) c = mix(A(uv), B(uv), e);
  else if (uType == 1 || uType == 2) {
    vec4 mid = uType == 1 ? vec4(0.0, 0.0, 0.0, 1.0) : vec4(1.0);
    c = p < 0.5 ? mix(A(uv), mid, ease(p * 2.0)) : mix(mid, B(uv), ease(p * 2.0 - 1.0));
  }
  else if (uType == 3) { float x = uv.x + e; c = x < 1.0 ? A(vec2(x, uv.y)) : B(vec2(x - 1.0, uv.y)); }
  else if (uType == 4) { float y = uv.y + e; c = y < 1.0 ? A(vec2(uv.x, y)) : B(vec2(uv.x, y - 1.0)); }
  else if (uType == 5) c = uv.x > 1.0 - e ? B(uv) : A(uv);
  else if (uType == 6) { float edge = 1.0 - e * 1.3 + 0.15; c = mix(A(uv), B(uv), smoothstep(edge - 0.15, edge + 0.15, uv.x)); }
  else if (uType == 7) {
    vec2 za = (uv - 0.5) / (1.0 + e * 0.6) + 0.5;
    vec2 zb = (uv - 0.5) * (1.0 + (1.0 - e) * 0.25) + 0.5;
    c = mix(A(za), B(zb), smoothstep(0.35, 0.75, p));
  }
  else if (uType == 8) {
    vec2 q = (uv - 0.5) * vec2(uSize.x / uSize.y, 1.0);
    float r = e * length(vec2(uSize.x / uSize.y, 1.0)) * 0.5;
    c = length(q) < r ? B(uv) : A(uv);
  }
  else if (uType == 9) {
    float amt = sin(p * 3.14159) * 0.035;
    vec4 a = vec4(0.0), b = vec4(0.0);
    for (int i = -6; i <= 6; i++) {
      vec2 o = vec2(float(i) * amt / 6.0, 0.0);
      a += A(uv + o); b += B(uv + o);
    }
    c = mix(a / 13.0, b / 13.0, e);
  }
  else if (uType == 10) {
    float cells = mix(uSize.y, 12.0, sin(p * 3.14159));
    vec2 grid = vec2(cells * uSize.x / uSize.y, cells);
    vec2 g = (floor(uv * grid) + 0.5) / grid;
    c = mix(A(g), B(g), step(0.5, p));
  }
  else {
    vec2 q = uv - 0.5;
    float ang = atan(q.x, -q.y) / 6.28318 + 0.5;
    c = ang < e ? B(uv) : A(uv);
  }
  outColor = c;
}`;

interface Prog {
  p: WebGLProgram;
  u: Record<string, WebGLUniformLocation | null>;
}

interface Target {
  fb: WebGLFramebuffer;
  tex: WebGLTexture;
  w: number;
  h: number;
}

export class Compositor {
  readonly gl: WebGL2RenderingContext;
  private draw: Prog;
  private fill: Prog;
  private mixer: Prog;
  private quad: WebGLVertexArrayObject;
  private textures = new WeakMap<object, WebGLTexture>();
  private scratch: WebGLTexture;
  private targets = new Map<string, Target>();
  /** Size of what is being drawn into now; the canvas size is `base`. */
  private frame: [number, number] = [1, 1];
  private base: [number, number] = [1, 1];
  current: string | null = null;

  constructor(readonly canvas: HTMLCanvasElement | OffscreenCanvas) {
    const gl = canvas.getContext("webgl2", { premultipliedAlpha: true, alpha: false, antialias: false, preserveDrawingBuffer: true }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error("WebGL2 is not available");
    this.gl = gl;
    this.draw = this.program(VERT, DRAW_FRAG, ["uDst", "uFrame", "uTex", "uCrop", "uRot", "uOpacity", "uAdj", "uVignette", "uRadius", "uSize", "uBlur", "uPremul"]);
    this.fill = this.program(VERT, FILL_FRAG, ["uDst", "uFrame", "uColor"]);
    this.mixer = this.program(VERT, MIX_FRAG, ["uDst", "uFrame", "uA", "uB", "uType", "uP", "uSize"]);
    this.quad = gl.createVertexArray()!;
    gl.bindVertexArray(this.quad);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    for (const pr of [this.draw, this.fill, this.mixer]) {
      const loc = gl.getAttribLocation(pr.p, "aPos");
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    }
    this.scratch = this.newTexture();
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  }

  private program(vs: string, fs: string, uniforms: string[]): Prog {
    const gl = this.gl;
    const mk = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "link");
    const u: Prog["u"] = {};
    for (const n of uniforms) u[n] = gl.getUniformLocation(p, n);
    return { p, u };
  }

  private newTexture(): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  /** Start a frame of w x h pixels (the canvas is resized to match). */
  begin(w: number, h: number, background: string) {
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    this.base = [w, h];
    this.bind(null);
    this.clear(background);
  }

  /** Draw into the screen (null) or into a named offscreen frame (canvas-sized unless given a size). */
  bind(name: string | null, size?: [number, number]) {
    const gl = this.gl;
    const [w, h] = size ? [Math.max(1, Math.round(size[0])), Math.max(1, Math.round(size[1]))] : this.base;
    this.current = name;
    this.frame = [w, h];
    if (!name) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      return;
    }
    let t = this.targets.get(name);
    if (!t || t.w !== w || t.h !== h) {
      if (t) { gl.deleteFramebuffer(t.fb); gl.deleteTexture(t.tex); }
      const tex = this.newTexture();
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      const fb = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      t = { fb, tex, w, h };
      this.targets.set(name, t);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
    gl.viewport(0, 0, w, h);
  }

  clear(color: string, alpha = 1) {
    const gl = this.gl;
    const [r, g, b] = rgb(color);
    gl.clearColor(r * alpha, g * alpha, b * alpha, alpha);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  private upload(src: Drawable, cacheable: boolean): WebGLTexture {
    const gl = this.gl;
    let tex: WebGLTexture | undefined;
    if (cacheable) {
      tex = this.textures.get(src as object);
      if (tex) { gl.bindTexture(gl.TEXTURE_2D, tex); return tex; }
      tex = this.newTexture();
      this.textures.set(src as object, tex);
    } else {
      tex = this.scratch;
      gl.bindTexture(gl.TEXTURE_2D, tex);
    }
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src as TexImageSource);
    return tex;
  }

  /** Draw a picture. Stills (images) keep their texture; video frames are re-uploaded. */
  picture(src: Drawable, o: DrawOpts, still = false) {
    const gl = this.gl;
    const pr = this.draw;
    gl.useProgram(pr.p);
    gl.activeTexture(gl.TEXTURE0);
    this.upload(src, still);
    gl.uniform1i(pr.u.uTex, 0);
    gl.uniform4f(pr.u.uDst, o.x, o.y, o.w, o.h);
    gl.uniform2f(pr.u.uFrame, this.frame[0], this.frame[1]);
    const c = o.crop ?? [0, 0, 1, 1];
    gl.uniform4f(pr.u.uCrop, c[0], c[1], c[2], c[3]);
    gl.uniform1i(pr.u.uRot, Math.round(((o.rotation ?? 0) % 360) / 90));
    gl.uniform1f(pr.u.uOpacity, o.opacity ?? 1);
    const a = o.adj ?? {};
    gl.uniform4f(pr.u.uAdj, a.brightness ?? 0, a.contrast ?? 0, a.saturation ?? 0, a.temperature ?? 0);
    gl.uniform1f(pr.u.uVignette, a.vignette ?? 0);
    gl.uniform1f(pr.u.uRadius, o.radius ?? 0);
    gl.uniform2f(pr.u.uSize, o.w, o.h);
    const sw = (src as { displayWidth?: number; width: number }).displayWidth ?? (src as { width: number }).width;
    const sh = (src as { displayHeight?: number; height: number }).displayHeight ?? (src as { height: number }).height;
    const b = o.blur ?? 0;
    gl.uniform2f(pr.u.uBlur, b / Math.max(1, sw), b / Math.max(1, sh));
    gl.uniform1i(pr.u.uPremul, o.premultiplied ? 1 : 0);
    gl.bindVertexArray(this.quad);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** Draw an offscreen frame (by name) like a picture. */
  target(name: string, o: DrawOpts) {
    const t = this.targets.get(name);
    if (!t) return;
    const gl = this.gl;
    const pr = this.draw;
    gl.useProgram(pr.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.uniform1i(pr.u.uTex, 0);
    gl.uniform4f(pr.u.uDst, o.x, o.y, o.w, o.h);
    gl.uniform2f(pr.u.uFrame, this.frame[0], this.frame[1]);
    // Offscreen frames are stored bottom-up.
    const c = o.crop ?? [0, 0, 1, 1];
    gl.uniform4f(pr.u.uCrop, c[0], 1 - c[1], c[2], 1 - c[3]);
    gl.uniform1i(pr.u.uRot, 0);
    gl.uniform1f(pr.u.uOpacity, o.opacity ?? 1);
    const a = o.adj ?? {};
    gl.uniform4f(pr.u.uAdj, a.brightness ?? 0, a.contrast ?? 0, a.saturation ?? 0, a.temperature ?? 0);
    gl.uniform1f(pr.u.uVignette, a.vignette ?? 0);
    gl.uniform1f(pr.u.uRadius, o.radius ?? 0);
    gl.uniform2f(pr.u.uSize, o.w, o.h);
    const b = o.blur ?? 0;
    gl.uniform2f(pr.u.uBlur, b / t.w, b / t.h);
    gl.uniform1i(pr.u.uPremul, 1);
    gl.bindVertexArray(this.quad);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  rect(x: number, y: number, w: number, h: number, color: string, alpha: number) {
    if (alpha <= 0) return;
    const gl = this.gl;
    const pr = this.fill;
    gl.useProgram(pr.p);
    gl.uniform4f(pr.u.uDst, x, y, w, h);
    gl.uniform2f(pr.u.uFrame, this.frame[0], this.frame[1]);
    const [r, g, b] = rgb(color);
    gl.uniform4f(pr.u.uColor, r * alpha, g * alpha, b * alpha, alpha);
    gl.bindVertexArray(this.quad);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** Size of an offscreen frame, once made. */
  sizeOf(name: string): [number, number] | null {
    const t = this.targets.get(name);
    return t ? [t.w, t.h] : null;
  }

  /** Blend two offscreen frames into the current one. */
  transition(a: string, b: string, type: string, p: number) {
    const ta = this.targets.get(a), tb = this.targets.get(b);
    if (!ta || !tb) return;
    const gl = this.gl;
    const pr = this.mixer;
    gl.useProgram(pr.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, ta.tex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, tb.tex);
    gl.uniform1i(pr.u.uA, 0);
    gl.uniform1i(pr.u.uB, 1);
    gl.uniform1i(pr.u.uType, TRANSITION_IDS[type] ?? 0);
    gl.uniform1f(pr.u.uP, p);
    gl.uniform2f(pr.u.uSize, this.frame[0], this.frame[1]);
    gl.uniform4f(pr.u.uDst, 0, 0, this.frame[0], this.frame[1]);
    gl.uniform2f(pr.u.uFrame, this.frame[0], this.frame[1]);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(this.quad);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.enable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0);
  }

  dispose() {
    const gl = this.gl;
    for (const t of this.targets.values()) { gl.deleteFramebuffer(t.fb); gl.deleteTexture(t.tex); }
    this.targets.clear();
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

function rgb(hex: string): [number, number, number] {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h.slice(0, 6), 16) || 0;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
