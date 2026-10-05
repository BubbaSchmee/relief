/** Supersampled render -> one output frame with STRAIGHT alpha, ready for any
 *  transparent video or image format.
 *
 *  Edges are antialiased by rendering at `ss` times the size and averaging.
 *  The average is taken in PREMULTIPLIED space and then unpremultiplied: an
 *  edge pixel half covered by #FF2E9A comes out #FF2E9A at alpha 128. Averaging
 *  straight RGB against the transparent black background instead gives
 *  #801749 at alpha 128 — the dark fringe that rings a logo on every overlay.
 *  PNG, ProRes 4444 and VP9-alpha all store straight alpha, so that is what
 *  this returns.
 *
 *  Input rows are bottom-up (as gl.readPixels returns them); output rows are
 *  top-down (as every image and video format stores them). */
export function resolveFrame(src: Uint8Array | Uint8ClampedArray, w: number, h: number, ss: number): Uint8ClampedArray {
  const W = w * ss;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy0 = (h - 1 - y) * ss; // bottom-up source block for top-down row y
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let j = 0; j < ss; j++) {
        let p = ((sy0 + j) * W + x * ss) * 4;
        for (let i = 0; i < ss; i++, p += 4) {
          const al = src[p + 3];
          r += src[p] * al;
          g += src[p + 1] * al;
          b += src[p + 2] * al;
          a += al;
        }
      }
      const o = (y * w + x) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round(a / (ss * ss));
    }
  }
  return out;
}
