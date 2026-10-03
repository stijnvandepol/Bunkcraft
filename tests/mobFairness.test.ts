import { describe, expect, it } from 'vitest';
import { EntityManager, type EntityWorld } from '../src/entities/EntityManager';
import { Entity } from '../src/entities/Entity';
import { Mob, type MobEvents, type MobTarget, lineOfSight } from '../src/entities/Mob';
import { SPAWN, hostileCap } from '../src/entities/MobSpawner';
import { MOB_TYPES } from '../src/entities/MobTypes';
import { ITEM, getItemDef } from '../src/items/ItemRegistry';
import { PHYSICS } from '../src/player/Physics';
import { BLOCK } from '../src/world/BlockRegistry';
import { DOOR_OPEN_BIT, SLAB_BOTTOM } from '../src/world/BlockStates';
import { type EntityPlayer, ServerEntities } from '../server/ServerEntities';

/**
 * Early survival must be winnable bare-handed, like Minecraft: a bounded number of monsters, zombies that hit for 3
 * once a second, are slower than a walking player, and cannot hit through walls, glass or closed doors.
 */

/** Flat grass at y = 62 with sparse block overrides (and their states). */
class TestWorld implements EntityWorld {
  sky = 15;
  private readonly blocks = new Map<string, number>();
  private readonly metas = new Map<string, number>();
  set(x: number, y: number, z: number, id: number, meta = 0): void {
    this.blocks.set(`${x},${y},${z}`, id);
    this.metas.set(`${x},${y},${z}`, meta);
  }
  getBlock(x: number, y: number, z: number): number {
    const o = this.blocks.get(`${x},${y},${z}`);
    if (o !== undefined) return o;
    return y < 62 ? BLOCK.STONE : y === 62 ? BLOCK.GRASS : 0;
  }
  getMeta(x: number, y: number, z: number): number {
    return this.metas.get(`${x},${y},${z}`) ?? 0;
  }
  getLight(): number {
    return this.sky << 4;
  }
}

const noop = () => undefined;
function recorder() {
  const hits: number[] = [];
  const events: MobEvents = {
    attack: (_m, damage) => hits.push(damage), explode: noop, shoot: noop, arrowHit: noop, arrowImpact: noop,
    tntExplode: noop, killed: noop, playerArrowHit: noop, sound: noop,
  };
  return { hits, events };
}

/** Darkness passed by Game.gameTick at midnight: round((1 − dayFactor) × 11). */
const MIDNIGHT = 11;

describe('hostile cap', () => {
  it('singleplayer call pattern (one target, no `targets`) never exceeds the cap on any tick', () => {
    const world = new TestWorld();
    const em = new EntityManager(world, 42);
    const { events } = recorder();
    const target: MobTarget = { x: 0.5, y: 63, z: 0.5, attackable: true };
    let max = 0;
    // Three minutes at midnight while the player wanders.
    for (let t = 0; t < 3 * 60 * 20; t++) {
      target.x = 0.5 + Math.sin(t / 400) * 40;
      target.z = 0.5 + Math.cos(t / 400) * 40;
      em.tick(target, MIDNIGHT, events, null, false);
      let h = 0;
      for (const m of em.mobs) if (m.type.hostile && !m.removed) h++;
      if (h > max) max = h;
    }
    expect(max).toBeLessThanOrEqual(SPAWN.hostileCap);
    expect(max).toBeGreaterThan(SPAWN.hostileCap / 2);
  });

  it('the multiplayer server keeps one player at the same cap', () => {
    const host = { send: noop, broadcast: noop, broadcastBlock: noop, broadcastBlocks: noop, recordEdit: noop };
    const ents = new ServerEntities(777, {}, 'survival', host, () => 0.75);
    const player: EntityPlayer = { id: 1, x: 0.5, y: 120, z: 0.5, flags: 0, held: 0, hasPos: true };
    let max = 0;
    for (let t = 0; t < 1200; t++) {
      ents.tick([player]);
      max = Math.max(max, ents.manager.mobs.filter((m) => m.type.hostile && !m.removed).length);
    }
    expect(max).toBeLessThanOrEqual(hostileCap(1, MIDNIGHT));
  });
});

describe('zombie melee', () => {
  it('hits for 3 (Normal) at most once per 20 ticks', () => {
    const world = new TestWorld();
    const { hits, events } = recorder();
    const z = new Mob(MOB_TYPES.zombie);
    z.setPosition(2.5, 63, 0.5);
    const target: MobTarget = { x: 3.9, y: 63, z: 0.5, attackable: true };
    for (let t = 0; t < 200; t++) z.tick((x, y, zz) => world.getBlock(x, y, zz), target, events);
    expect(MOB_TYPES.zombie.attack).toBe(3);
    expect(hits.length).toBe(10);
    expect(hits.every((d) => d === 3)).toBe(true);
  });

  it.each([
    ['open air (control)', 0, 0, 10],
    ['stone wall', BLOCK.STONE, 0, 0],
    ['glass wall', BLOCK.GLASS, 0, 0],
    ['glass pane', BLOCK.GLASS_PANE, 0, 0],
    ['closed door', BLOCK.DOOR, 2, 0],
  ])('hits through %s: %i times in 10 s', (_name, id, meta, expected) => {
    const world = new TestWorld();
    for (let y = 63; y < 66; y++) for (let zz = -2; zz <= 2; zz++) world.set(3, y, zz, id, meta);
    const { hits, events } = recorder();
    const z = new Mob(MOB_TYPES.zombie);
    z.setPosition(2.5, 63, 0.5);
    const target: MobTarget = { x: 4.35, y: 63, z: 0.5, attackable: true };
    Entity.metaGetter = (x, y, zz) => world.getMeta(x, y, zz);
    try {
      for (let t = 0; t < 200; t++) z.tick((x, y, zz) => world.getBlock(x, y, zz), target, events);
    } finally {
      Entity.metaGetter = null;
    }
    expect(hits.length).toBe(expected);
  });

  it('line of sight follows collision shapes: an open door and the empty half of a slab do not block', () => {
    const world = new TestWorld();
    const gb = (x: number, y: number, z: number) => world.getBlock(x, y, z);
    const gm = (x: number, y: number, z: number) => world.getMeta(x, y, z);
    // A door facing west (box on the x 13..16 side) blocks a ray along x when closed, not when open (swung to a z side).
    world.set(3, 64, 0, BLOCK.DOOR, 2);
    expect(lineOfSight(gb, gm, 0.5, 64.5, 0.5, 6.5, 64.5, 0.5)).toBe(false);
    world.set(3, 64, 0, BLOCK.DOOR, 2 | DOOR_OPEN_BIT);
    expect(lineOfSight(gb, gm, 0.5, 64.5, 0.5, 6.5, 64.5, 0.5)).toBe(true);
    // A bottom slab: a ray through its upper half passes, through the lower half it does not.
    world.set(3, 64, 0, BLOCK.SLAB_X, SLAB_BOTTOM);
    expect(lineOfSight(gb, gm, 0.5, 64.8, 0.5, 6.5, 64.8, 0.5)).toBe(true);
    expect(lineOfSight(gb, gm, 0.5, 64.2, 0.5, 6.5, 64.2, 0.5)).toBe(false);
    // Without block states a partial block counts as full (like collision).
    expect(lineOfSight(gb, null, 0.5, 64.8, 0.5, 6.5, 64.8, 0.5)).toBe(false);
  });
});

describe('outrunning and killing', () => {
  /** Steady chase speed in blocks per second on flat ground (median of a few runs). */
  function chaseSpeed(kind: 'zombie' | 'spider' | 'creeper'): number {
    const world = new TestWorld();
    const gb = (x: number, y: number, z: number) => world.getBlock(x, y, z);
    const { events } = recorder();
    const runs: number[] = [];
    for (let r = 0; r < 7; r++) {
      const m = new Mob(MOB_TYPES[kind]);
      m.setPosition(0.5, 63, 0.5);
      const t: MobTarget = { x: 10, y: 63, z: 0.5, attackable: true };
      for (let i = 0; i < 40; i++) { t.x = m.x + 10; m.tick(gb, t, events); }
      const x0 = m.x;
      for (let i = 0; i < 100; i++) { t.x = m.x + 10; m.tick(gb, t, events); }
      runs.push((m.x - x0) / 5);
    }
    runs.sort((a, b) => a - b);
    return runs[3];
  }

  it('zombies, spiders and creepers are slower than a walking player', () => {
    expect(chaseSpeed('zombie')).toBeLessThan(PHYSICS.WALK_SPEED * 0.6);
    expect(chaseSpeed('creeper')).toBeLessThan(PHYSICS.WALK_SPEED * 0.6);
    expect(chaseSpeed('spider')).toBeLessThan(PHYSICS.WALK_SPEED);
  });

  it('a walking player escapes a zombie that starts right behind them and it gives up the chase', () => {
    const world = new TestWorld();
    const gb = (x: number, y: number, z: number) => world.getBlock(x, y, z);
    const { hits, events } = recorder();
    const z = new Mob(MOB_TYPES.zombie);
    z.setPosition(0.5, 63, 0.5);
    z.yaw = -Math.PI / 2; // facing +x, towards the player
    const target: MobTarget = { x: 2.5, y: 63, z: 0.5, attackable: true };
    for (let t = 0; t < 30 * 20; t++) {
      target.x += PHYSICS.WALK_SPEED / 20;
      z.tick(gb, target, events);
    }
    expect(hits.length).toBeLessThanOrEqual(1);
    // Beyond the 32-block follow range the zombie stops chasing.
    expect(target.x - z.x).toBeGreaterThan(32);
  });

  it('a zombie (2 natural armor) dies from 22 bare-handed hits, or 6 with a wooden sword', () => {
    const fist = new Mob(MOB_TYPES.zombie);
    let swings = 0;
    while (!fist.dead && swings < 100) {
      fist.hurt(1, 0, 0, 1, true);
      for (let t = 0; t < 10; t++) fist.hurtTime = Math.max(0, fist.hurtTime - 1);
      swings++;
    }
    // Armor 2 takes 6 % off a fist (1 → 0.94) and 1.6 % off a wooden sword (4 → 3.936), like Minecraft.
    expect(swings).toBe(22);
    const sword = new Mob(MOB_TYPES.zombie);
    const swordDamage = getItemDef(ITEM.WOODEN_SWORD)!.tool!.damage;
    let hits = 0;
    while (!sword.dead && hits < 100) {
      sword.hurt(swordDamage, 0, 0, 1, true);
      sword.hurtTime = 0;
      hits++;
    }
    expect(hits).toBe(6);
  });
});
