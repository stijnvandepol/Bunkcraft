import { BLOCK, SHAPE, SHAPE_LIQUID, SHAPE_NONE } from './BlockRegistry';

export interface RayHit {
  hit: boolean;
  x: number; y: number; z: number;
  /** Face normal of the hit face (where a placed block goes). */
  nx: number; ny: number; nz: number;
  id: number;
  distance: number;
}

export function createRayHit(): RayHit {
  return { hit: false, x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, id: 0, distance: 0 };
}

/**
 * Voxel traversal (Amanatides & Woo): visits exactly the cells the ray passes through,
 * so it never skips thin corners and costs O(reach) block lookups.
 */
export function raycast(
  getBlock: (x: number, y: number, z: number) => number,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  maxDist: number,
  out: RayHit,
): RayHit {
  let x = Math.floor(ox), y = Math.floor(oy), z = Math.floor(oz);
  const stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
  const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
  const tDeltaY = dy !== 0 ? Math.abs(1 / dy) : Infinity;
  const tDeltaZ = dz !== 0 ? Math.abs(1 / dz) : Infinity;
  let tMaxX = dx !== 0 ? (dx > 0 ? x + 1 - ox : ox - x) * tDeltaX : Infinity;
  let tMaxY = dy !== 0 ? (dy > 0 ? y + 1 - oy : oy - y) * tDeltaY : Infinity;
  let tMaxZ = dz !== 0 ? (dz > 0 ? z + 1 - oz : oz - z) * tDeltaZ : Infinity;
  let nx = 0, ny = 0, nz = 0;
  let t = 0;
  out.hit = false;
  while (t <= maxDist) {
    const id = getBlock(x, y, z);
    if (id === BLOCK.UNLOADED) return out;
    const shape = SHAPE[id];
    if (shape !== SHAPE_NONE && shape !== SHAPE_LIQUID) {
      out.hit = true;
      out.x = x; out.y = y; out.z = z;
      out.nx = nx; out.ny = ny; out.nz = nz;
      out.id = id;
      out.distance = t;
      return out;
    }
    if (tMaxX < tMaxY && tMaxX < tMaxZ) {
      x += stepX; t = tMaxX; tMaxX += tDeltaX; nx = -stepX; ny = 0; nz = 0;
    } else if (tMaxY < tMaxZ) {
      y += stepY; t = tMaxY; tMaxY += tDeltaY; nx = 0; ny = -stepY; nz = 0;
    } else {
      z += stepZ; t = tMaxZ; tMaxZ += tDeltaZ; nx = 0; ny = 0; nz = -stepZ;
    }
  }
  return out;
}
