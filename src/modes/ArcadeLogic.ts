import type { RosterEntry } from '../net/protocol';
import type { Team } from './GameTypes';
import { PHYSICS } from '../player/Physics';
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

/**
 * Shared client/server numbers: the server validates movement against the same constants the
 * client's `Player` physics uses (see server/anticheat/Movement.ts), so change them together.
 */
/** Highest ground speed (blocks/s) with a weapon of speed modifier `moveSpeed`: always-sprint pace. */
export function arcadeMaxSpeed(moveSpeed: number): number {
  return PHYSICS.SPRINT_SPEED * ARCADE_SPEED_MULT * moveSpeed;
}

/** Server tick rate of arcade rooms (Hz), overridable per server with ARCADE_TICK_HZ. */
export const ARCADE_TICK_HZ = 30;
/** Arcade clients send their position this often (Hz), at most. */
export const ARCADE_POS_HZ = 30;
/** Clamp for the configurable tick rate. */
export const ARCADE_TICK_MIN = 10;
export const ARCADE_TICK_MAX = 60;

/** Other players are drawn this many seconds in the past: two snapshot intervals, so there are always two to blend. */
export function arcadeInterpDelay(tickHz: number): number {
  return 2 / Math.max(ARCADE_TICK_MIN, Math.min(ARCADE_TICK_MAX, tickHz));
}

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

/**
 * Spread multipliers for moving and for being in the air: hip fire pays for them, aiming barely does (that is what the
 * sights are for). Shared with the server (see `shotSpread`), so the crosshair, the tracers and the verdict agree.
 */
export const SPREAD_MOVING = { hip: 1.3, ads: 1.08 } as const;
export const SPREAD_AIR = { hip: 1.4, ads: 1.25 } as const;

/** Cone half-angle (degrees) for the current stance: aiming tightens it, moving and air loosen it (hip fire more than aimed). */
export function currentSpread(w: WeaponDef, ads: number, moving: boolean, airborne: boolean): number {
  const a = Math.min(1, Math.max(0, ads));
  const base = w.spread + (w.adsSpread - w.spread) * a;
  const move = moving ? SPREAD_MOVING.hip + (SPREAD_MOVING.ads - SPREAD_MOVING.hip) * a : 1;
  const air = airborne ? SPREAD_AIR.hip + (SPREAD_AIR.ads - SPREAD_AIR.hip) * a : 1;
  return base * move * air;
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

  private burstLeft = 0;
  private burstStart = 0;

  /**
   * Burst weapons: one press fires `count` shots `interval` apart; the next burst may start
   * `cycleSec` after the first shot. Returns true for every shot that goes out now.
   */
  tryBurst(now: number, interval: number, count: number, cycleSec: number, pressed: boolean): boolean {
    if (now < this.nextAt) return false;
    if (this.burstLeft > 0) {
      this.burstLeft--;
      this.nextAt = this.burstLeft > 0 ? now + interval : Math.max(now + interval, this.burstStart + cycleSec);
      return true;
    }
    if (!pressed) return false;
    this.burstStart = now;
    this.burstLeft = count - 1;
    this.nextAt = this.burstLeft > 0 ? now + interval : now + cycleSec;
    return true;
  }

  /** Drops the rest of a burst (the magazine ran dry mid-burst: it must not finish by itself after the reload). */
  cancelBurst(): void {
    this.burstLeft = 0;
  }

  /** Block the trigger for a while (weapon switch, reload). */
  delay(now: number, seconds: number): void {
    this.nextAt = Math.max(this.nextAt, now + seconds);
    this.burstLeft = 0;
  }

  reset(): void {
    this.nextAt = 0;
    this.burstLeft = 0;
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
  return [...players].sort((a, b) => (b.pts ?? 0) - (a.pts ?? 0) || b.kills - a.kills || a.deaths - b.deaths || a.name.localeCompare(b.name));
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

// ---------------------------------------------------------------- scope sway and breath

/** Seconds of breath a full lung holds the scope steady, and the recovery after running out. */
export const BREATH_HOLD_SEC = 4;
export const BREATH_SPENT_SEC = 2.5;
/** Breath comes back this fast (fraction per second) when not holding. */
export const BREATH_REGEN = 0.35;
/** Sway amplitude through a scope (degrees): idle, holding the breath, out of breath, moving (multiplier). */
export const SCOPE_SWAY = { idle: 0.24, held: 0.035, spent: 0.55, moving: 1.6 } as const;
/**
 * Quickscope window: right after the scope comes up the sway is only SCOPE_SETTLE.start of its amplitude, growing to the
 * full amplitude between `calm` and `full` seconds scoped. A fast scope-in and shot lands where the reticle is; camping
 * in the scope needs the breath (Shift). QA round 3: "snipers are bad" (0.32° sway at once missed heads at 40 blocks).
 */
export const SCOPE_SETTLE = { start: 0.2, calm: 0.45, full: 1.4 } as const;

/** Sway amplitude share after `scoped` seconds in the scope (SCOPE_SETTLE). */
export function scopeSettle(scoped: number): number {
  const { start, calm, full } = SCOPE_SETTLE;
  if (scoped <= calm) return start;
  return Math.min(1, start + ((scoped - calm) / (full - calm)) * (1 - start));
}

/**
 * Scope sway with breath control (hold Shift): holding steadies the aim for up to BREATH_HOLD_SEC, then the
 * shooter gasps and sways harder for BREATH_SPENT_SEC. `amp` is the current sway amplitude in degrees; the
 * caller turns it into a figure-eight drift with {@link swayOffset}. Pure state, no allocations.
 */
export class ScopeBreath {
  /** 0..1 breath left. */
  breath = 1;
  holding = false;
  /** Out of breath until this time (seconds). */
  spentUntil = 0;
  amp: number = SCOPE_SWAY.idle * SCOPE_SETTLE.start;
  /** Seconds in the scope without a break (the quickscope window). */
  scopedFor = 0;
  private now = 0;

  /** Returns 'hold' / 'release' when the breath sound should play this frame, else ''. */
  update(dt: number, now: number, scoped: boolean, wantHold: boolean, moving: boolean): '' | 'hold' | 'release' {
    this.now = now;
    const spent = now < this.spentUntil;
    const hold = scoped && wantHold && !spent && this.breath > 0;
    let cue: '' | 'hold' | 'release' = '';
    if (hold && !this.holding) cue = 'hold';
    if (!hold && this.holding) cue = 'release';
    this.holding = hold;
    if (hold) {
      this.breath = Math.max(0, this.breath - dt / BREATH_HOLD_SEC);
      if (this.breath === 0) {
        this.spentUntil = now + BREATH_SPENT_SEC;
        this.holding = false;
        cue = 'release';
      }
    } else if (!spent) this.breath = Math.min(1, this.breath + dt * BREATH_REGEN);
    this.scopedFor = scoped ? this.scopedFor + dt : 0;
    const settle = this.holding ? 1 : scopeSettle(this.scopedFor);
    const target = (this.holding ? SCOPE_SWAY.held : now < this.spentUntil ? SCOPE_SWAY.spent : SCOPE_SWAY.idle * settle) * (moving ? SCOPE_SWAY.moving : 1);
    // Out of the scope the amplitude snaps back to the calm start, so the next scope-in is steady at once.
    if (!scoped) this.amp = SCOPE_SWAY.idle * SCOPE_SETTLE.start;
    else this.amp += (target - this.amp) * Math.min(1, dt * 6);
    return cue;
  }

  /** Out of breath right now (the meter shows it). */
  get spent(): boolean {
    return this.now < this.spentUntil;
  }

  reset(): void {
    this.breath = 1;
    this.holding = false;
    this.spentUntil = 0;
    this.scopedFor = 0;
    this.amp = SCOPE_SWAY.idle * SCOPE_SETTLE.start;
  }
}

/** Sway offset (degrees) at time `t` for amplitude `amp`: a slow figure-eight, written into `out`. */
export function swayOffset(t: number, amp: number, out: { x: number; y: number }): void {
  out.x = amp * Math.sin(t * 0.83);
  out.y = amp * Math.sin(t * 1.66 + 0.6) * 0.6;
}

// ---------------------------------------------------------------- recoil

/** Shortest pause after a shot before the aim recovers. */
export const RECOIL_REST_SEC = 0.09;

/**
 * Aim recoil: every shot climbs the aim by `recoil × AIM_CLIMB` degrees (less when aiming) and drifts it
 * sideways by the weapon's pattern; after the trigger lets go most of the climb comes back down.
 * `kick` returns the pitch/yaw change (degrees) to apply for a shot; `recover` the change for a frame.
 */
export class RecoilState {
  private shot = 0;
  private lastShotAt = -1e9;
  /** Seconds without a shot before the aim starts to come back down (the trigger rests). */
  private restAfter = RECOIL_REST_SEC;
  /** Climb (degrees) still to recover. */
  private climb = 0;
  readonly out = { pitch: 0, yaw: 0 };

  /**
   * `interval` is an automatic weapon's time between shots: the aim only recovers after a pause longer than that, so a
   * held trigger keeps climbing (the 600 rpm rifle fires every 0.1 s, more than the old fixed 0.09 s rest, and
   * recovered between every shot of a spray: QA round 2).
   */
  kick(
    now: number, recoil: number, recoilX: number, pattern: readonly number[], ads: number, climbPerRecoil: number, interval = 0,
  ): { pitch: number; yaw: number } {
    if (now - this.lastShotAt > 0.35) this.shot = 0;
    this.lastShotAt = now;
    this.restAfter = Math.max(RECOIL_REST_SEC, interval * 1.3);
    const k = 1 - 0.3 * Math.min(1, Math.max(0, ads));
    const up = recoil * climbPerRecoil * k;
    this.out.pitch = up;
    this.out.yaw = pattern.length ? pattern[this.shot % pattern.length] * recoilX * k : 0;
    this.shot++;
    this.climb += up * 0.7;
    return this.out;
  }

  /** Pitch change (degrees, negative = down) for this frame: recovers once the shooting stops. */
  recover(now: number, dt: number): number {
    if (this.climb <= 1e-4 || now - this.lastShotAt < this.restAfter) return 0;
    const r = this.climb * Math.min(1, dt * 9);
    this.climb -= r;
    return -r;
  }

  reset(): void {
    this.shot = 0;
    this.climb = 0;
    this.lastShotAt = -1e9;
  }
}
