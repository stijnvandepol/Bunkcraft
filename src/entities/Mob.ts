import type { BlockGetter } from '../player/Collision';
import { OPAQUE, PARTIAL, SOLID } from '../world/BlockRegistry';
import { collisionBoxes } from '../world/BlockShapes';
import { Entity } from './Entity';
import type { MobType } from './MobTypes';
import type { Arrow } from './Arrow';
import type { PrimedTnt } from './PrimedTnt';

/** Ticks a skeleton waits after a shot before it draws again (Minecraft: 40 on Easy/Normal, 20 on Hard). */
export const SKELETON_SHOT_INTERVAL = 40;

/** Blocks within which a hostile mob notices its target (Minecraft's follow_range: 16, zombies 35). */
export function followRange(type: MobType): number {
  return type.followRange ?? 16;
}

export interface MobTarget {
  x: number;
  y: number;
  z: number;
  /** Whether hostile mobs may attack (survival, alive). */
  attackable: boolean;
  /** Which player this is (multiplayer server); echoed back in attack and shoot events. */
  id?: number;
  /** Experience orbs fly to this player (false for spectators). */
  collects?: boolean;
}

export interface MobEvents {
  /** Melee hit on the player. */
  attack(mob: Mob, damage: number, target: MobTarget): void;
  explode(mob: Mob): void;
  /** A ranged mob (skeleton) releases an arrow at the player. */
  shoot(mob: Mob, target: MobTarget): void;
  /** An arrow struck the player. */
  arrowHit(arrow: Arrow, damage: number, targetId: number | undefined): void;
  /** An arrow stuck in a block or hit a mob (sound). */
  arrowImpact(arrow: Arrow): void;
  /** Lit TNT whose fuse ran out. */
  tntExplode(tnt: PrimedTnt): void;
  /** A mob died after the player hurt it (advancements). */
  killed(mob: Mob): void;
  /** An arrow fired by the player hit a mob. */
  playerArrowHit(): void;
  sound(mob: Mob, kind: 'idle' | 'hurt' | 'death' | 'fuse'): void;
}

/**
 * A mob with Minecraft-style goal AI: passive mobs wander and panic when hurt,
 * zombies chase and hit, creepers chase, swell for 1.5 s and explode, skeletons keep
 * their distance and shoot, spiders climb walls, leap and are neutral in bright light.
 * Steering is greedy (head for the target, jump over 1-block steps).
 */
export class Mob extends Entity {
  health: number;
  hurtTime = 0;
  deathTime = 0;
  limbSwing = 0;
  limbAmount = 0;
  prevLimbSwing = 0;
  headYaw = 0;
  headPitch = 0;
  /** Creeper fuse 0..30 ticks. */
  fuse = 0;
  prevFuse = 0;
  burning = 0;
  /** Chunk this passive mob was spawned with (unloaded together with it). */
  homeChunk = -1;
  persistent = false;
  /** Remote arcade player with a gun in the hands (arms raised). */
  holding = false;
  /** Set each tick by the EntityManager: bright light keeps neutral-in-light mobs calm. */
  calm = false;
  /** Attacked: neutral mobs (spiders) stay hostile. */
  provoked = false;
  /** Ticks since the player last hurt this mob (player-kill drops). */
  hurtByPlayer = 0;
  /** Ticks of fire left from Fire Aspect or a Flame arrow (1 damage a second). */
  igniteTicks = 0;
  /** Looting level of the last player weapon that hit it (extra drops). */
  looting = 0;
  /** Bow draw progress in ticks (skeleton). */
  aimTicks = 0;
  private targetX = 0;
  private targetZ = 0;
  private moving = false;
  private panic = 0;
  private attackCooldown = 0;
  private idleSound = Math.random() * 200;
  age = 0;

  constructor(readonly type: MobType) {
    super(type.width, type.height);
    this.health = type.health;
    this.yaw = Math.random() * Math.PI * 2;
  }

  get dead(): boolean {
    return this.health <= 0;
  }

  /** Damage from the player, an arrow or an explosion; knockback away from (fromX, fromZ). */
  hurt(amount: number, fromX: number, fromZ: number, knockback = 1, byPlayer = false): boolean {
    if (this.dead || this.hurtTime > 0) return false;
    this.health -= amount;
    this.hurtTime = 10;
    if (byPlayer) {
      this.hurtByPlayer = 100;
      this.provoked = true;
    }
    const dx = this.x - fromX, dz = this.z - fromZ;
    const d = Math.hypot(dx, dz) || 1;
    if (knockback > 0) {
      this.vx += (dx / d) * 6 * knockback;
      this.vz += (dz / d) * 6 * knockback;
      this.vy = 6;
    }
    if (!this.type.hostile) this.panic = 100;
    return true;
  }

  tick(getBlock: BlockGetter, target: MobTarget, events: MobEvents): void {
    this.age++;
    this.prevLimbSwing = this.limbSwing;
    this.prevFuse = this.fuse;
    if (this.hurtTime > 0) this.hurtTime--;
    if (this.hurtByPlayer > 0) this.hurtByPlayer--;
    if (this.dead) {
      this.deathTime++;
      if (this.deathTime >= 20) this.removed = true;
      this.vx = this.vz = 0;
      this.physicsTick(getBlock, false);
      return;
    }
    if (this.attackCooldown > 0) this.attackCooldown--;
    if (--this.idleSound <= 0) {
      this.idleSound = 160 + Math.random() * 240;
      events.sound(this, 'idle');
    }

    const t = this.type;
    const dxT = target.x - this.x, dzT = target.z - this.z;
    const distT = Math.hypot(dxT, dzT, target.y - this.y);
    let speed = 0;

    // Follow range like Minecraft's (attribute follow_range): zombies notice players from 35 blocks, the others from 16.
    const follow = followRange(t);
    const hunting = t.hostile && target.attackable && distT < follow && !(t.neutralInLight && this.calm && !this.provoked);
    if (!hunting) this.aimTicks = 0;
    if (hunting) {
      // Chase the player.
      this.targetX = target.x;
      this.targetZ = target.z;
      speed = t.runSpeed;
      this.lookAt(target.x, target.y + 1.5, target.z);
      const sees = distT < (t.ranged ? 16 : 4) ? this.canSee(getBlock, target) : false;
      if (t.ranged) {
        // Skeleton (RangedBowAttackGoal): stop within 15 blocks with line of sight, wait 40 ticks after a shot, then
        // draw for 20 ticks: one arrow every 3 s (Easy and Normal).
        if (sees && distT < 15) {
          speed = distT < 4 ? -t.walkSpeed : 0;
          if (this.attackCooldown === 0 && ++this.aimTicks >= 20) {
            events.shoot(this, target);
            this.aimTicks = 0;
            this.attackCooldown = SKELETON_SHOT_INTERVAL;
          }
        } else {
          this.aimTicks = 0;
        }
      } else if (t.kind === 'creeper') {
        if (distT < 3 && sees) {
          if (this.fuse === 0) events.sound(this, 'fuse');
          this.fuse++;
          speed = 0;
        } else if (distT > 7 && this.fuse > 0) this.fuse--;
        if (this.fuse >= 30) {
          events.explode(this);
          this.removed = true;
          return;
        }
      } else if (distT < 1.4 + this.width / 2 && Math.abs(target.y - this.y) < 1.5 && this.attackCooldown === 0 && sees) {
        events.attack(this, t.attack, target);
        this.attackCooldown = 20;
      } else if (t.climbs && this.onGround && distT > 2 && distT < 4 && Math.random() < 0.2) {
        // Spider leap (Minecraft's LeapAtTargetGoal: 0.4 blocks/tick up and forward).
        const d = Math.hypot(dxT, dzT) || 1;
        this.vx = (dxT / d) * 8 + this.vx * 0.2;
        this.vz = (dzT / d) * 8 + this.vz * 0.2;
        this.vy = 8;
      }
    } else {
      if (this.fuse > 0) this.fuse--;
      if (this.panic > 0) {
        this.panic--;
        speed = t.runSpeed;
        if (!this.moving || Math.random() < 0.05) this.pickWanderTarget(6);
      } else if (this.moving) {
        speed = t.walkSpeed;
      } else if (Math.random() < 1 / 100) {
        this.pickWanderTarget(8);
      }
      // Idle glances stay within ~20° and fade back to the front (the old ±35° that stuck made
      // pigs look sideways most of the time, so one eye was always out of sight).
      if (Math.random() < 0.02) this.headYaw = (Math.random() - 0.5) * 0.7;
      else this.headYaw *= 0.97;
      this.headPitch *= 0.9;
    }

    // Steering towards the current target point.
    const dx = this.targetX - this.x, dz = this.targetZ - this.z;
    const dist = Math.hypot(dx, dz);
    if (speed < 0) {
      // Back away while facing the target (ranged mobs keeping distance).
      const want = Math.atan2(-dx, -dz);
      let diff = want - this.yaw;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      this.yaw += Math.max(-0.35, Math.min(0.35, diff));
      const accel = this.onGround ? 0.45 : 0.08;
      this.vx += (Math.sin(this.yaw) * -speed - this.vx) * accel;
      this.vz += (Math.cos(this.yaw) * -speed - this.vz) * accel;
    } else if (speed > 0 && dist > 0.4) {
      const want = Math.atan2(-dx, -dz);
      let diff = want - this.yaw;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      this.yaw += Math.max(-0.35, Math.min(0.35, diff));
      // Don't walk off ledges higher than 3 blocks unless chasing.
      const ax = this.x - Math.sin(this.yaw) * 0.8, az = this.z - Math.cos(this.yaw) * 0.8;
      const ground = this.groundBelow(getBlock, ax, az);
      if (ground > 3 && !(t.hostile && target.attackable)) {
        this.moving = false;
      } else {
        const accel = this.onGround || this.inWater ? 0.45 : 0.08;
        this.vx += (-Math.sin(this.yaw) * speed - this.vx) * accel;
        this.vz += (-Math.cos(this.yaw) * speed - this.vz) * accel;
      }
    } else {
      this.moving = false;
    }

    this.physicsTick(getBlock, speed > 0 && !t.climbs);
    // Spiders climb walls at 0.2 blocks/tick.
    if (t.climbs && speed > 0 && this.horizontalCollision) {
      this.vy = 4;
      this.fallDistance = 0;
    }

    // Limb swing from actual horizontal movement (Minecraft's limbSwing smoothing).
    const moved = Math.hypot(this.x - this.prevX, this.z - this.prevZ);
    this.limbAmount += (Math.min(1, moved * 4 * 4) - this.limbAmount) * 0.4;
    this.limbSwing += this.limbAmount;
  }

  /** Line of sight from the mob's eyes to the player's eyes (no attacks through walls, glass or closed doors). */
  private canSee(getBlock: BlockGetter, target: MobTarget): boolean {
    return lineOfSight(getBlock, Entity.metaGetter, this.x, this.y + this.height * 0.85, this.z, target.x, target.y + 1.62, target.z);
  }

  private pickWanderTarget(range: number): void {
    const a = Math.random() * Math.PI * 2;
    const r = 2 + Math.random() * range;
    this.targetX = this.x + Math.cos(a) * r;
    this.targetZ = this.z + Math.sin(a) * r;
    this.moving = true;
  }

  private lookAt(x: number, y: number, z: number): void {
    const dx = x - this.x, dz = z - this.z;
    let rel = Math.atan2(-dx, -dz) - this.yaw;
    rel = Math.atan2(Math.sin(rel), Math.cos(rel));
    this.headYaw = Math.max(-1.2, Math.min(1.2, rel));
    this.headPitch = Math.atan2(y - (this.y + this.height * 0.85), Math.hypot(dx, dz)) * 0.6;
  }

  private groundBelow(getBlock: BlockGetter, x: number, z: number): number {
    const bx = Math.floor(x), bz = Math.floor(z);
    for (let d = 0; d < 5; d++) {
      if (SOLID[getBlock(bx, Math.floor(this.y) - 1 - d, bz)]) return d;
    }
    return 5;
  }

  protected override onLand(fall: number): void {
    if (this.type.kind !== 'chicken' && fall > 3) this.health -= Math.ceil(fall - 3);
  }
}

const losBoxes = new Float64Array(64);

/**
 * Minecraft's `hasLineOfSight` (a COLLIDER clip): every block with a collision shape blocks the view, so glass,
 * leaves and closed doors stop melee attacks too, while the open half of a slab or the gaps beside a fence post do
 * not. Voxel traversal (Amanatides & Woo) visits every cell on the segment, so thin panes are never skipped.
 * Without block states (`getMeta` null) partial blocks count as full, like the collision code.
 */
export function lineOfSight(
  getBlock: BlockGetter, getMeta: BlockGetter | null,
  ax: number, ay: number, az: number, bx: number, by: number, bz: number,
): boolean {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  let x = Math.floor(ax), y = Math.floor(ay), z = Math.floor(az);
  const ex = Math.floor(bx), ey = Math.floor(by), ez = Math.floor(bz);
  const stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
  const tdX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
  const tdY = dy !== 0 ? Math.abs(1 / dy) : Infinity;
  const tdZ = dz !== 0 ? Math.abs(1 / dz) : Infinity;
  let tmX = dx !== 0 ? (dx > 0 ? x + 1 - ax : ax - x) * tdX : Infinity;
  let tmY = dy !== 0 ? (dy > 0 ? y + 1 - ay : ay - y) * tdY : Infinity;
  let tmZ = dz !== 0 ? (dz > 0 ? z + 1 - az : az - z) * tdZ : Infinity;
  // t runs 0..1 along the segment. The two end cells hold the eyes themselves, so only a partial block there (a door
  // the mob or player stands in) can block; any block counts in the cells in between.
  if (blocksEndCell(getBlock, getMeta, x, y, z, ax, ay, az, dx, dy, dz)) return false;
  for (let guard = 0; guard < 512; guard++) {
    if (tmX < tmY && tmX < tmZ) { if (tmX > 1) return true; x += stepX; tmX += tdX; }
    else if (tmY < tmZ) { if (tmY > 1) return true; y += stepY; tmY += tdY; }
    else { if (tmZ > 1) return true; z += stepZ; tmZ += tdZ; }
    if (x === ex && y === ey && z === ez) return !blocksEndCell(getBlock, getMeta, x, y, z, ax, ay, az, dx, dy, dz);
    const id = getBlock(x, y, z);
    if (OPAQUE[id]) return false;
    if (!SOLID[id]) continue;
    if (!PARTIAL[id] || !getMeta) return false;
    const n = collisionBoxes(id, getMeta(x, y, z), getBlock, getMeta, x, y, z, losBoxes);
    if (segmentHitsBoxes(n, x, y, z, ax, ay, az, dx, dy, dz)) return false;
  }
  return true;
}

function blocksEndCell(
  getBlock: BlockGetter, getMeta: BlockGetter | null, x: number, y: number, z: number,
  ax: number, ay: number, az: number, dx: number, dy: number, dz: number,
): boolean {
  const id = getBlock(x, y, z);
  if (!PARTIAL[id] || !SOLID[id] || !getMeta) return false;
  const n = collisionBoxes(id, getMeta(x, y, z), getBlock, getMeta, x, y, z, losBoxes);
  return segmentHitsBoxes(n, x, y, z, ax, ay, az, dx, dy, dz);
}

/** Does the segment a + t·d (t in 0..1) cross one of the first `n` boxes in `losBoxes` (cell-relative, at x, y, z)? */
function segmentHitsBoxes(n: number, x: number, y: number, z: number, ax: number, ay: number, az: number, dx: number, dy: number, dz: number): boolean {
  for (let k = 0; k < n; k++) {
    const o = k * 6;
    let tmin = 0, tmax = 1;
    for (let axis = 0; axis < 3 && tmin <= tmax; axis++) {
      const org = axis === 0 ? ax : axis === 1 ? ay : az;
      const dir = axis === 0 ? dx : axis === 1 ? dy : dz;
      const base = axis === 0 ? x : axis === 1 ? y : z;
      const lo = base + losBoxes[o + axis], hi = base + losBoxes[o + 3 + axis];
      if (dir === 0) {
        if (org < lo || org > hi) tmin = 2;
        continue;
      }
      let t1 = (lo - org) / dir, t2 = (hi - org) / dir;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
    }
    if (tmin <= tmax) return true;
  }
  return false;
}
