/** Regressions for two P1 seam bugs found during P3.
 *
 *  1. earcut silently drops near-collinear boundary points (its own rounding,
 *     not ours). The band/walls used to walk the RING's vertex list, so a point
 *     earcut dropped left a gap. Here earcut is wrapped to drop one known
 *     boundary point on purpose — the property under test is "whatever earcut
 *     keeps, the mesh closes".
 *  2. A zero bevel width lifted the front by bevelHeight even at the edge,
 *     floating the rim above the walls. */
import { describe, expect, it, vi } from "vitest";
import { buildMesh } from "../src/mesh.js";
import { DEFAULT_PROFILE, type Region } from "../src/types.js";
import { FIXTURES } from "./fixtures.js";
import { topology } from "./validate.js";

// model-space x of the injected point (slab below: source x=60 in a 0..200 box -> (60-100)*0.01)
const { DROP_X } = vi.hoisted(() => ({ DROP_X: -0.4 }));

vi.mock("earcut", async (importOriginal) => {
  const real = ((await importOriginal()) as { default: (d: number[], h?: number[] | null, dim?: number) => number[] }).default;
  return {
    default: (data: number[], holes?: number[] | null, dim = 2) => {
      // drop the first vertex at DROP_X (if any), triangulate without it, map indices back
      const n = data.length / dim;
      let k = -1;
      for (let i = 0; i < n; i++) if (Math.abs(data[i * dim] - DROP_X) < 1e-6) { k = i; break; }
      if (k < 0) return real(data, holes ?? undefined, dim);
      const kept = data.slice(0, k * dim).concat(data.slice((k + 1) * dim));
      const h = holes?.map((s) => (s > k ? s - 1 : s));
      return real(kept, h?.length ? h : undefined, dim).map((i) => (i >= k ? i + 1 : i));
    },
  };
});

/** A slab whose bottom edge carries an extra point a hair off the line: our
 *  exact dedupe keeps it, and the wrapped earcut drops it — as real earcut does
 *  to near-collinear points under its own rounding. */
const slabWithHair: Region[] = [{
  hex: "#FF2E9A",
  outer: [0, 0, 200, 0, 200, 80, 60, 80 + 1e-12, 0, 80],
  holes: [],
}];

describe("seam robustness", () => {
  it("a boundary point earcut drops does not open the mesh (bevelled)", () => {
    const t = topology(buildMesh(slabWithHair));
    expect(t.badEdges).toBe(0);
    expect(t.slivers).toBe(0);
    expect(t.consistentEdges).toBe(t.manifoldEdges * 2);
  });

  it("…nor with a hard edge (no band)", () => {
    const t = topology(buildMesh(slabWithHair, { profile: { ...DEFAULT_PROFILE, bevelWidth: 0 } }));
    expect(t.badEdges).toBe(0);
    expect(t.slivers).toBe(0);
  });

  for (const [name, regions] of Object.entries(FIXTURES))
    it(`zero bevel width stays watertight: ${name}`, () => {
      const t = topology(buildMesh(regions, { profile: { ...DEFAULT_PROFILE, bevelWidth: 0 } }));
      expect(t.badEdges).toBe(0);
      expect(t.slivers).toBe(0);
      expect(t.volume).toBeGreaterThan(0);
    });
});
