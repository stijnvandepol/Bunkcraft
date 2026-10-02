import { SOLID } from '../world/BlockRegistry';

export type BlockGetter = (x: number, y: number, z: number) => number;

/** Axis-aligned box stored as min/max corners. */
export interface AABB {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
}

const EPS = 1e-4;

/**
 * Clips a movement `delta` along one axis against solid blocks near the box
 * (Minecraft's per-axis "calculateOffset" approach). Only the handful of blocks
 * overlapped by the swept box are tested, never the whole world.
 */
export function clipAxis(box: AABB, axis: 0 | 1 | 2, delta: number, getBlock: BlockGetter): number {
  if (delta === 0) return 0;
  const minX = Math.floor(box.minX + (axis === 0 && delta < 0 ? delta : 0) + EPS);
  const maxX = Math.floor(box.maxX + (axis === 0 && delta > 0 ? delta : 0) - EPS);
  const minY = Math.floor(box.minY + (axis === 1 && delta < 0 ? delta : 0) + EPS);
  const maxY = Math.floor(box.maxY + (axis === 1 && delta > 0 ? delta : 0) - EPS);
  const minZ = Math.floor(box.minZ + (axis === 2 && delta < 0 ? delta : 0) + EPS);
  const maxZ = Math.floor(box.maxZ + (axis === 2 && delta > 0 ? delta : 0) - EPS);
  for (let y = minY; y <= maxY; y++) {
    for (let z = minZ; z <= maxZ; z++) {
      for (let x = minX; x <= maxX; x++) {
        if (!SOLID[getBlock(x, y, z)]) continue;
        const lo = axis === 0 ? x : axis === 1 ? y : z;
        const boxMin = axis === 0 ? box.minX : axis === 1 ? box.minY : box.minZ;
        const boxMax = axis === 0 ? box.maxX : axis === 1 ? box.maxY : box.maxZ;
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

export function boxIntersectsSolid(box: AABB, getBlock: BlockGetter): boolean {
  for (let y = Math.floor(box.minY + EPS); y <= Math.floor(box.maxY - EPS); y++) {
    for (let z = Math.floor(box.minZ + EPS); z <= Math.floor(box.maxZ - EPS); z++) {
      for (let x = Math.floor(box.minX + EPS); x <= Math.floor(box.maxX - EPS); x++) {
        if (SOLID[getBlock(x, y, z)]) return true;
      }
    }
  }
  return false;
}
