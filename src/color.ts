/** Colour, exactly.
 *
 *  glTF 2.0 is asymmetric and that is where every "my colours changed" bug
 *  lives: baseColorFactor is LINEAR, baseColorTexture texels are sRGB, and any
 *  embedded ICC/gamma chunk must be IGNORED — the material alone defines the
 *  transfer function. See docs/DESIGN.md §6. */

export interface RGB {
  r: number;
  g: number;
  b: number;
}

const HEX = /^#?([0-9a-fA-F]{6})$/;

/** "#RRGGBB" -> 0..255 channels. Throws on anything else: a logo's colour is a
 *  brand fact, so a malformed one is a bug to surface, not a value to guess. */
export function parseHex(hex: string): RGB {
  const m = HEX.exec(hex.trim());
  if (!m) throw new Error(`RELIEF: not a #RRGGBB colour: ${JSON.stringify(hex)}`);
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function toHex({ r, g, b }: RGB): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`.toUpperCase();
}

/** The EXACT piecewise sRGB EOTF. Not pow(x, 2.2) — the approximation is where
 *  the last delta-E hides, and this pipeline's whole promise is that there is
 *  no last delta-E. */
export function srgbToLinear(u8: number): number {
  const c = u8 / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(v: number): number {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, c * 255));
}

/** What goes in glTF baseColorFactor: linear, alpha 1. */
export function hexToBaseColorFactor(hex: string): [number, number, number, number] {
  const { r, g, b } = parseHex(hex);
  return [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b), 1];
}

// ---------------------------------------------------------------- CIELAB
export interface Lab {
  L: number;
  a: number;
  b: number;
}

/** sRGB (0..255) -> CIELAB, D65. */
export function rgbToLab({ r, g, b }: RGB): Lab {
  const R = srgbToLinear(r);
  const G = srgbToLinear(g);
  const B = srgbToLinear(b);
  let X = (R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / 0.95047;
  let Y = R * 0.2126729 + G * 0.7151522 + B * 0.072175;
  let Z = (R * 0.0193339 + G * 0.119192 + B * 0.9503041) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
  X = f(X);
  Y = f(Y);
  Z = f(Z);
  return { L: 116 * Y - 16, a: 500 * (X - Y), b: 200 * (Y - Z) };
}

/** CIEDE2000. The gate metric: dE 1.0 is the just-noticeable threshold, dE 3 is
 *  visibly wrong. Implemented from Sharma, Wu & Dalal (2005). */
export function deltaE2000(c1: Lab, c2: Lab): number {
  const rad = Math.PI / 180;
  const deg = 180 / Math.PI;
  const C1 = Math.hypot(c1.a, c1.b);
  const C2 = Math.hypot(c2.a, c2.b);
  const Cbar = (C1 + C2) / 2;
  const C7 = Math.pow(Cbar, 7);
  const G = 0.5 * (1 - Math.sqrt(C7 / (C7 + Math.pow(25, 7))));
  const a1p = (1 + G) * c1.a;
  const a2p = (1 + G) * c2.a;
  const C1p = Math.hypot(a1p, c1.b);
  const C2p = Math.hypot(a2p, c2.b);
  const h = (a: number, b: number) => {
    if (a === 0 && b === 0) return 0;
    const d = Math.atan2(b, a) * deg;
    return d >= 0 ? d : d + 360;
  };
  const h1p = h(a1p, c1.b);
  const h2p = h(a2p, c2.b);

  const dLp = c2.L - c1.L;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * rad);

  const Lbarp = (c1.L + c2.L) / 2;
  const Cbarp = (C1p + C2p) / 2;
  let hbarp = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) > 180) hbarp += h1p + h2p < 360 ? 360 : -360;
    hbarp /= 2;
  } else {
    hbarp = h1p + h2p;
  }

  const T =
    1 -
    0.17 * Math.cos((hbarp - 30) * rad) +
    0.24 * Math.cos(2 * hbarp * rad) +
    0.32 * Math.cos((3 * hbarp + 6) * rad) -
    0.2 * Math.cos((4 * hbarp - 63) * rad);
  const dTheta = 30 * Math.exp(-Math.pow((hbarp - 275) / 25, 2));
  const Cbarp7 = Math.pow(Cbarp, 7);
  const RC = 2 * Math.sqrt(Cbarp7 / (Cbarp7 + Math.pow(25, 7)));
  const L50 = Math.pow(Lbarp - 50, 2);
  const SL = 1 + (0.015 * L50) / Math.sqrt(20 + L50);
  const SC = 1 + 0.045 * Cbarp;
  const SH = 1 + 0.015 * Cbarp * T;
  const RT = -Math.sin(2 * dTheta * rad) * RC;

  return Math.sqrt(
    Math.pow(dLp / SL, 2) + Math.pow(dCp / SC, 2) + Math.pow(dHp / SH, 2) + RT * (dCp / SC) * (dHp / SH),
  );
}

/** Convenience: delta-E 2000 between two #RRGGBB strings. */
export function hexDeltaE(a: string, b: string): number {
  return deltaE2000(rgbToLab(parseHex(a)), rgbToLab(parseHex(b)));
}
