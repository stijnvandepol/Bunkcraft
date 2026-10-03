import { itemId } from '../../items/ItemRegistry';
import { type AiTarget, type Mob, type MobTarget, isMob } from '../Mob';
import type { MobKind } from '../MobTypes';
import { FLAG, type Goal } from './Goal';
import { meleeStrike } from './goals';
import { pathGrid } from './Pathfinder';

/** Goals of the newer mobs: wolves (taming, owner fights), endermen, slimes, drowned, witches, chickens, skeletons. */

/** The owner of a tamed mob among the players, or null when he is not around. */
export function ownerOf(m: Mob): MobTarget | null {
  if (!m.tamed) return null;
  const targets = m.world?.targets;
  if (targets && targets.length > 0) {
    for (let i = 0; i < targets.length; i++) if ((targets[i].id ?? 0) === m.ownerId) return targets[i];
    return null;
  }
  return (m.player.id ?? 0) === m.ownerId ? m.player : null;
}

/** Nearest living mob within `range` that passes `test` (−1 range = any). */
function nearestMob(m: Mob, range: number, test: (o: Mob) => boolean): Mob | null {
  const world = m.world;
  if (!world) return null;
  let best: Mob | null = null, bestD = range * range;
  const mobs = world.mobs;
  for (let i = 0; i < mobs.length; i++) {
    const o = mobs[i];
    if (o === m || o.removed || o.dead || !test(o)) continue;
    const d = m.distanceToSq2D(o.x, o.z);
    if (d < bestD && Math.abs(o.y - m.y) < 8) { bestD = d; best = o; }
  }
  return best;
}

function alive(t: AiTarget | null): boolean {
  return t !== null && (!isMob(t) || (!t.dead && !t.removed));
}

/** Base for target goals that pick one target and keep it while it is valid. */
abstract class PickTargetGoal implements Goal {
  readonly flags = FLAG.TARGET;
  protected chosen: AiTarget | null = null;
  constructor(protected readonly m: Mob, protected readonly keepRange = 24) {}
  abstract find(): AiTarget | null;
  canUse(): boolean {
    this.chosen = this.find();
    return this.chosen !== null;
  }
  canContinue(): boolean {
    const t = this.chosen;
    if (!alive(t) || this.m.distanceTo(t!) > this.keepRange) return false;
    return !(t && !isMob(t) && !t.attackable);
  }
  start(): void { this.m.target = this.chosen; }
  tick(): void { if (this.chosen && !isMob(this.chosen)) this.m.target = this.chosen; }
  stop(): void {
    if (this.m.target === this.chosen) this.m.target = null;
    this.chosen = null;
  }
}

// ---------------------------------------------------------------- wolves

/** A sitting wolf stays put (Minecraft: SitWhenOrderedToGoal). */
export class SitGoal implements Goal {
  readonly flags = FLAG.MOVE | FLAG.JUMP;
  constructor(private readonly m: Mob) {}
  canUse(): boolean { return this.m.sitting && this.m.tamed && !this.m.inWater; }
  start(): void { this.m.nav.stop(); this.m.target = null; }
}

/**
 * Tamed mobs follow their owner when more than 10 blocks away and stop at 2; beyond 12 blocks they teleport next
 * to him (Minecraft: FollowOwnerGoal).
 */
export class FollowOwnerGoal implements Goal {
  readonly flags = FLAG.MOVE | FLAG.LOOK;
  private timer = 0;
  constructor(private readonly m: Mob, private readonly start2 = 100, private readonly stop2 = 4) {}
  canUse(): boolean {
    const m = this.m, o = ownerOf(m);
    if (!o || m.sitting || m.target) return false;
    return m.distanceToSq2D(o.x, o.z) > this.start2 || Math.abs(o.y - m.y) > 4;
  }
  canContinue(): boolean {
    const m = this.m, o = ownerOf(m);
    if (!o || m.sitting || m.target) return false;
    return m.distanceToSq2D(o.x, o.z) > this.stop2;
  }
  start(): void { this.timer = 0; }
  stop(): void { this.m.nav.stop(); }
  tick(): void {
    const m = this.m, o = ownerOf(m)!;
    m.lookAt(o.x, o.y + 1.62, o.z);
    if (--this.timer > 0) return;
    this.timer = 10;
    if (m.distanceToSq2D(o.x, o.z) >= 144 && teleportNear(m, o.x, o.y, o.z, 3)) return;
    m.nav.moveTo(o.x, o.y, o.z, m.type.runSpeed, 1.5);
  }
}

/** Teleports the mob onto a free standable cell 2..r blocks from (x, y, z). */
export function teleportNear(m: Mob, x: number, y: number, z: number, r: number): boolean {
  const g = pathGrid;
  g.getBlock = m.getBlock; g.height = Math.max(1, Math.ceil(m.height - 0.01)); g.avoidWater = true;
  for (let i = 0; i < 10; i++) {
    const dx = Math.floor((Math.random() * 2 - 1) * (r + 1)), dz = Math.floor((Math.random() * 2 - 1) * (r + 1));
    if (Math.abs(dx) < 2 && Math.abs(dz) < 2) continue;
    const bx = Math.floor(x) + dx, bz = Math.floor(z) + dz;
    const by = g.groundY(bx, Math.floor(y) + 2, bz, 4);
    if (by < 0) continue;
    m.setPosition(bx + 0.5, by, bz + 0.5);
    m.vx = m.vy = m.vz = 0;
    m.nav.stop();
    return true;
  }
  return false;
}

/** The mob that last hurt the owner becomes the target (Minecraft: OwnerHurtByTargetGoal). */
export class OwnerHurtByTargetGoal extends PickTargetGoal {
  find(): AiTarget | null {
    const m = this.m;
    if (!m.tamed || m.sitting || !m.world?.lastAttackerOf) return null;
    const a = m.world.lastAttackerOf(m.ownerId);
    if (!a || a === m || a.dead || a.removed || a.type.kind === 'creeper' || (a.tamed && a.ownerId === m.ownerId)) return null;
    return a;
  }
}

/** The mob the owner just hit becomes the target (Minecraft: OwnerHurtTargetGoal). Creepers are left alone. */
export class OwnerHurtTargetGoal extends PickTargetGoal {
  find(): AiTarget | null {
    const m = this.m;
    if (!m.tamed || m.sitting || m.age % 4 !== 0) return null;
    return nearestMob(m, 16, (o) => o.hurtByPlayer >= 90 && o.hurtByPlayerId === m.ownerId && o.type.kind !== 'creeper'
      && !(o.tamed && o.ownerId === m.ownerId));
  }
}

/**
 * Hurt by a mob: fight back (and other wolves of the pack join). Hurt by a player: an untamed wolf (or any enderman)
 * turns angry at him for 20-39 s; tamed wolves never turn on players.
 */
export class RetaliateGoal extends PickTargetGoal {
  find(): AiTarget | null {
    const m = this.m;
    if (m.lastAttacker && m.age - m.lastHurtAge < 5 && alive(m.lastAttacker) && !(m.tamed && m.lastAttacker.ownerId === m.ownerId && m.lastAttacker.tamed)) {
      return m.lastAttacker;
    }
    if (m.hurtByPlayer >= 95 && !m.tamed && m.player.attackable) {
      this.anger(m);
      if (m.type.kind === 'wolf') {
        // The pack joins in (Minecraft alerts wolves within 16 blocks... with `alertOthers`).
        const mobs = m.world?.mobs ?? [];
        for (const o of mobs) {
          if (o !== m && o.type === m.type && !o.tamed && !o.dead && m.distanceToSq2D(o.x, o.z) < 256) this.anger(o);
        }
      }
      return m.player;
    }
    if (m.angryTicks > 0 && !m.tamed && m.player.attackable && m.distanceTo(m.player) < 24) return m.player;
    return null;
  }
  override canContinue(): boolean {
    const t = this.chosen;
    if (t && !isMob(t)) return this.m.angryTicks > 0 && super.canContinue();
    return super.canContinue();
  }
  private anger(o: Mob): void {
    if (o.angryTicks <= 0) o.events?.sound(o, 'angry');
    o.angryTicks = 400 + Math.floor(Math.random() * 380);
  }
}

/** Wolves hunt skeletons, and wild ones now and then sheep (Minecraft: NonTameRandomTargetGoal). */
export class PreyTargetGoal extends PickTargetGoal {
  constructor(m: Mob, private readonly prey: readonly MobKind[], private readonly wildOnly: boolean, private readonly chance: number) {
    super(m, 20);
  }
  find(): AiTarget | null {
    const m = this.m;
    if (m.baby || m.sitting || (this.wildOnly && m.tamed) || Math.random() >= this.chance) return null;
    return nearestMob(m, 16, (o) => this.prey.includes(o.type.kind));
  }
}

// ---------------------------------------------------------------- skeletons

/** Skeletons run from wolves within 6 blocks (Minecraft: AvoidEntityGoal). */
export class AvoidMobGoal implements Goal {
  readonly flags = FLAG.MOVE;
  private from: Mob | null = null;
  constructor(private readonly m: Mob, private readonly kinds: readonly MobKind[], private readonly range = 6) {}
  canUse(): boolean {
    const m = this.m;
    if (m.age % 5 !== 0) return false;
    this.from = nearestMob(m, this.range, (o) => this.kinds.includes(o.type.kind));
    return this.from !== null;
  }
  canContinue(): boolean {
    const f = this.from;
    return f !== null && !f.dead && !f.removed && this.m.distanceToSq2D(f.x, f.z) < (this.range + 2) ** 2;
  }
  tick(): void {
    const m = this.m, f = this.from!;
    const dx = m.x - f.x, dz = m.z - f.z;
    const d = Math.hypot(dx, dz) || 1;
    m.setMove(m.x + (dx / d) * 4, m.z + (dz / d) * 4, m.type.runSpeed);
  }
  stop(): void { this.from = null; }
}

// ---------------------------------------------------------------- endermen

/**
 * Endermen turn angry when a player looks at their head for 5 ticks within 64 blocks (Minecraft's
 * `isLookingAtMe`: the view direction within 0.025/d of the head), or when hit.
 */
export class EndermanStareGoal extends PickTargetGoal {
  private stare = 0;
  constructor(m: Mob) { super(m, 64); }
  find(): AiTarget | null {
    const m = this.m, p = m.player;
    if (!p.attackable) { this.stare = 0; return null; }
    if (m.hurtByPlayer >= 95 || (m.angryTicks > 0 && m.distanceTo(p) < 64)) return this.angry(p);
    if (p.yaw === undefined || p.pitch === undefined || m.distanceTo(p) > 64) { this.stare = 0; return null; }
    const vx = -Math.sin(p.yaw) * Math.cos(p.pitch), vy = Math.sin(p.pitch), vz = -Math.cos(p.yaw) * Math.cos(p.pitch);
    const dx = m.x - p.x, dy = m.y + m.eyeHeight - (p.y + 1.62), dz = m.z - p.z;
    const d = Math.hypot(dx, dy, dz) || 1;
    const dot = (vx * dx + vy * dy + vz * dz) / d;
    if (dot > 1 - 0.025 / d && m.canSee(m.getBlock, p)) {
      if (++this.stare >= 5) return this.angry(p);
    } else this.stare = 0;
    return null;
  }
  override canContinue(): boolean { return this.m.angryTicks > 0 && super.canContinue(); }
  private angry(p: MobTarget): MobTarget {
    const m = this.m;
    this.stare = 0;
    if (m.angryTicks <= 0) m.events?.sound(m, 'angry');
    m.angryTicks = 600;
    m.busy = 600;
    return p;
  }
  override stop(): void { super.stop(); this.m.busy = 0; }
}

/**
 * Teleports: away after taking damage (half the hits; arrows included), every tick in water (with 1 damage per
 * half second), and towards an angry target that is more than 16 blocks away.
 */
export class TeleportGoal implements Goal {
  readonly flags = 0;
  constructor(private readonly m: Mob) {}
  canUse(): boolean { return true; }
  tick(): void {
    const m = this.m;
    if (m.inWater && !m.inLava) {
      if (m.age % 10 === 0) m.hurt(1, m.x, m.z, 0);
      m.pendingTeleport = true;
    }
    const t = m.target;
    if (m.pendingTeleport) {
      if (this.teleport(m.x, m.y, m.z, 16)) m.pendingTeleport = false;
    } else if (t && m.age % 30 === 0 && m.distanceTo(t) > 16 && Math.random() < 0.5) {
      this.teleport(t.x, t.y, t.z, 6);
    }
  }
  private teleport(x: number, y: number, z: number, r: number): boolean {
    const m = this.m;
    const g = pathGrid;
    g.getBlock = m.getBlock; g.height = 3; g.avoidWater = true;
    for (let i = 0; i < 16; i++) {
      const bx = Math.floor(x + (Math.random() * 2 - 1) * r), bz = Math.floor(z + (Math.random() * 2 - 1) * r);
      const by = g.groundY(bx, Math.floor(y) + 8, bz, 16);
      if (by < 0) continue;
      m.events?.fx?.(m, 'poof');
      m.setPosition(bx + 0.5, by, bz + 0.5);
      m.vx = m.vy = m.vz = 0;
      m.nav.stop();
      m.events?.sound(m, 'teleport');
      return true;
    }
    return false;
  }
}

// ---------------------------------------------------------------- slimes

/**
 * Slimes only move by hopping: on the ground they wait 10-30 ticks (a third of that when chasing), then jump towards
 * the target or in a direction that changes now and then; touching the target hurts it.
 */
export class SlimeHopGoal implements Goal {
  readonly flags = FLAG.MOVE | FLAG.JUMP | FLAG.LOOK;
  private delay = 0;
  private dir = Math.random() * Math.PI * 2;
  constructor(private readonly m: Mob) {}
  canUse(): boolean { return true; }
  tick(): void {
    const m = this.m, t = m.target;
    if (t) {
      this.dir = Math.atan2(-(t.x - m.x), -(t.z - m.z));
      meleeStrike(m, t);
    } else if (Math.random() < 0.02) {
      this.dir += (Math.random() - 0.5) * 2;
    }
    let diff = this.dir - m.yaw;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    m.yaw += Math.max(-0.5, Math.min(0.5, diff));
    if (m.inWater) { m.wantJump = true; return; }
    if (!m.onGround) {
      // Keep the air speed (no ground friction in the air).
      return;
    }
    if (--this.delay > 0) return;
    this.delay = 10 + Math.floor(Math.random() * 20);
    if (t) this.delay = Math.ceil(this.delay / 3);
    const speed = m.type.walkSpeed * (0.8 + 0.1 * m.size);
    m.vx = -Math.sin(m.yaw) * speed;
    m.vz = -Math.cos(m.yaw) * speed;
    m.vy = 8.4;
  }
}

// ---------------------------------------------------------------- drowned

/** Drowned swim after their target in water: steer straight at it and match its height. */
export class DrownedSwimGoal implements Goal {
  readonly flags = FLAG.MOVE | FLAG.LOOK;
  constructor(private readonly m: Mob) {}
  canUse(): boolean { return this.m.inWater && this.m.target !== null; }
  tick(): void {
    const m = this.m, t = m.target!;
    m.lookAt(t.x, t.y + 1.5, t.z);
    m.setMove(t.x, t.z, m.type.runSpeed * 0.8);
    m.swimVy = Math.max(-2.5, Math.min(2.5, (t.y - m.y) * 2));
    meleeStrike(m, t);
  }
}

// ---------------------------------------------------------------- witches

/** Witches throw a potion every 3 s at a player within 10 blocks in sight, otherwise close in. */
export class PotionAttackGoal implements Goal {
  readonly flags = FLAG.MOVE | FLAG.LOOK;
  constructor(private readonly m: Mob) {}
  canUse(): boolean { return this.m.target !== null && !isMob(this.m.target); }
  stop(): void { this.m.nav.stop(); }
  tick(): void {
    const m = this.m, t = m.target as MobTarget;
    m.lookAt(t.x, t.y + 1.5, t.z);
    const d = m.distanceTo(t);
    const sees = d < 12 && m.canSee(m.getBlock, t);
    if (sees && d < 10) {
      m.nav.stop();
      if (m.attackCooldown === 0) {
        m.attackCooldown = 60;
        m.busy = 10;
        m.events?.potion?.(m, t);
      }
    } else {
      m.nav.moveTo(t.x, t.y, t.z, m.type.walkSpeed, 6);
    }
  }
}

// ---------------------------------------------------------------- chickens

/** A grown chicken lays an egg every 5-10 minutes (Minecraft: 6000-12000 ticks). */
export class LayEggGoal implements Goal {
  readonly flags = 0;
  private timer = 6000 + Math.floor(Math.random() * 6000);
  constructor(private readonly m: Mob) {}
  canUse(): boolean { return !this.m.baby; }
  tick(): void {
    if (--this.timer > 0) return;
    this.timer = 6000 + Math.floor(Math.random() * 6000);
    const m = this.m;
    m.world?.dropItem?.({ id: itemId('egg'), count: 1 }, m.x, m.y + 0.2, m.z);
  }
}

// ---------------------------------------------------------------- horses

/** An untamed horse that is ridden bucks its rider off after a while; temper grows each time (taming). */
export class HorseRiddenGoal implements Goal {
  readonly flags = FLAG.MOVE | FLAG.LOOK | FLAG.JUMP;
  constructor(private readonly m: Mob) {}
  canUse(): boolean { return this.m.rider !== null; }
  start(): void { this.m.nav.stop(); }
}

