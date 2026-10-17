import { describe, expect, it } from "vitest";
import { buildMesh } from "../src/mesh.js";
import { DEFAULT_PROFILE, DEFAULT_TESSELLATION, FaceKind, type Region } from "../src/types.js";
import { FIXTURES, rect } from "./fixtures.js";
import { iou, rasterFront, rasterRings, topology } from "./validate.js";

/** The same normalisation buildMesh applies, so the silhouette can be compared
 *  in model space. Kept deliberately duplicated: if buildMesh's normalisation
 *  drifts, this test is what catches it. */
function toModel(regions: Region[]): number[][] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of regions)
    for (let i = 0; i < r.outer.length; i += 2) {
      minX = Math.min(minX, r.outer[i]); maxX = Math.max(maxX, r.outer[i]);
      minY = Math.min(minY, r.outer[i + 1]); maxY = Math.max(maxY, r.outer[i + 1]);
    }
  const sc = Math.min(2 / (maxX - minX), 2.4 / (maxY - minY));
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const rings: number[][] = [];
  for (const r of regions)
    for (const ring of [r.outer, ...r.holes]) {
      const m: number[] = [];
      for (let i = 0; i < ring.length; i += 2) m.push((ring[i] - cx) * sc, (cy - ring[i + 1]) * sc);
      rings.push(m);
    }
  return rings;
}

const N = 320;

describe("P1 gates, single region", () => {
  for (const [name, regions] of Object.entries(FIXTURES)) {
    describe(name, () => {
      const t0 = performance.now();
      const mesh = buildMesh(regions);
      const ms = performance.now() - t0;
      const topo = topology(mesh);

      it("builds something", () => {
        expect(mesh.indices.length).toBeGreaterThan(0);
        expect(mesh.positions.length / 3).toBeGreaterThan(0);
      });

      it("is watertight: every edge on exactly two faces", () => {
        expect(topo.badEdges).toBe(0);
        expect(topo.manifoldEdges).toBeGreaterThan(0);
      });

      it("has no slivers: no triangle collapses under weld", () => {
        expect(topo.slivers).toBe(0);
      });

      it("survives a weld by distance of 1e-4 (the default of common 3D tools)", () => {
        const t = topology(mesh, 1e4);
        expect(t.badEdges).toBe(0);
        expect(t.slivers).toBe(0);
      });

      it("is consistently wound, outward-facing", () => {
        // every directed edge has a twin going the other way
        expect(topo.consistentEdges).toBe(topo.manifoldEdges * 2);
        expect(topo.volume).toBeGreaterThan(0);
      });

      it("keeps the silhouette: IoU >= 0.98 against the source polygon", () => {
        const rings = toModel(regions);
        const src = rasterRings(rings, -1.05, -1.25, 1.05, 1.25, N);
        const got = rasterFront(mesh, -1.05, -1.25, 1.05, 1.25, N);
        expect(iou(src, got)).toBeGreaterThanOrEqual(0.98);
      });

      it("lifts the front above the base plane and never below", () => {
        const D = DEFAULT_PROFILE.extrude;
        let minFront = Infinity, maxFront = -Infinity;
        for (let i = 0; i < mesh.faceKind.length; i++) {
          if (mesh.faceKind[i] !== FaceKind.Front && mesh.faceKind[i] !== FaceKind.Bevel) continue;
          const z = mesh.positions[i * 3 + 2];
          minFront = Math.min(minFront, z);
          maxFront = Math.max(maxFront, z);
        }
        expect(minFront).toBeGreaterThanOrEqual(D / 2 - 1e-6);
        // a stroke rises at most inflate x its half-width, and no half-width exceeds 1.2 (model half-height)
        expect(maxFront).toBeLessThanOrEqual(D / 2 + DEFAULT_PROFILE.bevelHeight + DEFAULT_PROFILE.inflate * 1.2 + 1e-6);
      });

      if (name !== "hairline")
        it("actually gets a bevel band", () => {
          let n = 0;
          for (let i = 0; i < mesh.faceKind.length; i++) if (mesh.faceKind[i] === FaceKind.Bevel) n++;
          expect(n).toBeGreaterThan(0);
        });

      it("front normals point forward", () => {
        for (let i = 0; i < mesh.faceKind.length; i++) {
          if (mesh.faceKind[i] !== FaceKind.Front) continue;
          expect(mesh.normals[i * 3 + 2]).toBeGreaterThan(0);
        }
      });

      it(`stays under the triangle budget (${topo.triangles})`, () => {
        expect(topo.triangles).toBeLessThanOrEqual(50_000);
      });

      it(`converts in under 500 ms (${ms.toFixed(0)} ms)`, () => {
        expect(ms).toBeLessThan(500);
      });

      it("is deterministic: same input, byte-identical buffers", () => {
        const again = buildMesh(regions);
        expect(again.positions).toEqual(mesh.positions);
        expect(again.normals).toEqual(mesh.normals);
        expect(again.indices).toEqual(mesh.indices);
      });
    });
  }
});

describe("profile behaviour", () => {
  it("a zero dome and zero bevel is a flat prism", () => {
    const mesh = buildMesh(FIXTURES.slab, {
      profile: { ...DEFAULT_PROFILE, inflate: 0, bevelHeight: 0, bevelWidth: 0 },
    });
    const D = DEFAULT_PROFILE.extrude;
    for (let i = 0; i < mesh.faceKind.length; i++) {
      if (mesh.faceKind[i] !== FaceKind.Front) continue;
      expect(Math.abs(mesh.positions[i * 3 + 2] - D / 2)).toBeLessThan(1e-6);
      expect(mesh.normals[i * 3 + 2]).toBeCloseTo(1, 6);
    }
  });

  it("inflation lifts the centre: a unit disc rises by inflate x its radius", () => {
    const mesh = buildMesh(FIXTURES.disc);
    let maxZ = -Infinity;
    for (let i = 0; i < mesh.faceKind.length; i++)
      if (mesh.faceKind[i] === FaceKind.Front) maxZ = Math.max(maxZ, mesh.positions[i * 3 + 2]);
    const D = DEFAULT_PROFILE.extrude;
    expect(maxZ).toBeGreaterThan(D / 2 + DEFAULT_PROFILE.bevelHeight + DEFAULT_PROFILE.inflate * 0.95);
  });

  it("inflation is flat-topped: no crease down the middle of a stroke", () => {
    // On the slab's centre line d = R exactly, where the arc's slope is zero, so
    // the normal is straight up. The old u^k dome had slope k*H/dMax there: a
    // crease, rendered as a staircase wherever triangle edges crossed it.
    const mesh = buildMesh(FIXTURES.slab);
    let checked = 0;
    for (let i = 0; i < mesh.faceKind.length; i++) {
      if (mesh.faceKind[i] !== FaceKind.Front) continue;
      if (Math.abs(mesh.positions[i * 3 + 1]) > 1e-9 || Math.abs(mesh.positions[i * 3]) > 0.5) continue;
      checked++;
      expect(mesh.normals[i * 3 + 2]).toBeGreaterThan(0.9999);
    }
    expect(checked).toBeGreaterThan(5);
  });

  it("inflation scales with stroke width: a tapering stroke rises in proportion", () => {
    // wedge: half-width 0.1875 at model x=-0.8, 0.0875 at x=+0.8 (ratio 0.467)
    const mesh = buildMesh(FIXTURES.wedge);
    const base = DEFAULT_PROFILE.extrude / 2 + DEFAULT_PROFILE.bevelHeight;
    const rise = (x0: number, x1: number) => {
      let z = -Infinity;
      for (let i = 0; i < mesh.faceKind.length; i++) {
        const x = mesh.positions[i * 3];
        if (mesh.faceKind[i] === FaceKind.Front && x >= x0 && x <= x1) z = Math.max(z, mesh.positions[i * 3 + 2]);
      }
      return z - base;
    };
    const ratio = rise(0.75, 0.85) / rise(-0.85, -0.75);
    console.log(`wedge: thin/thick rise ratio = ${ratio.toFixed(3)} (half-width ratio 0.467)`);
    expect(ratio).toBeGreaterThan(0.38);
    expect(ratio).toBeLessThan(0.56);
  });

  it("a thin stroke rises by its OWN half-width, never more", () => {
    // thinO: half-width 6/180*2/2 = 0.0333. The width search used to bisect from
    // half the logo's size: its first probe overshot the stroke into empty space,
    // saw a "local" outline there and kept the huge radius, so one stroke of a
    // real wordmark stood ~2.5x proud of the rest.
    const mesh = buildMesh(FIXTURES.thinO);
    let maxZ = -Infinity;
    for (let i = 0; i < mesh.faceKind.length; i++)
      if (mesh.faceKind[i] === FaceKind.Front) maxZ = Math.max(maxZ, mesh.positions[i * 3 + 2]);
    const p = DEFAULT_PROFILE;
    expect(maxZ).toBeLessThan(p.extrude / 2 + p.bevelHeight + p.inflate * 0.0333 * 1.1);
  });

  it("a fat blob rises by its own half-width too, not the search ceiling", () => {
    // 200x130: half-height 0.65 sits in (rCap/2, rCap] with rCap = 1. A search
    // that returned its ceiling unprobed gave R = 1 here and z 0.528, not 0.385.
    const mesh = buildMesh([{ hex: "#FF2E9A", outer: rect(0, 0, 200, 130), holes: [] }]);
    let maxZ = -Infinity;
    for (let i = 0; i < mesh.faceKind.length; i++)
      if (mesh.faceKind[i] === FaceKind.Front) maxZ = Math.max(maxZ, mesh.positions[i * 3 + 2]);
    const p = DEFAULT_PROFILE;
    expect(maxZ).toBeLessThan(p.extrude / 2 + p.bevelHeight + p.inflate * 0.65 * 1.1);
    expect(maxZ).toBeGreaterThan(p.extrude / 2 + p.bevelHeight + p.inflate * 0.65 * 0.9);
  });

  it("a thin ring gets a narrower bevel instead of a broken one", () => {
    const mesh = buildMesh(FIXTURES.thinO);
    let bevelVerts = 0;
    for (let i = 0; i < mesh.faceKind.length; i++) if (mesh.faceKind[i] === FaceKind.Bevel) bevelVerts++;
    expect(bevelVerts).toBeGreaterThan(0);
    expect(topology(mesh).badEdges).toBe(0);
  });

  it("a 1px ring falls back to a hard edge, still watertight", () => {
    const mesh = buildMesh(FIXTURES.hairline);
    let bevelVerts = 0;
    for (let i = 0; i < mesh.faceKind.length; i++) if (mesh.faceKind[i] === FaceKind.Bevel) bevelVerts++;
    expect(bevelVerts).toBe(0);
    const t = topology(mesh);
    expect(t.badEdges).toBe(0);
    expect(t.slivers).toBe(0);
  });

  it("dome shading is smooth: no per-segment facets on a curved outline", () => {
    // A streak is a JUMP in shading between neighbours. On a disc, take each
    // tilted vertex's signed deviation of its normal from radial; a per-segment
    // facet (the raw gradient of distance-to-a-polyline is constant per
    // segment) makes neighbours across a segment boundary differ by the
    // 64-gon's whole 5.6deg turn. What the eye sees is the swing of the actual
    // normal, which is that direction change scaled by the tilt: near the flat
    // apex a direction change is invisible, at the steep bevel it is a streak.
    const mesh = buildMesh(FIXTURES.disc);
    const P = mesh.positions, N = mesh.normals;
    const dev = (v: number) => {
      const h = Math.hypot(N[v * 3], N[v * 3 + 1]), r = Math.hypot(P[v * 3], P[v * 3 + 1]);
      if (h < 0.02 || r < 0.2) return NaN; // flat apex: direction is meaningless there
      const cross = P[v * 3] * N[v * 3 + 1] - P[v * 3 + 1] * N[v * 3];
      const dot = P[v * 3] * N[v * 3] + P[v * 3 + 1] * N[v * 3 + 1];
      return (Math.atan2(cross, dot) * 180) / Math.PI;
    };
    const top = (v: number) => mesh.faceKind[v] === FaceKind.Front || mesh.faceKind[v] === FaceKind.Bevel;
    let worst = 0;
    for (let t = 0; t < mesh.indices.length; t += 3)
      for (let e = 0; e < 3; e++) {
        const a = mesh.indices[t + e], b = mesh.indices[t + ((e + 1) % 3)];
        if (!top(a) || !top(b)) continue;
        const tilt = Math.min(Math.hypot(N[a * 3], N[a * 3 + 1]), Math.hypot(N[b * 3], N[b * 3 + 1]));
        const d = tilt * Math.abs(dev(a) - dev(b));
        if (d === d) worst = Math.max(worst, d); // skips NaN
      }
    console.log(`disc: worst shading swing between neighbours = ${worst.toFixed(3)} deg`);
    expect(worst).toBeLessThan(1);
  });

  it("tessellation cap is respected", () => {
    const mesh = buildMesh(FIXTURES.disc, { tessellation: { ...DEFAULT_TESSELLATION, maxEdge: 0.001, triangleCap: 8000 } });
    // interior alone must stay under the cap; band/walls/back add a bounded amount
    expect(mesh.indices.length / 3).toBeLessThan(8000 * 2);
  });
});

describe("depth raises only the front (P4)", () => {
  const D = DEFAULT_PROFILE.extrude;
  const depth = 0.05;
  for (const name of ["disc", "thickO", "bee"] as const) {
    const flat = buildMesh(FIXTURES[name]);
    const raised = buildMesh(FIXTURES[name].map((r) => ({ ...r, depth })));
    const maxFront = (m: typeof flat) => {
      let z = -Infinity;
      for (let i = 0; i < m.faceKind.length; i++) if (m.faceKind[i] <= FaceKind.Bevel) z = Math.max(z, m.positions[i * 3 + 2]);
      return z;
    };

    it(`${name}: a region with depth > 0 is watertight, sliver-free and survives Merge by Distance`, () => {
      for (const q of [1e5, 1e4]) {
        const t = topology(raised, q);
        expect(t.badEdges).toBe(0);
        expect(t.slivers).toBe(0);
        expect(t.consistentEdges).toBe(t.manifoldEdges * 2);
        expect(t.volume).toBeGreaterThan(0);
      }
    });

    it(`${name}: the back, back rim and wall bottoms stay at exactly -extrude/2`, () => {
      const back = Math.fround(-D / 2);
      let minZ = Infinity, backs = 0;
      for (let i = 0; i < raised.faceKind.length; i++) {
        const z = raised.positions[i * 3 + 2];
        minZ = Math.min(minZ, z);
        if (raised.faceKind[i] === FaceKind.Back) { backs++; expect(z).toBe(back); }
      }
      expect(backs).toBeGreaterThan(0);
      expect(minZ).toBe(back);
    });

    it(`${name}: the front is raised by exactly the depth, so the solid is taller`, () => {
      expect(maxFront(raised) - maxFront(flat)).toBeCloseTo(depth, 6);
    });
  }
});
