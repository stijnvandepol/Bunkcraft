import { describe, expect, it } from 'vitest';
import { EntityManager, type EntityWorld } from '../src/entities/EntityManager';
import { Mob, type MobEvents, type MobTarget } from '../src/entities/Mob';
import {
  HOSTILE_TABLE, MobSpawner, PASSIVE_TABLE, SPAWN, type SpawnHost, hostileCap, hostileDespawns, hostileLightOk, pickEntry,
} from '../src/entities/MobSpawner';
import { MOB_TYPES, type MobKind } from '../src/entities/MobTypes';
import { BLOCK } from '../src/world/BlockRegistry';
import { CHUNK_VOLUME, blockIndex } from '../src/world/constants';
import { mulberry32 } from '../src/world/Noise';
import { TIME_SLACK } from './helpers/timing';

/** Flat grass world at y = 63 with a configurable light level everywhere. */
class FlatWorld implements EntityWorld {
  sky = 15;
  block = 0;
  /** Optional hollow: inside it is a cave (solid ceiling, no sky light). */
  cave: { y0: number; y1: number } | null = null;
  getBlock(_x: number, y: number, _z: number): number {
    if (this.cave && y >= this.cave.y0 - 1 && y <= this.cave.y1) {
      // Roof above the cave, stone floor under it.
      if (y === this.cave.y0 - 1) return BLOCK.STONE;
      if (y === this.cave.y1) return BLOCK.STONE;
      return 0;
    }
    if (y < 62) return BLOCK.STONE;
    if (y === 62) return BLOCK.GRASS;
    return 0;
  }
  getLight(_x: number, y: number): number {
    const underCave = this.cave !== null && y >= this.cave.y0 && y < this.cave.y1;
    return ((underCave ? 0 : this.sky) << 4) | this.block;
  }
}

const noop = () => undefined;
const noEvents: MobEvents = { attack: noop, explode: noop, shoot: noop, arrowHit: noop, arrowImpact: noop, tntExplode: noop, killed: noop, playerArrowHit: noop, sound: noop };

function fakeHost(world: EntityWorld) {
  const mobs: Mob[] = [];
  const log: { kind: MobKind; x: number; y: number; z: number; call: number }[] = [];
  let call = 0;
  const host: SpawnHost = {
    world,
    mobs,
    spawnMob(kind, x, y, z) {
      const m = new Mob(MOB_TYPES[kind]);
      m.setPosition(x, y, z);
      mobs.push(m);
      log.push({ kind, x, y, z, call });
      return m;
    },
  };
  return { host, mobs, log, nextCall: () => { call++; } };
}

const player: MobTarget = { x: 0.5, y: 63, z: 0.5, attackable: true };

describe('light rules', () => {
  it('needs zero block light, and sky light below a random 0..7 after darkening', () => {
    expect(hostileLightOk(0, 0, 0, 0)).toBe(true); // cave
    expect(hostileLightOk(0, 1, 0, 0.99)).toBe(false); // a torch nearby
    expect(hostileLightOk(15, 0, 0, 0.99)).toBe(false); // noon, open sky
    expect(hostileLightOk(15, 0, 11, 0.5)).toBe(true); // midnight, open sky (4 <= 4)
    expect(hostileLightOk(15, 0, 11, 0.4)).toBe(false); // roll gives 3 < 4
    expect(hostileLightOk(15, 0, 4, 0.99)).toBe(false); // dusk is still too bright (11 > 7)
  });

  it('spawns nothing in an open field at noon, packs at midnight, and cave packs at noon', () => {
    const noon = new FlatWorld();
    const a = fakeHost(noon);
    const s = new MobSpawner(a.host, 1, mulberry32(5));
    for (let i = 0; i < 400; i++) { s.recount(); s.tickHostile([player], 0); }
    expect(a.mobs.filter((m) => m.type.hostile)).toHaveLength(0);

    const midnight = fakeHost(new FlatWorld());
    const s2 = new MobSpawner(midnight.host, 1, mulberry32(5));
    for (let i = 0; i < 400; i++) { s2.recount(); s2.tickHostile([player], 11); }
    expect(midnight.mobs.length).toBeGreaterThan(SPAWN.hostileCap / 2);

    const cave = new FlatWorld();
    cave.cave = { y0: 40, y1: 48 };
    const c = fakeHost(cave);
    const s3 = new MobSpawner(c.host, 1, mulberry32(9));
    for (let i = 0; i < 2000; i++) { s3.recount(); s3.tickHostile([{ ...player, y: 44 }], 0); }
    // Only cave floors are dark, so every spawn stands on the cave floor.
    expect(c.mobs.length).toBeGreaterThanOrEqual(hostileCap(1, 0) - 1);
    for (const m of c.mobs) expect(m.y).toBe(40);
  });

  it('never spawns on lit ground (torches) or closer than 24 blocks', () => {
    const w = new FlatWorld();
    w.block = 1;
    const a = fakeHost(w);
    const s = new MobSpawner(a.host, 1, mulberry32(2));
    for (let i = 0; i < 300; i++) { s.recount(); s.tickHostile([player], 11); }
    expect(a.mobs).toHaveLength(0);

    const dark = fakeHost(new FlatWorld());
    const s2 = new MobSpawner(dark.host, 1, mulberry32(3));
    for (let i = 0; i < 300; i++) { s2.recount(); s2.tickHostile([player], 11); }
    for (const m of dark.mobs) {
      expect(Math.hypot(m.x - player.x, m.z - player.z)).toBeGreaterThanOrEqual(SPAWN.minDistance - 0.01);
      expect(m.y).toBe(63);
    }
  });
});

describe('caps and rates', () => {
  it('fills up to the cap within a minute at night, never beyond it', () => {
    const a = fakeHost(new FlatWorld());
    const s = new MobSpawner(a.host, 1, mulberry32(11));
    for (let tick = 0; tick < 60 * 20; tick++) { s.recount(); s.tickHostile([player], 11); }
    expect(a.mobs.filter((m) => m.type.hostile)).toHaveLength(hostileCap(1, 11));
    expect(hostileCap(1, 11)).toBe(SPAWN.hostileCap);
  });

  it('scales the cap with players and shrinks it in daylight', () => {
    expect(hostileCap(2, 11)).toBe(SPAWN.hostileCap + SPAWN.hostileCapPerExtraPlayer);
    expect(hostileCap(50, 11)).toBe(SPAWN.hostileCapMax);
    // By day only a share of the cap is available, and it is the same for every darkness below the threshold.
    expect(hostileCap(1, 0)).toBeGreaterThan(0);
    expect(hostileCap(1, 0)).toBeLessThanOrEqual(Math.ceil(SPAWN.hostileCap * SPAWN.daylightCapShare));
    expect(hostileCap(1, 6)).toBe(hostileCap(1, 0));
    expect(hostileCap(1, 7)).toBe(SPAWN.hostileCap);
  });

  it('attempts several packs per second, not one', () => {
    const a = fakeHost(new FlatWorld());
    const s = new MobSpawner(a.host, 1, mulberry32(4));
    s.recount();
    for (let tick = 0; tick < 20; tick++) { s.recount(); s.tickHostile([player], 11); }
    // One second at midnight already holds far more than the old one mob per second.
    expect(a.mobs.length).toBeGreaterThanOrEqual(8);
  });
});

describe('packs and weights', () => {
  it('picks every monster with the same weight and animals with the vanilla ratio', () => {
    const rng = mulberry32(1);
    const hostile: Record<string, number> = {};
    const passive: Record<string, number> = {};
    for (let i = 0; i < 20000; i++) {
      const h = pickEntry(HOSTILE_TABLE, rng()).kind;
      const p = pickEntry(PASSIVE_TABLE, rng()).kind;
      hostile[h] = (hostile[h] ?? 0) + 1;
      passive[p] = (passive[p] ?? 0) + 1;
    }
    for (const k of ['zombie', 'skeleton', 'creeper', 'spider']) expect(hostile[k]).toBeGreaterThan(4500);
    expect(passive.sheep).toBeGreaterThan(passive.cow);
    expect(passive.pig / passive.cow).toBeGreaterThan(1.1);
  });

  it('spawns zombies and skeletons in packs of 4, creepers alone and spiders in pairs at most', () => {
    const a = fakeHost(new FlatWorld());
    const s = new MobSpawner(a.host, 1, mulberry32(21));
    const sizes: Record<string, number[]> = {};
    for (let i = 0; i < 3000; i++) {
      a.nextCall();
      s.recount();
      s.tryPack(player, [player], 11, 1000);
      const added = a.log.filter((l) => l.call === i + 1);
      if (added.length > 0) (sizes[added[0].kind] ??= []).push(added.length);
      expect(new Set(added.map((l) => l.kind)).size).toBeLessThanOrEqual(1);
      a.mobs.length = 0;
    }
    expect(Math.max(...sizes.zombie)).toBe(4);
    expect(Math.max(...sizes.skeleton)).toBe(3);
    expect(Math.max(...sizes.creeper)).toBe(1);
    expect(Math.max(...sizes.spider)).toBe(2);
    // Pack sizes are drawn from 2-4 for zombies; members that find no floor are skipped.
    expect(Math.min(...sizes.zombie)).toBeGreaterThanOrEqual(1);
    const big = sizes.zombie.filter((n) => n >= 3).length / sizes.zombie.length;
    expect(big).toBeGreaterThan(0.3);
  });

  it('keeps the members of a pack close together', () => {
    const a = fakeHost(new FlatWorld());
    const s = new MobSpawner(a.host, 1, mulberry32(8));
    for (let i = 0; i < 200; i++) {
      a.nextCall();
      s.recount();
      s.tryPack(player, [player], 11, 1000);
      a.mobs.length = 0;
    }
    const byCall = new Map<number, typeof a.log>();
    for (const l of a.log) byCall.set(l.call, [...(byCall.get(l.call) ?? []), l]);
    for (const group of byCall.values()) {
      for (const g of group) expect(Math.hypot(g.x - group[0].x, g.z - group[0].z)).toBeLessThanOrEqual(6);
    }
  });
});

describe('animals', () => {
  function chunkWith(grass: boolean): { key: number; cx: number; cz: number; blocks: Uint8Array } {
    const blocks = new Uint8Array(CHUNK_VOLUME);
    for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) {
      for (let y = 0; y < 62; y++) blocks[blockIndex(x, y, z)] = BLOCK.STONE;
      blocks[blockIndex(x, 62, z)] = grass ? BLOCK.GRASS : BLOCK.SAND;
    }
    return { key: 1, cx: 3, cz: -2, blocks };
  }

  it('puts a herd of 2 to 4 on grass in a quarter of the chunks, the same every time, none on sand', () => {
    let withHerd = 0;
    const kinds = new Set<string>();
    for (let cx = 0; cx < 200; cx++) {
      const a = fakeHost(new FlatWorld());
      const s = new MobSpawner(a.host, 42);
      const chunk = { ...chunkWith(true), cx, cz: 7, key: cx };
      s.onChunkReady(chunk);
      if (a.mobs.length > 0) {
        withHerd++;
        expect(a.mobs.length).toBeGreaterThanOrEqual(2);
        expect(a.mobs.length).toBeLessThanOrEqual(4);
        for (const m of a.mobs) {
          kinds.add(m.type.kind);
          expect(m.type.hostile).toBe(false);
          expect(Math.floor(m.x) >> 4).toBe(cx);
          expect(m.y).toBe(63);
          expect(m.homeChunk).toBe(cx);
        }
        // Deterministic from the seed and chunk.
        const b = fakeHost(new FlatWorld());
        new MobSpawner(b.host, 42).onChunkReady(chunk);
        expect(b.mobs.map((m) => [m.type.kind, m.x, m.z])).toEqual(a.mobs.map((m) => [m.type.kind, m.x, m.z]));
      }
      const sand = fakeHost(new FlatWorld());
      new MobSpawner(sand.host, 42).onChunkReady({ ...chunkWith(false), cx, cz: 7, key: cx });
      expect(sand.mobs).toHaveLength(0);
    }
    expect(withHerd / 200).toBeGreaterThan(0.15);
    expect(withHerd / 200).toBeLessThan(0.35);
    expect(kinds.size).toBe(4);
  });

  it('tops up animals in daylight but not at night, and respects the cap', () => {
    const a = fakeHost(new FlatWorld());
    const s = new MobSpawner(a.host, 3, mulberry32(6));
    for (let t = 0; t < 40; t++) { s.recount(); s.tickPassive([player], 11, t * SPAWN.passiveInterval); }
    expect(a.mobs).toHaveLength(0);
    for (let t = 0; t < 40; t++) { s.recount(); s.tickPassive([player], 0, t * SPAWN.passiveInterval); }
    expect(a.mobs.length).toBeGreaterThan(10);
    expect(a.mobs.length).toBeLessThanOrEqual(SPAWN.passiveNearCap + 4);
    for (const m of a.mobs) expect(m.type.hostile).toBe(false);
  });
});

describe('despawning', () => {
  it('removes hostiles instantly beyond 128 blocks and at 1/800 per tick beyond 32', () => {
    expect(hostileDespawns(129, 0.99)).toBe(true);
    expect(hostileDespawns(50, 0.0005)).toBe(true);
    expect(hostileDespawns(50, 0.5)).toBe(false);
    expect(hostileDespawns(20, 0)).toBe(false);
  });

  it('EntityManager despawns far hostiles, keeps passives, and daylight thins the surface mobs', () => {
    const world = new FlatWorld();
    const em = new EntityManager(world, 1);
    em.hostileSpawning = false;
    em.passiveSpawning = false;
    const far = em.spawnMob('creeper', 200, 63, 0);
    const pig = em.spawnMob('pig', 200, 63, 0);
    const target: MobTarget = { x: 0, y: 63, z: 0, attackable: false };
    em.tick(target, 0, noEvents, null, true);
    expect(em.mobs.includes(far)).toBe(false);
    expect(em.mobs.includes(pig)).toBe(true);

    // 100 creepers 60 blocks away on an open, sunlit field: a few ticks of daylight clean most of them up.
    for (let i = 0; i < 100; i++) em.spawnMob('creeper', 60, 63, (i % 10) - 5);
    for (let t = 0; t < 600; t++) em.tick(target, 0, noEvents, null, true);
    expect(em.mobs.filter((m) => m.type.kind === 'creeper').length).toBeLessThan(15);

    // At night they stay (only the 1/800 distance rule applies).
    for (let i = 0; i < 100; i++) em.spawnMob('creeper', 60, 63, (i % 10) - 5);
    for (let t = 0; t < 100; t++) em.tick(target, 11, noEvents, null, false);
    expect(em.mobs.filter((m) => m.type.kind === 'creeper').length).toBeGreaterThan(80);
  });

  it('spawns through the manager at night and stays within the cap and budget', () => {
    const em = new EntityManager(new FlatWorld(), 1);
    em.passiveSpawning = false;
    const target: MobTarget = { x: 0.5, y: 63, z: 0.5, attackable: false };
    const t0 = performance.now();
    for (let t = 0; t < 1200; t++) em.tick(target, 11, noEvents, null, false);
    const perTick = (performance.now() - t0) / 1200;
    expect(em.mobs.filter((m) => m.type.hostile).length).toBeGreaterThan(SPAWN.hostileCap / 2);
    expect(em.mobs.filter((m) => m.type.hostile).length).toBeLessThanOrEqual(SPAWN.hostileCap);
    expect(perTick).toBeLessThan(5 * TIME_SLACK);
  });
});
