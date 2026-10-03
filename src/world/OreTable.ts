import { BLOCK } from './BlockRegistry';
import { CHUNK_HEIGHT, CHUNK_SIZE, blockIndex } from './constants';
import { hash2, hash3, mulberry32 } from './Noise';

/**
 * Ore distribution of generator version 2: Minecraft 1.21-style blobs ("veins") from one table.
 *
 * Heights are ours (world 0..127, sea level 62). Minecraft's y -64..320 maps onto ours with
 * roughly y_ours = (y_mc + 64) * 0.49 underground, e.g. its diamond range -64..16 is our 0..39, and
 * `attempts` follow Minecraft's attempts-per-layer: the veins keep their size while a layer of ours is
 * "worth" two of theirs, so the ore fraction of the rock stays about equal.
 *
 * To add an ore: add a row. `block` is a key of BLOCK; rows whose block does not exist (yet) are
 * skipped, so rows for upcoming content can already be here. A row only runs for generator versions
 * >= `minGen`: when a new ore is added to a game that already has v2 worlds, give it minGen: 3 and bump
 * GEN_VERSION_CURRENT, otherwise existing worlds would grow ore (and change) on chunks they have not
 * visited yet. Rows for ids that exist today keep minGen 2.
 */
export interface OreSpec {
  /** Key of BLOCK. */
  block: string;
  /** Blob attempts per chunk; fractions are a probability (0.11 = one chunk in nine). */
  attempts: number;
  /** Maximum blocks per blob (Minecraft's vein size, 4..33). */
  size: number;
  minY: number;
  maxY: number;
  /** uniform = flat over the range, triangle = densest in the middle of the range. */
  shape: 'uniform' | 'triangle';
  /** Chance that a block touching air (cave wall inside this chunk) is skipped; 1 = buried ores only. */
  discardOnAir?: number;
  /** BLOCK key replaced by the ore; stone by default. */
  host?: string;
  /** First generator version that places this ore (default 2). */
  minGen?: number;
}

export const ORE_TABLE: readonly OreSpec[] = [
  // Coal: the most common ore, up to high altitude (Minecraft: 20 × size 17 at y 0..192, 30 × size 17 above 136).
  { block: 'COAL_ORE', attempts: 6, size: 17, minY: 8, maxY: 110, shape: 'uniform', discardOnAir: 0.5 },
  { block: 'COAL_ORE', attempts: 4, size: 17, minY: 90, maxY: 127, shape: 'uniform' },
  // Iron: small veins everywhere, medium veins at mid depth, big ones in the mountains.
  { block: 'IRON_ORE', attempts: 6, size: 9, minY: 14, maxY: 62, shape: 'triangle' },
  { block: 'IRON_ORE', attempts: 6, size: 4, minY: 1, maxY: 70, shape: 'uniform' },
  { block: 'IRON_ORE', attempts: 8, size: 9, minY: 70, maxY: 127, shape: 'triangle' },
  // Gold: low (Minecraft -64..32), a bit more at the very bottom.
  { block: 'GOLD_ORE', attempts: 1.5, size: 9, minY: 1, maxY: 47, shape: 'triangle', discardOnAir: 0.5 },
  { block: 'GOLD_ORE', attempts: 0.3, size: 9, minY: 1, maxY: 10, shape: 'uniform' },
  // Diamond: only the lowest layers; small, medium, rare large and buried (never touching air).
  { block: 'DIAMOND_ORE', attempts: 2, size: 4, minY: 1, maxY: 38, shape: 'triangle', discardOnAir: 0.5 },
  { block: 'DIAMOND_ORE', attempts: 0.5, size: 8, minY: 1, maxY: 24, shape: 'uniform' },
  { block: 'DIAMOND_ORE', attempts: 0.08, size: 12, minY: 1, maxY: 38, shape: 'triangle', discardOnAir: 0.7 },
  { block: 'DIAMOND_ORE', attempts: 1, size: 8, minY: 1, maxY: 38, shape: 'triangle', discardOnAir: 1 },
  // Filler blobs of other blocks inside the stone (Minecraft: gravel 14 and dirt 7 attempts of size 33).
  { block: 'GRAVEL', attempts: 3, size: 24, minY: 5, maxY: 110, shape: 'uniform' },
  { block: 'DIRT', attempts: 3, size: 24, minY: 14, maxY: 110, shape: 'uniform' },

  // ---- Upcoming content (inactive until the block exists AND GEN_VERSION_CURRENT >= minGen). ----
  // Minecraft: lapis 2 × 7 triangle -32..32 plus 4 × 7 buried; redstone 4 × 8 below 15 plus 8 × 8 triangle -96..32;
  // copper 16 × 10 triangle -16..112; emerald single blocks in mountains.
  { block: 'LAPIS_ORE', attempts: 1.5, size: 7, minY: 8, maxY: 46, shape: 'triangle', discardOnAir: 1, minGen: 3 },
  { block: 'REDSTONE_ORE', attempts: 3, size: 8, minY: 1, maxY: 36, shape: 'uniform', minGen: 3 },
  { block: 'REDSTONE_ORE', attempts: 4, size: 8, minY: 1, maxY: 30, shape: 'triangle', minGen: 3 },
  { block: 'COPPER_ORE', attempts: 5, size: 10, minY: 24, maxY: 80, shape: 'triangle', minGen: 3 },
  { block: 'EMERALD_ORE', attempts: 6, size: 1, minY: 60, maxY: 127, shape: 'triangle', minGen: 3 },
];

interface ResolvedOre {
  spec: OreSpec;
  id: number;
  host: number;
  /** Index in the table: part of the random stream key, so adding rows never changes the others. */
  index: number;
  /** How far a blob can reach from its origin, in blocks. */
  reach: number;
}

const BLOCKS = BLOCK as unknown as Record<string, number>;

/** The rows that exist for a generator version (unknown blocks skipped). */
export function resolveOres(genVersion: number): ResolvedOre[] {
  const out: ResolvedOre[] = [];
  ORE_TABLE.forEach((spec, index) => {
    if ((spec.minGen ?? 2) > genVersion) return;
    const id = BLOCKS[spec.block];
    const host = BLOCKS[spec.host ?? 'STONE'];
    if (id === undefined || host === undefined) return;
    out.push({ spec, id, host, index, reach: spec.size / 8 + spec.size / 16 + 2 });
  });
  return out;
}

/**
 * Places the ore blobs that touch chunk (cx, cz). Every chunk replays the attempts of itself and its
 * 8 neighbours (a blob never reaches further than 8 blocks) and keeps only the blocks inside itself, so
 * blobs cross chunk borders seamlessly and do not depend on generation order. Only host blocks (stone)
 * are replaced, which also means ores show up in cave walls.
 */
export function placeOreBlobs(blocks: Uint8Array, seed: number, cx: number, cz: number, ores: readonly ResolvedOre[]): void {
  const ox = cx * CHUNK_SIZE, oz = cz * CHUNK_SIZE;
  for (let dcz = -1; dcz <= 1; dcz++) {
    for (let dcx = -1; dcx <= 1; dcx++) {
      const ncx = cx + dcx, ncz = cz + dcz;
      for (const ore of ores) {
        const s = ore.spec;
        const rand = mulberry32((hash2(seed ^ Math.imul(ore.index + 1, 0x9e3779b1), ncx, ncz) * 4294967296) >>> 0);
        let n = Math.floor(s.attempts);
        if (rand() < s.attempts - n) n++;
        for (let a = 0; a < n; a++) {
          const bx = ncx * CHUNK_SIZE + rand() * CHUNK_SIZE;
          const bz = ncz * CHUNK_SIZE + rand() * CHUNK_SIZE;
          const span = s.maxY - s.minY;
          const by = s.shape === 'uniform'
            ? s.minY + rand() * span
            : s.minY + (rand() + rand()) * 0.5 * span;
          // The blob's random numbers are always drawn, so its shape never depends on who evaluates it.
          const angle = rand() * Math.PI;
          const dy1 = rand() * 3 - 2, dy2 = rand() * 3 - 2;
          if (bx + ore.reach < ox || bx - ore.reach > ox + CHUNK_SIZE || bz + ore.reach < oz || bz - ore.reach > oz + CHUNK_SIZE) {
            // Still advance the stream by the per-sphere draws so later attempts of this row stay identical.
            for (let i = 0; i < s.size; i++) rand();
            continue;
          }
          const sx = Math.sin(angle) * s.size / 8, sz = Math.cos(angle) * s.size / 8;
          for (let i = 0; i < s.size; i++) {
            const t = i / (s.size - 1 || 1);
            const r = ((Math.sin(Math.PI * t) + 1) * rand() * s.size / 16 + 1) / 2;
            const px = bx + sx * (1 - 2 * t), pz = bz + sz * (1 - 2 * t);
            const py = by + dy1 + (dy2 - dy1) * t;
            fillSphere(blocks, seed, ox, oz, px, py, pz, r, ore);
          }
        }
      }
    }
  }
}

function fillSphere(
  blocks: Uint8Array, seed: number, ox: number, oz: number,
  px: number, py: number, pz: number, r: number, ore: ResolvedOre,
): void {
  const x0 = Math.max(ox, Math.floor(px - r)), x1 = Math.min(ox + CHUNK_SIZE - 1, Math.floor(px + r));
  const z0 = Math.max(oz, Math.floor(pz - r)), z1 = Math.min(oz + CHUNK_SIZE - 1, Math.floor(pz + r));
  const y0 = Math.max(1, Math.floor(py - r)), y1 = Math.min(CHUNK_HEIGHT - 2, Math.floor(py + r));
  if (x0 > x1 || z0 > z1 || y0 > y1) return;
  const discard = ore.spec.discardOnAir ?? 0;
  const inv = 1 / (r * r);
  for (let y = y0; y <= y1; y++) {
    const dy = y + 0.5 - py;
    for (let z = z0; z <= z1; z++) {
      const dz = z + 0.5 - pz;
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - px;
        if ((dx * dx + dy * dy + dz * dz) * inv >= 1) continue;
        const lx = x - ox, lz = z - oz;
        const i = blockIndex(lx, y, lz);
        if (blocks[i] !== ore.host) continue;
        if (discard > 0 && touchesAir(blocks, lx, y, lz) && (discard >= 1 || hash3(seed + 5, x, y, z) < discard)) continue;
        blocks[i] = ore.id;
      }
    }
  }
}

/** Air next to a block, inside the chunk only (the neighbour chunk is not known here). */
function touchesAir(blocks: Uint8Array, x: number, y: number, z: number): boolean {
  if (x > 0 && blocks[blockIndex(x - 1, y, z)] === BLOCK.AIR) return true;
  if (x < CHUNK_SIZE - 1 && blocks[blockIndex(x + 1, y, z)] === BLOCK.AIR) return true;
  if (z > 0 && blocks[blockIndex(x, y, z - 1)] === BLOCK.AIR) return true;
  if (z < CHUNK_SIZE - 1 && blocks[blockIndex(x, y, z + 1)] === BLOCK.AIR) return true;
  return blocks[blockIndex(x, y - 1, z)] === BLOCK.AIR || blocks[blockIndex(x, y + 1, z)] === BLOCK.AIR;
}
