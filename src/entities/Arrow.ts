import { BLOCK, SOLID } from '../world/BlockRegistry';
import { type RayHit, createRayHit, raycast } from '../world/Raycast';
import type { Mob } from './Mob';

const GRAVITY = 0.05; // blocks/tick²
const DRAG = 0.99;
const WATER_DRAG = 0.6;
/** Stuck arrows despawn after a minute, like Minecraft. */
const STUCK_LIFETIME = 1200;
const PLAYER_HALF_WIDTH = 0.3;
const PLAYER_HEIGHT = 1.8;

const hit: RayHit = createRayHit();

export interface ArrowTarget {
  x: number;
  y: number;
  z: number;
  /** The player can be hit (survival, alive). */
  attackable: boolean;
}

/**
 * An arrow (Minecraft's AbstractArrow): ray-marched each tick so fast arrows never
 * tunnel, gravity 0.05 and drag 0.99 per tick, damage = ceil(speed × 2) plus a random
 * bonus for critical (fully drawn) shots. Sticks in blocks; player arrows can be picked up.
 */
export class Arrow {
  x = 0; y = 0; z = 0;
  prevX = 0; prevY = 0; prevZ = 0;
  /** Velocity in blocks per tick. */
  vx = 0; vy = 0; vz = 0;
  yaw = 0;
  pitch = 0;
  inGround = false;
  removed = false;
  age = 0;
  private stuckTicks = 0;
  private stuckX = 0; private stuckY = 0; private stuckZ = 0;

  constructor(
    readonly shooter: Mob | null,
    /** Shot by the player (counts as a player kill; may be picked up). */
    readonly fromPlayer: boolean,
    readonly crit: boolean,
    /** Can be picked up once stuck (survival player arrows). */
    readonly pickup: boolean,
  ) {}

  setPosition(x: number, y: number, z: number): void {
    this.x = this.prevX = x;
    this.y = this.prevY = y;
    this.z = this.prevZ = z;
  }

  private updateRotation(): void {
    const h = Math.hypot(this.vx, this.vz);
    this.yaw = Math.atan2(this.vx, this.vz);
    this.pitch = Math.atan2(this.vy, h);
  }

  /**
   * One tick. Calls `onHitMob` / `onHitPlayer` with the damage when it strikes something,
   * `onLand` when it sticks in a block.
   */
  tick(
    getBlock: (x: number, y: number, z: number) => number,
    mobs: readonly Mob[],
    target: ArrowTarget,
    onHitMob: (arrow: Arrow, mob: Mob, damage: number) => void,
    onHitPlayer: (arrow: Arrow, damage: number) => void,
    onLand: (arrow: Arrow) => void,
  ): void {
    this.age++;
    this.prevX = this.x; this.prevY = this.y; this.prevZ = this.z;
    if (this.inGround) {
      // Falls again when its block is broken.
      if (!SOLID[getBlock(this.stuckX, this.stuckY, this.stuckZ)]) {
        this.inGround = false;
        this.stuckTicks = 0;
      } else {
        if (++this.stuckTicks >= STUCK_LIFETIME) this.removed = true;
        return;
      }
    }

    // Frozen in unloaded chunks (like Minecraft), gone below the world.
    if (getBlock(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z)) === BLOCK.UNLOADED) return;
    if (this.y < -64) {
      this.removed = true;
      return;
    }
    const speed = Math.hypot(this.vx, this.vy, this.vz);
    if (speed < 1e-6) {
      this.vy -= GRAVITY;
      return;
    }
    const dx = this.vx / speed, dy = this.vy / speed, dz = this.vz / speed;
    raycast(getBlock, this.x, this.y, this.z, dx, dy, dz, speed, hit);
    // Water and other non-solid blocks don't stop arrows.
    const blockDist = hit.hit && SOLID[hit.id] && hit.id !== BLOCK.UNLOADED ? hit.distance : Infinity;

    let best: Mob | null = null;
    let bestD = Math.min(blockDist, speed);
    for (const m of mobs) {
      if (m.dead || m.removed || (m === this.shooter && this.age < 5)) continue;
      const d = m.rayHit(this.x, this.y, this.z, dx, dy, dz, bestD);
      if (d < bestD) { bestD = d; best = m; }
    }
    let hitPlayer = false;
    if (target.attackable && !(this.fromPlayer && this.age < 5)) {
      const d = rayBox(this.x, this.y, this.z, dx, dy, dz, bestD,
        target.x - PLAYER_HALF_WIDTH, target.y, target.z - PLAYER_HALF_WIDTH,
        target.x + PLAYER_HALF_WIDTH, target.y + PLAYER_HEIGHT, target.z + PLAYER_HALF_WIDTH);
      if (d < bestD) { bestD = d; hitPlayer = true; best = null; }
    }

    if (best || hitPlayer) {
      let damage = Math.ceil(speed * 2);
      if (this.crit) damage += Math.floor(Math.random() * (damage / 2 + 2));
      if (best) onHitMob(this, best, damage);
      else onHitPlayer(this, damage);
      this.removed = true;
      return;
    }

    if (blockDist <= speed) {
      this.x += dx * (blockDist - 0.05);
      this.y += dy * (blockDist - 0.05);
      this.z += dz * (blockDist - 0.05);
      this.updateRotation();
      this.vx = this.vy = this.vz = 0;
      this.inGround = true;
      this.stuckX = hit.x; this.stuckY = hit.y; this.stuckZ = hit.z;
      onLand(this);
      return;
    }

    this.x += this.vx; this.y += this.vy; this.z += this.vz;
    this.updateRotation();
    const inWater = getBlock(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z)) === BLOCK.WATER;
    const drag = inWater ? WATER_DRAG : DRAG;
    this.vx *= drag; this.vy *= drag; this.vz *= drag;
    this.vy -= GRAVITY;
  }
}

/** Ray–AABB slab test; distance along the (unit) ray or Infinity. */
function rayBox(
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, max: number,
  minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number,
): number {
  let tmin = 0, tmax = max;
  for (let axis = 0; axis < 3; axis++) {
    const o = axis === 0 ? ox : axis === 1 ? oy : oz;
    const d = axis === 0 ? dx : axis === 1 ? dy : dz;
    const lo = axis === 0 ? minX : axis === 1 ? minY : minZ;
    const hi = axis === 0 ? maxX : axis === 1 ? maxY : maxZ;
    if (Math.abs(d) < 1e-9) {
      if (o < lo || o > hi) return Infinity;
      continue;
    }
    let t1 = (lo - o) / d, t2 = (hi - o) / d;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return Infinity;
  }
  return tmin;
}
