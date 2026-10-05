/** The §8 gates, as functions that return numbers. No vibes. */
import type { Mesh } from "../src/types.js";

/** Weld vertices by position so seams built from duplicated vertices can be
 *  checked topologically. Positions at a seam are computed identically on both
 *  sides, so a quantised key is exact in practice; the quantum only guards
 *  against last-ulp float32 rounding. */
export function weld(m: Mesh, quantum = 1e5): { map: Int32Array; count: number } {
  const n = m.positions.length / 3;
  const map = new Int32Array(n);
  const ids = new Map<string, number>();
  let count = 0;
  for (let i = 0; i < n; i++) {
    const key =
      Math.round(m.positions[i * 3] * quantum) + "," +
      Math.round(m.positions[i * 3 + 1] * quantum) + "," +
      Math.round(m.positions[i * 3 + 2] * quantum);
    let id = ids.get(key);
    if (id === undefined) {
      id = count++;
      ids.set(key, id);
    }
    map[i] = id;
  }
  return { map, count };
}

export interface Topology {
  triangles: number;
  /** Undirected edges on exactly two faces. */
  manifoldEdges: number;
  /** Undirected edges on one face (a hole in the surface) or three+ (a fin). */
  badEdges: number;
  /** Directed edges whose twin runs the other way — consistent winding. */
  consistentEdges: number;
  /** Signed volume via the divergence theorem. Positive = outward-facing. */
  volume: number;
  /** Triangles with two or more vertices at the same welded position: slivers
   *  a GLB validator flags and a renderer z-fights on. Must be zero. */
  slivers: number;
}

/** `quantum` 1e4 mimics the usual weld-by-distance default (0.0001). */
export function topology(m: Mesh, quantum = 1e5): Topology {
  const { map } = weld(m, quantum);
  const dir = new Map<string, number>();
  const und = new Map<string, number>();
  let volume = 0;
  let slivers = 0;
  const p = m.positions;
  const ix = m.indices;
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t], b = ix[t + 1], c = ix[t + 2];
    const wa = map[a], wb = map[b], wc = map[c];
    if (wa === wb || wb === wc || wc === wa) {
      slivers++;
      continue;
    }
    for (const [u, v] of [[wa, wb], [wb, wc], [wc, wa]] as const) {
      dir.set(u + ">" + v, (dir.get(u + ">" + v) ?? 0) + 1);
      const k = u < v ? u + "-" + v : v + "-" + u;
      und.set(k, (und.get(k) ?? 0) + 1);
    }
    const ax = p[a * 3], ay = p[a * 3 + 1], az = p[a * 3 + 2];
    const bx = p[b * 3], by = p[b * 3 + 1], bz = p[b * 3 + 2];
    const cx = p[c * 3], cy = p[c * 3 + 1], cz = p[c * 3 + 2];
    volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  let manifoldEdges = 0;
  let badEdges = 0;
  for (const n of und.values()) n === 2 ? manifoldEdges++ : badEdges++;
  let consistentEdges = 0;
  for (const [k, n] of dir) {
    const [u, v] = k.split(">");
    if (n === 1 && dir.get(v + ">" + u) === 1) consistentEdges++;
  }
  return { triangles: ix.length / 3, manifoldEdges, badEdges, consistentEdges, volume, slivers };
}

/** Rasterise a polygon-with-holes (even-odd) into a grid over [x0,x1]x[y0,y1]. */
export function rasterRings(rings: number[][], x0: number, y0: number, x1: number, y1: number, n: number): Uint8Array {
  const out = new Uint8Array(n * n);
  for (let j = 0; j < n; j++) {
    const y = y0 + ((j + 0.5) / n) * (y1 - y0);
    for (let i = 0; i < n; i++) {
      const x = x0 + ((i + 0.5) / n) * (x1 - x0);
      let inside = false;
      for (const r of rings) {
        const m = r.length / 2;
        for (let a = 0, b = m - 1; a < m; b = a++) {
          const xa = r[a * 2], ya = r[a * 2 + 1], xb = r[b * 2], yb = r[b * 2 + 1];
          if (ya > y !== yb > y && x < ((xb - xa) * (y - ya)) / (yb - ya) + xa) inside = !inside;
        }
      }
      if (inside) out[j * n + i] = 1;
    }
  }
  return out;
}

/** Rasterise the xy projection of every front-facing triangle (geometric
 *  normal z > 0): that is the silhouette a viewer sees head-on. */
export function rasterFront(m: Mesh, x0: number, y0: number, x1: number, y1: number, n: number): Uint8Array {
  const out = new Uint8Array(n * n);
  const p = m.positions;
  const ix = m.indices;
  const sx = n / (x1 - x0);
  const sy = n / (y1 - y0);
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t], b = ix[t + 1], c = ix[t + 2];
    const ax = p[a * 3], ay = p[a * 3 + 1];
    const bx = p[b * 3], by = p[b * 3 + 1];
    const cx = p[c * 3], cy = p[c * 3 + 1];
    const area2 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    // sign of the xy winding IS the sign of the geometric normal's z
    if (area2 <= 0) continue;
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - x0) * sx));
    const i1 = Math.min(n - 1, Math.ceil((Math.max(ax, bx, cx) - x0) * sx));
    const j0 = Math.max(0, Math.floor((Math.min(ay, by, cy) - y0) * sy));
    const j1 = Math.min(n - 1, Math.ceil((Math.max(ay, by, cy) - y0) * sy));
    for (let j = j0; j <= j1; j++) {
      const y = y0 + (j + 0.5) / sy;
      for (let i = i0; i <= i1; i++) {
        const x = x0 + (i + 0.5) / sx;
        const w0 = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
        const w1 = (cx - bx) * (y - by) - (cy - by) * (x - bx);
        const w2 = (ax - cx) * (y - cy) - (ay - cy) * (x - cx);
        if (w0 >= 0 && w1 >= 0 && w2 >= 0) out[j * n + i] = 1;
      }
    }
  }
  return out;
}

export function iou(a: Uint8Array, b: Uint8Array): number {
  let inter = 0;
  let union = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] && b[i]) inter++;
    if (a[i] || b[i]) union++;
  }
  return union ? inter / union : 1;
}
