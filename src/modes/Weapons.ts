/**
 * Weapons for the arcade game types. All numbers are authoritative on the server; the client
 * only predicts the visuals (recoil, tracers, ammo counter) and takes the server's word for hits.
 * Damage is out of 100 health. The balance table (time to kill per distance) is printed by
 * `npx tsx scripts/ttk-matrix.ts` and guarded by tests/arcadeBalance.test.ts.
 */
export type WeaponSlot = 'primary' | 'secondary' | 'melee';

/** How the trigger works: hold (auto), one shot per click (semi), three per click (burst), or a bolt to work after every shot. */
export type FireMode = 'auto' | 'semi' | 'burst' | 'bolt';

/** Sights a weapon can carry (Create-a-Class). `iron` is the weapon's own sights. */
export type OpticId = 'iron' | 'reddot' | 'holo' | 'scope';

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
  /** Field of view multiplier when aiming through the iron sights (0.5 = 2× zoom). */
  zoom: number;
  /** Movement speed multiplier while holding it. */
  moveSpeed: number;
  /** Camera kick per shot in degrees (vertical). */
  recoil: number;
  /** Burst weapons fire this many shots per trigger pull, `rpm` apart; the next burst may start `burstCycleSec` after the first shot. */
  burst?: number;
  burstCycleSec?: number;
  /** Bolt action: the bolt is worked after every shot (sound and animation; the cadence is `rpm`). */
  bolt?: boolean;
  /** Seconds from hip to fully aimed (iron sights). */
  adsTime: number;
  /**
   * Recoil pattern: the aim climbs `recoil * AIM_CLIMB` degrees per shot and drifts sideways by
   * `recoilX` degrees times the pattern entry of the shot (the pattern repeats). Learnable, not random.
   */
  recoilX: number;
  pattern: readonly number[];
  /** Sights this weapon accepts, the first is the default. */
  optics: readonly OpticId[];
  /** Field of view multiplier through a scope (only for weapons that accept one). */
  scopeZoom?: number;
  /** One line about what the weapon is for (class menu). */
  role: string;
}

/** Share of the visual kick (degrees) that really moves the aim per shot. */
export const AIM_CLIMB = 0.32;

// Recoil patterns (horizontal multipliers per shot, repeating).
const PAT_RIFLE = [0.2, -0.3, 0.5, 0.4, -0.6, 0.3, 0.7, -0.2, -0.5, 0.6];
const PAT_SMG = [0.5, -0.6, 0.7, -0.4, 0.3, -0.8, 0.6, -0.3];
const PAT_LMG = [0.6, 0.8, 0.5, 0.3, -0.2, -0.6, -0.8, -0.4, 0.2, 0.7, 0.9, 0.4];
const PAT_RIGHT = [0.4, 0.6, 0.3, 0.5];
const PAT_LEFT = [-0.3, -0.5, 0.2, -0.4];
const PAT_NONE = [0];

export const WEAPONS: WeaponDef[] = [
  {
    id: 'rifle', name: 'Assault Rifle', slot: 'primary', auto: true, damage: 20, headshot: 2, pellets: 1, rpm: 600,
    magazine: 30, reloadSec: 1.3, spread: 2.2, adsSpread: 0.4, range: 32, falloffEnd: 80, minDamage: 0.55, maxRange: 150,
    zoom: 0.8, moveSpeed: 1, recoil: 0.9, adsTime: 0.24, recoilX: 0.18, pattern: PAT_RIFLE, optics: ['iron', 'reddot', 'holo'],
    role: 'All-rounder: wins mid range, holds its own close and far',
  },
  {
    id: 'smg', name: 'SMG', slot: 'primary', auto: true, damage: 15, headshot: 1.8, pellets: 1, rpm: 900,
    magazine: 25, reloadSec: 1.1, spread: 2.6, adsSpread: 1.2, range: 16, falloffEnd: 50, minDamage: 0.5, maxRange: 100,
    zoom: 0.85, moveSpeed: 1.08, recoil: 0.6, adsTime: 0.17, recoilX: 0.24, pattern: PAT_SMG, optics: ['iron', 'reddot', 'holo'],
    role: 'Fastest on its feet; shreds up close, fades past 20 blocks',
  },
  {
    id: 'shotgun', name: 'Shotgun', slot: 'primary', auto: false, damage: 18, headshot: 1.5, pellets: 8, rpm: 80,
    magazine: 6, reloadSec: 1.9, spread: 3.2, adsSpread: 2.6, range: 9, falloffEnd: 24, minDamage: 0.2, maxRange: 40,
    zoom: 0.9, moveSpeed: 0.97, recoil: 4.5, adsTime: 0.2, recoilX: 0.3, pattern: PAT_RIGHT, optics: ['iron', 'reddot'],
    role: 'One pump kills out to 8 blocks; useless past 15',
  },
  {
    id: 'lmg', name: 'LMG', slot: 'primary', auto: true, damage: 19, headshot: 1.7, pellets: 1, rpm: 720,
    magazine: 75, reloadSec: 3.4, spread: 3.2, adsSpread: 0.55, range: 38, falloffEnd: 95, minDamage: 0.62, maxRange: 150,
    zoom: 0.78, moveSpeed: 0.88, recoil: 0.8, adsTime: 0.42, recoilX: 0.22, pattern: PAT_LMG, optics: ['iron', 'reddot', 'holo'],
    role: 'Huge magazine: holds a lane and wins multi-kills, slow to aim and to reload',
  },
  {
    id: 'burst', name: 'Burst Rifle', slot: 'primary', auto: false, damage: 22, headshot: 1.6, pellets: 1, rpm: 900,
    magazine: 30, reloadSec: 1.35, spread: 2, adsSpread: 0.25, range: 45, falloffEnd: 85, minDamage: 0.55, maxRange: 160,
    zoom: 0.8, moveSpeed: 1, recoil: 1.2, burst: 3, burstCycleSec: 0.34, adsTime: 0.25, recoilX: 0.12, pattern: PAT_LEFT,
    optics: ['iron', 'reddot', 'holo'], role: 'Tight three-round bursts: rewards accuracy at mid range',
  },
  {
    id: 'dmr', name: 'DMR', slot: 'primary', auto: false, damage: 34, headshot: 2, pellets: 1, rpm: 270,
    magazine: 12, reloadSec: 1.6, spread: 3.5, adsSpread: 0.1, range: 60, falloffEnd: 140, minDamage: 0.7, maxRange: 250,
    zoom: 0.7, moveSpeed: 0.96, recoil: 1.6, adsTime: 0.28, recoilX: 0.1, pattern: PAT_RIGHT, optics: ['iron', 'reddot', 'holo', 'scope'],
    scopeZoom: 0.45, role: 'Three-shot marksman rifle; take the scope for long lanes',
  },
  {
    id: 'semisniper', name: 'Semi-Auto Sniper', slot: 'primary', auto: false, damage: 55, headshot: 1.7, pellets: 1, rpm: 125,
    magazine: 6, reloadSec: 1.9, spread: 7, adsSpread: 0.05, range: 70, falloffEnd: 160, minDamage: 0.8, maxRange: 300,
    zoom: 0.33, moveSpeed: 0.93, recoil: 2.6, adsTime: 0.36, recoilX: 0.15, pattern: PAT_LEFT, optics: ['scope'], scopeZoom: 0.33,
    role: 'Two quick body shots at any range; no one-shot headshot',
  },
  {
    id: 'sniper', name: 'Bolt-Action Sniper', slot: 'primary', auto: false, damage: 100, headshot: 1.5, pellets: 1, rpm: 45,
    magazine: 4, reloadSec: 2.1, spread: 9, adsSpread: 0, range: 70, falloffEnd: 160, minDamage: 0.85, maxRange: 400,
    zoom: 0.25, moveSpeed: 0.92, recoil: 3, bolt: true, adsTime: 0.3, recoilX: 0.2, pattern: PAT_RIGHT, optics: ['scope'], scopeZoom: 0.22,
    role: 'One body shot kills out to 70 blocks: quickscope it; slow bolt, no hip fire',
  },
  {
    id: 'pistol', name: 'Pistol', slot: 'secondary', auto: false, damage: 18, headshot: 2, pellets: 1, rpm: 400,
    magazine: 12, reloadSec: 0.95, spread: 1.8, adsSpread: 0.5, range: 25, falloffEnd: 60, minDamage: 0.5, maxRange: 100,
    zoom: 0.9, moveSpeed: 1.04, recoil: 1.1, adsTime: 0.15, recoilX: 0.1, pattern: PAT_RIGHT, optics: ['iron'],
    role: 'Fast, accurate backup',
  },
  {
    id: 'mpistol', name: 'Machine Pistol', slot: 'secondary', auto: true, damage: 12, headshot: 1.6, pellets: 1, rpm: 1000,
    magazine: 20, reloadSec: 1.2, spread: 3.2, adsSpread: 1.5, range: 9, falloffEnd: 30, minDamage: 0.45, maxRange: 70,
    zoom: 0.92, moveSpeed: 1.05, recoil: 0.5, adsTime: 0.14, recoilX: 0.3, pattern: PAT_SMG, optics: ['iron'],
    role: 'Full-auto panic button for close quarters',
  },
  {
    id: 'revolver', name: 'Revolver', slot: 'secondary', auto: false, damage: 52, headshot: 2, pellets: 1, rpm: 150,
    magazine: 6, reloadSec: 1.8, spread: 2.5, adsSpread: 0.15, range: 30, falloffEnd: 70, minDamage: 0.6, maxRange: 120,
    zoom: 0.85, moveSpeed: 1, recoil: 4.5, adsTime: 0.2, recoilX: 0.25, pattern: PAT_RIGHT, optics: ['iron'],
    role: 'Two hits to kill, slow to reload',
  },
  {
    id: 'knife', name: 'Knife', slot: 'melee', auto: false, damage: 55, headshot: 1, pellets: 1, rpm: 120,
    magazine: 0, reloadSec: 0, spread: 0, adsSpread: 0, range: 2.6, falloffEnd: 2.6, minDamage: 1, maxRange: 2.6,
    zoom: 1, moveSpeed: 1.08, recoil: 0, adsTime: 0.2, recoilX: 0, pattern: PAT_NONE, optics: ['iron'],
    role: 'Two stabs',
  },
];

const BY_ID = new Map(WEAPONS.map((w) => [w.id, w]));

export function weaponDef(id: string): WeaponDef | undefined {
  return BY_ID.get(id);
}

export function fireMode(w: WeaponDef): FireMode {
  return w.bolt ? 'bolt' : w.burst ? 'burst' : w.auto ? 'auto' : 'semi';
}

export const PRIMARY_WEAPONS: string[] = WEAPONS.filter((w) => w.slot === 'primary').map((w) => w.id);
export const SECONDARY_WEAPONS: string[] = WEAPONS.filter((w) => w.slot === 'secondary').map((w) => w.id);
export const DEFAULT_PRIMARY = 'rifle';
export const DEFAULT_SECONDARY = 'pistol';

/** Damage of one bullet at a distance, before the headshot multiplier. `rangeMul` scales the falloff distances (suppressor). */
export function damageAt(w: WeaponDef, distance: number, rangeMul = 1): number {
  const range = w.range * rangeMul, end = w.falloffEnd * rangeMul;
  if (distance <= range) return w.damage;
  const t = Math.min(1, (distance - range) / Math.max(0.001, end - range));
  return w.damage * (1 - t * (1 - w.minDamage));
}

/**
 * A tactical reload (rounds left in the magazine) takes this share of the empty reload: the old magazine comes out
 * with a round still chambered, so there is no bolt or slide to work.
 */
export const TACTICAL_RELOAD = 0.75;

/** Seconds a reload takes, starting with `mag` rounds in the magazine: `reloadSec` when empty, faster when not. Server and client use it. */
export function reloadTimeFor(w: WeaponDef, mag: number): number {
  return mag > 0 ? w.reloadSec * TACTICAL_RELOAD : w.reloadSec;
}

/** Seconds between two shots. */
export function fireInterval(w: WeaponDef): number {
  return 60 / w.rpm;
}

// ---------------------------------------------------------------- optics and perks

export interface OpticDef {
  id: OpticId;
  name: string;
  desc: string;
}

export const OPTICS: Record<OpticId, OpticDef> = {
  iron: { id: 'iron', name: 'Iron Sights', desc: 'The weapon\'s own sights' },
  reddot: { id: 'reddot', name: 'Red Dot', desc: 'Clean dot, slightly more zoom' },
  holo: { id: 'holo', name: 'Holographic', desc: 'Ring reticle, a bit more zoom' },
  scope: { id: 'scope', name: 'Scope', desc: 'Magnified, hold Shift to steady; slower to aim' },
};

/** Whether a weapon accepts an optic. */
export function opticAllowed(w: WeaponDef, optic: string): optic is OpticId {
  return (w.optics as readonly string[]).includes(optic);
}

/** The optic a weapon really gets for a requested one: the request when allowed, else its default. */
export function opticFor(w: WeaponDef, optic: string | undefined): OpticId {
  return optic !== undefined && opticAllowed(w, optic) ? optic : w.optics[0];
}

/** Field of view multiplier when fully aimed with an optic (per weapon). */
export function opticZoom(w: WeaponDef, optic: OpticId): number {
  if (optic === 'scope') return w.scopeZoom ?? w.zoom;
  if (optic === 'holo') return w.zoom * 0.9;
  if (optic === 'reddot') return w.zoom * 0.95;
  return w.zoom;
}

export type PerkId = 'none' | 'extmag' | 'quickdraw' | 'ninja' | 'suppressor';

export interface PerkDef {
  id: PerkId;
  name: string;
  desc: string;
}

export const PERKS: Record<PerkId, PerkDef> = {
  none: { id: 'none', name: 'No Perk', desc: 'Nothing extra' },
  extmag: { id: 'extmag', name: 'Extended Mags', desc: '+40% magazine on both guns' },
  quickdraw: { id: 'quickdraw', name: 'Quickdraw', desc: 'Aim 40% faster, switch weapons twice as fast' },
  ninja: { id: 'ninja', name: 'Ninja', desc: 'Enemies hear your footsteps only up close' },
  suppressor: { id: 'suppressor', name: 'Suppressor', desc: 'Quiet shots heard only nearby; 20% shorter damage range' },
};
export const PERK_IDS = Object.keys(PERKS) as PerkId[];

export function isPerk(v: unknown): v is PerkId {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(PERKS, v);
}

/** Magazine size with a perk (Extended Mags adds 40% to guns). */
export function magazineFor(w: WeaponDef, perk: PerkId): number {
  return perk === 'extmag' && w.magazine > 0 ? Math.round(w.magazine * 1.4) : w.magazine;
}

/** Falloff distance multiplier with a perk (the suppressor shortens it); melee is never affected. */
export function rangeMulFor(w: WeaponDef, perk: PerkId): number {
  return perk === 'suppressor' && w.slot !== 'melee' ? 0.8 : 1;
}

/** Seconds to aim with an optic and a perk. */
export function adsTimeFor(w: WeaponDef, optic: OpticId, perk: PerkId): number {
  return (w.adsTime + (optic === 'scope' && w.slot === 'primary' && w.optics[0] !== 'scope' ? 0.08 : 0)) * (perk === 'quickdraw' ? 0.6 : 1);
}

/** Seconds a weapon switch takes (server cadence and client animation). */
export function switchDelayFor(perk: PerkId, base: number): number {
  return perk === 'quickdraw' ? base * 0.5 : base;
}

export const PLAYER_MAX_HEALTH = 100;
/** Health regenerates after this many seconds without damage, at this rate per second. */
export const REGEN_DELAY = 5;
export const REGEN_PER_SECOND = 25;
export const RESPAWN_SECONDS = 3;
/** Player hitbox (blocks): width, total height; the head is the top 0.4. */
export const HITBOX = { width: 0.6, height: 1.8, head: 0.4 };
