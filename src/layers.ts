/** Layering: the painter's stack -> disjoint regions -> depth by containment.
 *
 *  A logo is not a pile of shapes at different heights: a white disc painted
 *  over a pink one is a pink RING with a white disc filling its hole. So
 *    1. flattenPaintOrder  each region minus everything painted above it, so no
 *                          two regions overlap in xy (no z-fight, no doubled geometry);
 *    2. assignContainmentDepth  a region sitting inside another's outer boundary
 *                          is one level in front of it; siblings share a level.
 *  See docs/DESIGN.md decision 5 and §5 "Layer ordering".
 *
 *  Booleans run in Clipper2 (clipper2-js, a pure TypeScript port: no WASM) on
 *  integer coordinates. Colours are never touched: every output region carries
 *  the exact hex of the region it was cut from. */
import { Clipper, ClipperOffset, EndType, FillRule, JoinType, type Path64, Paths64 } from "clipper2-js";
import { signedArea } from "./geom.js";
import type { Region } from "./types.js";

/** Positive: a ring wound like an outer fills, a hole ring (opposite winding)
 *  cancels it, and a stray hole outside any outer fills nothing. */
const FILL = FillRule.Positive;
/** Pieces smaller than this share of the total area are dropped (see `finish`). */
const MIN_AREA_SHARE = 1e-6;

/** Power-of-two scale mapping the largest coordinate to ~2^23, so Clipper's
 *  integers keep sub-pixel precision at any viewBox size, scaling is exact in
 *  floating point, and the result is a pure function of the input.
 *  `tol` is the shortest edge worth keeping, in the same integer units: 2e-4 of
 *  the extent, twice the usual weld-by-distance default (1e-4 of a model that
 *  is 2 wide, so 5e-5 of the extent). */
function gridFor(regions: Region[]): { scale: number; tol: number } {
  let m = 0;
  for (const r of regions) for (const v of r.outer) m = Math.max(m, Math.abs(v));
  const scale = m > 0 ? 2 ** Math.floor(Math.log2(2 ** 23 / m)) : 1;
  return { scale, tol: Math.max(1, 2e-4 * m * scale) };
}

/** Flat ring wound outer-positive or hole-negative, in shoelace terms. */
function orient(ring: number[], positive: boolean): number[] {
  if (signedArea(ring) > 0 === positive) return ring;
  const out: number[] = [];
  for (let i = ring.length - 2; i >= 0; i -= 2) out.push(ring[i], ring[i + 1]);
  return out;
}

function toPaths(region: Region, scale: number): Paths64 {
  const path = (ring: number[], positive: boolean): Path64 =>
    Clipper.makePath(orient(ring, positive).map((v) => Math.round(v * scale)));
  return [path(region.outer, true), ...region.holes.map((h) => path(h, false))] as Paths64;
}

/** 1 = strictly inside the ring, 0 = on its boundary (within sqrt(eps2)), -1 = outside. */
function locate(ring: number[], x: number, y: number, eps2: number): -1 | 0 | 1 {
  let inside = false;
  for (let i = 0, n = ring.length / 2, j = n - 1; i < n; j = i++) {
    const xi = ring[i * 2], yi = ring[i * 2 + 1], xj = ring[j * 2], yj = ring[j * 2 + 1];
    const dx = xj - xi, dy = yj - yi;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - xi) * dx + (y - yi) * dy) / len2)) : 0;
    if ((x - xi - t * dx) ** 2 + (y - yi - t * dy) ** 2 <= eps2) return 0;
    if (yi > y !== yj > y && x < (dx * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside ? 1 : -1;
}

/** Does `outer` enclose `ring`? No vertex of `ring` strictly outside and at
 *  least one strictly inside. Vertices ON the boundary are neutral: flattened
 *  neighbours share edges exactly, and a shared vertex must not decide
 *  anything either way. */
function encloses(outer: number[], ring: number[], eps2: number): boolean {
  let strictlyIn = false;
  for (let k = 0; k < ring.length; k += 2) {
    const side = locate(outer, ring[k], ring[k + 1], eps2);
    if (side < 0) return false;
    if (side > 0) strictlyIn = true;
  }
  return strictlyIn;
}

/** Flat Clipper output -> regions. clipper2-js 1.2.4's PolyTree is broken (its
 *  OutRec never initialises `bounds`, so executePolyTree swallows a TypeError and
 *  hands back an empty tree), so hole structure is rebuilt here from the flat
 *  result: Clipper winds outers positive and holes negative, and each hole goes
 *  to the smallest outer that encloses it. */
function fromPaths(paths: Paths64, hex: string, grid: { scale: number; tol: number }, out: Region[]): void {
  const { scale, tol } = grid;
  // Drop vertices closer than `tol` to the last one kept. This port's boolean
  // output repeats points outright (its own stripDuplicates compares by
  // identity, so it cannot be used), and where two outlines cross at a shallow
  // angle Clipper emits edges of a few thousandths of a pixel. Each is a
  // degenerate triangle in the mesh, and tears under Merge by Distance.
  const rings = paths
    .map((p: Path64) => {
      const r: number[] = [];
      for (const pt of p) if (!r.length || Math.hypot(r[r.length - 2] - pt.x, r[r.length - 1] - pt.y) >= tol) r.push(pt.x, pt.y);
      while (r.length > 2 && Math.hypot(r[0] - r[r.length - 2], r[1] - r[r.length - 1]) < tol) r.length -= 2;
      return r.map((v) => v / scale);
    })
    .filter((r) => r.length >= 6);
  const shapes = rings.filter((r) => signedArea(r) > 0).map((outer): Region => ({ hex, outer, holes: [] }));
  const bySize = [...shapes].sort((a, b) => signedArea(a.outer) - signedArea(b.outer));
  for (const h of rings.filter((r) => signedArea(r) < 0)) bySize.find((s) => encloses(s.outer, h, 0))?.holes.push(h);
  out.push(...shapes);
}

const netArea = (r: Region) => Math.abs(signedArea(r.outer)) - r.holes.reduce((a, h) => a + Math.abs(signedArea(h)), 0);

/** Drop slivers. A region (or hole) under 1e-6 of the total area is a boolean
 *  artefact, not a design element: it would only add needle triangles to the
 *  mesh, and at that size removing it is invisible. */
function finish(regions: Region[]): Region[] {
  const floor = regions.reduce((a, r) => a + netArea(r), 0) * MIN_AREA_SHARE;
  return regions
    .filter((r) => netArea(r) > floor)
    .map((r) => ({ ...r, holes: r.holes.filter((h) => Math.abs(signedArea(h)) > floor) }));
}

/** `regions` is bottom-to-top paint order. Each result is a region minus the
 *  union of everything above it, so the output is disjoint in xy. A region may
 *  split into several (a bar painted across a disc) or vanish (fully covered).
 *
 *  ponytail: the covering union grows as the stack is walked, so this is
 *  roughly O(n * union size). Fine for logos; an icon sheet of thousands of
 *  shapes would want a bounding-box prefilter. */
export function flattenPaintOrder(regions: Region[]): Region[] {
  const grid = gridFor(regions);
  const { scale } = grid;
  const out: Region[][] = [];
  let above = new Paths64();
  for (let i = regions.length - 1; i >= 0; i--) {
    const mine = toPaths(regions[i], scale);
    out[i] = [];
    fromPaths(Clipper.Difference(mine, above, FILL), regions[i].hex, grid, out[i]);
    above = Clipper.Union(above, mine, FILL);
  }
  return finish(out.flat());
}

/** Grow every region by `delta` source units (round joins; negative shrinks).
 *  The raster path uses it so independently traced neighbours overlap by a
 *  hair instead of leaving a crack; flattenPaintOrder then trims the overlap. */
export function inflateRegions(regions: Region[], delta: number): Region[] {
  const grid = gridFor(regions);
  const { scale } = grid;
  const d = delta * scale;
  const out: Region[] = [];
  for (const r of regions) {
    // arc tolerance relative to delta (about 4 segments per full circle): this only
    // closes hairline cracks, and Clipper's default would add hundreds of points
    const off = new ClipperOffset(2, Math.max(1, Math.abs(d) * 0.25));
    off.addPaths(toPaths(r, scale), JoinType.Round, EndType.Polygon);
    const solution = new Paths64();
    off.execute(d, solution);
    // Round joins still leave 2-3 points per original vertex, with sub-pixel
    // edges between them. Those collapse under the mitred bevel inset (it
    // shortens a tiny edge by more than its own length) and tear the mesh
    // (hundreds of slivers under weld). Merging points within delta/2 of their
    // neighbours' line costs under half a delta of accuracy and removes them.
    fromPaths(Clipper.simplifyPaths(solution, Math.abs(d) / 2, true), r.hex, grid, out);
  }
  return finish(out);
}

/** Drop every hole that the other regions cover (at least `minCover` of its
 *  area), so the region underneath simply lies beneath whatever fills the hole.
 *
 *  Why: a pink ring with a white disc in its hole is, as traced, two outlines of
 *  the SAME pixel boundary, simplified independently, so they disagree by up to
 *  a pixel and cross each other. Growing both (inflateRegions) closes most of
 *  that but not all, and the leftovers are notches the metal shows through and
 *  tiny edges the mesh tears on. Once the ring is filled and the disc painted
 *  over it, flattenPaintOrder cuts the hole out of the ring with the disc's own
 *  outline: the two share one boundary exactly, by construction.
 *
 *  A counter (a hole nothing fills) has no cover and stays open; so does a real
 *  gap around a smaller inner shape, which is why this is a threshold and not
 *  "any overlap". */
export function fillCoveredHoles(regions: Region[], minCover = 0.97): Region[] {
  const { scale } = gridFor(regions);
  let all = new Paths64();
  for (const r of regions) all = Clipper.Union(all, toPaths(r, scale), FILL);
  return regions.map((r) => ({
    ...r,
    holes: r.holes.filter((h) => {
      const disc = [Clipper.makePath(orient(h, true).map((v) => Math.round(v * scale)))] as Paths64;
      return Clipper.areaPaths(Clipper.Intersect(disc, all, FILL)) < minCover * Clipper.areaPaths(disc);
    }),
  }));
}

/** Containment level of each region: how many OTHER regions' outer rings
 *  enclose its outer ring, the enclosing outer having the larger area.
 *  Checking every vertex (with boundary vertices neutral) instead of one keeps
 *  edge-sharing siblings from reading as nested. */
export function containmentLevels(regions: Region[]): number[] {
  const area = regions.map((r) => Math.abs(signedArea(r.outer)));
  const box = regions.map((r) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < r.outer.length; i += 2) {
      x0 = Math.min(x0, r.outer[i]); x1 = Math.max(x1, r.outer[i]);
      y0 = Math.min(y0, r.outer[i + 1]); y1 = Math.max(y1, r.outer[i + 1]);
    }
    return [x0, y0, x1, y1];
  });
  const eps = Math.max(0, ...box.map((b) => Math.max(b[2] - b[0], b[3] - b[1]))) * 1e-7;
  return regions.map((r, i) => {
    let level = 0;
    for (let j = 0; j < regions.length; j++) {
      if (j === i || !(area[j] > area[i])) continue;
      const a = box[i], b = box[j];
      if (a[0] < b[0] - eps || a[1] < b[1] - eps || a[2] > b[2] + eps || a[3] > b[3] + eps) continue;
      if (encloses(regions[j].outer, r.outer, eps * eps)) level++;
    }
    return level;
  });
}

/** depth = level * layerStep, level from containment. Deterministic. */
export function assignContainmentDepth(regions: Region[], layerStep: number): Region[] {
  const level = containmentLevels(regions);
  return regions.map((r, i) => ({ ...r, depth: level[i] * layerStep }));
}

/** The SVG path: a painter's stack in, disjoint depth-layered regions out. */
export function layerRegions(regions: Region[], layerStep: number): Region[] {
  return assignContainmentDepth(flattenPaintOrder(regions), layerStep);
}
