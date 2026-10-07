import type { Team } from '../../src/modes/GameTypes';
import type { Site, Spawn } from '../../src/modes/maps';
import type { ModeState } from '../../src/net/protocol';
import type { Match, MatchPlayer } from '../Match';
import type { BotGoal } from './ModeLogic';
import { RoundsLogic } from './rounds';

/** How far above/below a site's standing level a player still counts as on it. */
const SITE_BELOW = 1.2;
const SITE_ABOVE = 3;

interface SiteRun {
  site: Site;
  /** Plant progress (before the plant) or defuse progress (after it), 0..1. */
  progress: number;
  planted: boolean;
  /** Living attackers / defenders on the site this tick. */
  att: number;
  def: number;
  /** Who plants or defuses (first on the site), 0 = nobody. */
  actor: number;
}

const other = (t: Team): Team => (t === 'red' ? 'blue' : 'red');

/**
 * Search and destroy: elimination rounds (one life each, `RoundsLogic`) with a bomb. One team attacks:
 * a living attacker who stays on bomb site A or B for `params.plantSec` seconds plants the bomb (leaving the
 * site resets the progress). The round clock then becomes the fuse (`params.fuseSec`); a living defender who
 * stays on the planted site for `params.defuseSec` seconds defuses it (leaving resets it).
 *
 * The attackers win the round by detonation or by killing every defender; the defenders by a defuse, by
 * killing every attacker before the plant, or when the round clock runs out with no bomb down. After a plant
 * the attackers' deaths no longer end the round: the defenders still have to defuse.
 *
 * Sides swap every `params.swapEvery` rounds (default: the round limit minus one, "half time"). Attackers
 * always start from the map's red spawns (x < 0) and defenders from the blue ones, whatever their colour:
 * the sites are in the blue half. `MatchPlayer.pts` counts plants and defuses.
 */
export class SndLogic extends RoundsLogic {
  private runs: SiteRun[] = [];
  private mapId = '';
  /** The team that attacks this round. */
  attackers: Team = 'red';

  private load(m: Match): void {
    this.mapId = m.map.id;
    this.runs = m.map.sites.map((site) => ({ site, progress: 0, planted: false, att: 0, def: 0, actor: 0 }));
  }

  private ensure(m: Match): void {
    if (this.mapId !== m.map.id || this.runs.length === 0) this.load(m);
  }

  get planted(): SiteRun | undefined {
    return this.runs.find((r) => r.planted);
  }

  /** The bomb sites with their progress (tests, bots). */
  get siteRuns(): readonly SiteRun[] {
    return this.runs;
  }

  private swapEvery(m: Match): number {
    return Math.max(1, m.def.params?.swapEvery ?? m.info.scoreLimit - 1);
  }

  onStart(m: Match): void {
    this.attackers = 'red';
    this.load(m);
    super.onStart(m);
  }

  onReset(): void {
    super.onReset();
    this.attackers = 'red';
    this.runs = [];
    this.mapId = '';
  }

  protected nextRound(m: Match): void {
    this.ensure(m);
    // `round` still counts the rounds played: swap before the players respawn on their new side.
    if (this.round > 0 && this.round % this.swapEvery(m) === 0) {
      this.attackers = other(this.attackers);
      m.event('side-swap', this.attackers);
    }
    for (const r of this.runs) { r.progress = 0; r.planted = false; r.att = r.def = 0; r.actor = 0; }
    super.nextRound(m);
    m.markModeDirty();
  }

  /** Attackers start in the red half, defenders in the blue half (next to the sites), spread out over their spawns. */
  pickSpawn(m: Match, p: MatchPlayer): Spawn | null {
    if (!p.team) return null;
    const list = p.team === this.attackers ? m.map.spawns.red : m.map.spawns.blue;
    let best = list[0], bestScore = -Infinity;
    for (const s of list) {
      let nearest = 1000;
      for (const o of m.players.values()) {
        if (o === p || !o.alive || o.team !== p.team) continue;
        nearest = Math.min(nearest, Math.hypot(s.x - o.x, s.z - o.z));
      }
      const score = nearest + m.random() * 2;
      if (score > bestScore) { bestScore = score; best = s; }
    }
    return best;
  }

  onTick(m: Match, dt: number, now: number): void {
    if (m.phase !== 'live') return;
    this.ensure(m);
    this.count(m);
    const params = m.def.params ?? {};
    const bomb = this.planted;
    if (bomb) this.defuse(m, bomb, dt, params.defuseSec ?? 6, now);
    else for (const r of this.runs) this.plant(m, r, dt, params.plantSec ?? 4, params.fuseSec ?? 35);
    if (m.phase === 'live') this.checkWipe(m, now);
  }

  /** Living players of each side on each site; the first one there is the actor. */
  private count(m: Match): void {
    for (const r of this.runs) {
      const was = `${r.att}|${r.def}`;
      r.att = r.def = 0;
      let actorHere = false;
      const s = r.site;
      for (const p of m.players.values()) {
        if (!p.alive || !p.team) continue;
        if (Math.hypot(p.x - s.x, p.z - s.z) > s.r || p.y < s.y - SITE_BELOW || p.y > s.y + SITE_ABOVE) continue;
        if (p.team === this.attackers) r.att++; else r.def++;
        if (p.id === r.actor) actorHere = true;
      }
      if (!actorHere) r.actor = 0;
      if (was !== `${r.att}|${r.def}`) m.markModeDirty();
    }
  }

  private firstOn(m: Match, r: SiteRun, team: Team): number {
    const s = r.site;
    for (const p of m.players.values()) {
      if (p.alive && p.team === team && Math.hypot(p.x - s.x, p.z - s.z) <= s.r && p.y >= s.y - SITE_BELOW && p.y <= s.y + SITE_ABOVE) return p.id;
    }
    return 0;
  }

  private plant(m: Match, r: SiteRun, dt: number, plantSec: number, fuseSec: number): void {
    if (r.att === 0) {
      if (r.progress > 0) { r.progress = 0; m.markModeDirty(); }
      return;
    }
    if (!r.actor) r.actor = this.firstOn(m, r, this.attackers);
    r.progress = Math.min(1, r.progress + dt / plantSec);
    if (r.progress < 1) return;
    r.planted = true;
    r.progress = 0;
    const planter = m.players.get(r.actor);
    if (planter) {
      planter.pts++;
      // Realms progression: a plant (and a defuse) counts as an objective capture.
      m.creditObjective(planter, 'zone-captured');
    }
    r.actor = 0;
    // The round clock becomes the fuse.
    m.setPhase('live', fuseSec);
    m.event('bomb-planted', this.attackers, planter?.id ?? 0, r.site.name);
    m.broadcastRoster();
  }

  private defuse(m: Match, r: SiteRun, dt: number, defuseSec: number, now: number): void {
    const defenders = other(this.attackers);
    if (r.def === 0) {
      if (r.progress > 0) { r.progress = 0; m.markModeDirty(); }
      return;
    }
    if (!r.actor) r.actor = this.firstOn(m, r, defenders);
    r.progress = Math.min(1, r.progress + dt / defuseSec);
    if (r.progress < 1) return;
    const hero = m.players.get(r.actor);
    if (hero) {
      hero.pts++;
      m.creditObjective(hero, 'zone-captured');
    }
    r.planted = false;
    m.event('bomb-defused', defenders, hero?.id ?? 0, r.site.name);
    m.broadcastRoster();
    this.endRound(m, defenders, now);
  }

  /** Wipes: no defenders left = attackers win; no attackers left = defenders win, unless the bomb is down. */
  protected checkWipe(m: Match, now: number): void {
    if (m.phase !== 'live') return;
    const att = m.aliveCount(this.attackers), def = m.aliveCount(other(this.attackers));
    const bomb = !!this.planted;
    if (def === 0 && (att > 0 || bomb)) this.endRound(m, this.attackers, now);
    else if (att === 0 && def === 0) this.endRound(m, '', now);
    else if (att === 0 && !bomb) this.endRound(m, other(this.attackers), now);
  }

  /** The clock ran out: with the bomb down that is the detonation, otherwise the defenders held. */
  protected onRoundTimeout(m: Match, now: number): void {
    const bomb = this.planted;
    if (bomb) {
      m.event('bomb-exploded', this.attackers, 0, bomb.site.name);
      bomb.planted = false;
      this.endRound(m, this.attackers, now);
    } else this.endRound(m, other(this.attackers), now);
  }

  scoreText(m: Match): string {
    return `Round ${Math.max(1, this.round)} · first to ${m.info.scoreLimit}`;
  }

  modeState(m: Match): ModeState {
    this.ensure(m);
    const bomb = this.planted;
    const every = this.swapEvery(m);
    return {
      kind: 'bomb', round: Math.max(1, this.round), need: m.info.scoreLimit,
      wins: { red: m.scores.red, blue: m.scores.blue }, alive: { red: m.aliveCount('red'), blue: m.aliveCount('blue') },
      attackers: this.attackers,
      sites: this.runs.map((r) => ({
        name: r.site.name, x: r.site.x, y: r.site.y, z: r.site.z, r: r.site.r, progress: Math.round(r.progress * 100) / 100, planted: r.planted,
      })),
      fuseIn: bomb && m.phase === 'live' ? m.timeLeft() : 0,
      swapIn: every - (Math.max(1, this.round) - 1) % every,
    };
  }

  /** Bots: attackers plant (spread over both sites by id), then guard the bomb; defenders guard, then defuse. */
  objectives(m: Match, p: MatchPlayer): BotGoal[] {
    this.ensure(m);
    if (!p.team || this.runs.length === 0) return [];
    const bomb = this.planted;
    const own = this.runs[p.id % this.runs.length];
    const goal = (kind: BotGoal['kind'], r: SiteRun, priority: number): BotGoal => ({ kind, x: r.site.x, y: r.site.y, z: r.site.z, r: r.site.r - 0.5, priority });
    if (p.team === this.attackers) return bomb ? [goal('defend', bomb, 2)] : [goal('capture', own, 2), ...this.runs.filter((r) => r !== own).map((r) => goal('capture', r, 1))];
    return bomb ? [goal('defuse', bomb, 3)] : [goal('defend', own, 1)];
  }
}
