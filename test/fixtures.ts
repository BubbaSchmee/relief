/** Synthetic logos in SOURCE space (y-down), following trace.ts's convention:
 *  outers have POSITIVE shoelace area, holes NEGATIVE. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import type { Region } from "../src/types.js";

const PINK = "#FF2E9A";

export function rect(x: number, y: number, w: number, h: number): number[] {
  return [x, y, x + w, y, x + w, y + h, x, y + h];
}

export function circle(cx: number, cy: number, r: number, n = 64): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
  return out;
}

export function star(cx: number, cy: number, rOut: number, rIn: number, points = 5): number[] {
  const out: number[] = [];
  for (let i = 0; i < points * 2; i++) {
    const a = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2;
    const r = i % 2 === 0 ? rOut : rIn;
    out.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
  return out;
}

/** Reverse a ring's winding: an outer becomes a hole. */
export function asHole(ring: number[]): number[] {
  const out: number[] = [];
  for (let i = ring.length - 2; i >= 0; i -= 2) out.push(ring[i], ring[i + 1]);
  return out;
}

export const FIXTURES: Record<string, Region[]> = {
  slab: [{ hex: PINK, outer: rect(0, 0, 200, 80), holes: [] }],
  disc: [{ hex: PINK, outer: circle(100, 100, 90), holes: [] }],
  /** A thick letter O: the canonical hole case. */
  thickO: [{ hex: PINK, outer: circle(100, 100, 90), holes: [asHole(circle(100, 100, 50))] }],
  /** A thin O (6px ring): the nominal bevel cannot fit, a narrower one must. */
  thinO: [{ hex: PINK, outer: circle(100, 100, 90), holes: [asHole(circle(100, 100, 84))] }],
  /** A 1px ring: no bevel width in the shrink sequence fits, so this must fall
   *  back to a hard edge — still watertight, never self-intersecting. */
  hairline: [{ hex: PINK, outer: circle(100, 100, 90), holes: [asHole(circle(100, 100, 89))] }],
  /** Spikes: the mitre cap has to hold or the inset flies off the tips. */
  star: [{ hex: PINK, outer: star(100, 100, 95, 40), holes: [] }],
  /** A stroke that tapers 80 -> 30 along its length: inflation must follow the
   *  local width, and the centre line must not crease. */
  wedge: [{ hex: PINK, outer: [0, 0, 400, 25, 400, 55, 0, 80], holes: [] }],
  /** A wordmark-shaped slab with two counters, like a B. */
  bee: [{ hex: PINK, outer: rect(0, 0, 120, 200), holes: [asHole(rect(30, 30, 60, 55)), asHole(rect(30, 115, 60, 55))] }],
};

/** The raster fixture: the word RELIEF in six bold letters, 600x200, one flat
 *  colour on a transparent background (test/fixtures/make-wordmark.mjs draws it).
 *  Every opaque pixel is exactly WORDMARK_HEX; the edges are antialiased alpha. */
export const WORDMARK_HEX = "#2E7BFF";
/** Six letters, one counter (the bowl of the R). */
export const WORDMARK_SHAPES = 6;
export const WORDMARK_HOLES = 1;

export function loadWordmark(): { width: number; height: number; data: Uint8ClampedArray } {
  const here = dirname(fileURLToPath(import.meta.url));
  const png = PNG.sync.read(readFileSync(join(here, "fixtures", "wordmark.png")));
  return { width: png.width, height: png.height, data: png.data as unknown as Uint8ClampedArray };
}
