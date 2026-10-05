/** Turning a flat polygon into a surface that can actually be displaced.
 *
 *  earcut alone is not enough: it triangulates using only the contour points, so
 *  EVERY vertex sits on the boundary at distance zero and a height field has
 *  nothing to lift. That is the single finding that made the spike's change
 *  ~150 lines instead of 60. Subdivision supplies the interior vertices.
 *
 *  4-way midpoint splitting preserves the silhouette bit-for-bit, because the
 *  midpoint of a straight boundary edge lies on that edge. */
import earcut from "earcut";

export interface Tessellated {
  /** Flat [x0,y0,...] — the original contour points first, then the midpoints. */
  pts: number[];
  /** Triangle indices into pts. */
  tris: number[];
}

/** Triangulate rings (first = outer, rest = holes) into a flat polygon soup. */
export function triangulateRings(rings: number[][]): Tessellated {
  const coords: number[] = [];
  const holeIdx: number[] = [];
  for (let r = 0; r < rings.length; r++) {
    if (r > 0) holeIdx.push(coords.length / 2);
    for (const c of rings[r]) coords.push(c);
  }
  const tris = earcut(coords, holeIdx.length ? holeIdx : undefined, 2);
  return { pts: coords, tris };
}

/** Split every triangle 4 ways until no edge exceeds maxEdge.
 *
 *  ponytail: UNIFORM density, so the flat interior carries more triangles than
 *  it needs. Uniform splitting has no T-junctions, which adaptive splitting
 *  would introduce as visible cracks without red-green refinement. If the 50k
 *  triangle budget starts binding, that refinement is the upgrade path. */
export function subdivide(t: Tessellated, maxEdge: number, triCap: number): Tessellated {
  let pts = t.pts.slice();
  let tris = t.tris.slice();
  if (!tris.length) return { pts, tris };

  for (let pass = 0; pass < 8; pass++) {
    let longest = 0;
    for (let i = 0; i < tris.length; i += 3)
      for (let e = 0; e < 3; e++) {
        const a = tris[i + e];
        const b = tris[i + ((e + 1) % 3)];
        const d = Math.hypot(pts[a * 2] - pts[b * 2], pts[a * 2 + 1] - pts[b * 2 + 1]);
        if (d > longest) longest = d;
      }
    if (longest <= maxEdge) break;
    if (tris.length / 3 > triCap / 4) break; // the next pass would blow the cap

    const mid = new Map<number, number>();
    const getMid = (a: number, b: number): number => {
      // a symmetric integer key; pts never exceeds 2^26 vertices in practice
      const key = a < b ? a * 67108864 + b : b * 67108864 + a;
      let m = mid.get(key);
      if (m === undefined) {
        m = pts.length / 2;
        pts.push((pts[a * 2] + pts[b * 2]) / 2, (pts[a * 2 + 1] + pts[b * 2 + 1]) / 2);
        mid.set(key, m);
      }
      return m;
    };
    const next: number[] = [];
    for (let i = 0; i < tris.length; i += 3) {
      const a = tris[i];
      const b = tris[i + 1];
      const c = tris[i + 2];
      const ab = getMid(a, b);
      const bc = getMid(b, c);
      const ca = getMid(c, a);
      next.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
    }
    tris = next;
  }
  return { pts, tris };
}

/** Lawson edge flips toward the constrained Delaunay triangulation.
 *
 *  earcut is plain ear clipping: on a ring with a hole it happily emits needle
 *  triangles whose long diagonal grazes another vertex. Subdivision preserves
 *  needles, leaving distinct vertices micrometres apart — and anything that
 *  welds by distance (common 3D tools default to 1e-4) then tears
 *  the surface. Needles also stretch normal interpolation across the dome.
 *
 *  Flipping every interior edge whose opposite vertex lies inside the circumcircle
 *  maximises the minimum angle. Boundary edges (one adjacent triangle) are the
 *  constraints and never flip, so the silhouette is untouched. Deterministic:
 *  a fixed-order stack, a fixed threshold, an iteration cap. */
export function delaunayFlip(t: Tessellated): Tessellated {
  const P = t.pts;
  const T = t.tris.slice();
  const nT = T.length / 3;
  if (nT < 2) return { pts: P, tris: T };
  const ox = (a: number, b: number, c: number) =>
    (P[b * 2] - P[a * 2]) * (P[c * 2 + 1] - P[a * 2 + 1]) - (P[b * 2 + 1] - P[a * 2 + 1]) * (P[c * 2] - P[a * 2]);
  // all triangles counter-clockwise, so incircle has one sign convention
  for (let i = 0; i < nT; i++) if (ox(T[i * 3], T[i * 3 + 1], T[i * 3 + 2]) < 0) { const s = T[i * 3 + 1]; T[i * 3 + 1] = T[i * 3 + 2]; T[i * 3 + 2] = s; }

  const K = 67108864;
  const owner = new Map<number, number>(); // directed edge a->b  ->  triangle
  const setTri = (i: number) => { for (let e = 0; e < 3; e++) owner.set(T[i * 3 + e] * K + T[i * 3 + ((e + 1) % 3)], i); };
  const clearTri = (i: number) => { for (let e = 0; e < 3; e++) owner.delete(T[i * 3 + e] * K + T[i * 3 + ((e + 1) % 3)]); };
  for (let i = 0; i < nT; i++) setTri(i);

  /** d strictly inside the circumcircle of CCW (a,b,c)? */
  const inCircle = (a: number, b: number, c: number, d: number) => {
    const dx = P[d * 2], dy = P[d * 2 + 1];
    const adx = P[a * 2] - dx, ady = P[a * 2 + 1] - dy;
    const bdx = P[b * 2] - dx, bdy = P[b * 2 + 1] - dy;
    const cdx = P[c * 2] - dx, cdy = P[c * 2 + 1] - dy;
    const det =
      (adx * adx + ady * ady) * (bdx * cdy - cdx * bdy) -
      (bdx * bdx + bdy * bdy) * (adx * cdy - cdx * ady) +
      (cdx * cdx + cdy * cdy) * (adx * bdy - bdx * ady);
    // cocircular rings (every vertex of a traced circle) sit at det ~ 0; the
    // threshold stops float noise flipping them back and forth forever
    return det > 1e-13;
  };
  const third = (i: number, a: number, b: number) => {
    for (let e = 0; e < 3; e++) { const v = T[i * 3 + e]; if (v !== a && v !== b) return v; }
    return -1;
  };

  const stack: number[] = [];
  for (let i = 0; i < nT; i++) for (let e = 0; e < 3; e++) stack.push(T[i * 3 + e], T[i * 3 + ((e + 1) % 3)]);
  let budget = 50 * T.length;
  while (stack.length && budget-- > 0) {
    const b = stack.pop()!;
    const a = stack.pop()!;
    const t1 = owner.get(a * K + b);
    const t2 = owner.get(b * K + a);
    if (t1 === undefined || t2 === undefined) continue; // boundary: a constraint
    const c = third(t1, a, b);
    const d = third(t2, a, b);
    if (c < 0 || d < 0 || !inCircle(a, b, c, d)) continue;
    // only a strictly convex quad can flip: the new diagonal c-d must cross a-b
    if (!(ox(c, d, a) * ox(c, d, b) < 0)) continue;
    clearTri(t1);
    clearTri(t2);
    T[t1 * 3] = a; T[t1 * 3 + 1] = d; T[t1 * 3 + 2] = c; // a,d,c is CCW given c left / d right of a->b
    T[t2 * 3] = b; T[t2 * 3 + 1] = c; T[t2 * 3 + 2] = d;
    setTri(t1);
    setTri(t2);
    stack.push(a, d, d, b, b, c, c, a);
  }
  return { pts: P, tris: T };
}
