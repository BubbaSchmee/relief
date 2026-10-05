/** P4 raster path: exact palette, no blend colours, disjoint regions, correct
 *  layering, background removal. The image is rasterised HERE, with 2x2
 *  supersampled antialiasing, so real edge blends exist for the palette to
 *  reject. */
import { Clipper, FillRule, Paths64 } from "clipper2-js";
import { describe, expect, it } from "vitest";
import { parseHex } from "../src/color.js";
import { regionsFromRaster, type RasterImage } from "../src/raster.js";
import { buildMesh } from "../src/mesh.js";
import type { Region } from "../src/types.js";
import { loadWordmark, WORDMARK_HEX, WORDMARK_SHAPES } from "./fixtures.js";
import { topology } from "./validate.js";

const PINK = "#FF2E9A";
const WHITE = "#FFFFFF";
const STEP = 0.03;
const SIZE = 400;
const RGB = { pink: parseHex(PINK), white: parseHex(WHITE) };

/** pink disc r=150 with a white disc r=84 on it, centred; `bg` = opaque
 *  background colour, or null for a transparent one. 2x2 supersampling:
 *  coverage becomes alpha (or blends into `bg`), colour is the mean of the
 *  covered samples, so pink/white and logo/background blends all occur. */
function ring(bg: string | null, size = SIZE, scale = 1): RasterImage {
  const data = new Uint8ClampedArray(size * size * 4);
  const c = size / 2;
  const bgc = bg ? parseHex(bg) : null;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, hits = 0;
      for (const [sx, sy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
        const d = Math.hypot(x + sx - c, y + sy - c) / scale;
        const col = d < 84 ? RGB.white : d < 150 ? RGB.pink : bgc;
        if (!col) continue;
        r += col.r; g += col.g; b += col.b; hits++;
      }
      const i = (y * size + x) * 4;
      if (hits) { data[i] = r / hits; data[i + 1] = g / hits; data[i + 2] = b / hits; }
      data[i + 3] = bg ? 255 : (hits / 4) * 255;
    }
  return { width: size, height: size, data };
}

/** 3x3 box blur of an opaque image: a soft, JPEG-ish edge a few pixels wide. */
function blur(img: RasterImage): RasterImage {
  const { width: W, height: H, data } = img;
  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      for (let c = 0; c < 3; c++) {
        let sum = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx >= 0 && yy >= 0 && xx < W && yy < H) { sum += data[(yy * W + xx) * 4 + c]; n++; }
          }
        out[(y * W + x) * 4 + c] = Math.round(sum / n);
      }
  for (let i = 3; i < data.length; i += 4) out[i] = 255;
  return { width: W, height: H, data: out };
}

/** Paint a logo from a colour-at-point function, 2x2 supersampled, transparent where it returns null. */
function paint(size: number, colourAt: (x: number, y: number) => string | null): RasterImage {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, hits = 0;
      for (const [sx, sy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
        const hex = colourAt(x + sx, y + sy);
        if (!hex) continue;
        const c = parseHex(hex);
        r += c.r; g += c.g; b += c.b; hits++;
      }
      const i = (y * size + x) * 4;
      if (hits) { data[i] = r / hits; data[i + 1] = g / hits; data[i + 2] = b / hits; }
      data[i + 3] = (hits / 4) * 255;
    }
  return { width: size, height: size, data };
}

const shoelace = (r: number[]) => {
  let a = 0;
  for (let i = 0; i < r.length; i += 2) {
    const j = (i + 2) % r.length;
    a += r[i] * r[j + 1] - r[j] * r[i + 1];
  }
  return a / 2;
};
const netArea = (r: Region) => shoelace(r.outer) + r.holes.reduce((a, h) => a + shoelace(h), 0);
const paths = (r: Region) =>
  [r.outer, ...r.holes].map((ring) => Clipper.makePath(ring.map((v) => Math.round(v * 1024)))) as unknown as Paths64;
/** Pairwise intersection area, in source px^2. */
const overlap = (a: Region, b: Region) => Math.abs(Clipper.areaPaths(Clipper.Intersect(paths(a), paths(b), FillRule.Positive))) / 1024 ** 2;

function check(res: ReturnType<typeof regionsFromRaster>) {
  const { regions, palette } = res;
  expect(palette).toEqual([PINK, WHITE]);
  expect(regions.every((r) => palette.includes(r.hex))).toBe(true);
  // exactly one ring and one disc
  expect(regions.map((r) => [r.hex, r.holes.length])).toEqual([[PINK, 1], [WHITE, 0]]);
  // no crack: the ring and the disc together cover the whole outer circle
  const pinkOuter = regions.find((r) => r.hex === PINK)!.outer;
  const covered = regions.reduce((a, r) => a + netArea(r), 0);
  expect(Math.abs(covered - shoelace(pinkOuter))).toBeLessThan(1e-9 * covered);
  // disjoint
  let worst = 0;
  for (let i = 0; i < regions.length; i++) for (let j = i + 1; j < regions.length; j++) worst = Math.max(worst, overlap(regions[i], regions[j]));
  console.log(`raster: worst pairwise overlap ${worst.toExponential(2)} px^2`);
  expect(worst).toBeLessThan(0.01);
  // layering: white a level in front of pink
  const white = regions.find((r) => r.hex === WHITE)!;
  const pink = regions.find((r) => r.hex === PINK)!;
  expect(pink.depth).toBe(0);
  expect(white.depth).toBeCloseTo(STEP, 12);
  // geometry sits where the logo is: radii within a pixel of the truth
  const rad = (r: Region) => Math.sqrt(Math.abs(shoelace(r.outer)) / Math.PI);
  expect(Math.abs(rad(pink) - 150)).toBeLessThan(1.5);
  expect(Math.abs(rad(white) - 84)).toBeLessThan(1.5);
  // the whole thing builds into a clean mesh
  const mesh = buildMesh(regions, { source: { width: SIZE, height: SIZE } });
  for (let ri = 0; ri < regions.length; ri++) {
    const idx: number[] = [];
    for (let t = 0; t < mesh.indices.length; t += 3) if (mesh.regionIndex[mesh.indices[t]] === ri) idx.push(mesh.indices[t], mesh.indices[t + 1], mesh.indices[t + 2]);
    const t = topology({ ...mesh, indices: Uint32Array.from(idx) }, 1e4);
    expect(t.badEdges).toBe(0);
    expect(t.slivers).toBe(0);
  }
}

describe("regionsFromRaster: two-colour ring", () => {
  it("transparent background: palette is exactly the two colours, regions disjoint, white in front", () => {
    const img = ring(null);
    // the premise: blend colours really exist in the image
    const distinct = new Set<number>();
    for (let i = 0; i < img.data.length; i += 4) if (img.data[i + 3] >= 250) distinct.add((img.data[i] << 16) | (img.data[i + 1] << 8) | img.data[i + 2]);
    console.log(`raster: ${distinct.size} distinct opaque colours in the transparent ring`);
    expect(distinct.size).toBeGreaterThan(2);
    const res = regionsFromRaster(img, { layerStep: STEP });
    expect(res.warnings).toEqual([]);
    check(res);
  });

  for (const bg of ["#102030", "#FFFFFF"])
    it(`opaque ${bg} background: removed, palette still exactly the two logo colours`, () => {
      const img = ring(bg);
      const res = regionsFromRaster(img, { layerStep: STEP });
      expect(res.warnings).toEqual([]);
      check(res);
    });

  for (const bg of ["#102030", "#FFFFFF"])
    it(`soft edges against ${bg}: no fringe layer, palette still exact, white still in front`, () => {
      const res = regionsFromRaster(blur(ring(bg)), { layerStep: STEP });
      expect(res.palette).toEqual([PINK, WHITE]);
      expect(res.regions.map((r) => [r.hex, r.holes.length, r.depth])).toEqual([[PINK, 1, 0], [WHITE, 0, STEP]]);
    });

  it("traces a downscaled copy but reads the palette from the full image", () => {
    const full = ring(null, 800, 2);
    const small = ring(null, 400);
    const res = regionsFromRaster(full, { trace: small, layerStep: STEP });
    check(res);
  });

  it("is deterministic", () => {
    const a = regionsFromRaster(ring("#102030"));
    const b = regionsFromRaster(ring("#102030"));
    expect(a).toEqual(b);
  });
});

/** Every region is a closed, sliver-free solid, also after a weld by distance of 1e-4. */
function solids(regions: Region[], size = SIZE) {
  const mesh = buildMesh(regions, { source: { width: size, height: size } });
  regions.forEach((_, ri) => {
    const idx: number[] = [];
    for (let t = 0; t < mesh.indices.length; t += 3) if (mesh.regionIndex[mesh.indices[t]] === ri) idx.push(mesh.indices[t], mesh.indices[t + 1], mesh.indices[t + 2]);
    const t = topology({ ...mesh, indices: Uint32Array.from(idx) }, 1e4);
    expect(t.badEdges).toBe(0);
    expect(t.slivers).toBe(0);
  });
}

describe("regionsFromRaster: richer layouts", () => {
  const BLUE = "#2E9AFF";
  it("a bullseye (pink, white, pink) stacks three levels and the inner pink is not lost", () => {
    const img = paint(SIZE, (x, y) => {
      const d = Math.hypot(x - 200, y - 200);
      return d < 70 ? PINK : d < 110 ? WHITE : d < 150 ? PINK : null;
    });
    const res = regionsFromRaster(img, { layerStep: STEP });
    expect(res.palette).toEqual([PINK, WHITE]);
    const byDepth = [...res.regions].sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0));
    expect(byDepth.map((r) => [r.hex, r.holes.length, Math.round((r.depth ?? 0) / STEP)])).toEqual([[PINK, 1, 0], [WHITE, 1, 1], [PINK, 0, 2]]);
    solids(res.regions);
  });

  it("a disc split into two colours inside a plate: siblings share a level, the plate is a frame", () => {
    const img = paint(SIZE, (x, y) => {
      if (Math.hypot(x - 200, y - 200) < 100) return x < 200 ? WHITE : BLUE;
      return x > 40 && x < 360 && y > 40 && y < 360 ? PINK : null;
    });
    const res = regionsFromRaster(img, { layerStep: STEP });
    expect(res.palette.length).toBe(3);
    expect(new Set(res.palette)).toEqual(new Set([PINK, WHITE, BLUE]));
    const lv = (hex: string) => res.regions.filter((r) => r.hex === hex).map((r) => Math.round((r.depth ?? 0) / STEP));
    expect(lv(PINK)).toEqual([0]);
    expect(lv(WHITE)).toEqual([1]);
    expect(lv(BLUE)).toEqual([1]);
    const total = res.regions.reduce((a, r) => a + netArea(r), 0);
    expect(Math.abs(total - 320 * 320)).toBeLessThan(0.02 * 320 * 320); // the plate's full area is covered
    solids(res.regions);
  });

  it("a counter (a hole nothing fills) stays open", () => {
    const img = paint(SIZE, (x, y) => (Math.hypot(x - 200, y - 200) < 150 && Math.hypot(x - 200, y - 200) > 90 ? PINK : Math.hypot(x - 200, y - 200) <= 90 && Math.hypot(x - 200, y - 200) > 40 ? WHITE : null));
    const res = regionsFromRaster(img, { layerStep: STEP });
    // pink ring around a white ring around a transparent counter
    expect(res.regions.map((r) => [r.hex, r.holes.length]).sort()).toEqual([[PINK, 1], [WHITE, 1]]);
    const white = res.regions.find((r) => r.hex === WHITE)!;
    expect(Math.abs(Math.abs(shoelace(white.holes[0])) - Math.PI * 40 ** 2)).toBeLessThan(0.05 * Math.PI * 40 ** 2);
  });
});

describe("regionsFromRaster: refusals and caps", () => {
  const solid = (w: number, h: number, fill: (x: number, y: number) => [number, number, number, number]): RasterImage => {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(fill(x, y), (y * w + x) * 4);
    return { width: w, height: h, data };
  };

  it("an opaque image whose corners disagree has no single background: zero regions and a clear warning", () => {
    const img = solid(100, 100, (x) => (x < 50 ? [255, 0, 0, 255] : [0, 0, 255, 255]));
    const res = regionsFromRaster(img);
    expect(res.regions).toEqual([]);
    expect(res.warnings.join(" ")).toMatch(/background/);
  });

  it("a fully transparent image yields nothing, with a warning", () => {
    const res = regionsFromRaster(solid(50, 50, () => [0, 0, 0, 0]));
    expect(res.regions).toEqual([]);
    expect(res.warnings.length).toBeGreaterThan(0);
  });

  it("caps the palette at 16 colours, most frequent first, and says so", () => {
    // 20 stripes of 100x100 px, widening so frequencies are distinct and ordered
    const widths = Array.from({ length: 20 }, (_, i) => 30 + (20 - i) * 6);
    const edges = widths.map((_, i) => widths.slice(0, i + 1).reduce((a, b) => a + b, 0));
    const img = solid(edges[19], 110, (x, y) => {
      if (y < 10) return [0, 0, 0, 0]; // a transparent strip, so there is no background to flood
      const s = edges.findIndex((e) => x < e);
      return [s * 12, 255 - s * 12, (s * 37) % 256, 255];
    });
    const res = regionsFromRaster(img);
    expect(res.palette.length).toBe(16);
    expect(res.warnings.join(" ")).toMatch(/16/);
    expect(res.palette[0]).toBe("#00FF00");
  });

  it("single colour: no neighbours, so the traced shape is not grown", () => {
    const img = solid(100, 60, (x, y) => (x >= 10 && x < 90 && y >= 10 && y < 50 ? [255, 46, 154, 255] : [0, 0, 0, 0]));
    const res = regionsFromRaster(img);
    expect(res.palette).toEqual([PINK]);
    expect(res.regions.length).toBe(1);
    expect(netArea(res.regions[0])).toBeCloseTo(80 * 40, 6);
  });
});

describe("regionsFromRaster: a wordmark raster", () => {
  it("RELIEF is one exact colour, level 0 everywhere, and is not grown", () => {
    const res = regionsFromRaster(loadWordmark());
    expect(res.palette).toEqual([WORDMARK_HEX]);
    expect(res.regions.length).toBe(WORDMARK_SHAPES);
    expect(res.regions.every((r) => r.hex === WORDMARK_HEX && r.depth === 0)).toBe(true);
  });
});
