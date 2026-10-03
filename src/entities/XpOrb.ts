import { orbTier } from '../player/Experience';
import { Entity } from './Entity';

/** Orbs are pulled towards a player this close (blocks), and picked up this close. */
export const ORB_MAGNET_RANGE = 8;
export const ORB_PICKUP_RANGE = 1.0;
/** Orbs vanish after 5 minutes (ticks). */
export const ORB_LIFETIME = 6000;
/** Orbs closer than this merge into one (blocks). */
export const ORB_MERGE_RANGE = 0.75;

/** Target the orbs fly to: the player, or the nearest player on a server. */
export interface OrbTarget {
  x: number;
  y: number;
  z: number;
}

/**
 * An experience orb: falls like an item, is pulled towards a player within 8 blocks (faster when closer), merges with orbs
 * that lie close together and disappears after 5 minutes. The `value` decides its size (see `orbTier`).
 */
export class XpOrb extends Entity {
  age = 0;
  /** Set while it is being pulled (rendering shows nothing different; kept for tests). */
  magnetised = false;

  constructor(public value: number) {
    super(0.5, 0.5);
  }

  get tier(): number {
    return orbTier(this.value);
  }

  /** Does this orb get pulled to a target at (x, y, z)? */
  static inRange(orb: OrbTarget, tx: number, ty: number, tz: number): boolean {
    return Math.hypot(tx - orb.x, ty - orb.y, tz - orb.z) < ORB_MAGNET_RANGE;
  }

  /**
   * One tick. `target` is the player's body (x, feet y, z) or null when nobody can collect it. Like Minecraft's
   * ExperienceOrb: acceleration (1 - distance/8)² towards the player's chest, a little drag.
   */
  tick(getBlock: (x: number, y: number, z: number) => number, target: OrbTarget | null): void {
    this.age++;
    if (this.age > ORB_LIFETIME) this.removed = true;
    this.magnetised = false;
    if (target) {
      const dx = target.x - this.x, dy = target.y + 0.8 - this.y, dz = target.z - this.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist < ORB_MAGNET_RANGE) {
        const pull = (1 - dist / ORB_MAGNET_RANGE) ** 2 * 2.4;
        this.vx += (dx / (dist || 1)) * pull;
        this.vy += (dy / (dist || 1)) * pull + 1.7;
        this.vz += (dz / (dist || 1)) * pull;
        // Drag and a speed limit (12 blocks/s = 0.6 per tick): fast orbs would jump over the pickup range.
        const keep = Math.min(0.93, 12 / (Math.hypot(this.vx, this.vy, this.vz) || 1));
        this.vx *= keep; this.vy *= keep; this.vz *= keep;
        this.magnetised = true;
      }
    }
    this.physicsTick(getBlock, false);
  }

  /** Is a player at (x, y, z) close enough to take it? */
  canPickUp(x: number, y: number, z: number): boolean {
    return Math.hypot(x - this.x, y + 0.8 - this.y, z - this.z) < ORB_PICKUP_RANGE + 0.3;
  }
}

/** Merges orbs that lie within ORB_MERGE_RANGE: the first keeps the sum of the values and the younger age. Returns how many were merged away. */
export function mergeOrbs(orbs: XpOrb[]): number {
  let merged = 0;
  for (let i = 0; i < orbs.length; i++) {
    const a = orbs[i];
    if (a.removed || a.remote) continue;
    for (let j = i + 1; j < orbs.length; j++) {
      const b = orbs[j];
      if (b.removed || b.remote) continue;
      if (Math.abs(a.x - b.x) < ORB_MERGE_RANGE && Math.abs(a.y - b.y) < ORB_MERGE_RANGE && Math.abs(a.z - b.z) < ORB_MERGE_RANGE) {
        a.value += b.value;
        a.age = Math.min(a.age, b.age);
        b.removed = true;
        merged++;
      }
    }
  }
  return merged;
}

/** Anything that can spawn orbs (the EntityManager of a world or of the server). */
export interface XpSink {
  spawnXp(x: number, y: number, z: number, amount: number): void;
}

/**
 * Hook for other systems (furnace output, breeding, fishing): drops `amount` experience as orbs at a position. Round
 * fractional amounts first with `wholeXp` (player/Experience); `SMELT_XP` there has the smelting values.
 */
export function awardXp(entities: XpSink | null | undefined, x: number, y: number, z: number, amount: number): void {
  if (entities && amount > 0) entities.spawnXp(x, y, z, Math.floor(amount));
}
