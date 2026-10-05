/** SVG -> Regions (P3). The caller supplies a parsed DOM (DOMParser in the
 *  browser, happy-dom in tests), so this file has no browser dependency.
 *
 *  Space: the root viewBox's user space, translated so the viewBox origin is
 *  (0,0), y-DOWN — exactly Region's source space. Everything the pipeline cannot
 *  represent is REFUSED with a warning, never silently mangled: the one thing
 *  this tool promises is that the colours and outlines it keeps are exact.
 *
 *  Curves are flattened here, by us, at a fixed tolerance (0.1% of the larger
 *  viewBox side) — deterministic, no randomness, no renderer in the loop.
 *  svgpath only NORMALISES path syntax (abs/unarc/unshort); its output is
 *  M L H V C Q Z, which flatten() turns into rings. */
import svgpath from "svgpath";
import { toHex } from "./color.js";
import { isSimple, pointInRing, signedArea } from "./geom.js";
import type { Region } from "./types.js";

export interface SvgResult {
  regions: Region[];
  warnings: string[];
  width: number;
  height: number;
}

// ---------------------------------------------------------------- numbers + transforms
type Matrix = [number, number, number, number, number, number]; // a b c d e f
const NUM = /[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi;
const nums = (s: string) => (s.match(NUM) ?? []).map(Number);

/** parent x child: the child's coordinates are mapped by the child first. */
const mulM = (p: Matrix, c: Matrix): Matrix => [
  p[0] * c[0] + p[2] * c[1], p[1] * c[0] + p[3] * c[1],
  p[0] * c[2] + p[2] * c[3], p[1] * c[2] + p[3] * c[3],
  p[0] * c[4] + p[2] * c[5] + p[4], p[1] * c[4] + p[3] * c[5] + p[5],
];

function parseTransform(s: string, warn: (m: string) => void): Matrix {
  let m: Matrix = [1, 0, 0, 1, 0, 0];
  for (const [, fn, args] of s.matchAll(/([a-zA-Z]+)\s*\(([^)]*)\)/g)) {
    const a = nums(args);
    const r = (a[0] * Math.PI) / 180;
    const [c, sn] = [Math.cos(r), Math.sin(r)];
    const t: Matrix | undefined =
      fn === "matrix" ? (a as Matrix) :
      fn === "translate" ? [1, 0, 0, 1, a[0], a[1] ?? 0] :
      fn === "scale" ? [a[0], 0, 0, a[1] ?? a[0], 0, 0] :
      fn === "rotate" ? [c, sn, -sn, c, (a[1] ?? 0) - c * (a[1] ?? 0) + sn * (a[2] ?? 0), (a[2] ?? 0) - sn * (a[1] ?? 0) - c * (a[2] ?? 0)] :
      fn === "skewX" ? [1, 0, Math.tan(r), 1, 0, 0] :
      fn === "skewY" ? [1, Math.tan(r), 0, 1, 0, 0] : undefined;
    if (!t || t.length !== 6 || !t.every(Number.isFinite)) warn(`Transform "${fn}(${args.trim()})" is invalid or unsupported and was ignored.`);
    else m = mulM(m, t);
  }
  return m;
}

// ---------------------------------------------------------------- colour
const NAMED: Record<string, string> = {
  black: "000000", silver: "c0c0c0", gray: "808080", grey: "808080", white: "ffffff", maroon: "800000", red: "ff0000",
  purple: "800080", fuchsia: "ff00ff", magenta: "ff00ff", green: "008000", lime: "00ff00", olive: "808000",
  yellow: "ffff00", navy: "000080", blue: "0000ff", teal: "008080", aqua: "00ffff", cyan: "00ffff", orange: "ffa500",
};

/** #rgb | #rrggbb | rgb()/rgba() | named. null = not a colour we can honour. */
function parseColor(v: string): { hex: string; a: number } | null {
  v = v.trim().toLowerCase();
  let h = NAMED[v] ?? (/^#[0-9a-f]{3}$/.test(v) ? [...v.slice(1)].map((c) => c + c).join("") : /^#[0-9a-f]{6}$/.test(v) ? v.slice(1) : "");
  if (h) return { hex: toHex({ r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4), 16) }), a: 1 };
  const m = /^rgba?\(([^)]*)\)$/.exec(v);
  if (!m) return null;
  const p = m[1].trim().split(/[\s,/]+/);
  if (p.length < 3) return null;
  const ch = p.slice(0, 3).map((x) => (x.endsWith("%") ? parseFloat(x) * 2.55 : parseFloat(x)));
  const a = p[3] === undefined ? 1 : p[3].endsWith("%") ? parseFloat(p[3]) / 100 : parseFloat(p[3]);
  return ch.every(Number.isFinite) && Number.isFinite(a) ? { hex: toHex({ r: ch[0], g: ch[1], b: ch[2] }), a } : null;
}

// ---------------------------------------------------------------- style cascade
type Style = Record<string, string>;
const PROPS = ["fill", "fill-opacity", "fill-rule", "clip-rule", "color", "visibility", "stroke", "opacity", "display", "clip-path", "mask", "filter"];
const INHERITED = new Set(["fill", "fill-opacity", "fill-rule", "clip-rule", "color", "visibility", "stroke"]);

const decls = (text: string): Style => {
  const o: Style = {};
  for (const part of text.split(";")) {
    const i = part.indexOf(":");
    if (i < 0) continue;
    const k = part.slice(0, i).trim().toLowerCase();
    const v = part.slice(i + 1).replace(/!important/i, "").trim();
    if (k && v && v.toLowerCase() !== "inherit") o[k] = v;
  }
  return o;
};

interface Rule { tag?: string; cls: string[]; id?: string; decls: Style }

/** <style> sheets: simple selectors only (tag, .class, #id, and combinations).
 *  Illustrator and Affinity export every colour as `.cls-1{fill:#...}`, so
 *  ignoring sheets would turn a coloured logo black without a word. */
function parseSheet(doc: Document, warn: (m: string) => void): Rule[] {
  const rules: (Rule & { spec: number })[] = [];
  for (const el of Array.from(doc.getElementsByTagName("style"))) {
    const text = (el.textContent ?? "").replace(/\/\*[\s\S]*?\*\//g, "");
    if (text.includes("@")) warn("CSS @-rules in <style> are not supported and were ignored; colours may be wrong.");
    for (const [, sels, body] of text.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
      for (const s of sels.split(",")) {
        const m = /^(\*|[\w-]+)?((?:[.#][\w-]+)*)$/.exec(s.trim());
        if (!m || (!m[1] && !m[2])) { warn(`CSS selector "${s.trim()}" is not supported and was ignored; colours may be wrong.`); continue; }
        const parts = m[2].match(/[.#][\w-]+/g) ?? [];
        const cls = parts.filter((p) => p[0] === ".").map((p) => p.slice(1));
        const id = parts.find((p) => p[0] === "#")?.slice(1);
        rules.push({ tag: m[1], cls, id, decls: decls(body), spec: (id ? 100 : 0) + cls.length * 10 + (m[1] && m[1] !== "*" ? 1 : 0) });
      }
    }
  }
  return rules.sort((a, b) => a.spec - b.spec); // stable: source order breaks ties
}

// ---------------------------------------------------------------- paths -> rings
const dist = (px: number, py: number, ax: number, ay: number, bx: number, by: number) => {
  const dx = bx - ax, dy = by - ay;
  const L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};

/** Adaptive de Casteljau. Both control points within tol of the chord means the
 *  whole curve is (it lies in their convex hull), so the bound is real, not a
 *  guess. Depth-capped so a pathological curve cannot loop. Pushes endpoint. */
function cubic(o: number[], x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, tol: number, depth = 0): void {
  if (depth >= 16 || (dist(x1, y1, x0, y0, x3, y3) <= tol && dist(x2, y2, x0, y0, x3, y3) <= tol)) {
    o.push(x3, y3);
    return;
  }
  const x01 = (x0 + x1) / 2, y01 = (y0 + y1) / 2, x12 = (x1 + x2) / 2, y12 = (y1 + y2) / 2, x23 = (x2 + x3) / 2, y23 = (y2 + y3) / 2;
  const xa = (x01 + x12) / 2, ya = (y01 + y12) / 2, xb = (x12 + x23) / 2, yb = (y12 + y23) / 2;
  const xm = (xa + xb) / 2, ym = (ya + yb) / 2;
  cubic(o, x0, y0, x01, y01, xa, ya, xm, ym, tol, depth + 1);
  cubic(o, xm, ym, xb, yb, x23, y23, x3, y3, tol, depth + 1);
}

/** Tidy a flattened ring so the mesher sees clean input. Drops points closer
 *  than `gap` to their predecessor (microscopic edges become slivers and zero-
 *  area triangles), and points that are collinear to within float noise.
 *  The second matters: buildMesh's dedupeCollinear tests cross === 0 EXACTLY,
 *  and a curve's inflection point comes out ~1e-14 off a straight line, so it
 *  survives there, is then dropped by earcut's differently-rounded test, and the
 *  seam it anchored opens. Dropping it here (deviation < 1e-7 of the edge
 *  length) keeps every ring this file emits away from that cliff. */
function clean(r: number[], gap: number): number[] | null {
  const flat = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) => {
    const ux = bx - ax, uy = by - ay, vx = cx - bx, vy = cy - by;
    return Math.abs(ux * vy - uy * vx) <= 1e-7 * Math.hypot(ux, uy) * Math.hypot(vx, vy) && ux * vx + uy * vy > 0;
  };
  const o: number[] = [];
  for (let i = 0; i < r.length; i += 2) {
    if (o.length && Math.hypot(r[i] - o[o.length - 2], r[i + 1] - o[o.length - 1]) <= gap) continue;
    while (o.length >= 4 && flat(o[o.length - 4], o[o.length - 3], o[o.length - 2], o[o.length - 1], r[i], r[i + 1])) o.length -= 2;
    o.push(r[i], r[i + 1]);
  }
  // the seam: closing duplicate, then the first and last points against their cyclic neighbours
  while (o.length > 4 && Math.hypot(o[0] - o[o.length - 2], o[1] - o[o.length - 1]) <= gap) o.length -= 2;
  while (o.length >= 8 && flat(o[o.length - 4], o[o.length - 3], o[o.length - 2], o[o.length - 1], o[0], o[1])) o.length -= 2;
  while (o.length >= 8 && flat(o[o.length - 2], o[o.length - 1], o[0], o[1], o[2], o[3])) o.splice(0, 2);
  return o.length >= 6 && Math.abs(signedArea(o)) > 1e-12 + gap * gap ? o : null;
}

/** Path data -> closed rings in final (transformed) space. Fills close open
 *  subpaths implicitly, so a polyline-like path is a ring too. */
function pathRings(d: string, m: Matrix, tol: number, warn: (s: string) => void): number[][] {
  const p = svgpath(d);
  if ((p as unknown as { err: string }).err) warn("A path has malformed data; only the part before the error is used.");
  const segs: (string | number)[][] = [];
  p.abs().unarc().unshort().iterate((s) => { segs.push(s.slice()); });
  const T = (x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  const rings: number[][] = [];
  let ring = null as number[] | null;
  let cx = 0, cy = 0, sx = 0, sy = 0;
  const flush = () => {
    const r = ring && clean(ring, isFinite(tol) ? tol / 10 : 0);
    if (r) rings.push(r);
    ring = null;
  };
  for (const s of segs) {
    const c = s[0] as string;
    const v = s.slice(1) as number[];
    if (c === "M") { flush(); cx = sx = v[0]; cy = sy = v[1]; ring = [...T(cx, cy)]; continue; }
    if (c === "Z") { flush(); cx = sx; cy = sy; continue; }
    ring ??= [...T(cx, cy)]; // a segment straight after Z starts a new subpath at its start point
    const [x0, y0] = T(cx, cy);
    if (c === "L") { cx = v[0]; cy = v[1]; ring.push(...T(cx, cy)); }
    else if (c === "H") { cx = v[0]; ring.push(...T(cx, cy)); }
    else if (c === "V") { cy = v[0]; ring.push(...T(cx, cy)); }
    else if (c === "C") {
      const [x1, y1] = T(v[0], v[1]), [x2, y2] = T(v[2], v[3]), [x3, y3] = T(v[4], v[5]);
      cubic(ring, x0, y0, x1, y1, x2, y2, x3, y3, tol);
      cx = v[4]; cy = v[5];
    } else if (c === "Q") {
      const [qx, qy] = T(v[0], v[1]), [x3, y3] = T(v[2], v[3]);
      cubic(ring, x0, y0, x0 + ((qx - x0) * 2) / 3, y0 + ((qy - y0) * 2) / 3, x3 + ((qx - x3) * 2) / 3, y3 + ((qy - y3) * 2) / 3, x3, y3, tol);
      cx = v[2]; cy = v[3];
    }
  }
  flush();
  return rings;
}

// ---------------------------------------------------------------- rings -> regions
/** Winding number of ring r around (x,y). Positive shoelace area = +1. */
function winding(r: number[], x: number, y: number): number {
  let w = 0;
  for (let i = 0, n = r.length / 2, j = n - 1; i < n; j = i++) {
    const xa = r[j * 2], ya = r[j * 2 + 1], xb = r[i * 2], yb = r[i * 2 + 1];
    const side = (xb - xa) * (y - ya) - (x - xa) * (yb - ya);
    if (ya <= y) { if (yb > y && side > 0) w++; }
    else if (yb <= y && side < 0) w--;
  }
  return w;
}

const reverse = (r: number[]) => {
  const o: number[] = [];
  for (let i = r.length - 2; i >= 0; i -= 2) o.push(r[i], r[i + 1]);
  return o;
};

/** One element's rings -> filled outers with their holes. The fill rule is
 *  applied per RING at the edge: compare the winding number just inside the
 *  ring's longest edge with the one just outside it. Filled-in/empty-out is an
 *  outer; empty-in/filled-out is a hole; equal is a ring buried inside fill
 *  (nonzero, same direction) and drops out. That one test covers evenodd,
 *  nonzero, and a nonzero donut whose inner ring runs the other way.
 *
 *  ponytail: one edge decides each ring, so rings that cross each other or
 *  share an edge inside one element can misclassify. Real boolean union
 *  (Clipper2) is the upgrade path, alongside P4's layering. */
function group(rings: number[][], evenodd: boolean): { outer: number[]; holes: number[][] }[] {
  const filled = (w: number) => (evenodd ? w % 2 !== 0 : w !== 0);
  const total = (x: number, y: number) => rings.reduce((a, r) => a + winding(r, x, y), 0);
  const outers: number[][] = [];
  const holes: number[][] = [];
  for (const r of rings) {
    let best = 0, bi = 0;
    const n = r.length / 2;
    for (let i = 0; i < n; i++) {
      const L = Math.hypot(r[((i + 1) % n) * 2] - r[i * 2], r[((i + 1) % n) * 2 + 1] - r[i * 2 + 1]);
      if (L > best) { best = L; bi = i; }
    }
    const j = (bi + 1) % n;
    const dx = r[j * 2] - r[bi * 2], dy = r[j * 2 + 1] - r[bi * 2 + 1];
    const s = Math.sign(signedArea(r)); // positive area: the left normal points inward
    const eps = best * 1e-4;
    const mx = (r[bi * 2] + r[j * 2]) / 2, my = (r[bi * 2 + 1] + r[j * 2 + 1]) / 2;
    const nx = (-dy / best) * eps * s, ny = (dx / best) * eps * s;
    const inside = filled(total(mx + nx, my + ny));
    const outside = filled(total(mx - nx, my - ny));
    if (inside && !outside) outers.push(signedArea(r) > 0 ? r : reverse(r));
    else if (!inside && outside) holes.push(signedArea(r) < 0 ? r : reverse(r));
  }
  const out = outers.map((outer) => ({ outer, holes: [] as number[][] }));
  const area = outers.map((o) => Math.abs(signedArea(o)));
  for (const h of holes) {
    // a hole belongs to the SMALLEST outer containing it (an island inside a
    // hole is its own outer). Test vertices until one is clear of a boundary.
    let owner = -1;
    for (let v = 0; v < Math.min(h.length / 2, 8) && owner < 0; v++)
      outers.forEach((o, k) => { if (pointInRing(o, h[v * 2], h[v * 2 + 1]) && (owner < 0 || area[k] < area[owner])) owner = k; });
    if (owner >= 0) out[owner].holes.push(h);
  }
  return out;
}

// ---------------------------------------------------------------- document walk
const SKIP = new Set(["defs", "symbol", "clippath", "mask", "pattern", "marker", "lineargradient", "radialgradient", "filter", "metadata", "title", "desc", "style", "script"]);
const REFUSED: Record<string, string> = {
  text: "<text> is not supported: convert text to outlines in your editor.",
  use: "<use> is not supported and was skipped: expand clones and symbols in your editor.",
  image: "<image> is not supported and was skipped: only vector shapes are built.",
  foreignobject: "<foreignObject> is not supported and was skipped.",
};
const STROKE_ONLY = "Stroke-only shapes were skipped: convert strokes to outlines in your editor.";
const LEN = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*(?:px)?\s*$/i;

export function parseSvg(doc: Document): SvgResult {
  const root = doc.documentElement;
  const warnings = new Set<string>();
  const warn = (m: string) => void warnings.add(m);
  if (!root || root.localName.toLowerCase() !== "svg") return { regions: [], warnings: ["Not an SVG document."], width: 0, height: 0 };

  const sheet = parseSheet(doc, warn);
  const size = (n: string) => {
    const m = LEN.exec(root.getAttribute(n) ?? "");
    return m ? +m[1] : 0;
  };
  const vb = nums(root.getAttribute("viewBox") ?? "");
  let [vx, vy, width, height] = vb.length === 4 && vb[2] > 0 && vb[3] > 0 ? vb : [0, 0, size("width"), size("height")];
  const known = width > 0 && height > 0;

  /** One full walk. tol = Infinity keeps curve endpoints only: the cheap pass
   *  that sizes a viewBox-less SVG before the real tolerance is known. */
  const run = (tol: number): Region[] => {
    const regions: Region[] = [];

    const walk = (el: Element, parent: { m: Matrix; st: Style; faded: boolean }): void => {
      const tag = el.localName.toLowerCase();
      if (SKIP.has(tag)) return;
      const own: Style = {};
      for (const p of PROPS) { const v = el.getAttribute(p); if (v !== null) own[p] = v.trim(); }
      for (const r of sheet)
        if ((!r.tag || r.tag === "*" || r.tag === el.localName) && r.cls.every((c) => (el.getAttribute("class") ?? "").split(/\s+/).includes(c)) && (!r.id || el.getAttribute("id") === r.id))
          Object.assign(own, r.decls);
      Object.assign(own, decls(el.getAttribute("style") ?? ""));
      if (own.display?.toLowerCase() === "none") return;

      const st: Style = {};
      for (const p of PROPS) {
        const v = INHERITED.has(p) ? (own[p] ?? parent.st[p]) : own[p];
        if (v !== undefined) st[p] = v;
      }
      const opac = (v?: string) => (v === undefined ? 1 : parseFloat(v) / (v.trim().endsWith("%") ? 100 : 1));
      const faded = parent.faded || opac(own.opacity) < 1;
      for (const a of ["clip-path", "mask", "filter"])
        if (own[a] && own[a].toLowerCase() !== "none") warn(`${a} is not supported and was ignored: shapes are drawn without it.`);
      let m = parent.m;
      const tf = el.getAttribute("transform");
      if (tf) m = mulM(m, parseTransform(tf, warn));
      const ctx = { m, st, faded };

      if (tag === "svg" || tag === "g" || tag === "a" || tag === "switch") {
        if (tag === "svg" && el !== root && ["x", "y", "viewBox", "width", "height"].some((a) => el.hasAttribute(a))) warn("A nested <svg> viewport (x, y, size, viewBox) is ignored: its content is placed as a plain group.");
        for (const c of Array.from(el.children)) walk(c, ctx);
        return;
      }
      if (REFUSED[tag]) return warn(REFUSED[tag]);

      // ---- shapes -> a path string, one pipeline for everything
      let bad = false;
      const f = (n: string): number => {
        const a = el.getAttribute(n);
        if (a === null) return 0;
        const l = LEN.exec(a);
        if (!l) { bad = true; warn(`<${tag}> uses the unsupported length "${a}": that shape was skipped.`); return 0; }
        return +l[1];
      };
      let d = "";
      if (tag === "path") d = el.getAttribute("d") ?? "";
      else if (tag === "rect") {
        const [x, y, w, h] = [f("x"), f("y"), f("width"), f("height")];
        let rx = el.hasAttribute("rx") ? f("rx") : f("ry");
        let ry = el.hasAttribute("ry") ? f("ry") : rx;
        rx = Math.min(rx, w / 2);
        ry = Math.min(ry, h / 2);
        if (w > 0 && h > 0)
          d = rx > 0 && ry > 0
            ? `M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}V${y + h - ry}A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`
            : `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
      } else if (tag === "circle" || tag === "ellipse") {
        const [x, y] = [f("cx"), f("cy")];
        const rx = tag === "circle" ? f("r") : f("rx");
        const ry = tag === "circle" ? rx : f("ry");
        if (rx > 0 && ry > 0) d = `M${x - rx} ${y}A${rx} ${ry} 0 1 0 ${x + rx} ${y}A${rx} ${ry} 0 1 0 ${x - rx} ${y}Z`;
      } else if (tag === "polygon" || tag === "polyline") {
        const v = nums(el.getAttribute("points") ?? "");
        if (v.length >= 6) d = "M" + v.slice(0, v.length - (v.length % 2)).join(" ").replace(/^(\S+ \S+)/, "$1L") + "Z"; // polyline: filled = closed
      } else if (tag !== "line") return; // unknown element: nothing to draw
      if (bad) return;

      const vis = st.visibility?.toLowerCase();
      if (vis === "hidden" || vis === "collapse") return;
      const fill = (st.fill ?? "black").trim().toLowerCase();
      const stroke = st.stroke?.trim().toLowerCase();
      const hasStroke = !!stroke && stroke !== "none" && stroke !== "transparent";
      if (tag === "line" || fill === "none" || fill === "transparent") {
        if (hasStroke) warn(STROKE_ONLY);
        return; // fill none and no stroke is invisible: skipped silently
      }
      if (fill.startsWith("url(")) return warn("Gradient and pattern fills are not supported: those shapes were skipped. Use flat colours.");
      const color = parseColor(fill === "currentcolor" ? (st.color ?? "black") : fill);
      if (!color) return warn(`The fill colour "${fill}" is not supported: that shape was skipped.`);
      if (hasStroke) warn("Strokes are ignored: only fills are built. Convert strokes to outlines in your editor to keep them.");
      if (faded || opac(st["fill-opacity"]) < 1 || color.a < 1) warn("Opacity below 1 is ignored: shapes are built opaque, in their exact colour.");

      const rings = pathRings(d, m, tol, warn);
      const made = group(rings, (st["fill-rule"] ?? "").toLowerCase() === "evenodd");
      if (!made.length) return;
      for (const r of [...made.map((g) => g.outer), ...made.flatMap((g) => g.holes)])
        // ponytail: isSimple is O(n^2), so rings over 2000 points are not checked
        if (isFinite(tol) && r.length <= 4000 && !isSimple(r)) warn("A shape's outline crosses itself; its 3D result may have artefacts.");
      // regions come out in paint order with no depth: layers.ts flattens the
      // painter's stack and derives depth from containment.
      for (const g of made) regions.push({ hex: color.hex, outer: g.outer, holes: g.holes });
    };

    walk(root, { m: [1, 0, 0, 1, -vx, -vy], st: {}, faded: false });
    return regions;
  };

  const tolFor = (w: number, h: number) => 0.001 * Math.max(w, h);
  let regions: Region[];
  if (known) regions = run(tolFor(width, height));
  else {
    // no viewBox, no usable width/height: size from the geometry itself
    const coarse = run(Infinity);
    const box = bounds(coarse);
    if (!box) return { regions: [], warnings: [...warnings], width: 0, height: 0 };
    regions = run(tolFor(box.maxX - box.minX, box.maxY - box.minY));
    const b = bounds(regions) ?? box;
    const shift = (r: number[]) => r.map((v, i) => v - (i % 2 ? b.minY : b.minX));
    regions = regions.map((r) => ({ ...r, outer: shift(r.outer), holes: r.holes.map(shift) }));
    width = b.maxX - b.minX;
    height = b.maxY - b.minY;
  }
  return { regions, warnings: [...warnings], width, height };
}

function bounds(regions: Region[]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of regions)
    for (let i = 0; i < r.outer.length; i += 2) {
      minX = Math.min(minX, r.outer[i]); maxX = Math.max(maxX, r.outer[i]);
      minY = Math.min(minY, r.outer[i + 1]); maxY = Math.max(maxY, r.outer[i + 1]);
    }
  return minX < Infinity ? { minX, minY, maxX, maxY } : null;
}
