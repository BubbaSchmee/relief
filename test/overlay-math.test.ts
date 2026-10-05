import { describe, expect, it } from "vitest";
import { deltaE2000, parseHex, rgbToLab } from "../src/color.js";
import { studio, studioMatcap } from "../src/matcap.js";
import { rgbaToI420A } from "../src/yuv.js";

/** w x h image of one RGBA value. */
const flat = (w: number, h: number, px: number[]) => Uint8Array.from({ length: w * h * 4 }, (_, i) => px[i % 4]);
const clamp8 = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

/** BT.709 limited range back to RGB: the inverse of what the encoder promises. */
function decodePixel(yuv: Uint8Array, w: number, h: number, x: number, y: number) {
  const cw = w / 2, U = w * h, V = U + cw * (h / 2);
  const Y = (yuv[y * w + x] - 16) / (219 / 255);
  const cb = (yuv[U + (y >> 1) * cw + (x >> 1)] - 128) / (224 / 255);
  const cr = (yuv[V + (y >> 1) * cw + (x >> 1)] - 128) / (224 / 255);
  const r = Y + 1.5748 * cr, b = Y + 1.8556 * cb;
  const g = (Y - 0.2126 * r - 0.0722 * b) / 0.7152;
  return { r: clamp8(r), g: clamp8(g), b: clamp8(b) };
}

describe("rgbaToI420A (BT.709, limited range)", () => {
  it("has the known BT.709 limited values for white, black and red", () => {
    const at = (px: number[]) => {
      const o = rgbaToI420A(flat(2, 2, px), 2, 2);
      return [o[0], o[4], o[5], o[6]]; // Y, U, V, A
    };
    expect(at([255, 255, 255, 255])).toEqual([235, 128, 128, 255]);
    expect(at([0, 0, 0, 255])).toEqual([16, 128, 128, 255]);
    expect(at([255, 0, 0, 255])).toEqual([63, 102, 240, 255]);
  });

  it("lays out Y, U, V and a full-resolution A plane", () => {
    const o = rgbaToI420A(flat(4, 2, [10, 20, 30, 77]), 4, 2);
    expect(o.length).toBe(4 * 2 + 2 * 1 * 2 + 4 * 2);
    expect([...o.slice(8 + 4, 8 + 4 + 8)]).toEqual(Array(8).fill(77)); // A plane starts after Y + U + V
  });

  it("a flat brand colour survives the round trip within a JND", () => {
    const { r, g, b } = parseHex("#FF2E9A");
    const o = rgbaToI420A(flat(8, 8, [r, g, b, 255]), 8, 8);
    const back = decodePixel(o, 8, 8, 3, 3);
    expect(deltaE2000(rgbToLab({ r, g, b }), rgbToLab(back))).toBeLessThan(1);
  });

  it("chroma ignores transparent neighbours: an edge block keeps the visible colour", () => {
    const { r, g, b } = parseHex("#FF2E9A");
    // one opaque pixel and three transparent BLACK ones in a 2x2 block
    const edge = flat(2, 2, [0, 0, 0, 0]);
    edge.set([r, g, b, 255], 0);
    const solid = rgbaToI420A(flat(2, 2, [r, g, b, 255]), 2, 2);
    const o = rgbaToI420A(edge, 2, 2);
    expect([o[4], o[5]]).toEqual([solid[4], solid[5]]); // same U and V as a solid pink block
  });

  it("a fully transparent block has neutral chroma", () => {
    const o = rgbaToI420A(flat(2, 2, [200, 10, 10, 0]), 2, 2);
    expect([o[4], o[5]]).toEqual([128, 128]);
  });

  it("refuses odd sizes and mismatched buffers", () => {
    expect(() => rgbaToI420A(new Uint8Array(3 * 2 * 4), 3, 2)).toThrow(/even/);
    expect(() => rgbaToI420A(new Uint8Array(7), 2, 2)).toThrow(/expected 16/);
  });
});

describe("studioMatcap", () => {
  const N = 128;
  const m = studioMatcap(N);
  const lum = (x: number, y: number) => {
    // (x, y) in -1..1, y up; row 0 is the bottom
    const i = Math.min(N - 1, Math.floor(((x + 1) / 2) * N)), j = Math.min(N - 1, Math.floor(((y + 1) / 2) * N));
    const o = (j * N + i) * 4;
    return m[o] + m[o + 1] + m[o + 2];
  };

  it("is deterministic, opaque, and the right size", () => {
    expect(m.length).toBe(N * N * 4);
    expect(Buffer.compare(Buffer.from(m), Buffer.from(studioMatcap(N)))).toBe(0);
    for (let i = 3; i < m.length; i += 4) expect(m[i]).toBe(255);
  });

  it("has a bright key softbox left of centre that the lower right lacks", () => {
    expect(lum(-0.27, 0.14)).toBeGreaterThan(700); // near white
    expect(lum(0.5, -0.5)).toBeLessThan(300); // the dark floor
  });

  it("is a studio, not a white ball: the face-on centre is mid-dark", () => {
    expect(lum(0, 0)).toBeLessThan(300);
  });

  it("the rim ring catches the back light, and the table is bounded 0..1", () => {
    expect(studio([0, 0, 1])).toBeLessThan(0.1);
    expect(studio([-0.3, 0.35, -0.89])).toBeGreaterThan(0.8);
  });
});
