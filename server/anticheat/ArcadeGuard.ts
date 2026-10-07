import { arcadeMaxSpeed } from '../../src/modes/ArcadeLogic';
import { type MovementWorld, MovementValidator, type Rule } from './Movement';

/**
 * Movement enforcement for one arcade room: a validator per player, strikes that decay over time,
 * and the decision to correct, kick or ban. Knows nothing about sockets (GameServer acts on the result).
 */

export const STRIKES = {
  /** Strike points forgotten per second. */
  DECAY_PER_SECOND: 0.2,
  /** Kick at this many points (a noclip attempt is 3, a speed violation 1). */
  KICK_AT: 10,
  /** A player kicked this often within BAN_WINDOW is banned from the room. */
  BAN_AFTER_KICKS: 3,
  BAN_WINDOW_SECONDS: 30 * 60,
  /** Corrections forgiven as lag (decaying like strikes) before they count as strikes of weight 1. */
  LAG_EXCUSES: 4,
  /** Ignoring a rubber band (the client keeps reporting far away) costs this per resent teleport. */
  IGNORED_TELEPORT: 1,
} as const;

/** Points that decay linearly with time. */
export class Strikes {
  private points = 0;
  private at = 0;

  value(now: number): number {
    this.points = Math.max(0, this.points - (now - this.at) * STRIKES.DECAY_PER_SECOND);
    this.at = now;
    return this.points;
  }

  add(w: number, now: number): number {
    this.value(now);
    this.points += w;
    return this.points;
  }
}

export type MoveResult =
  | { ok: true }
  | { ok: false; rule: GuardRule; strikes: number; lag: boolean; action: 'correct' | 'kick' | 'ban' };

export type GuardRule = Rule | 'ignored-teleport' | 'bounds';

interface Tracked {
  name: string;
  validator: MovementValidator;
  strikes: Strikes;
  lagPoints: Strikes;
  violations: number;
}

export class ArcadeGuard {
  private readonly players = new Map<number, Tracked>();
  /** Kick times per lower-case name (survives reconnects, not restarts). */
  private readonly kicks = new Map<string, number[]>();

  constructor(private readonly world: MovementWorld, private readonly inBounds: (x: number, z: number) => boolean) {}

  join(id: number, name: string): void {
    this.players.set(id, {
      name, strikes: new Strikes(), lagPoints: new Strikes(), violations: 0,
      validator: new MovementValidator(this.world, { maxSpeed: arcadeMaxSpeed(1), inBounds: this.inBounds }),
    });
  }

  leave(id: number): void {
    this.players.delete(id);
  }

  /** The server put the player here (spawn, teleport, rubber band arrived). */
  reset(id: number, x: number, y: number, z: number, now: number): void {
    this.players.get(id)?.validator.reset(x, y, z, now);
  }

  /** The weapon in the hands (and the perk) decides the speed limit. */
  setMoveSpeed(id: number, moveSpeed: number, now: number): void {
    this.players.get(id)?.validator.setMaxSpeed(arcadeMaxSpeed(moveSpeed), now);
  }

  /** Has this player started an accepted slide recently enough to still be sliding? */
  sliding(id: number): boolean {
    return this.players.get(id)?.validator.slideActive ?? false;
  }

  /** Seconds between two slides for this player (the perk of this life). */
  setSlideCooldown(id: number, seconds: number): void {
    this.players.get(id)?.validator.setSlideCooldown(seconds);
  }

  strikes(id: number, now: number): number {
    return this.players.get(id)?.strikes.value(now) ?? 0;
  }

  violations(id: number): number {
    return this.players.get(id)?.violations ?? 0;
  }

  /**
   * Checks a position report (`step`: the client's physics clock, `slide`: the step of its latest slide start,
   * when sent); on failure the caller rubber-bands to `lastValid`.
   */
  move(id: number, x: number, y: number, z: number, now: number, step?: number, slide?: number): MoveResult {
    const p = this.players.get(id);
    if (!p) return { ok: true };
    const v = p.validator.check(x, y, z, now, step, slide);
    if (v.ok) return v;
    return this.strike(p, v.rule, v.weight, v.lag, now);
  }

  /** The client did not follow a rubber band (it keeps reporting positions far from it). */
  ignoredTeleport(id: number, now: number): MoveResult {
    const p = this.players.get(id);
    if (!p) return { ok: true };
    return this.strike(p, 'ignored-teleport', STRIKES.IGNORED_TELEPORT, false, now);
  }

  /** A violation found outside the validator (e.g. a position outside the arena). */
  flag(id: number, rule: GuardRule, weight: number, now: number): MoveResult {
    const p = this.players.get(id);
    if (!p) return { ok: true };
    return this.strike(p, rule, weight, false, now);
  }

  lastValid(id: number): { x: number; y: number; z: number } | null {
    const p = this.players.get(id);
    return p ? { x: p.validator.x, y: p.validator.y, z: p.validator.z } : null;
  }

  private strike(p: Tracked, rule: GuardRule, weight: number, lag: boolean, now: number): MoveResult {
    p.violations++;
    // Lag excuses a few corrections, not a steady stream of them.
    if (lag && p.lagPoints.add(1, now) > STRIKES.LAG_EXCUSES) { lag = false; weight = 1; }
    const strikes = p.strikes.add(weight, now);
    let action: 'correct' | 'kick' | 'ban' = 'correct';
    if (strikes >= STRIKES.KICK_AT) {
      const key = p.name.toLowerCase();
      const list = (this.kicks.get(key) ?? []).filter((t) => now - t < STRIKES.BAN_WINDOW_SECONDS);
      list.push(now);
      this.kicks.set(key, list);
      action = list.length >= STRIKES.BAN_AFTER_KICKS ? 'ban' : 'kick';
    }
    return { ok: false, rule, strikes, lag, action };
  }
}
