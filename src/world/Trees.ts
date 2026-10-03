import { BLOCK, CUBE_ID } from './BlockRegistry';
import { hash3 } from './Noise';

/**
 * Tree shapes, shared by world generation (TerrainGenerator, which places them into a chunk array) and plant growth
 * (a sapling that grows, see Growth.ts). A shape only talks to a TreeSink, so it does not care whether it writes into
 * a chunk buffer or into the live world.
 *
 * `oakTree` and `spruceTree` are the original generator shapes moved here unchanged (the golden hashes of
 * generator versions 1 and 2 pin their output). The other species (jungle, acacia, dark oak, cherry) are small
 * shapes for grown trees; nothing generates them yet.
 */

export interface TreeSink {
  /** Leaves: replaces air and small plants, never anything else. */
  leaf(x: number, y: number, z: number, id: number): void;
  /** Trunk: replaces air, leaves and small plants. */
  log(x: number, y: number, z: number, id: number): void;
  /** The ground under the trunk at (x, y, z) turns from grass into dirt. */
  trunkBase(x: number, y: number, z: number): void;
}

/** Classic blob tree (oak/birch). (x, z) may be chunk-local; (wx, wz) are the world coordinates that seed the corner noise. */
export function oakTree(
  sink: TreeSink, seed: number, x: number, y: number, z: number, height: number,
  log: number, leaves: number, wx: number, wz: number, chunkHeight: number,
): void {
  if (y + height + 1 >= chunkHeight) return;
  const top = y + height - 1;
  for (let ly = top - 2; ly <= top + 1; ly++) {
    const r = ly >= top ? 1 : 2;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const corner = Math.abs(dx) === r && Math.abs(dz) === r;
        if (corner && (ly === top + 1 || hash3(seed + 31, wx + dx, ly, wz + dz) < 0.5)) continue;
        sink.leaf(x + dx, ly, z + dz, leaves);
      }
    }
  }
  for (let i = 0; i < height; i++) sink.log(x, y + i, z, log);
  sink.trunkBase(x, y, z);
}

export function spruceTree(sink: TreeSink, x: number, y: number, z: number, height: number, chunkHeight: number): void {
  if (y + height + 1 >= chunkHeight) return;
  const top = y + height;
  sink.leaf(x, top, z, BLOCK.SPRUCE_LEAVES);
  // Conical shape, alternating radii from the tip down: 1, 0, 1, 2, 1, 2, ...
  for (let ly = top - 1; ly >= y + 2; ly--) {
    const k = top - 1 - ly;
    const r = k === 0 ? 1 : k === 1 ? 0 : k % 2 === 0 ? 1 : 2;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (r > 0 && Math.abs(dx) === r && Math.abs(dz) === r) continue;
        sink.leaf(x + dx, ly, z + dz, BLOCK.SPRUCE_LEAVES);
      }
    }
  }
  for (let i = 0; i < height; i++) sink.log(x, y + i, z, BLOCK.SPRUCE_LOG);
}

// ---------------------------------------------------------------- grown trees

/** Sapling variants, in the order of the sapling block's state (see BlockRegistry: SAPLING_WOODS, mangrove has none). */
export const SAPLING_TYPES = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'cherry'] as const;
export type SaplingType = typeof SAPLING_TYPES[number];

interface Species {
  log: number;
  leaves: number;
}

/** Log and leaf block of each sapling variant. */
export function speciesOf(variant: number): Species {
  switch (SAPLING_TYPES[variant]) {
    case 'spruce': return { log: BLOCK.SPRUCE_LOG, leaves: BLOCK.SPRUCE_LEAVES };
    case 'birch': return { log: BLOCK.BIRCH_LOG, leaves: BLOCK.BIRCH_LEAVES };
    case 'jungle': return { log: CUBE_ID.jungle_log, leaves: CUBE_ID.jungle_leaves };
    case 'acacia': return { log: CUBE_ID.acacia_log, leaves: CUBE_ID.acacia_leaves };
    case 'dark_oak': return { log: CUBE_ID.dark_oak_log, leaves: CUBE_ID.dark_oak_leaves };
    case 'cherry': return { log: CUBE_ID.cherry_log, leaves: CUBE_ID.cherry_leaves };
    default: return { log: BLOCK.OAK_LOG, leaves: BLOCK.OAK_LEAVES };
  }
}

/** What a grown tree will look like: decided once from the random source, so a free-space check and the real placement agree. */
export interface TreePlan {
  variant: number;
  height: number;
  /** Acacia: the way the trunk bends, 0..3 (+X, -X, +Z, -Z). */
  dir: number;
}

const DIRS_X = [1, -1, 0, 0];
const DIRS_Z = [0, 0, 1, -1];

/** Minecraft heights: oak 4-6, birch 5-7, spruce 6-9 (here), jungle 6-9, acacia 5-6, dark oak 5-6, cherry 6-7. */
export function planTree(variant: number, rand: () => number): TreePlan {
  const pick = (min: number, max: number): number => min + Math.floor(rand() * (max - min + 1));
  const dir = Math.floor(rand() * 4);
  switch (SAPLING_TYPES[variant]) {
    case 'spruce': return { variant, height: pick(6, 9), dir };
    case 'birch': return { variant, height: pick(5, 7), dir };
    case 'jungle': return { variant, height: pick(6, 9), dir };
    case 'acacia': return { variant, height: pick(5, 6), dir };
    case 'dark_oak': return { variant, height: pick(5, 6), dir };
    case 'cherry': return { variant, height: pick(6, 7), dir };
    default: return { variant, height: pick(4, 6), dir };
  }
}

/** A round canopy of leaf layers around the top of a straight trunk (dark oak, cherry, jungle). */
function roundTree(sink: TreeSink, x: number, y: number, z: number, height: number, log: number, leaves: number, radius: number): void {
  const top = y + height - 1;
  // Layers from two below the top to one above: narrow, wide, wide, narrow.
  for (let ly = top - 2; ly <= top + 1; ly++) {
    const r = ly === top + 1 ? radius - 2 : ly === top - 2 ? radius - 1 : radius;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (r >= 2 && Math.abs(dx) === r && Math.abs(dz) === r) continue;
        sink.leaf(x + dx, ly, z + dz, leaves);
      }
    }
  }
  for (let i = 0; i < height; i++) sink.log(x, y + i, z, log);
  sink.trunkBase(x, y, z);
}

/** Acacia: a trunk that bends sideways near the top, under a flat canopy. */
function acaciaTree(sink: TreeSink, x: number, y: number, z: number, height: number, dir: number, log: number, leaves: number): void {
  const bend = height - 2;
  const dx = DIRS_X[dir], dz = DIRS_Z[dir];
  const cx = x + dx * 2, cz = z + dz * 2;
  const top = y + height;
  const flat = (cy: number, r: number): void => {
    for (let oz = -r; oz <= r; oz++) {
      for (let ox = -r; ox <= r; ox++) {
        if (r >= 2 && Math.abs(ox) === r && Math.abs(oz) === r) continue;
        sink.leaf(cx + ox, cy, cz + oz, leaves);
      }
    }
  };
  flat(top, 2);
  flat(top + 1, 1);
  for (let i = 0; i <= bend; i++) sink.log(x, y + i, z, log);
  sink.log(x + dx, y + bend + 1, z + dz, log);
  sink.log(cx, y + bend + 2, cz, log);
  if (bend + 3 < height) sink.log(cx, y + bend + 3, cz, log);
  sink.trunkBase(x, y, z);
}

/** Places a grown tree whose trunk starts at (x, y) (the sapling's own cell). `seed` only feeds the blob corner noise. */
export function placeTree(sink: TreeSink, plan: TreePlan, x: number, y: number, z: number, chunkHeight: number, seed = 0): void {
  const { log, leaves } = speciesOf(plan.variant);
  switch (SAPLING_TYPES[plan.variant]) {
    case 'spruce': spruceTree(sink, x, y, z, plan.height, chunkHeight); sink.trunkBase(x, y, z); break;
    case 'jungle': if (y + plan.height + 2 < chunkHeight) roundTree(sink, x, y, z, plan.height, log, leaves, 2); break;
    case 'dark_oak': if (y + plan.height + 2 < chunkHeight) roundTree(sink, x, y, z, plan.height, log, leaves, 3); break;
    case 'cherry': if (y + plan.height + 2 < chunkHeight) roundTree(sink, x, y, z, plan.height, log, leaves, 3); break;
    case 'acacia': if (y + plan.height + 3 < chunkHeight) acaciaTree(sink, x, y, z, plan.height, plan.dir, log, leaves); break;
    default: oakTree(sink, seed, x, y, z, plan.height, log, leaves, x, z, chunkHeight);
  }
}
