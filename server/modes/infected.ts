import type { Team } from '../../src/modes/GameTypes';
import type { Spawn } from '../../src/modes/maps';
import type { WeaponDef } from '../../src/modes/Weapons';
import type { ModeState } from '../../src/net/protocol';
import type { Match, MatchPlayer } from '../Match';
import { BaseLogic, type BotGoal, type Kit, type MatchResult } from './ModeLogic';

/** Team of the survivors and of the infected (the team colours carry the roles; see `GameTypeDef.teamRoles`). */
export const SURVIVORS: Team = 'blue';
export const INFECTED: Team = 'red';
/** A survivor earns a point for every this many seconds alive after the outbreak. */
export const SURVIVE_POINT_SEC = 10;

const KNIFE_KIT: Kit = { primary: 'knife', secondary: 'knife', melee: 'knife' };

/**
 * Infected: everybody starts as a survivor with their own class. `params.outbreakSec` after the start one
 * random survivor turns: the infected carry only a knife, run `params.infectedSpeed` times faster and stab
 * for `params.knifeMul` times the damage (one stab kills). A survivor who dies joins the infected for the rest
 * of the match; so does anyone who joins after the outbreak. The last survivor is announced, gets
 * `params.lastBonus` points and runs as fast as the infected.
 *
 * The infected win as soon as no survivor is left; the survivors win when the clock runs out. Points
 * (`MatchPlayer.pts`): a kill is a point for either side, and survivors earn a point per `SURVIVE_POINT_SEC`
 * seconds alive. The mode moves players between teams itself, so Match does not balance the teams.
 */
export class InfectedLogic extends BaseLogic {
  readonly keepTeams = true;
  private outbreakAt = 0;
  private outbroken = false;
  private lastId = 0;
  private nextPointAt = 0;

  /** Whether the first player turned already. */
  get started(): boolean {
    return this.outbroken;
  }

  get lastSurvivor(): number {
    return this.lastId;
  }

  private params(m: Match) {
    const p = m.def.params ?? {};
    return { outbreakSec: p.outbreakSec ?? 8, speed: p.infectedSpeed ?? 1.12, knifeMul: p.knifeMul ?? 2, lastBonus: p.lastBonus ?? 3 };
  }

  onStart(m: Match, now: number): void {
    this.clear(m);
    this.outbreakAt = now + this.params(m).outbreakSec;
    m.startLive();
  }

  onReset(m: Match): void {
    this.clear(m);
  }

  private clear(m: Match): void {
    this.outbroken = false;
    this.lastId = 0;
    for (const p of m.players.values()) p.team = SURVIVORS;
  }

  teamFor(m: Match): Team {
    return this.outbroken && m.phase === 'live' ? INFECTED : SURVIVORS;
  }

  canStart(m: Match): boolean {
    return m.players.size >= 2;
  }

  loadoutFor(_m: Match, p: MatchPlayer): Kit | undefined {
    return this.outbroken && p.team === INFECTED ? KNIFE_KIT : undefined;
  }

  speedMul(m: Match, p: MatchPlayer): number {
    return (this.outbroken && p.team === INFECTED) || (p.id !== 0 && p.id === this.lastId) ? this.params(m).speed : 1;
  }

  damageMul(m: Match, attacker: MatchPlayer, _victim: MatchPlayer, weapon: WeaponDef): number {
    return attacker.team === INFECTED && weapon.slot === 'melee' ? this.params(m).knifeMul : 1;
  }

  /** Any spawn, as far as possible from the living players of the other side (before the outbreak: from everybody). */
  pickSpawn(m: Match, p: MatchPlayer): Spawn | null {
    const list = m.map.spawns.ffa;
    let best = list[0], bestScore = -Infinity;
    for (const s of list) {
      let nearest = 1000;
      for (const o of m.players.values()) {
        if (o === p || !o.alive || (this.outbroken && o.team === p.team)) continue;
        nearest = Math.min(nearest, Math.hypot(s.x - o.x, s.z - o.z));
      }
      const score = nearest + m.random() * 4;
      if (score > bestScore) { bestScore = score; best = s; }
    }
    return best;
  }

  /** The team scores show the head counts: survivors (blue) and infected (red). */
  private syncScores(m: Match): void {
    m.scores.blue = m.teamSize(SURVIVORS);
    m.scores.red = m.teamSize(INFECTED);
  }

  onTick(m: Match, _dt: number, now: number): void {
    if (m.phase !== 'live') return;
    this.syncScores(m);
    if (!this.outbroken) {
      if (now >= this.outbreakAt) this.outbreak(m, now);
      return;
    }
    // Every infected left: somebody else turns, or nobody would ever hunt again.
    if (m.teamSize(INFECTED) === 0 && m.teamSize(SURVIVORS) >= 2) this.turnRandom(m, 'outbreak');
    if (now >= this.nextPointAt) {
      this.nextPointAt += SURVIVE_POINT_SEC;
      let any = false;
      for (const p of m.players.values()) if (p.alive && p.team === SURVIVORS) { p.pts++; any = true; }
      if (any) m.broadcastRoster();
    }
  }

  private outbreak(m: Match, now: number): void {
    this.outbroken = true;
    this.nextPointAt = now + SURVIVE_POINT_SEC;
    this.turnRandom(m, 'outbreak');
  }

  /** A random living survivor turns on the spot. */
  private turnRandom(m: Match, kind: 'outbreak'): void {
    const pool = [...m.players.values()].filter((p) => p.team === SURVIVORS && p.alive);
    if (pool.length === 0) return;
    const p = pool[Math.min(pool.length - 1, Math.floor(m.random() * pool.length))];
    this.turn(m, p);
    m.event(kind, INFECTED, p.id, p.name);
    this.checkLast(m);
  }

  /** Makes a player infected; a living one swaps to the knife at once. */
  private turn(m: Match, p: MatchPlayer): void {
    p.team = INFECTED;
    if (p.id === this.lastId) this.lastId = 0;
    if (p.alive) m.giveGear(p, KNIFE_KIT.primary, KNIFE_KIT.secondary, KNIFE_KIT.melee);
    m.broadcastRoster();
    m.markModeDirty();
  }

  onKill(m: Match, killer: MatchPlayer | null, victim: MatchPlayer): void {
    if (killer && killer !== victim) killer.pts++;
    if (m.phase !== 'live' || !this.outbroken || victim.team !== SURVIVORS) return;
    // The victim comes back as one of them (the respawn hands out the knife).
    victim.team = INFECTED;
    if (victim.id === this.lastId) this.lastId = 0;
    m.event('infected', INFECTED, victim.id, victim.name);
    m.markModeDirty();
    this.syncScores(m);
    this.checkLast(m);
  }

  onLeave(m: Match, p: MatchPlayer): void {
    if (m.phase === 'warmup' || m.phase === 'ended') return;
    if (p.id === this.lastId) this.lastId = 0;
    if (m.players.size < 2) m.returnToWarmup();
    else this.checkLast(m);
    m.markModeDirty();
  }

  /** One survivor left: announce them, hand out the bonus. */
  private checkLast(m: Match): void {
    if (!this.outbroken || this.lastId) return;
    const left = [...m.players.values()].filter((p) => p.team === SURVIVORS);
    if (left.length !== 1 || m.players.size < 3) return;
    const p = left[0];
    this.lastId = p.id;
    p.pts += this.params(m).lastBonus;
    m.event('last-survivor', SURVIVORS, p.id, p.name);
    m.broadcastRoster();
    m.markModeDirty();
  }

  checkEnd(m: Match): MatchResult | null {
    if (!this.outbroken) return null;
    return m.teamSize(SURVIVORS) === 0 ? { winnerTeam: INFECTED, winnerId: 0 } : null;
  }

  winner(m: Match): MatchResult {
    return { winnerTeam: m.teamSize(SURVIVORS) > 0 ? SURVIVORS : INFECTED, winnerId: 0 };
  }

  scoreText(m: Match): string {
    const n = m.teamSize(SURVIVORS);
    return this.outbroken ? `${n} ${n === 1 ? 'survivor' : 'survivors'} left` : 'Survive until the end';
  }

  modeState(m: Match): ModeState {
    return {
      kind: 'infected', survivors: m.teamSize(SURVIVORS), infected: m.teamSize(INFECTED),
      outbreakIn: this.outbroken || m.phase !== 'live' ? 0 : Math.max(0, Math.round((this.outbreakAt - m.now()) * 10) / 10),
      last: this.lastId,
    };
  }

  /** Bots: the infected hunt the nearest survivor; survivors keep away from the nearest infected. */
  objectives(m: Match, p: MatchPlayer): BotGoal[] {
    if (!this.outbroken || !p.team) return [];
    const hunter = p.team === INFECTED;
    let near: MatchPlayer | null = null, best = Infinity;
    for (const o of m.players.values()) {
      if (o === p || !o.alive || o.team === p.team) continue;
      const d = Math.hypot(o.x - p.x, o.z - p.z);
      if (d < best) { best = d; near = o; }
    }
    if (!near) return [];
    return [{ kind: hunter ? 'hunt' : 'flee', x: near.x, y: near.y, z: near.z, r: hunter ? 1.5 : 12, priority: 2, target: near.id }];
  }
}
