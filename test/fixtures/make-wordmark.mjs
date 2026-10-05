/** Regenerates test/fixtures/wordmark.png: the word RELIEF in six bold, blocky
 *  letters, one flat colour (#2E7BFF) on a transparent background, 600x200.
 *  Drawn from rectangles, circles and one polygon, so it needs no font and
 *  nothing in it belongs to anyone. Antialiased edges keep the SAME RGB with a
 *  partial alpha (straight alpha), as a real exported logo does.
 *
 *    node test/fixtures/make-wordmark.mjs
 *
 *  The PNG is committed; this script documents where it came from. */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const W = 600, H = 200;
const COLOUR = [0x2e, 0x7b, 0xff];
const LH = 124, S = 24; // letter height, stroke
const GAP = 20, TOP = 38;

// each letter: width, shapes to add, shapes to cut (counters). Coordinates are
// relative to the letter's top-left corner.
const rect = (x0, y0, x1, y1) => (x, y) => x >= x0 && x < x1 && y >= y0 && y < y1;
const disc = (cx, cy, r) => (x, y) => (x - cx) ** 2 + (y - cy) ** 2 < r * r;
const poly = (pts) => (x, y) => {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
const midBar = (w) => rect(0, (LH - S) / 2, w, (LH + S) / 2);

const LETTERS = [
  { w: 86, add: [rect(0, 0, S, LH), rect(0, 0, 52, 78), disc(52, 39, 39), poly([[34, 70], [62, 70], [86, LH], [58, LH]])], cut: [rect(S, S, 52, 78 - S), disc(52, 39, 39 - S)] }, // R, one counter
  { w: 70, add: [rect(0, 0, S, LH), rect(0, 0, 70, S), midBar(60), rect(0, LH - S, 70, LH)], cut: [] }, // E
  { w: 64, add: [rect(0, 0, S, LH), rect(0, LH - S, 64, LH)], cut: [] }, // L
  { w: 28, add: [rect(0, 0, 28, LH)], cut: [] }, // I
  { w: 70, add: [rect(0, 0, S, LH), rect(0, 0, 70, S), midBar(60), rect(0, LH - S, 70, LH)], cut: [] }, // E
  { w: 66, add: [rect(0, 0, S, LH), rect(0, 0, 66, S), midBar(56)], cut: [] }, // F
];

const total = LETTERS.reduce((n, l) => n + l.w, 0) + GAP * (LETTERS.length - 1);
let ox = Math.round((W - total) / 2);
const placed = LETTERS.map((l) => {
  const p = { ...l, ox };
  ox += l.w + GAP;
  return p;
});

const SS = 8; // 8x8 samples per pixel
const png = new PNG({ width: W, height: H });
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++) {
    let hit = 0;
    for (let j = 0; j < SS; j++)
      for (let i = 0; i < SS; i++) {
        const px = x + (i + 0.5) / SS, py = y + (j + 0.5) / SS;
        for (const l of placed) {
          const lx = px - l.ox, ly = py - TOP;
          if (l.add.some((f) => f(lx, ly)) && !l.cut.some((f) => f(lx, ly))) { hit++; break; }
        }
      }
    const a = Math.round((hit / (SS * SS)) * 255);
    const o = (y * W + x) * 4;
    if (a > 0) png.data.set([...COLOUR, a], o); // transparent pixels stay 0,0,0,0
  }

const out = join(dirname(fileURLToPath(import.meta.url)), "wordmark.png");
writeFileSync(out, PNG.sync.write(png));
console.log("wrote test/fixtures/wordmark.png");
