import type { Team } from '../../src/modes/GameTypes';
import type { WeaponDef } from '../../src/modes/Weapons';
import type { FlagState, ModeState } from '../../src/net/protocol';
import type { Match, MatchPlayer } from '../Match';
import { BaseLogic, type MatchResult, teamWinner } from './ModeLogic';

/** Height difference (blocks) at which a player can still touch a flag. */
const TOUCH_HEIGHT = 2.6;

interface FlagRun {
  team: Team;
  status: 'home' | 'carried' | 'dropped';
  /** Where it is now (the base, the carrier or the place it was dropped). */
  x: number; y: number; z: number;
  hx: number; hy: number; hz: number;
  carrier: number;
  returnAt: number;
}

/**
 * Capture the flag on the map's two flags (`ArenaMap.flags`, one per team).
 *
 * Touch (`params.touchRadius`) the enemy flag while it is at its base or lying dropped to pick it up.
 * Carry it to your own base and touch your own flag there while it is home to capture (a point for the
 * team and a capture for the carrier; both flags then return). A carrier who dies drops the flag where
 * he fell; it stays `params.returnSec` seconds and returns by itself, or at once when a player of the
 * flag's own team touches it. The carrier is `params.carrySlow` slower (the client applies that from the
 * mode state). First to the capture limit wins, on time the team with more captures.
 */
export class CtfLogic extends BaseLogic {
  private flags: FlagRun[] = [];
  private mapId = '';

  private load(m: Match): void {
    this.mapId = m.map.id;
    this.flags = m.map.flags.map((f) => ({
      team: f.team, status: 'home', x: f.x, y: f.y, z: f.z, hx: f.x, hy: f.y, hz: f.z, carrier: 0, returnAt: 0,
    }));
  }

  private ensure(m: Match): void {
    if (this.mapId !== m.map.id || this.flags.length === 0) this.load(m);
  }

  flagOf(team: Team): FlagRun | undefined {
    return this.flags.find((f) => f.team === team);
  }

  onStart(m: Match): void {
    this.load(m);
    m.startLive();
  }

  onReset(): void {
    this.flags = [];
    this.mapId = '';
  }

  private home(f: FlagRun): void {
    f.status = 'home';
    f.x = f.hx; f.y = f.hy; f.z = f.hz;
    f.carrier = 0;
  }

  private drop(m: Match, f: FlagRun, x: number, y: number, z: number, carrier: MatchPlayer | null, now: number): void {
    f.status = 'dropped';
    f.x = x; f.y = y; f.z = z;
    f.carrier = 0;
    f.returnAt = now + (m.def.params?.returnSec ?? 12);
    m.event('flag-dropped', f.team, carrier?.id ?? 0, carrier?.name ?? '');
    m.markModeDirty();
  }

  private carrying(p: MatchPlayer): FlagRun | undefined {
    return this.flags.find((f) => f.status === 'carried' && f.carrier === p.id);
  }

  onTick(m: Match, _dt: number, now: number): void {
    if (m.phase !== 'live') return;
    this.ensure(m);
    const radius = m.def.params?.touchRadius ?? 1.6;
    for (const f of this.flags) {
      if (f.status === 'dropped' && now >= f.returnAt) {
        this.home(f);
        m.event('flag-returned', f.team, 0, 'timeout');
        m.markModeDirty();
      }
    }
    for (const p of m.players.values()) {
      if (!p.alive || !p.team) continue;
      for (const f of this.flags) {
        if (f.status === 'carried') continue;
        if (Math.hypot(p.x - f.x, p.z - f.z) > radius || Math.abs(p.y - f.y) > TOUCH_HEIGHT) continue;
        if (f.team !== p.team) this.pickUp(m, p, f);
        else if (f.status === 'dropped') {
          this.home(f);
          m.event('flag-returned', f.team, p.id, p.name);
          m.markModeDirty();
        } else this.tryCapture(m, p, f);
      }
    }
    // A carried flag travels with its carrier.
    for (const f of this.flags) {
      if (f.status !== 'carried') continue;
      const c = m.players.get(f.carrier);
      if (c) { f.x = c.x; f.y = c.y; f.z = c.z; }
    }
  }

  private pickUp(m: Match, p: MatchPlayer, f: FlagRun): void {
    if (this.carrying(p)) return;
    f.status = 'carried';
    f.carrier = p.id;
    f.x = p.x; f.y = p.y; f.z = p.z;
    m.event('flag-taken', f.team, p.id, p.name);
    m.markModeDirty();
  }

  /** `own` is the player's own flag, at home; capture when the player carries the enemy flag. */
  private tryCapture(m: Match, p: MatchPlayer, own: FlagRun): void {
    const enemy = this.carrying(p);
    if (!enemy || own.status !== 'home' || !p.team) return;
    this.home(enemy);
    m.scores[p.team] += m.def.scoring?.objective ?? 1;
    p.pts++;
    m.event('flag-captured', p.team, p.id, p.name);
    m.broadcastRoster();
    m.markModeDirty();
  }

  onKill(m: Match, _killer: MatchPlayer | null, victim: MatchPlayer, _w: WeaponDef, _head: boolean, now: number): void {
    const f = this.carrying(victim);
    if (f) this.drop(m, f, victim.x, victim.y, victim.z, victim, now);
  }

  onLeave(m: Match, p: MatchPlayer, now: number): void {
    const f = this.carrying(p);
    if (f) this.drop(m, f, p.x, p.y, p.z, p, now);
  }

  checkEnd(m: Match): MatchResult | null {
    const limit = m.info.scoreLimit;
    return limit > 0 && (m.scores.red >= limit || m.scores.blue >= limit) ? teamWinner(m) : null;
  }

  winner(m: Match): MatchResult {
    return teamWinner(m);
  }

  scoreText(m: Match): string {
    return `First to ${m.info.scoreLimit} ${m.info.scoreLimit === 1 ? 'capture' : 'captures'}`;
  }

  /** Whether this player carries a flag (the client slows the carrier down). */
  isCarrier(p: MatchPlayer): boolean {
    return !!this.carrying(p);
  }

  /** A flag carrier runs `params.carrySlow` slower. */
  speedMul(m: Match, p: MatchPlayer): number {
    return this.carrying(p) ? 1 - (m.def.params?.carrySlow ?? 0.1) : 1;
  }

  modeState(m: Match): ModeState {
    this.ensure(m);
    const now = m.now();
    const flags: FlagState[] = this.flags.map((f) => ({
      team: f.team, status: f.status, x: r2(f.x), y: r2(f.y), z: r2(f.z), carrier: f.carrier,
      returnIn: f.status === 'dropped' ? Math.max(0, Math.round((f.returnAt - now) * 10) / 10) : 0,
      hx: f.hx, hy: f.hy, hz: f.hz,
    }));
    return { kind: 'ctf', flags };
  }
}

const r2 = (v: number) => Math.round(v * 100) / 100;
