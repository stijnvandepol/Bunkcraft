/**
 * Weapon XP, weapon levels and camos. Every weapon earns its own XP (kills, headshots, assists with it); weapon
 * levels unlock camos for that weapon. Camos are procedural colour schemes for the voxel weapon models
 * (rendering/WeaponCamo.ts paints them): no textures, no copyrighted assets.
 */
export const WEAPON_MAX_LEVEL = 25;
export const WEAPON_XP = { kill: 100, headshot: 25, assist: 30 } as const;

/** Weapon XP from weapon level L to L+1. */
export function weaponXpToNext(level: number): number {
  if (level >= WEAPON_MAX_LEVEL) return 0;
  return 500 + 75 * (Math.max(1, Math.floor(level)) - 1);
}

/** Weapon level of a weapon XP total (1..WEAPON_MAX_LEVEL) and the progress into it. */
export function weaponLevel(xp: number): { level: number; into: number; need: number } {
  let rest = Math.max(0, Math.floor(Number.isFinite(xp) ? xp : 0));
  let level = 1;
  while (level < WEAPON_MAX_LEVEL && rest >= weaponXpToNext(level)) {
    rest -= weaponXpToNext(level);
    level++;
  }
  return level >= WEAPON_MAX_LEVEL ? { level, into: 0, need: 0 } : { level, into: rest, need: weaponXpToNext(level) };
}

export type CamoPattern = 'none' | 'blotch' | 'stripe' | 'digital' | 'solid' | 'sparkle';

export interface CamoDef {
  id: string;
  /** Weapon level that unlocks it. */
  level: number;
  pattern: CamoPattern;
  /** Colours the pattern picks from (first = base). */
  palette: readonly string[];
}

export const CAMOS: readonly CamoDef[] = [
  { id: 'none', level: 1, pattern: 'none', palette: [] },
  { id: 'woodland', level: 2, pattern: 'blotch', palette: ['#4f5a3a', '#2f3a22', '#6b5a3a', '#1f241a'] },
  { id: 'desert', level: 4, pattern: 'blotch', palette: ['#c2a878', '#a08a5c', '#e0c898', '#7a6440'] },
  { id: 'arctic', level: 6, pattern: 'digital', palette: ['#e8eef2', '#b8c4cc', '#8a98a4', '#ffffff'] },
  { id: 'urban', level: 8, pattern: 'digital', palette: ['#6a6e74', '#3a3d42', '#9aa0a6', '#25272a'] },
  { id: 'tiger', level: 10, pattern: 'stripe', palette: ['#d9822b', '#1a1a1a'] },
  { id: 'crimson', level: 13, pattern: 'stripe', palette: ['#8e1a1a', '#3a0808', '#c0302a'] },
  { id: 'cobalt', level: 16, pattern: 'digital', palette: ['#1e3f8e', '#3a6fd8', '#0f1f4a', '#7aa8ff'] },
  { id: 'gold', level: 20, pattern: 'solid', palette: ['#e2b93b', '#b88a1a', '#fff0a0'] },
  { id: 'diamond', level: WEAPON_MAX_LEVEL, pattern: 'sparkle', palette: ['#7fe8f0', '#3fbcd0', '#e8ffff', '#a8f4ff'] },
];

const BY_ID = new Map(CAMOS.map((c) => [c.id, c]));

export function camoDef(id: string): CamoDef | undefined {
  return BY_ID.get(id);
}

export function isCamo(id: unknown): id is string {
  return typeof id === 'string' && BY_ID.has(id);
}

/** Whether a weapon at this weapon XP may wear a camo. */
export function camoUnlocked(id: string, weaponXp: number): boolean {
  const c = BY_ID.get(id);
  return !!c && weaponLevel(weaponXp).level >= c.level;
}

/** Camos a weapon gained going from one weapon XP total to another. */
export function camosBetween(fromXp: number, toXp: number): CamoDef[] {
  const a = weaponLevel(fromXp).level, b = weaponLevel(toXp).level;
  return CAMOS.filter((c) => c.level > a && c.level <= b);
}
