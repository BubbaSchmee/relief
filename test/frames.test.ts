import { describe, expect, it } from "vitest";
import { resolveFrame } from "../src/frames.js";

/** ss x ss block per output pixel; `fill(sx, sy)` gives RGBA for a source
 *  texel, with sy counted bottom-up like gl.readPixels. */
function source(w: number, h: number, ss: number, fill: (sx: number, sy: number) => number[]): Uint8Array {
  const W = w * ss, H = h * ss, out = new Uint8Array(W * H * 4);
  for (let sy = 0; sy < H; sy++) for (let sx = 0; sx < W; sx++) out.set(fill(sx, sy), (sy * W + sx) * 4);
  return out;
}

const PINK = [0xff, 0x2e, 0x9a, 255];
const CLEAR = [0, 0, 0, 0];

describe("resolveFrame", () => {
  it("a half-covered edge pixel keeps the exact colour: no dark fringe", () => {
    // 1x1 output, 2x supersample: left half pink, right half transparent
    const out = resolveFrame(source(1, 1, 2, (sx) => (sx === 0 ? PINK : CLEAR)), 1, 1, 2);
    expect([...out]).toEqual([0xff, 0x2e, 0x9a, 128]);
  });

  it("fully opaque and fully transparent pixels pass through", () => {
    expect([...resolveFrame(source(1, 1, 3, () => PINK), 1, 1, 3)]).toEqual(PINK);
    expect([...resolveFrame(source(1, 1, 3, () => CLEAR), 1, 1, 3)]).toEqual(CLEAR);
  });

  it("flips bottom-up GL rows to top-down image rows", () => {
    // 1x2 output, ss 1: the BOTTOM source row is pink -> the BOTTOM output row is pink
    const out = resolveFrame(source(1, 2, 1, (_x, sy) => (sy === 0 ? PINK : CLEAR)), 1, 2, 1);
    expect([...out.slice(0, 4)]).toEqual(CLEAR); // top
    expect([...out.slice(4, 8)]).toEqual(PINK); // bottom
  });
});
