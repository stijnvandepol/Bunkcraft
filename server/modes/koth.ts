import type { Zone } from '../../src/modes/maps';
import type { ModeState, ZoneState } from '../../src/net/protocol';
import type { Match, MatchPlayer } from '../Match';
import { BaseLogic, type BotGoal, type MatchResult, topPlayer } from './ModeLogic';
import { ZONE_ABOVE, ZONE_BELOW } from './zones';

/**
 * King of the hill: free-for-all hardpoint on the map's capture zones (`ArenaMap.zones`, in map order). One
 * hill is live at a time and moves on every `params.rotateSec` seconds after a `params.gapSec` pause. The one
 * living player who stands in it alone holds it and scores `params.pointsPerSec` per second
 * (`MatchPlayer.pts`); two or more inside contest it and nobody scores. Kills score nothing. First to the
 * score limit wins, on time the most points.
 */
export class KothLogic extends BaseLogic {
  private zones: Zone[] = [];
  private mapId = '';
  /** Index of the live hill, -1 during the pause. */
  private hill = 0;
  private lastHill = 0;
  private hillEnd = 0;
  private gapEnd = 0;
  /** Player who holds the hill alone (0 = nobody) and how many living players stand in it. */
  private holderId = 0;
  private inside = 0;
  /** Fraction of a point the holder has not been given yet. */
  private acc = 0;

  /** The live hill's index (-1 = pause) and its holder: tests and bots. */
  get liveHill(): number {
    return this.hill;
  }

  get holder(): number {
    return this.holderId;
  }

  private load(m: Match): void {
    this.mapId = m.map.id;
    this.zones = m.map.zones;
    this.hill = 0;
    this.lastHill = 0;
    this.holderId = 0;
    this.inside = 0;
    this.acc = 0;
  }

  private ensure(m: Match): void {
    if (this.mapId !== m.map.id || this.zones.length === 0) this.load(m);
  }

  onStart(m: Match, now: number): void {
    this.load(m);
    this.hillEnd = now + (m.def.params?.rotateSec ?? 45);
    m.startLive();
  }

  onReset(): void {
    this.zones = [];
    this.mapId = '';
  }

  onTick(m: Match, dt: number, now: number): void {
    if (m.phase !== 'live') return;
    this.ensure(m);
    if (this.zones.length === 0) return;
    const params = m.def.params ?? {};
    this.rotate(m, now, params.rotateSec ?? 45, params.gapSec ?? 4);
    let holder = 0, inside = 0;
    if (this.hill >= 0) {
      const z = this.zones[this.hill];
      for (const p of m.players.values()) {
        if (!p.alive) continue;
        if (Math.hypot(p.x - z.x, p.z - z.z) > z.r || p.y < z.y - ZONE_BELOW || p.y > z.y + ZONE_ABOVE) continue;
        inside++;
        holder = p.id;
      }
      if (inside !== 1) holder = 0;
    }
    if (holder !== this.holderId || inside !== this.inside) {
      // A new holder starts from a whole point: nobody inherits the previous holder's fraction.
      if (holder !== this.holderId) this.acc = 0;
      this.holderId = holder;
      this.inside = inside;
      m.markModeDirty();
    }
    if (!holder) return;
    // Realms progression: time in the hill counts like hardpoint time.
    const king = m.players.get(holder);
    if (king) m.creditObjective(king, 'hill', dt);
    this.acc += (params.pointsPerSec ?? 1) * dt;
    const whole = Math.floor(this.acc);
    if (whole <= 0) return;
    this.acc -= whole;
    const p = m.players.get(holder);
    if (!p) return;
    p.pts += whole * (m.def.scoring?.objective ?? 1);
    m.broadcastRoster();
  }

  /** Moves the hill on after `rotateSec`, with a pause of `gapSec` in between. */
  private rotate(m: Match, now: number, rotateSec: number, gapSec: number): void {
    if (this.hill >= 0 && now >= this.hillEnd) {
      this.hill = -1;
      this.gapEnd = now + gapSec;
      m.markModeDirty();
    } else if (this.hill < 0 && now >= this.gapEnd) {
      this.hill = (this.lastHill + 1) % this.zones.length;
      this.hillEnd = now + rotateSec;
      m.event('zone-moved', '', 0, this.zones[this.hill].name);
      m.markModeDirty();
    }
    if (this.hill >= 0) this.lastHill = this.hill;
  }

  onKill(): void {
    // Kills do not score: only holding the hill does.
  }

  checkEnd(m: Match): MatchResult | null {
    const limit = m.info.scoreLimit;
    if (limit <= 0) return null;
    for (const p of m.players.values()) if (p.pts >= limit) return this.winner(m);
    return null;
  }

  winner(m: Match): MatchResult {
    return topPlayer(m, (p) => p.pts);
  }

  scoreText(m: Match): string {
    if (this.hill >= 0 && this.zones[this.hill]) return `Hill: ${this.zones[this.hill].name} · first to ${m.info.scoreLimit}`;
    return `First to ${m.info.scoreLimit} points`;
  }

  modeState(m: Match): ModeState {
    this.ensure(m);
    const now = m.now();
    const zones: ZoneState[] = this.zones.map((z, i) => {
      const live = i === this.hill;
      return {
        name: z.name, x: z.x, y: z.y, z: z.z, r: z.r, active: live, owner: '', progress: 0, progressTeam: '',
        contested: live && this.inside > 1, red: live ? this.inside : 0, blue: 0, holder: live ? this.holderId : 0,
      };
    });
    const rotateIn = this.hill >= 0 ? Math.max(0, this.hillEnd - now) : Math.max(0, this.gapEnd - now);
    return { kind: 'zones', variant: 'koth', zones, rotateIn: Math.round(rotateIn * 10) / 10, gap: this.hill < 0 };
  }

  /** Bots: stand in the live hill (during the pause: go to the next one). */
  objectives(m: Match, _p: MatchPlayer): BotGoal[] {
    this.ensure(m);
    if (this.zones.length === 0) return [];
    const z = this.zones[this.hill >= 0 ? this.hill : (this.lastHill + 1) % this.zones.length];
    return [{ kind: 'capture', x: z.x, y: z.y, z: z.z, r: z.r - 1, priority: 2 }];
  }
}
