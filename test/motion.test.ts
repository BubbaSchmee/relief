import { describe, expect, it } from "vitest";
import { DEFAULT_MOTION, frameTimes, poseAt, type Motion } from "../src/motion.js";

const close = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-9);
// angles equal modulo a full turn: both cos and sin agree
const sameAngle = (a: number, b: number) => {
  close(Math.cos(a), Math.cos(b));
  close(Math.sin(a), Math.sin(b));
};

describe("motion loops seamlessly", () => {
  for (const kind of ["spin", "rock"] as const) {
    const m: Motion = { ...DEFAULT_MOTION, kind };
    it(`${kind}: the pose at the end equals the pose at the start`, () => {
      const a = poseAt(m, 0);
      const b = poseAt(m, m.duration);
      sameAngle(a.yaw, b.yaw);
      close(a.lift, b.lift);
      close(a.pitch, b.pitch);
    });
  }

  it("spin makes exactly one full turn per loop, in the chosen direction", () => {
    const m = { ...DEFAULT_MOTION, kind: "spin" as const };
    close(poseAt(m, m.duration / 4).yaw, Math.PI / 2);
    close(poseAt({ ...m, direction: -1 }, m.duration / 4).yaw, -Math.PI / 2);
  });

  it("rock swings to +peak, back through centre, to -peak", () => {
    const m = { ...DEFAULT_MOTION, kind: "rock" as const, rockDeg: 30 };
    const peak = (30 * Math.PI) / 180;
    close(poseAt(m, 0).yaw, 0);
    close(poseAt(m, m.duration / 4).yaw, peak);
    close(poseAt(m, m.duration / 2).yaw, 0);
    close(poseAt(m, (3 * m.duration) / 4).yaw, -peak);
  });

  it("frame list excludes the loop end, so a repeat does not stutter", () => {
    const m = { ...DEFAULT_MOTION, duration: 4 };
    const t = frameTimes(m, 30);
    expect(t.length).toBe(120);
    expect(t[0]).toBe(0);
    expect(t[t.length - 1]).toBeLessThan(m.duration);
    close(t[1], 1 / 30);
  });

  it("is deterministic", () => {
    expect(poseAt(DEFAULT_MOTION, 1.234)).toEqual(poseAt(DEFAULT_MOTION, 1.234));
  });
});
