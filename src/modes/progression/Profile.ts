import { type GameType, gameTypeDef } from '../GameTypes';
import { WEAPONS } from '../Weapons';
import { type CamoDef, WEAPON_XP, camoUnlocked, camosBetween, isCamo } from './Camos';
import { type ChallengeDef, type ChallengeState, applyChallenges, currentState, periodKey } from './Challenges';
import { MAX_LEVEL, MAX_PRESTIGE, PRESTIGE_XP, type Rank, canPrestige, levelFromXp } from './Levels';
import { CARDS, DEFAULT_CARD, DEFAULT_TITLE, TITLES, type Unlock, hasUnlock, isCard, isTitle, unlocksBetween } from './Unlocks';
import { type MatchOutcome, type MatchResultKind, type MatchTally, type XpLine, matchXp } from './XpRules';

/**
 * A Realms player profile: level, prestige, lifetime statistics, weapon XP, recent matches, challenge progress
 * and the chosen cosmetics. The server owns it (server/progression/ProfileStore.ts) and is the only one that
 * changes XP; `applyMatch` is the single place a match turns into progress. Everything that comes from disk
 * goes through `sanitizeProfile`, so a damaged or hand-edited file cannot grow without bounds.
 */
export const PROFILE_VERSION = 1;
export const RECENT_MATCHES = 10;
/** Upper bound for any counter (keeps files small and arithmetic safe). */
const MAX_COUNT = 1e9;

export interface LifetimeStats {
  kills: number; deaths: number; assists: number; headshots: number; shots: number; hits: number;
  wins: number; losses: number; draws: number; matches: number;
  captures: number; returns: number; zones: number; hillSeconds: number;
  /** Seconds played in live matches. */
  seconds: number;
  bestStreak: number;
  challenges: number;
}

export interface ModeRecord { matches: number; wins: number; kills: number; deaths: number }
export interface WeaponRecord { xp: number; kills: number; headshots: number; shots: number; hits: number }

export interface RecentMatch {
  /** Epoch ms of the end of the match. */
  at: number;
  mode: GameType;
  map: string;
  result: MatchResultKind;
  kills: number;
  deaths: number;
  assists: number;
  xp: number;
}

export interface ProfileData {
  v: number;
  id: string;
  /** Last name played with (display only; names are not unique). */
  name: string;
  created: number;
  /** XP within the current prestige, and over all time. */
  xp: number;
  totalXp: number;
  prestige: number;
  stats: LifetimeStats;
  modes: Partial<Record<GameType, ModeRecord>>;
  weapons: Record<string, WeaponRecord>;
  recent: RecentMatch[];
  daily: ChallengeState;
  weekly: ChallengeState;
  equip: { title: string; card: string; camos: Record<string, string> };
}

const WEAPON_IDS = new Set(WEAPONS.map((w) => w.id));

function emptyStats(): LifetimeStats {
  return {
    kills: 0, deaths: 0, assists: 0, headshots: 0, shots: 0, hits: 0, wins: 0, losses: 0, draws: 0, matches: 0,
    captures: 0, returns: 0, zones: 0, hillSeconds: 0, seconds: 0, bestStreak: 0, challenges: 0,
  };
}

export function newProfile(id: string, name: string, nowMs: number): ProfileData {
  return {
    v: PROFILE_VERSION, id, name: cleanName(name), created: nowMs, xp: 0, totalXp: 0, prestige: 0,
    stats: emptyStats(), modes: {}, weapons: {}, recent: [],
    daily: currentState(undefined, periodKey('daily', nowMs)), weekly: currentState(undefined, periodKey('weekly', nowMs)),
    equip: { title: DEFAULT_TITLE, card: DEFAULT_CARD, camos: {} },
  };
}

export function cleanName(v: unknown): string {
  return typeof v === 'string' && /^[A-Za-z0-9_]{3,16}$/.test(v) ? v : 'Player';
}

const num = (v: unknown, max = MAX_COUNT): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(max, Math.floor(v))) : 0);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const own = (o: Record<string, unknown>, k: string): unknown => (Object.hasOwn(o, k) ? o[k] : undefined);

/** A clean profile from anything (a file from disk): unknown keys dropped, numbers clamped, lists capped. Null without an id. */
export function sanitizeProfile(raw: unknown): ProfileData | null {
  const r = obj(raw);
  const id = own(r, 'id');
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) return null;
  const s = obj(own(r, 'stats'));
  const stats = emptyStats();
  for (const k of Object.keys(stats) as (keyof LifetimeStats)[]) stats[k] = num(own(s, k));
  const modes: Partial<Record<GameType, ModeRecord>> = {};
  const m = obj(own(r, 'modes'));
  for (const [k, v] of Object.entries(m)) {
    if (!gameTypeDef(k as GameType).arcade || gameTypeDef(k as GameType).id !== k) continue;
    const e = obj(v);
    modes[k as GameType] = { matches: num(own(e, 'matches')), wins: num(own(e, 'wins')), kills: num(own(e, 'kills')), deaths: num(own(e, 'deaths')) };
  }
  const weapons: Record<string, WeaponRecord> = {};
  for (const [k, v] of Object.entries(obj(own(r, 'weapons')))) {
    if (!WEAPON_IDS.has(k)) continue;
    const e = obj(v);
    weapons[k] = { xp: num(own(e, 'xp')), kills: num(own(e, 'kills')), headshots: num(own(e, 'headshots')), shots: num(own(e, 'shots')), hits: num(own(e, 'hits')) };
  }
  const recentRaw = own(r, 'recent');
  const recent: RecentMatch[] = (Array.isArray(recentRaw) ? recentRaw : []).slice(0, RECENT_MATCHES).map((x) => {
    const e = obj(x);
    const mode = own(e, 'mode');
    const result = own(e, 'result');
    const map = own(e, 'map');
    return {
      at: num(own(e, 'at'), 8.64e15), mode: typeof mode === 'string' && gameTypeDef(mode as GameType).id === mode ? mode as GameType : 'tdm',
      map: typeof map === 'string' && /^[a-z0-9_-]{1,24}$/.test(map) ? map : 'classic',
      result: result === 'win' || result === 'draw' ? result : 'loss',
      kills: num(own(e, 'kills')), deaths: num(own(e, 'deaths')), assists: num(own(e, 'assists')), xp: num(own(e, 'xp')),
    };
  });
  const eq = obj(own(r, 'equip'));
  const camos: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj(own(eq, 'camos')))) if (WEAPON_IDS.has(k) && isCamo(v) && v !== 'none') camos[k] = v;
  const title = own(eq, 'title'), card = own(eq, 'card');
  const challengeState = (v: unknown): ChallengeState => {
    const e = obj(v);
    const key = own(e, 'key');
    return currentState({ key: typeof key === 'string' ? key.slice(0, 16) : '', progress: Array.isArray(own(e, 'progress')) ? own(e, 'progress') as number[] : [] }, typeof key === 'string' ? key.slice(0, 16) : '');
  };
  const prestige = num(own(r, 'prestige'), MAX_PRESTIGE);
  const created = own(r, 'created');
  return {
    v: PROFILE_VERSION, id, name: cleanName(own(r, 'name')), created: num(created, 8.64e15),
    xp: num(own(r, 'xp'), PRESTIGE_XP), totalXp: num(own(r, 'totalXp'), 1e12), prestige,
    stats, modes, weapons, recent,
    daily: challengeState(own(r, 'daily')), weekly: challengeState(own(r, 'weekly')),
    equip: { title: isTitle(title) ? title : DEFAULT_TITLE, card: isCard(card) ? card : DEFAULT_CARD, camos },
  };
}

export function rankOf(p: Pick<ProfileData, 'xp' | 'prestige'>): Rank {
  return { level: levelFromXp(p.xp).level, prestige: p.prestige };
}

/** What a match did to a profile: shown on the end screen (the `progress` message). */
export interface ProgressReport {
  lines: XpLine[];
  /** XP from the match (capped) plus challenge rewards. */
  xp: number;
  before: { xp: number; level: number; prestige: number };
  after: { xp: number; level: number; prestige: number };
  /** Equipment, titles and cards this match unlocked. */
  unlocks: Unlock[];
  /** New camos per weapon. */
  camos: { weapon: string; camo: string }[];
  /** Challenges completed by this match. */
  challenges: { id: string; period: 'daily' | 'weekly'; xp: number }[];
  /** Weapon levels gained: weapon id and new level. */
  weaponLevels: { weapon: string; xp: number }[];
}

/**
 * Applies a finished (or abandoned) match to a profile in place and reports what changed. XP within a prestige
 * stops at the level cap (the rest still counts towards `totalXp`): the player prestiges by choice.
 */
export function applyMatch(p: ProfileData, t: MatchTally, o: MatchOutcome, nowMs: number): ProgressReport {
  const before = { xp: p.xp, level: levelFromXp(p.xp).level, prestige: p.prestige };
  const { lines, total } = matchXp(t, o);
  const titlesBefore = new Set(TITLES.filter((u) => hasUnlock(u, rankOf(p), p.stats.challenges)).map((u) => u.id));

  // Challenges first: their XP goes into the same award.
  const completed: { def: ChallengeDef; period: 'daily' | 'weekly' }[] = [];
  const daily = applyChallenges('daily', p.daily, nowMs, t, o);
  const weekly = applyChallenges('weekly', p.weekly, nowMs, t, o);
  p.daily = daily.state;
  p.weekly = weekly.state;
  for (const c of daily.completed) completed.push({ def: c, period: 'daily' });
  for (const c of weekly.completed) completed.push({ def: c, period: 'weekly' });
  const challengeXp = completed.reduce((s, c) => s + c.def.xp, 0);
  for (const c of completed) lines.push({ key: `challenge.${c.def.id}`, xp: c.def.xp });
  const award = total + challengeXp;

  p.xp = Math.min(PRESTIGE_XP, p.xp + award);
  p.totalXp = Math.min(1e12, p.totalXp + award);

  // Lifetime statistics.
  const s = p.stats;
  const add = (k: keyof LifetimeStats, v: number) => { s[k] = Math.min(MAX_COUNT, s[k] + Math.max(0, Math.floor(v))); };
  add('kills', t.kills); add('deaths', t.deaths); add('assists', t.assists); add('headshots', t.headshots);
  add('shots', t.shots); add('hits', t.hits); add('captures', t.flagCaptures); add('returns', t.flagReturns);
  add('zones', t.zoneCaptures); add('hillSeconds', t.hillSeconds); add('seconds', t.seconds);
  add('challenges', completed.length);
  s.bestStreak = Math.max(s.bestStreak, Math.min(MAX_COUNT, t.bestStreak));
  if (o.completed) {
    add('matches', 1);
    add(o.result === 'win' ? 'wins' : o.result === 'draw' ? 'draws' : 'losses', 1);
  }
  const mode = (p.modes[o.mode] ??= { matches: 0, wins: 0, kills: 0, deaths: 0 });
  mode.kills = Math.min(MAX_COUNT, mode.kills + t.kills);
  mode.deaths = Math.min(MAX_COUNT, mode.deaths + t.deaths);
  if (o.completed) {
    mode.matches++;
    if (o.result === 'win') mode.wins++;
  }

  // Weapon XP and camos.
  const camos: ProgressReport['camos'] = [];
  const weaponLevels: ProgressReport['weaponLevels'] = [];
  for (const [id, wt] of Object.entries(t.weapons)) {
    if (!WEAPON_IDS.has(id)) continue;
    const rec = (p.weapons[id] ??= { xp: 0, kills: 0, headshots: 0, shots: 0, hits: 0 });
    const gain = wt.kills * WEAPON_XP.kill + wt.headshots * WEAPON_XP.headshot + wt.assists * WEAPON_XP.assist;
    const fromXp = rec.xp;
    rec.xp = Math.min(MAX_COUNT, rec.xp + gain);
    rec.kills = Math.min(MAX_COUNT, rec.kills + wt.kills);
    rec.headshots = Math.min(MAX_COUNT, rec.headshots + wt.headshots);
    rec.shots = Math.min(MAX_COUNT, rec.shots + wt.shots);
    rec.hits = Math.min(MAX_COUNT, rec.hits + wt.hits);
    if (gain > 0) weaponLevels.push({ weapon: id, xp: rec.xp });
    for (const c of camosBetween(fromXp, rec.xp)) camos.push({ weapon: id, camo: c.id });
  }

  p.recent.unshift({ at: nowMs, mode: o.mode, map: o.map, result: o.result, kills: t.kills, deaths: t.deaths, assists: t.assists, xp: award });
  p.recent.length = Math.min(p.recent.length, RECENT_MATCHES);

  const after = { xp: p.xp, level: levelFromXp(p.xp).level, prestige: p.prestige };
  const unlocks = unlocksBetween(before.level, after.level, p.prestige);
  // Titles earned by challenges (not by level) show up too.
  for (const u of TITLES) {
    if (u.challenges !== undefined && !titlesBefore.has(u.id) && hasUnlock(u, rankOf(p), p.stats.challenges)) unlocks.push(u);
  }
  return {
    lines, xp: award, before, after, unlocks, camos,
    challenges: completed.map((c) => ({ id: c.def.id, period: c.period, xp: c.def.xp })),
    weaponLevels,
  };
}

/** Enters the next prestige when allowed: level back to 1 (unlocks stay). Returns whether it happened. */
export function prestigeUp(p: ProfileData): boolean {
  if (!canPrestige(rankOf(p))) return false;
  p.prestige++;
  p.xp = 0;
  return true;
}

/** Changes the chosen title, card or weapon camos; anything not unlocked is refused. Returns whether all of it applied. */
export function setEquip(p: ProfileData, change: { title?: unknown; card?: unknown; camos?: unknown }): boolean {
  const rank = rankOf(p);
  let ok = true;
  if (change.title !== undefined) {
    const u = TITLES.find((x) => x.id === change.title);
    if (u && hasUnlock(u, rank, p.stats.challenges)) p.equip.title = u.id; else ok = false;
  }
  if (change.card !== undefined) {
    const u = CARDS.find((x) => x.id === change.card);
    if (u && hasUnlock(u, rank, p.stats.challenges)) p.equip.card = u.id; else ok = false;
  }
  if (change.camos !== undefined) {
    const c = obj(change.camos);
    for (const [weapon, camo] of Object.entries(c)) {
      if (!WEAPON_IDS.has(weapon) || !isCamo(camo)) { ok = false; continue; }
      if (camo === 'none') { delete p.equip.camos[weapon]; continue; }
      if (camoUnlocked(camo, p.weapons[weapon]?.xp ?? 0)) p.equip.camos[weapon] = camo; else ok = false;
    }
  }
  return ok;
}

/** Ratio helpers for the stats screen. */
export function kd(kills: number, deaths: number): string {
  return (deaths > 0 ? kills / deaths : kills).toFixed(2);
}

export function accuracy(hits: number, shots: number): number {
  return shots > 0 ? Math.round((hits / shots) * 1000) / 10 : 0;
}

/** The weapon with the most kills, or null. */
export function favouriteWeapon(p: Pick<ProfileData, 'weapons'>): string | null {
  let best: string | null = null, kills = 0;
  for (const [id, w] of Object.entries(p.weapons)) if (w.kills > kills) { kills = w.kills; best = id; }
  return best;
}

export type { CamoDef, MatchOutcome, MatchTally, Rank };
export { MAX_LEVEL };
