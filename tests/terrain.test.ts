import { describe, expect, it } from 'vitest';
import { BLOCK } from '../src/world/BlockRegistry';
import { ORE_TABLE, resolveOres } from '../src/world/OreTable';
import { TerrainGenerator } from '../src/world/TerrainGenerator';
import { CHUNK_AREA, CHUNK_HEIGHT, CHUNK_VOLUME, SEA_LEVEL, blockIndex } from '../src/world/constants';
import { GEN_VERSION_CURRENT, GEN_VERSION_LEGACY, normalizeGenVersion } from '../src/world/GenVersion';
import { createGenerator } from '../src/world/WorldGenerator';
import { fnv1a } from './helpers';

const SEED = 12345;

function generate(seed: number, cx: number, cz: number, version = GEN_VERSION_CURRENT): { blocks: Uint8Array; biomes: Uint8Array } {
  const blocks = new Uint8Array(CHUNK_VOLUME);
  const biomes = new Uint8Array(CHUNK_AREA);
  new TerrainGenerator(seed, version).generate(cx, cz, blocks, biomes);
  return { blocks, biomes };
}

/**
 * Golden hashes (FNV-1a over the chunk bytes) for a fixed seed. If world generation is
 * changed on purpose, existing worlds change too: add a new generator version instead of updating
 * the hashes of an old one (version 1 hashes below must never change: they prove old worlds are intact).
 */
const GOLDEN_V1: [number, number, number, number][] = [
  // [cx, cz, blocks hash, biomes hash]
  [0, 0, 0xf29319c7, 0x87f698b0],
  [3, -2, 0x1f82108e, 0xef78e905],
  [-7, 11, 0xc58d641b, 0x2e9aeac5],
];

const GOLDEN_V2: [number, number, number, number][] = [
  [0, 0, 0xaa0ae40d, 0x87f698b0],
  [3, -2, 0xd280fd9f, 0xef78e905],
  [-7, 11, 0x1e8e8fa7, 0x2e9aeac5],
];

describe('TerrainGenerator version 1 (worlds created before generator versioning)', () => {
  it.each(GOLDEN_V1)('chunk (%i, %i) matches its golden hash', (cx, cz, blocksHash, biomesHash) => {
    const { blocks, biomes } = generate(SEED, cx, cz, GEN_VERSION_LEGACY);
    expect(fnv1a(blocks)).toBe(blocksHash);
    expect(fnv1a(biomes)).toBe(biomesHash);
  });

  it('is what createGenerator builds for genVersion 1', () => {
    const blocks = new Uint8Array(CHUNK_VOLUME);
    createGenerator('terrain', SEED, 1).generate(0, 0, blocks);
    expect(fnv1a(blocks)).toBe(GOLDEN_V1[0][2]);
  });
});

describe('TerrainGenerator version 2 (worlds created before generator version 3)', () => {
  it.each(GOLDEN_V2)('chunk (%i, %i) matches its golden hash', (cx, cz, blocksHash, biomesHash) => {
    const { blocks, biomes } = generate(SEED, cx, cz, 2);
    expect(fnv1a(blocks)).toBe(blocksHash);
    expect(fnv1a(biomes)).toBe(biomesHash);
  });

  it('keeps the surface of version 1: same biomes and same height function', () => {
    const a = generate(SEED, 3, -2, 1), b = generate(SEED, 3, -2, 2);
    expect(b.biomes).toEqual(a.biomes);
    const g1 = new TerrainGenerator(SEED, 1), g2 = new TerrainGenerator(SEED, 2);
    for (const [x, z] of [[0, 0], [100, -40], [-333, 20]]) expect(g2.heightAt(x, z)).toBe(g1.heightAt(x, z));
  });

  it('differs from version 1 underground', () => {
    expect(fnv1a(generate(SEED, 0, 0, 2).blocks)).not.toBe(fnv1a(generate(SEED, 0, 0, 1).blocks));
  });

  it('is not the default any more (version 3 is), and unknown versions are normalised', () => {
    expect(GEN_VERSION_CURRENT).toBe(3);
    expect(new TerrainGenerator(SEED).genVersion).toBe(GEN_VERSION_CURRENT);
    expect(normalizeGenVersion(undefined)).toBe(1);
    expect(normalizeGenVersion('x')).toBe(1);
    expect(normalizeGenVersion(0)).toBe(1);
    expect(normalizeGenVersion(99)).toBe(GEN_VERSION_CURRENT);
  });
});

describe.each([GEN_VERSION_LEGACY, 2, 3])('TerrainGenerator determinism (version %i)', (version) => {
  it('is deterministic: same seed gives identical bytes, also from a fresh generator', () => {
    const a = generate(SEED, 1, 2, version);
    const b = generate(SEED, 1, 2, version);
    expect(b.blocks).toEqual(a.blocks);
    expect(b.biomes).toEqual(a.biomes);
  });

  it('does not depend on generation order when one generator is reused', () => {
    const gen = new TerrainGenerator(SEED, version);
    const first = new Uint8Array(CHUNK_VOLUME);
    gen.generate(4, 4, first);
    const other = new Uint8Array(CHUNK_VOLUME);
    gen.generate(-3, 9, other);
    gen.generate(5, 4, other);
    const again = new Uint8Array(CHUNK_VOLUME);
    gen.generate(4, 4, again);
    expect(again).toEqual(first);
  });

  it('produces different terrain for a different seed', () => {
    const a = generate(SEED, 0, 0, version);
    const b = generate(SEED + 1, 0, 0, version);
    expect(fnv1a(b.blocks)).not.toBe(fnv1a(a.blocks));
  });
});

/** Chunks around a few places, generated once for the structural tests below. */
const GRID = 8;
const SEEDS = [SEED, 777];
interface Sample { seed: number; cx: number; cz: number; blocks: Uint8Array; gen: TerrainGenerator }
const samples: Sample[] = [];
function allSamples(): Sample[] {
  if (samples.length) return samples;
  for (const seed of SEEDS) {
    const gen = new TerrainGenerator(seed, 2);
    for (let cz = 0; cz < GRID; cz++) {
      for (let cx = 0; cx < GRID; cx++) {
        const blocks = new Uint8Array(CHUNK_VOLUME);
        gen.generate(cx - 3, cz + 9, blocks);
        samples.push({ seed, cx: cx - 3, cz: cz + 9, blocks, gen });
      }
    }
  }
  return samples;
}

const at = (b: Uint8Array, x: number, y: number, z: number) => b[blockIndex(x, y, z)];

describe('TerrainGenerator version 2 caves', () => {
  it('never carves bedrock or the bottom layers', () => {
    for (const { blocks } of allSamples()) {
      for (let z = 0; z < 16; z++) {
        for (let x = 0; x < 16; x++) {
          expect(at(blocks, x, 0, z)).toBe(BLOCK.BEDROCK);
          for (let y = 1; y < 5; y++) {
            const b = at(blocks, x, y, z);
            expect(b === BLOCK.AIR || b === BLOCK.WATER || b === BLOCK.LAVA).toBe(false);
          }
        }
      }
    }
  });

  it('keeps the sea floor and the shore closed: no air under the sea, no sea water next to air', () => {
    let seaWater = 0, violations = 0;
    for (const { blocks, gen, cx, cz } of allSamples()) {
      for (let z = 0; z < 16; z++) {
        for (let x = 0; x < 16; x++) {
          const h = Math.floor(gen.heightAt(cx * 16 + x, cz * 16 + z));
          if (h >= SEA_LEVEL) continue;
          for (let y = Math.max(1, h - 2); y <= SEA_LEVEL; y++) {
            if (at(blocks, x, y, z) === BLOCK.AIR) violations++;
            if (y <= h) continue;
            seaWater++;
            if (x > 0 && at(blocks, x - 1, y, z) === BLOCK.AIR) violations++;
            if (x < 15 && at(blocks, x + 1, y, z) === BLOCK.AIR) violations++;
            if (z > 0 && at(blocks, x, y, z - 1) === BLOCK.AIR) violations++;
            if (z < 15 && at(blocks, x, y, z + 1) === BLOCK.AIR) violations++;
          }
        }
      }
    }
    expect(seaWater).toBeGreaterThan(1000);
    expect(violations).toBe(0);
  });

  it('only fills caves with lava in the bottom layers (no lava near the surface)', () => {
    let lava = 0, high = 0;
    for (const { blocks } of allSamples()) {
      for (let i = 0; i < blocks.length; i++) {
        if (blocks[i] !== BLOCK.LAVA) continue;
        if (i >> 8 <= 10) lava++; else high++;
      }
    }
    expect(high).toBe(0);
    expect(lava).toBeGreaterThan(0);
  });

  it('opens caves to the surface: cave mouths and ravines exist', () => {
    let land = 0, openings = 0, deepCuts = 0;
    for (const { blocks, gen, cx, cz } of allSamples()) {
      let landCols = 0, chunkOpenings = 0;
      for (let z = 0; z < 16; z++) {
        for (let x = 0; x < 16; x++) {
          const h = Math.floor(gen.heightAt(cx * 16 + x, cz * 16 + z));
          if (h < SEA_LEVEL) continue;
          landCols++;
          if (at(blocks, x, h, z) !== BLOCK.AIR) continue;
          let run = 0;
          while (h - run > 0 && at(blocks, x, h - run, z) === BLOCK.AIR) run++;
          if (run >= 3) chunkOpenings++;
          if (run >= 20) deepCuts++;
        }
      }
      if (landCols > 128) { land++; if (chunkOpenings > 0) openings++; }
    }
    // Version 1 had ~13 chunks in 100 with an opening, version 2 has several times that.
    expect(openings / land).toBeGreaterThan(0.2);
    expect(deepCuts).toBeGreaterThan(10);
  });

  it('has underground water and big caverns', () => {
    let water = 0, bigAir = 0;
    for (const { blocks, gen, cx, cz } of allSamples()) {
      for (let z = 0; z < 16; z++) {
        for (let x = 0; x < 16; x++) {
          if (gen.heightAt(cx * 16 + x, cz * 16 + z) < SEA_LEVEL) continue;
          for (let y = 11; y < SEA_LEVEL - 12; y++) {
            const b = at(blocks, x, y, z);
            if (b === BLOCK.WATER) water++;
            if (b === BLOCK.AIR && at(blocks, x, y + 1, z) === BLOCK.AIR && at(blocks, x, y + 2, z) === BLOCK.AIR && at(blocks, x, y + 3, z) === BLOCK.AIR) bigAir++;
          }
        }
      }
    }
    expect(water).toBeGreaterThan(500);
    expect(bigAir).toBeGreaterThan(5000);
  });

  it('agrees with itself at the surface: surfaceOpen() is exactly "the surface block is gone"', () => {
    for (const { blocks, gen, cx, cz } of allSamples().filter((_, i) => i % 3 === 0)) {
      for (let z = 0; z < 16; z++) {
        for (let x = 0; x < 16; x++) {
          const h = Math.floor(gen.heightAt(cx * 16 + x, cz * 16 + z));
          const b = at(blocks, x, h, z);
          // A neighbouring tree's leaves may hang over a hole: still "gone".
          const gone = b === BLOCK.AIR || b === BLOCK.OAK_LEAVES || b === BLOCK.BIRCH_LEAVES || b === BLOCK.SPRUCE_LEAVES;
          expect(gen.surfaceOpen(cx * 16 + x, cz * 16 + z)).toBe(gone);
        }
      }
    }
  });

  it('carvedAt() (used for neighbouring columns) matches the generated blocks everywhere, also on chunk borders', () => {
    let carved = 0, checked = 0, mismatches = 0;
    for (const { blocks, gen, cx, cz } of allSamples().filter((_, i) => i % 4 === 1)) {
      for (let z = 0; z < 16; z += 5) {
        for (let x = 0; x < 16; x += (z % 2 ? 5 : 15)) {
          const wx = cx * 16 + x, wz = cz * 16 + z;
          const h = Math.floor(gen.heightAt(wx, wz));
          const mn = Math.floor(Math.min(gen.heightAt(wx + 1, wz), gen.heightAt(wx - 1, wz), gen.heightAt(wx, wz + 1), gen.heightAt(wx, wz - 1)));
          for (let y = 5; y < h; y++) {
            const b = at(blocks, x, y, z);
            if (b === BLOCK.WATER && h < SEA_LEVEL && y > h) continue;
            const isCarved = b === BLOCK.AIR || b === BLOCK.WATER || b === BLOCK.LAVA;
            checked++;
            if (isCarved) carved++;
            if (gen.carver!.carvedAt(wx, y, wz, h, mn) !== isCarved) mismatches++;
          }
        }
      }
    }
    expect(carved).toBeGreaterThan(500);
    expect(checked).toBeGreaterThan(5000);
    expect(mismatches).toBe(0);
  });

  it('leaves no tree or cactus floating over a hole', () => {
    const solid = (b: number) => b !== BLOCK.AIR && b !== BLOCK.WATER && b !== BLOCK.LAVA
      && b !== BLOCK.OAK_LEAVES && b !== BLOCK.BIRCH_LEAVES && b !== BLOCK.SPRUCE_LEAVES
      && b !== BLOCK.OAK_LOG && b !== BLOCK.BIRCH_LOG && b !== BLOCK.SPRUCE_LOG && b !== BLOCK.CACTUS
      && b !== BLOCK.TALL_GRASS && b !== BLOCK.DANDELION && b !== BLOCK.POPPY;
    const trunk = (b: number) => b === BLOCK.OAK_LOG || b === BLOCK.BIRCH_LOG || b === BLOCK.SPRUCE_LOG || b === BLOCK.CACTUS;
    let trunks = 0;
    for (const { blocks } of allSamples()) {
      for (let z = 0; z < 16; z++) {
        for (let x = 0; x < 16; x++) {
          for (let y = 2; y < CHUNK_HEIGHT; y++) {
            if (!trunk(at(blocks, x, y, z)) || trunk(at(blocks, x, y - 1, z))) continue;
            trunks++;
            expect(solid(at(blocks, x, y - 1, z))).toBe(true);
          }
        }
      }
    }
    expect(trunks).toBeGreaterThan(100);
  });
});

describe('TerrainGenerator version 2 ores', () => {
  it('places ore blobs of all four ores at plausible heights, and only inside stone', () => {
    const counts = new Map<number, number>();
    const maxY = new Map<number, number>();
    for (const { blocks } of allSamples()) {
      for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];
        if (b < BLOCK.COAL_ORE || b > BLOCK.DIAMOND_ORE) continue;
        counts.set(b, (counts.get(b) ?? 0) + 1);
        maxY.set(b, Math.max(maxY.get(b) ?? 0, i >> 8));
      }
    }
    for (const id of [BLOCK.COAL_ORE, BLOCK.IRON_ORE, BLOCK.GOLD_ORE, BLOCK.DIAMOND_ORE]) expect(counts.get(id)).toBeGreaterThan(0);
    // Rarity order like Minecraft: coal > iron > gold, diamond rarer than coal.
    expect(counts.get(BLOCK.COAL_ORE)!).toBeGreaterThan(counts.get(BLOCK.IRON_ORE)!);
    expect(counts.get(BLOCK.IRON_ORE)!).toBeGreaterThan(counts.get(BLOCK.GOLD_ORE)!);
    expect(counts.get(BLOCK.COAL_ORE)!).toBeGreaterThan(counts.get(BLOCK.DIAMOND_ORE)!);
    expect(maxY.get(BLOCK.DIAMOND_ORE)!).toBeLessThan(45);
    expect(maxY.get(BLOCK.GOLD_ORE)!).toBeLessThan(55);
  });

  it('puts ores in blobs, not single blocks, and lets blobs cross chunk borders', () => {
    let blobbed = 0, ores = 0, crossing = 0;
    const isOre = (b: number) => b === BLOCK.COAL_ORE || b === BLOCK.IRON_ORE;
    const bySeed = allSamples().filter((s) => s.seed === SEED);
    const byPos = new Map(bySeed.map((s) => [`${s.cx},${s.cz}`, s.blocks]));
    for (const { blocks, cx, cz } of bySeed) {
      const east = byPos.get(`${cx + 1},${cz}`);
      for (let y = 5; y < 90; y++) {
        for (let z = 0; z < 16; z++) {
          for (let x = 0; x < 16; x++) {
            const b = at(blocks, x, y, z);
            if (!isOre(b)) continue;
            ores++;
            if (x < 15 && at(blocks, x + 1, y, z) === b) blobbed++;
            else if (x === 15 && east && at(east, 0, y, z) === b) { blobbed++; crossing++; }
          }
        }
      }
    }
    expect(blobbed / ores).toBeGreaterThan(0.4);
    expect(crossing).toBeGreaterThan(0);
  });

  it('skips table rows of blocks that do not exist yet or that need a newer generator', () => {
    const active = resolveOres(2);
    expect(active.length).toBeGreaterThan(5);
    expect(active.length).toBeLessThan(ORE_TABLE.length);
    for (const o of active) expect(o.spec.minGen ?? 2).toBeLessThanOrEqual(2);
    expect(resolveOres(1)).toHaveLength(0 + resolveOres(1).length);
  });
});
