/** A wordmark as a raster: the word RELIEF, 600x200, every opaque pixel exactly
 *  #2E7BFF (test/fixtures/wordmark.png). Synthetic fixtures prove the algorithm;
 *  this proves it on a logo-shaped raster input, through the real raster path
 *  (traceAlpha), at production-ish settings. */
import { describe, expect, it } from "vitest";
import { buildMesh } from "../src/mesh.js";
import { traceAlpha } from "../src/trace.js";
import { FaceKind, type Region } from "../src/types.js";
import { loadWordmark, WORDMARK_HEX, WORDMARK_HOLES, WORDMARK_SHAPES } from "./fixtures.js";
import { iou, rasterFront, rasterRings, topology } from "./validate.js";

const png = loadWordmark();
const BRAND = WORDMARK_HEX;

describe("raster wordmark: RELIEF", () => {
  const shapes = traceAlpha(png);
  const regions: Region[] = shapes.map((s) => ({ hex: BRAND, outer: s.outer, holes: s.holes }));

  it("traces six letters, with the bowl of the R as the only hole", () => {
    expect(regions.length).toBe(WORDMARK_SHAPES);
    const holes = regions.map((r) => r.holes.length).reduce((a, b) => a + b, 0);
    expect(holes).toBe(WORDMARK_HOLES);
  });

  const t0 = performance.now();
  const mesh = buildMesh(regions, { source: { width: png.width, height: png.height } });
  const ms = performance.now() - t0;
  const topo = topology(mesh);

  it("is watertight, sliver-free, consistently wound, positive volume", () => {
    expect(topo.badEdges).toBe(0);
    expect(topo.slivers).toBe(0);
    expect(topo.consistentEdges).toBe(topo.manifoldEdges * 2);
    expect(topo.volume).toBeGreaterThan(0);
  });

  it("survives a weld by distance of 1e-4 (the default of common 3D tools)", () => {
    const t = topology(mesh, 1e4);
    expect(t.badEdges).toBe(0);
    expect(t.slivers).toBe(0);
  });

  it("keeps the silhouette: IoU >= 0.98 against the source alpha", () => {
    // source alpha mask, mapped into model space with buildMesh's normalisation
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const r of regions)
      for (let i = 0; i < r.outer.length; i += 2) {
        minX = Math.min(minX, r.outer[i]); maxX = Math.max(maxX, r.outer[i]);
        minY = Math.min(minY, r.outer[i + 1]); maxY = Math.max(maxY, r.outer[i + 1]);
      }
    const sc = Math.min(2 / (maxX - minX), 2.4 / (maxY - minY));
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const N = 480;
    const x0 = -1.02, x1 = 1.02;
    const y0 = -((maxY - minY) * sc) / 2 - 0.02, y1 = -y0;
    // the TRUE source: alpha pixels, not the traced polygon
    const src = new Uint8Array(N * N);
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++) {
        const mx = x0 + ((i + 0.5) / N) * (x1 - x0);
        const my = y0 + ((j + 0.5) / N) * (y1 - y0);
        const sx = Math.floor(mx / sc + cx);
        const sy = Math.floor(cy - my / sc);
        if (sx >= 0 && sy >= 0 && sx < png.width && sy < png.height && png.data[(sy * png.width + sx) * 4 + 3] >= 128) src[j * N + i] = 1;
      }
    const got = rasterFront(mesh, x0, y0, x1, y1, N);
    const traced = rasterRings(
      regions.flatMap((r) => [r.outer, ...r.holes]).map((ring) => {
        const o: number[] = [];
        for (let k = 0; k < ring.length; k += 2) o.push((ring[k] - cx) * sc, (cy - ring[k + 1]) * sc);
        return o;
      }),
      x0, y0, x1, y1, N,
    );
    const vsAlpha = iou(src, got);
    const vsTrace = iou(traced, got);
    console.log(`wordmark iou vs alpha=${vsAlpha.toFixed(4)} vs trace=${vsTrace.toFixed(4)} tris=${topo.triangles} ${ms.toFixed(0)}ms`);
    expect(vsTrace).toBeGreaterThanOrEqual(0.99); // the mesher loses nothing the trace kept
    expect(vsAlpha).toBeGreaterThanOrEqual(0.98); // the whole pipeline, vs the pixels
  });

  it("every vertex carries the exact brand hex", () => {
    for (let i = 0; i < mesh.regionIndex.length; i++) expect(mesh.regionHex[mesh.regionIndex[i]]).toBe(BRAND);
  });

  it("bevels the letters (thick strokes are not hairlines)", () => {
    let bevel = 0;
    for (let i = 0; i < mesh.faceKind.length; i++) if (mesh.faceKind[i] === FaceKind.Bevel) bevel++;
    expect(bevel).toBeGreaterThan(0);
  });

  it("under budget and fast", () => {
    expect(topo.triangles).toBeLessThanOrEqual(50_000);
    expect(ms).toBeLessThan(500);
  });
});
