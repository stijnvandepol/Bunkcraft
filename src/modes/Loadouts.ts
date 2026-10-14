import {
  DEFAULT_PRIMARY, DEFAULT_SECONDARY, type Kit, type OpticId, type PerkId, PRIMARY_WEAPONS, type RailId, SECONDARY_WEAPONS, type UnderId,
  attachAllowed, isPerk, opticFor, perksCompatible, weaponDef,
} from './Weapons';

/**
 * Create-a-Class: a primary with an optic and up to two attachments (a grip under the barrel, a laser on the rail), a
 * secondary and two perks from different categories. The same validation runs on the client (saved classes) and on
 * the server (the `loadout` message): anything unknown or not allowed falls back to the default, field by field.
 * (The server is stricter about the newer fields: see Unlocks.parseExtras.)
 */
export interface ClassSpec extends Kit {
  primary: string;
  optic: OpticId;
  secondary: string;
}

/** A class preset: a template in Create-a-Class (it fills one of your class slots). Ids refer to Weapons.ts. */
export interface LoadoutPreset extends ClassSpec {
  id: string;
  name: string;
  description: string;
}

export const DEFAULT_CLASS: Readonly<ClassSpec> = {
  primary: DEFAULT_PRIMARY, optic: 'iron', under: 'none', rail: 'none', secondary: DEFAULT_SECONDARY, perk: 'none', perk2: 'none',
};

/** A preset from its gear (no attachments or second perk unless given). */
function preset(id: string, name: string, primary: string, optic: OpticId, secondary: string, perk: PerkId, description: string, extra: Partial<ClassSpec> = {}): LoadoutPreset {
  return { id, name, primary, optic, under: 'none', rail: 'none', secondary, perk, perk2: 'none', description, ...extra };
}

export const LOADOUT_PRESETS: LoadoutPreset[] = [
  preset('assault', 'Assault', 'rifle', 'reddot', 'pistol', 'quickdraw', 'All-rounder at any range'),
  preset('rusher', 'Rusher', 'smg', 'iron', 'mpistol', 'ninja', 'Fast, quiet and deadly up close', { rail: 'laser' }),
  preset('breacher', 'Breacher', 'shotgun', 'iron', 'pistol', 'ninja', 'One shot at point blank'),
  preset('support', 'Support', 'lmg', 'holo', 'pistol', 'extmag', 'Holds a lane, wins multi-kills', { under: 'vgrip' }),
  preset('marksman', 'Marksman', 'dmr', 'scope', 'revolver', 'none', 'Scoped, precise at medium and long range'),
  preset('burst', 'Burst', 'burst', 'holo', 'pistol', 'suppressor', 'Tight, quiet three-round bursts'),
  preset('sniper', 'Sniper', 'sniper', 'scope', 'mpistol', 'quickdraw', 'One shot, one kill'),
  preset('scout', 'Scout', 'smg', 'iron', 'pistol', 'lightfoot', 'Fastest on foot: slide in, knife or spray, slide out'),
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

/** An attachment for a slot of a primary: the request when the weapon takes it, else none. */
export function underFor(primary: string, v: unknown): UnderId {
  const w = weaponDef(primary);
  return (v === 'vgrip' || v === 'agrip') && !!w && attachAllowed(w, v) ? v : 'none';
}

export function railFor(primary: string, v: unknown): RailId {
  const w = weaponDef(primary);
  return v === 'laser' && !!w && attachAllowed(w, v) ? v : 'none';
}

/**
 * A valid class from anything (saved JSON, a network message): unknown or disallowed fields become the default. An
 * attachment the primary does not take is dropped, and a second perk from the first perk's category too.
 */
export function validateClass(raw: unknown): ClassSpec {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const primary = typeof r.primary === 'string' && PRIMARY_WEAPONS.includes(r.primary) ? r.primary : DEFAULT_CLASS.primary;
  const secondary = typeof r.secondary === 'string' && SECONDARY_WEAPONS.includes(r.secondary) ? r.secondary : DEFAULT_CLASS.secondary;
  const optic = opticFor(weaponDef(primary)!, typeof r.optic === 'string' ? r.optic : undefined);
  const perk = isPerk(r.perk) ? r.perk : DEFAULT_CLASS.perk;
  const perk2 = isPerk(r.perk2) && r.perk2 !== perk && perksCompatible(perk, r.perk2) ? r.perk2 : 'none';
  return { primary, optic, under: underFor(primary, r.under), rail: railFor(primary, r.rail), secondary, perk, perk2 };
}

export function sameClass(a: ClassSpec, b: ClassSpec): boolean {
  return a.primary === b.primary && a.optic === b.optic && a.secondary === b.secondary && a.perk === b.perk
    && a.perk2 === b.perk2 && a.under === b.under && a.rail === b.rail;
}

/** The preset matching a class exactly, or null for a custom class. */
export function presetFor(c: ClassSpec): LoadoutPreset | null {
  return LOADOUT_PRESETS.find((p) => sameClass(p, c)) ?? null;
}

/** Whether every preset is a valid class (validation keeps it unchanged). */
export function presetsValid(): boolean {
  return LOADOUT_PRESETS.every((p) => sameClass(validateClass(p), p));
}

/** The attachments of a class as the `loadout` message carries them (one key per attachment slot). */
export function attOf(c: Pick<ClassSpec, 'under' | 'rail'>): { under: UnderId; rail: RailId } {
  return { under: c.under, rail: c.rail };
}

/** The `loadout` message for a class. */
export function loadoutMessage(c: ClassSpec): { t: 'loadout'; primary: string; secondary: string; optic: string; perk: string; perk2: string; att: { under: UnderId; rail: RailId } } {
  return { t: 'loadout', primary: c.primary, secondary: c.secondary, optic: c.optic, perk: c.perk, perk2: c.perk2, att: attOf(c) };
}

/**
 * localStorage key of the old single custom class (before multiple classes). Read once to migrate it into slot 1 of the
 * class book (ClassBook.ts); never written any more.
 */
export const CLASS_STORAGE_KEY = 'bunkcraft.arcadeClass';
/** localStorage key of the class last chosen before multiple classes (a preset or the custom one): migrated too. */
export const LAST_CLASS_STORAGE_KEY = 'bunkcraft.arcadeClass.last';

/** A saved class, or null (nothing saved, storage blocked, broken JSON). */
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
