import { PARTIAL, SOLID, TALL } from '../world/BlockRegistry';
import { collisionBoxes } from '../world/BlockShapes';

export type BlockGetter = (x: number, y: number, z: number) => number;

/** Axis-aligned box stored as min/max corners. */
export interface AABB {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
}

const EPS = 1e-4;
/** Scratch for the boxes of one slab, stair or door (no allocation per query). */
const partialBoxes = new Float64Array(64);

/**
 * Clips a movement `delta` along one axis against solid blocks near the box
 * (Minecraft's per-axis "calculateOffset" approach). Only the handful of blocks
 * overlapped by the swept box are tested, never the whole world.
 *
 * `getMeta` supplies block states: with it slabs, stairs and doors collide with their real shape; without
 * it they count as full blocks.
 */
export function clipAxis(box: AABB, axis: 0 | 1 | 2, delta: number, getBlock: BlockGetter, getMeta?: BlockGetter): number {
  if (delta === 0) return 0;
  const minX = Math.floor(box.minX + (axis === 0 && delta < 0 ? delta : 0) + EPS);
  const maxX = Math.floor(box.maxX + (axis === 0 && delta > 0 ? delta : 0) - EPS);
  const minY = Math.floor(box.minY + (axis === 1 && delta < 0 ? delta : 0) + EPS);
  const maxY = Math.floor(box.maxY + (axis === 1 && delta > 0 ? delta : 0) - EPS);
  const minZ = Math.floor(box.minZ + (axis === 2 && delta < 0 ? delta : 0) + EPS);
  const maxZ = Math.floor(box.maxZ + (axis === 2 && delta > 0 ? delta : 0) - EPS);
  const boxMin = axis === 0 ? box.minX : axis === 1 ? box.minY : box.minZ;
  const boxMax = axis === 0 ? box.maxX : axis === 1 ? box.maxY : box.maxZ;
  // One cell lower too: fences and walls reach 1.5 blocks up.
  for (let y = minY - 1; y <= maxY; y++) {
    for (let z = minZ; z <= maxZ; z++) {
      for (let x = minX; x <= maxX; x++) {
        const id = getBlock(x, y, z);
        if (!SOLID[id]) continue;
        if (y < minY && !TALL[id]) continue;
        if (PARTIAL[id] && getMeta) {
          const n = collisionBoxes(id, getMeta(x, y, z), getBlock, getMeta, x, y, z, partialBoxes);
          for (let k = 0; k < n; k++) {
            const o = k * 6;
            const x0 = x + partialBoxes[o], y0 = y + partialBoxes[o + 1], z0 = z + partialBoxes[o + 2];
            const x1 = x + partialBoxes[o + 3], y1 = y + partialBoxes[o + 4], z1 = z + partialBoxes[o + 5];
            // The sub-box must overlap the moving box on the two other axes.
            if (axis !== 0 && !(box.minX < x1 - EPS && box.maxX > x0 + EPS)) continue;
            if (axis !== 1 && !(box.minY < y1 - EPS && box.maxY > y0 + EPS)) continue;
            if (axis !== 2 && !(box.minZ < z1 - EPS && box.maxZ > z0 + EPS)) continue;
            const lo = axis === 0 ? x0 : axis === 1 ? y0 : z0;
            const hi = axis === 0 ? x1 : axis === 1 ? y1 : z1;
            if (delta > 0) {
              const lim = lo - boxMax;
              if (lim >= -EPS && lim < delta) delta = lim;
            } else {
              const lim = hi - boxMin;
              if (lim <= EPS && lim > delta) delta = lim;
            }
          }
          continue;
        }
        const lo = axis === 0 ? x : axis === 1 ? y : z;
        // Blocks the box already overlaps (e.g. after placing one inside it) are ignored.
        if (delta > 0) {
          const lim = lo - boxMax;
          if (lim >= -EPS && lim < delta) delta = lim;
        } else {
          const lim = lo + 1 - boxMin;
          if (lim <= EPS && lim > delta) delta = lim;
        }
      }
    }
  }
  // Never move "backwards" because of a float-precision overlap.
  return Math.abs(delta) < EPS ? 0 : delta;
}

export function boxIntersectsSolid(box: AABB, getBlock: BlockGetter, getMeta?: BlockGetter): boolean {
  const minY = Math.floor(box.minY + EPS);
  for (let y = minY - 1; y <= Math.floor(box.maxY - EPS); y++) {
    for (let z = Math.floor(box.minZ + EPS); z <= Math.floor(box.maxZ - EPS); z++) {
      for (let x = Math.floor(box.minX + EPS); x <= Math.floor(box.maxX - EPS); x++) {
        const id = getBlock(x, y, z);
        if (!SOLID[id]) continue;
        if (y < minY && !TALL[id]) continue;
        if (PARTIAL[id] && getMeta) {
          const n = collisionBoxes(id, getMeta(x, y, z), getBlock, getMeta, x, y, z, partialBoxes);
          for (let k = 0; k < n; k++) {
            const o = k * 6;
            if (box.minX < x + partialBoxes[o + 3] - EPS && box.maxX > x + partialBoxes[o] + EPS
              && box.minY < y + partialBoxes[o + 4] - EPS && box.maxY > y + partialBoxes[o + 1] + EPS
              && box.minZ < z + partialBoxes[o + 5] - EPS && box.maxZ > z + partialBoxes[o + 2] + EPS) return true;
          }
          continue;
        }
        return true;
      }
    }
  }
  return false;
}
