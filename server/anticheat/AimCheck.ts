import { PHYSICS } from '../../src/player/Physics';

/**
 * Sanity checks on a `fire` message before the hitscan runs (DOM-free).
 *
 * The client's origin is its eye at the moment it fired. The server knows the eye from the last
 * position report and the velocity between the last two; the client is ahead of that by the time
 * since the report (at most a report interval). The origin must lie within ORIGIN_TOLERANCE of the
 * segment from the last known eye to the extrapolated one, otherwise the server's eye is used.
 */

/** Blocks of tolerance around the server-known eye (was 1.6 before the extrapolation). */
export const ORIGIN_TOLERANCE = 0.6;
/** The extrapolation looks at most this far ahead (s): a report interval plus jitter. */
export const MAX_EXTRAPOLATION = 0.1;
/** |dir| must be within this of 1 (the client sends a unit vector built from yaw and pitch). */
export const UNIT_TOLERANCE = 0.02;

export function isUnitVector(dx: number, dy: number, dz: number): boolean {
  if (![dx, dy, dz].every(Number.isFinite)) return false;
  return Math.abs(Math.hypot(dx, dy, dz) - 1) <= UNIT_TOLERANCE;
}

/**
 * Distance from the claimed origin to the segment [eye, eye + v·ahead], where eye is the last known eye
 * position (feet + 1.62), v the last known velocity and ahead the time since that report (capped).
 */
export function originError(
  ox: number, oy: number, oz: number,
  x: number, y: number, z: number, vx: number, vy: number, vz: number, sinceReport: number, eye: number = PHYSICS.EYE_HEIGHT,
): number {
  const ahead = Math.min(MAX_EXTRAPOLATION, Math.max(0, sinceReport));
  const ex = x, ey = y + eye, ez = z;
  const sx = vx * ahead, sy = vy * ahead, sz = vz * ahead;
  const len2 = sx * sx + sy * sy + sz * sz;
  let f = len2 > 1e-12 ? ((ox - ex) * sx + (oy - ey) * sy + (oz - ez) * sz) / len2 : 0;
  f = Math.max(0, Math.min(1, f));
  return Math.hypot(ox - (ex + sx * f), oy - (ey + sy * f), oz - (ez + sz * f));
}

/** Unit view direction from yaw/pitch as the client builds it (yaw 0 looks along −Z, pitch > 0 up). */
export function viewDir(yaw: number, pitch: number, out: [number, number, number]): [number, number, number] {
  const c = Math.cos(pitch);
  out[0] = -Math.sin(yaw) * c;
  out[1] = Math.sin(pitch);
  out[2] = -Math.cos(yaw) * c;
  return out;
}

/** Angle in degrees between two unit vectors. */
export function angleDeg(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  return (Math.acos(Math.max(-1, Math.min(1, ax * bx + ay * by + az * bz))) * 180) / Math.PI;
}
