import type { GameType } from '../GameTypes';

/**
 * What a match is worth. The server counts a `MatchTally` per player while the match is live
 * (server/progression/MatchRecorder.ts) and turns it into XP with `matchXp` at the end; the client
 * only shows the breakdown it is sent. Pure functions, unit tested.
 */
export const XP = {
  kill: 100,
  /** A kill on a victim you already killed KILL_REPEAT_FULL times this match (farming a friend) is worth this. */
  killRepeat: 25,
  headshot: 25,
  assist: 40,
  knifeKill: 25,
  flagCapture: 300,
  flagReturn: 75,
  zoneCapture: 150,
  /** Per second in a hardpoint hill your team holds. */
  hillSecond: 5,
  completion: 250,
  win: 400,
  draw: 150,
} as const;

export const KILL_REPEAT_FULL = 6;
/** XP from one match is capped (challenge rewards come on top). */
export const MATCH_XP_CAP = 6000;
/** Seconds a player has to be in a match for the completion and win bonus. */
export const MIN_COMPLETION_SECONDS = 45;
/** Damage within this many seconds before a kill earns an assist. */
export const ASSIST_WINDOW = 10;

export interface WeaponTally { kills: number; headshots: number; assists: number; shots: number; hits: number }

export interface MatchTally {
  kills: number;
  deaths: number;
  assists: number;
  headshots: number;
  shots: number;
  hits: number;
  knifeKills: number;
  flagCaptures: number;
  flagReturns: number;
  zoneCaptures: number;
  hillSeconds: number;
  /** XP of the kills after diminishing returns on repeated victims. */
  killXp: number;
  bestStreak: number;
  /** Seconds this player spent in the live match. */
  seconds: number;
  weapons: Record<string, WeaponTally>;
}

export type MatchResultKind = 'win' | 'loss' | 'draw';

export interface MatchOutcome {
  mode: GameType;
  map: string;
  result: MatchResultKind;
  /** Played to the end (present at the end and long enough). False when the player left early. */
  completed: boolean;
}

export function emptyTally(): MatchTally {
  return {
    kills: 0, deaths: 0, assists: 0, headshots: 0, shots: 0, hits: 0, knifeKills: 0, flagCaptures: 0, flagReturns: 0,
    zoneCaptures: 0, hillSeconds: 0, killXp: 0, bestStreak: 0, seconds: 0, weapons: {},
  };
}

export function emptyWeaponTally(): WeaponTally {
  return { kills: 0, headshots: 0, assists: 0, shots: 0, hits: 0 };
}

/** One line of the end-of-match XP breakdown (`key` is an i18n suffix: xp.line.<key>). */
export interface XpLine { key: string; xp: number; count?: number }

/** The XP lines of a match, capped at MATCH_XP_CAP in total (lines with 0 XP are left out). */
export function matchXp(t: MatchTally, o: MatchOutcome): { lines: XpLine[]; total: number } {
  const lines: XpLine[] = [];
  const add = (key: string, xp: number, count?: number) => { if (xp > 0) lines.push(count !== undefined ? { key, xp, count } : { key, xp }); };
  add('kills', Math.round(t.killXp), t.kills);
  add('headshots', t.headshots * XP.headshot, t.headshots);
  add('knife', t.knifeKills * XP.knifeKill, t.knifeKills);
  add('assists', t.assists * XP.assist, t.assists);
  add('captures', t.flagCaptures * XP.flagCapture, t.flagCaptures);
  add('returns', t.flagReturns * XP.flagReturn, t.flagReturns);
  add('zones', t.zoneCaptures * XP.zoneCapture, t.zoneCaptures);
  add('hill', Math.floor(t.hillSeconds) * XP.hillSecond, Math.floor(t.hillSeconds));
  if (o.completed) {
    add('completion', XP.completion);
    if (o.result === 'win') add('win', XP.win);
    else if (o.result === 'draw') add('draw', XP.draw);
  }
  let total = lines.reduce((s, l) => s + l.xp, 0);
  if (total > MATCH_XP_CAP) {
    lines.push({ key: 'cap', xp: MATCH_XP_CAP - total });
    total = MATCH_XP_CAP;
  }
  return { lines, total };
}

/** Weapon classes for challenges ("10 kills with an SMG"). */
export type WeaponClass = 'ar' | 'smg' | 'shotgun' | 'lmg' | 'marksman' | 'sniper' | 'pistol' | 'melee';

export const WEAPON_CLASS: Record<string, WeaponClass> = {
  rifle: 'ar', burst: 'ar', smg: 'smg', shotgun: 'shotgun', lmg: 'lmg', dmr: 'marksman',
  semisniper: 'sniper', sniper: 'sniper', pistol: 'pistol', mpistol: 'pistol', revolver: 'pistol', knife: 'melee',
};

/** Kills with weapons of one class in a tally. */
export function classKills(t: MatchTally, cls: WeaponClass): number {
  let n = 0;
  for (const [id, w] of Object.entries(t.weapons)) if (WEAPON_CLASS[id] === cls) n += w.kills;
  return n;
}
