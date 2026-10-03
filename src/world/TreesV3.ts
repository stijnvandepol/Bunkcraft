import { BLOCK, CUBE_ID } from './BlockRegistry';
import { CHUNK_HEIGHT, blockIndex } from './constants';
import { CUBES } from './Content';
import { hash3 } from './Noise';
import { type TreeSink, oakTree, spruceTree } from './Trees';

/**
 * Generated tree shapes of generator version 3: jungle, acacia, dark oak and cherry (big, world-generation variants;
 * sapling growth uses the smaller shapes in Trees.ts), plus oak/birch/spruce through the shared shapes of Trees.ts.
 *
 * Every leaf is at most 6 steps (through leaves) from a log, so leaf decay (Growth.ts) keeps them (Vitest). Every shape is a pure function of
 * its (world) trunk position and parameters: chunks that share a tree each build their own part of it and agree.
 * Coordinates (x, y, z) are chunk-local and may lie outside 0..15; blocks outside the chunk are skipped.
 */

const IS_PLANT = new Uint8Array(256);
const IS_LEAVES = new Uint8Array(256);
for (const id of [BLOCK.TALL_GRASS, BLOCK.DANDELION, BLOCK.POPPY, BLOCK.DEAD_BUSH]) IS_PLANT[id] = 1;
for (const id of [BLOCK.OAK_LEAVES, BLOCK.BIRCH_LEAVES, BLOCK.SPRUCE_LEAVES]) IS_LEAVES[id] = 1;
for (const spec of CUBES) {
  const id = CUBE_ID[spec.name];
  if (spec.kind === 'plant' || spec.kind === 'cobweb') IS_PLANT[id] = 1;
  if (spec.kind === 'leaves' || spec.kind === 'cherry_leaves') IS_LEAVES[id] = 1;
}

/** Blocks a leaf or log may grow into. */
export function isReplaceablePlant(id: number): boolean {
  return IS_PLANT[id] === 1;
}

export class TreeBuilder implements TreeSink {
  constructor(private readonly seed: number, public blocks: Uint8Array) {}

  leaf(x: number, y: number, z: number, id: number): void {
    if (x < 0 || x >= 16 || z < 0 || z >= 16 || y < 0 || y >= CHUNK_HEIGHT) return;
    const i = blockIndex(x, y, z);
    const cur = this.blocks[i];
    if (cur === BLOCK.AIR || IS_PLANT[cur]) this.blocks[i] = id;
  }

  log(x: number, y: number, z: number, id: number): void {
    if (x < 0 || x >= 16 || z < 0 || z >= 16 || y < 0 || y >= CHUNK_HEIGHT) return;
    const i = blockIndex(x, y, z);
    const cur = this.blocks[i];
    if (cur === BLOCK.AIR || IS_PLANT[cur] || IS_LEAVES[cur]) this.blocks[i] = id;
  }

  /** Dirt under the trunk, like Minecraft (only when the trunk column is inside this chunk). */
  trunkBase(x: number, y: number, z: number): void {
    this.soil(x, y, z);
  }

  private soil(x: number, y: number, z: number): void {
    if (x < 0 || x >= 16 || z < 0 || z >= 16 || y <= 0) return;
    const i = blockIndex(x, y - 1, z);
    const b = this.blocks[i];
    if (b === BLOCK.GRASS || b === BLOCK.SNOWY_GRASS) this.blocks[i] = BLOCK.DIRT;
  }

  private rand(wx: number, y: number, wz: number, salt: number): number {
    return hash3(this.seed + salt, wx, y, wz);
  }

  /** Round leaf layer of radius r with randomly dropped corners. */
  private disc(x: number, y: number, z: number, r: number, id: number, wx: number, wz: number, corners: number): void {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) === r && Math.abs(dz) === r && r > 0 && this.rand(wx + dx, y, wz + dz, 31) < corners) continue;
        this.leaf(x + dx, y, z + dz, id);
      }
    }
  }

  /** Classic blob tree (oak/birch), the shared shape. */
  blob(x: number, y: number, z: number, height: number, log: number, leaves: number, wx: number, wz: number): void {
    oakTree(this, this.seed, x, y, z, height, log, leaves, wx, wz, CHUNK_HEIGHT);
  }

  spruce(x: number, y: number, z: number, height: number): void {
    spruceTree(this, x, y, z, height, CHUNK_HEIGHT);
    this.soil(x, y, z);
  }

  /** Tall jungle tree: a long trunk, a wide flat-topped crown and a few side clumps held by branches. */
  jungle(x: number, y: number, z: number, height: number, wx: number, wz: number): void {
    if (y + height + 3 >= CHUNK_HEIGHT) return;
    const LOG = CUBE_ID.jungle_log, LEAF = CUBE_ID.jungle_leaves;
    const top = y + height;
    const radii = [2, 3, 3, 2, 1];
    for (let k = 0; k < radii.length; k++) this.disc(x, top - 2 + k, z, radii[k], LEAF, wx, wz, 0.4);
    for (let i = 0; i < height; i++) this.log(x, y + i, z, LOG);
    // Branches with a clump of leaves at their end.
    const branches = 2 + Math.floor(this.rand(wx, 0, wz, 7) * 2);
    for (let b = 0; b < branches; b++) {
      const dir = Math.floor(this.rand(wx, b, wz, 9) * 4);
      const dx = dir === 0 ? 1 : dir === 1 ? -1 : 0, dz = dir === 2 ? 1 : dir === 3 ? -1 : 0;
      const by = y + Math.floor(height * (0.45 + 0.3 * this.rand(wx, b, wz, 11)));
      const len = 2;
      for (let s = 1; s <= len; s++) this.log(x + dx * s, by, z + dz * s, LOG);
      const ex = x + dx * len, ez = z + dz * len;
      for (let ly = by - 1; ly <= by + 1; ly++) this.disc(ex, ly, ez, ly === by ? 2 : 1, LEAF, wx + dx * len, wz + dz * len, 0.5);
    }
    this.soil(x, y, z);
  }

  /** Savanna tree: short trunk that bends sideways, crowned with a flat disc of leaves. */
  acacia(x: number, y: number, z: number, height: number, wx: number, wz: number): void {
    if (y + height + 3 >= CHUNK_HEIGHT) return;
    const LOG = CUBE_ID.acacia_log, LEAF = CUBE_ID.acacia_leaves;
    const dir = Math.floor(this.rand(wx, 0, wz, 13) * 4);
    const dx = dir === 0 ? 1 : dir === 1 ? -1 : 0, dz = dir === 2 ? 1 : dir === 3 ? -1 : 0;
    const straight = Math.max(2, height - 3);
    for (let i = 0; i < straight; i++) this.log(x, y + i, z, LOG);
    let px = x, pz = z, py = y + straight;
    const bend = 2 + (this.rand(wx, 1, wz, 15) < 0.5 ? 1 : 0);
    for (let s = 0; s < bend; s++) {
      px += dx; pz += dz;
      this.log(px, py, pz, LOG);
      if (s < bend - 1 || bend === 2) py++;
    }
    this.disc(px, py, pz, 2, LEAF, wx + dx * bend, wz + dz * bend, 0.5);
    this.disc(px, py + 1, pz, 1, LEAF, wx + dx * bend, wz + dz * bend, 1);
    // A second, shorter limb in the opposite direction.
    if (this.rand(wx, 2, wz, 17) < 0.6) {
      const sy = y + straight - 1;
      const qx = x - dx * 2, qz = z - dz * 2;
      this.log(x - dx, sy, z - dz, LOG);
      this.log(qx, sy, qz, LOG);
      this.log(qx, sy + 1, qz, LOG);
      this.disc(qx, sy + 2, qz, 2, LEAF, wx - dx * 2, wz - dz * 2, 0.6);
    }
    this.soil(x, y, z);
  }

  /** Dark oak: a 2×2 trunk and a heavy, wide canopy. (x, z) is the north-west log. */
  darkOak(x: number, y: number, z: number, height: number, wx: number, wz: number): void {
    if (y + height + 3 >= CHUNK_HEIGHT) return;
    const LOG = CUBE_ID.dark_oak_log, LEAF = CUBE_ID.dark_oak_leaves;
    const top = y + height;
    // The canopy is centred on the middle of the 2×2 trunk: leaf discs cover x-2..x+3.
    const layers: [number, number][] = [[top - 2, 2], [top - 1, 3], [top, 3], [top + 1, 2]];
    for (const [ly, r] of layers) {
      for (let dz = -r + 1; dz <= r; dz++) {
        for (let dx = -r + 1; dx <= r; dx++) {
          const cx = dx > 0 ? dx - 1 : dx, cz = dz > 0 ? dz - 1 : dz; // distance from the trunk block
          const corner = Math.abs(cx) === r - 1 && Math.abs(cz) === r - 1 && r > 1;
          if (corner && this.rand(wx + dx, ly, wz + dz, 33) < 0.55) continue;
          this.leaf(x + dx, ly, z + dz, LEAF);
        }
      }
    }
    for (let i = 0; i < height; i++) {
      this.log(x, y + i, z, LOG); this.log(x + 1, y + i, z, LOG);
      this.log(x, y + i, z + 1, LOG); this.log(x + 1, y + i, z + 1, LOG);
    }
    this.soil(x, y, z); this.soil(x + 1, y, z); this.soil(x, y, z + 1); this.soil(x + 1, y, z + 1);
  }

  /** Cherry tree: a short crooked trunk under a round pink crown. */
  cherry(x: number, y: number, z: number, height: number, wx: number, wz: number): void {
    if (y + height + 3 >= CHUNK_HEIGHT) return;
    const LOG = CUBE_ID.cherry_log, LEAF = CUBE_ID.cherry_leaves;
    const dir = Math.floor(this.rand(wx, 0, wz, 19) * 4);
    const dx = dir === 0 ? 1 : dir === 1 ? -1 : 0, dz = dir === 2 ? 1 : dir === 3 ? -1 : 0;
    const lean = Math.floor(height * 0.6);
    for (let i = 0; i < height; i++) this.log(x + (i >= lean ? dx : 0), y + i, z + (i >= lean ? dz : 0), LOG);
    this.log(x + dx, y + lean - 1, z + dz, LOG); // elbow, so the trunk is connected face to face
    const cx = x + dx, cz = z + dz, top = y + height;
    const radii = [2, 3, 3, 2, 1];
    for (let k = 0; k < radii.length; k++) this.disc(cx, top - 3 + k, cz, radii[k], LEAF, wx + dx, wz + dz, 0.4);
    this.soil(x, y, z);
  }
}
