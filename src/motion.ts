/** Motion for the transparent overlay video: the logo spins or rocks, and may
 *  hover, as a pure function of time. Every preset is a seamless loop — the
 *  pose at t = duration equals the pose at t = 0 — so an editor can repeat the
 *  clip end to end with no hitch. */

export type MotionKind = "spin" | "rock";

export interface Motion {
  kind: MotionKind;
  /** Seconds per loop. */
  duration: number;
  /** rock only: peak swing either side of facing the camera, in degrees. */
  rockDeg: number;
  /** Constant forward tilt, degrees (looks at the logo slightly from above). */
  tiltDeg: number;
  /** Vertical hover amplitude, in model units (logo width = 2). 0 = still. */
  hover: number;
  /** spin only: +1 or -1. */
  direction: 1 | -1;
}

export const DEFAULT_MOTION: Motion = {
  kind: "spin",
  duration: 4,
  rockDeg: 35,
  tiltDeg: 8,
  hover: 0.03,
  direction: 1,
};

export interface Pose {
  /** Rotation about the vertical axis, radians. */
  yaw: number;
  /** Rotation about the horizontal axis, radians. */
  pitch: number;
  /** Vertical offset, model units. */
  lift: number;
}

const TAU = Math.PI * 2;

export function poseAt(m: Motion, t: number): Pose {
  const phase = m.duration > 0 ? (((t / m.duration) % 1) + 1) % 1 : 0;
  const yaw =
    m.kind === "spin"
      ? m.direction * TAU * phase
      : ((m.rockDeg * Math.PI) / 180) * Math.sin(TAU * phase); // sine: eased at both ends
  return {
    yaw,
    pitch: (m.tiltDeg * Math.PI) / 180,
    lift: m.hover * Math.sin(TAU * phase),
  };
}

/** Frame times for one loop at `fps`. The loop's end is NOT included: frame
 *  `count` would equal frame 0, and including it makes the clip stutter on a
 *  repeat. Times are i / fps exactly, so frames are reproducible. */
export function frameTimes(m: Motion, fps: number): number[] {
  const count = Math.max(1, Math.round(m.duration * fps));
  return Array.from({ length: count }, (_, i) => i / fps);
}
