/** Straight RGBA -> planar I420A, BT.709, limited range. The WebM path does this
 *  itself instead of handing the browser an RGBA frame, because browsers
 *  disagree about the matrix: Chrome converted our canvas frames with BT.601
 *  (tagged smpte170m), Firefox with BT.709 (verified 2026-10-04). Doing it here
 *  makes the bytes and the tag agree everywhere.
 *
 *  4:2:0 chroma is averaged WEIGHTED BY ALPHA. A plain 2x2 average would blend
 *  the black that sits under transparent pixels into every edge pixel's colour
 *  and dull the whole outline; weighted, a block's colour is that of the pixels
 *  that are actually there. Alpha itself stays full resolution, in its own plane.
 *
 *  Layout: Y (w*h), U ((w/2)*(h/2)), V (same), A (w*h) — the 'I420A' VideoFrame
 *  layout. Rows are top-down, as in every image and video. Width and height
 *  must be even. */
export function rgbaToI420A(rgba: Uint8Array | Uint8ClampedArray, w: number, h: number): Uint8Array {
  if (w % 2 || h % 2) throw new Error(`RELIEF: I420A needs even dimensions, got ${w}x${h}`);
  if (rgba.length !== w * h * 4) throw new Error(`RELIEF: RGBA buffer is ${rgba.length} bytes, expected ${w * h * 4}`);
  const cw = w / 2, ch = h / 2;
  const out = new Uint8Array(w * h * 2 + cw * ch * 2);
  const U = w * h, V = U + cw * ch, A = V + cw * ch;

  // Limited range: Y in 16..235 (219 steps), Cb/Cr in 16..240 (224 steps, 128 = neutral).
  const ky = 219 / 255, kc = 224 / 255;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
      out[y * w + x] = Math.round(16 + ky * (0.2126 * r + 0.7152 * g + 0.0722 * b));
      out[A + y * w + x] = rgba[p + 3];
    }
  for (let y = 0; y < ch; y++)
    for (let x = 0; x < cw; x++) {
      let wsum = 0, cb = 0, cr = 0;
      for (let j = 0; j < 2; j++)
        for (let i = 0; i < 2; i++) {
          const p = ((2 * y + j) * w + 2 * x + i) * 4;
          const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2], a = rgba[p + 3];
          const yf = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          wsum += a;
          cb += a * (b - yf);
          cr += a * (r - yf);
        }
      const o = y * cw + x;
      // a block with no visible pixel has no colour to keep: neutral chroma
      out[U + o] = wsum > 0 ? Math.round(128 + (kc / 1.8556) * (cb / wsum)) : 128;
      out[V + o] = wsum > 0 ? Math.round(128 + (kc / 1.5748) * (cr / wsum)) : 128;
    }
  return out;
}
