import { BLOCK, PARTIAL, SHAPE, SHAPE_LIQUID, SHAPE_NONE } from './BlockRegistry';
import { collisionBoxes } from './BlockShapes';

export interface RayHit {
  hit: boolean;
  x: number; y: number; z: number;
  /** Face normal of the hit face (where a placed block goes). */
  nx: number; ny: number; nz: number;
  id: number;
  distance: number;
}

const boxes = new Float64Array(64);
const enter = [0, 0, 0];

/**
 * Where does the ray (origin o, direction d) first touch one of the boxes of the partial block at (x, y, z)?
 * Returns the distance or −1; the face normal goes to `enter` (the box face that was crossed).
 */
function hitPartial(
  getBlock: (x: number, y: number, z: number) => number, getMeta: (x: number, y: number, z: number) => number,
  id: number, x: number, y: number, z: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
): number {
  const n = collisionBoxes(id, getMeta(x, y, z), getBlock, getMeta, x, y, z, boxes);
  let best = Infinity;
  for (let k = 0; k < n; k++) {
    const o = k * 6;
    let tmin = -Infinity, tmax = Infinity;
    let nAxis = -1, nSign = 0;
    for (let axis = 0; axis < 3; axis++) {
      const org = axis === 0 ? ox : axis === 1 ? oy : oz;
      const dir = axis === 0 ? dx : axis === 1 ? dy : dz;
      const base = axis === 0 ? x : axis === 1 ? y : z;
      const lo = base + boxes[o + axis], hi = base + boxes[o + 3 + axis];
      if (dir === 0) {
        if (org < lo || org > hi) { tmin = Infinity; break; }
        continue;
      }
      let t1 = (lo - org) / dir, t2 = (hi - org) / dir;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      if (t1 > tmin) { tmin = t1; nAxis = axis; nSign = dir > 0 ? -1 : 1; }
      if (t2 < tmax) tmax = t2;
    }
    if (tmin > tmax || tmax < 0) continue;
    const t = tmin < 0 ? 0 : tmin;
    if (t < best) {
      best = t;
      enter[0] = enter[1] = enter[2] = 0;
      if (nAxis >= 0 && tmin >= 0) enter[nAxis] = nSign;
    }
  }
  return best === Infinity ? -1 : best;
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
  getMeta?: (x: number, y: number, z: number) => number,
  /** Also stop at liquid source blocks (what an empty bucket aims at); flowing liquid is still passed through. */
  hitLiquidSource = false,
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
    if (shape !== SHAPE_NONE && (shape !== SHAPE_LIQUID || (hitLiquidSource && !!getMeta && getMeta(x, y, z) === 0))) {
      if (PARTIAL[id] && getMeta) {
        // Slabs, stairs and doors are only hit where their boxes are, so the ray passes over a bottom slab's empty half.
        const th = hitPartial(getBlock, getMeta, id, x, y, z, ox, oy, oz, dx, dy, dz);
        if (th >= 0 && th <= maxDist) {
          out.hit = true;
          out.x = x; out.y = y; out.z = z;
          // Entering through the cell face keeps the cell normal; otherwise the box face that was crossed.
          if (enter[0] || enter[1] || enter[2]) { nx = enter[0]; ny = enter[1]; nz = enter[2]; }
          out.nx = nx; out.ny = ny; out.nz = nz;
          out.id = id;
          out.distance = th;
          return out;
        }
        // Missed the boxes: carry on into the next cell.
        if (tMaxX < tMaxY && tMaxX < tMaxZ) {
          x += stepX; t = tMaxX; tMaxX += tDeltaX; nx = -stepX; ny = 0; nz = 0;
        } else if (tMaxY < tMaxZ) {
          y += stepY; t = tMaxY; tMaxY += tDeltaY; nx = 0; ny = -stepY; nz = 0;
        } else {
          z += stepZ; t = tMaxZ; tMaxZ += tDeltaZ; nx = 0; ny = 0; nz = -stepZ;
        }
        continue;
      }
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
