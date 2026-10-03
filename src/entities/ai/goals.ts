import { BLOCK } from '../../world/BlockRegistry';
import { isBreedFood } from '../Breeding';
import { BREED_COOLDOWN, LOVE_TICKS, type Mob, type MobTarget, isMob } from '../Mob';
import { FLAG, type Goal } from './Goal';
import { pathGrid } from './Pathfinder';

/** The generic goals of Minecraft's mob AI, parameterised like their Java counterparts. */

const scratch = { x: 0, y: 0, z: 0 };

/**
 * A random standable cell near the mob for strolls, panic and fleeing: within `range` blocks horizontally and
 * `vrange` vertically, in loaded chunks only, and (with `avoidWater`) not in water. Result in `out`.
 */
export function pickGroundTarget(m: Mob, range: number, vrange: number, avoidWater: boolean, out = scratch, shade = false): boolean {
  const g = pathGrid;
  g.getBlock = m.getBlock;
  g.height = Math.max(1, Math.ceil(m.height - 0.01));
  g.avoidWater = avoidWater;
  const bx = Math.floor(m.x), by = Math.floor(m.y + 0.05), bz = Math.floor(m.z);
  for (let i = 0; i < 10; i++) {
    const px = bx + Math.floor((Math.random() * 2 - 1) * (range + 1)), pz = bz + Math.floor((Math.random() * 2 - 1) * (range + 1));
    if (px === bx && pz === bz) continue;
    const y = g.groundY(px, by + vrange, pz, vrange * 2);
    if (y < 0) continue;
    if (shade && m.world?.sunlit(px + 0.5, y + 1.6, pz + 0.5)) continue;
    out.x = px + 0.5; out.y = y; out.z = pz + 0.5;
    return true;
  }
  return false;
}

/** Swimming: land mobs in water keep their head up (the physics provides the buoyancy; this holds the jump flag). */
export class FloatGoal implements Goal {
  readonly flags = FLAG.JUMP;
  constructor(private readonly m: Mob) {}
  canUse(): boolean { return this.m.inWater; }
  tick(): void { this.m.wantJump = true; }
}

/** After being hurt: run in random directions for a few seconds (Minecraft: PanicGoal). */
export class PanicGoal implements Goal {
  readonly flags = FLAG.MOVE;
  constructor(private readonly m: Mob) {}
  canUse(): boolean { return this.m.panic > 0; }
  canContinue(): boolean { return this.m.panic > 0; }
  start(): void { this.pick(); }
  tick(): void {
    const m = this.m;
    m.panic--;
    if (m.nav.done || Math.random() < 0.05) this.pick();
  }
  stop(): void { this.m.nav.stop(); }
  private pick(): void {
    const m = this.m;
    if (pickGroundTarget(m, 6, 3, false)) m.nav.moveTo(scratch.x, scratch.y, scratch.z, m.type.runSpeed, 0.8);
  }
}

/** Walk a short way now and then (Minecraft: WaterAvoidingRandomStrollGoal, interval 120 ticks). */
export class StrollGoal implements Goal {
  readonly flags = FLAG.MOVE;
  constructor(private readonly m: Mob, private readonly interval = 120, private readonly range = 10) {}
  canUse(): boolean {
    const m = this.m;
    if (m.sitting || Math.random() * this.interval >= 1) return false;
    if (!pickGroundTarget(m, this.range, 7, true, this.pos)) return false;
    return true;
  }
  canContinue(): boolean { return this.m.nav.active && !this.m.nav.failed; }
  start(): void { this.m.nav.moveTo(this.pos.x, this.pos.y, this.pos.z, this.m.type.walkSpeed, 0.8); }
  stop(): void { this.m.nav.stop(); }
  private readonly pos = { x: 0, y: 0, z: 0 };
}

/** Looks at a player within range for 2-4 seconds now and then. */
export class LookAtPlayerGoal implements Goal {
  readonly flags = FLAG.LOOK;
  private ticks = 0;
  constructor(private readonly m: Mob, private readonly range = 6, private readonly chance = 0.02) {}
  private near(): boolean {
    const m = this.m, p = m.player;
    const dx = p.x - m.x, dz = p.z - m.z;
    return dx * dx + dz * dz < this.range * this.range && Math.abs(p.y - m.y) < 4;
  }
  canUse(): boolean { return Math.random() < this.chance && this.near(); }
  canContinue(): boolean { return this.ticks > 0 && this.near(); }
  start(): void { this.ticks = 40 + Math.floor(Math.random() * 40); }
  tick(): void {
    const p = this.m.player;
    this.m.lookAt(p.x, p.y + 1.62, p.z);
    this.ticks--;
  }
}

/** Glances in a random direction for about a second (Minecraft: RandomLookAroundGoal). */
export class RandomLookGoal implements Goal {
  readonly flags = FLAG.LOOK;
  private ticks = 0;
  private dx = 0; private dz = 0; private dy = 0;
  constructor(private readonly m: Mob) {}
  canUse(): boolean { return Math.random() < 0.02; }
  canContinue(): boolean { return this.ticks > 0; }
  start(): void {
    const m = this.m;
    // Within about 55° of the facing direction: the head can follow it without the body turning.
    const a = m.yaw + (Math.random() - 0.5) * 2;
    this.dx = -Math.sin(a) * 6; this.dz = -Math.cos(a) * 6;
    this.dy = (Math.random() - 0.5) * 2;
    this.ticks = 20 + Math.floor(Math.random() * 20);
  }
  tick(): void {
    const m = this.m;
    m.lookAt(m.x + this.dx, m.y + m.eyeHeight + this.dy, m.z + this.dz);
    this.ticks--;
  }
}

/** Follow the player holding breeding food (Minecraft: TemptGoal). */
export class TemptGoal implements Goal {
  readonly flags = FLAG.MOVE | FLAG.LOOK;
  private cooldownUntil = 0;
  constructor(private readonly m: Mob, private readonly speedMod = 1.25, private readonly range = 10) {}
  private tempted(): boolean {
    const m = this.m, p = m.player;
    if (!isBreedFood(m.type.kind, p.held)) return false;
    const dx = p.x - m.x, dz = p.z - m.z;
    return dx * dx + dz * dz < this.range * this.range && Math.abs(p.y - m.y) < 6;
  }
  canUse(): boolean { return this.m.age >= this.cooldownUntil && this.tempted(); }
  canContinue(): boolean { return this.tempted(); }
  tick(): void {
    const m = this.m, p = m.player;
    m.lookAt(p.x, p.y + 1.62, p.z);
    const d2 = m.distanceToSq2D(p.x, p.z);
    if (d2 > 6.25) m.nav.moveTo(p.x, p.y, p.z, m.type.walkSpeed * this.speedMod, 2);
    else m.nav.stop();
  }
  stop(): void {
    this.m.nav.stop();
    this.cooldownUntil = this.m.age + 100;
  }
}

/** Two animals in love walk to each other and make a baby after three seconds close together. */
export class BreedGoal implements Goal {
  readonly flags = FLAG.MOVE | FLAG.LOOK;
  private partner: Mob | null = null;
  private timer = 0;
  constructor(private readonly m: Mob, private readonly speedMod = 1) {}

  private findPartner(): Mob | null {
    const m = this.m, world = m.world;
    if (!world) return null;
    let best: Mob | null = null, bestD = 64;
    const mobs = world.mobs;
    for (let i = 0; i < mobs.length; i++) {
      const o = mobs[i];
      if (o === m || o.type !== m.type || o.removed || o.dead || o.inLove <= 0 || o.growingAge < 0) continue;
      const d = m.distanceToSq2D(o.x, o.z);
      if (d < bestD && Math.abs(o.y - m.y) < 4) { bestD = d; best = o; }
    }
    return best;
  }
  canUse(): boolean {
    const m = this.m;
    if (m.inLove <= 0 || m.growingAge < 0) return false;
    this.partner = this.findPartner();
    return this.partner !== null;
  }
  canContinue(): boolean {
    const p = this.partner;
    return p !== null && !p.removed && !p.dead && p.inLove > 0 && this.m.inLove > 0 && this.timer < 60;
  }
  start(): void { this.timer = 0; }
  stop(): void { this.partner = null; this.timer = 0; this.m.nav.stop(); }
  tick(): void {
    const m = this.m, p = this.partner!;
    m.lookAt(p.x, p.y + p.eyeHeight, p.z);
    m.nav.moveTo(p.x, p.y, p.z, m.type.walkSpeed * this.speedMod, 1);
    if (m.distanceToSq2D(p.x, p.z) < 9 && ++this.timer >= 60) this.breed(p);
  }

  private breed(p: Mob): void {
    const m = this.m, world = m.world;
    m.inLove = p.inLove = 0;
    m.breedCooldown = p.breedCooldown = BREED_COOLDOWN;
    this.timer = 60;
    if (!world) return;
    const baby = world.spawnMob(m.type.kind, (m.x + p.x) / 2, Math.max(m.y, p.y), (m.z + p.z) / 2);
    baby.setBaby(true);
    baby.homeChunk = m.homeChunk;
    baby.persistent = m.persistent || p.persistent;
    baby.variant = Math.random() < 0.5 ? m.variant & 15 : p.variant & 15; // sheep inherit a parent's colour, wolves a collar
    if (m.tamed) baby.ownerId = m.ownerId;
    m.events?.fx?.(m, 'love');
    m.events?.xp?.(m.x, m.y, m.z, 1 + Math.floor(Math.random() * 7));
  }
}

/** Hearts float up from animals in love mode. */
export class LoveFxGoal implements Goal {
  readonly flags = 0;
  constructor(private readonly m: Mob) {}
  canUse(): boolean { return this.m.inLove > 0; }
  tick(): void {
    const m = this.m;
    if (m.age % 20 === 0) m.events?.fx?.(m, 'love');
  }
}

/** A baby stays close to an adult of its kind (Minecraft: FollowParentGoal). */
export class FollowParentGoal implements Goal {
  readonly flags = FLAG.MOVE;
  private parent: Mob | null = null;
  constructor(private readonly m: Mob, private readonly speedMod = 1.1) {}
  canUse(): boolean {
    const m = this.m, world = m.world;
    if (!m.baby || !world) return false;
    let best: Mob | null = null, bestD = 64;
    const mobs = world.mobs;
    for (let i = 0; i < mobs.length; i++) {
      const o = mobs[i];
      if (o.type !== m.type || o.removed || o.dead || o.growingAge < 0) continue;
      const d = m.distanceToSq2D(o.x, o.z);
      if (d < bestD && Math.abs(o.y - m.y) < 4) { bestD = d; best = o; }
    }
    if (!best || bestD < 9) return false;
    this.parent = best;
    return true;
  }
  canContinue(): boolean {
    const p = this.parent;
    if (!p || p.removed || p.dead || !this.m.baby) return false;
    const d = this.m.distanceToSq2D(p.x, p.z);
    return d >= 9 && d <= 256;
  }
  tick(): void {
    const m = this.m, p = this.parent!;
    m.nav.moveTo(p.x, p.y, p.z, m.type.walkSpeed * this.speedMod, 2);
  }
  stop(): void { this.parent = null; this.m.nav.stop(); }
}

/** Sheep graze: grass turns to dirt, tall grass is eaten, a shorn sheep regrows its wool, a lamb grows faster. */
export class EatGrassGoal implements Goal {
  readonly flags = FLAG.MOVE | FLAG.LOOK | FLAG.JUMP;
  constructor(private readonly m: Mob) {}
  private spot(): { x: number; y: number; z: number; tall: boolean } | null {
    const m = this.m;
    const x = Math.floor(m.x), y = Math.floor(m.y + 0.05), z = Math.floor(m.z);
    if (m.getBlock(x, y, z) === BLOCK.TALL_GRASS) return { x, y, z, tall: true };
    if (m.getBlock(x, y - 1, z) === BLOCK.GRASS) return { x, y: y - 1, z, tall: false };
    return null;
  }
  canUse(): boolean {
    const m = this.m;
    if (Math.random() * (m.baby ? 50 : 1000) >= 1) return false;
    return this.spot() !== null;
  }
  canContinue(): boolean { return this.m.busy > 0; }
  start(): void { this.m.busy = 40; this.m.nav.stop(); }
  stop(): void { this.m.busy = 0; }
  tick(): void {
    const m = this.m;
    if (m.busy !== 4) return;
    const s = this.spot();
    if (!s) return;
    const ok = m.world?.setBlock?.(s.x, s.y, s.z, s.tall ? BLOCK.AIR : BLOCK.DIRT) ?? false;
    if (!ok) return;
    if (m.type.kind === 'sheep') m.variant &= ~16;
    if (m.baby) m.growingAge = Math.min(0, m.growingAge + 60);
  }
}

/** Attack the target in melee (Minecraft: MeleeAttackGoal): path to it, hit every second in reach. */
export class MeleeAttackGoal implements Goal {
  readonly flags = FLAG.MOVE | FLAG.LOOK;
  constructor(private readonly m: Mob, private readonly runSpeed = 1) {}
  canUse(): boolean { return this.m.target !== null; }
  start(): void { this.m.nav.stop(); }
  stop(): void { this.m.nav.stop(); }
  tick(): void {
    const m = this.m, t = this.m.target;
    if (!t) return;
    m.lookAt(t.x, t.y + (isMob(t) ? t.eyeHeight : 1.5), t.z);
    m.nav.moveTo(t.x, t.y, t.z, m.type.runSpeed * this.runSpeed, 0.8);
    meleeStrike(m, t);
  }
}

/** The nearest player becomes the target while attackable and in range (zombies, spiders, creepers). */
export class NearestPlayerTargetGoal implements Goal {
  readonly flags = FLAG.TARGET;
  constructor(private readonly m: Mob, private readonly range: number, private readonly calmCheck = false) {}
  private ok(): boolean {
    const m = this.m, p = m.player;
    if (!p.attackable) return false;
    if (this.calmCheck && m.calm && !m.provoked) return false;
    return m.distanceTo(p) < this.range;
  }
  canUse(): boolean { return this.ok(); }
  canContinue(): boolean { return this.ok(); }
  tick(): void { this.m.target = this.m.player; }
  start(): void { this.m.target = this.m.player; }
  stop(): void { if (this.m.target && !isMob(this.m.target)) this.m.target = null; }
}

/** Strike the target if it is in reach and the cooldown is over (shared by the melee and swimming goals). */
export function meleeStrike(m: Mob, t: NonNullable<Mob['target']>): void {
  const tm = isMob(t);
  const dist = m.distanceTo(t);
  const reach = 1.4 + m.width / 2 + (tm ? t.width / 2 : 0);
  if (m.attackCooldown > 0 || dist >= reach || Math.abs(t.y - m.y) >= 1.5) return;
  const damage = m.attackDamage;
  if (damage <= 0 || !m.canSee(m.getBlock, t)) return;
  m.attackCooldown = 20;
  if (tm) {
    if (t.hurt(damage, m.x, m.z, 1, false, m)) m.events?.sound(t, 'hurt');
  } else {
    m.events?.attack(m, damage, t as MobTarget);
  }
}

/** Creeper fuse (Minecraft: SwellGoal): swells within 3 blocks in sight, cools down beyond 7 or out of sight. */
export class CreeperSwellGoal implements Goal {
  readonly flags = FLAG.MOVE;
  constructor(private readonly m: Mob) {}
  canUse(): boolean {
    const m = this.m, t = m.target;
    return m.fuse > 0 || (t !== null && m.distanceTo(t) < 3);
  }
  start(): void { this.m.nav.stop(); }
  tick(): void {
    const m = this.m, t = m.target;
    const dist = t ? m.distanceTo(t) : Infinity;
    if (!t || dist > 7 || !m.canSee(m.getBlock, t)) {
      if (m.fuse > 0) m.fuse--;
      return;
    }
    m.lookAt(t.x, t.y + 1.5, t.z);
    if (m.fuse === 0) m.events?.sound(m, 'fuse');
    if (++m.fuse >= 30) {
      m.events?.explode(m);
      m.removed = true;
    }
  }
}

/** Spider leap: 0.4 blocks/tick up and forward when 2-4 blocks from the target (Minecraft: LeapAtTargetGoal). */
export class LeapAtTargetGoal implements Goal {
  readonly flags = FLAG.JUMP | FLAG.MOVE;
  private leapt = false;
  constructor(private readonly m: Mob) {}
  canUse(): boolean {
    const m = this.m, t = m.target;
    if (!t || !m.onGround) return false;
    const d = m.distanceTo(t);
    return d > 2 && d < 4 && Math.random() < 0.2;
  }
  canContinue(): boolean { return this.leapt && !this.m.onGround; }
  start(): void {
    const m = this.m, t = m.target!;
    const dx = t.x - m.x, dz = t.z - m.z;
    const d = Math.hypot(dx, dz) || 1;
    m.vx = (dx / d) * 8 + m.vx * 0.2;
    m.vz = (dz / d) * 8 + m.vz * 0.2;
    m.vy = 8;
    this.leapt = true;
  }
  stop(): void { this.leapt = false; }
}

/** Skeleton: keep distance, draw for a second and shoot (Normal difficulty: one arrow per 2 s; Hard 1 s, onzeker). */
export class RangedAttackGoal implements Goal {
  readonly flags = FLAG.MOVE | FLAG.LOOK;
  constructor(private readonly m: Mob, private readonly interval = 40) {}
  canUse(): boolean { return this.m.target !== null && !isMob(this.m.target); }
  stop(): void { this.m.aimTicks = 0; this.m.nav.stop(); }
  tick(): void {
    const m = this.m, t = m.target as MobTarget | null;
    if (!t) return;
    m.lookAt(t.x, t.y + 1.5, t.z);
    const dist = m.distanceTo(t);
    const sees = dist < 16 ? m.canSee(m.getBlock, t) : false;
    if (sees && dist < 15) {
      m.nav.stop();
      if (dist < 4) m.setMove(t.x, t.z, -m.type.walkSpeed);
      if (++m.aimTicks >= 20 && m.attackCooldown === 0) {
        m.events?.shoot(m, t);
        m.aimTicks = 0;
        m.attackCooldown = this.interval;
      }
    } else {
      m.aimTicks = 0;
      m.nav.moveTo(t.x, t.y, t.z, m.type.runSpeed, 3);
    }
  }
}

/** A burning daylight mob without a target looks for shade (Minecraft: FleeSunGoal). */
export class FleeSunGoal implements Goal {
  readonly flags = FLAG.MOVE;
  private readonly pos = { x: 0, y: 0, z: 0 };
  constructor(private readonly m: Mob) {}
  canUse(): boolean {
    const m = this.m;
    if (m.target || m.burning <= 0 || !m.world) return false;
    return pickGroundTarget(m, 7, 3, true, this.pos, true);
  }
  canContinue(): boolean { return !this.m.target && this.m.nav.active && !this.m.nav.failed; }
  start(): void { this.m.nav.moveTo(this.pos.x, this.pos.y, this.pos.z, this.m.type.runSpeed, 0.8); }
  stop(): void { this.m.nav.stop(); }
}

export { BREED_COOLDOWN, LOVE_TICKS };
