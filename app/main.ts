/** RELIEF browser app: drop a logo (SVG, or a PNG/JPEG/WebP), build the mesh,
 *  preview the looping overlay video (app/overlay-ui.ts), export it as a
 *  transparent video or PNG sequence, or download a GLB. Plain TS + DOM, no framework.
 *  Every region carries an exact colour: an SVG's fills, or a raster's palette
 *  of exact RGB values (never an average, which invents a colour the logo does
 *  not contain). Overlaps are flattened into disjoint regions and depth comes
 *  from containment (src/layers.ts); the list below the sliders overrides it. */
import { buildMesh } from "../src/mesh.js";
import { meshToGlb } from "../src/gltf.js";
import { containmentLevels, flattenPaintOrder } from "../src/layers.js";
import { regionsFromRaster } from "../src/raster.js";
import { parseSvg } from "../src/svg.js";
import { DEFAULT_PROFILE, type BevelCurve, type Mesh, type Profile, type Region } from "../src/types.js";
import { desktop } from "./desktop.js";
import { overlay } from "./overlay-ui.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------------------------------------------------------------- controls
type NumKey = Exclude<keyof Profile, "bevelCurve">;
const SLIDERS: [NumKey, string, number, number, number][] = [
  ["extrude", "Extrude", 0.02, 0.6, 0.01],
  ["bevelWidth", "Bevel width", 0, 0.08, 0.001],
  ["bevelHeight", "Bevel height", 0, 0.06, 0.001],
  ["bevelSteps", "Bevel steps", 1, 8, 1],
  ["inflate", "Inflate", 0, 1, 0.01],
];
const CURVES: BevelCurve[] = ["round", "ogee", "chamfer", "step"];
/** Long-edge cap for the TRACE raster (colour is always read at full size). */
const TRACE_MAX = 1024;

const inputs = new Map<string, HTMLInputElement | HTMLSelectElement>();
const decimals = (step: number) => (step >= 1 ? 0 : Math.max(0, -Math.floor(Math.log10(step))));

function addRow(key: string, label: string, control: HTMLInputElement | HTMLSelectElement, readout?: HTMLOutputElement) {
  const row = document.createElement("div");
  row.className = "row";
  const l = document.createElement("label");
  l.htmlFor = control.id = `c-${key}`;
  l.textContent = label;
  row.append(l);
  if (readout) row.append(readout);
  row.append(control);
  $("controls").append(row);
  inputs.set(key, control);
  control.addEventListener("input", () => {
    if (readout) readout.textContent = Number((control as HTMLInputElement).value).toFixed(readout.dataset.dp ? +readout.dataset.dp : 2);
    rebuild();
  });
}

for (const [key, label, min, max, step] of SLIDERS) {
  const r = document.createElement("input");
  Object.assign(r, { type: "range", min: String(min), max: String(max), step: String(step), value: String(DEFAULT_PROFILE[key]) });
  const out = document.createElement("output");
  out.dataset.dp = String(decimals(step));
  out.textContent = DEFAULT_PROFILE[key].toFixed(decimals(step));
  addRow(key, label, r, out);
  if (key === "bevelHeight") {
    const s = document.createElement("select");
    for (const c of CURVES) s.add(new Option(c, c, false, c === DEFAULT_PROFILE.bevelCurve));
    addRow("bevelCurve", "Bevel curve", s);
  }
}

{
  const r = document.createElement("input");
  Object.assign(r, { type: "range", min: "0", max: "0.1", step: "0.005", value: "0.03" });
  const out = document.createElement("output");
  out.dataset.dp = "3";
  out.textContent = "0.030";
  addRow("layerStep", "Layer step", r, out);
}

const readProfile = (): Profile => {
  const p = { ...DEFAULT_PROFILE };
  for (const [key] of SLIDERS) p[key] = (inputs.get(key) as HTMLInputElement).valueAsNumber;
  p.bevelCurve = (inputs.get("bevelCurve") as HTMLSelectElement).value as BevelCurve;
  return p;
};

// ---------------------------------------------------------------- image -> regions
/** Flattened, disjoint regions in paint order, WITHOUT depth: depth is derived
 *  per rebuild from `levels` (containment) and `overrides` (the user's) times
 *  the layer step, so the slider and the overrides compose. */
let regions: Region[] = [];
let levels: number[] = [];
const overrides = new Map<number, number>();
let src = { width: 0, height: 0 };
let baseName = "relief";
let mesh: Mesh | null = null;

const msg = $("msg");
const stats = $("stats");
const dl = $<HTMLButtonElement>("dl");
let warnings: string[] = [];

/** Import warnings are a list, not an alert: SVG refusals must stay readable. */
function showWarnings(list: string[]) {
  warnings = list;
  $("warnings").replaceChildren(...list.map((w) => Object.assign(document.createElement("li"), { textContent: w })));
}

/** Every distinct region colour, exact hex, in region order. */
function showSource(info: string, hexes: string[]) {
  $("swatches").replaceChildren(
    ...[...new Set(hexes)].map((hex) => {
      const sw = document.createElement("span");
      sw.className = "sw";
      const chip = document.createElement("i");
      chip.style.background = hex;
      const code = document.createElement("code");
      code.textContent = hex;
      sw.append(chip, code);
      return sw;
    }),
  );
  $("srcinfo").textContent = info;
  $("source").hidden = false;
}

function reject(text: string, list: string[] = []) {
  regions = [];
  mesh = null;
  msg.textContent = text;
  showWarnings(list);
  $("source").hidden = true;
  $("layers").hidden = true;
  stats.textContent = "";
  dl.disabled = true;
  overlay.setMesh(null);
}

/** A new file: its regions, their automatic levels, no overrides. */
function setRegions(flat: Region[]) {
  regions = flat;
  levels = containmentLevels(flat);
  overrides.clear();
  $("layers").hidden = flat.length < 2;
  $("layerlist").replaceChildren(
    ...flat.map((r, i) => {
      const row = document.createElement("label");
      row.className = "lr";
      const chip = document.createElement("i");
      chip.style.background = r.hex;
      const code = document.createElement("code");
      code.textContent = r.hex;
      const n = document.createElement("input");
      Object.assign(n, { type: "number", min: "0", max: "9", step: "1", value: String(levels[i]) });
      n.setAttribute("aria-label", `Layer level of region ${i + 1}, ${r.hex}`);
      n.addEventListener("input", () => {
        const v = Math.round(n.valueAsNumber);
        if (!Number.isFinite(v)) return;
        if (v === levels[i]) overrides.delete(i);
        else overrides.set(i, v);
        rebuild();
      });
      row.append(chip, code, n);
      return row;
    }),
  );
}

async function loadSvg(blob: Blob, name: string) {
  const doc = new DOMParser().parseFromString(await blob.text(), "image/svg+xml");
  if (doc.getElementsByTagName("parsererror").length) return reject(`${name}: this is not valid SVG (the XML could not be parsed).`);
  const svg = parseSvg(doc);
  if (!svg.regions.length) return reject(`${name}: no filled shapes to build from.`, svg.warnings);
  setRegions(flattenPaintOrder(svg.regions));
  src = { width: svg.width, height: svg.height };
  baseName = name.replace(/\.[^.]+$/, "") || "relief";
  msg.textContent = "";
  showWarnings(svg.warnings);
  const n = regions.length;
  showSource(`${name}, ${svg.width.toFixed(0)}x${svg.height.toFixed(0)}, ${n} shape${n === 1 ? "" : "s"}`, regions.map((r) => r.hex));
  rebuild();
}

async function loadBlob(blob: Blob, name: string) {
  if (!/^image\/(png|jpeg|webp)$/.test(blob.type)) return reject(`${name}: not a PNG, JPEG or WebP image.`);
  let bmp: ImageBitmap;
  try {
    // "none": no ICC/gamma conversion — the pixel values ARE the brand colour
    bmp = await createImageBitmap(blob, { colorSpaceConversion: "none" });
  } catch {
    return reject(`${name}: the browser could not decode this image.`);
  }
  const cv = document.createElement("canvas");
  cv.width = bmp.width;
  cv.height = bmp.height;
  const g = cv.getContext("2d", { willReadFrequently: true })!;
  g.drawImage(bmp, 0, 0);
  const img = g.getImageData(0, 0, bmp.width, bmp.height);
  bmp.close();

  // The palette is read from the FULL image (exactness). Geometry is traced on a
  // copy capped at TRACE_MAX: tracing and the distance field scale with pixel
  // count and contour length, and a 4k logo would otherwise freeze the tab.
  const k = Math.min(1, TRACE_MAX / Math.max(img.width, img.height));
  let traceImg = img;
  if (k < 1) {
    const tc = document.createElement("canvas");
    tc.width = Math.max(1, Math.round(img.width * k));
    tc.height = Math.max(1, Math.round(img.height * k));
    const tg = tc.getContext("2d", { willReadFrequently: true })!;
    tg.drawImage(cv, 0, 0, tc.width, tc.height);
    traceImg = tg.getImageData(0, 0, tc.width, tc.height);
  }
  const res = regionsFromRaster(img, k < 1 ? { trace: traceImg } : {});
  if (!res.regions.length) return reject(`${name}: nothing to build from.`, res.warnings);

  setRegions(res.regions);
  src = { width: traceImg.width, height: traceImg.height };
  baseName = name.replace(/\.[^.]+$/, "") || "relief";
  msg.textContent = "";
  showWarnings(res.warnings);
  const nc = res.palette.length;
  const ns = res.regions.length;
  showSource(`${name}, ${img.width}x${img.height}, ${nc} colour${nc === 1 ? "" : "s"}, ${ns} shape${ns === 1 ? "" : "s"}`, res.palette);
  rebuild();
}

// ---------------------------------------------------------------- build + hand-off to the overlay preview
function rebuild() {
  if (!regions.length) return;
  const t0 = performance.now();
  try {
    const step = (inputs.get("layerStep") as HTMLInputElement).valueAsNumber;
    const layered = regions.map((r, i) => ({ ...r, depth: (overrides.get(i) ?? levels[i]) * step }));
    mesh = buildMesh(layered, { profile: readProfile(), source: src });
  } catch (e) {
    return reject(`Mesh build failed: ${e instanceof Error ? e.message : String(e)}`, warnings);
  }
  const ms = performance.now() - t0;
  stats.textContent = `${(mesh.indices.length / 3).toLocaleString()} triangles, built in ${ms.toFixed(0)} ms`;
  dl.disabled = false;
  overlay.setMesh(mesh, baseName);
}

dl.addEventListener("click", () => {
  if (!mesh) return;
  const bytes = meshToGlb(mesh, { unlit: $<HTMLInputElement>("unlit").checked });
  const blob = new Blob([bytes as BlobPart], { type: "model/gltf-binary" });
  if (desktop) {
    // the desktop window does not reliably handle <a download>: use the native Save dialog
    desktop.saveBlob(blob, `${baseName}.glb`).then(
      (path) => overlay.status(path ? `Saved to ${path}` : "Save cancelled."),
      (e) => overlay.status(`Save failed: ${e instanceof Error ? e.message : String(e)}`),
    );
    return;
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${baseName}.glb`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});

// ---------------------------------------------------------------- input: file picker, drag-and-drop, sample
const isSvg = (f: File) => f.type === "image/svg+xml" || /\.svg$/i.test(f.name);
const pick = (f: File | undefined) => { if (f) void (isSvg(f) ? loadSvg(f, f.name) : loadBlob(f, f.name)); };
$<HTMLInputElement>("file").addEventListener("change", (e) => {
  const inp = e.target as HTMLInputElement;
  pick(inp.files?.[0]);
  inp.value = ""; // so choosing the same file again still fires change
});
const drop = $("drop");
for (const t of ["dragenter", "dragover"]) document.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("hot"); });
for (const t of ["dragleave", "drop"]) document.addEventListener(t, () => drop.classList.remove("hot"));
document.addEventListener("drop", (e) => { e.preventDefault(); pick(e.dataTransfer?.files[0]); });

fetch("./sample.svg")
  .then((r) => r.blob())
  .then((b) => loadSvg(b, "sample.svg"))
  .catch(() => (msg.textContent = "Could not load the sample logo. Choose or drop an image."));
