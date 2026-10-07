import { SHARPSHOOTER_POOL } from '../../src/modes/GameTypes';
import type { ModeState } from '../../src/net/protocol';
import type { Match } from '../Match';
import { BaseLogic, type BotGoal, type Kit } from './ModeLogic';

/** The sidearm everybody carries next to the rotating weapon. */
export const SHARPSHOOTER_SECONDARY = 'pistol';

/**
 * Sharpshooter: free for all where nobody picks a weapon. Everybody carries the same random primary
 * (from `SHARPSHOOTER_POOL`, never the same one twice in a row) plus a pistol and the knife, and every
 * `params.rotateSec` seconds the weapon changes for everyone at once (full magazines). Kills score; first to
 * the score limit, or the most kills at the horn, wins.
 */
export class SharpshooterLogic extends BaseLogic {
  private weapon = SHARPSHOOTER_POOL[0];
  private switchAt = 0;

  /** The weapon everybody holds now. */
  get current(): string {
    return this.weapon;
  }

  private pick(m: Match, not: string): string {
    const pool = SHARPSHOOTER_POOL.filter((w) => w !== not);
    return pool[Math.min(pool.length - 1, Math.floor(m.random() * pool.length))];
  }

  onStart(m: Match, now: number): void {
    this.weapon = this.pick(m, '');
    this.switchAt = now + (m.def.params?.rotateSec ?? 45);
    m.startLive();
  }

  onReset(): void {
    this.weapon = SHARPSHOOTER_POOL[0];
    this.switchAt = 0;
  }

  loadoutFor(): Kit {
    return { primary: this.weapon, secondary: SHARPSHOOTER_SECONDARY, melee: 'knife' };
  }

  onTick(m: Match, _dt: number, now: number): void {
    if (m.phase !== 'live' || now < this.switchAt) return;
    this.weapon = this.pick(m, this.weapon);
    this.switchAt = now + (m.def.params?.rotateSec ?? 45);
    for (const p of m.players.values()) if (p.alive) m.giveGear(p, this.weapon, SHARPSHOOTER_SECONDARY, 'knife');
    m.event('weapon-rotate', '', 0, this.weapon);
    m.markModeDirty();
  }

  onKill(): void {
    // Free for all: the kill counter is the score.
  }

  modeState(m: Match): ModeState {
    const left = m.phase === 'live' ? Math.max(0, Math.round((this.switchAt - m.now()) * 10) / 10) : 0;
    return { kind: 'roulette', weapon: this.weapon, switchIn: left };
  }

  /** No objective: bots just fight (with the same weapon as everybody). */
  objectives(): BotGoal[] {
    return [];
  }
}
