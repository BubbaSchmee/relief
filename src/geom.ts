/** 2D ring geometry: area, containment, the mitred inset that carves the bevel
 *  band, and the exact distance field the dome is displaced by.
 *
 *  Everything here is PURE and allocation-light: same numbers in, same numbers
 *  out, no state, no clock. That is what makes the whole converter byte-stable. */

/** Shoelace signed area of a flat closed polygon. Sign encodes winding. */
export function signedArea(pts: number[]): number {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i += 2) {
    const j = (i + 2) % n;
    a += pts[i] * pts[j + 1] - pts[j] * pts[i + 1];
  }
  return a / 2;
}

/** Ray-cast point-in-polygon. On-edge results are indeterminate, which is fine
 *  for containment tests between distinct rings. */
export function pointInRing(pts: number[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, n = pts.length / 2, j = n - 1; i < n; j = i++) {
    const xi = pts[i * 2];
    const yi = pts[i * 2 + 1];
    const xj = pts[j * 2];
    const yj = pts[j * 2 + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Per-vertex outward unit normals and the edge normals they average.
 *  Outward = normalize(-dy, dx) for this winding — the convention
 *  trace.ts produces, verified in production for both outers and holes. */
export function ringNormals(pts: number[]): { edge: number[]; vertex: number[] } {
  const n = pts.length / 2;
  const edge: number[] = new Array(n * 2);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const dx = pts[j * 2] - pts[i * 2];
    const dy = pts[j * 2 + 1] - pts[i * 2 + 1];
    const len = Math.hypot(dx, dy) || 1e-9;
    edge[i * 2] = -dy / len;
    edge[i * 2 + 1] = dx / len;
  }
  const vertex: number[] = new Array(n * 2);
  for (let i = 0; i < n; i++) {
    const p = (i - 1 + n) % n; // the edge arriving at i
    let sx = edge[p * 2] + edge[i * 2];
    let sy = edge[p * 2 + 1] + edge[i * 2 + 1];
    const sl = Math.hypot(sx, sy) || 1e-9;
    sx /= sl;
    sy /= sl;
    vertex[i * 2] = sx;
    vertex[i * 2 + 1] = sy;
  }
  return { edge, vertex };
}

/** Inset a ring by `b`, mitred at the corners.
 *
 *  The point at distance b from BOTH adjoining edges is v - b*(na+nb)/(1+na·nb).
 *  The denominator is floored so a spike's mitre cannot fly off its own tip —
 *  the ceiling found when 4x was allowed and inset rings self-intersected at
 *  every spike.
 *
 *  Returns null when the ring is too thin to carry the band (the inset collapses
 *  or flips winding). Callers keep a hard edge there rather than a
 *  self-intersecting one. */
export function mitredInset(pts: number[], b: number): number[] | null {
  if (b <= 0) return null;
  const n = pts.length / 2;
  if (n < 3) return null;
  const { edge } = ringNormals(pts);
  const inset: number[] = new Array(n * 2);
  for (let i = 0; i < n; i++) {
    const p = (i - 1 + n) % n;
    const ax = edge[p * 2];
    const ay = edge[p * 2 + 1];
    const bx = edge[i * 2];
    const by = edge[i * 2 + 1];
    const dot = ax * bx + ay * by;
    const k = b / Math.max(0.7, 1 + dot);
    inset[i * 2] = pts[i * 2] - (ax + bx) * k;
    inset[i * 2 + 1] = pts[i * 2 + 1] - (ay + by) * k;
  }
  const a0 = signedArea(pts);
  const a1 = signedArea(inset);
  if (Math.sign(a1) !== Math.sign(a0)) return null;
  if (!(Math.abs(a1) > Math.abs(a0) * 0.35)) return null;
  return inset;
}

/** Drop consecutive duplicate and exactly-collinear points. trace.ts already
 *  guarantees this for traced input; synthetic and SVG rings need it too,
 *  because earcut silently removes such points during its own preprocessing
 *  and every seam that assumed they were still there then opens. */
export function dedupeCollinear(pts: number[]): number[] {
  const n = pts.length / 2;
  if (n < 3) return pts.slice();
  const keep: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = (i - 1 + n) % n;
    const q = (i + 1) % n;
    const ax = pts[p * 2], ay = pts[p * 2 + 1];
    const bx = pts[i * 2], by = pts[i * 2 + 1];
    const cx = pts[q * 2], cy = pts[q * 2 + 1];
    if (ax === bx && ay === by) continue; // duplicate of the previous point
    const cross = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (cross === 0) continue; // exactly collinear: contributes no corner
    keep.push(bx, by);
  }
  return keep.length >= 6 ? keep : pts.slice();
}

/** Proper crossing of two segments, ignoring shared endpoints. */
function segmentsCross(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): boolean {
  const o = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) =>
    Math.sign((qx - px) * (ry - py) - (qy - py) * (rx - px));
  const o1 = o(ax, ay, bx, by, cx, cy);
  const o2 = o(ax, ay, bx, by, dx, dy);
  const o3 = o(cx, cy, dx, dy, ax, ay);
  const o4 = o(cx, cy, dx, dy, bx, by);
  return o1 !== o2 && o3 !== o4 && o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0;
}

/** Does the ring intersect itself? Adjacent segments share a vertex and are
 *  skipped. O(n^2); a traced logo's rings are a few hundred points. */
export function isSimple(pts: number[]): boolean {
  const n = pts.length / 2;
  for (let i = 0; i < n; i++) {
    const i2 = (i + 1) % n;
    for (let j = i + 2; j < n; j++) {
      const j2 = (j + 1) % n;
      if (j2 === i) continue; // the last segment closes onto the first
      if (segmentsCross(pts[i * 2], pts[i * 2 + 1], pts[i2 * 2], pts[i2 * 2 + 1], pts[j * 2], pts[j * 2 + 1], pts[j2 * 2], pts[j2 * 2 + 1])) return false;
    }
  }
  return true;
}

/** Does any segment of ring a cross any segment of ring b? */
export function ringsCross(a: number[], b: number[]): boolean {
  const n = a.length / 2;
  const m = b.length / 2;
  for (let i = 0; i < n; i++) {
    const i2 = (i + 1) % n;
    for (let j = 0; j < m; j++) {
      const j2 = (j + 1) % m;
      if (segmentsCross(a[i * 2], a[i * 2 + 1], a[i2 * 2], a[i2 * 2 + 1], b[j * 2], b[j * 2 + 1], b[j2 * 2], b[j2 * 2 + 1])) return true;
    }
  }
  return false;
}

export interface Nearest {
  /** Distance to the closest point on any ring. */
  d: number;
  /** Unit gradient of that distance field: points away from the contour. */
  gx: number;
  gy: number;
  /** Which ring, which segment of it, and where along that segment (0..1,
   *  clamped) the nearest point lies — so callers can smooth normals. */
  ring: number;
  seg: number;
  t: number;
}

/** Exact distance from (x,y) to the nearest point on any of `rings`, with the
 *  gradient. Exact, not an approximation — the dome's normals are derived from
 *  this analytically, so error here shows up as shading artifacts.
 *
 *  ponytail: brute force over every segment, O(verts x segments). Measured at
 *  112 ms for 28k triangles against a real logo, so it is not worth optimising
 *  yet. If multi-region logos (P4) make it hot, swap in a two-pass separable
 *  exact Euclidean distance transform on a raster grid and sample bilinearly. */
export function nearestOnRings(rings: number[][], x: number, y: number): Nearest {
  let best = Infinity;
  let bx = 0;
  let by = 0;
  let bRing = 0;
  let bSeg = 0;
  let bT = 0;
  for (let ri = 0; ri < rings.length; ri++) {
    const r = rings[ri];
    const n = r.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = r[i * 2];
      const ay = r[i * 2 + 1];
      const dx = r[j * 2] - ax;
      const dy = r[j * 2 + 1] - ay;
      const L = dx * dx + dy * dy;
      let t = L > 1e-20 ? ((x - ax) * dx + (y - ay) * dy) / L : 0;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      const ex = x - (ax + t * dx);
      const ey = y - (ay + t * dy);
      const d2 = ex * ex + ey * ey;
      if (d2 < best) {
        best = d2;
        bx = ex;
        by = ey;
        bRing = ri;
        bSeg = i;
        bT = t;
      }
    }
  }
  const d = Math.sqrt(best);
  const inv = d > 1e-9 ? 1 / d : 0;
  return { d, gx: bx * inv, gy: by * inv, ring: bRing, seg: bSeg, t: bT };
}
