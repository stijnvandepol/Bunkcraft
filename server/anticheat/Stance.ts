/**
 * Arcade: the shooter's stance (moving, airborne) as the server saw it, for the spread of a shot. Fed with the accepted
 * position reports (the movement validator has checked their ground contact and jump curve); the `mv` / `air` claims
 * of a `fire` message are not used.
 *
 * Tolerance, because client and server look at the same movement through ~20 Hz reports: a flag counts only when the
 * last TWO report intervals agree (about 100 ms). An honest player who just stopped or landed is therefore never
 * charged for the report that still shows the old state (the more favourable of the two views), while a cheater has
 * to stand still or stay on the ground for two whole reports to get the tight spread, which a real jump or run never does.
 */

/** Blocks per second above which a player counts as moving; the same threshold the client uses for its crosshair. */
export const MOVING_MIN_SPEED = 0.5;

export class StanceTracker {
  private t = NaN;
  private x = 0;
  private z = 0;
  /** Speed of the last interval and the one before it. */
  private v1 = 0;
  private v2 = 0;
  /** Was the player airborne at the last report / the one before it. */
  private a1 = false;
  private a2 = false;

  /** The server put the player somewhere (spawn, teleport): no history. */
  reset(): void {
    this.t = NaN;
    this.v1 = this.v2 = 0;
    this.a1 = this.a2 = false;
  }

  /** An accepted position report at `now` (seconds); `grounded`: the validator's ground contact at that position. */
  note(now: number, x: number, z: number, grounded: boolean): void {
    const dt = now - this.t;
    this.v2 = this.v1;
    this.a2 = this.a1;
    this.v1 = this.t === this.t && dt > 0.005 ? Math.hypot(x - this.x, z - this.z) / dt : 0;
    this.a1 = !grounded;
    this.t = now; this.x = x; this.z = z;
  }

  get moving(): boolean {
    return this.v1 > MOVING_MIN_SPEED && this.v2 > MOVING_MIN_SPEED;
  }

  get airborne(): boolean {
    return this.a1 && this.a2;
  }
}
