import { DEFAULT_PRIMARY, DEFAULT_SECONDARY, weaponDef } from './Weapons';

/** A class: a primary and a secondary weapon picked in one click. Ids refer to Weapons.ts. */
export interface LoadoutPreset {
  id: string;
  name: string;
  primary: string;
  secondary: string;
  description: string;
}

export const LOADOUT_PRESETS: LoadoutPreset[] = [
  { id: 'assault', name: 'Assault', primary: 'rifle', secondary: 'pistol', description: 'All-rounder at any range' },
  { id: 'rusher', name: 'Rusher', primary: 'smg', secondary: 'pistol', description: 'Fast and deadly up close' },
  { id: 'breacher', name: 'Breacher', primary: 'shotgun', secondary: 'pistol', description: 'One shot at point blank' },
  { id: 'marksman', name: 'Marksman', primary: 'dmr', secondary: 'revolver', description: 'Precise at medium and long range' },
  { id: 'burst', name: 'Burst', primary: 'burst', secondary: 'pistol', description: 'Tight three-round bursts' },
  { id: 'sniper', name: 'Sniper', primary: 'sniper', secondary: 'pistol', description: 'One headshot, one kill' },
];

/** The preset matching a primary/secondary pair, or null for a custom combination. */
export function presetFor(primary: string, secondary: string): LoadoutPreset | null {
  return LOADOUT_PRESETS.find((p) => p.primary === primary && p.secondary === secondary) ?? null;
}

/** Whether every preset points at real weapons in the right slots. */
export function presetsValid(): boolean {
  return LOADOUT_PRESETS.every((p) => weaponDef(p.primary)?.slot === 'primary' && weaponDef(p.secondary)?.slot === 'secondary');
}

export const DEFAULT_LOADOUT = { primary: DEFAULT_PRIMARY, secondary: DEFAULT_SECONDARY };
