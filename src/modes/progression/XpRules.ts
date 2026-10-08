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
  /** Kill Confirmed: picking up an enemy tag (confirm) or an own one (deny). */
  tagConfirm: 50,
  tagDeny: 25,
  completion: 250,
  win: 400,
  draw: 150,
} as const;

export const KILL_REPEAT_FULL = 6;
/**
 * Fairness against bots (server/bots). Kills, headshots, knife kills and assists on a bot pay this share of the
 * XP, at most BOT_XP_CAP per match in total; only the first BOT_COUNT_CAP bot kills (and assists) of a match
 * count towards challenges and weapon XP / camos. In a lobby with fewer than 2 humans the objective, completion,
 * win and draw XP is scaled by LOBBY_BOT_FACTOR too, and matches / wins / objectives stop counting for challenges.
 */
export const BOT_XP_FACTOR = 0.25;
export const BOT_XP_CAP = 600;
export const BOT_COUNT_CAP = 3;
export const LOBBY_BOT_FACTOR = 0.25;
/** Fewer humans than this in the match = a bot lobby. */
export const MIN_HUMANS = 2;
/** XP from one match is capped (challenge rewards come on top). */
export const MATCH_XP_CAP = 6000;
/** Seconds a player has to be in a match for the completion and win bonus. */
export const MIN_COMPLETION_SECONDS = 45;
/** Damage within this many seconds before a kill earns an assist. */
export const ASSIST_WINDOW = 10;

export interface WeaponTally {
  kills: number; headshots: number; assists: number; shots: number; hits: number;
  /** The part of kills / headshots / assists that was against bots. */
  botKills?: number; botHeadshots?: number; botAssists?: number;
}

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
  /** Kill Confirmed tags picked up: enemy ones (confirmed) and own ones (denied). */
  tagConfirms: number;
  tagDenies: number;
  /** The part of kills / headshots / knife kills / assists that was against bots (they are included in the totals above). */
  botKills: number;
  botHeadshots: number;
  botKnifeKills: number;
  botAssists: number;
  /** XP of the kills on humans after diminishing returns on repeated victims (bot kills are in `botKills`). */
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
  /** Most human players in the match; fewer than MIN_HUMANS = a bot lobby. Unknown (absent) pays in full. */
  humans?: number;
}

/** A lobby without enough human players (everybody else is a bot). */
export function botLobby(o: Pick<MatchOutcome, 'humans'>): boolean {
  return o.humans !== undefined && o.humans < MIN_HUMANS;
}

export function emptyTally(): MatchTally {
  return {
    kills: 0, deaths: 0, assists: 0, headshots: 0, shots: 0, hits: 0, knifeKills: 0, flagCaptures: 0, flagReturns: 0,
    zoneCaptures: 0, hillSeconds: 0, tagConfirms: 0, tagDenies: 0, botKills: 0, botHeadshots: 0, botKnifeKills: 0, botAssists: 0, killXp: 0, bestStreak: 0, seconds: 0, weapons: {},
  };
}

export function emptyWeaponTally(): WeaponTally {
  return { kills: 0, headshots: 0, assists: 0, shots: 0, hits: 0 };
}

/** One line of the end-of-match XP breakdown (`key` is an i18n suffix: xp.line.<key>). */
export interface XpLine {
  key: string; xp: number; count?: number;
  /** Fairness multiplier already applied to this line (0.25 = "x0.25"); absent = full value. */
  mult?: number;
  /** The line hit its limit (bot XP). */
  capped?: boolean;
}

/** The XP lines of a match, capped at MATCH_XP_CAP in total (lines with 0 XP are left out). */
export function matchXp(t: MatchTally, o: MatchOutcome): { lines: XpLine[]; total: number } {
  const lines: XpLine[] = [];
  const add = (key: string, xp: number, count?: number, extra?: Partial<XpLine>) => {
    if (xp > 0) lines.push({ key, xp, ...(count !== undefined ? { count } : {}), ...extra });
  };
  // Kills, headshots, knife kills and assists on humans pay in full; those on bots are one reduced, capped line.
  const bk = Math.min(t.kills, t.botKills), bh = Math.min(t.headshots, t.botHeadshots);
  const bn = Math.min(t.knifeKills, t.botKnifeKills), ba = Math.min(t.assists, t.botAssists);
  add('kills', Math.round(t.killXp), t.kills - bk);
  add('headshots', (t.headshots - bh) * XP.headshot, t.headshots - bh);
  add('knife', (t.knifeKills - bn) * XP.knifeKill, t.knifeKills - bn);
  add('assists', (t.assists - ba) * XP.assist, t.assists - ba);
  const botRaw = bk * XP.kill + bh * XP.headshot + bn * XP.knifeKill + ba * XP.assist;
  const botXp = Math.round(botRaw * BOT_XP_FACTOR);
  add('bots', Math.min(BOT_XP_CAP, botXp), bk + ba, { mult: BOT_XP_FACTOR, ...(botXp > BOT_XP_CAP ? { capped: true } : {}) });
  // Objectives and the match bonuses shrink in a lobby without humans to play against.
  const lobby = botLobby(o);
  const m = lobby ? LOBBY_BOT_FACTOR : 1;
  const extra: Partial<XpLine> | undefined = lobby ? { mult: LOBBY_BOT_FACTOR } : undefined;
  const scaled = (xp: number) => Math.round(xp * m);
  add('captures', scaled(t.flagCaptures * XP.flagCapture), t.flagCaptures, extra);
  add('returns', scaled(t.flagReturns * XP.flagReturn), t.flagReturns, extra);
  add('zones', scaled(t.zoneCaptures * XP.zoneCapture), t.zoneCaptures, extra);
  add('hill', scaled(Math.floor(t.hillSeconds) * XP.hillSecond), Math.floor(t.hillSeconds), extra);
  add('confirms', scaled(t.tagConfirms * XP.tagConfirm), t.tagConfirms, extra);
  add('denies', scaled(t.tagDenies * XP.tagDeny), t.tagDenies, extra);
  if (o.completed) {
    add('completion', scaled(XP.completion), undefined, extra);
    if (o.result === 'win') add('win', scaled(XP.win), undefined, extra);
    else if (o.result === 'draw') add('draw', scaled(XP.draw), undefined, extra);
  }
  let total = lines.reduce((s, l) => s + l.xp, 0);
  if (total > MATCH_XP_CAP) {
    lines.push({ key: 'cap', xp: MATCH_XP_CAP - total });
    total = MATCH_XP_CAP;
  }
  return { lines, total };
}

/**
 * What counts for challenges and weapon XP / camos: everything against humans plus the first BOT_COUNT_CAP
 * kills and assists on bots (headshots and knife kills only while their kill counts). The statistics keep
 * using the raw tally.
 */
export function countedTally(t: MatchTally): MatchTally {
  if (t.botKills === 0 && t.botAssists === 0) return t;
  let killBudget = BOT_COUNT_CAP, assistBudget = BOT_COUNT_CAP;
  const weapons: Record<string, WeaponTally> = {};
  let kills = t.kills - t.botKills, headshots = t.headshots - t.botHeadshots, knife = t.knifeKills - t.botKnifeKills, assists = t.assists - t.botAssists;
  for (const [id, w] of Object.entries(t.weapons)) {
    const bk = Math.min(w.kills, w.botKills ?? 0), bh = Math.min(w.headshots, w.botHeadshots ?? 0), ba = Math.min(w.assists, w.botAssists ?? 0);
    const keepK = Math.min(bk, killBudget), keepA = Math.min(ba, assistBudget);
    const keepH = Math.min(bh, keepK);
    killBudget -= keepK;
    assistBudget -= keepA;
    weapons[id] = { ...w, kills: w.kills - bk + keepK, headshots: w.headshots - bh + keepH, assists: w.assists - ba + keepA };
    kills += keepK; headshots += keepH; assists += keepA;
    if (WEAPON_CLASS[id] === 'melee') knife += keepK;
  }
  return { ...t, kills, headshots, assists, knifeKills: knife, weapons };
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
