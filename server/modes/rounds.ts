import type { Team } from '../../src/modes/GameTypes';
import type { MatchPhase, ModeState } from '../../src/net/protocol';
import type { Match, MatchPlayer } from '../Match';
import { BaseLogic, type MatchResult, teamWinner } from './ModeLogic';

/**
 * Team elimination: best-of rounds with one life each. A round is won by wiping the other team
 * (or, on the round timer, by having more survivors); first team to `scoreLimit` round wins takes
 * the match. Dead players spectate their team until the next round.
 *
 * Phase cycle (after the warm-up): intermission (everybody back at spawn, may pick a weapon, nobody
 * can be hurt) → countdown (3-2-1) → live (the round timer = `timeLimitSec`) → roundend (result
 * banner) → intermission ...
 */
export class RoundsLogic extends BaseLogic {
  protected round = 0;
  /** The next round waits for a side whose players all dropped (their seats are kept): see `sideMissing`. */
  private waiting = false;

  protected get cfg() {
    return { postSec: 4, intermissionSec: 5, countdownSec: 3 };
  }

  onStart(m: Match): void {
    this.round = 0;
    this.nextRound(m);
  }

  onReset(): void {
    this.round = 0;
    this.waiting = false;
  }

  /** A side has nobody connected (only kept seats, or nobody at all): no round can start. */
  protected sideMissing(m: Match): boolean {
    return m.teamSize('red') === 0 || m.teamSize('blue') === 0;
  }

  /** A side has nobody, not even a kept seat: nothing to play for. */
  private sideGone(m: Match): boolean {
    return m.seatedTeamSize('red') === 0 || m.seatedTeamSize('blue') === 0;
  }

  /** Holds the intermission (no timer) until the missing side is back or its kept seats run out. */
  private hold(m: Match): void {
    if (!this.waiting) m.say('Waiting for players to reconnect');
    this.waiting = true;
    m.setPhase('intermission', 0);
  }

  canStart(m: Match): boolean {
    return m.teamSize('red') > 0 && m.teamSize('blue') > 0;
  }

  protected nextRound(m: Match): void {
    this.round++;
    m.respawnAll(m.now());
    if (this.sideMissing(m)) this.hold(m);
    else m.setPhase('intermission', m.def.rounds?.intermissionSec ?? this.cfg.intermissionSec);
    m.event('round-start', '', 0, `Round ${this.round}`);
    m.broadcastRoster();
  }

  onPhaseEnd(m: Match, phase: MatchPhase, now: number): void {
    const rounds = m.def.rounds ?? this.cfg;
    switch (phase) {
      case 'intermission':
        if (rounds.countdownSec > 0) m.setPhase('countdown', rounds.countdownSec);
        else m.setPhase('live', m.info.timeLimitSec);
        break;
      case 'countdown':
        m.setPhase('live', m.info.timeLimitSec);
        break;
      case 'live':
        this.onRoundTimeout(m, now);
        break;
      case 'roundend':
        this.nextRound(m);
        break;
      default: break;
    }
  }

  /** The round timer ran out: the team with more survivors wins, equal numbers draw the round. */
  protected onRoundTimeout(m: Match, now: number): void {
    const red = m.aliveCount('red'), blue = m.aliveCount('blue');
    this.endRound(m, red > blue ? 'red' : blue > red ? 'blue' : '', now);
  }

  onTick(m: Match, _dt: number, now: number): void {
    if (m.phase === 'live') this.checkWipe(m, now);
  }

  onKill(m: Match, _killer: MatchPlayer | null, _victim: MatchPlayer, _w: unknown, _head: boolean, now: number): void {
    if (m.phase === 'live') this.checkWipe(m, now);
    m.markModeDirty();
  }

  onLeave(m: Match, _p: MatchPlayer, now: number): void {
    if (m.phase === 'warmup' || m.phase === 'ended') return;
    // One side is gone for good: nothing to play for, wait for players again. A side whose players only dropped keeps
    // the match (their seats are kept): a round in progress goes on without them, the next one waits for them.
    if (this.sideGone(m)) m.returnToWarmup();
    else if (m.phase === 'live') this.checkWipe(m, now);
    else if ((m.phase === 'intermission' || m.phase === 'countdown') && this.sideMissing(m)) this.hold(m);
  }

  onSeatGivenUp(m: Match): void {
    if (m.phase !== 'warmup' && m.phase !== 'ended' && this.sideGone(m)) m.returnToWarmup();
  }

  onJoin(m: Match, p: MatchPlayer): void {
    // Joining while a round is running: watch until the next one.
    if (m.phase === 'live' || m.phase === 'roundend') {
      p.alive = false;
      p.respawnAt = Infinity;
    }
    // The side the next round waited for is back.
    if (this.waiting && m.phase === 'intermission' && !this.sideMissing(m)) {
      this.waiting = false;
      m.setPhase('intermission', m.def.rounds?.intermissionSec ?? this.cfg.intermissionSec);
    }
  }

  protected checkWipe(m: Match, now: number): void {
    const red = m.aliveCount('red'), blue = m.aliveCount('blue');
    if (red === 0 && blue === 0) this.endRound(m, '', now);
    else if (red === 0) this.endRound(m, 'blue', now);
    else if (blue === 0) this.endRound(m, 'red', now);
  }

  protected endRound(m: Match, winner: Team | '', now: number): void {
    if (m.phase !== 'live') return;
    if (winner) m.scores[winner]++;
    m.event('round-win', winner, 0, `Round ${this.round}`);
    if (winner && m.scores[winner] >= m.info.scoreLimit) {
      m.endMatch(now, { winnerTeam: winner, winnerId: 0 });
      return;
    }
    m.setPhase('roundend', m.def.rounds?.postSec ?? this.cfg.postSec);
  }

  checkEnd(): MatchResult | null {
    return null;
  }

  winner(m: Match): MatchResult {
    return teamWinner(m);
  }

  scoreText(m: Match): string {
    return `Round ${Math.max(1, this.round)} · first to ${m.info.scoreLimit}`;
  }

  modeState(m: Match): ModeState {
    return {
      kind: 'rounds', round: Math.max(1, this.round), need: m.info.scoreLimit,
      wins: { red: m.scores.red, blue: m.scores.blue }, alive: { red: m.aliveCount('red'), blue: m.aliveCount('blue') },
    };
  }
}
