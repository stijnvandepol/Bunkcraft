import {
  DEFAULT_PRIMARY, DEFAULT_SECONDARY, type OpticId, type PerkId, PRIMARY_WEAPONS, SECONDARY_WEAPONS, isPerk, opticFor, weaponDef,
} from './Weapons';

/**
 * Create-a-Class: a primary with an optic, a secondary and one perk. The same validation runs on the
 * client (saved class from localStorage) and on the server (the `loadout` message): anything unknown
 * or not allowed falls back to the default, field by field.
 */
export interface ClassSpec {
  primary: string;
  optic: OpticId;
  secondary: string;
  perk: PerkId;
}

/** A class preset: one click in the menu (keys 1-n on the death screen). Ids refer to Weapons.ts. */
export interface LoadoutPreset extends ClassSpec {
  id: string;
  name: string;
  description: string;
}

export const DEFAULT_CLASS: Readonly<ClassSpec> = { primary: DEFAULT_PRIMARY, optic: 'iron', secondary: DEFAULT_SECONDARY, perk: 'none' };

export const LOADOUT_PRESETS: LoadoutPreset[] = [
  { id: 'assault', name: 'Assault', primary: 'rifle', optic: 'reddot', secondary: 'pistol', perk: 'quickdraw', description: 'All-rounder at any range' },
  { id: 'rusher', name: 'Rusher', primary: 'smg', optic: 'iron', secondary: 'mpistol', perk: 'ninja', description: 'Fast, quiet and deadly up close' },
  { id: 'breacher', name: 'Breacher', primary: 'shotgun', optic: 'iron', secondary: 'pistol', perk: 'ninja', description: 'One shot at point blank' },
  { id: 'support', name: 'Support', primary: 'lmg', optic: 'holo', secondary: 'pistol', perk: 'extmag', description: 'Holds a lane, wins multi-kills' },
  { id: 'marksman', name: 'Marksman', primary: 'dmr', optic: 'scope', secondary: 'revolver', perk: 'none', description: 'Scoped, precise at medium and long range' },
  { id: 'burst', name: 'Burst', primary: 'burst', optic: 'holo', secondary: 'pistol', perk: 'suppressor', description: 'Tight, quiet three-round bursts' },
  { id: 'sniper', name: 'Sniper', primary: 'sniper', optic: 'scope', secondary: 'mpistol', perk: 'quickdraw', description: 'One shot, one kill' },
];

/** A class picked within this many seconds of spawning (and before the first shot) applies at once in a live round. */
export const CLASS_SWAP_WINDOW = 3;

/** Phases without fighting: a class picked then applies at once (warm-up, countdown, between rounds). */
export function calmPhase(phase: string): boolean {
  return phase === 'warmup' || phase === 'countdown' || phase === 'roundend' || phase === 'intermission';
}

/**
 * When a class picked now is put in your hands (the server's rule in Match.setLoadout): at once outside a live round or
 * right after spawning before the first shot, at the respawn while dead (or after the match), else from the next life.
 */
export function classApplies(phase: string, alive: boolean, firedThisLife: boolean, sinceSpawn: number): 'now' | 'respawn' | 'nextLife' {
  if (!alive || phase === 'ended') return 'respawn';
  if (calmPhase(phase) || (!firedThisLife && sinceSpawn <= CLASS_SWAP_WINDOW)) return 'now';
  return 'nextLife';
}

/** A valid class from anything (saved JSON, a network message): unknown or disallowed fields become the default. */
export function validateClass(raw: unknown): ClassSpec {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const primary = typeof r.primary === 'string' && PRIMARY_WEAPONS.includes(r.primary) ? r.primary : DEFAULT_CLASS.primary;
  const secondary = typeof r.secondary === 'string' && SECONDARY_WEAPONS.includes(r.secondary) ? r.secondary : DEFAULT_CLASS.secondary;
  const optic = opticFor(weaponDef(primary)!, typeof r.optic === 'string' ? r.optic : undefined);
  const perk = isPerk(r.perk) ? r.perk : DEFAULT_CLASS.perk;
  return { primary, optic, secondary, perk };
}

export function sameClass(a: ClassSpec, b: ClassSpec): boolean {
  return a.primary === b.primary && a.optic === b.optic && a.secondary === b.secondary && a.perk === b.perk;
}

/** The preset matching a class exactly, or null for a custom class. */
export function presetFor(c: ClassSpec): LoadoutPreset | null {
  return LOADOUT_PRESETS.find((p) => sameClass(p, c)) ?? null;
}

/** Whether every preset is a valid class (validation keeps it unchanged). */
export function presetsValid(): boolean {
  return LOADOUT_PRESETS.every((p) => sameClass(validateClass(p), p));
}

/** localStorage key of the custom class (Create-a-Class); per browser, like the settings. */
export const CLASS_STORAGE_KEY = 'bunkcraft.arcadeClass';
/** localStorage key of the class last chosen (a preset or the custom one): sent when joining an arcade game. */
export const LAST_CLASS_STORAGE_KEY = 'bunkcraft.arcadeClass.last';

/** The saved custom class, or null (nothing saved, storage blocked, broken JSON). */
export function loadSavedClass(storage: Pick<Storage, 'getItem'> | null, key = CLASS_STORAGE_KEY): ClassSpec | null {
  try {
    const raw = storage?.getItem(key);
    return raw ? validateClass(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function saveClass(storage: Pick<Storage, 'setItem'> | null, c: ClassSpec, key = CLASS_STORAGE_KEY): void {
  try {
    storage?.setItem(key, JSON.stringify(c));
  } catch { /* private mode, quota: the class just is not remembered */ }
}
