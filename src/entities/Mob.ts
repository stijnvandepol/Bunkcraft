import type { BlockGetter } from '../player/Collision';
import { OPAQUE, SOLID } from '../world/BlockRegistry';
import { Entity } from './Entity';
import type { MobType } from './MobTypes';
import type { Arrow } from './Arrow';
import type { PrimedTnt } from './PrimedTnt';

export interface MobTarget {
  x: number;
  y: number;
  z: number;
  /** Whether hostile mobs may attack (survival, alive). */
  attackable: boolean;
  /** Which player this is (multiplayer server); echoed back in attack and shoot events. */
  id?: number;
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
  /** Set each tick by the EntityManager: bright light keeps neutral-in-light mobs calm. */
  calm = false;
  /** Attacked: neutral mobs (spiders) stay hostile. */
  provoked = false;
  /** Ticks since the player last hurt this mob (player-kill drops). */
  hurtByPlayer = 0;
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
      this.vx += (dx / d) * 8 * knockback;
      this.vz += (dz / d) * 8 * knockback;
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

    const hunting = t.hostile && target.attackable && distT < (t.ranged ? 16 : 24) && !(t.neutralInLight && this.calm && !this.provoked);
    if (!hunting) this.aimTicks = 0;
    if (hunting) {
      // Chase the player.
      this.targetX = target.x;
      this.targetZ = target.z;
      speed = t.runSpeed;
      this.lookAt(target.x, target.y + 1.5, target.z);
      const sees = distT < (t.ranged ? 16 : 4) ? this.canSee(getBlock, target) : false;
      if (t.ranged) {
        // Skeleton: stop within 15 blocks with line of sight, draw for 1 s, shoot every 2 s.
        if (sees && distT < 15) {
          speed = distT < 4 ? -t.walkSpeed : 0;
          if (++this.aimTicks >= 20 && this.attackCooldown === 0) {
            events.shoot(this, target);
            this.aimTicks = 0;
            this.attackCooldown = 20;
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
      if (Math.random() < 0.02) this.headYaw = (Math.random() - 0.5) * 1.2;
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

  /** Line of sight from the mob's eyes to the player's eyes (no attacks through walls). */
  private canSee(getBlock: BlockGetter, target: MobTarget): boolean {
    const ex = this.x, ey = this.y + this.height * 0.85, ez = this.z;
    const dx = target.x - ex, dy = target.y + 1.62 - ey, dz = target.z - ez;
    const len = Math.hypot(dx, dy, dz);
    const steps = Math.ceil(len / 0.25);
    for (let i = 1; i < steps; i++) {
      const f = i / steps;
      const b = getBlock(Math.floor(ex + dx * f), Math.floor(ey + dy * f), Math.floor(ez + dz * f));
      if (OPAQUE[b]) return false;
    }
    return true;
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
