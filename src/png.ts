/** Minimal PNG encoder: RGBA8, straight (non-premultiplied) alpha, filter 0.
 *  Pure: Node and browser, no canvas. A canvas round trip would premultiply and
 *  re-quantise the frame; this writes exactly the bytes it is given.
 *  Used for the PNG-sequence export and as ProRes's input frames. */
import { zlibSync } from "fflate";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array, crc = 0): number {
  let c = ~crc;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return ~c >>> 0;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  // the CRC covers the type and the data, not the length
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** `level` is zlib's 0..9; 6 for files people keep, 1 for transient frames. */
export function encodePng(rgba: Uint8Array | Uint8ClampedArray, w: number, h: number, level: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 = 6): Uint8Array {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) throw new Error(`RELIEF: bad PNG size ${w}x${h}`);
  if (rgba.length !== w * h * 4) throw new Error(`RELIEF: PNG pixel buffer is ${rgba.length} bytes, expected ${w * h * 4}`);
  const stride = w * 4;
  const raw = new Uint8Array(h * (stride + 1)); // each row: filter byte 0 (none), then the pixels
  for (let y = 0; y < h; y++) raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);

  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, w);
  v.setUint32(4, h);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // compression 0, filter 0, interlace 0 stay zero

  const parts = [new Uint8Array(SIGNATURE), chunk("IHDR", ihdr), chunk("IDAT", zlibSync(raw, { level })), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
