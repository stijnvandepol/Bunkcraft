import { HITBOX } from '../../src/modes/Weapons';
import { type BlockQuery, traceBlocks } from '../Combat';

/**
 * Lag compensation limits for hitscan (DOM-free). The server tests a shot against where the shooter saw the
 * targets. The client says which server tick its screen showed (`rk` in `fire`, see SnapshotClock.renderTick);
 * that claim is clamped to what its round trip and interpolation delay can explain. Older clients get an estimate
 * from the measured round trip. A target that had already been behind cover for PEEK_LIMIT seconds cannot be
 * rewound back into the open ("shot around the corner").
 *
 * Why the full round trip: the snapshot the shooter looks at left the server half a round trip before it arrived,
 * is drawn `interp` later, and the shot needs another half round trip to come back. Rewinding only half the round
 * trip (the old rule) put a running target 0.3-0.5 blocks ahead of where it was drawn at 100 ms.
 */

/** Never rewind further than this (s): covers a 250 ms round trip plus the interpolation delay. */
export const MAX_REWIND = 0.4;
/** Without a ping measurement, rewind only the interpolation delay. */
export const DEFAULT_REWIND = 0.1;
/** Rewinds longer than this need the victim to have been visible at `now - PEEK_LIMIT`. */
export const PEEK_LIMIT = 0.15;
/** A client's claimed render time may lie this much further back than its measured round trip explains (jitter). */
export const REWIND_SLACK = 0.08;

/** Seconds to rewind for a shooter with round-trip time `rttMs` (0 = unknown) and interpolation delay `interp`. */
export function rewindWindow(rttMs: number, interp = DEFAULT_REWIND): number {
  if (!(rttMs > 0)) return Math.min(MAX_REWIND, interp);
  return Math.min(MAX_REWIND, rttMs / 1000 + interp);
}

/** How far back a client's own render-time claim may reach (anti backtracking). */
export function rewindLimit(rttMs: number, interp = DEFAULT_REWIND): number {
  if (!(rttMs > 0)) return MAX_REWIND;
  return Math.min(MAX_REWIND, rttMs / 1000 + interp + REWIND_SLACK);
}

/** Heights (above the feet) of the three body points used for line of sight. */
export const BODY_POINTS = [0.2, HITBOX.height / 2, HITBOX.height - HITBOX.head / 2] as const;

/** Can a bullet from (ox, oy, oz) reach any of the three body points of a player standing at (x, y, z)? */
export function bodyVisible(blocks: BlockQuery, ox: number, oy: number, oz: number, x: number, y: number, z: number): boolean {
  for (const h of BODY_POINTS) {
    const dx = x - ox, dy = y + h - oy, dz = z - oz;
    const d = Math.hypot(dx, dy, dz);
    if (d < 1e-6) return true;
    if (traceBlocks(blocks, ox, oy, oz, dx / d, dy / d, dz / d, d) >= d - 1e-6) return true;
  }
  return false;
}
