import { BLOCK } from '../world/BlockRegistry';
import { type AABB, type BlockGetter, clipAxis } from '../player/Collision';

export const ENTITY_TICK = 1 / 20;
const GRAVITY = 32;

/**
 * Base entity with Minecraft-style physics at 20 ticks/s: AABB collision against
 * blocks (shared with the player), gravity, water buoyancy and 1-block auto-jump.
 */
export abstract class Entity {
  x = 0; y = 0; z = 0;
  prevX = 0; prevY = 0; prevZ = 0;
  vx = 0; vy = 0; vz = 0;
  yaw = 0;
  prevYaw = 0;
  onGround = false;
  horizontalCollision = false;
  inWater = false;
  inLava = false;
  removed = false;
  fallDistance = 0;
  protected readonly box: AABB = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };

  constructor(readonly width: number, readonly height: number) {}

  setPosition(x: number, y: number, z: number): void {
    this.x = this.prevX = x;
    this.y = this.prevY = y;
    this.z = this.prevZ = z;
  }

  updateBox(): AABB {
    const b = this.box, hw = this.width / 2;
    b.minX = this.x - hw; b.maxX = this.x + hw;
    b.minY = this.y; b.maxY = this.y + this.height;
    b.minZ = this.z - hw; b.maxZ = this.z + hw;
    return b;
  }

  /** Ray–AABB slab test; returns the distance along the ray or Infinity. */
  rayHit(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, max: number): number {
    const b = this.updateBox();
    let tmin = 0, tmax = max;
    const axes: [number, number, number, number][] = [[ox, dx, b.minX, b.maxX], [oy, dy, b.minY, b.maxY], [oz, dz, b.minZ, b.maxZ]];
    for (const [o, d, lo, hi] of axes) {
      if (Math.abs(d) < 1e-9) {
        if (o < lo || o > hi) return Infinity;
        continue;
      }
      let t1 = (lo - o) / d, t2 = (hi - o) / d;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return Infinity;
    }
    return tmin;
  }

  /** One physics tick. */
  physicsTick(getBlock: BlockGetter, wantJump: boolean): void {
    const dt = ENTITY_TICK;
    this.prevX = this.x; this.prevY = this.y; this.prevZ = this.z;
    this.prevYaw = this.yaw;
    const feet = getBlock(Math.floor(this.x), Math.floor(this.y + 0.2), Math.floor(this.z));
    this.inWater = feet === BLOCK.WATER || feet === BLOCK.LAVA;
    this.inLava = feet === BLOCK.LAVA;

    if (this.inWater) {
      // Mobs float up to the surface.
      this.vy = Math.min(this.vy + 18 * dt, 2.2);
      this.vx *= 0.8; this.vz *= 0.8;
    } else {
      this.vy = Math.max(this.vy - GRAVITY * dt, -50);
    }
    if (wantJump && this.onGround && this.horizontalCollision) this.vy = 8.6;

    const box = this.updateBox();
    const wantY = this.vy * dt;
    const dy = clipAxis(box, 1, wantY, getBlock);
    this.y += dy;
    const landed = wantY < 0 && dy > wantY + 1e-6;
    if (dy !== wantY) this.vy = 0;
    this.updateBox();
    const wantX = this.vx * dt;
    const dx = clipAxis(this.box, 0, wantX, getBlock);
    this.x += dx;
    this.updateBox();
    const wantZ = this.vz * dt;
    const dz = clipAxis(this.box, 2, wantZ, getBlock);
    this.z += dz;
    this.horizontalCollision = dx !== wantX || dz !== wantZ;

    if (this.inWater) this.fallDistance = 0;
    else if (dy < 0) this.fallDistance -= dy;
    this.onGround = landed;
    if (landed) {
      this.onLand(this.fallDistance);
      this.fallDistance = 0;
    }
    if (this.onGround) {
      // Ground friction.
      this.vx *= 0.6;
      this.vz *= 0.6;
    }
  }

  protected onLand(_fallDistance: number): void {
    void _fallDistance;
  }
}
