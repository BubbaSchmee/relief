/** RELIEF core types. Coordinates in a Region are SOURCE space, y-DOWN — the
 *  convention `traceAlpha` emits and every raster tracer naturally produces.
 *  Normalization to model space (y-up, centred, width 2) happens once inside
 *  buildMesh across ALL regions together, so layered regions stay registered. */

export interface Region {
  /** "#RRGGBB" — the exact source colour. Never re-derived, never averaged. */
  hex: string;
  /** Flat [x0,y0,x1,y1,...]; closed implicitly. Source space, y-down. */
  outer: number[];
  /** Interior holes (counters), same format. */
  holes: number[][];
  /** How far the FRONT is raised along +z, in model units. 0 = base plane. The
   *  back stays at -extrude/2, so depth makes the region a taller solid.
   *  layers.ts sets it from containment (level * layerStep). */
  depth?: number;
}

export type BevelCurve = "chamfer" | "round" | "ogee" | "step";

/** The height of the front surface above the base plane, as a function of the
 *  distance d to the region edge and the LOCAL half-width R of the stroke there:
 *
 *    z(d) = D/2 + bevelHeight * bevel(d / bevelWidth) + inflate * R * arc(d / R)
 *
 *  bevelWidth is ABSOLUTE, so a hairline gets the same crisp edge as a heavy
 *  stroke. Inflation is the professional "Inflate" (Illustrator, Spline,
 *  Teddy): a quarter-circle cross-section scaled to each stroke's own width —
 *  vertical at the rim, FLAT at the stroke's centre line, so no stroke creases
 *  down its middle and a logo of mixed weights reads as one material.
 *  See docs/DESIGN.md §5. */
export interface Profile {
  /** Total front-to-back thickness. */
  extrude: number;
  /** Absolute width of the bevel band, in model units (logo width = 2). */
  bevelWidth: number;
  /** How far the bevel lifts the surface over that band. */
  bevelHeight: number;
  bevelCurve: BevelCurve;
  /** Loft steps across the band. 1 = a flat chamfer regardless of curve. */
  bevelSteps: number;
  /** Inflation: how high each stroke rises, as a fraction of its own local
   *  half-width. 0 = a cleanly bevelled prism; 1 = a full half-round tube. */
  inflate: number;
}

export interface Tessellation {
  /** Longest permitted edge on the front interior, in model units. */
  maxEdge: number;
  /** Interior triangle budget for the WHOLE logo, shared across regions by
   *  area. The back mirrors the interior, so total output is roughly double
   *  this plus the bevel bands and walls. */
  triangleCap: number;
}

export interface BuildOptions {
  profile: Profile;
  tessellation: Tessellation;
  /** Source raster size, for UVs that map back onto the original image. Defaults
   *  to the bounding box of all regions. */
  source?: { width: number; height: number };
  /** Side-wall normals are smoothed across a vertex unless the turn is sharper
   *  than this: curves shade as curves, a wordmark's spikes stay razor-edged. */
  creaseDeg?: number;
}

/** Which surface a vertex belongs to. Front AND Bevel carry the brand colour —
 *  the bevel is the edge of the face, not a side. Side and Back are free to be
 *  metal. Bevel stays a distinct kind so a renderer can still light it
 *  differently (a matcap highlight can sweep along exactly this band).
 *
 *  A plain object rather than a `const enum`: consumers compiling with
 *  `erasableSyntaxOnly` reject enums, and const enums do not
 *  survive per-file transpilation (Vite, esbuild) across module boundaries. */
export const FaceKind = { Front: 0, Bevel: 1, Side: 2, Back: 3 } as const;
export type FaceKind = (typeof FaceKind)[keyof typeof FaceKind];

export interface Mesh {
  positions: Float32Array; // xyz
  normals: Float32Array; // xyz
  uvs: Float32Array; // uv, in source texture space
  faceKind: Uint8Array; // per vertex, FaceKind
  regionIndex: Uint16Array; // per vertex
  indices: Uint32Array;
  /** Per-region exact source colour, index-aligned with regionIndex. */
  regionHex: string[];
}

export const DEFAULT_PROFILE: Profile = {
  extrude: 0.2,
  // Wider bands eat the face: a nominal 0.035 covered 43% of a five-letter
  // wordmark's front in testing. Keep it a crisp edge.
  bevelWidth: 0.012,
  bevelHeight: 0.01,
  bevelCurve: "round",
  bevelSteps: 3,
  inflate: 0.5,
};

export const DEFAULT_TESSELLATION: Tessellation = {
  maxEdge: 0.05,
  triangleCap: 20000,
};
