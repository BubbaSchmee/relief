/** The overlay video: live preview of the loop, the motion and export controls,
 *  and the export run. The preview and the export use the SAME renderer, motion
 *  and framing (app/render.ts, src/motion.ts, src/framing.ts); the only thing a
 *  preview adds is the wall clock, and the export never reads one. */
import { frameFor, type Framing } from "../src/framing.js";
import { DEFAULT_MOTION, frameTimes, poseAt, type Motion } from "../src/motion.js";
import type { Mesh } from "../src/types.js";
import { createEncoder, type FormatId } from "./encoders.js";
import { FrameRenderer, OverlayRenderer } from "./render.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------------------------------------------------------------- the choices
const SIZES: { label: string; w: number; h: number }[] = [
  { label: "1080 x 1080 (square)", w: 1080, h: 1080 },
  { label: "1920 x 1080 (landscape)", w: 1920, h: 1080 },
  { label: "1080 x 1920 (portrait)", w: 1080, h: 1920 },
  { label: "2160 x 2160 (PNG sequence only)", w: 2160, h: 2160 },
];
const FORMATS: { id: FormatId; label: string; note: string }[] = [
  {
    id: "prores",
    label: "ProRes 4444 (.mov)",
    note: "Opens with transparency in DaVinci Resolve, Premiere Pro, After Effects, Final Cut Pro and iMovie. Not CapCut. The first time, your browser downloads a 32 MB encoder (ffmpeg, GPL) from a CDN. 1080p at most here: 4K needs too much memory, use the PNG sequence.",
  },
  {
    id: "webm",
    label: "Transparent WebM (.webm)",
    note: "Small and quick. Opens with transparency in CapCut on desktop (test it; the phone app varies), OBS and web pages. Not DaVinci Resolve, Premiere Pro or Final Cut Pro.",
  },
  {
    id: "png",
    label: "PNG sequence (.zip)",
    note: "Opens everywhere, at any size. Unzip, then import the first image as an image sequence and set the frame rate written in the file names.",
  },
];
/** "I'll use it in..." -> the format that works there (research 2026-10-04, DESIGN.md decision 10). */
const EDITORS: [string, FormatId][] = [
  ["Not sure / other (works everywhere)", "png"],
  ["DaVinci Resolve", "prores"],
  ["Premiere Pro", "prores"],
  ["After Effects", "prores"],
  ["Final Cut Pro", "prores"],
  ["iMovie", "prores"],
  ["CapCut", "webm"],
  ["OBS", "webm"],
  ["A web page", "webm"],
  ["4K video, any editor", "png"],
];
/** The ProRes encoder keeps every frame and the whole file in wasm memory. */
const PRORES_MAX_PIXELS = 1.0e9; // frames * w * h

// ---------------------------------------------------------------- state
const motion: Motion = { ...DEFAULT_MOTION };
let size = SIZES[0];
let fps = 30;
/** What the picker or the Format menu asked for; `format` is what is allowed right now. */
let wanted: FormatId = "png";
let format: FormatId = wanted;
let mesh: Mesh | null = null;
let baseName = "relief";
let exporting = false;

/** 4K here means beyond 1080p (the long side over 1920): PNG sequence only. */
const isBig = (s: { w: number; h: number }) => Math.max(s.w, s.h) > 1920;
const isUnlit = () => $<HTMLInputElement>("unlit").checked;
const frameCount = () => Math.max(1, Math.round(motion.duration * fps));

// ---------------------------------------------------------------- the panel
function row(label: string, control: HTMLElement, readout?: HTMLOutputElement): HTMLDivElement {
  const r = document.createElement("div");
  r.className = "row";
  const l = document.createElement("label");
  l.textContent = label;
  l.htmlFor = control.id;
  r.append(l);
  if (readout) r.append(readout);
  r.append(control);
  $("ovpanel").append(r);
  return r;
}

function slider(id: string, label: string, min: number, max: number, step: number, value: number, unit: string, onInput: (v: number) => void) {
  const input = document.createElement("input");
  Object.assign(input, { id, type: "range", min: String(min), max: String(max), step: String(step), value: String(value) });
  const out = document.createElement("output");
  const dp = step >= 1 ? 0 : step >= 0.1 ? 1 : 3;
  const show = () => (out.textContent = `${input.valueAsNumber.toFixed(dp)}${unit}`);
  show();
  input.addEventListener("input", () => {
    show();
    onInput(input.valueAsNumber);
    refresh();
  });
  return row(label, input, out);
}

function select(id: string, label: string, options: { value: string; text: string }[], value: string, onChange: (v: string) => void) {
  const s = document.createElement("select");
  s.id = id;
  for (const o of options) s.add(new Option(o.text, o.value, false, o.value === value));
  s.addEventListener("change", () => {
    onChange(s.value);
    refresh();
  });
  return { el: s, row: row(label, s) };
}

select("ov-kind", "Motion", [{ value: "spin", text: "Spin" }, { value: "rock", text: "Rock back and forth" }], motion.kind, (v) => (motion.kind = v as Motion["kind"]));
slider("ov-dur", "Loop length", 2, 10, 0.5, motion.duration, " s", (v) => { motion.duration = v; t %= v; });
const rockRow = slider("ov-rock", "Rock angle", 5, 60, 1, motion.rockDeg, "°", (v) => (motion.rockDeg = v));
const dirSel = select("ov-dir", "Spin direction", [{ value: "1", text: "Face turns right" }, { value: "-1", text: "Face turns left" }], "1", (v) => (motion.direction = v === "-1" ? -1 : 1));
slider("ov-tilt", "Tilt", -20, 30, 1, motion.tiltDeg, "°", (v) => (motion.tiltDeg = v));
slider("ov-hover", "Hover", 0, 0.1, 0.005, motion.hover, "", (v) => (motion.hover = v));
select("ov-size", "Size", SIZES.map((s, i) => ({ value: String(i), text: s.label })), "0", (v) => (size = SIZES[+v]));
select("ov-fps", "Frame rate", [{ value: "30", text: "30 fps" }, { value: "60", text: "60 fps" }], "30", (v) => (fps = +v));
select("ov-editor", "I'll use it in...", EDITORS.map(([text], i) => ({ value: String(i), text })), "0", (v) => (wanted = EDITORS[+v][1]));
const formatSel = select("ov-format", "Format", FORMATS.map((f) => ({ value: f.id, text: f.label })), wanted, (v) => (wanted = v as FormatId));

const note = document.createElement("p");
note.id = "ov-note";
const goRow = document.createElement("div");
goRow.className = "go";
const go = Object.assign(document.createElement("button"), { id: "ov-export", type: "button", textContent: "Export overlay video", disabled: true });
const cancel = Object.assign(document.createElement("button"), { id: "ov-cancel", type: "button", textContent: "Cancel", hidden: true });
goRow.append(go, cancel);
const bar = Object.assign(document.createElement("progress"), { id: "ov-bar", max: 1, value: 0, hidden: true });
const statusEl = Object.assign(document.createElement("p"), { id: "ov-status" });
statusEl.setAttribute("role", "status");
$("ovpanel").append(note, goRow, bar, statusEl);

/** Make the controls consistent with each other, then redraw. */
function refresh() {
  const big = isBig(size);
  const n = frameCount();
  const heavy = n * size.w * size.h > PRORES_MAX_PIXELS;
  const why = new Map<FormatId, string>();
  if (big) { why.set("prores", "4K"); why.set("webm", "4K"); }
  else if (heavy) why.set("prores", "too long");
  for (const o of formatSel.el.options) o.disabled = why.has(o.value as FormatId);
  // a format that is off right now falls back to PNG, the one that is always allowed and works
  // everywhere; the choice is remembered, so it comes back when the size or length allows it
  format = why.has(wanted) ? "png" : wanted;
  formatSel.el.value = format;
  rockRow.hidden = motion.kind !== "rock";
  dirSel.row.hidden = motion.kind !== "spin";
  const fmt = FORMATS.find((f) => f.id === format)!;
  const heavyNote = why.get("prores") === "too long" ? " ProRes is switched off for a clip this long at this size: shorten it, or use WebM or the PNG sequence." : "";
  note.textContent = `${fmt.note}${heavyNote} ${n} frames, ${size.w} x ${size.h}.`;
  go.disabled = !mesh || exporting;
  $("ov-scrub").setAttribute("max", String(motion.duration));
  fit();
  dirty = true;
}

// ---------------------------------------------------------------- the preview
const canvas = $<HTMLCanvasElement>("view");
const stage = $("stage");
const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: true, depth: true });
const preview = gl ? new OverlayRenderer(gl) : null;
if (!gl) $("msg").textContent = "WebGL2 is not available in this browser: the preview is off, and so is export.";

let framing: Framing | null = null;
let t = 0;
let playing = true;
let dirty = true;
let last = performance.now();
const scrub = $<HTMLInputElement>("ov-scrub");
const playBtn = $<HTMLButtonElement>("ov-play");

/** The preview is the export's frame: same aspect, shown whole on a checkerboard. */
function fit() {
  const aspect = size.w / size.h;
  const bw = stage.clientWidth - 24, bh = stage.clientHeight - 64;
  if (bw < 8 || bh < 8) return;
  const cssW = Math.floor(Math.min(bw, bh * aspect));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${Math.round(cssW / aspect)}px`;
  const w = Math.max(2, Math.round(cssW * dpr));
  if (canvas.width !== w) canvas.width = w;
  const h = Math.max(2, Math.round(w / aspect));
  if (canvas.height !== h) canvas.height = h;
}

let cached: { mesh: Mesh; hover: number; aspect: number; f: Framing } | null = null;
/** Framing is a pure function of the mesh, the hover and the aspect: compute it once, not per frame. */
function framingFor(m: Mesh): Framing {
  const aspect = size.w / size.h;
  if (!cached || cached.mesh !== m || cached.hover !== motion.hover || cached.aspect !== aspect) cached = { mesh: m, hover: motion.hover, aspect, f: frameFor(m, motion, aspect) };
  return cached.f;
}

function drawPreview() {
  if (!gl || !preview) return;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, canvas.width, canvas.height);
  framing = mesh ? framingFor(mesh) : null;
  if (!framing) {
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return;
  }
  preview.draw(framing, poseAt(motion, t), isUnlit());
}

function tick(now: number) {
  requestAnimationFrame(tick);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (exporting) return; // the export owns the GPU
  if (playing && mesh) {
    t = (t + dt) % motion.duration;
    scrub.value = String(t);
    dirty = true;
  }
  if (dirty) {
    dirty = false;
    drawPreview();
  }
}

playBtn.addEventListener("click", () => {
  playing = !playing;
  playBtn.textContent = playing ? "Pause" : "Play";
});
scrub.addEventListener("input", () => {
  playing = false;
  playBtn.textContent = "Play";
  t = scrub.valueAsNumber;
  dirty = true;
});
new ResizeObserver(() => { fit(); dirty = true; }).observe(stage);
$("unlit").addEventListener("input", () => (dirty = true));

// ---------------------------------------------------------------- export
let abort: AbortController | null = null;

function deliver(blob: Blob, filename: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  // dev server only (app/vite.config.ts): drop a copy in RELIEF/.out/ so native tools can check it
  if (import.meta.env.DEV) void fetch(`/__save?name=${encodeURIComponent(filename)}`, { method: "POST", body: blob });
}

async function runExport() {
  if (!mesh || exporting) return;
  const snap = mesh; // a slider moved mid-export must not change the clip
  const m: Motion = { ...motion };
  const { w, h } = size;
  const fmt = format;
  const times = frameTimes(m, fps);
  const ss = isBig(size) ? 2 : 3; // 4K: 3x would be a 6480px render target
  const f = frameFor(snap, m, w / h);
  const unlit = isUnlit();
  const stamp = `${baseName}_${m.kind}_${w}x${h}_${fps}fps${unlit ? "_unlit" : ""}`;
  exporting = true;
  abort = new AbortController();
  go.disabled = true;
  cancel.hidden = false;
  bar.hidden = false;
  bar.max = times.length;
  bar.value = 0;
  statusEl.textContent = "Preparing";
  refresh();
  const timing = { renderMs: 0, addMs: 0, finishMs: 0, totalMs: 0 };
  const t0 = performance.now();
  let renderer: FrameRenderer | null = null;
  let enc: Awaited<ReturnType<typeof createEncoder>> | null = null;
  try {
    renderer = new FrameRenderer(snap, w, h, ss);
    enc = await createEncoder(fmt, { w, h, fps, frames: times.length, name: baseName }, (s) => (statusEl.textContent = s));
    for (let i = 0; i < times.length; i++) {
      if (abort.signal.aborted) throw new DOMException("Cancelled", "AbortError");
      const a = performance.now();
      const rgba = renderer.render(f, poseAt(m, times[i]), unlit);
      const b = performance.now();
      await enc.add(rgba, i);
      timing.renderMs += b - a;
      timing.addMs += performance.now() - b;
      bar.value = i + 1;
      statusEl.textContent = `Frame ${i + 1} of ${times.length}`;
      await new Promise((r) => setTimeout(r)); // let the page paint the bar and take a Cancel click
    }
    const c = performance.now();
    const out = await enc.finish();
    timing.finishMs = performance.now() - c;
    timing.totalMs = performance.now() - t0;
    const filename = `${stamp}${fmt === "png" ? "_png" : ""}.${out.ext}`;
    deliver(out.blob, filename);
    const sec = (ms: number) => (ms / 1000).toFixed(1);
    statusEl.textContent = `Done: ${filename}, ${(out.blob.size / 1e6).toFixed(1)} MB, ${sec(timing.totalMs)} s (render ${sec(timing.renderMs)}, encode ${sec(timing.addMs + timing.finishMs)}).`;
    if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__reliefLast = { filename, bytes: out.blob.size, frames: times.length, ss, ...timing };
  } catch (e) {
    enc?.abort();
    const cancelled = e instanceof DOMException && e.name === "AbortError";
    statusEl.textContent = cancelled ? "Cancelled." : `Export failed: ${e instanceof Error ? e.message : String(e)}`;
    if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__reliefLast = { error: statusEl.textContent };
  } finally {
    renderer?.dispose();
    exporting = false;
    abort = null;
    cancel.hidden = true;
    bar.hidden = true;
    refresh();
  }
}

go.addEventListener("click", () => void runExport());
cancel.addEventListener("click", () => abort?.abort());

// ---------------------------------------------------------------- what main.ts drives
export const overlay = {
  /** A new or rebuilt mesh (null: nothing to show). */
  setMesh(m: Mesh | null, name = baseName) {
    mesh = m;
    baseName = name;
    preview?.setMesh(m);
    refresh();
  },
  /** The unlit checkbox changed. */
  redraw() {
    dirty = true;
  },
};

refresh();
requestAnimationFrame(tick);
