import { WEAPON_CLASS, ASSIST_WINDOW, KILL_REPEAT_FULL, type MatchTally, MIN_COMPLETION_SECONDS, XP, emptyTally, emptyWeaponTally } from '../../src/modes/progression/XpRules';

/** Objective kinds the recorder credits (Match.event / Match.creditObjective). */
export type ObjectiveKind = 'flag-captured' | 'flag-returned' | 'zone-captured' | 'hill';

interface Entry {
  tally: MatchTally;
  /** Kills of each victim this match (diminishing returns against farming one player). */
  victims: Map<number, number>;
  /** Who damaged this player in the current life, when (seconds) and with what: assists. */
  hurtBy: Map<number, { at: number; weapon: string }>;
  streak: number;
  /** When this player started counting (match start or join), seconds. */
  since: number;
}

/**
 * Counts what every player does in one live match (kills, assists, headshots, accuracy, objectives, weapons)
 * for XP and statistics. Fed by the Match through the MatchHost hooks; knows nothing about profiles. Only
 * counts while the match is live, and `take` hands a player's tally over exactly once (match end or leaving).
 */
export class MatchRecorder {
  private readonly entries = new Map<number, Entry>();
  private live = false;

  /** A new match went live: everybody present starts from zero. */
  start(ids: Iterable<number>, now: number): void {
    this.entries.clear();
    this.live = true;
    for (const id of ids) this.entries.set(id, newEntry(now));
  }

  /** The match ended (or the room emptied): nothing counts until the next start. */
  stop(): void {
    this.live = false;
  }

  get counting(): boolean {
    return this.live;
  }

  /** A player came in during a live match. */
  join(id: number, now: number): void {
    if (this.live && !this.entries.has(id)) this.entries.set(id, newEntry(now));
  }

  private entry(id: number): Entry | null {
    return this.live ? this.entries.get(id) ?? null : null;
  }

  shot(id: number, weapon: string, hit: boolean): void {
    const e = this.entry(id);
    if (!e || weapon === 'knife') return;
    const w = (e.tally.weapons[weapon] ??= emptyWeaponTally());
    e.tally.shots++;
    w.shots++;
    if (hit) { e.tally.hits++; w.hits++; }
  }

  damage(attacker: number, victim: number, weapon: string, now: number): void {
    if (attacker === victim) return;
    const v = this.entry(victim);
    if (!v) return;
    const h = v.hurtBy.get(attacker);
    if (h) { h.at = now; h.weapon = weapon; } else v.hurtBy.set(attacker, { at: now, weapon });
  }

  kill(killer: number | null, victim: number, weapon: string, head: boolean, now: number): void {
    const v = this.entry(victim);
    if (v) {
      v.tally.deaths++;
      v.streak = 0;
      // Everybody else who hurt the victim recently helped.
      for (const [by, h] of v.hurtBy) {
        if (by === killer || now - h.at > ASSIST_WINDOW) continue;
        const a = this.entry(by);
        if (!a) continue;
        a.tally.assists++;
        (a.tally.weapons[h.weapon] ??= emptyWeaponTally()).assists++;
      }
      v.hurtBy.clear();
    }
    if (killer === null || killer === victim) return;
    const k = this.entry(killer);
    if (!k) return;
    const t = k.tally;
    t.kills++;
    if (head) t.headshots++;
    if (WEAPON_CLASS[weapon] === 'melee') t.knifeKills++;
    const n = (k.victims.get(victim) ?? 0) + 1;
    k.victims.set(victim, n);
    t.killXp += n > KILL_REPEAT_FULL ? XP.killRepeat : XP.kill;
    k.streak++;
    t.bestStreak = Math.max(t.bestStreak, k.streak);
    const w = (t.weapons[weapon] ??= emptyWeaponTally());
    w.kills++;
    if (head) w.headshots++;
  }

  /** Objective credit; `amount` is seconds for `hill`, otherwise 1. */
  objective(id: number, kind: ObjectiveKind, amount = 1): void {
    const e = this.entry(id);
    if (!e) return;
    const t = e.tally;
    if (kind === 'flag-captured') t.flagCaptures++;
    else if (kind === 'flag-returned') t.flagReturns++;
    else if (kind === 'zone-captured') t.zoneCaptures++;
    else if (kind === 'hill') t.hillSeconds += Math.max(0, Math.min(1, amount));
  }

  /**
   * Hands over a player's tally (and forgets the player): the seconds played are filled in, and `completed`
   * says whether they were in long enough for the completion bonus. Null when the player has nothing.
   */
  take(id: number, now: number): { tally: MatchTally; completed: boolean } | null {
    const e = this.entries.get(id);
    if (!e) return null;
    this.entries.delete(id);
    e.tally.seconds = Math.max(0, now - e.since);
    return { tally: e.tally, completed: e.tally.seconds >= MIN_COMPLETION_SECONDS };
  }

  /** Players with a tally. */
  ids(): number[] {
    return [...this.entries.keys()];
  }
}

function newEntry(now: number): Entry {
  return { tally: emptyTally(), victims: new Map(), hurtBy: new Map(), streak: 0, since: now };
}
