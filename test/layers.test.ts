// @vitest-environment happy-dom
/** P4 gate: a white disc on a pink disc is a pink RING with a white disc in its
 *  hole, the white one a level in front, and it stays visible under rotation.
 *  Everything here is deterministic. */
import { describe, expect, it } from "vitest";
import { hexToBaseColorFactor } from "../src/color.js";
import { meshToGlb } from "../src/gltf.js";
import { assignContainmentDepth, fillCoveredHoles, flattenPaintOrder, inflateRegions, layerRegions } from "../src/layers.js";
import { buildMesh } from "../src/mesh.js";
import { parseSvg } from "../src/svg.js";
import { FaceKind, type Mesh, type Region } from "../src/types.js";
import { asHole, circle, rect } from "./fixtures.js";
import { topology, weld } from "./validate.js";

const PINK = "#FF2E9A";
const WHITE = "#FFFFFF";
const STEP = 0.03;

const shoelace = (r: number[]) => {
  let a = 0;
  for (let i = 0; i < r.length; i += 2) {
    const j = (i + 2) % r.length;
    a += r[i] * r[j + 1] - r[j] * r[i + 1];
  }
  return a / 2;
};
const netArea = (r: Region) => shoelace(r.outer) + r.holes.reduce((a, h) => a + shoelace(h), 0); // holes are negative
const total = (rs: Region[]) => rs.reduce((a, r) => a + netArea(r), 0);

/** pink disc r=75 with a white disc r=42 painted on top, same centre */
const ringStack: Region[] = [
  { hex: PINK, outer: circle(100, 100, 75), holes: [] },
  { hex: WHITE, outer: circle(100, 100, 42), holes: [] },
];

// ---------------------------------------------------------------- flattenPaintOrder
describe("flattenPaintOrder", () => {
  it("leaves non-overlapping shapes unchanged in area", () => {
    const out = flattenPaintOrder([
      { hex: PINK, outer: rect(0, 0, 10, 10), holes: [] },
      { hex: WHITE, outer: rect(20, 0, 10, 10), holes: [] },
    ]);
    expect(out.map((r) => r.hex)).toEqual([PINK, WHITE]);
    out.forEach((r) => expect(netArea(r)).toBeCloseTo(100, 6));
  });

  it("a full cover removes the shape underneath", () => {
    const out = flattenPaintOrder([
      { hex: PINK, outer: rect(0, 0, 10, 10), holes: [] },
      { hex: WHITE, outer: rect(-5, -5, 20, 20), holes: [] },
    ]);
    expect(out.map((r) => r.hex)).toEqual([WHITE]);
    expect(netArea(out[0])).toBeCloseTo(400, 6);
  });

  it("partial overlap: the areas add up to the union, and no colour is blended", () => {
    const out = flattenPaintOrder([
      { hex: PINK, outer: rect(0, 0, 10, 10), holes: [] },
      { hex: WHITE, outer: rect(5, 0, 10, 10), holes: [] },
    ]);
    expect(out.map((r) => [r.hex, Math.round(netArea(r))])).toEqual([[PINK, 50], [WHITE, 100]]);
    expect(total(out)).toBeCloseTo(150, 6);
  });

  it("a bar across a disc splits it into two regions of the same hex", () => {
    const out = flattenPaintOrder([
      { hex: PINK, outer: circle(100, 100, 50), holes: [] },
      { hex: WHITE, outer: rect(0, 90, 200, 20), holes: [] },
    ]);
    expect(out.filter((r) => r.hex === PINK).length).toBe(2);
    expect(out.filter((r) => r.hex === WHITE).length).toBe(1);
  });

  it("emits outers with positive shoelace area and holes negative", () => {
    for (const r of flattenPaintOrder(ringStack)) {
      expect(shoelace(r.outer)).toBeGreaterThan(0);
      for (const h of r.holes) expect(shoelace(h)).toBeLessThan(0);
    }
  });

  it("an island inside a hole stays its own region, not a hole of the outer", () => {
    const out = flattenPaintOrder([
      { hex: PINK, outer: circle(100, 100, 80), holes: [asHole(circle(100, 100, 50))] },
      { hex: WHITE, outer: circle(100, 100, 20), holes: [] },
    ]);
    expect(out.map((r) => r.holes.length)).toEqual([1, 0]);
  });

  it("is deterministic", () => {
    expect(flattenPaintOrder(ringStack)).toEqual(flattenPaintOrder(ringStack));
  });
});

describe("inflateRegions", () => {
  it("grows a disc by the delta, keeping the hex", () => {
    const out = inflateRegions([{ hex: PINK, outer: circle(100, 100, 50, 128), holes: [] }], 2);
    expect(out.length).toBe(1);
    expect(out[0].hex).toBe(PINK);
    expect(netArea(out[0])).toBeGreaterThan(Math.PI * 51 ** 2);
    expect(netArea(out[0])).toBeLessThan(Math.PI * 52.2 ** 2);
  });

  it("shrinks a hole's neighbour: a ring's hole gets smaller when inflated", () => {
    const [ring] = inflateRegions([{ hex: PINK, outer: circle(100, 100, 80), holes: [asHole(circle(100, 100, 50))] }], 1);
    expect(ring.holes.length).toBe(1);
    expect(Math.abs(shoelace(ring.holes[0]))).toBeLessThan(Math.PI * 50 ** 2);
  });
});

describe("fillCoveredHoles", () => {
  const ringWith = (inner: number): Region[] => [
    { hex: PINK, outer: circle(100, 100, 80), holes: [asHole(circle(100, 100, 50))] },
    { hex: WHITE, outer: circle(100, 100, inner), holes: [] },
  ];
  it("drops a hole that another region fills", () => {
    expect(fillCoveredHoles(ringWith(50))[0].holes.length).toBe(0);
    expect(fillCoveredHoles(ringWith(51))[0].holes.length).toBe(0); // overlapping the rim is still filling it
  });
  it("keeps a hole nothing fills, and a hole only partly filled (a real gap)", () => {
    expect(fillCoveredHoles([ringWith(50)[0]])[0].holes.length).toBe(1);
    expect(fillCoveredHoles(ringWith(30))[0].holes.length).toBe(1); // 36% covered
    expect(fillCoveredHoles(ringWith(46))[0].holes.length).toBe(1); // 85% covered: a 4-unit gap is real
  });
  it("the filled ring flattens to a hole that IS the inner outline, exactly", () => {
    const [ring, disc] = flattenPaintOrder(fillCoveredHoles(ringWith(50.4)));
    expect(ring.holes.length).toBe(1);
    expect(Math.abs(Math.abs(shoelace(ring.holes[0])) - shoelace(disc.outer))).toBeLessThan(1e-6 * shoelace(disc.outer));
  });
});

// ---------------------------------------------------------------- the ring
describe("SVG ring: a white disc painted over a pink disc", () => {
  const layered = layerRegions(ringStack, STEP);
  const pink = layered.filter((r) => r.hex === PINK);
  const white = layered.filter((r) => r.hex === WHITE);

  it("becomes one pink ring (exactly one hole) and one white disc a level in front", () => {
    expect(layered.length).toBe(2);
    expect(pink.length).toBe(1);
    expect(pink[0].holes.length).toBe(1);
    expect(pink[0].depth).toBe(0);
    expect(white.length).toBe(1);
    expect(white[0].holes.length).toBe(0);
    expect(white[0].depth).toBeCloseTo(STEP, 12);
  });

  it("the pink hole IS the white disc: no gap, no overlap", () => {
    const whole = shoelace(circle(100, 100, 75));
    expect(Math.abs(netArea(pink[0]) + netArea(white[0]) - whole)).toBeLessThan(1e-6 * whole); // Clipper's 2^-16 grid
  });

  it("works through the real parseSvg pipeline", () => {
    const doc = new DOMParser().parseFromString(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><circle cx="100" cy="100" r="75" fill="${PINK}"/><circle cx="100" cy="100" r="42" fill="${WHITE}"/></svg>`,
      "image/svg+xml",
    );
    const svg = parseSvg(doc);
    expect(svg.regions.map((r) => r.depth)).toEqual([undefined, undefined]);
    const out = layerRegions(svg.regions, STEP);
    expect(out.map((r) => [r.hex, r.holes.length, r.depth])).toEqual([[PINK, 1, 0], [WHITE, 0, STEP]]);
  });

  const mesh = buildMesh(layered);
  const wi = mesh.regionHex.indexOf(WHITE);
  const pi = mesh.regionHex.indexOf(PINK);
  const R_WHITE = (42 * 2) / 150; // white radius in model units: the logo is 150 wide -> 2
  /** The triangles of one region only: its own shell, on its own. */
  const shell = (m: Mesh, region: number): Mesh => {
    const idx: number[] = [];
    for (let t = 0; t < m.indices.length; t += 3) if (m.regionIndex[m.indices[t]] === region) idx.push(m.indices[t], m.indices[t + 1], m.indices[t + 2]);
    return { ...m, indices: Uint32Array.from(idx) };
  };

  it("builds watertight, sliver-free solids that survive Merge by Distance", () => {
    for (const q of [1e5, 1e4])
      for (const region of [pi, wi]) {
        const t = topology(shell(mesh, region), q);
        expect(t.badEdges).toBe(0);
        expect(t.slivers).toBe(0);
        expect(t.consistentEdges).toBe(t.manifoldEdges * 2);
        expect(t.volume).toBeGreaterThan(0);
      }
    for (const q of [1e5, 1e4]) expect(topology(mesh, q).slivers).toBe(0);
  });

  // Two solids that touch along a wall are two shells, not one manifold: welded
  // by position, an edge on the shared contour belongs to both regions' faces.
  // Pin that down: the ONLY such edges are on the contour the regions share.
  it("welded across regions, the only non-manifold edges lie on the contour the two share", () => {
    const { map } = weld(mesh, 1e4);
    const faces = new Map<string, number>();
    const at = new Map<number, [number, number]>();
    for (let t = 0; t < mesh.indices.length; t += 3)
      for (let e = 0; e < 3; e++) {
        const a = mesh.indices[t + e], b = mesh.indices[t + ((e + 1) % 3)];
        const u = map[a], v = map[b];
        at.set(u, [mesh.positions[a * 3], mesh.positions[a * 3 + 1]]);
        at.set(v, [mesh.positions[b * 3], mesh.positions[b * 3 + 1]]);
        const k = u < v ? u + "-" + v : v + "-" + u;
        faces.set(k, (faces.get(k) ?? 0) + 1);
      }
    let bad = 0;
    for (const [k, n] of faces) {
      if (n === 2) continue;
      bad++;
      for (const id of k.split("-")) {
        const [x, y] = at.get(+id)!;
        expect(Math.abs(Math.hypot(x, y) - R_WHITE)).toBeLessThan(2e-3);
      }
    }
    console.log(`welded whole-mesh non-manifold edges (all on the shared contour): ${bad}`);
  });

  it("every front material carries its region's exact linear hex", () => {
    const glb = meshToGlb(mesh);
    const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
    const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + dv.getUint32(12, true))));
    const fronts = json.materials.filter((m: { name: string }) => m.name.startsWith("front "));
    expect(fronts.map((m: { name: string }) => m.name.slice(6)).sort()).toEqual([PINK, WHITE].sort());
    for (const m of fronts) expect(m.pbrMetallicRoughness.baseColorFactor).toEqual(hexToBaseColorFactor(m.name.slice(6)));
  });

  // ---- OCCLUSION: a CPU z-buffer, orthographic, looking down -z.
  const N = 480;
  const EXT = 1.25;
  type Hit = { region: Int16Array; kind: Int8Array };
  /** Nearest triangle per pixel (any kind occludes); `only` limits which
   *  triangles are drawn at all. Mesh is rotated about y by `yaw` first. */
  function zbuffer(m: Mesh, yaw: number, only?: (region: number, kind: number) => boolean): Hit {
    const s = Math.sin(yaw), c = Math.cos(yaw);
    const nV = m.positions.length / 3;
    const X = new Float64Array(nV), Y = new Float64Array(nV), Z = new Float64Array(nV);
    for (let i = 0; i < nV; i++) {
      const x = m.positions[i * 3], z = m.positions[i * 3 + 2];
      X[i] = x * c + z * s;
      Y[i] = m.positions[i * 3 + 1];
      Z[i] = -x * s + z * c;
    }
    const depth = new Float64Array(N * N).fill(-Infinity);
    const region = new Int16Array(N * N).fill(-1);
    const kind = new Int8Array(N * N).fill(-1);
    const px = (v: number) => ((v + EXT) / (2 * EXT)) * N;
    const py = (v: number) => ((EXT - v) / (2 * EXT)) * N;
    for (let t = 0; t < m.indices.length; t += 3) {
      const a = m.indices[t], b = m.indices[t + 1], d = m.indices[t + 2];
      if (only && !only(m.regionIndex[a], m.faceKind[a])) continue;
      const ax = px(X[a]), ay = py(Y[a]), bx = px(X[b]), by = py(Y[b]), cx = px(X[d]), cy = py(Y[d]);
      const area2 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (Math.abs(area2) < 1e-12) continue;
      const i0 = Math.max(0, Math.floor(Math.min(ax, bx, cx) - 1)), i1 = Math.min(N - 1, Math.ceil(Math.max(ax, bx, cx) + 1));
      const j0 = Math.max(0, Math.floor(Math.min(ay, by, cy) - 1)), j1 = Math.min(N - 1, Math.ceil(Math.max(ay, by, cy) + 1));
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const x = i + 0.5, y = j + 0.5;
          const w0 = ((bx - x) * (cy - y) - (by - y) * (cx - x)) / area2;
          const w1 = ((cx - x) * (ay - y) - (cy - y) * (ax - x)) / area2;
          const w2 = 1 - w0 - w1;
          if (w0 < -1e-9 || w1 < -1e-9 || w2 < -1e-9) continue;
          const z = w0 * Z[a] + w1 * Z[b] + w2 * Z[d];
          if (z > depth[j * N + i]) {
            depth[j * N + i] = z;
            region[j * N + i] = m.regionIndex[a];
            kind[j * N + i] = m.faceKind[a];
          }
        }
    }
    return { region, kind };
  }

  const colour = (k: number) => k === FaceKind.Front || k === FaceKind.Bevel;

  it("head-on, at least 98% of the white disc's pixels show white", () => {
    const hit = zbuffer(mesh, 0);
    let inside = 0, white = 0;
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++) {
        const x = -EXT + ((i + 0.5) / N) * 2 * EXT, y = EXT - ((j + 0.5) / N) * 2 * EXT;
        if (x * x + y * y > R_WHITE * R_WHITE) continue;
        inside++;
        if (hit.region[j * N + i] === wi && colour(hit.kind[j * N + i])) white++;
      }
    console.log(`occlusion yaw 0: ${white}/${inside} white = ${((100 * white) / inside).toFixed(2)}%`);
    expect(inside).toBeGreaterThan(10000);
    expect(white / inside).toBeGreaterThanOrEqual(0.98);
  });

  for (const deg of [35, -35]) {
    it(`at yaw ${deg} deg the white disc is still visible and no pink shows in its central 80%`, () => {
      const yaw = (deg * Math.PI) / 180;
      const hit = zbuffer(mesh, yaw);
      // the white disc's projected area: where its front would be seen if nothing else were drawn
      const alone = zbuffer(mesh, yaw, (r, k) => r === wi && colour(k));
      let n = 0, cx = 0, cy = 0;
      for (let p = 0; p < N * N; p++) if (alone.region[p] === wi) { n++; cx += p % N; cy += Math.floor(p / N); }
      cx /= n; cy /= n;
      let visible = 0;
      for (let p = 0; p < N * N; p++) if (hit.region[p] === wi && colour(hit.kind[p])) visible++;
      // central 80% BY AREA: shrink the silhouette about its centroid by sqrt(0.8)
      const f = Math.sqrt(0.8);
      let central = 0, pinkFront = 0, pinkSide = 0, whiteShown = 0;
      for (let j = 0; j < N; j++)
        for (let i = 0; i < N; i++) {
          const ox = Math.round(cx + (i + 0.5 - cx) / f - 0.5), oy = Math.round(cy + (j + 0.5 - cy) / f - 0.5);
          if (ox < 0 || oy < 0 || ox >= N || oy >= N || alone.region[oy * N + ox] !== wi) continue;
          central++;
          const q = j * N + i;
          if (hit.region[q] === pi && colour(hit.kind[q])) pinkFront++;
          if (hit.region[q] === pi && !colour(hit.kind[q])) pinkSide++;
          if (hit.region[q] === wi && colour(hit.kind[q])) whiteShown++;
        }
      console.log(`occlusion yaw ${deg}: white visible ${visible}px of ${n}; central ${central}px: white ${whiteShown}, pink front/bevel ${pinkFront}, pink wall ${pinkSide}`);
      expect(visible).toBeGreaterThan(0);
      expect(central).toBeGreaterThan(5000);
      expect(pinkFront).toBe(0);
    });
  }
});

describe("assignContainmentDepth", () => {
  it("siblings share a level, nested regions stack, edge-sharing neighbours are not nested", () => {
    const out = assignContainmentDepth(
      [
        { hex: PINK, outer: rect(0, 0, 100, 100), holes: [] },
        { hex: WHITE, outer: rect(20, 20, 20, 20), holes: [] }, // inside the pink
        { hex: "#112233", outer: rect(60, 60, 20, 20), holes: [] }, // sibling of the white
        { hex: "#445566", outer: rect(25, 25, 5, 5), holes: [] }, // inside the white inside the pink
        { hex: "#778899", outer: rect(100, 0, 50, 50), holes: [] }, // shares an edge with the pink
      ],
      0.1,
    );
    expect(out.map((r) => Math.round((r.depth ?? 0) / 0.1))).toEqual([0, 1, 1, 2, 0]);
  });

  it("touching a boundary from inside still counts as inside", () => {
    const out = assignContainmentDepth(
      [
        { hex: PINK, outer: rect(0, 0, 100, 100), holes: [] },
        { hex: WHITE, outer: rect(0, 0, 50, 50), holes: [] }, // shares a corner AND two edges
      ],
      1,
    );
    expect(out.map((r) => r.depth)).toEqual([0, 1]);
  });
});
