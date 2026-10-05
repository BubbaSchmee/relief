
/** Alpha-silhouette tracing: a raster logo's alpha channel → clean vector
 *  polygons (outer contours + their holes), ready for earcut triangulation and
 *  3D extrusion (logo3d.ts).
 *
 *  PURE + DETERMINISTIC: same pixels in → same polygons out (no DOM, no state),
 *  so the extruded mesh — and therefore every rendered frame — stays a pure
 *  function of the uploaded image. Pipeline:
 *    1. binarize alpha at `threshold`
 *    2. collect the directed boundary edges between solid and empty pixels
 *    3. chain edges into closed loops (deterministic tie-break at pinch points)
 *    4. merge collinear runs, drop noise loops
 *    5. Douglas-Peucker simplify (smooths staircase diagonals)
 *    6. assign holes to their smallest containing outer
 *
 *  Coordinates are in trace-pixel space, y-down. With this edge construction the
 *  shoelace signed area (y-down) is POSITIVE for outer loops and NEGATIVE for
 *  holes — callers re-orient for their own space. */

export interface AlphaGrid {
  width: number;
  height: number;
  data: Uint8ClampedArray; // RGBA, only [i*4+3] is read
}

export interface TracedShape {
  outer: number[]; // flat [x0,y0,x1,y1,…], closed implicitly
  holes: number[][];
}

/** y-down shoelace signed area of a flat closed polygon. */
export function signedArea(pts: number[]): number {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i += 2) {
    const j = (i + 2) % n;
    a += pts[i] * pts[j + 1] - pts[j] * pts[i + 1];
  }
  return a / 2;
}

/** Ray-cast point-in-polygon (flat coords). On-edge results are indeterminate —
 *  fine for hole assignment (hole vertices are never on the outer). */
function pointIn(pts: number[], x: number, y: number): boolean {
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

/** Douglas-Peucker over an OPEN run of points (indices [a,b] kept). */
function dpSimplify(pts: { x: number; y: number }[], a: number, b: number, eps: number, keep: boolean[]): void {
  if (b - a < 2) return;
  const ax = pts[a].x;
  const ay = pts[a].y;
  const dx = pts[b].x - ax;
  const dy = pts[b].y - ay;
  const len = Math.hypot(dx, dy) || 1e-9;
  let worst = -1;
  let worstD = eps;
  for (let i = a + 1; i < b; i++) {
    const d = Math.abs((pts[i].x - ax) * dy - (pts[i].y - ay) * dx) / len;
    if (d > worstD) {
      worstD = d;
      worst = i;
    }
  }
  if (worst >= 0) {
    keep[worst] = true;
    dpSimplify(pts, a, worst, eps, keep);
    dpSimplify(pts, worst, b, eps, keep);
  }
}

/** Simplify a CLOSED loop: anchor at index 0 and the farthest point from it,
 *  then DP each half. Deterministic. */
function simplifyLoop(loop: { x: number; y: number }[], eps: number): number[] {
  const n = loop.length;
  if (n <= 4) return loop.flatMap((p) => [p.x, p.y]);
  let far = 1;
  let farD = -1;
  for (let i = 1; i < n; i++) {
    const d = (loop[i].x - loop[0].x) ** 2 + (loop[i].y - loop[0].y) ** 2;
    if (d > farD) {
      farD = d;
      far = i;
    }
  }
  const keep = new Array<boolean>(n).fill(false);
  keep[0] = true;
  keep[far] = true;
  dpSimplify(loop, 0, far, eps, keep);
  // second half wraps: simplify [far..n] with the wrap point appended
  const tail = loop.slice(far).concat([loop[0]]);
  const keepT = new Array<boolean>(tail.length).fill(false);
  keepT[0] = true;
  keepT[tail.length - 1] = true;
  dpSimplify(tail, 0, tail.length - 1, eps, keepT);
  for (let i = 1; i < tail.length - 1; i++) if (keepT[i]) keep[far + i] = true;
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(loop[i].x, loop[i].y);
  return out;
}

/** Trace the alpha channel into outer+hole polygons. `threshold` binarizes
 *  (alpha ≥ threshold = solid); `eps` is the simplify tolerance in trace px;
 *  loops under `minArea` px² are dropped as noise. */
export function traceAlpha(img: AlphaGrid, threshold = 128, eps = 1.2, minArea = 6): TracedShape[] {
  const W = img.width;
  const H = img.height;
  const solid = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < W && y < H && img.data[(y * W + x) * 4 + 3] >= threshold;

  // 1-2 · directed boundary edges on the (W+1)×(H+1) lattice, keyed by start point.
  // Directions: 0=+x, 1=+y, 2=-x, 3=-y. Solid region kept on the same side by
  // construction, so loops close and outers/holes wind oppositely.
  const PW = W + 1;
  const key = (x: number, y: number) => y * PW + x;
  const DX = [1, 0, -1, 0];
  const DY = [0, 1, 0, -1];
  const out = new Map<number, number[]>(); // startKey -> dirs (deterministic insert order)
  const addEdge = (x: number, y: number, dir: number) => {
    const k = key(x, y);
    const l = out.get(k);
    if (l) l.push(dir);
    else out.set(k, [dir]);
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!solid(x, y)) continue;
      if (!solid(x, y - 1)) addEdge(x, y, 0); // top edge, travels +x
      if (!solid(x + 1, y)) addEdge(x + 1, y, 1); // right edge, travels +y
      if (!solid(x, y + 1)) addEdge(x + 1, y + 1, 2); // bottom edge, travels -x
      if (!solid(x - 1, y)) addEdge(x, y + 1, 3); // left edge, travels -y
    }
  }

  // 3 · chain into loops. At pinch points (2 outgoing dirs) prefer the sharpest
  // RIGHT turn relative to the incoming direction — keeps each loop hugging its
  // own region instead of jumping across the pinch. Deterministic.
  const loops: { x: number; y: number }[][] = [];
  for (const [startKey, dirs0] of out) {
    while (dirs0.length) {
      const startDir = dirs0.shift()!;
      let x = startKey % PW;
      let y = (startKey - x) / PW;
      let dir = startDir;
      const loop: { x: number; y: number }[] = [];
      const sx = x;
      const sy = y;
      for (;;) {
        loop.push({ x, y });
        x += DX[dir];
        y += DY[dir];
        if (x === sx && y === sy) break; // closed
        const cand = out.get(key(x, y));
        if (!cand || !cand.length) {
          loop.length = 0; // broken chain (shouldn't happen) — discard
          break;
        }
        // right turn first: (dir+1)%4, then straight, then left
        let pick = -1;
        for (const want of [(dir + 1) % 4, dir, (dir + 3) % 4]) {
          const at = cand.indexOf(want);
          if (at >= 0) {
            pick = at;
            break;
          }
        }
        if (pick < 0) pick = 0;
        dir = cand.splice(pick, 1)[0];
        if (loop.length > W * H * 4) {
          loop.length = 0; // safety net against a pathological chain
          break;
        }
      }
      if (loop.length >= 4) loops.push(loop);
    }
  }

  // 4-5 · collinear merge + simplify + area filter
  const polys: { pts: number[]; area: number }[] = [];
  for (const loop of loops) {
    const merged: { x: number; y: number }[] = [];
    for (let i = 0; i < loop.length; i++) {
      const prev = loop[(i - 1 + loop.length) % loop.length];
      const cur = loop[i];
      const next = loop[(i + 1) % loop.length];
      const collinear = (cur.x - prev.x) * (next.y - cur.y) === (cur.y - prev.y) * (next.x - cur.x);
      if (!collinear) merged.push(cur);
    }
    if (merged.length < 3) continue;
    const flat = simplifyLoop(merged, eps);
    if (flat.length < 6) continue;
    const area = signedArea(flat);
    if (Math.abs(area) < minArea) continue;
    polys.push({ pts: flat, area });
  }

  // 6 · outers (area > 0 in this construction) get their holes (area < 0)
  const outers = polys.filter((p) => p.area > 0).sort((a, b) => a.area - b.area); // smallest first
  const holes = polys.filter((p) => p.area < 0);
  const shapes: TracedShape[] = outers.map((o) => ({ outer: o.pts, holes: [] as number[][] }));
  for (const h of holes) {
    const hx = h.pts[0];
    const hy = h.pts[1];
    for (let i = 0; i < outers.length; i++) {
      // smallest containing outer wins (outers are sorted by area)
      if (pointIn(outers[i].pts, hx, hy)) {
        shapes[i].holes.push(h.pts);
        break;
      }
    }
  }
  return shapes;
}
