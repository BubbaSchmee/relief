/** Camera framing for the overlay video. Pure, so a test can project the real
 *  mesh with the very matrices the renderer uses.
 *
 *  The logo spins or rocks about its own centre, so its farthest vertex sweeps
 *  a sphere. The camera sits on the axis at a FIXED distance where that sphere
 *  (grown by the hover amplitude) fits with a margin. Constant for the whole
 *  clip: a distance that tracked the logo's silhouette would pump in and out
 *  as a wordmark turns edge-on, and could never loop. The price is that a wide
 *  wordmark fills less of the frame than its face-on width would allow. */
import type { Mesh } from "./types.js";
import { DEFAULT_MOTION, poseAt, type Motion, type Pose } from "./motion.js";

export const FOV_Y = (30 * Math.PI) / 180;
/** Free space kept between the sweep sphere and the frame edge, per side. */
export const FRAME_MARGIN = 0.08;

/** Column-major 4x4, as WebGL wants it. Float64 here; the renderer narrows. */
export type M4 = number[];

export interface Sphere {
  center: [number, number, number];
  radius: number;
}

export interface Framing {
  /** The point the logo rotates about. */
  center: [number, number, number];
  /** Sweep radius: the logo's bounding radius plus the hover amplitude. */
  radius: number;
  fovY: number;
  aspect: number;
  /** Camera distance on the +z axis, looking down -z. */
  distance: number;
  near: number;
  far: number;
}

/** Bounding sphere about the bounding-box centre: every vertex lies within
 *  `radius` of `center`. Not the minimal sphere, but it is the pivot too, so it
 *  stays exact under rotation about it. */
export function boundingSphere(positions: ArrayLike<number>): Sphere {
  if (positions.length < 3) return { center: [0, 0, 0], radius: 0 };
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3)
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], positions[i + k]);
      hi[k] = Math.max(hi[k], positions[i + k]);
    }
  const center: [number, number, number] = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  let r2 = 0;
  for (let i = 0; i < positions.length; i += 3) {
    const dx = positions[i] - center[0], dy = positions[i + 1] - center[1], dz = positions[i + 2] - center[2];
    r2 = Math.max(r2, dx * dx + dy * dy + dz * dz);
  }
  return { center, radius: Math.sqrt(r2) };
}

/** Distance at which a sphere of `radius` on the axis projects to `1 - margin`
 *  of the frame's smaller half-extent. The silhouette's angular radius is
 *  asin(R / d), so tan(theta) = R / sqrt(d^2 - R^2). */
export function framingDistance(radius: number, fovY: number, aspect: number, margin = FRAME_MARGIN): number {
  const tanHalf = Math.tan(fovY / 2) * Math.min(1, aspect); // the tighter axis binds
  const k = 1 / ((1 - margin) * tanHalf);
  return radius * Math.sqrt(1 + k * k);
}

/** Samples per loop when fitting. Spin turns 2 degrees between samples; a
 *  vertex's projection is at an extreme where its rate of change is zero, so the
 *  overshoot between samples is second order and the margin absorbs it. */
const FIT_SAMPLES = 180;

/** Camera distance at which EVERY vertex, at EVERY pose of the motion, projects
 *  inside the frame with `margin` to spare, fitted on each axis separately.
 *
 *  A bounding sphere wastes the frame on a wide logo: its full width had to fit
 *  the frame's HEIGHT, so a 3:1 wordmark in a 16:9 overlay used well under half
 *  the frame's width. Fitting the actual motion also frames a rocking logo
 *  tighter than a spinning one, since it never turns edge-on. Still one fixed
 *  distance for the whole clip: no zoom pumping.
 *
 *  Per vertex (camera on +z looking down -z, f = 1/tan(fovY/2)):
 *    |x_ndc| = |X| f / (aspect (D - Z)) <= m   =>   D >= Z + |X| f / (aspect m)
 *    |y_ndc| = |Y| f / (D - Z)          <= m   =>   D >= Z + |Y| f / m        */
export function fitDistance(positions: ArrayLike<number>, center: [number, number, number], motion: Motion, aspect: number, fovY = FOV_Y, margin = FRAME_MARGIN): number {
  const f = 1 / Math.tan(fovY / 2);
  // 0.1% headroom: an export samples the loop at its own frame times, which can
  // fall between the fit's samples; that overshoot is second order (measured
  // ~3e-5 of the frame at 30 fps), so 1e-3 covers it with room to spare
  const m = (1 - margin) * (1 - 1e-3);
  const kx = f / (aspect * m);
  const ky = f / m;
  let D = 0;
  for (let s = 0; s < FIT_SAMPLES; s++) {
    const pose = poseAt(motion, (s / FIT_SAMPLES) * motion.duration);
    const cy = Math.cos(pose.yaw), sy = Math.sin(pose.yaw);
    const cp = Math.cos(pose.pitch), sp = Math.sin(pose.pitch);
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i] - center[0], y = positions[i + 1] - center[1], z = positions[i + 2] - center[2];
      // the same transform as poseMatrices: rotY, then rotX, then the lift
      const x1 = cy * x + sy * z;
      const z1 = -sy * x + cy * z;
      const Y = cp * y - sp * z1 + pose.lift;
      const Z = sp * y + cp * z1;
      const need = Z + Math.max(Math.abs(x1) * kx, Math.abs(Y) * ky);
      if (need > D) D = need;
    }
  }
  return D;
}

export function frameFor(mesh: Pick<Mesh, "positions">, motion: Partial<Motion>, aspect: number, fovY = FOV_Y, margin = FRAME_MARGIN): Framing {
  const mo: Motion = { ...DEFAULT_MOTION, ...motion };
  const s = boundingSphere(mesh.positions);
  const radius = s.radius + Math.abs(mo.hover); // every vertex stays within this of the pivot
  const distance = fitDistance(mesh.positions, s.center, mo, aspect, fovY, margin);
  // depth range from the logo's real extent; near must stay in front of the
  // nearest possible vertex (distance - radius), which the exact fit brings close
  return { center: s.center, radius, fovY, aspect, distance, near: Math.max(distance * 1e-3, distance - 1.05 * radius), far: distance + 1.05 * radius };
}

// ---------------------------------------------------------------- matrices
export const mul = (a: M4, b: M4): M4 => {
  const o = new Array<number>(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return o;
};
export const perspective = (fovY: number, aspect: number, near: number, far: number): M4 => {
  const f = 1 / Math.tan(fovY / 2), nf = 1 / (near - far);
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
};
export const rotY = (a: number): M4 => { const c = Math.cos(a), s = Math.sin(a); return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]; };
export const rotX = (a: number): M4 => { const c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]; };
export const translate = (x: number, y: number, z: number): M4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];

/** Model-view and model-view-projection for one pose: spin about the logo's own
 *  vertical axis, then the forward tilt, then the hover lift, then the fixed
 *  camera. The lights live in view space, so they stay put as the logo turns. */
export function poseMatrices(f: Framing, pose: Pose): { modelView: M4; mvp: M4 } {
  const [cx, cy, cz] = f.center;
  const model = mul(translate(0, pose.lift, 0), mul(rotX(pose.pitch), mul(rotY(pose.yaw), translate(-cx, -cy, -cz))));
  const modelView = mul(translate(0, 0, -f.distance), model);
  return { modelView, mvp: mul(perspective(f.fovY, f.aspect, f.near, f.far), modelView) };
}

/** Project a model-space point to NDC with a matrix from poseMatrices. */
export function project(mvp: M4, x: number, y: number, z: number): [number, number, number] {
  const w = mvp[3] * x + mvp[7] * y + mvp[11] * z + mvp[15];
  return [
    (mvp[0] * x + mvp[4] * y + mvp[8] * z + mvp[12]) / w,
    (mvp[1] * x + mvp[5] * y + mvp[9] * z + mvp[13]) / w,
    (mvp[2] * x + mvp[6] * y + mvp[10] * z + mvp[14]) / w,
  ];
}
