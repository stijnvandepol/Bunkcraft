import { BLOCK, CUBE_ID } from './BlockRegistry';
import { CHUNK_HEIGHT, CHUNK_SIZE, blockIndex } from './constants';
import { BIOME } from './Biomes';
import { hash2, mulberry32 } from './Noise';

/**
 * Surface structures of generator version 3: a registry of features with chunk-seeded anchors.
 *
 * A feature is anchored in one chunk (the anchor chunk) and may reach into the chunks around it. Every chunk that
 * is generated replays the features of itself and its neighbours within `reachChunks` and keeps only the blocks that
 * land inside itself, exactly like the ore blobs (OreTable.ts). So a structure that crosses chunk borders is built
 * identically from every side and does not depend on the order chunks are generated in.
 *
 * To add a structure (village, dungeon, mineshaft, ...):
 *  1. write a `StructureFeature` (see `desertWell` below),
 *  2. add it at the END of `STRUCTURE_FEATURES` (the list index is part of the random stream, so a new feature
 *     never changes the others),
 *  3. give it `minGen` = the generator version that introduces it: a feature that appears in an old version would
 *     change existing worlds. Bump GEN_VERSION_CURRENT in the same change.
 *
 * Everything a feature needs from the world goes through `StructureTarget`: world coordinates; writes outside the chunk
 * being generated are ignored and `get` returns AIR there. Features must therefore decide where and how to build with
 * `ctx` (a pure function of the seed and the position, valid for any column) and never on blocks they read: a block
 * read in this chunk can differ from the one the neighbouring chunk sees.
 */
export interface StructureContext {
  readonly seed: number;
  /** Height of the surface (top solid block) of the column at world position (x, z), before caves are carved. */
  heightAt(x: number, z: number): number;
  biomeAt(x: number, z: number): number;
}

export interface StructureTarget {
  readonly ctx: StructureContext;
  /** The chunk being generated. */
  readonly cx: number;
  readonly cz: number;
  /** Writes a block (and an optional state byte) at world coordinates; ignored outside the chunk or the height range. */
  set(x: number, y: number, z: number, id: number, meta?: number): void;
  /** Reads a block at world coordinates (AIR outside the chunk). */
  get(x: number, y: number, z: number): number;
}

export interface StructureFeature {
  readonly id: string;
  /** Mixed into the random stream of the feature; keep it unique. */
  readonly salt: number;
  /** How many chunks around the anchor chunk the structure can reach (0 = stays inside its chunk). */
  readonly reachChunks: number;
  /** First generator version that builds it. */
  readonly minGen: number;
  /**
   * Is the anchor chunk (acx, acz) hosting this feature? Returns the world position (x, z) of its origin or null.
   * `rng` is seeded from (world seed, salt, acx, acz); the draw order is part of the world format.
   */
  anchor(acx: number, acz: number, rng: () => number, ctx: StructureContext): { x: number; z: number } | null;
  /** Builds the structure at origin (ax, az); `rng` starts in the same state for every chunk that calls it. */
  place(target: StructureTarget, ax: number, az: number, rng: () => number): void;
}

/** Desert well: a 5×5 sandstone floor, a 3×3 basin of water, four pillars and a slab roof. */
export const desertWell: StructureFeature = {
  id: 'desert_well',
  salt: 0x57e11,
  reachChunks: 1,
  minGen: 3,
  anchor(acx, acz, rng, ctx) {
    if (rng() > 0.045) return null;
    const x = acx * CHUNK_SIZE + 2 + Math.floor(rng() * 12);
    const z = acz * CHUNK_SIZE + 2 + Math.floor(rng() * 12);
    if (ctx.biomeAt(x, z) !== BIOME.DESERT) return null;
    // Flat ground only: the 5×5 floor must sit on one level.
    const h = ctx.heightAt(x, z);
    for (let dz = -2; dz <= 2; dz += 2) {
      for (let dx = -2; dx <= 2; dx += 2) {
        if (ctx.heightAt(x + dx, z + dz) !== h || ctx.biomeAt(x + dx, z + dz) !== BIOME.DESERT) return null;
      }
    }
    return { x, z };
  },
  place(t, ax, az) {
    const h = t.ctx.heightAt(ax, az);
    const S = BLOCK.SANDSTONE;
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        // Floor with a foundation, and clear air above (cacti, dead bushes).
        t.set(ax + dx, h, az + dz, S);
        t.set(ax + dx, h - 1, az + dz, S);
        for (let y = h + 1; y <= h + 4; y++) t.set(ax + dx, y, az + dz, BLOCK.AIR);
      }
    }
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const centre = dx === 0 && dz === 0;
        t.set(ax + dx, h, az + dz, centre ? BLOCK.WATER : S);
        if (centre) { t.set(ax, h - 1, az, BLOCK.WATER); t.set(ax, h - 2, az, BLOCK.WATER); }
        if (Math.abs(dx) === 1 && Math.abs(dz) === 1) { t.set(ax + dx, h + 1, az + dz, S); t.set(ax + dx, h + 2, az + dz, S); }
        t.set(ax + dx, h + 3, az + dz, BLOCK.SANDSTONE_SLAB);
      }
    }
  },
};

/** A mossy boulder of the taiga: a lumpy blob of mossy cobblestone, sunk a little into the ground. */
export const taigaBoulder: StructureFeature = {
  id: 'taiga_boulder',
  salt: 0xb0d1e2,
  reachChunks: 1,
  minGen: 3,
  anchor(acx, acz, rng, ctx) {
    if (rng() > 0.16) return null;
    const x = acx * CHUNK_SIZE + Math.floor(rng() * CHUNK_SIZE);
    const z = acz * CHUNK_SIZE + Math.floor(rng() * CHUNK_SIZE);
    const b = ctx.biomeAt(x, z);
    return b === BIOME.TAIGA || b === BIOME.SNOWY_TAIGA ? { x, z } : null;
  },
  place(t, ax, az, rng) {
    const h = t.ctx.heightAt(ax, az);
    const r = 1 + Math.floor(rng() * 2);
    const replaceable = (b: number) => b === BLOCK.AIR || b === BLOCK.TALL_GRASS || b === BLOCK.GRASS || b === BLOCK.SNOWY_GRASS
      || b === BLOCK.DIRT || b === CUBE_ID.podzol || b === CUBE_ID.fern;
    for (let dy = -1; dy <= r; dy++) {
      const rr = r - Math.max(0, dy) * 0.55;
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          const d = Math.sqrt(dx * dx + dz * dz + (dy < 0 ? 0 : dy * dy * 0.6));
          // The random draw is made for every cell, so the shape never depends on which chunk evaluates it.
          const jitter = rng() * 0.3;
          if (d > rr + 0.3 + jitter) continue;
          if (replaceable(t.get(ax + dx, h + 1 + dy, az + dz))) t.set(ax + dx, h + 1 + dy, az + dz, BLOCK.MOSSY_COBBLESTONE);
        }
      }
    }
  },
};

/** APPEND-ONLY: the index is part of the random stream. */
export const STRUCTURE_FEATURES: readonly StructureFeature[] = [desertWell, taigaBoulder];

/**
 * Builds every feature that reaches chunk (cx, cz). `blocks` and `meta` are the chunk's arrays; `onMeta` is called
 * when a feature wrote a non-zero state byte, so the generator knows the chunk needs its state array.
 */
export function placeStructures(
  blocks: Uint8Array, meta: Uint8Array, onMeta: () => void,
  ctx: StructureContext, cx: number, cz: number, genVersion: number,
): void {
  const ox = cx * CHUNK_SIZE, oz = cz * CHUNK_SIZE;
  const target: StructureTarget = {
    ctx, cx, cz,
    set(x, y, z, id, m = 0) {
      const lx = x - ox, lz = z - oz;
      if (lx < 0 || lx >= CHUNK_SIZE || lz < 0 || lz >= CHUNK_SIZE || y < 0 || y >= CHUNK_HEIGHT) return;
      const i = blockIndex(lx, y, lz);
      blocks[i] = id;
      if (m !== 0) { onMeta(); meta[i] = m; } else meta[i] = 0;
    },
    get(x, y, z) {
      const lx = x - ox, lz = z - oz;
      if (lx < 0 || lx >= CHUNK_SIZE || lz < 0 || lz >= CHUNK_SIZE || y < 0 || y >= CHUNK_HEIGHT) return BLOCK.AIR;
      return blocks[blockIndex(lx, y, lz)];
    },
  };
  STRUCTURE_FEATURES.forEach((f, index) => {
    if (f.minGen > genVersion) return;
    const r = f.reachChunks;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const acx = cx + dx, acz = cz + dz;
        const streamSeed = (hash2(ctx.seed ^ Math.imul(f.salt + index, 0x9e3779b1), acx, acz) * 4294967296) >>> 0;
        const at = f.anchor(acx, acz, mulberry32(streamSeed), ctx);
        if (at) f.place(target, at.x, at.z, mulberry32(streamSeed ^ 0x5bd1e995));
      }
    }
  });
}
