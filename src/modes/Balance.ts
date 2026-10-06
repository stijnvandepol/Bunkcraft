import { PLAYER_MAX_HEALTH, type WeaponDef, damageAt, fireInterval } from './Weapons';

/**
 * Time-to-kill model for the arcade weapons (design aid and balance tests; the game does not use it).
 *
 *   perfect TTK   = time from the first to the last shot needed when every shot lands: (STK - 1) × interval
 *   spread hit %  = chance that a bullet aimed at the centre falls inside the body: min(1, (θ / spread)²),
 *                   θ = atan(body radius / distance); bullets are uniform over the cone's disc (Combat.spreadDirection)
 *   realistic TTK = aim-down-sights time (beyond hip range) + time for the expected shots:
 *                   expected damage per shot = dmg × pellets × falloff × spread hit % × aim; STK = ceil(100 / that);
 *                   reloads are added when STK exceeds the magazine
 */
export const BODY_RADIUS = 0.55; // blocks: a circle with the area of the 0.6 × 1.8 hitbox seen from the front
/** Up to this distance fights are hip fire; beyond it the shooter aims first. */
export const HIP_RANGE = 7;
/** Default aim factor: share of shots whose centre is on the body. */
export const DEFAULT_AIM = 0.75;
/** Distances (blocks) the balance is judged at: point blank, close, mid, long, very long. */
export const BALANCE_RANGES = [4, 10, 20, 35, 60, 90] as const;

export interface Ttk { stk: number; ms: number }

/** Time of shot number n (1-based), first shot at 0. */
export function shotTime(w: WeaponDef, n: number): number {
  if (!w.burst || !w.burstCycleSec) return (n - 1) * fireInterval(w);
  const k = n - 1;
  return Math.floor(k / w.burst) * w.burstCycleSec + (k % w.burst) * fireInterval(w);
}

export function spreadHit(w: WeaponDef, dist: number, ads: boolean): number {
  const s = ads ? w.adsSpread : w.spread;
  if (s <= 0 || w.range < 5) return 1;
  const theta = (Math.atan(BODY_RADIUS / Math.max(1, dist)) * 180) / Math.PI;
  return Math.min(1, (theta / s) ** 2);
}

/** Shots to kill and ms for a damage per shot (pellets and falloff included). */
export function ttkFor(w: WeaponDef, perShot: number, magazine = w.magazine): Ttk {
  if (perShot <= 0) return { stk: Infinity, ms: Infinity };
  const stk = Math.ceil(PLAYER_MAX_HEALTH / perShot - 1e-9);
  let ms = shotTime(w, stk) * 1000;
  if (magazine > 0 && stk > magazine) ms += Math.floor((stk - 1) / magazine) * w.reloadSec * 1000;
  return { stk, ms: Math.round(ms) };
}

export function perfectTtk(w: WeaponDef, dist: number, head = false): Ttk {
  if (dist > w.maxRange) return { stk: Infinity, ms: Infinity };
  return ttkFor(w, damageAt(w, dist) * w.pellets * (head ? w.headshot : 1));
}

/** Time of the n-th shot for a fractional (expected) shot count: interpolated between whole shots. */
function shotTimeFrac(w: WeaponDef, n: number): number {
  const lo = Math.floor(n), f = n - lo;
  return f === 0 ? shotTime(w, lo) : shotTime(w, lo) + (shotTime(w, lo + 1) - shotTime(w, lo)) * f;
}

/**
 * Realistic body-only TTK at a distance, aiming time included beyond hip range. Every shot lands with
 * probability `aim` (× the spread hit chance for single bullets; a shotgun blast lands its share of
 * pellets); the time is that of the expected number of shots (fractional), reloads included.
 */
export function realisticTtk(w: WeaponDef, dist: number, aim = DEFAULT_AIM): Ttk {
  if (dist > w.maxRange) return { stk: Infinity, ms: Infinity };
  const ads = dist > HIP_RANGE;
  const hit = spreadHit(w, dist, ads);
  const perHit = damageAt(w, dist) * (w.pellets > 1 ? w.pellets * hit : 1);
  const p = w.pellets > 1 ? aim : aim * hit;
  if (perHit <= 0 || p <= 0) return { stk: Infinity, ms: Infinity };
  const hits = Math.ceil(PLAYER_MAX_HEALTH / perHit - 1e-9);
  const shots = hits / p;
  let ms = shotTimeFrac(w, shots) * 1000;
  if (w.magazine > 0 && shots > w.magazine) ms += Math.floor((Math.ceil(shots) - 1) / w.magazine) * w.reloadSec * 1000;
  if (ads) ms += w.adsTime * 1000;
  return { stk: Math.ceil(shots), ms: Math.round(ms) };
}

/** Kills one magazine is worth at a distance (realistic shots to kill): the sustain of a weapon. */
export function killsPerMag(w: WeaponDef, dist: number, aim = DEFAULT_AIM): number {
  const t = realisticTtk(w, dist, aim);
  return Number.isFinite(t.stk) ? w.magazine / t.stk : 0;
}
