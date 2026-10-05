/** RELIEF core — a flat logo's colour regions in, a closed 3D mesh out.
 *  Pure, deterministic, dependency-light. See docs/DESIGN.md. */
export { buildMesh } from "./mesh.js";
export { meshToGlb, type GlbOptions } from "./gltf.js";
export { poseAt, frameTimes, DEFAULT_MOTION, type Motion, type MotionKind, type Pose } from "./motion.js";
export { resolveFrame } from "./frames.js";
export { parseSvg, type SvgResult } from "./svg.js";
export { assignContainmentDepth, containmentLevels, fillCoveredHoles, flattenPaintOrder, inflateRegions, layerRegions } from "./layers.js";
export { regionsFromRaster, type RasterImage, type RasterOptions } from "./raster.js";
export { surfaceHeight, bevelCurve } from "./profile.js";
export { mitredInset, nearestOnRings, ringNormals, signedArea, pointInRing } from "./geom.js";
export { subdivide, triangulateRings } from "./tessellate.js";
export {
  parseHex,
  toHex,
  srgbToLinear,
  linearToSrgb,
  hexToBaseColorFactor,
  rgbToLab,
  deltaE2000,
  hexDeltaE,
} from "./color.js";
export {
  FaceKind,
  DEFAULT_PROFILE,
  DEFAULT_TESSELLATION,
  type Region,
  type Profile,
  type BevelCurve,
  type Tessellation,
  type BuildOptions,
  type Mesh,
} from "./types.js";
