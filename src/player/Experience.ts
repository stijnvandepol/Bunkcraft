/**
 * Experience as in Minecraft Java 1.21 (wiki: Experience). DOM-free so the server, the tests and the HUD share it.
 *
 * The player has a total number of points; the level and the fraction of the bar follow from it:
 *  - points needed to go from level L to L+1: L <= 15: 2L+7, 16..30: 5L-38, >= 31: 9L-158;
 *  - total points at the start of level L: L <= 16: L^2+6L, 17..31: 2.5L^2-40.5L+360, >= 32: 4.5L^2-162.5L+2220.
 * Spending levels (enchanting, anvil) keeps the fraction of the bar, like the game does.
 */

export const MAX_LEVEL = 100_000;

export function xpToNextLevel(level: number): number {
  if (level <= 15) return 2 * level + 7;
  if (level <= 30) return 5 * level - 38;
  return 9 * level - 158;
}

export function totalXpForLevel(level: number): number {
  if (level <= 16) return level * level + 6 * level;
  if (level <= 31) return Math.round(2.5 * level * level - 40.5 * level + 360);
  return Math.round(4.5 * level * level - 162.5 * level + 2220);
}

export interface XpState {
  level: number;
  /** Points inside the current level. */
  into: number;
  /** 0..1: how far the bar is filled. */
  progress: number;
}

/** Level and bar fraction of a point total. */
export function levelFromTotal(total: number): XpState {
  let level = 0;
  const t = Math.max(0, Math.floor(total));
  // Closed form for the three ranges, then a correction step for rounding.
  if (t >= totalXpForLevel(32)) level = Math.floor((162.5 + Math.sqrt(162.5 * 162.5 - 18 * (2220 - t))) / 9);
  else if (t >= totalXpForLevel(17)) level = Math.floor((40.5 + Math.sqrt(40.5 * 40.5 - 10 * (360 - t))) / 5);
  else level = Math.floor(-3 + Math.sqrt(9 + t));
  while (level > 0 && totalXpForLevel(level) > t) level--;
  while (totalXpForLevel(level + 1) <= t) level++;
  const into = t - totalXpForLevel(level);
  return { level, into, progress: into / xpToNextLevel(level) };
}

/** Orb sizes by value (the wiki's table): index into the 11 sprites, 0 = smallest. */
export function orbTier(value: number): number {
  if (value >= 2477) return 10;
  if (value >= 1237) return 9;
  if (value >= 617) return 8;
  if (value >= 307) return 7;
  if (value >= 149) return 6;
  if (value >= 73) return 5;
  if (value >= 37) return 4;
  if (value >= 17) return 3;
  if (value >= 7) return 2;
  if (value >= 3) return 1;
  return 0;
}

/** Orb values an amount of experience is cut into (largest first), like ExperienceOrb.getExperienceValue. */
export const ORB_VALUES = [2477, 1237, 617, 307, 149, 73, 37, 17, 7, 3, 1] as const;

export function splitXp(amount: number): number[] {
  const out: number[] = [];
  let left = Math.floor(amount);
  while (left > 0) {
    const v = ORB_VALUES.find((x) => left >= x) ?? 1;
    out.push(v);
    left -= v;
  }
  return out;
}

/** Points dropped on death: 7 per level, at most 100 (the rest is lost). */
export function deathXp(level: number): number {
  return Math.min(level * 7, 100);
}

/** Fractional experience (smelting 0.35 per item) becomes a whole number: the fraction is the chance of one more point. */
export function wholeXp(amount: number, rand: () => number = Math.random): number {
  const whole = Math.floor(amount);
  return whole + (rand() < amount - whole ? 1 : 0);
}

// ---------------------------------------------------------------- sources

/** Experience a mob gives when the player killed it: [min, max] points. Unknown hostile mobs give 5, unknown passive ones 1-3. */
export const MOB_XP: Record<string, [number, number]> = {
  zombie: [5, 5], skeleton: [5, 5], creeper: [5, 5], spider: [5, 5],
  pig: [1, 3], cow: [1, 3], sheep: [1, 3], chicken: [1, 3],
};

export function mobXp(kind: string, hostile: boolean, rand: () => number = Math.random): number {
  const [lo, hi] = MOB_XP[kind] ?? (hostile ? [5, 5] : [1, 3]);
  return lo + Math.floor(rand() * (hi - lo + 1));
}

/** Experience of breaking an ore without Silk Touch: block name -> [min, max]. Iron, gold and copper ore give it when smelted. */
export const ORE_XP: Record<string, [number, number]> = {
  coal_ore: [0, 2], lapis_ore: [2, 5], redstone_ore: [1, 5], diamond_ore: [3, 7], emerald_ore: [3, 7],
};

export function oreXp(blockName: string, rand: () => number = Math.random): number {
  const r = ORE_XP[blockName];
  return r ? r[0] + Math.floor(rand() * (r[1] - r[0] + 1)) : 0;
}

/** Experience per smelted item, by the name of the result (wiki: Smelting). Hook for the furnace: `awardXp(entities, x, y, z, wholeXp(SMELT_XP[name] * count))`. */
export const SMELT_XP: Record<string, number> = {
  iron_ingot: 0.7, gold_ingot: 1, copper_ingot: 0.7, coal: 0.1, diamond: 1, emerald: 1, lapis_lazuli: 0.2, redstone: 0.3,
  glass: 0.1, stone: 0.1, smooth_stone: 0.1, smooth_sandstone: 0.1, smooth_red_sandstone: 0.1, cracked_stone_bricks: 0.1,
  brick: 0.3, terracotta: 0.35, charcoal: 0.15, green_dye: 1, baked_potato: 0.35, cooked_porkchop: 0.35, steak: 0.35,
  cooked_mutton: 0.35, cooked_chicken: 0.35, cooked_rabbit: 0.35, cooked_cod: 0.35, cooked_salmon: 0.35,
};

/** Breeding gives 1-7 points, fishing 1-6 (hooks for the farming and fishing developers). */
export function breedingXp(rand: () => number = Math.random): number {
  return 1 + Math.floor(rand() * 7);
}
export function fishingXp(rand: () => number = Math.random): number {
  return 1 + Math.floor(rand() * 6);
}

// ---------------------------------------------------------------- the player's experience

export class Experience {
  /** Total points the bar currently holds. */
  total = 0;
  private state: XpState = { level: 0, into: 0, progress: 0 };
  /** Fired with the new level whenever the level goes up. */
  onLevelUp: ((level: number) => void) | null = null;
  /** Fired after any change (HUD). */
  onChange: (() => void) | null = null;

  get level(): number {
    return this.state.level;
  }

  get progress(): number {
    return this.state.progress;
  }

  /** Points left until the next level. */
  get toNext(): number {
    return xpToNextLevel(this.state.level) - this.state.into;
  }

  reset(): void {
    this.set(0);
  }

  set(total: number): void {
    this.total = Math.max(0, Math.floor(Number.isFinite(total) ? total : 0));
    this.state = levelFromTotal(this.total);
    this.onChange?.();
  }

  /** Adds points; returns how many levels were gained. */
  add(points: number): number {
    if (!(points > 0)) return 0;
    const before = this.state.level;
    this.total = Math.min(this.total + Math.floor(points), totalXpForLevel(MAX_LEVEL));
    this.state = levelFromTotal(this.total);
    if (this.state.level > before) this.onLevelUp?.(this.state.level);
    this.onChange?.();
    return this.state.level - before;
  }

  /**
   * Pays levels (enchanting table, anvil). The fraction of the bar stays. Returns false when the player has too few levels.
   * Creative players pay nothing: pass `free`.
   */
  spendLevels(n: number, free = false): boolean {
    if (free) return true;
    if (n <= 0) return true;
    if (this.state.level < n) return false;
    const target = this.state.level - n;
    this.total = totalXpForLevel(target) + Math.floor(this.state.progress * xpToNextLevel(target));
    this.state = levelFromTotal(this.total);
    this.onChange?.();
    return true;
  }

  /** Removes points (death keeps nothing). */
  take(points: number): void {
    this.set(this.total - points);
  }

  /** Saved form: just the point total. */
  serialize(): number {
    return this.total;
  }
}
