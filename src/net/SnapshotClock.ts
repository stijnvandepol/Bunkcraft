/**
 * Timing of other players' snapshots on the client, DOM-free (RemotePlayers draws with it, the hit
 * registration simulation in tests/helpers/hitregSim.ts runs the very same code).
 *
 * The server sends snapshots at a steady tick, but the page handles a message only when its event loop
 * gets to it (up to a frame late). Stamping samples with the raw arrival time turns that into speed
 * jitter, so each snapshot is stamped on a steady clock (last stamp + whole tick intervals) that drifts
 * slowly towards arrival.
 */

/** Snapshot clock: how much of each arrival-time error is corrected (the rest is jitter of the page's event loop). */
const CLOCK_GAIN = 0.1;
/** A gap this long (or a clock this far off) restarts the snapshot clock at the arrival time. */
const CLOCK_RESET = 0.5;
/** Server ticks remembered for `renderTick` (about a second at 30 Hz). */
const TICK_RING = 32;

export class SnapshotClock {
  private clock = -1;
  private tick = 0.05;
  private lastArrival = -1;
  /** Stamps and server tick numbers of the last snapshots that carried one (ring). */
  private readonly ringT = new Float64Array(TICK_RING);
  private readonly ringK = new Float64Array(TICK_RING);
  private ringHead = -1;
  private ringCount = 0;

  /** The time stamp for a snapshot that arrived at `now`. `serverTick` (when the server sent one) feeds `renderTick`. */
  stamp(now: number, serverTick = -1): number {
    const gap = now - this.lastArrival;
    this.lastArrival = now;
    if (this.clock < 0 || gap > CLOCK_RESET) this.clock = now;
    else {
      // The tick interval is the long-run average gap (one snapshot per server tick; arcade servers tick faster).
      if (gap < 3 * this.tick) this.tick = Math.min(0.2, Math.max(0.004, this.tick + (gap - this.tick) * 0.02));
      // Each snapshot is one tick after the last, however late the page handled it. Far off (the server stalled or
      // skipped, a culled arcade player came back): start again from the arrival time, like the server's own clock.
      const expected = this.clock + this.tick;
      this.clock = Math.abs(now - expected) > 2 * this.tick ? now : expected + (now - expected) * CLOCK_GAIN;
    }
    if (serverTick >= 0) {
      // A tick number that went backwards (server restart, wrap) starts the ring over.
      if (this.ringCount > 0 && serverTick <= this.ringK[this.ringHead]) this.ringCount = 0;
      this.ringHead = (this.ringHead + 1) % TICK_RING;
      this.ringT[this.ringHead] = this.clock;
      this.ringK[this.ringHead] = serverTick;
      if (this.ringCount < TICK_RING) this.ringCount++;
    }
    return this.clock;
  }

  /** Seconds between snapshots (long-run average). */
  get interval(): number {
    return this.tick;
  }

  /**
   * The server tick (fractional) that the snapshots drawn at `renderTime` show: the server rewinds a shot
   * to exactly this moment (lag compensation). −1 when no snapshot carried a tick number.
   */
  renderTick(renderTime: number): number {
    if (this.ringCount === 0) return -1;
    const t = this.ringT, k = this.ringK;
    let newer = this.ringHead;
    // Past the newest snapshot (a late packet): RemotePlayers keeps going for a moment, so does the tick.
    if (renderTime >= t[newer]) return k[newer] + Math.min(renderTime - t[newer], 0.1) / Math.max(0.004, this.tick);
    for (let i = 1; i < this.ringCount; i++) {
      const older = (this.ringHead - i + TICK_RING) % TICK_RING;
      if (t[older] <= renderTime) {
        const span = t[newer] - t[older];
        return span > 0 ? k[older] + ((renderTime - t[older]) / span) * (k[newer] - k[older]) : k[newer];
      }
      newer = older;
    }
    return k[newer];
  }
}

/** One stamped snapshot of a player. */
export interface InterpState { t: number; x: number; y: number; z: number; yaw: number; pitch: number; flags: number }

/** Past the newest snapshot a player keeps moving at its last velocity for at most this long (a late packet), then holds. */
export const MAX_EXTRAPOLATE = 0.1;

/** Result of `interpolate`: the two snapshots to blend and the blend factor (above 1 = extrapolating). */
export interface Span { a: number; c: number; f: number }

/**
 * The two buffer entries around `renderTime` and the blend between them. Past the newest one (a late packet)
 * keep going along the last two for a moment instead of freezing, then hold; before the oldest, hold the oldest.
 */
export function interpolate(b: readonly InterpState[], renderTime: number, out: Span): Span {
  let a = 0, c = b.length - 1;
  let f = 1;
  if (b.length >= 2 && renderTime > b[c].t) {
    a = c - 1;
    const span = b[c].t - b[a].t;
    f = span > 0 ? 1 + Math.min(renderTime - b[c].t, MAX_EXTRAPOLATE) / span : 1;
    // Not across a teleport or respawn.
    if (Math.abs(b[c].x - b[a].x) + Math.abs(b[c].z - b[a].z) > 8) f = 1;
  } else {
    for (let i = 0; i < b.length - 1; i++) {
      if (b[i].t <= renderTime && b[i + 1].t >= renderTime) { a = i; c = i + 1; break; }
    }
    if (b.length < 2 || renderTime < b[0].t) a = c = 0;
    const span = b[c].t - b[a].t;
    f = span > 0 ? Math.min(1, Math.max(0, (renderTime - b[a].t) / span)) : 1;
  }
  out.a = a; out.c = c; out.f = f;
  return out;
}
