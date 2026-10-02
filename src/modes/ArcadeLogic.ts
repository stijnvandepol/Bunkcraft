import type { RosterEntry } from '../net/protocol';
import type { Team } from './GameTypes';
import type { WeaponDef } from './Weapons';

/**
 * Pure helpers for the arcade client (no DOM, no three.js): the HUD, the fire control and the
 * session use them, and the unit tests cover them.
 */

/** Always-sprint: arcade movement is this much faster than Minecraft's sprint, before the weapon modifier. */
export const ARCADE_SPEED_MULT = 1.3;
/** Air acceleration while bunny hopping (Minecraft's is 4.5): more steering in the air. */
export const ARCADE_AIR_ACCEL = 8;
/** Seconds of spawn protection shown after (re)spawning. */
export const SPAWN_PROTECTION = 2;

// ---------------------------------------------------------------- crosshair

/**
 * Radius in screen pixels of the circle a bullet can land in, for a cone half-angle `spreadDeg`
 * seen through a camera with vertical field of view `fovDeg` on a viewport `height` pixels tall.
 */
export function spreadPixels(spreadDeg: number, fovDeg: number, height: number): number {
  const half = Math.tan((fovDeg * Math.PI) / 360);
  if (half <= 0) return 0;
  return (Math.tan((spreadDeg * Math.PI) / 180) / half) * (height / 2);
}

/** Cone half-angle (degrees) for the current stance: aiming tightens it, moving and air loosen it. */
export function currentSpread(w: WeaponDef, ads: number, moving: boolean, airborne: boolean): number {
  const base = w.spread + (w.adsSpread - w.spread) * Math.min(1, Math.max(0, ads));
  const penalty = (moving ? 1.15 : 1) * (airborne ? 1.4 : 1);
  return base * penalty;
}

// ---------------------------------------------------------------- fire control

/**
 * Throttles the trigger to the weapon's fire rate. Semi-automatic weapons need a fresh click per
 * shot, automatic ones keep firing while the button is held. Times are in seconds.
 */
export class FireControl {
  private nextAt = 0;

  /** True when a shot may go out now; the caller fires and the next one waits `interval`. */
  tryFire(now: number, interval: number, auto: boolean, held: boolean, pressed: boolean): boolean {
    if (!(auto ? held : pressed)) return false;
    if (now < this.nextAt) return false;
    // Keep the rhythm while the button stays down (late frames do not slow the average rate), but
    // after a pause start a fresh interval so there is no burst.
    this.nextAt = now - this.nextAt > interval ? now + interval : this.nextAt + interval;
    return true;
  }

  /** Block the trigger for a while (weapon switch, reload). */
  delay(now: number, seconds: number): void {
    this.nextAt = Math.max(this.nextAt, now + seconds);
  }

  reset(): void {
    this.nextAt = 0;
  }
}

// ---------------------------------------------------------------- damage direction

/**
 * Angle of a damage source relative to the view, for the indicator around the crosshair.
 * (dx, dz) points from the player towards the source in world space; `yaw` is the player's yaw
 * (forward = (−sin yaw, −cos yaw)). Result in radians: 0 = ahead (indicator on top),
 * π/2 = right, ±π = behind, −π/2 = left.
 */
export function damageAngle(dx: number, dz: number, yaw: number): number {
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
  const rx = Math.cos(yaw), rz = -Math.sin(yaw);
  return Math.atan2(rx * dx + rz * dz, fx * dx + fz * dz);
}

// ---------------------------------------------------------------- scoreboard

/** Scoreboard order: most kills first, then fewest deaths, then name. Does not modify the input. */
export function sortRoster(players: readonly RosterEntry[]): RosterEntry[] {
  return [...players].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths || a.name.localeCompare(b.name));
}

/** Total kills per team from the roster (the server also sends these in `match.scores`). */
export function teamKills(players: readonly RosterEntry[]): { red: number; blue: number } {
  const t = { red: 0, blue: 0 };
  for (const p of players) if (p.team) t[p.team] += p.kills;
  return t;
}

export function kdRatio(kills: number, deaths: number): string {
  return (deaths === 0 ? kills : kills / deaths).toFixed(2);
}

/** "m:ss" for the match timer; negative values count as zero. */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- kill feed

export interface KillFeedEntry {
  killer: string;
  victim: string;
  killerTeam: Team | '';
  victimTeam: Team | '';
  weapon: string;
  head: boolean;
  /** Time (s) the entry was added. */
  born: number;
}

export const KILL_FEED_LIFETIME = 6;
export const KILL_FEED_MAX = 6;

/** The newest kills, expiring after a few seconds. */
export class KillFeed {
  readonly entries: KillFeedEntry[] = [];

  add(entry: KillFeedEntry): void {
    this.entries.push(entry);
    if (this.entries.length > KILL_FEED_MAX) this.entries.shift();
  }

  /** Drops expired entries; true when the list changed. */
  prune(now: number): boolean {
    let n = 0;
    while (n < this.entries.length && now - this.entries[n].born > KILL_FEED_LIFETIME) n++;
    if (n > 0) this.entries.splice(0, n);
    return n > 0;
  }

  clear(): void {
    this.entries.length = 0;
  }
}

// ---------------------------------------------------------------- bullet impacts

/**
 * Face normal of the block a bullet ended on: the axis along which the end point lies closest
 * to a block boundary, pointing back against the bullet's direction.
 */
export function impactNormal(
  ex: number, ey: number, ez: number, dx: number, dy: number, dz: number, out: { x: number; y: number; z: number },
): void {
  const fx = Math.abs(ex - Math.round(ex)), fy = Math.abs(ey - Math.round(ey)), fz = Math.abs(ez - Math.round(ez));
  out.x = out.y = out.z = 0;
  if (fx <= fy && fx <= fz) out.x = dx > 0 ? -1 : 1;
  else if (fy <= fz) out.y = dy > 0 ? -1 : 1;
  else out.z = dz > 0 ? -1 : 1;
}

// ---------------------------------------------------------------- misc

/** Weapon slot (0 primary, 1 secondary, 2 melee) to the next slot, skipping nothing. */
export function cycleSlot(slot: number, delta: number): 0 | 1 | 2 {
  return (((slot + delta) % 3) + 3) % 3 as 0 | 1 | 2;
}

/** Reload progress 0..1 from the time since it began. */
export function reloadProgress(elapsed: number, reloadSec: number): number {
  return reloadSec <= 0 ? 1 : Math.min(1, Math.max(0, elapsed / reloadSec));
}

/** After dying the camera follows the killer for this long, then the player cycles through the others. */
export const SPECTATE_KILLER_SECONDS = 1;

/** Players that may be spectated: everybody else (ffa) or the teammates (tdm), alive ones only. */
export function spectateCandidates(
  players: Iterable<[number, { team: string }]>, selfId: number, selfTeam: string, teams: boolean, isAlive: (id: number) => boolean, out: number[],
): number[] {
  out.length = 0;
  for (const [id, p] of players) {
    if (id === selfId || (teams && p.team !== selfTeam) || !isAlive(id)) continue;
    out.push(id);
  }
  return out;
}

/** The next (dir 1) or previous (dir -1) candidate, wrapping; the first/last one when `current` is not in the list; 0 when empty. */
export function cycleTarget(candidates: readonly number[], current: number, dir: 1 | -1): number {
  const n = candidates.length;
  if (n === 0) return 0;
  const i = candidates.indexOf(current);
  return candidates[i < 0 ? (dir > 0 ? 0 : n - 1) : (i + dir + n) % n];
}
