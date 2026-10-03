import type { Team } from '../../src/modes/GameTypes';
import type { Zone } from '../../src/modes/maps';
import type { ModeState, ZoneState } from '../../src/net/protocol';
import type { Match } from '../Match';
import { BaseLogic, type MatchResult, teamWinner } from './ModeLogic';

/** How far above/below a zone's standing level a player still counts as inside (stairs, small jumps). */
const ZONE_BELOW = 1.2;
const ZONE_ABOVE = 3.5;

interface ZoneRun {
  zone: Zone;
  owner: Team | '';
  /** Domination: capture progress 0..1 of `progressTeam`. */
  progress: number;
  progressTeam: Team | '';
  contested: boolean;
  red: number;
  blue: number;
}

/**
 * Hardpoint and domination on the map's capture zones (`ArenaMap.zones`).
 *
 * Hardpoint (`params.rotateSec`, `gapSec`, `pointsPerSec`): one zone, the hill, is live at a time, in the
 * map's order; it moves every `rotateSec` seconds after a `gapSec` pause. The team that has living
 * players in it and no opponents owns it and scores `pointsPerSec` per second; both teams inside =
 * contested, nobody scores.
 *
 * Domination (`params.captureSec`, `pointEverySec`): every domination point is live all the time.
 * Standing in one alone captures it in `captureSec` seconds (an owned point first has to be neutralised);
 * a contested point holds its progress. Every owned point scores one point per `pointEverySec` seconds.
 *
 * Team points go to `Match.scores`; the first team to the score limit (or the higher score on time) wins.
 */
export class ZonesLogic extends BaseLogic {
  private runs: ZoneRun[] = [];
  private mapId = '';
  /** Hardpoint: index of the live hill into `runs`, -1 during the pause. */
  private hill = 0;
  private lastHill = 0;
  private hillEnd = 0;
  private gapEnd = 0;
  /** Fractions of a point not scored yet. */
  private readonly acc = { red: 0, blue: 0 };

  private get hardpoint(): boolean {
    return this.variant === 'hardpoint';
  }

  constructor(private readonly variant: 'hardpoint' | 'domination' = 'hardpoint') {
    super();
  }

  private load(m: Match): void {
    this.mapId = m.map.id;
    const zones = m.map.zones;
    const wanted = this.hardpoint ? zones.map((_, i) => i) : m.map.dominationZones;
    this.runs = wanted.map((i) => ({ zone: zones[i], owner: '', progress: 0, progressTeam: '', contested: false, red: 0, blue: 0 }));
    this.acc.red = this.acc.blue = 0;
    this.hill = 0;
    this.lastHill = 0;
  }

  private ensure(m: Match): void {
    if (this.mapId !== m.map.id || this.runs.length === 0) this.load(m);
  }

  onStart(m: Match, now: number): void {
    this.load(m);
    this.hillEnd = now + (m.def.params?.rotateSec ?? 60);
    m.startLive();
  }

  onReset(): void {
    this.runs = [];
    this.mapId = '';
  }

  onTick(m: Match, dt: number, now: number): void {
    if (m.phase !== 'live') return;
    this.ensure(m);
    const params = m.def.params ?? {};
    if (this.hardpoint) this.rotate(m, now, params.rotateSec ?? 60, params.gapSec ?? 5);
    for (let i = 0; i < this.runs.length; i++) {
      const r = this.runs[i];
      const live = this.hardpoint ? i === this.hill : true;
      this.count(m, r, live);
      if (!live) continue;
      if (this.hardpoint) this.scoreHill(m, r, dt, params.pointsPerSec ?? 1);
      else this.capture(m, r, dt, params.captureSec ?? 6);
    }
    if (!this.hardpoint) this.scoreOwned(dt, params.pointEverySec ?? 2);
    this.flush(m);
  }

  /** Moves the hill on after `rotateSec`, with a pause of `gapSec` in between. */
  private rotate(m: Match, now: number, rotateSec: number, gapSec: number): void {
    if (this.hill >= 0 && now >= this.hillEnd) {
      this.hill = -1;
      this.gapEnd = now + gapSec;
      m.markModeDirty();
    } else if (this.hill < 0 && now >= this.gapEnd) {
      this.hill = (this.lastHill + 1) % this.runs.length;
      this.hillEnd = now + rotateSec;
      m.event('zone-moved', '', 0, this.runs[this.hill].zone.name);
      m.markModeDirty();
    }
    if (this.hill >= 0) this.lastHill = this.hill;
  }

  /** Living players of each team inside a zone. */
  private count(m: Match, r: ZoneRun, live: boolean): void {
    const was = `${r.red}${r.blue}${r.contested}`;
    r.red = r.blue = 0;
    if (live) {
      const z = r.zone;
      for (const p of m.players.values()) {
        if (!p.alive || !p.team) continue;
        if (Math.hypot(p.x - z.x, p.z - z.z) > z.r || p.y < z.y - ZONE_BELOW || p.y > z.y + ZONE_ABOVE) continue;
        if (p.team === 'red') r.red++; else r.blue++;
      }
    }
    r.contested = r.red > 0 && r.blue > 0;
    if (was !== `${r.red}${r.blue}${r.contested}`) m.markModeDirty();
  }

  private scoreHill(m: Match, r: ZoneRun, dt: number, perSec: number): void {
    const team: Team | '' = r.red > 0 && r.blue === 0 ? 'red' : r.blue > 0 && r.red === 0 ? 'blue' : '';
    if (team !== r.owner) {
      r.owner = team;
      m.markModeDirty();
    }
    if (team) this.acc[team] += perSec * dt;
  }

  private capture(m: Match, r: ZoneRun, dt: number, captureSec: number): void {
    const team: Team | '' = r.red > 0 && r.blue === 0 ? 'red' : r.blue > 0 && r.red === 0 ? 'blue' : '';
    if (!team || r.owner === team) return;
    const step = dt / captureSec;
    if (r.progressTeam === team || r.progress <= 0) {
      r.progressTeam = team;
      r.progress = Math.min(1, r.progress + step);
      if (r.progress >= 1) {
        r.owner = team;
        m.event('zone-captured', team, 0, r.zone.name);
        m.markModeDirty();
      }
    } else {
      // The point belongs to (or is being taken by) the other team: take that away first.
      r.progress = Math.max(0, r.progress - step);
      if (r.progress <= 0 && r.owner) {
        m.event('zone-lost', r.owner, 0, r.zone.name);
        r.owner = '';
        m.markModeDirty();
      }
    }
  }

  private scoreOwned(dt: number, everySec: number): void {
    for (const r of this.runs) if (r.owner) this.acc[r.owner] += dt / everySec;
  }

  /** Turns collected fractions into whole points. */
  private flush(m: Match): void {
    for (const team of ['red', 'blue'] as const) {
      const whole = Math.floor(this.acc[team]);
      if (whole > 0) {
        this.acc[team] -= whole;
        m.scores[team] += whole * (m.def.scoring?.objective ?? 1);
      }
    }
  }

  onKill(): void {
    // Kills do not score: only holding the objective does.
  }

  checkEnd(m: Match): MatchResult | null {
    const limit = m.info.scoreLimit;
    return limit > 0 && (m.scores.red >= limit || m.scores.blue >= limit) ? teamWinner(m) : null;
  }

  winner(m: Match): MatchResult {
    return teamWinner(m);
  }

  scoreText(m: Match): string {
    if (this.hardpoint && this.hill >= 0 && this.runs[this.hill]) return `Hill: ${this.runs[this.hill].zone.name} · first to ${m.info.scoreLimit}`;
    return `First to ${m.info.scoreLimit} points`;
  }

  modeState(m: Match): ModeState {
    this.ensure(m);
    const now = m.now();
    const zones: ZoneState[] = this.runs.map((r, i) => ({
      name: r.zone.name, x: r.zone.x, y: r.zone.y, z: r.zone.z, r: r.zone.r,
      active: this.hardpoint ? i === this.hill : true,
      owner: r.owner, progress: Math.round(r.progress * 100) / 100, progressTeam: r.progressTeam, contested: r.contested,
      red: r.red, blue: r.blue,
    }));
    const rotateIn = !this.hardpoint ? 0 : this.hill >= 0 ? Math.max(0, this.hillEnd - now) : Math.max(0, this.gapEnd - now);
    return { kind: 'zones', variant: this.variant, zones, rotateIn: Math.round(rotateIn * 10) / 10, gap: this.hardpoint && this.hill < 0 };
  }
}
