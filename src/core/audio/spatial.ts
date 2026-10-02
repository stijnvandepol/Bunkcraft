/** Pure spatial-audio math: distance attenuation, panning, air absorption, occlusion. */

export const MAX_HEAR_DISTANCE = 48;
const REF_DISTANCE = 2;

/** Gain 0..1 at `d` blocks: full inside the reference distance, smooth fall-off to silence at `max`. */
export function distanceGain(d: number, max = MAX_HEAR_DISTANCE): number {
  if (d <= REF_DISTANCE) return 1;
  if (d >= max) return 0;
  const g = 1 - (d - REF_DISTANCE) / (max - REF_DISTANCE);
  return g * g;
}

/** Low-pass cut-off (Hz) from air absorption: far sounds lose their highs. */
export function distanceCutoff(d: number): number {
  return 18000 / (1 + d * 0.14);
}

/**
 * Stereo pan -1 (left) .. 1 (right) of a source at (dx, dz) relative to a listener facing `yaw`
 * (three.js YXZ camera: forward = (-sin, -cos), right = (cos, -sin)). Sounds straight ahead or behind stay
 * centred; very close sounds are widened less (so a footstep under you is not hard-panned).
 */
export function panFor(dx: number, dz: number, yaw: number): number {
  const d = Math.hypot(dx, dz);
  if (d < 0.001) return 0;
  const right = (dx * Math.cos(yaw) - dz * Math.sin(yaw)) / d;
  const closeness = Math.min(1, d / 3);
  return Math.max(-1, Math.min(1, right * 0.85 * closeness));
}

/** Gain multiplier from the number of solid blocks between source and listener (0 = clear line). */
export function occlusionGain(solidBlocks: number): number {
  return 1 - Math.min(solidBlocks, 4) * 0.12;
}

/** Low-pass cut-off multiplier from occlusion (1 = open). */
export function occlusionCutoff(solidBlocks: number): number {
  if (solidBlocks <= 0) return 1;
  return Math.max(0.05, 0.5 ** Math.min(solidBlocks, 4) * 0.45);
}

/**
 * Count solid blocks along the straight line between two points by sampling every half block.
 * Samples at both ends are skipped (the source may stand inside a block). `maxSamples` bounds the cost.
 * Returns the number of distinct solid samples (a wall of thickness n counts ~n, not 2n).
 */
export function countSolidAlong(
  isSolid: (x: number, y: number, z: number) => boolean,
  x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, maxSamples = 32,
): number {
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1.5) return 0;
  const n = Math.min(maxSamples, Math.ceil(len * 1.0));
  let count = 0;
  let lastX = NaN, lastY = NaN, lastZ = NaN;
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const x = Math.floor(x0 + dx * t), y = Math.floor(y0 + dy * t), z = Math.floor(z0 + dz * t);
    if (x === lastX && y === lastY && z === lastZ) continue;
    lastX = x; lastY = y; lastZ = z;
    if (isSolid(x, y, z)) count++;
  }
  return count;
}
