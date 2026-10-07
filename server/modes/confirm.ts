import type { Team } from '../../src/modes/GameTypes';
import type { WeaponDef } from '../../src/modes/Weapons';
import type { ModeState, TagState } from '../../src/net/protocol';
import type { Match, MatchPlayer } from '../Match';
import { BaseLogic, type BotGoal, type MatchResult, teamWinner } from './ModeLogic';

/** Height difference (blocks) at which a player still picks a tag up. */
const TOUCH_HEIGHT = 2.6;
/** Never more tags on the ground than this (the oldest goes first); keeps the mode message small. */
export const MAX_TAGS = 40;

interface Tag extends TagState { expiresAt: number }

/**
 * Kill confirmed: team deathmatch where a kill scores nothing by itself. Every death drops a dog tag
 * where the player fell. An enemy of the fallen player who walks over it confirms the kill (a point for
 * their team); a teammate who gets there first denies it (no point). Tags vanish after `params.tagSec`.
 * `MatchPlayer.pts` counts the tags a player picked up (confirms and denies). First team to the score
 * limit wins, on time the higher score.
 */
export class ConfirmLogic extends BaseLogic {
  private tags: Tag[] = [];
  private nextId = 1;

  onStart(m: Match): void {
    this.tags = [];
    m.startLive();
  }

  onReset(): void {
    this.tags = [];
  }

  /** The tags on the ground (for tests and bots). */
  get dropped(): readonly TagState[] {
    return this.tags;
  }

  onKill(m: Match, _killer: MatchPlayer | null, victim: MatchPlayer, _w: WeaponDef, _head: boolean, now: number): void {
    if (!victim.team || m.phase !== 'live') return;
    if (this.tags.length >= MAX_TAGS) this.tags.shift();
    this.tags.push({ id: this.nextId++, x: r2(victim.x), y: r2(victim.y), z: r2(victim.z), team: victim.team, expiresAt: now + (m.def.params?.tagSec ?? 30) });
    m.markModeDirty();
  }

  onTick(m: Match, _dt: number, now: number): void {
    if (m.phase !== 'live' || this.tags.length === 0) return;
    const radius = m.def.params?.touchRadius ?? 1.6;
    for (let i = this.tags.length - 1; i >= 0; i--) {
      const tag = this.tags[i];
      if (now >= tag.expiresAt) {
        this.tags.splice(i, 1);
        m.markModeDirty();
        continue;
      }
      let taker: MatchPlayer | null = null, best = radius;
      for (const p of m.players.values()) {
        if (!p.alive || !p.team || Math.abs(p.y - tag.y) > TOUCH_HEIGHT) continue;
        const d = Math.hypot(p.x - tag.x, p.z - tag.z);
        if (d <= best) { best = d; taker = p; }
      }
      if (taker) this.take(m, taker, tag, i);
    }
  }

  private take(m: Match, p: MatchPlayer, tag: Tag, index: number): void {
    this.tags.splice(index, 1);
    p.pts++;
    if (p.team !== tag.team) {
      m.scores[p.team as Team] += m.def.scoring?.objective ?? 1;
      m.event('tag-confirmed', p.team, p.id, p.name);
    } else m.event('tag-denied', p.team, p.id, p.name);
    m.markModeDirty();
    m.broadcastRoster();
  }

  checkEnd(m: Match): MatchResult | null {
    const limit = m.info.scoreLimit;
    return limit > 0 && (m.scores.red >= limit || m.scores.blue >= limit) ? teamWinner(m) : null;
  }

  winner(m: Match): MatchResult {
    return teamWinner(m);
  }

  scoreText(m: Match): string {
    return `First to ${m.info.scoreLimit} confirms`;
  }

  modeState(): ModeState {
    return { kind: 'tags', tags: this.tags.map(({ id, x, y, z, team }) => ({ id, x, y, z, team })) };
  }

  /** Bots: the nearest tags first (any tag is worth a walk: enemy ones score, own ones deny). */
  objectives(_m: Match, p: MatchPlayer): BotGoal[] {
    return this.tags
      .map((t) => ({ t, d: Math.hypot(t.x - p.x, t.z - p.z) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 3)
      .map(({ t, d }) => ({ kind: 'pickup' as const, x: t.x, y: t.y, z: t.z, r: 1.2, priority: (t.team !== p.team ? 2 : 1) + 1 / (1 + d) }));
  }
}

const r2 = (v: number) => Math.round(v * 100) / 100;
