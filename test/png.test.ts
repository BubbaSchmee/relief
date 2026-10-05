import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import { crc32, encodePng } from "../src/png.js";

/** Deterministic pseudo-random bytes (no Math.random: a failure must reproduce). */
function noise(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = s >>> 24;
  }
  return out;
}

describe("crc32", () => {
  it("matches the standard check value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });
});

describe("encodePng", () => {
  for (const [w, h] of [[1, 1], [7, 5], [64, 33], [255, 2]] as const) {
    it(`${w}x${h}: decodes byte-identical, including RGB under alpha 0`, () => {
      const px = noise(w * h * 4, w * 31 + h);
      // straight alpha: a transparent pixel may carry any RGB and must keep it
      for (let i = 0; i < w * h; i += 3) px[i * 4 + 3] = 0;
      const back = PNG.sync.read(Buffer.from(encodePng(px, w, h)));
      expect(back.width).toBe(w);
      expect(back.height).toBe(h);
      expect(Buffer.compare(Buffer.from(back.data), Buffer.from(px))).toBe(0);
    });
  }

  it("every zlib level decodes to the same pixels", () => {
    const px = noise(40 * 30 * 4, 9);
    for (const level of [0, 1, 6, 9] as const) {
      const back = PNG.sync.read(Buffer.from(encodePng(px, 40, 30, level)));
      expect(Buffer.compare(Buffer.from(back.data), Buffer.from(px))).toBe(0);
    }
  });

  it("is deterministic and accepts a Uint8ClampedArray", () => {
    const px = noise(16 * 16 * 4, 3);
    const a = encodePng(px, 16, 16);
    const b = encodePng(new Uint8ClampedArray(px), 16, 16);
    expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).toBe(0);
  });

  it("refuses a buffer that does not match the size", () => {
    expect(() => encodePng(new Uint8Array(15), 2, 2)).toThrow(/expected 16/);
    expect(() => encodePng(new Uint8Array(0), 0, 0)).toThrow(/bad PNG size/);
  });
});
