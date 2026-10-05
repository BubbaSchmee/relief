/** A procedural studio sphere for the glossy look: what a mirror ball would show
 *  in a dark photo studio with a few softboxes. No image asset and no canvas:
 *  plain float maths, so every machine draws the same bytes.
 *
 *  Texel (u, v) holds the environment reflected at the sphere normal
 *  n = (u, v, sqrt(1 - u^2 - v^2)) seen from +z, i.e. in the direction
 *  r = 2 nz n - z. The shader looks the same table up with the true reflection
 *  vector, so it stays right under perspective. Values are sRGB-encoded 8-bit;
 *  the shader decodes them with the exact piecewise EOTF. Row 0 is v = -1 (the
 *  bottom), which is what texImage2D expects, so no flip is needed. */
import { linearToSrgb } from "./color.js";

type V3 = [number, number, number];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: V3): V3 => { const l = Math.hypot(a[0], a[1], a[2]); return [a[0] / l, a[1] / l, a[2] / l]; };
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const smoothstep = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** A soft rectangular card at direction `d`: 1 inside, easing to 0 over `soft`.
 *  a and b are gnomonic (tan-angle) coordinates across the card. */
function card(r: V3, d: V3, halfW: number, halfH: number, soft: number): number {
  const dz = dot(r, d);
  if (dz <= 0.05) return 0;
  const right = norm(cross([0, 1, 0], d));
  const up = cross(d, right);
  const a = Math.abs(dot(r, right) / dz), b = Math.abs(dot(r, up) / dz);
  return (1 - smoothstep(halfW - soft, halfW + soft, a)) * (1 - smoothstep(halfH - soft, halfH + soft, b));
}

const KEY = norm([-0.55, 0.12, 0.83]);
const STRIP = norm([0.82, 0.0, 0.57]);
const TOP = norm([0.05, 1.0, 0.18]);
const RIM = norm([-0.3, 0.35, -0.89]);
const FILL = norm([0.4, -0.45, 0.8]);

/** Linear radiance of the studio in direction r (unit, view space, +z toward the camera). */
export function studio(r: V3): number {
  const horizon = smoothstep(-0.1, 0.1, r[1]); // dark floor, brighter ceiling, a clear horizon line
  const base = 0.02 + 0.012 * Math.max(0, -r[1]) + horizon * (0.05 + 0.12 * Math.max(0, r[1]));
  return (
    base +
    1.0 * card(r, KEY, 0.4, 0.62, 0.1) + // large key softbox, upper left, tall so a tilted face still meets it
    0.85 * card(r, STRIP, 0.1, 0.8, 0.05) + // narrow strip on the right
    0.55 * card(r, TOP, 0.55, 0.12, 0.06) + // overhead bar
    0.9 * card(r, RIM, 0.6, 0.1, 0.05) + // back light, shows as a rim at the sphere's edge
    0.16 * card(r, FILL, 0.6, 0.4, 0.25) // dim fill from low right
  );
}

export function studioMatcap(size = 512): Uint8ClampedArray {
  const out = new Uint8ClampedArray(size * size * 4);
  for (let j = 0; j < size; j++)
    for (let i = 0; i < size; i++) {
      let u = ((i + 0.5) / size) * 2 - 1;
      let v = ((j + 0.5) / size) * 2 - 1;
      const rr = u * u + v * v;
      if (rr > 1) { // outside the disc: repeat the rim so filtering never blends in black
        const l = Math.sqrt(rr);
        u /= l;
        v /= l;
      }
      const nz = Math.sqrt(Math.max(0, 1 - u * u - v * v));
      const e = studio([2 * nz * u, 2 * nz * v, 2 * nz * nz - 1]);
      const o = (j * size + i) * 4;
      const c = linearToSrgb(Math.min(1, e));
      out[o] = c * 0.97; // a hair cool: it reads as polished steel, not paper
      out[o + 1] = c * 0.99;
      out[o + 2] = c;
      out[o + 3] = 255;
    }
  return out;
}
