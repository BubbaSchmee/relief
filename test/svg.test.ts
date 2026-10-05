// @vitest-environment happy-dom
/** P3: SVG in. Unit cases for the parser, then THE GATE (DESIGN.md §9): an SVG
 *  logo built from real curves must beat its own PNG rasterisation, traced,
 *  on the silhouette IoU bar. */
import { describe, expect, it } from "vitest";
import { buildMesh } from "../src/mesh.js";
import { parseSvg } from "../src/svg.js";
import { traceAlpha } from "../src/trace.js";
import type { Mesh, Region } from "../src/types.js";
import { iou, rasterFront, rasterRings, topology } from "./validate.js";

const parse = (body: string, attrs = 'viewBox="0 0 200 200"') =>
  parseSvg(new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`, "image/svg+xml"));

const shoelace = (r: number[]) => {
  let a = 0;
  for (let i = 0; i < r.length; i += 2) {
    const j = (i + 2) % r.length;
    a += r[i] * r[j + 1] - r[j] * r[i + 1];
  }
  return a / 2;
};
const netArea = (r: Region) => shoelace(r.outer) + r.holes.reduce((a, h) => a + shoelace(h), 0); // holes are negative
const box = (r: Region) => {
  const xs = r.outer.filter((_, i) => i % 2 === 0);
  const ys = r.outer.filter((_, i) => i % 2 === 1);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};
const near = (a: number, b: number, rel: number) => expect(Math.abs(a - b)).toBeLessThanOrEqual(Math.abs(b) * rel);

/** Every parsed region must survive the real mesher: closed, wound, no slivers. */
function sound(regions: Region[]) {
  expect(regions.length).toBeGreaterThan(0);
  for (const r of regions) {
    expect(shoelace(r.outer)).toBeGreaterThan(0);
    for (const h of r.holes) expect(shoelace(h)).toBeLessThan(0);
  }
  const t = topology(buildMesh(regions));
  expect(t.badEdges).toBe(0);
  expect(t.slivers).toBe(0);
  expect(t.consistentEdges).toBe(t.manifoldEdges * 2);
  expect(t.volume).toBeGreaterThan(0);
}

describe("parseSvg: shapes", () => {
  it("rect: exact outline, exact hex, positive outer", () => {
    const s = parse('<rect x="10" y="20" width="100" height="50" fill="#ff2e9a"/>');
    expect(s.regions.length).toBe(1);
    expect(s.regions[0].hex).toBe("#FF2E9A");
    expect(box(s.regions[0])).toEqual([10, 20, 110, 70]);
    expect(netArea(s.regions[0])).toBe(5000);
    expect([s.width, s.height]).toEqual([200, 200]);
    expect(s.warnings).toEqual([]);
    sound(s.regions);
  });

  it("rounded rect (rx only, ry follows; clamped to half the side)", () => {
    const s = parse('<rect x="0" y="0" width="100" height="50" rx="10" fill="red"/>');
    near(netArea(s.regions[0]), 5000 - (4 - Math.PI) * 100, 0.003);
    const pill = parse('<rect x="0" y="0" width="100" height="40" rx="500"/>'); // clamps to 50 x 20: an ellipse-ended pill
    near(netArea(pill.regions[0]), Math.PI * 50 * 20, 0.006); // small shape, absolute 0.1%-of-viewBox tolerance
    sound(s.regions);
    sound(pill.regions);
  });

  it("circle and ellipse", () => {
    const c = parse('<circle cx="100" cy="100" r="80"/>');
    near(netArea(c.regions[0]), Math.PI * 80 * 80, 0.003);
    const e = parse('<ellipse cx="100" cy="100" rx="90" ry="40"/>');
    near(netArea(e.regions[0]), Math.PI * 90 * 40, 0.003);
    sound(c.regions);
    sound(e.regions);
  });

  it("polygon, and polyline treated as closed", () => {
    const pg = parse('<polygon points="10,10 110,10 110,60 10,60"/>');
    const pl = parse('<polyline points="10 10 110 10 110 60 10 60" fill="blue"/>');
    expect(netArea(pg.regions[0])).toBe(5000);
    expect(netArea(pl.regions[0])).toBe(5000);
    sound(pl.regions);
  });

  it("path: relative, arc and absolute spellings of one shape agree", () => {
    const D = Math.PI * 50 * 50 / 2 + 50 * 100; // rectangle + half disc
    const abs = parse('<path d="M0 0H50A50 50 0 0 1 50 100H0Z"/>');
    const rel = parse('<path d="m0 0h50a50 50 0 0 1 0 100h-50z"/>');
    near(netArea(abs.regions[0]), D, 0.003);
    near(netArea(rel.regions[0]), D, 0.003);
    expect(box(abs.regions[0]).map(Math.round)).toEqual([0, 0, 100, 100]);
    sound(abs.regions);
  });

  it("path: Q, T (smooth quad), C, S (smooth cubic), implicit lineto, subpath after Z", () => {
    // parabola segment: (2/3) * base * height
    near(netArea(parse('<path d="M0 50Q50 -50 100 50Z"/>').regions[0]), (2 / 3) * 100 * 50, 0.003);
    // T reflects the control point: a wave whose bump and dip cancel against the rectangle below it
    const wave = parse('<path d="M0 100Q50 0 100 100T200 100V200H0Z"/>');
    near(netArea(wave.regions[0]), 20000, 0.003);
    // a full circle from four cubics (S supplies the mirrored control points)
    const k = 55.2285;
    const circ = parse(`<path d="M100 0C100 ${k} ${k} 100 0 100S-100 ${k} -100 0S-${k} -100 0 -100S100 -${k} 100 0Z"/>`, 'viewBox="-100 -100 200 200"');
    near(netArea(circ.regions[0]), Math.PI * 100 * 100, 0.003);
    // viewBox origin is mapped to (0,0)
    expect(box(circ.regions[0]).map(Math.round)).toEqual([0, 0, 200, 200]);
    // "M 0 0 10 0 10 10" has implicit linetos; a command after Z restarts at the subpath start
    expect(netArea(parse('<path d="M0 0 100 0 100 100 0 100Z"/>').regions[0])).toBe(10000);
    const two = parse('<path d="M0 0H10V10H0ZH-20V-20H0Z"/>'); // second shape starts at (0,0) again
    expect(two.regions.length).toBe(2);
    sound(circ.regions);
    sound(wave.regions);
  });

  it("transforms: nested translate+rotate+scale compose child-first", () => {
    const s = parse('<g transform="translate(100 50) rotate(90)"><g transform="scale(2)"><rect x="0" y="0" width="10" height="20"/></g></g>');
    expect(box(s.regions[0]).map((v) => Math.round(v * 1e6) / 1e6 + 0)).toEqual([60, 50, 100, 70]);
    expect(Math.round(netArea(s.regions[0]))).toBe(800);
    sound(s.regions);
  });

  it("transforms: rotate about a centre, skewX, skewY, matrix (mirror), on the element itself", () => {
    const r = (t: string) => box(parse(`<rect width="10" height="20" transform="${t}"/>`).regions[0]).map((v) => Math.round(v * 1e6) / 1e6 + 0);
    expect(r("rotate(90 10 10)")).toEqual([0, 0, 20, 10]);
    expect(r("skewX(45)")).toEqual([0, 0, 30, 20]);
    expect(r("skewY(45)")).toEqual([0, 0, 10, 30]);
    expect(r("matrix(1 0 0 -1 0 100)")).toEqual([0, 80, 10, 100]); // mirrored: orientation is re-normalised
    expect(r("scale(2 3) translate(1,1)")).toEqual([2, 3, 22, 63]);
    sound(parse('<rect width="10" height="20" transform="matrix(1 0 0 -1 0 100)"/>').regions);
  });

  it("viewBox origin shifts to 0,0; width/height attributes are the fallback; the bbox is the last resort", () => {
    const vb = parse('<rect x="50" y="60" width="10" height="10"/>', 'viewBox="50 50 100 80"');
    expect([vb.width, vb.height]).toEqual([100, 80]);
    expect(box(vb.regions[0])).toEqual([0, 10, 10, 20]);
    const wh = parse('<rect x="5" y="5" width="10" height="10"/>', 'width="120px" height="90"');
    expect([wh.width, wh.height]).toEqual([120, 90]);
    expect(box(wh.regions[0])).toEqual([5, 5, 15, 15]);
    const bb = parse('<rect x="30" y="40" width="10" height="20"/><circle cx="80" cy="50" r="10"/>', "");
    expect(bb.width).toBeCloseTo(60, 0);
    expect(bb.height).toBeCloseTo(20, 0);
    expect(Math.min(...bb.regions.map((r) => box(r)[0]))).toBe(0);
  });
});

describe("parseSvg: fill rules", () => {
  it("evenodd donut: one outer, one hole, hole negative", () => {
    const s = parse('<path fill-rule="evenodd" d="M0 0H100V100H0Z M25 25H75V75H25Z"/>');
    expect(s.regions.length).toBe(1);
    expect(s.regions[0].holes.length).toBe(1);
    expect(netArea(s.regions[0])).toBe(7500);
    sound(s.regions);
  });

  it("nonzero donut: a reversed inner ring is a hole; a same-direction inner ring is not", () => {
    const rev = parse('<path d="M0 0H100V100H0Z M25 25V75H75V25Z"/>');
    expect(rev.regions[0].holes.length).toBe(1);
    expect(netArea(rev.regions[0])).toBe(7500);
    const same = parse('<path d="M0 0H100V100H0Z M25 25H75V75H25Z"/>'); // nonzero fills the whole square
    expect(same.regions.length).toBe(1);
    expect(same.regions[0].holes.length).toBe(0);
    expect(netArea(same.regions[0])).toBe(10000);
    sound(rev.regions);
  });

  it("an island inside a hole is its own region", () => {
    const s = parse('<path fill-rule="evenodd" d="M0 0H100V100H0Z M20 20H80V80H20Z M40 40H60V60H40Z"/>');
    expect(s.regions.length).toBe(2);
    const [big, island] = s.regions;
    expect(big.holes.length).toBe(1);
    expect(island.holes.length).toBe(0);
    expect(netArea(big)).toBe(10000 - 3600);
    expect(netArea(island)).toBe(400);
    sound(s.regions);
  });

  it("clip-rule does not affect fills (it only governs clipping paths)", () => {
    // same-direction subpaths under the default nonzero rule: no hole, one region
    const s = parse('<path clip-rule="evenodd" d="M0 0H100V100H0Z M20 20H80V80H20Z"/>');
    expect(s.regions.length).toBe(1);
    expect(s.regions[0].holes.length).toBe(0);
  });

  // P4: depth is no longer paint order (layers.ts derives it from containment).
  // What parseSvg still guarantees is paint ORDER, bottom to top, with no depth.
  it("returns regions in paint order with no depth; elements that draw nothing yield none", () => {
    const s = parse('<rect width="10" height="10"/><rect width="10" height="10" fill="none"/><rect x="5" width="10" height="10" fill="red"/>');
    expect(s.regions.map((r) => r.hex)).toEqual(["#000000", "#FF0000"]);
    expect(s.regions.map((r) => r.depth)).toEqual([undefined, undefined]);
  });
});

describe("parseSvg: colour", () => {
  const hex = (body: string) => parse(body).regions.map((r) => r.hex);
  it("inherited fill, style attribute, rgb(), #rgb, named, currentColor, default black", () => {
    expect(hex('<g fill="#00ff00"><rect width="9" height="9"/><rect width="9" height="9" fill="blue"/></g>')).toEqual(["#00FF00", "#0000FF"]);
    expect(hex('<g fill="red"><g><rect width="9" height="9" style="fill: rgb(255, 128, 0)"/></g></g>')).toEqual(["#FF8000"]);
    expect(hex('<rect width="9" height="9" fill="#f80"/>')).toEqual(["#FF8800"]);
    expect(hex('<rect width="9" height="9" fill="orange"/>')).toEqual(["#FFA500"]);
    expect(hex('<g color="#336699"><rect width="9" height="9" fill="currentColor"/></g>')).toEqual(["#336699"]);
    expect(hex('<rect width="9" height="9"/>')).toEqual(["#000000"]);
    expect(hex('<style>.cls-1{fill:#e8e8e8}#top{fill:#102030}</style><rect class="cls-1" width="9" height="9"/><rect class="cls-1" id="top" width="9" height="9"/>')).toEqual(["#E8E8E8", "#102030"]);
  });
});

describe("parseSvg: refusals are loud, never silent", () => {
  it("text, gradient fills, stroke-only, fill+stroke", () => {
    const s = parse(
      '<text x="5" y="5">hi</text><text x="9" y="9">again</text>' +
        '<defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient></defs>' +
        '<rect width="50" height="50" fill="url(#g)"/>' +
        '<rect x="60" width="40" height="40" fill="none" stroke="black"/>' +
        '<rect x="110" width="40" height="40" fill="#112233" stroke="black"/>',
    );
    expect(s.regions.map((r) => r.hex)).toEqual(["#112233"]); // only the filled-and-stroked one survives, with its fill
    expect(s.warnings.filter((w) => /outlines/.test(w) && /text/.test(w)).length).toBe(1); // deduplicated
    expect(s.warnings.some((w) => /Gradient/.test(w))).toBe(true);
    expect(s.warnings.some((w) => /Stroke-only/.test(w))).toBe(true);
    expect(s.warnings.some((w) => /Strokes are ignored/.test(w))).toBe(true);
  });

  it("use, image, clip-path, mask, filter, opacity, bad colour", () => {
    const s = parse(
      '<defs><clipPath id="c"><rect width="5" height="5"/></clipPath><path id="p" d="M0 0H9V9Z"/></defs>' +
        '<use href="#p"/><image href="x.png"/>' +
        '<rect width="20" height="20" clip-path="url(#c)" opacity="0.5"/>' +
        '<rect x="30" width="20" height="20" filter="url(#f)" mask="url(#m)"/>' +
        '<rect x="60" width="20" height="20" fill="hsl(10 20% 30%)"/>',
    );
    for (const re of [/<use>/, /<image>/, /clip-path/, /mask/, /filter/, /Opacity/, /hsl/]) expect(s.warnings.some((w) => re.test(w))).toBe(true);
    expect(s.regions.length).toBe(2); // the bad-colour one was skipped
  });

  it("display:none and visibility:hidden are skipped silently", () => {
    const s = parse('<g display="none"><rect width="9" height="9"/></g><rect width="9" height="9" style="visibility:hidden"/><rect x="20" width="9" height="9"/>');
    expect(s.regions.length).toBe(1);
    expect(s.warnings).toEqual([]);
  });

  it("zero regions: an empty list plus warnings, never a throw", () => {
    const s = parse("<text>only text</text>");
    expect(s.regions).toEqual([]);
    expect(s.warnings.length).toBe(1);
    expect(parse("").regions).toEqual([]);
    expect(parseSvg(new DOMParser().parseFromString("<html/>", "text/html")).regions).toEqual([]);
  });
});

// ---------------------------------------------------------------- THE GATE
// A logo with real curves: an arc-built ring, a rounded-rect bar, a leaf from
// two cubics. Ground truth is the shape itself, sampled FINELY and independently
// of parseSvg's flattening, so flatten error counts against path A.
describe("P3 gate: an SVG logo beats its own PNG rasterisation, traced", () => {
  const SVG =
    '<path fill="#FF2E9A" fill-rule="evenodd" d="M20 110A90 90 0 1 0 200 110A90 90 0 1 0 20 110Z M55 110A55 55 0 1 0 165 110A55 55 0 1 0 55 110Z"/>' +
    '<rect fill="#2E9AFF" x="20" y="225" width="260" height="50" rx="25"/>' +
    '<path fill="#FFB000" d="M250 20C300 60 300 140 250 200C220 150 220 70 250 20Z"/>';

  const fine = (n: number, f: (t: number) => [number, number]) => Array.from({ length: n }, (_, i) => f(i / n)).flat();
  const arc = (cx: number, cy: number, r: number, n: number, dir = 1) => fine(n, (t) => [cx + r * Math.cos(dir * t * 2 * Math.PI), cy + r * Math.sin(dir * t * 2 * Math.PI)]);
  const bez = (p: number[], n: number) => fine(n, (t) => {
    const u = 1 - t;
    return [0, 1].map((k) => u * u * u * p[k] + 3 * u * u * t * p[2 + k] + 3 * u * t * t * p[4 + k] + t * t * t * p[6 + k]) as [number, number];
  });
  const pill: number[] = [];
  const corner = (cx: number, cy: number, a0: number) => { for (let i = 0; i < 90; i++) { const a = a0 + (i / 90) * (Math.PI / 2); pill.push(cx + 25 * Math.cos(a), cy + 25 * Math.sin(a)); } };
  corner(255, 250, -Math.PI / 2); corner(255, 250, 0); // right cap
  corner(45, 250, Math.PI / 2); corner(45, 250, Math.PI); // left cap
  const truth = [
    arc(110, 110, 90, 400), arc(110, 110, 55, 400, -1), pill,
    [...bez([250, 20, 300, 60, 300, 140, 250, 200], 300), ...bez([250, 200, 220, 150, 220, 70, 250, 20], 300)],
  ];

  type Frame = { sc: number; cx: number; cy: number; k: number };
  /** buildMesh's normalisation, replicated: bbox of the OUTER rings of `regions`. */
  const frame = (regions: { outer: number[] }[], k: number): Frame => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const r of regions) for (let i = 0; i < r.outer.length; i += 2) { x0 = Math.min(x0, r.outer[i]); x1 = Math.max(x1, r.outer[i]); y0 = Math.min(y0, r.outer[i + 1]); y1 = Math.max(y1, r.outer[i + 1]); }
    return { sc: Math.min(2 / (x1 - x0), 2.4 / (y1 - y0)), cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, k };
  };
  /** Re-express a mesh's model-space xy in the truth's frame: undo its own
   *  normalisation back to SVG units, then apply the truth's. Both meshes are
   *  then judged on one grid, including any bbox registration error. */
  const reframe = (m: Mesh, from: Frame, to: Frame): Mesh => {
    const p = Float32Array.from(m.positions);
    for (let i = 0; i < p.length; i += 3) {
      const sx = (p[i] / from.sc + from.cx) / from.k;
      const sy = (from.cy - p[i + 1] / from.sc) / from.k;
      p[i] = (sx - to.cx) * to.sc;
      p[i + 1] = (to.cy - sy) * to.sc;
    }
    return { ...m, positions: p };
  };

  it("IoU(A: SVG -> parseSvg -> buildMesh) >= 0.995 and > IoU(B: raster 600px -> traceAlpha -> buildMesh)", () => {
    const svg = parse(SVG, 'viewBox="0 0 300 300"');
    expect(svg.regions.length).toBe(3);
    expect(svg.regions.map((r) => r.holes.length)).toEqual([1, 0, 0]);
    expect(svg.warnings).toEqual([]);

    // ---- ground truth, on a common grid in model space
    const tf = frame([{ outer: truth.flat() }], 1);
    const N = 640;
    const W = 1.02;
    const toModel = (ring: number[]) => ring.map((v, i) => (i % 2 ? (tf.cy - v) * tf.sc : (v - tf.cx) * tf.sc));
    const gt = rasterRings(truth.map(toModel), -W, -W, W, W, N);

    // ---- path A
    const meshA = buildMesh(svg.regions, { source: { width: svg.width, height: svg.height } });
    const tA = topology(meshA);
    expect(tA.badEdges).toBe(0);
    expect(tA.slivers).toBe(0);
    expect(tA.consistentEdges).toBe(tA.manifoldEdges * 2);
    const iouA = iou(rasterFront(reframe(meshA, frame(svg.regions, 1), tf), -W, -W, W, W, N), gt);
    // flattening alone, before any meshing: the parsed rings against the truth
    const iouRings = iou(rasterRings(svg.regions.flatMap((r) => [r.outer, ...r.holes]).map((r) => toModel(r)), -W, -W, W, W, N), gt);

    // ---- path B: the same shape as a 600px-wide alpha raster
    const PX = 600;
    const k = PX / 300;
    const mask = rasterRings(truth, 0, 0, 300, 300, PX);
    const data = new Uint8ClampedArray(PX * PX * 4);
    for (let i = 0; i < mask.length; i++) data[i * 4 + 3] = mask[i] ? 255 : 0;
    const shapes = traceAlpha({ width: PX, height: PX, data });
    const regionsB: Region[] = shapes.map((s) => ({ hex: "#FF2E9A", outer: s.outer, holes: s.holes }));
    const meshB = buildMesh(regionsB, { source: { width: PX, height: PX } });
    const iouB = iou(rasterFront(reframe(meshB, frame(regionsB, k), tf), -W, -W, W, W, N), gt);

    console.log(`P3 gate  IoU(A svg->mesh) = ${iouA.toFixed(5)}   IoU(B raster->trace->mesh) = ${iouB.toFixed(5)}   parsed rings alone = ${iouRings.toFixed(5)}   tris A=${tA.triangles}`);
    expect(iouA).toBeGreaterThanOrEqual(0.995);
    expect(iouA).toBeGreaterThan(iouB);
    expect(iouRings).toBeGreaterThanOrEqual(0.995);
  }, 120_000);

  it("the parse is deterministic: byte-identical regions on a second run", () => {
    expect(JSON.stringify(parse(SVG, 'viewBox="0 0 300 300"'))).toBe(JSON.stringify(parse(SVG, 'viewBox="0 0 300 300"')));
  });
});
