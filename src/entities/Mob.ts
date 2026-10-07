import type { BlockGetter } from '../player/Collision';
import type { ItemStack } from '../items/ItemRegistry';
import { type DamageSource, type DamageTarget, dealDamage } from '../player/Damage';
import { OPAQUE, PARTIAL, SOLID } from '../world/BlockRegistry';
import { collisionBoxes } from '../world/BlockShapes';
import { Entity } from './Entity';
import type { MobKind, MobType } from './MobTypes';
import type { Arrow } from './Arrow';
import type { PrimedTnt } from './PrimedTnt';
import { GoalSelector } from './ai/Goal';
import { Navigator } from './ai/Navigator';
import { setupBrain } from './ai/brains';
import { canTrample } from '../world/Farming';

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
  /** Item id in the player's hand (animals follow breeding food). */
  held?: number;
  /** View direction (endermen notice being stared at). */
  yaw?: number;
  pitch?: number;
  /** Experience orbs fly to this player (false for spectators). */
  collects?: boolean;
}

/** Something a mob can chase or fight: a player or another mob. */
export type AiTarget = Mob | MobTarget;

export function isMob(t: AiTarget): t is Mob {
  return (t as Mob).type !== undefined;
}

export type MobSound = 'idle' | 'hurt' | 'death' | 'fuse' | 'angry' | 'teleport';
/** Visual feedback a mob asks the client for (hearts, smoke, angry cloud...). */
export type MobFx = 'love' | 'smoke' | 'angry' | 'tame' | 'poof';

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
  sound(mob: Mob, kind: MobSound): void;
  /** Hearts, smoke and so on (optional: tests and headless hosts skip it). */
  fx?(mob: Mob, kind: MobFx): void;
  /** Experience orbs: breeding gives 1-7 XP. TODO: forward to the XP system (`awardXp`) once it exists. */
  xp?(x: number, y: number, z: number, amount: number): void;
  /** A witch throws a potion at the player (poison or slowness; effects module pending). */
  potion?(mob: Mob, target: MobTarget): void;
}

/** What goals need from the world around a mob: the other mobs, the players and a few services. */
export interface MobWorld {
  readonly mobs: readonly Mob[];
  readonly targets: readonly MobTarget[];
  /** Ticks since the world started simulating. */
  time: number;
  /** Path searches still allowed this tick (reset by the manager; keeps a crowd of mobs cheap). */
  pathBudget: number;
  /**
   * A* nodes still allowed this tick (reset by the manager). A search only starts when its whole node cap fits, so the
   * path finding of one tick never exceeds this however the searches fall. Absent = no node limit.
   */
  pathNodeBudget?: number;
  spawnMob(kind: MobKind, x: number, y: number, z: number): Mob;
  /** Whether direct sunlight reaches this point right now (daytime and open sky). */
  sunlit(x: number, y: number, z: number): boolean;
  /** Changes a block (sheep eating grass, endermen); false when refused. */
  setBlock?(x: number, y: number, z: number, id: number): boolean;
  /** Biome id at a column, if the world knows. */
  biomeAt?(x: number, z: number): number;
  /** Mob that hit this player during the last few seconds (tamed wolves defend their owner). */
  lastAttackerOf?(playerId: number): Mob | null;
  /** Drops an item into the world (eggs, wool). */
  dropItem?(stack: ItemStack, x: number, y: number, z: number): void;
  /** A mob landed at its feet position after falling `fall` blocks: farmland under it may turn into dirt. */
  trample?(x: number, y: number, z: number, fall: number): void;
}

/** Ticks of love mode, breeding cooldown and growth of a baby (Minecraft Java 1.21). */
export const LOVE_TICKS = 600;
export const BREED_COOLDOWN = 6000;
export const BABY_AGE = -24000;

/**
 * A mob with Minecraft-style goal AI (see `ai/`): every kind registers prioritised goals (wander, panic, tempt, breed,
 * chase, shoot...) in `setupBrain`; `tick` runs the target selector and the goal selector, then the move and look
 * controls and finally the physics. Steering towards the move target is the old greedy code; routes around obstacles
 * come from the navigator's A*.
 */
/** Natural armor points of mobs (Minecraft: zombies 2). */
const NATURAL_ARMOR: Partial<Record<string, number>> = { zombie: 2 };

export class Mob extends Entity implements DamageTarget {
  health: number;
  hurtTime = 0;
  /** DamageTarget (Damage.ts): the hurt timer doubles as the 10 tick invulnerability frames. */
  absorption = 0;
  lastDamage = 0;
  armorPoints = 0;
  armorToughness = 0;
  get invulnerableTicks(): number { return this.hurtTime; }
  set invulnerableTicks(v: number) { this.hurtTime = v; }
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
  /** Attacked: neutral mobs (spiders, wolves, endermen) stay hostile. */
  provoked = false;
  /** Ticks since the player last hurt this mob (player-kill drops). */
  hurtByPlayer = 0;
  /** Ticks of fire left from Fire Aspect or a Flame arrow (1 damage a second). */
  igniteTicks = 0;
  /** Looting level of the last player weapon that hit it (extra drops). */
  looting = 0;
  /** Bow draw progress in ticks (skeleton). */
  aimTicks = 0;
  age = 0;

  // ---- AI
  world: MobWorld | null = null;
  getBlock: BlockGetter = () => 0;
  /** The player this mob is nearest to (set every tick). */
  player: MobTarget = { x: 0, y: 0, z: 0, attackable: false };
  events: MobEvents | null = null;
  target: AiTarget | null = null;
  attackCooldown = 0;
  /** Ticks of panic left (set by hurt() for animals that flee). */
  panic = 0;
  readonly nav = new Navigator(this);
  readonly goals = new GoalSelector();
  readonly targetGoals = new GoalSelector();
  private brainReady = false;
  private idleSound = Math.random() * 200;
  /** Move control: the point to walk to and the speed in blocks per second (negative = back away). */
  moveX = 0; moveZ = 0; moveSpeed = 0;
  /** A goal wants a jump this tick (swimming, slime hops). */
  wantJump = false;
  private lookActive = false;
  private lookX = 0; private lookY = 0; private lookZ = 0;

  // ---- breeding and growth
  /** Ticks of love mode left (hearts; looks for a partner). */
  inLove = 0;
  breedCooldown = 0;
  /** Negative = baby, counts up to 0 (−24000 ticks = 20 minutes). */
  growingAge = 0;
  /** Kind-specific state: sheep colour (bits 0-3, bit 4 sheared), slime size, wolf collar colour, horse coat. */
  variant = 0;
  /** Slime size 1/2/4 (also scales the hitbox). */
  size = 1;

  // ---- taming
  /** Player id of the owner (0 = the singleplayer player, −1 = untamed). */
  ownerId = -1;
  sitting = false;
  /** Ticks of anger left (wolves, endermen). */
  angryTicks = 0;
  /** Busy animation: sheep eating grass (ticks left), enderman screaming. */
  busy = 0;
  /** Saddle on (horses, pigs). */
  saddled = false;
  /** Player id of the last player who hurt this mob (wolves join their owner's fights). */
  hurtByPlayerId = -1;
  /** Enderman: teleport away on the next tick (after damage). */
  pendingTeleport = false;
  /** Horse temper 0..100: every failed taming ride adds 5 (Minecraft). */
  temper = 0;
  /** Horse stats rolled at spawn: speed in blocks/s and jump launch speed. */
  rideSpeed = 0;
  rideJumpSpeed = 0;
  /** Rider input for this tick (set by the game while mounted). */
  rideForward = 0;
  rideStrafe = 0;
  rideYaw = 0;
  rideJump = false;
  /** A player rides this mob (horses). */
  rider: MobTarget | null = null;

  /** Maximum health: the type's, 40 for a tamed wolf, rolled per horse. */
  maxHp: number;

  constructor(readonly type: MobType) {
    super(type.width, type.height);
    this.health = type.health;
    this.maxHp = type.health;
    this.armorPoints = NATURAL_ARMOR[type.kind] ?? 0;
    this.yaw = Math.random() * Math.PI * 2;
    this.prevYaw = this.yaw;
  }

  get dead(): boolean {
    return this.health <= 0;
  }

  get baby(): boolean {
    return this.growingAge < 0;
  }

  get tamed(): boolean {
    return this.ownerId >= 0;
  }

  /** Whether love mode can start: an adult that is not cooling down. */
  get canBreed(): boolean {
    return this.growingAge >= 0 && this.breedCooldown <= 0 && this.inLove <= 0;
  }

  /** Model scale for rendering: babies are half size, slimes scale with their size, some types are small or tall. */
  get renderScale(): number {
    return (this.type.scale ?? 1) * (this.baby ? 0.5 : 1) * (this.type.kind === 'slime' ? this.size : 1);
  }

  setBaby(baby: boolean): void {
    this.growingAge = baby ? BABY_AGE : 0;
    this.refreshSize();
  }

  /** Recomputes the hitbox after a change of age or slime size. */
  refreshSize(): void {
    const t = this.type;
    if (t.kind === 'slime') {
      const w = 0.52 * this.size;
      this.width = w; this.height = w;
      return;
    }
    const s = this.baby ? 0.5 : 1;
    this.width = t.width * s;
    this.height = t.height * s;
  }

  /** Damage from the player, an arrow or an explosion; knockback away from (fromX, fromZ). */
  hurt(amount: number, fromX: number, fromZ: number, knockback = 1, byPlayer = false, source?: DamageSource, attacker: AiTarget | null = null): boolean {
    if (this.dead) return false;
    // Same pipeline as the player: invulnerability frames (a bigger hit still counts for the difference), armor, hooks.
    if (!dealDamage(this, source ?? { kind: byPlayer ? 'player' : 'generic', byPlayer }, amount).hurt) return false;
    if (byPlayer) {
      this.hurtByPlayer = 100;
      this.provoked = true;
    }
    if (attacker) {
      if (isMob(attacker)) { this.lastAttacker = attacker; this.lastHurtAge = this.age; }
      else if (byPlayer) this.hurtByPlayerId = attacker.id ?? 0;
    } else if (byPlayer) this.hurtByPlayerId = 0;
    if (this.type.kind === 'enderman' && Math.random() < 0.5) this.pendingTeleport = true;
    const dx = this.x - fromX, dz = this.z - fromZ;
    const d = Math.hypot(dx, dz) || 1;
    if (knockback > 0) {
      this.vx += (dx / d) * 6 * knockback;
      this.vz += (dz / d) * 6 * knockback;
      this.vy = 6;
    }
    if (this.type.flees) this.panic = 100;
    return true;
  }

  /** Last mob that hurt this one (wolves answer it) and when. */
  lastAttacker: Mob | null = null;
  lastHurtAge = -1000;

  /** Melee damage (Normal difficulty); slimes hit by size (big 4: 3, medium 2: 2, small 1: 0). */
  get attackDamage(): number {
    if (this.type.kind === 'slime') return this.size >= 4 ? 3 : this.size >= 2 ? 2 : 0;
    return this.type.attack;
  }

  /** Sets where to walk this tick (the navigator and direct goals call it). */
  setMove(x: number, z: number, speed: number): void {
    this.moveX = x; this.moveZ = z; this.moveSpeed = speed;
  }

  /** Look at a point this tick (head and, when far out of range, body follow). */
  lookAt(x: number, y: number, z: number): void {
    this.lookActive = true;
    this.lookX = x; this.lookY = y; this.lookZ = z;
  }

  /** Eye height above the feet. */
  get eyeHeight(): number {
    return this.height * 0.85;
  }

  /** Distance to a target in 3D (feet to feet, like the old hunting range). */
  distanceTo(t: AiTarget): number {
    return Math.hypot(t.x - this.x, t.y - this.y, t.z - this.z);
  }

  distanceToSq2D(x: number, z: number): number {
    const dx = x - this.x, dz = z - this.z;
    return dx * dx + dz * dz;
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
      if (this.brainReady) { this.goals.clear(); this.targetGoals.clear(); this.nav.stop(); }
      this.physicsTick(getBlock, false);
      return;
    }
    this.getBlock = getBlock;
    this.player = target;
    this.events = events;
    if (!this.brainReady) {
      this.brainReady = true;
      setupBrain(this);
    }
    if (this.attackCooldown > 0) this.attackCooldown--;
    if (this.inLove > 0) this.inLove--;
    if (this.breedCooldown > 0) this.breedCooldown--;
    if (this.growingAge < 0 && ++this.growingAge === 0) this.refreshSize();
    if (this.angryTicks > 0) this.angryTicks--;
    if (this.busy > 0) this.busy--;
    if (--this.idleSound <= 0) {
      this.idleSound = 160 + Math.random() * 240;
      events.sound(this, 'idle');
    }

    this.moveSpeed = 0;
    this.wantJump = false;
    this.lookActive = false;
    this.swimVy = null;
    if (this.target && isMob(this.target) && (this.target.dead || this.target.removed)) this.target = null;
    this.targetGoals.tick();
    this.goals.tick();
    this.nav.tick();
    this.applyLook();
    this.applyMove(getBlock);

    const t = this.type;
    this.physicsTick(getBlock, (this.moveSpeed > 0 || this.wantJump) && !t.climbs);
    // Spiders climb walls at 0.2 blocks/tick.
    if (t.climbs && this.moveSpeed > 0 && this.horizontalCollision) {
      this.vy = 4;
      this.fallDistance = 0;
    }

    // Limb swing from actual horizontal movement (Minecraft's limbSwing smoothing).
    const moved = Math.hypot(this.x - this.prevX, this.z - this.prevZ);
    this.limbAmount += (Math.min(1, moved * 4 * 4) - this.limbAmount) * 0.4;
    this.limbSwing += this.limbAmount;
  }

  /** Head follows the look target at a limited turn rate; the body follows when the head is out of range. */
  private applyLook(): void {
    if (!this.lookActive) {
      this.headYaw *= 0.9;
      this.headPitch *= 0.9;
      return;
    }
    const dx = this.lookX - this.x, dz = this.lookZ - this.z;
    let rel = Math.atan2(-dx, -dz) - this.yaw;
    rel = Math.atan2(Math.sin(rel), Math.cos(rel));
    const wantYaw = Math.max(-1.3, Math.min(1.3, rel));
    this.headYaw += Math.max(-0.4, Math.min(0.4, wantYaw - this.headYaw));
    const wantPitch = Math.atan2(this.lookY - (this.y + this.eyeHeight), Math.hypot(dx, dz)) * 0.6;
    this.headPitch += Math.max(-0.3, Math.min(0.3, wantPitch - this.headPitch));
    // Past 75° the body turns along (so a pig watching the player ends up facing him).
    if (this.moveSpeed === 0 && Math.abs(rel) > 1.3) this.yaw += Math.max(-0.2, Math.min(0.2, rel - Math.sign(rel) * 1.3));
  }

  /** Steering towards the move target: turn at a limited rate, accelerate along the facing direction. */
  private applyMove(getBlock: BlockGetter): void {
    const speed = this.moveSpeed;
    const dx = this.moveX - this.x, dz = this.moveZ - this.z;
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
    } else if (speed > 0 && dist > 0.12) {
      const want = Math.atan2(-dx, -dz);
      let diff = want - this.yaw;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      this.yaw += Math.max(-0.35, Math.min(0.35, diff));
      // Don't walk off ledges higher than 3 blocks unless chasing.
      const ax = this.x - Math.sin(this.yaw) * 0.8, az = this.z - Math.cos(this.yaw) * 0.8;
      const ground = this.groundBelow(getBlock, ax, az);
      if (ground > 3 && !this.target) {
        this.moveSpeed = 0;
        this.nav.stop();
      } else {
        const accel = this.onGround || this.inWater ? 0.45 : 0.08;
        this.vx += (-Math.sin(this.yaw) * speed - this.vx) * accel;
        this.vz += (-Math.cos(this.yaw) * speed - this.vz) * accel;
      }
    } else {
      this.moveSpeed = 0;
    }
  }

  /** Line of sight from the mob's eyes to the target's eyes (no attacks through walls, glass or closed doors). */
  canSee(getBlock: BlockGetter, t: AiTarget): boolean {
    const targetEye = isMob(t) ? t.y + t.eyeHeight : t.y + 1.62;
    return lineOfSight(getBlock, Entity.metaGetter, this.x, this.y + this.eyeHeight, this.z, t.x, targetEye, t.z);
  }

  private groundBelow(getBlock: BlockGetter, x: number, z: number): number {
    const bx = Math.floor(x), bz = Math.floor(z);
    for (let d = 0; d < 5; d++) {
      if (SOLID[getBlock(bx, Math.floor(this.y) - 1 - d, bz)]) return d;
    }
    return 5;
  }

  protected override onLand(fall: number): void {
    if (this.type.kind !== 'chicken' && this.type.kind !== 'cave_spider' && fall > 3) this.health -= Math.ceil(fall - 3);
    // Big mobs trample farmland (Minecraft: width² × height > 0.512, only while mobGriefing is on).
    if (fall > 0.5 && canTrample(this.width, this.height)) this.world?.trample?.(this.x, this.y, this.z, fall);
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
