/**
 * Weapons for the arcade game types. All numbers are authoritative on the server; the client
 * only predicts the visuals (recoil, tracers, ammo counter) and takes the server's word for hits.
 * Damage is out of 100 health.
 */
export type WeaponSlot = 'primary' | 'secondary' | 'melee';

export interface WeaponDef {
  id: string;
  name: string;
  slot: WeaponSlot;
  /** Hold the button to keep firing. */
  auto: boolean;
  /** Damage per bullet (pellet) to the body. */
  damage: number;
  /** Multiplier for a headshot. */
  headshot: number;
  /** Bullets per shot (shotgun pellets). */
  pellets: number;
  /** Shots per minute. */
  rpm: number;
  magazine: number;
  reloadSec: number;
  /** Cone half-angle in degrees when firing from the hip and when aiming down the sights. */
  spread: number;
  adsSpread: number;
  /** Full damage up to `range` blocks, falling off linearly to `minDamage` (fraction) at `falloffEnd`. */
  range: number;
  falloffEnd: number;
  minDamage: number;
  /** Maximum distance a bullet travels. */
  maxRange: number;
  /** Field of view multiplier when aiming (0.5 = 2× zoom). */
  zoom: number;
  /** Movement speed multiplier while holding it. */
  moveSpeed: number;
  /** Camera kick per shot in degrees (vertical). */
  recoil: number;
  /** Burst weapons fire this many shots per trigger pull, `rpm` apart; the next burst may start `burstCycleSec` after the first shot. */
  burst?: number;
  burstCycleSec?: number;
}

export const WEAPONS: WeaponDef[] = [
  {
    id: 'rifle', name: 'Assault Rifle', slot: 'primary', auto: true, damage: 20, headshot: 2, pellets: 1, rpm: 600,
    magazine: 30, reloadSec: 1.6, spread: 2.2, adsSpread: 0.4, range: 40, falloffEnd: 90, minDamage: 0.6, maxRange: 150,
    zoom: 0.8, moveSpeed: 1, recoil: 0.9,
  },
  {
    id: 'smg', name: 'SMG', slot: 'primary', auto: true, damage: 15, headshot: 1.8, pellets: 1, rpm: 900,
    magazine: 25, reloadSec: 1.3, spread: 2.6, adsSpread: 1.2, range: 16, falloffEnd: 50, minDamage: 0.5, maxRange: 100,
    zoom: 0.85, moveSpeed: 1.08, recoil: 0.6,
  },
  {
    id: 'shotgun', name: 'Shotgun', slot: 'primary', auto: false, damage: 13, headshot: 1.5, pellets: 10, rpm: 70,
    magazine: 6, reloadSec: 2.4, spread: 4.5, adsSpread: 3.5, range: 6, falloffEnd: 20, minDamage: 0.15, maxRange: 40,
    zoom: 0.9, moveSpeed: 0.97, recoil: 4,
  },
  {
    id: 'sniper', name: 'Sniper Rifle', slot: 'primary', auto: false, damage: 85, headshot: 1.6, pellets: 1, rpm: 45,
    magazine: 4, reloadSec: 2.2, spread: 9, adsSpread: 0, range: 300, falloffEnd: 300, minDamage: 1, maxRange: 400,
    zoom: 0.25, moveSpeed: 0.92, recoil: 3,
  },
  {
    id: 'dmr', name: 'DMR', slot: 'primary', auto: false, damage: 34, headshot: 2, pellets: 1, rpm: 270,
    magazine: 12, reloadSec: 2, spread: 3.5, adsSpread: 0.1, range: 60, falloffEnd: 140, minDamage: 0.7, maxRange: 250,
    zoom: 0.55, moveSpeed: 0.96, recoil: 1.6,
  },
  {
    id: 'burst', name: 'Burst Rifle', slot: 'primary', auto: false, damage: 22, headshot: 1.6, pellets: 1, rpm: 900,
    magazine: 30, reloadSec: 1.7, spread: 2, adsSpread: 0.25, range: 45, falloffEnd: 100, minDamage: 0.6, maxRange: 160,
    zoom: 0.8, moveSpeed: 1, recoil: 1.2, burst: 3, burstCycleSec: 0.38,
  },
  {
    id: 'pistol', name: 'Pistol', slot: 'secondary', auto: false, damage: 18, headshot: 2, pellets: 1, rpm: 400,
    magazine: 12, reloadSec: 1.1, spread: 1.8, adsSpread: 0.5, range: 25, falloffEnd: 60, minDamage: 0.5, maxRange: 100,
    zoom: 0.9, moveSpeed: 1.04, recoil: 1.1,
  },
  {
    id: 'revolver', name: 'Revolver', slot: 'secondary', auto: false, damage: 52, headshot: 2, pellets: 1, rpm: 150,
    magazine: 6, reloadSec: 2.4, spread: 2.5, adsSpread: 0.15, range: 30, falloffEnd: 70, minDamage: 0.6, maxRange: 120,
    zoom: 0.85, moveSpeed: 1, recoil: 4.5,
  },
  {
    id: 'knife', name: 'Knife', slot: 'melee', auto: false, damage: 55, headshot: 1, pellets: 1, rpm: 120,
    magazine: 0, reloadSec: 0, spread: 0, adsSpread: 0, range: 2.6, falloffEnd: 2.6, minDamage: 1, maxRange: 2.6,
    zoom: 1, moveSpeed: 1.08, recoil: 0,
  },
];

export function weaponDef(id: string): WeaponDef | undefined {
  return WEAPONS.find((w) => w.id === id);
}

export const PRIMARY_WEAPONS: string[] = WEAPONS.filter((w) => w.slot === 'primary').map((w) => w.id);
export const SECONDARY_WEAPONS: string[] = WEAPONS.filter((w) => w.slot === 'secondary').map((w) => w.id);
export const DEFAULT_PRIMARY = 'rifle';
export const DEFAULT_SECONDARY = 'pistol';

/** Damage of one bullet at a distance, before the headshot multiplier. */
export function damageAt(w: WeaponDef, distance: number): number {
  if (distance <= w.range) return w.damage;
  const t = Math.min(1, (distance - w.range) / Math.max(0.001, w.falloffEnd - w.range));
  return w.damage * (1 - t * (1 - w.minDamage));
}

/** Seconds between two shots. */
export function fireInterval(w: WeaponDef): number {
  return 60 / w.rpm;
}

export const PLAYER_MAX_HEALTH = 100;
/** Health regenerates after this many seconds without damage, at this rate per second. */
export const REGEN_DELAY = 5;
export const REGEN_PER_SECOND = 25;
export const RESPAWN_SECONDS = 3;
/** Player hitbox (blocks): width, total height; the head is the top 0.4. */
export const HITBOX = { width: 0.6, height: 1.8, head: 0.4 };
