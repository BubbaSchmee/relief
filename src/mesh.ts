/** regions -> a closed, indexed, outward-facing mesh. The centre of RELIEF.
 *
 *  Per region:
 *    contour rings (model space)
 *      -> mitred inset rings, one bevel-width in           (hard edge where invalid)
 *      -> INTERIOR: triangulate the inset, subdivide, lift by the profile
 *      -> BAND:     loft from the inset out to the contour along the bevel curve
 *      -> WALLS:    contour, front to back
 *      -> BACK:     contour, flat
 *
 *  Watertightness is the constraint that shapes the code. Subdivision splits
 *  the interior's boundary edges, so anything built from the ORIGINAL edges
 *  would leave T-junctions along the seam. Instead: the band's inner rim reuses
 *  the interior's own boundary vertices; the band's outer rim, the walls, and
 *  the back are all densified to the same parameters along each contour edge.
 *
 *  The back is NOT earcut over the contour. earcut removes collinear points in
 *  preprocessing (so a densified contour comes back coarse) and emits slivers
 *  near hole bridges whose centroids coincide with their own vertices, so no
 *  Steiner-point fan is safe on fine polygons. Instead the back mirrors the
 *  front's subdivided interior, and one flat strip from the inset rim to the
 *  contour rim closes the bevel gap. Watertight by construction.
 *
 *  Both the interior and the band compute height through the same two
 *  functions — nearestOnRings then surfaceHeight — which is what makes the
 *  seam between them exact rather than approximately close. */
import { dedupeCollinear, isSimple, mitredInset, nearestOnRings, pointInRing, ringNormals, ringsCross, signedArea } from "./geom.js";
import { surfaceHeight } from "./profile.js";
import { delaunayFlip, subdivide, triangulateRings } from "./tessellate.js";
import { DEFAULT_PROFILE, DEFAULT_TESSELLATION, FaceKind, type BuildOptions, type Mesh, type Region } from "./types.js";

const DEFAULT_CREASE_DEG = 42;
/** Bevel-width multipliers tried in order until a region's inset is valid. */
const BEVEL_SHRINK = [1, 0.7, 0.5, 0.35];

/** Accumulates vertices and triangles; enforces that every triangle's winding
 *  agrees with the normal it was given, so the result is outward-facing
 *  everywhere without each emitter having to reason about orientation. */
class Sink {
  pos: number[] = [];
  nrm: number[] = [];
  uv: number[] = [];
  kind: number[] = [];
  region: number[] = [];
  idx: number[] = [];

  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number, kind: FaceKind, region: number): number {
    const len = Math.hypot(nx, ny, nz) || 1;
    this.pos.push(x, y, z);
    this.nrm.push(nx / len, ny / len, nz / len);
    this.uv.push(u, v);
    this.kind.push(kind);
    this.region.push(region);
    return this.pos.length / 3 - 1;
  }

  /** Emit a triangle wound so its geometric normal points along (nx,ny,nz). */
  tri(a: number, b: number, c: number, nx: number, ny: number, nz: number): void {
    const p = this.pos;
    const ax = p[a * 3], ay = p[a * 3 + 1], az = p[a * 3 + 2];
    const ux = p[b * 3] - ax, uy = p[b * 3 + 1] - ay, uz = p[b * 3 + 2] - az;
    const vx = p[c * 3] - ax, vy = p[c * 3 + 1] - ay, vz = p[c * 3 + 2] - az;
    const gx = uy * vz - uz * vy;
    const gy = uz * vx - ux * vz;
    const gz = ux * vy - uy * vx;
    if (gx * gx + gy * gy + gz * gz < 1e-24) return; // degenerate, drop
    if (gx * nx + gy * ny + gz * nz >= 0) this.idx.push(a, b, c);
    else this.idx.push(a, c, b);
  }

  quad(a: number, b: number, c: number, d: number, nx: number, ny: number, nz: number): void {
    this.tri(a, b, c, nx, ny, nz);
    this.tri(a, c, d, nx, ny, nz);
  }

  /** Emit quads [a,b,c,d,...] that form ONE continuous strip with ONE winding,
   *  chosen by an area-weighted vote of each quad's geometric normal against
   *  its hint [hx,hy,hz,...]. Per-triangle orientation flips a quad that folds
   *  at a sharp spike, which leaves its winding disagreeing with its
   *  neighbours; a strip-wide decision keeps the topology consistent. */
  strip(quads: number[], hints: number[]): void {
    const p = this.pos;
    let vote = 0;
    for (let q = 0, h = 0; q < quads.length; q += 4, h += 3) {
      const [a, b, c, d] = [quads[q], quads[q + 1], quads[q + 2], quads[q + 3]];
      const ux = p[c * 3] - p[a * 3], uy = p[c * 3 + 1] - p[a * 3 + 1], uz = p[c * 3 + 2] - p[a * 3 + 2];
      const vx = p[d * 3] - p[b * 3], vy = p[d * 3 + 1] - p[b * 3 + 1], vz = p[d * 3 + 2] - p[b * 3 + 2];
      // diagonals' cross product: twice the quad's vector area
      vote += (uy * vz - uz * vy) * hints[h] + (uz * vx - ux * vz) * hints[h + 1] + (ux * vy - uy * vx) * hints[h + 2];
    }
    const keep = vote >= 0;
    for (let q = 0; q < quads.length; q += 4) {
      const [a, b, c, d] = [quads[q], quads[q + 1], quads[q + 2], quads[q + 3]];
      if (keep) { this.raw(a, b, c); this.raw(a, c, d); }
      else { this.raw(a, c, b); this.raw(a, d, c); }
    }
  }

  /** Push a triangle as wound; drop it only if degenerate. */
  raw(a: number, b: number, c: number): void {
    const p = this.pos;
    const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2];
    const vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2];
    const gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
    if (gx * gx + gy * gy + gz * gz < 1e-24) return;
    this.idx.push(a, b, c);
  }
}

/** The vertices of a tessellation lying on the segment a->b, sorted by their
 *  parameter along it. Midpoints are exact averages, so "on the segment" is a
 *  tight test, not a tolerance. Endpoints are included. */
function verticesOnSegment(pts: number[], ax: number, ay: number, bx: number, by: number): { i: number; t: number }[] {
  const dx = bx - ax;
  const dy = by - ay;
  const L2 = dx * dx + dy * dy;
  if (L2 <= 0) return [];
  const eps = 1e-9 * Math.sqrt(L2);
  const out: { i: number; t: number }[] = [];
  const n = pts.length / 2;
  for (let i = 0; i < n; i++) {
    const px = pts[i * 2] - ax;
    const py = pts[i * 2 + 1] - ay;
    const perp = Math.abs(px * dy - py * dx) / Math.sqrt(L2);
    if (perp > eps) continue;
    const t = (px * dx + py * dy) / L2;
    if (t < -1e-9 || t > 1 + 1e-9) continue;
    out.push({ i, t: Math.max(0, Math.min(1, t)) });
  }
  out.sort((p, q) => p.t - q.t);
  const dedup: { i: number; t: number }[] = [];
  for (const e of out) if (!dedup.length || dedup[dedup.length - 1].i !== e.i) dedup.push(e);
  return dedup;
}

/** Is the inset still a valid polygon-with-holes? Each ring must be simple,
 *  holes must sit inside the outer, no two rings may cross, and the region
 *  must keep its orientation and a sane share of its area. A hairline O fails
 *  the last test: its outer's inset and its hole's inset cross each other, and
 *  the total area flips sign.
 *
 *  ponytail: all-or-nothing per region. A glyph with one thin stroke loses its
 *  bevel everywhere rather than just there. Real polygon offsetting (Clipper2)
 *  is the upgrade path if that ever matters on a real logo. */
function insetIsValid(inset: number[][], contour: number[][]): boolean {
  let a0 = 0;
  let a1 = 0;
  for (let r = 0; r < contour.length; r++) {
    a0 += signedArea(contour[r]);
    a1 += signedArea(inset[r]);
    if (!isSimple(inset[r])) return false;
  }
  if (Math.sign(a1) !== Math.sign(a0) || !(Math.abs(a1) > Math.abs(a0) * 0.35)) return false;
  for (let r = 1; r < inset.length; r++) {
    if (!pointInRing(inset[0], inset[r][0], inset[r][1])) return false;
    for (let s = r + 1; s < inset.length; s++) if (ringsCross(inset[r], inset[s])) return false;
    if (ringsCross(inset[0], inset[r])) return false;
  }
  return true;
}

export function buildMesh(regions: Region[], options: Partial<BuildOptions> = {}): Mesh {
  const profile = options.profile ?? DEFAULT_PROFILE;
  const tess = options.tessellation ?? DEFAULT_TESSELLATION;
  const cosCrease = Math.cos(((options.creaseDeg ?? DEFAULT_CREASE_DEG) * Math.PI) / 180);
  const D = profile.extrude;

  // ---- normalise ONCE across all regions so layers stay registered
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of regions)
    for (let i = 0; i < r.outer.length; i += 2) {
      minX = Math.min(minX, r.outer[i]);
      maxX = Math.max(maxX, r.outer[i]);
      minY = Math.min(minY, r.outer[i + 1]);
      maxY = Math.max(maxY, r.outer[i + 1]);
    }
  const w = maxX - minX;
  const h = maxY - minY;
  const sink = new Sink();
  if (!(w > 0 && h > 0)) return finish(sink, regions);
  const sc = Math.min(2 / w, 2.4 / h);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const srcW = options.source?.width ?? w;
  const srcH = options.source?.height ?? h;
  const srcX = options.source ? 0 : minX;
  const srcY = options.source ? 0 : minY;
  const px = (x: number) => (x - cx) * sc;
  const py = (y: number) => (cy - y) * sc; // source y-down -> model y-up
  const uOf = (mx: number) => (mx / sc + cx - srcX) / srcW;
  const vOf = (my: number) => (cy - my / sc - srcY) / srcH;

  // triangleCap is a budget for the WHOLE logo, shared by area: five letters
  // must not get five budgets (a five-letter wordmark hit 59k against a 50k gate that way).
  const areas = regions.map((r) => Math.max(0, Math.abs(signedArea(r.outer)) - r.holes.reduce((a, h) => a + Math.abs(signedArea(h)), 0)));
  const totalArea = areas.reduce((a, b) => a + b, 0) || 1;
  const regionCap = areas.map((a) => Math.max(64, Math.floor((tess.triangleCap * a) / totalArea)));

  regions.forEach((region, ri) => {
    const zOff = region.depth ?? 0;
    const contour: number[][] = [region.outer, ...region.holes].map((ring) => {
      const m: number[] = new Array(ring.length);
      for (let i = 0; i < ring.length; i += 2) {
        m[i] = px(ring[i]);
        m[i + 1] = py(ring[i + 1]);
      }
      return dedupeCollinear(m);
    });
    if (contour[0].length < 6) return;

    // ---- inset, shrinking until it fits. bevelWidth is in normalised units, so
    //      on a wide wordmark it can exceed half a stroke: 0.035 is 7.4px on a
    //      600px-wide wordmark, against ~25px strokes, and every letter's inset collapsed. Try
    //      narrower bands before giving up on a bevel entirely. Height stays
    //      fixed, so every region still reaches the same plateau and a narrow
    //      band simply reads as a crisper edge.
    let inset: number[][] = contour;
    let hasBand: boolean[] = contour.map(() => false);
    let rp = profile;
    if (profile.bevelWidth > 0)
      for (const f of BEVEL_SHRINK) {
        const bw = profile.bevelWidth * f;
        const tryInset = contour.map((ring) => mitredInset(ring, bw));
        if (tryInset.some((r) => r === null)) continue;
        if (!insetIsValid(tryInset as number[][], contour)) continue;
        inset = tryInset as number[][];
        hasBand = contour.map(() => true);
        rp = f === 1 ? profile : { ...profile, bevelWidth: bw };
        break;
      }

    // ---- interior: triangulate the inset, subdivide, measure, lift
    const t = subdivide(delaunayFlip(triangulateRings(inset)), tess.maxEdge, regionCap[ri]);
    if (!t.tris.length) return;
    // per contour ring: edge + vertex normals and crease flags, shared by the
    // interior, the band and the walls so all three shade from one field
    const rn = contour.map((ring) => {
      const n = ring.length / 2;
      const { edge: en, vertex: vn } = ringNormals(ring);
      const smooth: boolean[] = new Array(n);
      for (let i = 0; i < n; i++) {
        const p = (i - 1 + n) % n;
        smooth[i] = en[p * 2] * en[i * 2] + en[p * 2 + 1] * en[i * 2 + 1] > cosCrease;
      }
      return { n, en, vn, smooth };
    });
    /** Outward direction of the distance field, smoothed like vertex normals.
     *  The raw gradient of distance-to-a-polyline is CONSTANT per segment, so a
     *  64-gon circle shaded as 64 visible facets (radial streaks on a domed
     *  ring). Mid-segment: interpolate the end normals (Phong). At a smooth
     *  vertex: its vertex normal. At a crease vertex: the true radial fan, which
     *  meets the edge normals on either side continuously. */
    const fieldDir = (ringIdx: number, seg: number, tt: number, gx: number, gy: number, d: number): [number, number] => {
      const R = rn[ringIdx];
      const j = (seg + 1) % R.n;
      if (tt <= 0 || tt >= 1) {
        const k = tt <= 0 ? seg : j;
        if (R.smooth[k]) return [R.vn[k * 2], R.vn[k * 2 + 1]];
        return d > 1e-12 ? [-gx, -gy] : [R.en[seg * 2], R.en[seg * 2 + 1]];
      }
      const ax = R.smooth[seg] ? R.vn[seg * 2] : R.en[seg * 2];
      const ay = R.smooth[seg] ? R.vn[seg * 2 + 1] : R.en[seg * 2 + 1];
      const bx = R.smooth[j] ? R.vn[j * 2] : R.en[seg * 2];
      const by = R.smooth[j] ? R.vn[j * 2 + 1] : R.en[seg * 2 + 1];
      const x = ax + (bx - ax) * tt;
      const y = ay + (by - ay) * tt;
      const L = Math.hypot(x, y) || 1;
      return [x / L, y / L];
    };

    // ---- local half-width R along the outline: at sample points on every
    //      segment, the radius of the largest disc tangent to the outline there,
    //      grown along the inward normal until it touches another part of the
    //      outline. Inflation is scaled by THIS, so a stroke's rise follows its
    //      own width and its centre line is where the arc is flat.
    let ox0 = Infinity, oy0 = Infinity, ox1 = -Infinity, oy1 = -Infinity;
    for (let i = 0; i < contour[0].length; i += 2) {
      ox0 = Math.min(ox0, contour[0][i]); ox1 = Math.max(ox1, contour[0][i]);
      oy0 = Math.min(oy0, contour[0][i + 1]); oy1 = Math.max(oy1, contour[0][i + 1]);
    }
    const rCap = Math.max(ox1 - ox0, oy1 - oy0) / 2;
    /** Distance from outline point p to the medial axis along inward direction
     *  n: grow s while the outline point nearest the centre p + s*n stays LOCAL
     *  to p. The medial axis is exactly where that nearest point jumps to the far
     *  side of the stroke. (Testing "distance == s" instead fails on a polyline:
     *  its normal is piecewise constant, so the disc clips its own segment.) */
    const inscribed = (px: number, py: number, nx: number, ny: number): number => {
      const local = (s: number): boolean => {
        const cx = px + nx * s, cy = py + ny * s;
        const q = nearestOnRings(contour, cx, cy);
        const fx = cx - q.d * q.gx, fy = cy - q.d * q.gy; // the nearest outline point
        // local = still on p's own side: it barely advances along n. The far side
        // of the stroke lies a whole stroke-width along n. (Distance alone is not
        // enough: a probe that overshoots a thin stroke finds the far edge within
        // reach of p and mistakes it for local.)
        return (fx - px) * nx + (fy - py) * ny <= 0.25 * s + 1e-12;
      };
      // Grow by doubling from a tiny radius, then bisect the first failure. The
      // test is NOT monotone in s: a probe far past a thin stroke, out in empty
      // space, can see a "local" outline again. Bisecting from rCap/2 landed
      // there first and kept a radius the size of the logo, so one stroke of a
      // real wordmark stood 2.5x proud. A straight stroke of half-width R fails
      // over [R, 8R], wider than one doubling, so the march cannot skip it.
      // (Beside a reflex corner the window can be narrower than 2x and get
      // skipped; the stroke's own far side still caps R, as the old search did.)
      // rCap itself is probed, not assumed: a fat blob's true R lies in
      // (rCap/2, rCap], and returning rCap there bulged it to twice its height.
      let lo = 0, hi = rCap / 4096;
      while (local(hi)) {
        if (hi >= rCap) return rCap;
        lo = hi;
        hi = Math.min(hi * 2, rCap);
      }
      for (let it = 0; it < 10; it++) {
        const s = (lo + hi) / 2;
        if (local(s)) lo = s;
        else hi = s;
      }
      return lo;
    };
    const rSpacing = tess.maxEdge / 2;
    // Samples sit at the centres of sub-intervals, grown along the smoothed
    // normal (the underlying curve's, not the polyline's piecewise-constant one).
    // At each vertex the two neighbouring end samples are averaged, so R stays
    // continuous from one segment to the next.
    const rMid: Float64Array[][] = contour.map((ring, r) => {
      const R = rn[r];
      const out: Float64Array[] = new Array(R.n);
      for (let i = 0; i < R.n; i++) {
        const j = (i + 1) % R.n;
        const ax = ring[i * 2], ay = ring[i * 2 + 1], bx = ring[j * 2], by = ring[j * 2 + 1];
        const k = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / rSpacing));
        const arr = new Float64Array(k);
        for (let q = 0; q < k; q++) {
          const tt = (q + 0.5) / k;
          const [dx, dy] = fieldDir(r, i, tt, 0, 0, 1);
          arr[q] = inscribed(ax + (bx - ax) * tt, ay + (by - ay) * tt, -dx, -dy);
        }
        out[i] = arr;
      }
      return out;
    });
    const rVert: Float64Array[] = rMid.map((segs) => {
      const n = segs.length;
      const v = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const prev = segs[(i - 1 + n) % n];
        v[i] = (prev[prev.length - 1] + segs[i][0]) / 2;
      }
      return v;
    });
    /** R at parameter tt along segment seg: piecewise linear through
     *  [vertex, mid-samples..., next vertex]. */
    const localR = (ring: number, seg: number, tt: number): number => {
      const mids = rMid[ring][seg];
      const k = mids.length;
      const n = mids.length && rVert[ring].length;
      const r0 = rVert[ring][seg];
      const r1 = rVert[ring][(seg + 1) % n];
      const u = Math.max(0, Math.min(1, tt)) * k; // mid-sample q sits at u = q + 0.5
      if (u <= 0.5) return r0 + (mids[0] - r0) * (u / 0.5);
      if (u >= k - 0.5) return mids[k - 1] + (r1 - mids[k - 1]) * ((u - (k - 0.5)) / 0.5);
      const a = Math.floor(u - 0.5);
      return mids[a] + (mids[a + 1] - mids[a]) * (u - 0.5 - a);
    };

    const nV = t.pts.length / 2;
    const dist = new Float64Array(nV);
    const rLoc = new Float64Array(nV);
    const gxs = new Float64Array(nV); // smoothed OUTWARD field direction
    const gys = new Float64Array(nV);
    for (let i = 0; i < nV; i++) {
      const q = nearestOnRings(contour, t.pts[i * 2], t.pts[i * 2 + 1]);
      dist[i] = q.d;
      rLoc[i] = localR(q.ring, q.seg, q.t);
      const [ox, oy] = fieldDir(q.ring, q.seg, q.t, q.gx, q.gy, q.d);
      gxs[i] = ox;
      gys[i] = oy;
    }
    const interiorIdx = new Int32Array(nV);
    for (let i = 0; i < nV; i++) {
      const x = t.pts[i * 2];
      const y = t.pts[i * 2 + 1];
      const { h: lift, slope } = surfaceHeight(dist[i], rLoc[i], rp);
      interiorIdx[i] = sink.vertex(x, y, D / 2 + lift + zOff, slope * gxs[i], slope * gys[i], 1, uOf(x), vOf(y), FaceKind.Front, ri);
    }
    for (let i = 0; i < t.tris.length; i += 3)
      sink.tri(interiorIdx[t.tris[i]], interiorIdx[t.tris[i + 1]], interiorIdx[t.tris[i + 2]], 0, 0, 1);

    // ---- mirrored interior = the bulk of the back
    // ponytail: the back is flat but carries the interior's full subdivision,
    // roughly doubling triangle count (a disc lands at ~42k of the 50k budget).
    // Watertight by construction is worth it. If the budget binds on real
    // logos, decimate the back interior while keeping its boundary vertices.
    // depth raises only the FRONT (interior, bevel band, wall tops). The back
    // stays on the base plane, so a raised region is a taller solid rather than
    // a floating one with a recess behind it.
    const zBack = -D / 2;
    const backIdx = new Int32Array(nV);
    for (let i = 0; i < nV; i++) {
      const x = t.pts[i * 2];
      const y = t.pts[i * 2 + 1];
      backIdx[i] = sink.vertex(x, y, zBack, 0, 0, -1, uOf(x), vOf(y), FaceKind.Back, ri);
    }
    for (let i = 0; i < t.tris.length; i += 3)
      sink.tri(backIdx[t.tris[i]], backIdx[t.tris[i + 1]], backIdx[t.tris[i + 2]], 0, 0, -1);

    // ---- band + walls + the back's rim strip.
    //      Each ring is walked as ONE continuous loop of the interior vertices
    //      that actually lie on its boundary. earcut silently drops duplicate and
    //      collinear points, so a ring's own vertex list is not the surface's
    //      boundary; building band, walls and strip from the vertices the
    //      triangulation USES keeps every seam closed whatever earcut kept.
    const used = new Uint8Array(nV);
    for (const v of t.tris) used[v] = 1;
    for (let r = 0; r < contour.length; r++) {
      const ring = contour[r];
      const ins = inset[r];
      const n = ring.length / 2;
      const { en, vn, smooth } = rn[r];

      // (interior vertex, ring edge, parameter along that edge), in ring order
      const loop: { v: number; e: number; t: number }[] = [];
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        for (const q of verticesOnSegment(t.pts, ins[i * 2], ins[i * 2 + 1], ins[j * 2], ins[j * 2 + 1])) {
          if (!used[q.i]) continue;
          if (loop.length && loop[loop.length - 1].v === q.i) continue;
          loop.push({ v: q.i, e: i, t: q.t });
        }
      }
      if (loop.length > 1 && loop[loop.length - 1].v === loop[0].v) loop.pop();
      const m = loop.length;
      if (m < 3) continue;

      const cx = (k: number) => { const p = loop[k], a = p.e, b = (p.e + 1) % n; return ring[a * 2] + (ring[b * 2] - ring[a * 2]) * p.t; };
      const cy = (k: number) => { const p = loop[k], a = p.e, b = (p.e + 1) % n; return ring[a * 2 + 1] + (ring[b * 2 + 1] - ring[a * 2 + 1]) * p.t; };
      // the ring vertex a loop point sits on, or -1 mid-edge
      const atVertex = (k: number) => (loop[k].t <= 0 ? loop[k].e : loop[k].t >= 1 ? (loop[k].e + 1) % n : -1);
      // outward normal of loop point k as seen from the segment lying on edge E:
      // smoothed across gentle corners, the edge's own normal across a crease
      const nrm = (k: number, E: number): [number, number] => {
        const c = atVertex(k);
        if (c >= 0) return smooth[c] ? [vn[c * 2], vn[c * 2 + 1]] : [en[E * 2], en[E * 2 + 1]];
        return fieldDir(r, loop[k].e, loop[k].t, 0, 0, 1); // mid-edge: same Phong blend as the interior
      };
      // segment (k -> k+1) lies on the edge of its far end; normals either side of point k
      const nIn = (k: number) => nrm(k, loop[k].e);
      const nOut = (k: number) => nrm(k, loop[(k + 1) % m].e);
      const same = (a: [number, number], b: [number, number]) => a[0] === b[0] && a[1] === b[1];

      /** One vertex per loop point, split in two only where the normal differs
       *  on either side (a crease), so smooth curves share and corners stay sharp. */
      const row = (make: (k: number, nx: number, ny: number) => number) => {
        const L = new Int32Array(m);
        const R = new Int32Array(m);
        for (let k = 0; k < m; k++) {
          const a = nIn(k), b = nOut(k);
          L[k] = make(k, a[0], a[1]);
          R[k] = same(a, b) ? L[k] : make(k, b[0], b[1]);
        }
        return { L, R };
      };
      const hint = (k: number): [number, number] => {
        const k2 = (k + 1) % m;
        const dx = cx(k2) - cx(k), dy = cy(k2) - cy(k);
        return [-dy, dx]; // the outward convention of ringNormals
      };

      // band: row 0 is the interior's own boundary; row `steps` is the contour
      const steps = hasBand[r] ? Math.max(1, rp.bevelSteps | 0) : 0;
      const bandQ: number[] = [];
      const bandH: number[] = [];
      let prev = { L: Int32Array.from(loop, (p) => interiorIdx[p.v]), R: Int32Array.from(loop, (p) => interiorIdx[p.v]) };
      for (let s = 1; s <= steps; s++) {
        const f = s / steps;
        const cur = row((k, ox, oy) => {
          const vx = t.pts[loop[k].v * 2], vy = t.pts[loop[k].v * 2 + 1];
          const x = vx * (1 - f) + cx(k) * f;
          const y = vy * (1 - f) + cy(k) * f;
          const q = nearestOnRings(contour, x, y);
          const { h: lift, slope } = surfaceHeight(q.d, localR(q.ring, q.seg, q.t), rp);
          return sink.vertex(x, y, D / 2 + lift + zOff, slope * ox, slope * oy, 1, uOf(x), vOf(y), FaceKind.Bevel, ri);
        });
        for (let k = 0; k < m; k++) {
          const k2 = (k + 1) % m;
          const [hx, hy] = hint(k);
          bandQ.push(prev.R[k], prev.L[k2], cur.L[k2], cur.R[k]);
          bandH.push(hx, hy, 2 * Math.hypot(hx, hy));
        }
        prev = cur;
      }
      sink.strip(bandQ, bandH);

      // walls: contour from the front edge (surfaceHeight(0) = 0) down to the back
      const top = row((k, ox, oy) => sink.vertex(cx(k), cy(k), D / 2 + zOff, ox, oy, 0, 0, 0, FaceKind.Side, ri));
      const bot = row((k, ox, oy) => sink.vertex(cx(k), cy(k), zBack, ox, oy, 0, 0, 0, FaceKind.Side, ri));
      for (let k = 0; k < m; k++) {
        const k2 = (k + 1) % m;
        const [hx, hy] = hint(k);
        sink.quad(top.R[k], bot.R[k], bot.L[k2], top.L[k2], hx, hy, 0);
      }

      // back strip: mirrored interior boundary -> contour, flat. Only where a band
      // separates them; on a hard-edged ring they coincide and there is no gap.
      if (hasBand[r]) {
        const rim = Int32Array.from(loop, (_, k) => sink.vertex(cx(k), cy(k), zBack, 0, 0, -1, uOf(cx(k)), vOf(cy(k)), FaceKind.Back, ri));
        const stripQ: number[] = [];
        const stripH: number[] = [];
        for (let k = 0; k < m; k++) {
          const k2 = (k + 1) % m;
          stripQ.push(backIdx[loop[k].v], backIdx[loop[k2].v], rim[k2], rim[k]);
          stripH.push(0, 0, -1);
        }
        sink.strip(stripQ, stripH);
      }
    }

  });

  return finish(sink, regions);
}

function finish(sink: Sink, regions: Region[]): Mesh {
  return {
    positions: Float32Array.from(sink.pos),
    normals: Float32Array.from(sink.nrm),
    uvs: Float32Array.from(sink.uv),
    faceKind: Uint8Array.from(sink.kind),
    regionIndex: Uint16Array.from(sink.region),
    indices: Uint32Array.from(sink.idx),
    regionHex: regions.map((r) => r.hex),
  };
}
