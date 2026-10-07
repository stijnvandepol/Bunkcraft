import type { Team } from '../../src/modes/GameTypes';
import type { Spawn } from '../../src/modes/maps';
import type { WeaponDef } from '../../src/modes/Weapons';
import type { MatchPhase, ModeState } from '../../src/net/protocol';
import type { Match, MatchPlayer } from '../Match';

/** How a match ended: the winning team, a winning player, or neither (a draw). */
export interface MatchResult { winnerTeam: Team | ''; winnerId: number }

/** The weapons a player gets at the start of a life. */
export interface Kit { primary: string; secondary?: string; melee?: string }

/**
 * Something a player should go and do, for server bots (and anything else that wants to know what the mode
 * asks of a player): a point in the world, what to do there and how much it matters (higher first).
 *
 * - `capture`: stand in it (zone, hill, a bomb site to plant at); `defend`: stay near it and shoot whoever comes;
 * - `pickup`: walk over it (a flag, a dog tag); `defuse`: stand in it until the bomb is safe;
 * - `hunt`: go to that player (`target`) and kill them; `flee`: keep away from that point.
 */
export interface BotGoal {
  kind: 'capture' | 'defend' | 'pickup' | 'defuse' | 'hunt' | 'flee';
  x: number; y: number; z: number;
  /** Within this many blocks (horizontal) the goal counts as reached. */
  r: number;
  priority: number;
  /** Player id for `hunt`/`flee` goals (0 = a place). */
  target?: number;
}

/**
 * The rules of one game type. `Match` owns players, combat, health, respawn timers and lag
 * compensation; a ModeLogic decides what a kill is worth, what the objective is, how phases
 * follow each other and when the match is over. `BaseLogic` implements team/ffa deathmatch
 * behaviour, so a mode only overrides what differs.
 *
 * Phases: `warmup` (Match: waits for players, counts down) then the logic takes over. A plain mode
 * calls `match.startLive()`; a round mode cycles `intermission` → `countdown` → `live` → `roundend`
 * through `match.setPhase()` and answers `onPhaseEnd` when the timer of a phase runs out.
 */
export interface ModeLogic {
  /** Warm-up is over: begin the match. Scores and counters are zero here. */
  onStart(m: Match, now: number): void;
  /** Every game tick (20 Hz) except during warm-up. */
  onTick?(m: Match, dt: number, now: number): void;
  /** The timer of the current phase ran out (any phase except warm-up and the result screen). */
  onPhaseEnd(m: Match, phase: MatchPhase, now: number): void;
  /** `victim` just died (kills/deaths are already counted); `killer` is null for deaths without one. */
  onKill(m: Match, killer: MatchPlayer | null, victim: MatchPlayer, weapon: WeaponDef, head: boolean, now: number): void;
  /** A player got a fresh life (spawn): the place for per-life state. */
  onSpawn?(m: Match, p: MatchPlayer, now: number): void;
  onJoin?(m: Match, p: MatchPlayer, now: number): void;
  onLeave?(m: Match, p: MatchPlayer, now: number): void;
  /** An objective happened that the mode reports itself (zone captured, flag captured): points, banners. */
  onObjective?(m: Match, p: MatchPlayer | null, kind: string, now: number): void;
  /** The match went back to a fresh warm-up (a new match, or the room emptied): forget mode state. */
  onReset?(m: Match): void;
  /** Seconds until `victim` respawns, or a negative number for "not before the round is over". */
  respawnDelay(m: Match, victim: MatchPlayer): number;
  /** Weapons for the next life; absent (or undefined for this player) = the player's own choice. */
  loadoutFor?(m: Match, p: MatchPlayer): Kit | undefined;
  /** A spawn point override (null = the default: furthest from living opponents). */
  pickSpawn?(m: Match, p: MatchPlayer): Spawn | null;
  /** Whether warm-up may end (default: two players). */
  canStart(m: Match): boolean;
  /** Is the match decided right now? Checked after kills and objective changes while live. */
  checkEnd(m: Match): MatchResult | null;
  /** Winner when the match ends on time (or is ended otherwise). */
  winner(m: Match): MatchResult;
  /** One line under the timer on the HUD. */
  scoreText(m: Match): string;
  /** Mode state for the HUD (zones, flags, rounds); null = nothing to send. */
  modeState?(m: Match): ModeState | null;
  /** The team for a player who joins now (absent/undefined = the smaller team). */
  teamFor?(m: Match): Team | '' | undefined;
  /** The mode moves players between teams itself (infected): Match never rebalances the teams. */
  readonly keepTeams?: boolean;
  /** Run-speed factor of a player on top of the weapon's (flag carrier, infected); the movement check uses it too. */
  speedMul?(m: Match, p: MatchPlayer): number;
  /** Damage factor of a hit (the infected's knife); default 1. */
  damageMul?(m: Match, attacker: MatchPlayer, victim: MatchPlayer, weapon: WeaponDef): number;
  /** What this player should do right now, best first (server bots); empty = just fight. */
  objectives?(m: Match, p: MatchPlayer): BotGoal[];
}

/** Defaults shared by the modes: team or free-for-all deathmatch semantics. */
export abstract class BaseLogic implements ModeLogic {
  onStart(m: Match, _now: number): void {
    m.startLive();
  }

  onPhaseEnd(m: Match, phase: MatchPhase, now: number): void {
    if (phase === 'live') m.endMatch(now);
  }

  onKill(m: Match, killer: MatchPlayer | null, _victim: MatchPlayer, _weapon: WeaponDef, _head: boolean, _now: number): void {
    if (killer && m.teams && killer.team) m.scores[killer.team] += m.def.scoring?.kill ?? 1;
  }

  respawnDelay(m: Match): number {
    const r = m.def.respawn;
    return !r || r.rule === 'never' ? -1 : r.seconds;
  }

  canStart(m: Match): boolean {
    return m.players.size >= 2;
  }

  checkEnd(m: Match): MatchResult | null {
    const limit = m.info.scoreLimit;
    if (limit <= 0) return null;
    if (m.teams) {
      if (m.scores.red >= limit || m.scores.blue >= limit) return this.winner(m);
      return null;
    }
    return [...m.players.values()].some((p) => p.kills >= limit) ? this.winner(m) : null;
  }

  winner(m: Match): MatchResult {
    if (m.teams) return teamWinner(m);
    return topPlayer(m, (p) => p.kills);
  }

  scoreText(m: Match): string {
    return `First to ${m.info.scoreLimit}`;
  }
}

/** The team with the higher score, or a draw. */
export function teamWinner(m: Match): MatchResult {
  const { red, blue } = m.scores;
  return { winnerTeam: red > blue ? 'red' : blue > red ? 'blue' : '', winnerId: 0 };
}

/** The player with the highest score (must be above 0); a tie for the top is a draw. */
export function topPlayer(m: Match, score: (p: MatchPlayer) => number): MatchResult {
  let best = 0, id = 0, tie = false;
  for (const p of m.players.values()) {
    const s = score(p);
    if (s > best) { best = s; id = p.id; tie = false; } else if (s === best && best > 0) tie = true;
  }
  return { winnerTeam: '', winnerId: tie ? 0 : id };
}
