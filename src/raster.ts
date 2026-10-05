/** A raster logo -> flat colour regions. Pure (no DOM), so it is testable in Node.
 *
 *  The one rule: EXACT colours. The palette is a histogram of exact RGB values
 *  over the opaque pixels, restricted to colours that are common AND own a flat
 *  pixel, so an antialiased edge blend can never become an entry; every other
 *  pixel is then SNAPPED to its nearest palette colour in CIELAB. Each colour's mask is traced on its own,
 *  the traced shapes are grown a hair so neighbours overlap instead of leaving
 *  a crack, the overlap is flattened away, and depth comes from containment
 *  (layers.ts). A logo with no transparency has its background flood-filled
 *  away first. */
import { rgbToLab, toHex, type Lab } from "./color.js";
import { assignContainmentDepth, containmentLevels, fillCoveredHoles, flattenPaintOrder, inflateRegions } from "./layers.js";
import { traceAlpha } from "./trace.js";
import type { Region } from "./types.js";

export interface RasterImage {
  width: number;
  height: number;
  data: Uint8ClampedArray; // RGBA
}

export interface RasterOptions {
  /** A downscaled copy to trace instead of `img` (the app caps tracing at
   *  1024px). The palette is still read from the full-size `img`. */
  trace?: RasterImage;
  /** Depth per containment level, in model units. Default 0.03. */
  layerStep?: number;
}

const MAX_PALETTE = 16;
const MIN_PIXELS = 50;
const MIN_SHARE = 0.002;
/** Background tolerance, CIELAB distance. */
const BG_TOL = 6;
/** Crack-closing growth, in trace pixels. */
const CRACK = 0.6;

const keyAt = (d: Uint8ClampedArray, p: number) => (d[p * 4] << 16) | (d[p * 4 + 1] << 8) | d[p * 4 + 2];
const rgbOf = (k: number) => ({ r: k >> 16, g: (k >> 8) & 255, b: k & 255 });
const dist = (a: Lab, b: Lab) => Math.hypot(a.L - b.L, a.a - b.a, a.b - b.b);

/** Lab of a packed RGB, memoised: logos are a handful of colours. */
function labCache() {
  const m = new Map<number, Lab>();
  return (k: number): Lab => {
    let l = m.get(k);
    if (!l) m.set(k, (l = rgbToLab(rgbOf(k))));
    return l;
  };
}

/** Background mask (1 = background) by flood fill from the four corners, or a
 *  string explaining why there is no single background to remove. Filling from
 *  the corners (not keying on the colour) leaves an enclosed patch of the
 *  background colour, like the white inside a pink ring, as part of the logo. */
function floodBackground(img: RasterImage, lab: (k: number) => Lab): Uint8Array | string {
  const { width: W, height: H, data: d } = img;
  const corners = [0, W - 1, (H - 1) * W, H * W - 1];
  const cl = corners.map((c) => lab(keyAt(d, c)));
  for (let i = 0; i < 4; i++)
    for (let j = i + 1; j < 4; j++)
      if (dist(cl[i], cl[j]) > BG_TOL)
        return "This image has no transparency and its four corners are different colours, so there is no single background to remove. Use a transparent PNG or a logo on a plain background.";
  const bg = new Uint8Array(W * H);
  const stack: number[] = [];
  corners.forEach((c, n) => {
    const seed = cl[n];
    const seedKey = keyAt(d, c);
    const near = (p: number) => {
      const k = keyAt(d, p);
      return k === seedKey || dist(lab(k), seed) <= BG_TOL;
    };
    if (bg[c] || !near(c)) return;
    bg[c] = 1;
    stack.push(c);
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % W;
      for (const q of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, p >= W ? p - W : -1, p < W * (H - 1) ? p + W : -1])
        if (q >= 0 && !bg[q] && near(q)) {
          bg[q] = 1;
          stack.push(q);
        }
    }
  });
  return bg;
}

/** Edge pixels that blend the background into the logo sit just outside the
 *  tolerance. Absorb the ones nearer the background colour than EVERY logo
 *  colour (a few passes, one pixel deep each). Without this, a palette colour
 *  that matches the background (the white inside a pink ring, on a white page)
 *  claims the pale blends around the whole silhouette and wraps it in a white
 *  layer. A palette colour within tolerance of the background is not a
 *  competitor here: it IS the background colour. */
function eatFringe(img: RasterImage, bg: Uint8Array, bgLab: Lab, palette: Lab[], lab: (k: number) => Lab): void {
  const pal = palette.filter((c) => dist(c, bgLab) > BG_TOL);
  if (!pal.length) return;
  const { width: W, height: H, data: d } = img;
  for (let pass = 0; pass < 3; pass++) {
    const eat: number[] = [];
    for (let p = 0; p < W * H; p++) {
      if (bg[p] || d[p * 4 + 3] < 128) continue;
      const x = p % W;
      if (!((x > 0 && bg[p - 1]) || (x < W - 1 && bg[p + 1]) || (p >= W && bg[p - W]) || (p < W * (H - 1) && bg[p + W]))) continue;
      const l = lab(keyAt(d, p));
      const db = dist(l, bgLab);
      if (pal.every((c) => db < dist(l, c))) eat.push(p);
    }
    if (!eat.length) return;
    for (const p of eat) bg[p] = 1;
  }
}

export function regionsFromRaster(
  img: RasterImage,
  opts: RasterOptions = {},
): { regions: Region[]; palette: string[]; warnings: string[] } {
  const warnings: string[] = [];
  const none = (why: string) => ({ regions: [] as Region[], palette: [] as string[], warnings: [...warnings, why] });
  const lab = labCache();
  const tr = opts.trace ?? img;
  const step = opts.layerStep ?? 0.03;

  // ---- background (only when there is no transparency at all)
  const transparent = (im: RasterImage) => {
    for (let i = 3; i < im.data.length; i += 4) if (im.data[i] < 250) return true;
    return false;
  };
  let bg: Uint8Array | null = null;
  let trBg: Uint8Array | null = null;
  if (!transparent(img)) {
    const a = floodBackground(img, lab);
    if (typeof a === "string") return none(a);
    bg = a;
    const b = tr === img ? a : floodBackground(tr, lab);
    if (typeof b === "string") return none(b);
    trBg = tr === img ? a.slice() : b; // the fringe pass edits trBg, never the palette's mask
  }

  // ---- palette: exact-RGB histogram over opaque, non-background pixels.
  // A colour must also own at least one FLAT pixel: all four neighbours the
  // exact same RGB. Counts alone cannot tell a blend from a colour once an edge
  // is long (a 150px-radius disc has ~300 px of each antialiasing level, above
  // the 0.2% floor). A blend pixel always touches a different colour, so a
  // blend colour has no flat pixel, at any size or edge length.
  const { width: iw, height: ih, data: id } = img;
  const live = (p: number) => id[p * 4 + 3] >= 250 && !(bg && bg[p]);
  const counts = new Map<number, number>();
  const flat = new Set<number>();
  let opaque = 0;
  let last = -1, run = 0, flatLast = -1;
  const flush = () => { if (last >= 0) counts.set(last, (counts.get(last) ?? 0) + run); };
  for (let p = 0; p < iw * ih; p++) {
    if (!live(p)) continue;
    opaque++;
    const k = keyAt(id, p);
    if (k === last) run++; // logos are long runs of one colour
    else { flush(); last = k; run = 1; }
    if (k === flatLast) continue;
    if (flat.has(k)) { flatLast = k; continue; }
    const x = p % iw;
    const same = (q: number) => live(q) && keyAt(id, q) === k;
    if ((x === 0 || same(p - 1)) && (x === iw - 1 || same(p + 1)) && (p < iw || same(p - iw)) && (p >= iw * (ih - 1) || same(p + iw))) {
      flat.add(k);
      flatLast = k;
    }
  }
  flush();
  const floor = Math.max(MIN_PIXELS, MIN_SHARE * opaque);
  const ranked = [...counts].filter(([k, n]) => n >= floor && flat.has(k)).sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  if (!ranked.length) return none(opaque ? "No solid colours found: this looks like a photo or a gradient, which RELIEF does not support." : "No opaque pixels to build from.");
  if (ranked.length > MAX_PALETTE) warnings.push(`More than ${MAX_PALETTE} colours: only the ${MAX_PALETTE} most common were kept.`);
  const keys = ranked.slice(0, MAX_PALETTE).map(([k]) => k);
  const palette = keys.map((k) => toHex(rgbOf(k)));
  const palLab = keys.map(lab);

  // ---- assign every pixel of the trace image to its nearest palette colour
  const { width: W, height: H, data: d } = tr;
  if (trBg) eatFringe(tr, trBg, lab(keyAt(d, 0)), palLab, lab);
  const slot = new Uint8Array(W * H).fill(255);
  const memo = new Map<number, number>();
  for (let p = 0; p < W * H; p++) {
    if (d[p * 4 + 3] < 128 || (trBg && trBg[p])) continue;
    const k = keyAt(d, p);
    let s = memo.get(k);
    if (s === undefined) {
      const l = lab(k);
      let best = Infinity;
      s = 0;
      palLab.forEach((c, i) => { const e = dist(l, c); if (e < best) { best = e; s = i; } });
      memo.set(k, s);
    }
    slot[p] = s;
  }

  // ---- one mask per colour, traced on its own
  let regions: Region[] = [];
  const mask: RasterImage = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4) };
  palette.forEach((hex, i) => {
    mask.data.fill(0);
    for (let p = 0; p < W * H; p++) if (slot[p] === i) mask.data[p * 4 + 3] = 255;
    for (const s of traceAlpha(mask)) regions.push({ hex, outer: s.outer, holes: s.holes });
  });
  if (!regions.length) return none("Nothing to trace (the coloured areas are too small).");

  // ---- neighbours: grow a hair, fill the holes other shapes fill, paint outermost
  // first, flatten the overlap. One colour has no neighbours and its shapes are
  // disjoint already, so it is left exactly as traced.
  if (palette.length > 1) {
    regions = fillCoveredHoles(inflateRegions(regions, CRACK));
    const level = containmentLevels(regions);
    regions = flattenPaintOrder(regions.map((r, i) => ({ r, i })).sort((a, b) => level[a.i] - level[b.i] || a.i - b.i).map((e) => e.r));
  }
  return { regions: assignContainmentDepth(regions, step), palette, warnings };
}
