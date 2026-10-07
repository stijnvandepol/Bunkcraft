import { type ClassSpec, DEFAULT_CLASS, validateClass } from '../Loadouts';
import { type OpticId, type PerkId, PERK_IDS, PRIMARY_WEAPONS, SECONDARY_WEAPONS, weaponDef } from '../Weapons';
import { MAX_LEVEL, type Rank } from './Levels';

/**
 * What unlocks with the player level. Level 1 already has a full, competitive kit (assault rifle, SMG,
 * shotgun, pistol, red dot, Extended Mags) so a new player is never outgunned; the rest are side-grades that
 * arrive over the first ~20 levels. Once unlocked, always unlocked: a prestiged player keeps everything.
 *
 * The same table runs on the server (a locked class field falls back to the default) and in the menus
 * (Create-a-Class shows locked items with their level).
 */
export type UnlockKind = 'primary' | 'secondary' | 'optic' | 'perk' | 'title' | 'card';

export interface Unlock {
  kind: UnlockKind;
  id: string;
  /** Player level that unlocks it (any prestige > 0 has everything with a level requirement). */
  level: number;
  /** Prestige needed instead of a level (titles and cards for prestige). */
  prestige?: number;
  /** Completed challenges needed instead of a level (titles). */
  challenges?: number;
}

/** Equipment unlocks; anything not listed is available from level 1. */
export const EQUIPMENT_UNLOCKS: readonly Unlock[] = [
  { kind: 'perk', id: 'quickdraw', level: 2 },
  { kind: 'optic', id: 'holo', level: 3 },
  { kind: 'secondary', id: 'mpistol', level: 4 },
  { kind: 'primary', id: 'dmr', level: 5 },
  { kind: 'perk', id: 'ninja', level: 6 },
  { kind: 'primary', id: 'lmg', level: 7 },
  { kind: 'optic', id: 'scope', level: 8 },
  { kind: 'primary', id: 'burst', level: 9 },
  { kind: 'secondary', id: 'revolver', level: 10 },
  { kind: 'perk', id: 'suppressor', level: 12 },
  { kind: 'primary', id: 'semisniper', level: 14 },
  { kind: 'primary', id: 'sniper', level: 16 },
];

/** Titles shown under your name in the Realms hub. */
export const TITLES: readonly Unlock[] = [
  { kind: 'title', id: 'recruit', level: 1 },
  { kind: 'title', id: 'soldier', level: 10 },
  { kind: 'title', id: 'sharpshooter', level: 20 },
  { kind: 'title', id: 'veteran', level: 30 },
  { kind: 'title', id: 'elite', level: 40 },
  { kind: 'title', id: 'commander', level: 50 },
  { kind: 'title', id: 'legend', level: MAX_LEVEL },
  { kind: 'title', id: 'grinder', level: 1, challenges: 10 },
  { kind: 'title', id: 'ironman', level: 1, challenges: 50 },
  { kind: 'title', id: 'prestige', level: 1, prestige: 1 },
  { kind: 'title', id: 'master', level: 1, prestige: 5 },
  { kind: 'title', id: 'immortal', level: 1, prestige: 10 },
];

/** Calling cards: procedural backgrounds of the profile banner (colours in CARD_STYLES). */
export const CARDS: readonly Unlock[] = [
  { kind: 'card', id: 'stone', level: 1 },
  { kind: 'card', id: 'grass', level: 3 },
  { kind: 'card', id: 'ocean', level: 8 },
  { kind: 'card', id: 'sunset', level: 15 },
  { kind: 'card', id: 'nether', level: 25 },
  { kind: 'card', id: 'end', level: 35 },
  { kind: 'card', id: 'gold', level: 45 },
  { kind: 'card', id: 'diamond', level: MAX_LEVEL },
  { kind: 'card', id: 'prestige', level: 1, prestige: 1 },
];

/** Gradient stops of each calling card (left to right) and the accent of its pixel pattern. */
export const CARD_STYLES: Record<string, { from: string; to: string; accent: string }> = {
  stone: { from: '#4a4a4a', to: '#6e6e6e', accent: '#8a8a8a' },
  grass: { from: '#2f5a1e', to: '#5d8f2f', accent: '#79c05a' },
  ocean: { from: '#163a6b', to: '#2b6fa8', accent: '#5fb0e6' },
  sunset: { from: '#7a2a3a', to: '#e0803a', accent: '#ffd06a' },
  nether: { from: '#3a0f0f', to: '#8e2a1e', accent: '#ff6a2a' },
  end: { from: '#1c1630', to: '#5a3f8a', accent: '#d8d0a0' },
  gold: { from: '#7a5a10', to: '#e2b93b', accent: '#fff3a0' },
  diamond: { from: '#1d5f66', to: '#5fe0e8', accent: '#e8ffff' },
  prestige: { from: '#3a0a4a', to: '#c0306a', accent: '#ffd23f' },
};

export const DEFAULT_TITLE = 'recruit';
export const DEFAULT_CARD = 'stone';

const LEVEL_OF = new Map<string, Unlock>(EQUIPMENT_UNLOCKS.map((u) => [`${u.kind}:${u.id}`, u]));

/** Level needed for an equipment item (1 = from the start). */
export function unlockLevel(kind: 'primary' | 'secondary' | 'optic' | 'perk', id: string): number {
  return LEVEL_OF.get(`${kind}:${id}`)?.level ?? 1;
}

/** Whether a rank has an unlock. `challenges` = challenges completed so far (titles). */
export function hasUnlock(u: Unlock, rank: Rank, challenges = 0): boolean {
  if (u.prestige !== undefined) return rank.prestige >= u.prestige;
  if (u.challenges !== undefined) return challenges >= u.challenges;
  return rank.prestige > 0 || rank.level >= u.level;
}

/** Whether a rank may use an equipment item. */
export function isUnlocked(kind: 'primary' | 'secondary' | 'optic' | 'perk', id: string, rank: Rank): boolean {
  return rank.prestige > 0 || rank.level >= unlockLevel(kind, id);
}

/**
 * A class with every locked field replaced: a locked primary becomes the default primary (and its optic is
 * checked again), a locked optic the weapon's default sights, a locked secondary or perk the default.
 * The input is validated first, so this accepts anything.
 */
export function lockClass(raw: unknown, rank: Rank): ClassSpec {
  const c = validateClass(raw);
  const primary = isUnlocked('primary', c.primary, rank) ? c.primary : DEFAULT_CLASS.primary;
  const secondary = isUnlocked('secondary', c.secondary, rank) ? c.secondary : DEFAULT_CLASS.secondary;
  const perk: PerkId = isUnlocked('perk', c.perk, rank) ? c.perk : DEFAULT_CLASS.perk;
  const w = weaponDef(primary)!;
  // An optic the weapon does not take or the rank lacks: the first allowed (and unlocked) sights of the weapon.
  let optic: OpticId = primary === c.primary ? c.optic : w.optics[0];
  if (!w.optics.includes(optic) || !isUnlocked('optic', optic, rank)) {
    optic = w.optics.find((o) => isUnlocked('optic', o, rank)) ?? w.optics[0];
  }
  return { primary, secondary, optic, perk };
}

/** Whether every field of a class is unlocked (a preset card is usable as it is). */
export function classUnlocked(c: ClassSpec, rank: Rank): boolean {
  return isUnlocked('primary', c.primary, rank) && isUnlocked('secondary', c.secondary, rank)
    && isUnlocked('perk', c.perk, rank) && (isUnlocked('optic', c.optic, rank) || weaponDef(c.primary)?.optics[0] === c.optic);
}

/** Everything (equipment, titles, cards) that a level-up from `from` to `to` (same prestige) unlocks, in level order. */
export function unlocksBetween(from: number, to: number, prestige: number): Unlock[] {
  if (prestige > 0) return [...TITLES, ...CARDS].filter((u) => u.prestige === undefined && u.challenges === undefined && u.level > from && u.level <= to);
  return [...EQUIPMENT_UNLOCKS, ...TITLES, ...CARDS]
    .filter((u) => u.prestige === undefined && u.challenges === undefined && u.level > from && u.level <= to)
    .sort((a, b) => a.level - b.level);
}

/** All equipment, in menu order, with the level each item needs. */
export function equipmentList(): { kind: 'primary' | 'secondary' | 'optic' | 'perk'; id: string; level: number }[] {
  const out: { kind: 'primary' | 'secondary' | 'optic' | 'perk'; id: string; level: number }[] = [];
  for (const id of PRIMARY_WEAPONS) out.push({ kind: 'primary', id, level: unlockLevel('primary', id) });
  for (const id of SECONDARY_WEAPONS) out.push({ kind: 'secondary', id, level: unlockLevel('secondary', id) });
  for (const id of ['iron', 'reddot', 'holo', 'scope']) out.push({ kind: 'optic', id, level: unlockLevel('optic', id) });
  for (const id of PERK_IDS) out.push({ kind: 'perk', id, level: unlockLevel('perk', id) });
  return out;
}

export function isTitle(id: unknown): id is string {
  return typeof id === 'string' && TITLES.some((u) => u.id === id);
}

export function isCard(id: unknown): id is string {
  return typeof id === 'string' && CARDS.some((u) => u.id === id);
}
