import { type MatchOutcome, type MatchTally, type WeaponClass, classKills } from './XpRules';

/**
 * Daily and weekly challenges: three of each, the same for every player on a server, picked from a pool
 * by the date (UTC) so nothing has to be stored to know today's set. Progress lives in the profile per
 * period key; when the key changes the progress starts over.
 */
export type ChallengePeriod = 'daily' | 'weekly';

export type ChallengeStat =
  | 'kills' | 'headshots' | 'assists' | 'wins' | 'matches' | 'knife' | 'captures' | 'returns' | 'zones' | 'hill' | 'class';

export interface ChallengeDef {
  id: string;
  stat: ChallengeStat;
  target: number;
  /** Weapon class for `class` challenges. */
  weaponClass?: WeaponClass;
  /** XP reward once completed. */
  xp: number;
}

export const DAILY_XP = 750;
export const WEEKLY_XP = 2500;
export const CHALLENGES_PER_PERIOD = 3;

const d = (id: string, stat: ChallengeStat, target: number, weaponClass?: WeaponClass): ChallengeDef =>
  ({ id, stat, target, xp: DAILY_XP, ...(weaponClass ? { weaponClass } : {}) });
const w = (id: string, stat: ChallengeStat, target: number, weaponClass?: WeaponClass): ChallengeDef =>
  ({ id, stat, target, xp: WEEKLY_XP, ...(weaponClass ? { weaponClass } : {}) });

export const DAILY_POOL: readonly ChallengeDef[] = [
  d('d_kills', 'kills', 15),
  d('d_ar', 'class', 10, 'ar'),
  d('d_smg', 'class', 10, 'smg'),
  d('d_shotgun', 'class', 6, 'shotgun'),
  d('d_lmg', 'class', 8, 'lmg'),
  d('d_marksman', 'class', 6, 'marksman'),
  d('d_sniper', 'class', 5, 'sniper'),
  d('d_pistol', 'class', 4, 'pistol'),
  d('d_heads', 'headshots', 5),
  d('d_knife', 'knife', 2),
  d('d_assists', 'assists', 5),
  d('d_wins', 'wins', 2),
  d('d_matches', 'matches', 3),
  d('d_flags', 'captures', 1),
  d('d_zones', 'zones', 3),
  d('d_hill', 'hill', 60),
];

export const WEEKLY_POOL: readonly ChallengeDef[] = [
  w('w_kills', 'kills', 100),
  w('w_heads', 'headshots', 30),
  w('w_wins', 'wins', 10),
  w('w_matches', 'matches', 15),
  w('w_assists', 'assists', 30),
  w('w_knife', 'knife', 10),
  w('w_flags', 'captures', 5),
  w('w_zones', 'zones', 15),
  w('w_ar', 'class', 50, 'ar'),
  w('w_smg', 'class', 50, 'smg'),
  w('w_sniper', 'class', 25, 'sniper'),
  w('w_shotgun', 'class', 30, 'shotgun'),
];

const DAY_MS = 86_400_000;

/** "2026-10-07" (UTC) or "W2914" (weeks since 1970 starting on Mondays). */
export function periodKey(period: ChallengePeriod, nowMs: number): string {
  const day = Math.floor(nowMs / DAY_MS);
  if (period === 'weekly') return `W${Math.floor((day + 3) / 7)}`; // 1970-01-01 was a Thursday
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** Milliseconds until the period of `nowMs` ends (for "resets in 5 h"). */
export function periodEndsIn(period: ChallengePeriod, nowMs: number): number {
  const day = Math.floor(nowMs / DAY_MS);
  const endDay = period === 'daily' ? day + 1 : (Math.floor((day + 3) / 7) + 1) * 7 - 3;
  return endDay * DAY_MS - nowMs;
}

/** FNV-1a: a small, stable string hash (the pick must be the same in every browser and on the server). */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** The challenges of a period key: CHALLENGES_PER_PERIOD different ones, at most one objective-mode challenge. */
export function activeChallenges(period: ChallengePeriod, key: string): ChallengeDef[] {
  const pool = period === 'daily' ? DAILY_POOL : WEEKLY_POOL;
  const objective = (c: ChallengeDef) => c.stat === 'captures' || c.stat === 'zones' || c.stat === 'hill' || c.stat === 'returns';
  const out: ChallengeDef[] = [];
  let seed = hash(`${period}|${key}`);
  for (let tries = 0; out.length < CHALLENGES_PER_PERIOD && tries < 200; tries++) {
    seed = hash(`${seed}`);
    const c = pool[seed % pool.length];
    if (out.includes(c)) continue;
    if (objective(c) && out.some(objective)) continue;
    out.push(c);
  }
  return out;
}

/** How much one match moves a challenge. */
export function challengeProgress(c: ChallengeDef, t: MatchTally, o: MatchOutcome): number {
  switch (c.stat) {
    case 'kills': return t.kills;
    case 'headshots': return t.headshots;
    case 'assists': return t.assists;
    case 'wins': return o.completed && o.result === 'win' ? 1 : 0;
    case 'matches': return o.completed ? 1 : 0;
    case 'knife': return t.knifeKills;
    case 'captures': return t.flagCaptures;
    case 'returns': return t.flagReturns;
    case 'zones': return t.zoneCaptures;
    case 'hill': return Math.floor(t.hillSeconds);
    case 'class': return c.weaponClass ? classKills(t, c.weaponClass) : 0;
  }
}

/** A profile's progress in one period: the key it belongs to and the count per active challenge. */
export interface ChallengeState {
  key: string;
  progress: number[];
}

/** The state for the current key: the stored one when it is still this period's, else a fresh one. */
export function currentState(state: ChallengeState | undefined, key: string): ChallengeState {
  if (state && state.key === key && Array.isArray(state.progress)) {
    return { key, progress: Array.from({ length: CHALLENGES_PER_PERIOD }, (_, i) => clampCount(state.progress[i])) };
  }
  return { key, progress: Array.from({ length: CHALLENGES_PER_PERIOD }, () => 0) };
}

function clampCount(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1_000_000, Math.floor(v))) : 0;
}

/**
 * Applies one match to a period's challenges. Returns the new state and the challenges completed by this
 * match (each completes exactly once: progress stops at the target).
 */
export function applyChallenges(
  period: ChallengePeriod, state: ChallengeState | undefined, nowMs: number, t: MatchTally, o: MatchOutcome,
): { state: ChallengeState; completed: ChallengeDef[] } {
  const key = periodKey(period, nowMs);
  const next = currentState(state, key);
  const completed: ChallengeDef[] = [];
  activeChallenges(period, key).forEach((c, i) => {
    const before = next.progress[i];
    if (before >= c.target) return;
    const after = Math.min(c.target, before + challengeProgress(c, t, o));
    next.progress[i] = after;
    if (after >= c.target) completed.push(c);
  });
  return { state: next, completed };
}
