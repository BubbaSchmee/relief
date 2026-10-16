/** The overlay renderer. ONE implementation draws both the live preview and the
 *  exported frames, so what you see playing is what lands in your editor:
 *  same shader, same framing, same pose function. Only the target differs — the
 *  preview draws to a canvas, the export to an offscreen framebuffer
 *  supersampled and resolved by src/frames.ts.
 *
 *  Lighting is done in LINEAR light from the exact sRGB EOTF of each region's
 *  hex, then encoded back with the exact OETF, so a lit face is the brand
 *  colour modulated by light and not by a gamma mistake. Geometry is written
 *  with alpha 1 and nothing else is: no blending anywhere, so the framebuffer
 *  holds exact coverage and straight colour. */
import { parseHex, srgbToLinear } from "../src/color.js";
import { poseMatrices, type Framing } from "../src/framing.js";
import { resolveFrame } from "../src/frames.js";
import { studioMatcap } from "../src/matcap.js";
import type { Pose } from "../src/motion.js";
import type { Mesh } from "../src/types.js";

const VS = `#version 300 es
in vec3 aPos; in vec3 aNrm; in float aKind; in vec3 aCol;
uniform mat4 uMVP; uniform mat4 uModelView;
out vec3 vN; out vec3 vV; out vec3 vC; flat out float vK;
void main() {
  vec4 p = uModelView * vec4(aPos, 1.0);
  vN = mat3(uModelView) * aNrm; // rotation only, so the normal needs no inverse transpose
  vV = -p.xyz;                  // towards the eye, in view space
  vK = aKind; vC = aCol;
  gl_Position = uMVP * vec4(aPos, 1.0);
}`;

// Lights and the matcap live in VIEW space: the studio stays put as the logo turns.
const FS = `#version 300 es
precision highp float;
in vec3 vN; in vec3 vV; in vec3 vC; flat in float vK;
uniform sampler2D uMatcap; uniform float uUnlit;
out vec4 o;
vec3 decode(vec3 s) { return mix(s / 12.92, pow((s + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), s)); }
vec3 encode(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c)); }
// The studio as a mirror ball would show it, read with the true reflection vector.
vec3 studio(vec3 N, vec3 V) {
  vec3 r = reflect(-V, N);
  float m = max(2.0 * sqrt(r.x * r.x + r.y * r.y + (r.z + 1.0) * (r.z + 1.0)), 1e-4);
  return decode(texture(uMatcap, r.xy / m + 0.5).rgb);
}
void main() {
  vec3 N = normalize(vN), V = normalize(vV);
  // Front, Bevel AND Back carry the brand colour: mid-spin the viewer sees the
  // logo mirrored, not a grey slab. Only the side walls are chrome.
  bool face = abs(vK - 2.0) > 0.5;
  vec3 c;
  if (face && uUnlit > 0.5) {
    c = vC; // contractual colour: exactly the brand hex, no light at all
  } else if (face) {
    vec3 L1 = normalize(vec3(-0.40, 0.55, 0.73)), L2 = normalize(vec3(0.60, 0.10, 0.55)); // key, fill
    float diff = 0.34 + 0.70 * max(dot(N, L1), 0.0) + 0.22 * max(dot(N, L2), 0.0);
    float fres = 0.10 + 0.90 * pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 5.0);
    float gloss = (vK > 0.5 && vK < 1.5) ? 1.8 : 1.0; // the bevel catches the light harder
    c = vC * diff + studio(N, V) * fres * gloss;
  } else {
    c = studio(N, V) * 1.15 + 0.02; // Side walls: chrome, straight from the studio
  }
  o = vec4(encode(clamp(c, 0.0, 1.0)), 1.0);
}`;

let matcapBytes: Uint8ClampedArray | null = null;
const MATCAP_SIZE = 512;

export class OverlayRenderer {
  private prog: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private bufs: Record<"pos" | "nrm" | "kind" | "col" | "idx", WebGLBuffer>;
  private matcap: WebGLTexture;
  private indexCount = 0;
  private u: Record<"mvp" | "mv" | "unlit" | "matcap", WebGLUniformLocation | null>;
  readonly gl: WebGL2RenderingContext;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    const mk = (type: number, code: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, code);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
      return s;
    };
    this.prog = gl.createProgram()!;
    gl.attachShader(this.prog, mk(gl.VERTEX_SHADER, VS));
    gl.attachShader(this.prog, mk(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(this.prog);
    if (!gl.getProgramParameter(this.prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(this.prog) ?? "link");
    this.vao = gl.createVertexArray()!;
    this.bufs = { pos: gl.createBuffer()!, nrm: gl.createBuffer()!, kind: gl.createBuffer()!, col: gl.createBuffer()!, idx: gl.createBuffer()! };
    this.u = {
      mvp: gl.getUniformLocation(this.prog, "uMVP"),
      mv: gl.getUniformLocation(this.prog, "uModelView"),
      unlit: gl.getUniformLocation(this.prog, "uUnlit"),
      matcap: gl.getUniformLocation(this.prog, "uMatcap"),
    };
    matcapBytes ??= studioMatcap(MATCAP_SIZE); // deterministic maths, built once for every context
    this.matcap = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.matcap);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, MATCAP_SIZE, MATCAP_SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, matcapBytes);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); // no mipmaps: the table is smooth already
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  private attrib(name: string, buf: WebGLBuffer, data: ArrayBufferView, size: number, type: number) {
    const { gl } = this;
    const l = gl.getAttribLocation(this.prog, name);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(l);
    gl.vertexAttribPointer(l, size, type, false, 0, 0);
  }

  setMesh(m: Mesh | null) {
    const { gl } = this;
    this.indexCount = m ? m.indices.length : 0;
    if (!m) return;
    gl.bindVertexArray(this.vao);
    this.attrib("aPos", this.bufs.pos, m.positions, 3, gl.FLOAT);
    this.attrib("aNrm", this.bufs.nrm, m.normals, 3, gl.FLOAT);
    this.attrib("aKind", this.bufs.kind, m.faceKind, 1, gl.UNSIGNED_BYTE);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.bufs.idx);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, m.indices, gl.STATIC_DRAW);
    const linear = m.regionHex.map((h) => {
      const { r, g, b } = parseHex(h);
      return [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)];
    });
    const col = new Float32Array(m.regionIndex.length * 3);
    m.regionIndex.forEach((ri, i) => col.set(linear[ri], i * 3));
    this.attrib("aCol", this.bufs.col, col, 3, gl.FLOAT);
  }

  /** Draw one pose into the CURRENTLY BOUND framebuffer. The caller sets the
   *  viewport and chooses whether the background is transparent. */
  draw(f: Framing, pose: Pose, unlit: boolean) {
    const { gl } = this;
    gl.disable(gl.BLEND);
    gl.disable(gl.DITHER); // dithering would put noise into exact 8-bit colours
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!this.indexCount) return;
    const { modelView, mvp } = poseMatrices(f, pose);
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    gl.uniformMatrix4fv(this.u.mv, false, new Float32Array(modelView));
    gl.uniformMatrix4fv(this.u.mvp, false, new Float32Array(mvp));
    gl.uniform1f(this.u.unlit, unlit ? 1 : 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.matcap);
    gl.uniform1i(this.u.matcap, 0);
    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);
  }
}

/** Offscreen, supersampled frame source for export. Renders at (w*ss) x (h*ss)
 *  into an RGBA8 framebuffer cleared to (0,0,0,0), reads it back, and resolves
 *  it to a w x h STRAIGHT-alpha, top-down frame. Nothing here reads a clock. */
export class FrameRenderer {
  private canvas = document.createElement("canvas");
  private renderer: OverlayRenderer;
  private fbo: WebGLFramebuffer;
  private rbs: WebGLRenderbuffer[];
  private buf: Uint8Array;
  readonly w: number;
  readonly h: number;
  readonly ss: number;

  constructor(mesh: Mesh, w: number, h: number, ss: number) {
    this.w = w;
    this.h = h;
    this.ss = ss;
    const gl = this.canvas.getContext("webgl2", { alpha: true, antialias: false, depth: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error("WebGL2 is not available, so frames cannot be rendered.");
    const W = w * ss, H = h * ss;
    const max = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number;
    if (W > max || H > max) throw new Error(`This GPU renders at most ${max}px; ${W}x${H} was asked for. Choose a smaller size.`);
    this.renderer = new OverlayRenderer(gl);
    this.renderer.setMesh(mesh);
    this.fbo = gl.createFramebuffer()!;
    const color = gl.createRenderbuffer()!, depth = gl.createRenderbuffer()!;
    this.rbs = [color, depth];
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.bindRenderbuffer(gl.RENDERBUFFER, color);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, W, H);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, color);
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, W, H);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`The GPU could not allocate a ${W}x${H} render target.`);
    gl.viewport(0, 0, W, H);
    this.buf = new Uint8Array(W * H * 4);
  }

  render(f: Framing, pose: Pose, unlit: boolean): Uint8ClampedArray {
    const gl = this.renderer.gl;
    this.renderer.draw(f, pose, unlit);
    gl.readPixels(0, 0, this.w * this.ss, this.h * this.ss, gl.RGBA, gl.UNSIGNED_BYTE, this.buf);
    return resolveFrame(this.buf, this.w, this.h, this.ss);
  }

  dispose() {
    const gl = this.renderer.gl;
    gl.deleteFramebuffer(this.fbo);
    for (const rb of this.rbs) gl.deleteRenderbuffer(rb);
    gl.getExtension("WEBGL_lose_context")?.loseContext(); // browsers cap live contexts; give ours back
  }
}
