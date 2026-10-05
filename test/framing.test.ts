import { describe, expect, it } from "vitest";
import { boundingSphere, frameFor, framingDistance, FRAME_MARGIN, poseMatrices, project } from "../src/framing.js";
import { buildMesh } from "../src/mesh.js";
import { DEFAULT_MOTION, frameTimes, poseAt, type Motion } from "../src/motion.js";
import { traceAlpha } from "../src/trace.js";
import type { Mesh, Region } from "../src/types.js";
import { FIXTURES, loadWordmark, WORDMARK_HEX } from "./fixtures.js";

const wordmark = loadWordmark();
const WORDMARK: Region[] = traceAlpha(wordmark).map((s) => ({ hex: WORDMARK_HEX, outer: s.outer, holes: s.holes }));

const meshes: [string, Mesh][] = [
  ["RELIEF wordmark (600x200 raster)", buildMesh(WORDMARK, { source: { width: wordmark.width, height: wordmark.height } })],
  ["slab", buildMesh(FIXTURES.slab)],
  ["star", buildMesh(FIXTURES.star)],
  // layered regions stack depth in front of the base: the sweep sphere must follow
  ["bee, front raised", buildMesh(FIXTURES.bee.map((r) => ({ ...r, depth: 0.2 })))],
];

const MOTIONS: Motion[] = [
  { ...DEFAULT_MOTION, kind: "spin" },
  { ...DEFAULT_MOTION, kind: "spin", direction: -1, tiltDeg: 25, hover: 0.08 },
  { ...DEFAULT_MOTION, kind: "rock" },
  { ...DEFAULT_MOTION, kind: "rock", rockDeg: 60, tiltDeg: -15, hover: 0.1 },
];

describe("boundingSphere", () => {
  it("contains every vertex and is centred on the box", () => {
    const pos = [0, 0, 0, 4, 0, 0, 0, 2, 0, 0, 0, 6];
    const s = boundingSphere(pos);
    expect(s.center).toEqual([2, 1, 3]);
    for (let i = 0; i < pos.length; i += 3)
      expect(Math.hypot(pos[i] - 2, pos[i + 1] - 1, pos[i + 2] - 3)).toBeLessThanOrEqual(s.radius + 1e-12);
  });
});

describe("framing: the logo never leaves the frame", () => {
  for (const [name, mesh] of meshes)
    for (const aspect of [1, 16 / 9, 9 / 16])
      for (const m of MOTIONS) {
        it(`${name}, ${m.kind} (hover ${m.hover}, tilt ${m.tiltDeg}), aspect ${aspect.toFixed(2)}: every vertex at every frame is inside, with the margin`, () => {
          const f = frameFor(mesh, m, aspect);
          const p = mesh.positions;
          let worst = 0, zLo = Infinity, zHi = -Infinity;
          for (const t of frameTimes(m, 30)) {
            const { mvp } = poseMatrices(f, poseAt(m, t));
            for (let i = 0; i < p.length; i += 3) {
              const [x, y, z] = project(mvp, p[i], p[i + 1], p[i + 2]);
              zLo = Math.min(zLo, z);
              zHi = Math.max(zHi, z);
              worst = Math.max(worst, Math.abs(x), Math.abs(y));
            }
          }
          // NDC half-extents are 1, so the margin leaves |ndc| <= 1 - margin
          expect(worst).toBeLessThanOrEqual(1 - FRAME_MARGIN + 1e-9);
          expect(zLo).toBeGreaterThan(-1); // and inside the near and far planes
          expect(zHi).toBeLessThan(1);
        });
      }

  it("is constant: one camera for the whole clip, whatever the motion", () => {
    const [, mesh] = meshes[0];
    const spin = frameFor(mesh, { hover: 0.03 }, 1);
    // the framing sees only the hover amplitude, never a pose or a time, so it cannot pump
    expect(frameFor(mesh, { hover: 0.03 }, 1)).toEqual(spin);
    // the camera is the same pure translation in every frame: rotation never moves the eye
    const eye = (t: number) => {
      const { modelView } = poseMatrices(spin, poseAt(DEFAULT_MOTION, t));
      return Math.hypot(modelView[12], modelView[13], modelView[14]);
    };
    // the logo's centre stays within hover of the camera axis, at the same depth
    for (const t of [0, 0.7, 1.9, 3.3]) expect(Math.abs(eye(t) - spin.distance)).toBeLessThanOrEqual(DEFAULT_MOTION.hover + 1e-9);
  });

  it("a bigger margin pushes the camera back; a wider frame does not move it for a square-limited fit", () => {
    expect(framingDistance(1, 0.5, 1, 0.2)).toBeGreaterThan(framingDistance(1, 0.5, 1, 0.08));
    expect(framingDistance(1, 0.5, 16 / 9)).toBeCloseTo(framingDistance(1, 0.5, 1), 12);
    expect(framingDistance(1, 0.5, 9 / 16)).toBeGreaterThan(framingDistance(1, 0.5, 1));
  });
});
