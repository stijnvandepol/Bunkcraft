import { ITEM, type ItemStack, cloneStack, getItemDef, sameItem } from '../items/ItemRegistry';
import { BLOCK } from '../world/BlockRegistry';
import { Arrow, type ArrowTarget } from './Arrow';
import { Entity } from './Entity';
import { ItemEntity } from './ItemEntity';
import { Mob, type MobEvents, type MobTarget, type MobWorld } from './Mob';
import { initMob } from './MobInit';
import { MOB_TYPES, type MobKind } from './MobTypes';
import { MobSpawner, SPAWN, hostileDespawns } from './MobSpawner';
import { PrimedTnt, TNT_FUSE } from './PrimedTnt';
import { XpOrb, mergeOrbs } from './XpOrb';
import { mobXp, splitXp } from '../player/Experience';
import { lootingExtra } from '../items/EnchantRules';

const MAX_ITEMS = 160;
const MAX_ARROWS = 128;
const MAX_ORBS = 160;
/** Raw meat a burning animal drops cooked (Minecraft). */
const COOKED: Record<number, number> = {
  [ITEM.PORKCHOP]: ITEM.COOKED_PORKCHOP, [ITEM.BEEF]: ITEM.STEAK, [ITEM.MUTTON]: ITEM.COOKED_MUTTON, [ITEM.CHICKEN]: ITEM.COOKED_CHICKEN,
};

/** What entities need from a world: the client's World and the server's ServerWorld both fit. */
export interface EntityWorld {
  getBlock(x: number, y: number, z: number): number;
  /** Block state byte (slabs, stairs and doors collide with their real shape). */
  getMeta?(x: number, y: number, z: number): number;
  /** Sky light only (cheaper than getLight where block light needs a search). */
  getSkyLight?(x: number, y: number, z: number): number;
  /** Packed light (sky << 4 | block). */
  getLight(x: number, y: number, z: number): number;
  /** Block change by a mob (sheep grazing); returns false when refused. */
  setBlock?(x: number, y: number, z: number, id: number, meta?: number): unknown;
  /** Biome id of a column (client World and ServerWorld). */
  biomeName?(x: number, z: number): number;
}

/** A freshly generated chunk, as far as passive spawning cares. */
export interface ChunkLike {
  key: number;
  cx: number;
  cz: number;
  blocks: Uint8Array | null;
}

export interface PickupHandler {
  /** Try to give the stack to the player; returns how many items were NOT taken. */
  (stack: ItemStack): number;
}

/**
 * Owns all mobs and dropped items. Ticked at 20 Hz; rendering interpolates between
 * ticks. Passive mobs spawn in groups when a grassy chunk generates (like Minecraft's
 * chunk-generation spawns); hostile mobs spawn in darkness around the player.
 */
export class EntityManager implements MobWorld {
  readonly mobs: Mob[] = [];
  readonly items: ItemEntity[] = [];
  readonly tnt: PrimedTnt[] = [];
  readonly arrows: Arrow[] = [];
  /** Experience orbs (local ones and, in multiplayer, mirrors of the server's). */
  readonly orbs: XpOrb[] = [];
  /** Gives the player the experience of a local orb it touched (null = nobody collects: the server). */
  xpPickup: ((value: number) => void) | null = null;
  /** Multiplayer client: asks the server for a nearby server orb. */
  xpTakeHook: ((orb: XpOrb) => void) | null = null;
  /**
   * All players the mobs may target (multiplayer server). Empty = the single `target`
   * passed to tick(). Each mob and arrow picks the nearest one.
   */
  targets: MobTarget[] = [];
  /** Multiplayer client: intercepts local drops and sends them to the server (true = handled). */
  dropHook: ((stack: ItemStack, x: number, y: number, z: number, pickupDelay: number, throwYaw: number | undefined) => boolean) | null = null;
  /** Multiplayer client: asks the server for a nearby dropped item. */
  takeHook: ((item: ItemEntity) => void) | null = null;
  private nextNetId = 1;
  private events: MobEvents | null = null;
  private readonly single: MobTarget[] = [];
  private readonly arrowTarget: ArrowTarget = { x: 0, y: 0, z: 0, attackable: false };
  private readonly spawnedChunks = new Set<number>();
  private tickCount = 0;
  hostileSpawning = true;
  /** MobWorld: ticks simulated so far and the path searches left this tick. */
  time = 0;
  pathBudget = 0;
  /** Path searches allowed per tick for all mobs together (each costs up to ~0.1 ms). */
  static PATHS_PER_TICK = 6;
  /** Server: a block a mob changed must reach the clients. */
  blockHook: ((x: number, y: number, z: number, id: number) => void) | null = null;
  private dayBright = false;
  /** Who hit which player last: player id → mob and tick (tamed wolves defend their owner). */
  private readonly playerAttackers = new Map<number, { mob: Mob; time: number }>();
  private wrappedFor: MobEvents | null = null;
  private wrapped: MobEvents | null = null;
  /** Peaceful difficulty: hostile mobs are removed and do not spawn. */
  peaceful = false;
  /** The doMobSpawning game rule: false stops the natural top-up spawning (chunk generation herds stay). */
  spawningEnabled = true;
  /** Multiplayer v1 is peaceful: mobs are not yet simulated by the server. */
  passiveSpawning = true;

  private readonly spawner: MobSpawner;

  constructor(readonly world: EntityWorld, seed: number) {
    this.spawner = new MobSpawner(this, seed);
  }

  private readonly getBlock = (x: number, y: number, z: number) => this.world.getBlock(x, y, z);
  private readonly getMeta = (x: number, y: number, z: number) => this.world.getMeta!(x, y, z);

  clear(): void {
    this.mobs.length = 0;
    this.items.length = 0;
    this.tnt.length = 0;
    this.arrows.length = 0;
    this.orbs.length = 0;
    this.spawnedChunks.clear();
  }

  // ---------------------------------------------------------------- spawning

  spawnMob(kind: MobKind, x: number, y: number, z: number): Mob {
    const m = new Mob(MOB_TYPES[kind]);
    m.setPosition(x, y, z);
    m.netId = this.nextNetId++;
    m.world = this;
    initMob(m);
    this.mobs.push(m);
    return m;
  }

  // ---------------------------------------------------------------- MobWorld

  sunlit(x: number, y: number, z: number): boolean {
    if (!this.dayBright) return false;
    const bx = Math.floor(x), by = Math.floor(y), bz = Math.floor(z);
    return (this.world.getSkyLight ? this.world.getSkyLight(bx, by, bz) : this.world.getLight(bx, by, bz) >> 4) > 11;
  }

  setBlock(x: number, y: number, z: number, id: number): boolean {
    if (!this.world.setBlock) return false;
    const r = this.world.setBlock(x, y, z, id, 0);
    if (r === false || r === -1) return false;
    this.blockHook?.(x, y, z, id);
    return true;
  }

  biomeAt(x: number, z: number): number {
    return this.world.biomeName ? this.world.biomeName(Math.floor(x), Math.floor(z)) : -1;
  }

  lastAttackerOf(playerId: number): Mob | null {
    const e = this.playerAttackers.get(playerId);
    return e && this.time - e.time < 100 && !e.mob.dead && !e.mob.removed ? e.mob : null;
  }

  /** The events with the melee hook that remembers who hit which player. */
  private wrapEvents(events: MobEvents): MobEvents {
    if (this.wrappedFor === events && this.wrapped) return this.wrapped;
    const log = this.playerAttackers;
    this.wrappedFor = events;
    this.wrapped = {
      ...events,
      attack: (mob, damage, target) => {
        log.set(target.id ?? 0, { mob, time: this.time });
        events.attack(mob, damage, target);
      },
      // Breeding XP becomes experience orbs (singleplayer and server alike).
      xp: events.xp ?? ((x, y, z, amount) => this.spawnXp(x, y, z, amount)),
    };
    return this.wrapped;
  }

  /** @param force ignore the entity cap (death drops must never vanish). */
  dropItem(stack: ItemStack, x: number, y: number, z: number, pickupDelay = 10, throwYaw?: number, force = false): void {
    if (stack.count <= 0 || (!force && this.items.length >= MAX_ITEMS)) return;
    if (this.dropHook?.(stack, x, y, z, pickupDelay, throwYaw)) return;
    const e = new ItemEntity(cloneStack(stack), pickupDelay);
    e.setPosition(x, y, z);
    e.netId = this.nextNetId++;
    if (throwYaw !== undefined) {
      e.vx = -Math.sin(throwYaw) * 5;
      e.vz = -Math.cos(throwYaw) * 5;
      e.vy = 3;
    } else {
      e.vx = (Math.random() - 0.5) * 3;
      e.vz = (Math.random() - 0.5) * 3;
      e.vy = 3 + Math.random() * 2;
    }
    this.items.push(e);
  }

  /**
   * Spawns `amount` experience as orbs (split into Minecraft's orb values) with a small random hop. Used for mob kills,
   * ores, smelting (see `awardXp`), the grindstone and death drops.
   */
  spawnXp(x: number, y: number, z: number, amount: number): void {
    if (!(amount > 0)) return;
    for (const value of splitXp(amount)) {
      if (this.orbs.length >= MAX_ORBS) {
        // Full: the value goes into the nearest orb instead of being lost.
        let best: XpOrb | null = null, bd = Infinity;
        for (const o of this.orbs) {
          if (o.removed || o.remote) continue;
          const d = Math.hypot(o.x - x, o.y - y, o.z - z);
          if (d < bd) { bd = d; best = o; }
        }
        if (best) { best.value += value; continue; }
      }
      const o = new XpOrb(value);
      o.setPosition(x, y, z);
      o.netId = this.nextNetId++;
      o.vx = (Math.random() - 0.5) * 2.5;
      o.vz = (Math.random() - 0.5) * 2.5;
      o.vy = 2 + Math.random() * 2;
      this.orbs.push(o);
    }
  }

  /** Lights TNT at a block position (the block itself must already be removed). */
  primeTnt(x: number, y: number, z: number, fuse = TNT_FUSE): PrimedTnt {
    const t = new PrimedTnt(fuse);
    t.setPosition(x + 0.5, y, z + 0.5);
    t.netId = this.nextNetId++;
    this.tnt.push(t);
    return t;
  }

  /**
   * Fires an arrow (Minecraft's Projectile.shoot): direction plus gaussian spread of
   * 0.0075 × inaccuracy, scaled to `speed` blocks per tick.
   */
  shootArrow(x: number, y: number, z: number, dx: number, dy: number, dz: number, speed: number, inaccuracy: number,
    shooter: Mob | null, fromPlayer: boolean, crit: boolean, pickup: boolean): Arrow | null {
    if (this.arrows.length >= MAX_ARROWS) {
      // Oldest stuck arrow makes room.
      const i = this.arrows.findIndex((a) => a.inGround);
      if (i < 0) return null;
      this.arrows.splice(i, 1);
    }
    const len = Math.hypot(dx, dy, dz) || 1;
    const spread = 0.0075 * inaccuracy;
    const a = new Arrow(shooter, fromPlayer, crit, pickup);
    a.netId = this.nextNetId++;
    a.setPosition(x, y, z);
    a.vx = (dx / len + gaussian() * spread) * speed;
    a.vy = (dy / len + gaussian() * spread) * speed;
    a.vz = (dz / len + gaussian() * spread) * speed;
    this.arrows.push(a);
    return a;
  }

  /** Skeleton shot at the player (Normal difficulty: speed 1.6, inaccuracy 6). */
  skeletonShoot(mob: Mob, tx: number, ty: number, tz: number): void {
    const sy = mob.y + mob.height * 0.85 - 0.1;
    const dx = tx - mob.x, dz = tz - mob.z;
    const dy = ty + 0.6 - sy; // aim at a third of the player's height
    this.shootArrow(mob.x, sy, mob.z, dx, dy + Math.hypot(dx, dz) * 0.2, dz, 1.6, 6, mob, false, false, false);
  }

  /** Seeded animal herd for a freshly loaded chunk (grass surface). */
  onChunkReady(chunk: ChunkLike): void {
    if (!this.passiveSpawning || this.spawnedChunks.has(chunk.key) || !chunk.blocks) return;
    this.spawnedChunks.add(chunk.key);
    this.spawner.recount();
    this.spawner.onChunkReady(chunk);
  }

  /** Despawn passive mobs whose chunk unloaded (they respawn from the seed next time). */
  onChunkUnloaded(key: number): void {
    this.spawnedChunks.delete(key);
    for (const m of this.mobs) if (m.homeChunk === key && !m.persistent) m.removed = true;
  }

  // ---------------------------------------------------------------- per tick

  /**
   * @param darkness how much sky light is reduced (0 at noon, 11 at midnight)
   * @param pickup   gives a dropped stack to the player (null when the player can't pick up)
   */
  tick(target: MobTarget, darkness: number, events: MobEvents, pickup: PickupHandler | null, dayBright: boolean): void {
    this.tickCount++;
    this.time = this.tickCount;
    this.pathBudget = EntityManager.PATHS_PER_TICK;
    this.dayBright = dayBright;
    events = this.wrapEvents(events);
    this.events = events;
    Entity.metaGetter = this.world.getMeta ? this.getMeta : null;
    const getBlock = this.getBlock;
    let targets = this.targets;
    if (targets.length === 0) {
      this.single[0] = target;
      targets = this.single;
    }

    if ((this.hostileSpawning || this.passiveSpawning) && this.spawningEnabled) {
      this.spawner.recount();
      if (this.hostileSpawning && !this.peaceful) this.spawner.tickHostile(targets, darkness);
      if (this.passiveSpawning) this.spawner.tickPassive(targets, darkness, this.tickCount);
    }

    for (const m of this.mobs) {
      if (m.removed || m.remote) continue;
      if (this.peaceful && m.type.hostile) { m.removed = true; continue; }
      // Each mob follows the nearest player.
      let nearest = targets[0], d = Infinity;
      for (const t of targets) {
        const dt = Math.hypot(m.x - t.x, m.z - t.z);
        if (dt < d) { d = dt; nearest = t; }
      }
      // Hostiles despawn far away (instantly > 128, randomly > 32 blocks), and out-of-reach ones in the open fade away in daylight.
      if (m.type.hostile && !m.persistent && !m.dead && (hostileDespawns(d, Math.random()) || (dayBright && d > SPAWN.randomDespawn && Math.random() < SPAWN.daylightDespawnChance
        && this.skyAt(m) > 11))) { m.removed = true; continue; }
      if (getBlock(Math.floor(m.x), Math.floor(m.y), Math.floor(m.z)) === BLOCK.UNLOADED) continue; // frozen until loaded
      if (m.type.neutralInLight) {
        // Spiders turn neutral above light level 11 (Minecraft: brightness > 0.5).
        const light = this.world.getLight(Math.floor(m.x), Math.floor(m.y + 0.5), Math.floor(m.z));
        m.calm = Math.max((light >> 4) - darkness, light & 15) >= 12;
      }
      m.tick(getBlock, nearest, events);
      // Zombies and skeletons burn in daylight when they can see the sky.
      if (m.type.burnsInDaylight && dayBright && !m.inWater && !m.dead) {
        if (this.skyAt(m) > 11) {
          m.burning = 20;
          if (this.tickCount % 20 === 0) m.hurt(1, m.x, m.z, 0);
        }
      }
      if (m.burning > 0) m.burning--;
      if (m.inLava && this.tickCount % 10 === 0) m.hurt(4, m.x, m.z, 0);
      // Set on fire (Fire Aspect, Flame): 1 damage a second until it runs out or the mob reaches water.
      if (m.igniteTicks > 0) {
        if (m.inWater) m.igniteTicks = 0;
        else {
          m.igniteTicks--;
          m.burning = Math.max(m.burning, 2);
          if (m.igniteTicks % 20 === 0 && !m.dead) m.hurt(1, m.x, m.z, 0, m.hurtByPlayer > 0);
        }
      }
      if (m.dead && m.deathTime === 1) {
        const byPlayer = m.hurtByPlayer > 0;
        const onFire = m.burning > 0 || m.igniteTicks > 0;
        // Babies drop nothing and give no XP (Minecraft), big slimes split into 2-4 smaller ones.
        if (!m.baby) {
          for (const s of m.type.drops(byPlayer, m)) {
            // Looting adds up to its level to every drop; burning animals drop cooked meat.
            if (byPlayer && m.looting > 0) s.count += lootingExtra(m.looting);
            if (onFire && COOKED[s.id]) s.id = COOKED[s.id];
            this.dropItem(s, m.x, m.y + 0.5, m.z);
          }
          if (byPlayer) this.spawnXp(m.x, m.y + 0.5, m.z, mobXp(m.type.kind, m.type.hostile));
        }
        if (m.type.kind === 'slime' && m.size > 1) this.splitSlime(m);
        events.sound(m, 'death');
        if (m.hurtByPlayer > 0) events.killed(m);
      }
    }

    for (let i = 0; i < this.tnt.length; i++) {
      const t = this.tnt[i];
      if (!t.removed && !t.remote && t.tick(getBlock)) events.tntExplode(t);
    }

    const at = this.arrowTarget;
    for (let i = 0; i < this.arrows.length; i++) {
      const a = this.arrows[i];
      if (a.removed || a.remote) continue;
      let hit = targets[0], hd = Infinity;
      for (const t of targets) {
        const dt = Math.hypot(a.x - t.x, a.z - t.z);
        if (dt < hd) { hd = dt; hit = t; }
      }
      at.x = hit.x; at.y = hit.y; at.z = hit.z; at.attackable = hit.attackable; at.id = hit.id;
      a.tick(getBlock, this.mobs, at, this.onArrowHitMob, this.onArrowHitPlayer, this.onArrowLand);
      // Stuck player arrows can be picked up again (survival).
      if (a.inGround && a.pickup && pickup && Math.abs(a.x - target.x) < 1.3 && Math.abs(a.z - target.z) < 1.3
        && a.y > target.y - 0.5 && a.y < target.y + 2.3 && pickup({ id: ITEM.ARROW, count: 1 }) === 0) a.removed = true;
    }

    for (const it of this.items) {
      if (it.removed) continue;
      if (it.remote) {
        // Server item: ask for it when close; the server decides who gets it.
        if (this.takeHook && it.pickupDelay <= 0 && Math.abs(target.x - it.x) < 1.3 && Math.abs(target.z - it.z) < 1.3
          && Math.abs(target.y + 0.8 - it.y) < 1.5) this.takeHook(it);
        continue;
      }
      it.tick(getBlock);
      if (!pickup || it.pickupDelay > 0) continue;
      // Pickup box: player AABB grown by 1 horizontally; items are pulled in first.
      const dx = target.x - it.x, dy = target.y + 0.8 - it.y, dz = target.z - it.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist < 1.8) {
        it.vx += dx * 0.8; it.vy += dy * 0.8; it.vz += dz * 0.8;
        if (dist < 0.9) {
          const left = pickup(it.stack);
          if (left === 0) it.removed = true;
          else it.stack.count = left;
        }
      }
    }
    // Merge nearby identical stacks (fewer entities, like Minecraft).
    if (this.tickCount % 10 === 0) this.mergeItems();

    for (const o of this.orbs) {
      if (o.removed) continue;
      if (o.remote) {
        if (this.xpTakeHook && o.canPickUp(target.x, target.y, target.z)) this.xpTakeHook(o);
        continue;
      }
      // Each orb flies to the nearest player within range (the player, or every player on a server).
      let goal: MobTarget | null = null, gd = Infinity;
      for (const t of targets) {
        if (t.collects === false) continue;
        const d = Math.hypot(t.x - o.x, t.y - o.y, t.z - o.z);
        if (d < gd) { gd = d; goal = t; }
      }
      o.tick(getBlock, goal);
      if (this.xpPickup && goal === targets[0] && o.canPickUp(target.x, target.y, target.z) && o.age > 2) {
        this.xpPickup(o.value);
        o.removed = true;
      }
    }
    if (this.tickCount % 5 === 0) mergeOrbs(this.orbs);

    this.compact();
  }

  private splitSlime(m: Mob): void {
    const n = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) {
      const c = this.spawnMob('slime', m.x + (Math.random() - 0.5) * m.width, m.y + 0.2, m.z + (Math.random() - 0.5) * m.width);
      c.size = m.size / 2;
      c.refreshSize();
      c.health = c.maxHp = c.size * c.size;
      c.persistent = m.persistent;
    }
  }

  /** Sky light at a mob's head. */
  private skyAt(m: Mob): number {
    const bx = Math.floor(m.x), by = Math.floor(m.y + 1.6), bz = Math.floor(m.z);
    return this.world.getSkyLight ? this.world.getSkyLight(bx, by, bz) : this.world.getLight(bx, by, bz) >> 4;
  }

  private readonly onArrowHitMob = (a: Arrow, m: Mob, damage: number): void => {
    // Knockback along the arrow's flight direction.
    if (a.fromPlayer && a.flame) m.igniteTicks = Math.max(m.igniteTicks, 100);
    if (m.hurt(damage, a.x - a.vx * 4, a.z - a.vz * 4, 0.5 + a.punch, a.fromPlayer)) this.events?.sound(m, 'hurt');
    this.events?.arrowImpact(a);
    if (a.fromPlayer) this.events?.playerArrowHit();
  };

  private readonly onArrowHitPlayer = (a: Arrow, damage: number): void => {
    this.events?.arrowHit(a, damage, this.arrowTarget.id);
  };

  private readonly onArrowLand = (a: Arrow): void => {
    this.events?.arrowImpact(a);
  };

  private mergeItems(): void {
    const items = this.items;
    for (let i = 0; i < items.length; i++) {
      const a = items[i];
      if (a.removed) continue;
      for (let j = i + 1; j < items.length; j++) {
        const b = items[j];
        if (b.removed || a.remote || b.remote || !sameItem(a.stack, b.stack) || a.stack.damage || b.stack.damage) continue;
        if (Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.z - b.z) < 0.5 && a.stack.count + b.stack.count <= (getItemDef(a.stack.id)?.maxStack ?? 64)) {
          a.stack.count += b.stack.count;
          b.removed = true;
        }
      }
    }
  }

  private compact(): void {
    for (let i = this.mobs.length - 1; i >= 0; i--) if (this.mobs[i].removed) this.mobs.splice(i, 1);
    for (let i = this.items.length - 1; i >= 0; i--) if (this.items[i].removed) this.items.splice(i, 1);
    for (let i = this.tnt.length - 1; i >= 0; i--) if (this.tnt[i].removed) this.tnt.splice(i, 1);
    for (let i = this.arrows.length - 1; i >= 0; i--) if (this.arrows[i].removed) this.arrows.splice(i, 1);
    for (let i = this.orbs.length - 1; i >= 0; i--) if (this.orbs[i].removed) this.orbs.splice(i, 1);
  }

  /** Nearest living mob hit by a ray, with distance. */
  raycastMob(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, max: number): { mob: Mob; distance: number } | null {
    let best: Mob | null = null;
    let bestD = max;
    for (const m of this.mobs) {
      if (m.dead || m.removed) continue;
      const d = m.rayHit(ox, oy, oz, dx, dy, dz, bestD);
      if (d < bestD) { bestD = d; best = m; }
    }
    return best ? { mob: best, distance: bestD } : null;
  }
}

/** Standard normal sample (Box–Muller), like java.util.Random#nextGaussian. */
function gaussian(): number {
  let u = 0;
  while (u === 0) u = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
}
