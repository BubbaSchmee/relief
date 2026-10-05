/** The profile: one height function with two terms.
 *
 *    z(d) = bevelHeight * bevel(d / bevelWidth) + inflate * R * arc(d / R)
 *
 *  The bevel is ABSOLUTE in d, so a hairline gets the same crisp edge as a
 *  heavy stroke. Inflation is RELATIVE to R, the stroke's own local half-width,
 *  with a quarter-circle that is flat at the centre line: every stroke gets the
 *  same rounded cross-section scaled to its width, and none creases down its
 *  middle. (An earlier u^k dome normalised to the logo's thickest point left a
 *  visible crease along every thinner stroke.) docs/DESIGN.md §5. */
import type { BevelCurve, Profile } from "./types.js";

/** Curves run (0,0) -> (1,1). `d` is the derivative dc/dt, used for normals.
 *  Derivatives are clamped: a quarter-circle is vertical at t=0 and infinities
 *  would poison the normal. */
const SLOPE_CAP = 24;

export function bevelCurve(curve: BevelCurve, t: number): { c: number; d: number } {
  const u = t <= 0 ? 0 : t >= 1 ? 1 : t;
  switch (curve) {
    case "chamfer":
      return { c: u, d: 1 };
    case "round": {
      // quarter circle, tangent to the face at t=1, steep at the rim
      const s = 1 - u;
      const root = Math.sqrt(Math.max(1e-12, 1 - s * s));
      return { c: root, d: Math.min(SLOPE_CAP, s / root) };
    }
    case "ogee": {
      // smoothstep: tangent to BOTH the wall and the face, the softest edge
      return { c: u * u * (3 - 2 * u), d: 6 * u * (1 - u) };
    }
    case "step": {
      // two risers with a flat landing between them
      if (u < 0.4) return { c: (u / 0.4) * 0.5, d: 1.25 };
      if (u < 0.6) return { c: 0.5, d: 0 };
      return { c: 0.5 + ((u - 0.6) / 0.4) * 0.5, d: 1.25 };
    }
  }
}


/** Height of the front surface above the base plane at distance `d` from the
 *  region edge, where the stroke's local half-width is `R`, plus dh/dd — which
 *  is all the normal needs, since the gradient direction comes from the
 *  distance field. (The along-stroke change in R is ignored for the normal; it
 *  is slow, and ignoring it keeps the normal continuous.) */
export function surfaceHeight(d: number, R: number, p: Profile): { h: number; slope: number } {
  let h = 0;
  let slope = 0;

  if (p.bevelHeight !== 0 && p.bevelWidth > 0) {
    const t = d / p.bevelWidth;
    const { c, d: dc } = bevelCurve(p.bevelCurve, t);
    h += p.bevelHeight * c;
    if (t < 1) slope += (p.bevelHeight * dc) / p.bevelWidth;
  }
  // No band, no lift: a zero-width bevel used to add bevelHeight even AT the
  // edge, floating the front rim above the walls and opening the mesh. The
  // mesher relies on surfaceHeight(0) === 0 for every profile.

  // Inflation: the quarter circle, scaled to this stroke. Its slope is zero at
  // d = R, the stroke's centre line, which is what removes the crease the old
  // dome (u^k against the logo's thickest point) left on every thinner stroke.
  if (p.inflate > 0 && R > 0) {
    const { c, d: dc } = bevelCurve("round", d / R);
    h += p.inflate * R * c;
    slope += p.inflate * dc;
  }

  return { h, slope };
}

/** The plateau height: what the surface reaches once past the bevel band.
 *  The bevel band's inner rim must meet the interior surface here exactly, or
 *  the two halves of the front face disagree and the seam shows. */
export function bevelPlateau(p: Profile): number {
  return p.bevelHeight;
}
