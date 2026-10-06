/**
 * The last few position reports of a player with the time the server received them, so a snapshot can show where
 * the player was at one fixed moment instead of "whatever arrived last".
 *
 * Why: clients report 20 times a second and the server snapshots 20 times a second, but not in phase. Taking the
 * newest report per tick gives steps of 0, 1 and 2 report intervals (0 / 0.22 / 0.44 blocks at walking speed): a
 * friend walking at a steady pace stutters on everybody else's screen. Sampling the trail at `now - delay` on the
 * receive timeline turns that back into equal steps. Fixed storage, no allocation per report or snapshot.
 */
export const POSE_SAMPLE_DELAY_MS = 60;
/** Reports further apart than this are a teleport or respawn: jump, do not glide. */
const MAX_GLIDE = 8;
const SIZE = 6;
const STRIDE = 6; // t, x, y, z, yaw, pitch

export interface Pose { x: number; y: number; z: number; yaw: number; pitch: number }

export class PoseTrail {
  private readonly data = new Float64Array(SIZE * STRIDE);
  /** Index of the newest entry and the number of entries. */
  private head = -1;
  private count = 0;

  push(t: number, x: number, y: number, z: number, yaw: number, pitch: number): void {
    this.head = (this.head + 1) % SIZE;
    const o = this.head * STRIDE;
    const d = this.data;
    d[o] = t; d[o + 1] = x; d[o + 2] = y; d[o + 3] = z; d[o + 4] = yaw; d[o + 5] = pitch;
    if (this.count < SIZE) this.count++;
  }

  /** Forget the history (the server moved the player). */
  reset(): void {
    this.head = -1;
    this.count = 0;
  }

  /** The pose at time `t` (same clock as `push`), interpolated between the reports around it. False when empty. */
  sample(t: number, out: Pose): boolean {
    if (this.count === 0) return false;
    const d = this.data;
    // Walk from the newest report back to the first one at or before `t`.
    let newer = this.head * STRIDE;
    if (t >= d[newer]) return this.copy(newer, out); // nothing newer yet: hold the newest
    for (let k = 1; k < this.count; k++) {
      const older = ((this.head - k + SIZE) % SIZE) * STRIDE;
      if (d[older] <= t) {
        const span = d[newer] - d[older];
        const far = Math.hypot(d[newer + 1] - d[older + 1], d[newer + 3] - d[older + 3]) > MAX_GLIDE;
        if (span <= 0 || far) return this.copy(newer, out);
        const f = (t - d[older]) / span;
        out.x = d[older + 1] + (d[newer + 1] - d[older + 1]) * f;
        out.y = d[older + 2] + (d[newer + 2] - d[older + 2]) * f;
        out.z = d[older + 3] + (d[newer + 3] - d[older + 3]) * f;
        let dyaw = d[newer + 4] - d[older + 4];
        dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
        out.yaw = d[older + 4] + dyaw * f;
        out.pitch = d[older + 5] + (d[newer + 5] - d[older + 5]) * f;
        return true;
      }
      newer = older;
    }
    return this.copy(newer, out); // older than the whole trail: the oldest known
  }

  private copy(o: number, out: Pose): boolean {
    const d = this.data;
    out.x = d[o + 1]; out.y = d[o + 2]; out.z = d[o + 3]; out.yaw = d[o + 4]; out.pitch = d[o + 5];
    return true;
  }
}
