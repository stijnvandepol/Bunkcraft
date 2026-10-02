import { ITEM, type ItemStack, getItemDef } from '../items/ItemRegistry';
import { BLOCK, OPAQUE, SOLID } from '../world/BlockRegistry';
import type { Chunk } from '../world/Chunk';
import { CHUNK_HEIGHT, blockIndex } from '../world/constants';
import { hash2, mulberry32 } from '../world/Noise';
import type { World } from '../world/World';
import { Arrow, type ArrowTarget } from './Arrow';
import { ItemEntity } from './ItemEntity';
import { Mob, type MobEvents, type MobTarget } from './Mob';
import { HOSTILE_KINDS, MOB_TYPES, type MobKind, PASSIVE_KINDS } from './MobTypes';
import { PrimedTnt, TNT_FUSE } from './PrimedTnt';

const MAX_PASSIVE = 24;
const MAX_HOSTILE = 16;
const MAX_ITEMS = 160;
const MAX_ARROWS = 128;

export interface PickupHandler {
  /** Try to give the stack to the player; returns how many items were NOT taken. */
  (stack: ItemStack): number;
}

/**
 * Owns all mobs and dropped items. Ticked at 20 Hz; rendering interpolates between
 * ticks. Passive mobs spawn in groups when a grassy chunk generates (like Minecraft's
 * chunk-generation spawns); hostile mobs spawn in darkness around the player.
 */
export class EntityManager {
  readonly mobs: Mob[] = [];
  readonly items: ItemEntity[] = [];
  readonly tnt: PrimedTnt[] = [];
  readonly arrows: Arrow[] = [];
  private events: MobEvents | null = null;
  private readonly arrowTarget: ArrowTarget = { x: 0, y: 0, z: 0, attackable: false };
  private readonly spawnedChunks = new Set<number>();
  private tickCount = 0;
  hostileSpawning = true;
  /** Multiplayer v1 is peaceful: mobs are not yet simulated by the server. */
  passiveSpawning = true;

  constructor(private readonly world: World, private readonly seed: number) {}

  private readonly getBlock = (x: number, y: number, z: number) => this.world.getBlock(x, y, z);

  clear(): void {
    this.mobs.length = 0;
    this.items.length = 0;
    this.tnt.length = 0;
    this.arrows.length = 0;
    this.spawnedChunks.clear();
  }

  // ---------------------------------------------------------------- spawning

  spawnMob(kind: MobKind, x: number, y: number, z: number): Mob {
    const m = new Mob(MOB_TYPES[kind]);
    m.setPosition(x, y, z);
    this.mobs.push(m);
    return m;
  }

  /** @param force ignore the entity cap (death drops must never vanish). */
  dropItem(stack: ItemStack, x: number, y: number, z: number, pickupDelay = 10, throwYaw?: number, force = false): void {
    if (stack.count <= 0 || (!force && this.items.length >= MAX_ITEMS)) return;
    const e = new ItemEntity({ ...stack }, pickupDelay);
    e.setPosition(x, y, z);
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

  /** Lights TNT at a block position (the block itself must already be removed). */
  primeTnt(x: number, y: number, z: number, fuse = TNT_FUSE): PrimedTnt {
    const t = new PrimedTnt(fuse);
    t.setPosition(x + 0.5, y, z + 0.5);
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

  /** Seeded passive group for a freshly loaded chunk (grass surface, daylight). */
  onChunkReady(chunk: Chunk): void {
    if (!this.passiveSpawning || this.spawnedChunks.has(chunk.key) || !chunk.blocks) return;
    this.spawnedChunks.add(chunk.key);
    const rand = mulberry32((hash2(this.seed ^ 0x51ed, chunk.cx, chunk.cz) * 4294967296) >>> 0);
    if (rand() > 0.12 || this.passiveCount() >= MAX_PASSIVE) return;
    const kind = PASSIVE_KINDS[Math.floor(rand() * PASSIVE_KINDS.length)];
    const group = 2 + Math.floor(rand() * 3);
    for (let i = 0; i < group; i++) {
      const lx = Math.floor(rand() * 16), lz = Math.floor(rand() * 16);
      for (let y = CHUNK_HEIGHT - 2; y > 0; y--) {
        const b = chunk.blocks[blockIndex(lx, y, lz)];
        if (b === 0) continue;
        if (b === BLOCK.GRASS && chunk.blocks[blockIndex(lx, y + 1, lz)] === 0) {
          const m = this.spawnMob(kind, chunk.cx * 16 + lx + 0.5, y + 1, chunk.cz * 16 + lz + 0.5);
          m.homeChunk = chunk.key;
        }
        break;
      }
    }
  }

  /** Despawn passive mobs whose chunk unloaded (they respawn from the seed next time). */
  onChunkUnloaded(key: number): void {
    this.spawnedChunks.delete(key);
    for (const m of this.mobs) if (m.homeChunk === key && !m.persistent) m.removed = true;
  }

  private passiveCount(): number {
    let n = 0;
    for (const m of this.mobs) if (!m.type.hostile) n++;
    return n;
  }

  /**
   * Minecraft-style hostile spawning: a random spot 24–48 blocks away with two blocks of
   * air above a solid block, block light 0 and (darkened) sky light ≤ random 0..7.
   */
  private trySpawnHostile(px: number, py: number, pz: number, darkness: number): void {
    let hostile = 0;
    for (const m of this.mobs) if (m.type.hostile) hostile++;
    if (hostile >= MAX_HOSTILE) return;
    const a = Math.random() * Math.PI * 2;
    const r = 24 + Math.random() * 24;
    const x = Math.floor(px + Math.cos(a) * r), z = Math.floor(pz + Math.sin(a) * r);
    const y = Math.floor(py + (Math.random() - 0.5) * 40);
    for (let dy = 0; dy < 16; dy++) {
      const yy = y - dy;
      if (yy < 2 || yy >= CHUNK_HEIGHT - 2) continue;
      const below = this.world.getBlock(x, yy - 1, z);
      if (!SOLID[below] || !OPAQUE[below] || below === BLOCK.UNLOADED) continue;
      if (this.world.getBlock(x, yy, z) !== 0 || this.world.getBlock(x, yy + 1, z) !== 0) continue;
      const light = this.world.getLight(x, yy, z);
      const sky = (light >> 4) - darkness;
      if ((light & 15) > 0 || sky > Math.floor(Math.random() * 8)) return;
      this.spawnMob(HOSTILE_KINDS[Math.floor(Math.random() * HOSTILE_KINDS.length)], x + 0.5, yy, z + 0.5);
      return;
    }
  }

  // ---------------------------------------------------------------- per tick

  /**
   * @param darkness how much sky light is reduced (0 at noon, 11 at midnight)
   * @param pickup   gives a dropped stack to the player (null when the player can't pick up)
   */
  tick(target: MobTarget, darkness: number, events: MobEvents, pickup: PickupHandler | null, dayBright: boolean): void {
    this.tickCount++;
    this.events = events;
    const getBlock = this.getBlock;

    if (this.hostileSpawning && this.tickCount % 20 === 0) this.trySpawnHostile(target.x, target.y, target.z, darkness);

    for (const m of this.mobs) {
      if (m.removed) continue;
      // Hostiles despawn far away (instantly > 128, randomly > 32 blocks).
      const d = Math.hypot(m.x - target.x, m.z - target.z);
      if (m.type.hostile && (d > 128 || (d > 32 && Math.random() < 1 / 800))) { m.removed = true; continue; }
      if (getBlock(Math.floor(m.x), Math.floor(m.y), Math.floor(m.z)) === BLOCK.UNLOADED) continue; // frozen until loaded
      if (m.type.neutralInLight) {
        // Spiders turn neutral above light level 11 (Minecraft: brightness > 0.5).
        const light = this.world.getLight(Math.floor(m.x), Math.floor(m.y + 0.5), Math.floor(m.z));
        m.calm = Math.max((light >> 4) - darkness, light & 15) >= 12;
      }
      m.tick(getBlock, target, events);
      // Zombies and skeletons burn in daylight when they can see the sky.
      if (m.type.burnsInDaylight && dayBright && !m.inWater && !m.dead) {
        const sky = this.world.getLight(Math.floor(m.x), Math.floor(m.y + 1.6), Math.floor(m.z)) >> 4;
        if (sky > 11) {
          m.burning = 20;
          if (this.tickCount % 20 === 0) m.hurt(1, m.x, m.z, 0);
        }
      }
      if (m.burning > 0) m.burning--;
      if (m.inLava && this.tickCount % 10 === 0) m.hurt(4, m.x, m.z, 0);
      if (m.dead && m.deathTime === 1) {
        for (const s of m.type.drops(m.hurtByPlayer > 0)) this.dropItem(s, m.x, m.y + 0.5, m.z);
        events.sound(m, 'death');
      }
    }

    for (let i = 0; i < this.tnt.length; i++) {
      const t = this.tnt[i];
      if (!t.removed && t.tick(getBlock)) events.tntExplode(t);
    }

    const at = this.arrowTarget;
    at.x = target.x; at.y = target.y; at.z = target.z; at.attackable = target.attackable;
    for (let i = 0; i < this.arrows.length; i++) {
      const a = this.arrows[i];
      if (a.removed) continue;
      a.tick(getBlock, this.mobs, at, this.onArrowHitMob, this.onArrowHitPlayer, this.onArrowLand);
      // Stuck player arrows can be picked up again (survival).
      if (a.inGround && a.pickup && pickup && Math.abs(a.x - target.x) < 1.3 && Math.abs(a.z - target.z) < 1.3
        && a.y > target.y - 0.5 && a.y < target.y + 2.3 && pickup({ id: ITEM.ARROW, count: 1 }) === 0) a.removed = true;
    }

    for (const it of this.items) {
      if (it.removed) continue;
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

    this.compact();
  }

  private readonly onArrowHitMob = (a: Arrow, m: Mob, damage: number): void => {
    // Knockback along the arrow's flight direction.
    if (m.hurt(damage, a.x - a.vx * 4, a.z - a.vz * 4, 0.5, a.fromPlayer)) this.events?.sound(m, 'hurt');
    this.events?.arrowImpact(a);
  };

  private readonly onArrowHitPlayer = (a: Arrow, damage: number): void => {
    this.events?.arrowHit(a, damage);
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
        if (b.removed || b.stack.id !== a.stack.id || a.stack.damage || b.stack.damage) continue;
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
