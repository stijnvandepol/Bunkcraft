import { describe, expect, it } from 'vitest';
import { BLOCK, CUBE_ID } from '../src/world/BlockRegistry';
import { BIOME, BIOME_NAMES, isWaterBiome, spawnRank } from '../src/world/Biomes';
import { CHUNK_AREA, CHUNK_HEIGHT, CHUNK_VOLUME, SEA_LEVEL, blockIndex } from '../src/world/constants';
import { CUBES } from '../src/world/Content';
import { leafSupported } from '../src/world/Growth';
import * as noise from '../src/world/Noise';
import { resolveOres } from '../src/world/OreTable';
import { findSpawnColumn } from '../src/world/Spawn';
import { STRUCTURE_FEATURES, type StructureContext, desertWell, placeStructures } from '../src/world/Structures';
import { TerrainGenerator } from '../src/world/TerrainGenerator';
import { createGenerator } from '../src/world/WorldGenerator';
import { fnv1a } from './helpers';

const SEED = 12345;

interface Chunk { blocks: Uint8Array; biomes: Uint8Array; meta: Uint8Array | null }

function gen3(seed: number, cx: number, cz: number, g = new TerrainGenerator(seed, 3)): Chunk {
  const blocks = new Uint8Array(CHUNK_VOLUME);
  const biomes = new Uint8Array(CHUNK_AREA);
  const meta = g.generate(cx, cz, blocks, biomes);
  return { blocks, biomes, meta };
}

/**
 * Golden hashes of generator version 3 (blocks, biomes). Version 3 is what new worlds use: if its output changes,
 * existing v3 worlds change. Make a version 4 instead of updating these.
 */
const GOLDEN_V3: [number, number, number, number][] = [
  [0, 0, 0xdb58e1ac, 0xf440a294],
  [3, -2, 0xdf39a289, 0xdc43da71],
  [-7, 11, 0xa5436239, 0x2e9aeac5],
  [40, -25, 0xccd7c155, 0x40ebc2c5],
];

describe('TerrainGenerator version 3', () => {
  it.each(GOLDEN_V3)('chunk (%i, %i) matches its golden hash', (cx, cz, blocksHash, biomesHash) => {
    const { blocks, biomes } = gen3(SEED, cx, cz);
    expect(fnv1a(blocks)).toBe(blocksHash);
    expect(fnv1a(biomes)).toBe(biomesHash);
  });

  it('is what createGenerator builds by default, and differs from version 2 at the surface', () => {
    const blocks = new Uint8Array(CHUNK_VOLUME);
    createGenerator('terrain', SEED).generate(0, 0, blocks);
    expect(fnv1a(blocks)).toBe(GOLDEN_V3[0][2]);
    const v2 = new Uint8Array(CHUNK_VOLUME);
    new TerrainGenerator(SEED, 2).generate(0, 0, v2);
    expect(fnv1a(v2)).not.toBe(fnv1a(blocks));
  });

  it('reports the same height and biome as the generated chunk, whatever was asked before', () => {
    const g = new TerrainGenerator(777, 3);
    const c = gen3(777, 5, -9, g);
    for (let i = 0; i < CHUNK_AREA; i += 7) {
      const x = 5 * 16 + (i & 15), z = -9 * 16 + (i >> 4);
      g.heightAt(x + 100, z); // poison the one-column cache
      expect(g.biomeAt(x, z, Math.floor(g.heightAt(x, z)))).toBe(c.biomes[i]);
    }
  });

  it('only uses biome ids that have a name', () => {
    for (const [cx, cz] of [[0, 0], [30, 30], [-50, 12]]) {
      for (const b of gen3(SEED, cx, cz).biomes) expect(BIOME_NAMES[b]).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------- a sampled area, generated once

const AREA = 6; // chunks per side
interface Area { seed: number; x0: number; z0: number; chunks: Chunk[]; g: TerrainGenerator }
const areas = new Map<string, Area>();
function area(seed: number, cx0: number, cz0: number): Area {
  const key = `${seed},${cx0},${cz0}`;
  let a = areas.get(key);
  if (a) return a;
  const g = new TerrainGenerator(seed, 3);
  const chunks: Chunk[] = [];
  // Generate in a scrambled order: the result must not depend on it.
  const order = Array.from({ length: AREA * AREA }, (_, i) => (i * 7) % (AREA * AREA));
  const tmp: Chunk[] = new Array(AREA * AREA);
  for (const i of order) tmp[i] = gen3(seed, cx0 + (i % AREA), cz0 + Math.floor(i / AREA), g);
  chunks.push(...tmp);
  a = { seed, x0: cx0 * 16, z0: cz0 * 16, chunks, g };
  areas.set(key, a);
  return a;
}
function blockAt(a: Area, x: number, y: number, z: number): number {
  const lx = x - a.x0, lz = z - a.z0;
  if (lx < 0 || lz < 0 || lx >= AREA * 16 || lz >= AREA * 16 || y < 0 || y >= CHUNK_HEIGHT) return -1;
  return a.chunks[(lz >> 4) * AREA + (lx >> 4)].blocks[blockIndex(lx & 15, y, lz & 15)];
}

const LOGS = new Set<number>([BLOCK.OAK_LOG, BLOCK.BIRCH_LOG, BLOCK.SPRUCE_LOG]);
const LEAVES = new Set<number>([BLOCK.OAK_LEAVES, BLOCK.BIRCH_LEAVES, BLOCK.SPRUCE_LEAVES]);
for (const spec of CUBES) {
  if (spec.name.endsWith('_log') && !spec.name.startsWith('stripped')) LOGS.add(CUBE_ID[spec.name]);
  if (spec.kind === 'leaves' || spec.kind === 'cherry_leaves') LEAVES.add(CUBE_ID[spec.name]);
}

/** Places that show many biomes and trees (found with scripts/gen-spots.ts --gen=3). */
const PLACES: [number, number, number][] = [[SEED, -3, -3], [777, 10, 4], [424242, -20, 8]];

describe('TerrainGenerator version 3: chunk borders', () => {
  it('builds trees across chunk borders consistently: no generated leaf would decay (≤ 6 steps through leaves to a log)', () => {
    let leaves = 0, orphans = 0;
    for (const [seed, cx, cz] of PLACES) {
      const a = area(seed, cx, cz);
      // Inner chunks only (their neighbours are in the area too).
      for (let z = a.z0 + 16; z < a.z0 + (AREA - 1) * 16; z++) {
        for (let x = a.x0 + 16; x < a.x0 + (AREA - 1) * 16; x++) {
          for (let y = SEA_LEVEL; y < CHUNK_HEIGHT; y++) {
            if (!LEAVES.has(blockAt(a, x, y, z))) continue;
            leaves++;
            const found = leafSupported({ getBlock: (bx, by, bz) => { const b = blockAt(a, bx, by, bz); return b < 0 ? BLOCK.UNLOADED : b; } }, x, y, z);
            if (!found) orphans++;
          }
        }
      }
    }
    expect(leaves).toBeGreaterThan(500);
    expect(orphans).toBe(0);
  });

  it('agrees on the surface at chunk borders: the top block of every column is the height function (or carved)', () => {
    for (const [seed, cx, cz] of PLACES) {
      const a = area(seed, cx, cz);
      for (let k = 0; k < AREA * 16; k++) {
        for (const [x, z] of [[a.x0 + 15, a.z0 + k], [a.x0 + 16, a.z0 + k], [a.x0 + k, a.z0 + 31], [a.x0 + k, a.z0 + 32]]) {
          const h = Math.floor(a.g.heightAt(x, z));
          const top = blockAt(a, x, h, z);
          const above = blockAt(a, x, h + 1, z);
          const carved = a.g.surfaceOpen(x, z);
          if (!carved) expect(top === BLOCK.AIR || top === BLOCK.WATER).toBe(false);
          // Above the surface: air, water (sea, river, swamp), ice or something growing/standing there.
          if (h + 1 > SEA_LEVEL) expect(above === BLOCK.WATER && !carved).toBe(false);
        }
      }
    }
  });

  it('carvedAt() matches the generated blocks in version 3 too (trees use it for neighbouring trunks)', () => {
    const a = area(SEED, -3, -3);
    let checked = 0;
    for (let z = a.z0; z < a.z0 + AREA * 16; z += 3) {
      for (let x = a.x0; x < a.x0 + AREA * 16; x += 5) {
        const h = Math.floor(a.g.heightAt(x, z));
        const mn = Math.floor(Math.min(a.g.heightAt(x + 1, z), a.g.heightAt(x - 1, z), a.g.heightAt(x, z + 1), a.g.heightAt(x, z - 1)));
        for (let y = 5; y <= h; y += 2) {
          if (!a.g.carver!.carvedAt(x, y, z, h, mn)) continue;
          checked++;
          const b = blockAt(a, x, y, z);
          expect([BLOCK.AIR, BLOCK.WATER, BLOCK.LAVA, CUBE_ID.brown_mushroom, CUBE_ID.red_mushroom]).toContain(b);
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('never leaves the sea or a river next to air: no holes in the water surface', () => {
    let holes = 0, water = 0;
    for (const [seed, cx, cz] of PLACES) {
      const a = area(seed, cx, cz);
      for (let z = a.z0 + 1; z < a.z0 + AREA * 16 - 1; z++) {
        for (let x = a.x0 + 1; x < a.x0 + AREA * 16 - 1; x++) {
          const h = Math.floor(a.g.heightAt(x, z));
          for (let y = h + 1; y <= SEA_LEVEL; y++) {
            if (blockAt(a, x, y, z) !== BLOCK.WATER) continue;
            water++;
            for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]]) {
              if (blockAt(a, x + dx, y + dy, z + dz) === BLOCK.AIR) holes++;
            }
          }
        }
      }
    }
    expect(water).toBeGreaterThan(1000);
    expect(holes).toBe(0);
  });

  it('has no floating single blocks of terrain', () => {
    const terrain = new Set<number>([BLOCK.STONE, BLOCK.DIRT, BLOCK.GRASS, BLOCK.SAND, BLOCK.GRAVEL, BLOCK.SNOWY_GRASS, CUBE_ID.deepslate, CUBE_ID.mud]);
    let floating = 0;
    for (const [seed, cx, cz] of PLACES) {
      const a = area(seed, cx, cz);
      for (let z = a.z0 + 1; z < a.z0 + AREA * 16 - 1; z++) {
        for (let x = a.x0 + 1; x < a.x0 + AREA * 16 - 1; x++) {
          for (let y = 2; y < CHUNK_HEIGHT - 1; y++) {
            if (!terrain.has(blockAt(a, x, y, z))) continue;
            if ([[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]].every(([dx, dy, dz]) => blockAt(a, x + dx, y + dy, z + dz) === BLOCK.AIR)) floating++;
          }
        }
      }
    }
    // Minecraft also leaves the odd single block between caves; a handful in ~100 chunks at most.
    expect(floating).toBeLessThan(15);
  });
});

describe('TerrainGenerator version 3: rock and ores', () => {
  const counts = new Map<number, number[]>(); // id → blocks per 8-layer band
  const emeraldBiomes = new Set<number>();
  function tally() {
    if (counts.size) return;
    for (const [seed, cx, cz] of [...PLACES, [99, 30, -30] as [number, number, number]]) {
      const a = area(seed, cx, cz);
      for (const c of a.chunks) {
        for (let i = 0; i < CHUNK_VOLUME; i++) {
          const b = c.blocks[i];
          if (!counts.has(b)) counts.set(b, new Array(16).fill(0));
          counts.get(b)![i >> 11]++;
          if (b === CUBE_ID.emerald_ore) emeraldBiomes.add(c.biomes[i & 255]);
        }
      }
    }
  }
  const total = (id: number) => (counts.get(id) ?? []).reduce((s, v) => s + v, 0);

  it('has a deepslate layer below y 16 with a gradient, and none above', () => {
    tally();
    const d = counts.get(CUBE_ID.deepslate)!;
    expect(d[0]).toBeGreaterThan(d[1]); // y 0..7 is (nearly) all deepslate, y 8..15 the gradient
    expect(d[1]).toBeGreaterThan(0);
    for (let band = 2; band < 16; band++) expect(d[band]).toBe(0);
  });

  it('places granite, diorite, andesite and tuff blobs, tuff only deep down', () => {
    tally();
    for (const name of ['granite', 'diorite', 'andesite', 'tuff']) expect(total(CUBE_ID[name])).toBeGreaterThan(500);
    const tuff = counts.get(CUBE_ID.tuff)!;
    for (let band = 6; band < 16; band++) expect(tuff[band]).toBe(0);
  });

  it('places the new ores at Minecraft-like heights and the old ones also in deepslate', () => {
    tally();
    for (const name of ['copper_ore', 'lapis_ore', 'redstone_ore']) expect(total(CUBE_ID[name])).toBeGreaterThan(50);
    const redstone = counts.get(CUBE_ID.redstone_ore)!;
    for (let band = 5; band < 16; band++) expect(redstone[band]).toBe(0); // y < 40
    const copper = counts.get(CUBE_ID.copper_ore)!;
    expect(copper[0] + copper[1]).toBe(0); // copper from y 24
    expect(counts.get(BLOCK.DIAMOND_ORE)![0]).toBeGreaterThan(0); // in the deepslate layer
    expect(total(BLOCK.COAL_ORE)).toBeGreaterThan(total(CUBE_ID.copper_ore));
  });

  it('puts emerald only in mountain biomes', () => {
    tally();
    for (const b of emeraldBiomes) expect([BIOME.MOUNTAINS, BIOME.WINDSWEPT_HILLS]).toContain(b);
    expect(resolveOres(3).some((o) => o.id === CUBE_ID.emerald_ore)).toBe(true);
    expect(resolveOres(2).some((o) => o.id === CUBE_ID.emerald_ore)).toBe(false);
  });
});

describe('TerrainGenerator version 3: biomes and rivers', () => {
  it('covers every biome over 4 seeds, none dominating', () => {
    const counts = new Array(BIOME_NAMES.length).fill(0);
    let n = 0;
    for (const seed of [SEED, 777, 424242, 99]) {
      const g = new TerrainGenerator(seed, 3);
      for (let z = -2400; z < 2400; z += 24) {
        for (let x = -2400; x < 2400; x += 24) { counts[g.biomeAt(x, z, Math.floor(g.heightAt(x, z)))]++; n++; }
      }
    }
    counts.forEach((c, b) => expect(c, BIOME_NAMES[b]).toBeGreaterThan(0));
    for (const c of counts) expect(c / n).toBeLessThan(0.25);
  });

  it('lets rivers flow: water connects a river to the sea', () => {
    const g = new TerrainGenerator(SEED, 3);
    // River columns on a coarse grid, then a flood fill over water columns (surface below sea level).
    const starts: [number, number][] = [];
    for (let z = -1500; z < 1500 && starts.length < 12; z += 37) {
      for (let x = -1500; x < 1500 && starts.length < 12; x += 37) if (g.biomeAt(x, z, Math.floor(g.heightAt(x, z))) === BIOME.RIVER) starts.push([x, z]);
    }
    expect(starts.length).toBeGreaterThan(5);
    let reached = 0;
    for (const [sx, sz] of starts) {
      const seen = new Set<number>();
      const key = (x: number, z: number) => (x + 20000) * 40000 + (z + 20000);
      const queue: [number, number][] = [[sx, sz]];
      seen.add(key(sx, sz));
      let found = false;
      while (queue.length && seen.size < 60000) {
        const [x, z] = queue.shift()!;
        const b = g.biomeAt(x, z, Math.floor(g.heightAt(x, z)));
        if (isWaterBiome(b) && b !== BIOME.RIVER && b !== BIOME.FROZEN_RIVER) { found = true; break; }
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, nz = z + dz;
          if (seen.has(key(nx, nz)) || g.heightAt(nx, nz) >= SEA_LEVEL) continue;
          seen.add(key(nx, nz));
          queue.push([nx, nz]);
        }
      }
      if (found) reached++;
    }
    // Most rivers reach the sea; some run into the mountains and end there (they fade out above y ~90).
    expect(reached / starts.length).toBeGreaterThan(0.6);
  });

  it('paints the badlands with coloured terracotta bands (block states come back from generate)', () => {
    const g = new TerrainGenerator(SEED, 3);
    let found: [number, number] | null = null;
    for (let z = -3000; z < 3000 && !found; z += 48) {
      for (let x = -3000; x < 3000 && !found; x += 48) if (g.biomeAt(x, z, Math.floor(g.heightAt(x, z))) === BIOME.BADLANDS) found = [x >> 4, z >> 4];
    }
    expect(found).not.toBeNull();
    const c = gen3(SEED, found![0], found![1], g);
    expect(c.meta).not.toBeNull();
    let stained = 0;
    const colours = new Set<number>();
    for (let i = 0; i < CHUNK_VOLUME; i++) {
      if (c.blocks[i] === BLOCK.STAINED_TERRACOTTA) { stained++; colours.add(c.meta![i]); }
      else if (c.meta) expect(c.meta[i]).toBe(0);
    }
    expect(stained).toBeGreaterThan(50);
    expect(colours.size).toBeGreaterThan(2);
  });

  it('returns no block states for ordinary chunks and for older versions', () => {
    expect(gen3(SEED, 0, 0).meta).toBeNull();
    expect(new TerrainGenerator(SEED, 2).generate(0, 0, new Uint8Array(CHUNK_VOLUME))).toBeNull();
  });
});

describe('Structures registry', () => {
  const flatDesert: StructureContext = { seed: 5, heightAt: () => 70, biomeAt: () => BIOME.DESERT };

  it('builds a desert well identically from every chunk it touches', () => {
    // Find an anchor chunk with a well, then build the 3×3 chunks around it separately and stitch.
    let anchor: { x: number; z: number } | null = null;
    let acx = 0;
    for (; acx < 400 && !anchor; acx++) {
      const index = STRUCTURE_FEATURES.indexOf(desertWell);
      const { hash2, mulberry32 } = noise;
      const s = (hash2(flatDesert.seed ^ Math.imul(desertWell.salt + index, 0x9e3779b1), acx, 0) * 4294967296) >>> 0;
      anchor = desertWell.anchor(acx, 0, mulberry32(s), flatDesert);
    }
    expect(anchor).not.toBeNull();
    const meta = new Uint8Array(CHUNK_VOLUME);
    const get = (x: number, y: number, z: number) => {
      const blocks = new Uint8Array(CHUNK_VOLUME);
      placeStructures(blocks, meta, () => {}, flatDesert, x >> 4, z >> 4, 3);
      return blocks[blockIndex(x & 15, y, z & 15)];
    };
    expect(get(anchor!.x, 70, anchor!.z)).toBe(BLOCK.WATER);
    expect(get(anchor!.x + 1, 71, anchor!.z + 1)).toBe(BLOCK.SANDSTONE);
    expect(get(anchor!.x - 1, 73, anchor!.z)).toBe(BLOCK.SANDSTONE_SLAB);
    expect(get(anchor!.x + 2, 70, anchor!.z - 2)).toBe(BLOCK.SANDSTONE);
  });

  it('skips features of newer generator versions', () => {
    const blocks = new Uint8Array(CHUNK_VOLUME);
    for (let cx = 0; cx < 50; cx++) placeStructures(blocks, new Uint8Array(CHUNK_VOLUME), () => {}, flatDesert, cx, 0, 2);
    expect(blocks.every((b) => b === 0)).toBe(true);
  });
});

describe('Spawn search', () => {
  it.each([SEED, 777, 424242, 99, 2024])('seed %i spawns in a preferred biome near sea level, never badlands or water (v3)', (seed) => {
    const g = new TerrainGenerator(seed, 3);
    const at = findSpawnColumn(g, 3)!;
    expect(at).not.toBeNull();
    const biome = g.biomeAt(at.x, at.z, Math.floor(at.h));
    expect(spawnRank(biome, 3)).toBeGreaterThanOrEqual(0);
    expect(biome).not.toBe(BIOME.BADLANDS);
    expect(isWaterBiome(biome)).toBe(false);
    expect(at.h).toBeLessThan(80);
  });
});

