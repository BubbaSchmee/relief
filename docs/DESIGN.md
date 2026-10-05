# RELIEF — 2D logo → 3D object — Design

**Status: built. This document is the design rationale.** Written 2026-09-20 after a research
sweep, a license verification pass, and a working validation spike measured on a real wordmark,
then kept up to date as the phases below shipped.

A free, open-source, deterministic converter that turns a flat logo into a real 3D object with
its exact brand colors intact. Runs entirely in a browser, no install, no upload, no ML.
Its geometry core is a plain TypeScript library that any renderer can import directly.

---

## 1. Decisions locked

Each was settled with the author. Rationale is recorded so we don't relitigate.

| # | Decision | Why |
|---|---|---|
| 1 | **Logos → full 3D objects**, usable by any renderer that consumes the core | The ask. Not photos, not depth maps, not stereo. |
| 2 | **Free forever, no commercial plans** | The author's call. GPL is therefore permitted, though we end up not needing it. |
| 3 | **Pure procedural geometry, no ML** | See §2. Three independent kills. |
| 4 | **Shared TypeScript geometry core, two frontends** | Determinism between tool and renderer becomes structural, not aspirational. Verified: no Rust needed (§7). |
| 5 | **Color regions become depth layers** | The biggest lever on "reads as an object" — creates real internal occlusion under rotation. |
| 6 | **SVG-first, raster fully supported** | SVG gives exact curves and exact per-region hex. Raster must work anyway; most logos arrive as PNG. |
| 7 | **"Preserves colors" = exact hex in the asset** | Measured proof in §3. The only promise the tool can keep, since it does not control the renderer. |
| 8 | **Browser app first, desktop wrapper later** | Every verified dependency runs in a browser. Zero-install is the biggest adoption lever for a free tool. |
| 9 | **Primary output: a transparent overlay video** of the logo floating and spinning or rocking (2026-10-04) | The real use: an overlay on your own footage. GLB export stays as a secondary output. |
| 10 | **Three transparent formats behind an "I'll use it in…" picker**, all made in the browser | No single format survives every editor (research 2026-10-04): ProRes 4444 `.mov` for Resolve/Premiere/AE/FCP/iMovie (ffmpeg.wasm, fetched from the CDN only when chosen, ≤1080p); transparent WebM VP9 for CapCut/OBS/web (Mediabunny's two-encoder alpha); PNG sequence `.zip` as the universal fallback and the 4K path. |

### Deliberately deferred
Materials beyond chrome (nobody asked for more); animation/rig data in
the export; `.ai`/`.eps`/PDF import; batch folder conversion.

---

## 2. Why no machine learning

Not a budget compromise. Generative image-to-3D is the **wrong tool** for logos:

1. **Determinism.** The renderer RELIEF was built for is a pure function of its inputs
   (`(features, theme, frameIndex)`), so preview equals export frame-for-frame. Every surveyed model is a diffusion sampler or depends
   on one. A model could only ever bake an asset offline — at which point it is an authoring tool,
   not part of the pipeline.
2. **Exact color.** Generative models *re-render* the surface through a texture generator: color
   is a network output, not a copy of the input. Procedural extrusion copies the source value
   verbatim. Color fidelity is true by construction, not by measurement.
3. **Domain.** These models are trained on Objaverse-style renders of photographed objects. A flat
   hard-edged logo is out of distribution — documented failure modes are coin/plaque hallucination,
   warped wafers, and blobby normals eating letterform counters. The one paper targeting flat
   illustration (Art3D, 2026) exists *because* the baselines fail here, and ships no code.

A logo has an exact silhouette that is contractually part of the brand. AI's entire value is
inventing plausible unseen geometry. That is the one thing we must not do.

**License note (recorded, no longer binding after decision 2):** TRELLIS is MIT in code and weights
but its render path needs NVlabs `nvdiffrast` under a non-commercial NVIDIA license — the sweep
called it clean, verification refuted it. Hunyuan3D-2.1 is Tencent Community (EU/UK/Korea excluded,
1M-MAU cap). SF3D is Stability Community ($1M revenue cap). Kept as a warning: *MIT at the top of a
repo tells you nothing about its dependency tree.*

---

## 3. What the spike proved

A throwaway page (not part of this repository) imported the real `trace.ts` and `earcut`, built
the same mark twice — planar front vs inflated front — and rendered both under identical lighting.
Measured on a real wordmark: **five letters, 600×200, every opaque pixel exactly `#FF2E9A`.**

### Finding 1 — inflation works
A non-planar front face removes the cutout read. Same silhouette, same walls, same lights.

### Finding 2 — earcut alone cannot be domed
The front face is `earcut` over the contour, so **every vertex lies on the boundary at distance
zero**. Displacing by distance-to-edge moves nothing. A dome requires interior vertices that do not
currently exist — so subdivision is mandatory, not optional. This is why the change is ~150 lines,
not the 60 originally estimated.

### Finding 3 — lighting, not geometry, destroys brand color
ΔE measured against `#FF2E9A` over front-face pixels, face-on (the worst case):

| Configuration | mean ΔE | pixels within ΔE 1 |
|---|---|---|
| Flat, lit | 17.37 | **0%** |
| Domed, lit | 33.00 | 0.1% |
| Flat, unlit front | 4.29 | **88.6%** |
| Domed, unlit front | 4.63 | **87.3%** |

With an unlit face, **doming costs 0.34 ΔE** — free. The residual ~12% is edge antialiasing
against the background, not a defect.

### Finding 4 — the color/form tradeoff is a cliff, not a curve

| unlit | 0.0 | 0.4 | 0.6 | 0.75 | 0.85 | 0.95 | 1.0 |
|---|---|---|---|---|---|---|---|
| mean ΔE | 33.0 | 25.5 | 18.2 | 12.9 | 9.4 | 6.1 | 4.6 |
| exact px | 0.1% | 0.1% | 0.2% | 0.7% | 2.4% | 23% | 87% |

Exactness is ~0 until `unlit ≈ 0.95`, then snaps to 87%. **There is no compromise setting** — any
lighting on the face destroys hex-exactness, because shading a color *is* changing it. This killed
the "just clamp the lighting range" idea with data, and forced decision 7.

### Finding 5 — thin strokes are the failure mode
The `O` in the test wordmark has no flat interior: its whole stroke is rim, so it inflates into a
tube. Dome quality depends on stroke thickness relative to dome height. **This drives the profile
model in §5.**

### Performance
600×200 trace → 116 contour points → 28,192 triangles, **both meshes built in 112 ms**, single
threaded, no GPU compute. Performance is a non-issue.

---

## 4. Pipeline

```
input: SVG | PNG/JPEG/WebP
  │
  ├─ SVG path:    parse filled paths + basic shapes + transforms
  │               → flatten béziers at OUR tolerance → exact per-region hex
  │
  └─ raster path: background removal → color quantization
                  → per-color region trace (generalized trace.ts) → simplify/curve-fit
  │
  ▼
regions: [{ hex, outer[], holes[][], depthIndex }]
  │
  ▼  per region
  ├─ front surface: triangulate → subdivide → displace z by profile h(d)   (§5)
  ├─ bevel ring:    Clipper2 inset rings lofted along the profile curve
  ├─ side walls:    contour extruded from front rim to back
  └─ back face:     flat, or mirrored profile
  │
  ▼
merge: Manifold union within a region; regions stay separate primitives
  │
  ▼
materials: one per region, baseColorFactor = exact linear(hex)   (§6)
  │
  ▼
GLB
```

---

## 5. The profile model

The single most important design decision in the geometry, and it comes straight from Finding 5.

Do **not** treat "dome" and "bevel" as rival features. They are two terms of one height function
over `d` = distance to the region's edge:

```
z_front(d) = D/2  +  BEV_H · bevel(d / B)  +  DOME_H · dome(d / d_max)
```

- **`bevel(t)`** rises from 0 at the rim to 1 at `t ≥ 1`, shaped by a profile curve
  (round / ogee / step / chamfer). `B` is an **absolute** distance.
- **`dome(t)`** rises from 0 at the rim to 1 at the region's widest point. `d_max` is **relative**
  to the region.

**Why this split is the whole trick.** The bevel is absolute, so a hairline stroke gets the same
edge treatment as a thick one — it cannot tube. The dome is relative, so it scales with whatever
interior width is actually available. Setting `DOME_H = 0` yields a cleanly beveled prism; setting
`BEV_H = 0` yields the pure inflation the spike tested. The spike's two sliders were these two
terms all along.

**Correction after P1, measured on the real mark.** Two things the paragraph above overclaimed:
1. `bevelWidth` is absolute in *normalised* units, and normalisation scales to logo width — so a
   wide wordmark gets a bevel that is fat relative to its strokes. On that wordmark the nominal 0.035
   was 7.4 px against ~25 px strokes and every letter's inset collapsed. Fix shipped: per region, the
   band shrinks (×1, 0.7, 0.5, 0.35) until the inset is a valid polygon-with-holes, height held so
   all regions share one plateau; only if nothing fits does the region fall back to a hard edge.
2. The split stops the *bevel* from tubing a thin stroke. It does not stop the *dome*: a relative
   dome over a narrow stroke is still a steep ridge. That is a tuning question for P2's sliders
   (dome height vs stroke width), deliberately not solved with a new parameter yet.

**Superseded after P4 (2026-10-04): the dome is now width-proportional inflation.** The `u^k`
dome normalised to the logo's thickest point creased every thinner stroke down its middle (slope
at its peak is not zero, and thinner strokes peak before reaching it), which rendered as a
staircase wherever triangle edges crossed the crease. The author deferred to professional practice;
professional inflate tools (Illustrator 3D Inflate, Spline, Teddy) scale the rise with each stroke's
own width. So now:

```
z(d) = D/2 + bevelHeight · bevel(d / bevelWidth) + inflate · R · arc(d / R)
```

- `R` is the stroke's **local** half-width: for samples along the outline, the distance to the
  medial axis along the inward normal — grow a disc until the outline point nearest its centre
  jumps to the far side of the stroke. Interpolated at each point's nearest outline location.
- `arc` is the quarter circle (the round bevel curve): vertical at the rim, flat at `d = R`, so
  both sides of every stroke meet at its centre line at the same height with zero slope. No crease.
- `inflate` (unitless, default 0.5) replaces `domeHeight` + `domeFalloff`: the rise as a fraction
  of local half-width. Measured on a tapering wedge: rise ratio 0.477 for a width ratio 0.467.
- Band and back-strip quads take one winding per ring by area-weighted vote, so a quad that folds
  at a sharp spike cannot leave its winding disagreeing with its neighbours.

**Normals** come from the analytic gradient of `h`, not from mesh facets: with `h` known in closed
form, `∂h/∂x, ∂h/∂y` give exact per-vertex normals, and faceting disappears for free. Slope is
clamped near the rim so a `k < 1` falloff cannot blow up.

**Subdivision** is 4-way midpoint until every edge is under `maxEdge`. Boundary vertices stay
exactly on the boundary (the midpoint of a straight edge lies on it), so **the silhouette is
preserved bit-for-bit** while the interior gains displaceable vertices. Density should be higher
within the bevel band and sparser in the flat interior; the spike used a uniform grid and still
came in at 112 ms, so optimize only if measurement demands it.

**Distance field.** The spike used exact point-to-segment distance, O(vertices × contour points) —
fine at this scale. If multi-region logos make it hot, switch to a two-pass separable exact
Euclidean distance transform (Felzenszwalb–Huttenlocher) on a raster grid with bilinear sampling.
No maintained npm package exists for a *signed* EDT; it is ~100 lines and we own it.

### Layer ordering (regions → depth)
Default heuristic, deterministic:
1. Region **containment** wins: a region inside another sits **in front** of it (icon on badge).
2. Non-contained siblings share a depth.
3. Ties break by area, larger = further back.
4. Per-region manual override in the UI.

---

## 6. Color model

The glTF 2.0 spec is asymmetric here, which is why this is usually got wrong:

- `baseColorFactor` and vertex `COLOR_0` are **linear**.
- `baseColorTexture` texels are **sRGB** and must be decoded before shading.
- Embedded PNG ICC/gamma chunks **must be ignored** — the glTF material alone defines the transfer
  function.

**Rules:**
1. **Flat regions use `baseColorFactor`, no texture.** One material per color island. Convert hex
   to linear once with the exact piecewise sRGB EOTF (the 0.04045 knee), never `pow(x, 2.2)` — the
   approximation is where the last ΔE hides.
2. **Never use vertex colors for exact hex.** Khronos issue #1638 leaves `COLOR_0`'s color space
   ambiguous and exporters disagree. Unresolved upstream; do not build on it.
3. **If a texture is unavoidable** (a logo with gradients or photographic fill): `NEAREST` min and
   mag filters, **mipmaps off entirely**, no anisotropic filtering. Mip generation box-filters
   across region boundaries and shifts color at exactly the edges that matter.
4. **Ship an unlit variant** as a second glTF material — `KHR_materials_unlit` at the exact hex —
   for anywhere the brand color is contractual. Geometry is shared; it is a material, not a mesh.

---

## 7. Dependencies

All verified against the npm registry and GitHub on 2026-09-20. **No Rust toolchain required.**

| Need | Package | Version | License | Notes |
|---|---|---|---|---|
| Mesh booleans, watertight, shelling | `manifold-3d` | 3.5.3 | Apache-2.0 | Official WASM, ~84k dl/wk. Vite needs `optimizeDeps.exclude` + wasm asset glob. |
| Polygon booleans / offset (layers) | `clipper2-js` | 1.2.4 | Boost | **Used.** Pure TS, no WASM. PolyTree API is broken; flat API + containment rebuild. |
| — WASM alternative | `clipper2-wasm` | 0.4.0 | BSL-1.0 | Not used: needs `vite-plugin-wasm` + top-level-await. |
| — pure-JS alternative | `clipper2-js` | 1.2.4 | Boost | Stale but dependency-free; fallback if WASM friction bites. |
| Triangulation | `earcut` | 3.2.3 | ISC | **Used.** Small, widely deployed. |
| GLB export | `@gltf-transform/core` | 4.5.0 | MIT | Or hand-roll ~120 lines: 12-byte header + JSON chunk + BIN chunk. |
| Distance transform | *(in-house)* | — | — | ~100 lines. No maintained signed-EDT package exists. |
| Raster vectorization | *(in-house, generalize `trace.ts`)* | — | — | See below. |

### Why not VTracer
VTracer is the obvious vectorizer and it is MIT — but **there is no first-party WASM build**. Every
browser path is an unofficial single-maintainer wrapper; `@neplex/vectorizer` is Node-native-first
with a WASI bolt-on whose own docs say async breaks in browsers, and `vtracer-wasm` declares **no
license at all**. Adopting an unlicensed wrapper in a project whose premise is being freely
reusable is not acceptable.

`trace.ts` already does binarize → boundary-chain → simplify → hole-assign, deterministically.
Generalizing "binarize *alpha*" to "select *color region k*" is a modest change to code we own, and
it is exactly the multi-region tracing decision 5 requires anyway. Bézier curve fitting can be
added later if polyline density at a raised trace cap proves insufficient.

### The quality ceiling to fix
The app traces at most `TRACE_MAX = 1024` px on the long edge (colour is always read at full size). The spike ran at 1024 and a 600px source still yielded only
116 contour points after Douglas–Peucker. Raise the cap, loosen simplification, and — far more
importantly — **accept SVG**, where curves are analytic and no information was ever thrown away.

---

## 8. Test harness and pass bars

Every bar is a number, runnable in CI, no vibe checks.

| Gate | Bar |
|---|---|
| Silhouette fidelity | IoU of rendered alpha vs source alpha ≥ **0.98** |
| Material color | ΔE00 of each material's `baseColorFactor` vs source hex = **0, exactly** |
| Rendered color | ΔE00 of **unlit reference render** vs source hex: mean ≤ **1.0**, p95 ≤ **2.0** |
| Mesh validity | per region: manifold, winding-consistent, volume > 0; survives weld at 1e-4 (the usual weld-by-distance default) |
| Hole correctness | Euler characteristic matches traced region/hole count |
| Determinism | same input → **byte-identical GLB** (hash compare) |
| Triangle budget | ≤ **50k** per logo at default settings |
| Conversion time | < **500 ms** for a typical logo (spike: 112 ms) |
| Text legibility | OCR round-trip on wordmarks at target render size |

ΔE00 is CIEDE2000. The spike used ΔE76 for speed; production uses CIEDE2000 per the brief.
**Critically: the rendered-color gate runs against an unlit reference render, never a lit beauty
shot** — §3 Finding 4 proves a lit render can never pass, and a gate that cannot pass is not a gate.

---

## 9. Phases and gates

Each phase ends at a check that can fail.

- **P0 — validation spike. DONE.** Inflation confirmed on a real wordmark; §3 findings
  recorded. Gate passed: the cutout read goes away.
- **P1 — geometry core.** `relief-core`: regions → profile model (§5) → mesh. Single region only.
  Analytic normals, subdivision, distance field. Full test harness from §8.
  *Gate:* all §8 bars pass on a fixture set, single-region.
- **P2 — GLB export + browser app.** Drop a PNG, tune profile, preview, download `.glb`.
  *Gate:* exported GLB opens correctly in a desktop 3D package and a third-party web viewer, material hex exact.
  **This is the first genuinely usable product.**
- **P3 — SVG input.** Filled paths, basic shapes, transforms. Explicitly reject or convert the rest
  with a clear message rather than silently mangling it.
  *Gate:* an SVG logo beats its own PNG rasterization on the silhouette IoU bar.
- **P4 — multi-region layering.** Quantization, per-region trace, containment ordering, Manifold
  union, per-region materials, manual depth override.
  *Gate:* a multi-color logo shows correct occlusion under rotation, every region's hex exact.
- **P5 — integration into a consuming renderer.** Replace the host's own extrusion function with
  the shared core. Everything around it — GL settings, matcap, text drawing, the GL lifecycle — is
  untouched. Move the trace out of the per-frame path: it is an asset bake, done once on logo load
  and cached. *Gate:* the host's existing determinism tests still pass; preview still equals
  export. Done in the author's own renderer.
- **P6 — desktop wrapper.** Optional. Tauri from the same codebase, for filesystem and batch.

**The seam is small.** The host's extrusion function is the entire replacement surface. Its tuned
parts (crease angle, smoothing, matcap) are not what was broken, so they stay.

---

## 10. Rejected

One line each, so they stay rejected.

- **All generative image-to-3D** — §2. Wrong domain, nondeterministic, cannot preserve exact color.
- **Blender's `bpy` as a backend** — GPL. Permitted under decision 2, but drags a 200MB runtime in
  to do what ~1000 lines of TypeScript does deterministically in-browser.
- **Monster Mash source** — requires Shewchuk's Triangle, non-commercial. Read the paper, write the
  solve.
- **Shewchuk's Triangle and every port** (Triangle.NET, meshpy, Triangle.jl) — the non-commercial
  restriction survives the wrapper's permissive license.
- **CGAL straight skeleton** — GPL, and Clipper2 does the same offsetting under Boost.
- **potrace / AutoTrace** — GPL, and binary-threshold tracing is the wrong shape for multi-color.
- **Neural vectorizers** (StarVector, LIVE, DiffVG, Im2Vec) — nondeterministic and GPU-bound for a
  problem classical tracing solves losslessly on CPU.
- **OpenSubdiv** — clean license, real capability, unnecessary: a dense height-field grid is already
  smooth. A second geometry system for no visible gain.
- **glTF vertex colors for exact hex** — Khronos #1638, ambiguous color space, exporters disagree.
- **Mipmaps on any logo texture** — box-filters across color boundaries, shifting ΔE exactly at the
  edges that matter.
- **A Python geometry core** — it would match a Python-side stack, and that is the trap: it forks
  the math into a language a WebGL renderer cannot call, guaranteeing preview/export drift.
- **Clamping the lighting range** — §3 Finding 4 killed it with measurements.
- **Rust/WASM core** — genuinely defensible, and the research recommended it. Rejected because the
  npm check proved every needed library already has a browser-ready build, so Rust would buy a
  toolchain and lose contributors for no capability gain. Revisit only if TS proves too slow — at
  112 ms, it is not.

---

## 11. Open items

Defaults chosen; open to change.

1. ~~Project name.~~ **RELIEF** — chosen 2026-09-20.
2. **Bevel profiles as presets, not a curve editor.** Round / ogee / step / chamfer covers ~95% and
   takes an afternoon; a curve editor is a week of UI. Add the editor only if presets chafe.
3. **Static GLB, no animation or rig data.**
4. **Export `.glb` only at first.** Add `.stl` only if you want to 3D print these; it carries no
   color, so it is a different use case, not a free extra.
5. **Background removal for raster** = flood-fill from the corners with a tolerance, not a
   segmentation model. Deterministic, no weights.
6. **Region count cap** ~16 by default, to keep quantization sane and the UI legible.
