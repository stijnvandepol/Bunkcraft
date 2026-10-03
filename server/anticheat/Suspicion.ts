import { angleDeg } from './AimCheck';

/**
 * Aim anomaly statistics per player (DOM-free). Nothing here bans anybody: the score is logged,
 * counted in /metrics and shown on the admin page, and only kicks when ARCADE_AUTOKICK_SCORE is set.
 *
 * Signals over the last WINDOW shots:
 *  - headshot ratio of the hits,
 *  - accuracy at long range (the enemy closest to the aim further than FAR blocks),
 *  - snap hits: the aim turned more than SNAP_DEG within SNAP_SECONDS since the previous shot and hit,
 *  - mismatch: the fire direction differs more than MISMATCH_DEG from the view the last position
 *    report announced (an aimbot that only rewrites the fire message, not the camera).
 */
export const SUSPICION = {
  WINDOW: 40,
  FAR: 30,
  SNAP_DEG: 20,
  SNAP_SECONDS: 0.25,
  /** Degrees per second between two shots that both count (a flick of 20+ degrees that lands). */
  SNAP_RATE: 600,
  MISMATCH_DEG: 25,
  /** Log a warning at this score. */
  WARN_AT: 50,
} as const;

export interface ShotSample {
  now: number;
  /** Unit fire direction. */
  dx: number; dy: number; dz: number;
  /** Unit view direction of the last position report, or null when unknown. */
  view: [number, number, number] | null;
  /** Distance to the enemy closest to the aim line (NaN when there is none). */
  targetDist: number;
  hit: boolean;
  head: boolean;
}

export interface SuspicionReport {
  score: number;
  shots: number;
  hits: number;
  headRatio: number;
  farAccuracy: number;
  snapRatio: number;
  mismatchRatio: number;
}

interface Entry { hit: boolean; head: boolean; far: boolean; snap: boolean; mismatch: boolean }

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export class AimStats {
  private readonly ring: Entry[] = [];
  private head = 0;
  private lastDir: [number, number, number] | null = null;
  private lastAt = 0;
  /** Last score that was logged (avoid repeating the warning). */
  warnedAt = -1e9;

  shot(s: ShotSample): void {
    let snap = false;
    if (this.lastDir && s.now - this.lastAt <= SUSPICION.SNAP_SECONDS) {
      const a = angleDeg(this.lastDir[0], this.lastDir[1], this.lastDir[2], s.dx, s.dy, s.dz);
      const rate = a / Math.max(0.02, s.now - this.lastAt);
      snap = s.hit && a >= SUSPICION.SNAP_DEG && rate >= SUSPICION.SNAP_RATE;
    }
    const mismatch = s.view !== null && angleDeg(s.view[0], s.view[1], s.view[2], s.dx, s.dy, s.dz) > SUSPICION.MISMATCH_DEG;
    const e: Entry = { hit: s.hit, head: s.hit && s.head, far: s.targetDist > SUSPICION.FAR, snap, mismatch };
    if (this.ring.length < SUSPICION.WINDOW) this.ring.push(e);
    else { this.ring[this.head] = e; this.head = (this.head + 1) % SUSPICION.WINDOW; }
    this.lastDir = [s.dx, s.dy, s.dz];
    this.lastAt = s.now;
  }

  report(): SuspicionReport {
    let hits = 0, heads = 0, far = 0, farHits = 0, snaps = 0, mism = 0;
    for (const e of this.ring) {
      if (e.hit) hits++;
      if (e.head) heads++;
      if (e.far) { far++; if (e.hit) farHits++; }
      if (e.snap) snaps++;
      if (e.mismatch) mism++;
    }
    const shots = this.ring.length;
    const headRatio = hits ? heads / hits : 0;
    const farAccuracy = far ? farHits / far : 0;
    const snapRatio = hits ? snaps / hits : 0;
    const mismatchRatio = shots ? mism / shots : 0;
    let score = 0;
    if (hits >= 15) score += clamp01((headRatio - 0.5) / 0.4) * 30;
    if (far >= 10) score += clamp01((farAccuracy - 0.6) / 0.35) * 20;
    if (hits >= 10) score += clamp01((snapRatio - 0.1) / 0.3) * 30;
    if (shots >= 15) score += clamp01((mismatchRatio - 0.15) / 0.35) * 20;
    return { score: Math.round(score), shots, hits, headRatio, farAccuracy, snapRatio, mismatchRatio };
  }
}
