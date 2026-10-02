import { BLOCK } from '../world/BlockRegistry';
import { type AABB, type BlockGetter, boxIntersectsSolid, clipAxis } from './Collision';
import { PHYSICS, approach } from './Physics';

/** Ledges up to this high are walked up without jumping (Minecraft's step height). */
const STEP_HEIGHT = 0.6;

export interface MoveInput {
  forward: number; // -1..1
  strafe: number; // -1..1 (right positive)
  jump: boolean;
  jumpPressed: boolean;
  sprint: boolean;
  descend: boolean;
}

/**
 * First-person player: an AABB (0.6 × 1.8 × 0.6) moved with a fixed 60 Hz step.
 * Rendering interpolates between the previous and current step for smooth motion
 * on any refresh rate.
 */
export class Player {
  x = 0; y = 80; z = 0;
  prevX = 0; prevY = 80; prevZ = 0;
  vx = 0; vy = 0; vz = 0;
  yaw = 0;
  pitch = 0;
  onGround = false;
  inWater = false;
  headInWater = false;
  flying = false;
  sprinting = false;
  horizontalCollision = false;
  /** Distance walked on the ground, drives head bob and footsteps. */
  walkDistance = 0;
  /** Downward speed at the moment of the last landing (for landing sounds/bob). */
  landingImpact = 0;
  inLava = false;
  /** Blocks fallen since last on the ground (fall damage = distance − 3). */
  fallDistance = 0;
  /** Fall distance of the most recent landing, consumed by the game (fall damage). */
  landedFall = 0;
  /** Mode rules, set by the game. */
  canFly = true;
  canSprint = true;
  /** Arcade: scales walking and sprinting speed on the ground and in the air (1 = Minecraft). */
  speedMultiplier = 1;
  /** Horizontal acceleration in the air (arcade raises it for bunny hopping). */
  airAccel: number = PHYSICS.AIR_ACCEL;
  /** Spectator: fly through blocks. */
  noclip = false;
  /** Distance travelled while sprinting / swimming and jumps since last read (hunger). */
  sprintDistance = 0;
  swimDistance = 0;
  jumps = 0;

  private time = 0;
  private lastJumpPress = -1;
  private readonly box: AABB = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };

  setPosition(x: number, y: number, z: number): void {
    this.x = this.prevX = x;
    this.y = this.prevY = y;
    this.z = this.prevZ = z;
    this.vx = this.vy = this.vz = 0;
  }

  get eyeY(): number {
    return this.y + PHYSICS.EYE_HEIGHT;
  }

  private updateBox(): AABB {
    const b = this.box, hw = PHYSICS.WIDTH / 2;
    b.minX = this.x - hw; b.maxX = this.x + hw;
    b.minY = this.y; b.maxY = this.y + PHYSICS.HEIGHT;
    b.minZ = this.z - hw; b.maxZ = this.z + hw;
    return b;
  }

  /** Would a block at (x,y,z) intersect the player? Used before placing blocks. */
  intersectsBlock(x: number, y: number, z: number): boolean {
    const b = this.updateBox();
    return b.maxX > x && b.minX < x + 1 && b.maxY > y && b.minY < y + 1 && b.maxZ > z && b.minZ < z + 1;
  }

  /** @param getMeta block states, so slabs, stairs and doors collide with their real shape (full blocks without). */
  step(input: MoveInput, getBlock: BlockGetter, getMeta?: BlockGetter): void {
    const dt = PHYSICS.STEP;
    this.time += dt;
    this.prevX = this.x; this.prevY = this.y; this.prevZ = this.z;

    this.inWater = getBlock(Math.floor(this.x), Math.floor(this.y + 0.4), Math.floor(this.z)) === BLOCK.WATER;
    this.headInWater = getBlock(Math.floor(this.x), Math.floor(this.eyeY), Math.floor(this.z)) === BLOCK.WATER;
    this.inLava = getBlock(Math.floor(this.x), Math.floor(this.y + 0.4), Math.floor(this.z)) === BLOCK.LAVA;
    if (this.inLava) this.inWater = true; // lava swims like (slow) water
    if (this.noclip) this.flying = true;
    else if (!this.canFly) this.flying = false;

    // Double-tap jump toggles flight (creative style).
    if (input.jumpPressed && this.canFly && !this.noclip) {
      if (this.time - this.lastJumpPress < 0.3) {
        this.flying = !this.flying;
        this.lastJumpPress = -1;
        if (this.flying) this.vy = 0;
      } else {
        this.lastJumpPress = this.time;
      }
    }

    // Desired horizontal velocity in world space.
    let f = input.forward, s = input.strafe;
    const len = Math.hypot(f, s);
    if (len > 1) { f /= len; s /= len; }
    this.sprinting = input.sprint && f > 0 && !this.inWater && this.canSprint;
    let speed: number;
    if (this.flying) speed = this.sprinting ? PHYSICS.FLY_SPRINT_SPEED : PHYSICS.FLY_SPEED;
    else if (this.inWater) speed = this.inLava ? PHYSICS.SWIM_SPEED * 0.5 : PHYSICS.SWIM_SPEED;
    else speed = (this.sprinting ? PHYSICS.SPRINT_SPEED : PHYSICS.WALK_SPEED) * this.speedMultiplier;
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    const tx = (-sin * f + cos * s) * speed;
    const tz = (-cos * f - sin * s) * speed;
    const accel = this.flying ? PHYSICS.FLY_ACCEL : this.inWater ? 10 : this.onGround ? PHYSICS.GROUND_ACCEL : this.airAccel;
    this.vx = approach(this.vx, tx, accel, dt);
    this.vz = approach(this.vz, tz, accel, dt);

    // Vertical.
    if (this.flying) {
      const target = ((input.jump ? 1 : 0) - (input.descend ? 1 : 0)) * PHYSICS.FLY_VERTICAL;
      this.vy = approach(this.vy, target, 10, dt);
    } else if (this.inWater) {
      this.vy -= PHYSICS.WATER_GRAVITY * dt;
      if (input.jump) this.vy = approach(this.vy, PHYSICS.SWIM_UP, 8, dt);
      if (this.vy < -PHYSICS.WATER_SINK) this.vy = approach(this.vy, -PHYSICS.WATER_SINK, 10, dt);
      // Climb out onto the shore.
      if (input.jump && this.horizontalCollision) this.vy = Math.max(this.vy, 5.5);
    } else {
      if (input.jump && this.onGround) {
        this.vy = PHYSICS.JUMP_VELOCITY;
        this.jumps++;
      }
      this.vy = Math.max(this.vy - PHYSICS.GRAVITY * dt, -PHYSICS.TERMINAL_VELOCITY);
    }

    if (this.noclip) {
      this.x += this.vx * dt;
      this.y += this.vy * dt;
      this.z += this.vz * dt;
      this.onGround = false;
      this.fallDistance = 0;
      return;
    }

    // Collide per axis: Y first, then X and Z.
    const box = this.updateBox();
    const wantY = this.vy * dt;
    const dy = clipAxis(box, 1, wantY, getBlock, getMeta);
    this.y += dy;
    const wasOnGround = this.onGround;
    this.onGround = wantY < 0 && dy > wantY + 1e-6;
    if (dy !== wantY) {
      if (this.onGround && !wasOnGround) this.landingImpact = -this.vy;
      this.vy = 0;
    }

    this.updateBox();
    const startX = this.x, startZ = this.z;
    const wantX = this.vx * dt;
    let dx = clipAxis(this.box, 0, wantX, getBlock, getMeta);
    this.x += dx;
    this.updateBox();
    const wantZ = this.vz * dt;
    let dz = clipAxis(this.box, 2, wantZ, getBlock, getMeta);
    this.z += dz;
    this.horizontalCollision = dx !== wantX || dz !== wantZ;
    if (this.horizontalCollision && (wasOnGround || this.onGround) && !this.inWater && !this.flying
      && this.stepUp(startX, startZ, wantX, wantZ, dx, dz, getBlock, getMeta)) {
      // Climbed a slab or stair: the distance covered is the stepped one.
      dx = this.x - startX;
      dz = this.z - startZ;
      this.horizontalCollision = false;
      this.onGround = true;
    }
    if (dx !== wantX) this.vx = 0;
    if (dz !== wantZ) this.vz = 0;

    if (this.flying && this.onGround) this.flying = false;
    if (this.onGround) this.walkDistance += Math.hypot(dx, dz);
    const moved = Math.hypot(dx, dz);
    if (this.sprinting) this.sprintDistance += moved;
    if (this.inWater) this.swimDistance += moved;

    // Fall distance (reset in liquids and while flying), reported on landing.
    if (this.inWater || this.flying) this.fallDistance = 0;
    else if (dy < 0) this.fallDistance -= dy;
    if (this.onGround) {
      if (this.fallDistance > 0) this.landedFall = this.fallDistance;
      this.fallDistance = 0;
    }
  }

  /**
   * Minecraft's step height: when walking into a ledge of at most 0.6 blocks (slab, stair), tries the same
   * move from 0.6 higher and drops back down. Keeps the result when it gets further than the flat move.
   */
  private stepUp(
    startX: number, startZ: number, wantX: number, wantZ: number, dx: number, dz: number, getBlock: BlockGetter, getMeta?: BlockGetter,
  ): boolean {
    const hw = PHYSICS.WIDTH / 2;
    const b = this.box;
    b.minX = startX - hw; b.maxX = startX + hw;
    b.minZ = startZ - hw; b.maxZ = startZ + hw;
    b.minY = this.y; b.maxY = this.y + PHYSICS.HEIGHT;
    const up = clipAxis(b, 1, STEP_HEIGHT, getBlock, getMeta);
    if (up <= 0) { this.updateBox(); return false; }
    b.minY += up; b.maxY += up;
    const sdx = clipAxis(b, 0, wantX, getBlock, getMeta);
    b.minX += sdx; b.maxX += sdx;
    const sdz = clipAxis(b, 2, wantZ, getBlock, getMeta);
    b.minZ += sdz; b.maxZ += sdz;
    const down = clipAxis(b, 1, -up, getBlock, getMeta);
    // Only a step if we land on something and got further than before.
    if (down <= -up + 1e-6 || sdx * sdx + sdz * sdz <= dx * dx + dz * dz + 1e-9) { this.updateBox(); return false; }
    this.x = startX + sdx;
    this.z = startZ + sdz;
    this.y += up + down;
    this.updateBox();
    return true;
  }

  /** Pushes the player up if they end up inside a block (e.g. spawn in a tree). */
  unstick(getBlock: BlockGetter, getMeta?: BlockGetter): void {
    for (let i = 0; i < 64 && boxIntersectsSolid(this.updateBox(), getBlock, getMeta); i++) this.y += 1;
    this.prevY = this.y;
  }
}
