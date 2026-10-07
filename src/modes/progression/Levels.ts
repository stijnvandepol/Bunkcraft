/**
 * Player levels for BunkCraft Realms: 1-55 per prestige, then up to MAX_PRESTIGE prestiges (CoD style).
 * Pure numbers shared by the server (authoritative XP) and the menus (level bar, rank icons).
 *
 * The step from level L to L+1 costs XP_BASE + XP_STEP * (L - 1): the first level takes about one match,
 * level 55 roughly 180 matches of ten minutes.
 */
export const MAX_LEVEL = 55;
export const MAX_PRESTIGE = 10;
export const XP_BASE = 800;
export const XP_STEP = 120;

/** XP needed to go from `level` to the next one (0 at the cap). */
export function xpToNext(level: number): number {
  if (level >= MAX_LEVEL) return 0;
  return XP_BASE + XP_STEP * (Math.max(1, Math.floor(level)) - 1);
}

/** XP needed from 0 to reach `level` (level 1 = 0). */
export function totalXpForLevel(level: number): number {
  const l = Math.min(MAX_LEVEL, Math.max(1, Math.floor(level)));
  const n = l - 1;
  return XP_BASE * n + (XP_STEP * n * (n - 1)) / 2;
}

/** XP of one full prestige (level 1 to 55). */
export const PRESTIGE_XP = totalXpForLevel(MAX_LEVEL);

export interface LevelInfo {
  level: number;
  /** XP into the current level and the size of it (0 at the cap). */
  into: number;
  need: number;
}

/** Level of an XP total within one prestige (capped at MAX_LEVEL). */
export function levelFromXp(xp: number): LevelInfo {
  const x = Math.max(0, Math.floor(Number.isFinite(xp) ? xp : 0));
  // Solve the quadratic, then fix rounding by stepping.
  const a = XP_STEP / 2, b = XP_BASE - XP_STEP / 2;
  let level = Math.floor((-b + Math.sqrt(b * b + 4 * a * x)) / (2 * a)) + 1;
  level = Math.min(MAX_LEVEL, Math.max(1, level));
  while (level < MAX_LEVEL && totalXpForLevel(level + 1) <= x) level++;
  while (level > 1 && totalXpForLevel(level) > x) level--;
  if (level >= MAX_LEVEL) return { level: MAX_LEVEL, into: 0, need: 0 };
  return { level, into: x - totalXpForLevel(level), need: xpToNext(level) };
}

/** A rank as sent in the roster: prestige * 100 + level (0 = unknown, e.g. a bot or a guest). */
export function rankCode(level: number, prestige: number): number {
  return Math.min(MAX_PRESTIGE, Math.max(0, Math.floor(prestige))) * 100 + Math.min(MAX_LEVEL, Math.max(1, Math.floor(level)));
}

export interface Rank { level: number; prestige: number }

/** The rank of a roster code, or null when there is none. */
export function parseRank(code: unknown): Rank | null {
  if (typeof code !== 'number' || !Number.isInteger(code) || code < 1) return null;
  const prestige = Math.floor(code / 100), level = code % 100;
  if (level < 1 || level > MAX_LEVEL || prestige > MAX_PRESTIGE) return null;
  return { level, prestige };
}

/** Badge tier for the rank icon: one per five levels (0-10). */
export function rankTier(level: number): number {
  return Math.min(10, Math.max(0, Math.floor((Math.min(MAX_LEVEL, Math.max(1, level)) - 1) / 5)));
}

/** Whether a player at this rank may enter the next prestige (level cap reached, prestiges left). */
export function canPrestige(r: Rank): boolean {
  return r.level >= MAX_LEVEL && r.prestige < MAX_PRESTIGE;
}
