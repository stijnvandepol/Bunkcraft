import { HITBOX } from '../src/modes/Weapons';
import { BLOCK, SOLID } from '../src/world/BlockRegistry';

/** Hitscan geometry for the arcade game types: voxel ray march, player boxes and spread. */

export interface BlockQuery {
  getBlock(x: number, y: number, z: number): number;
}

/** A bullet stops at every solid block (glass included); plants and water let it through. */
export function blocksBullet(id: number): boolean {
  return id !== BLOCK.AIR && (SOLID[id] === 1 || id === BLOCK.UNLOADED);
}

/**
 * Distance along the (normalised) ray to the first bullet-stopping block, or `maxDist` when the
 * way is free. Amanatides & Woo voxel traversal; the origin voxel itself never blocks.
 */
export function traceBlocks(
  world: BlockQuery, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number,
): number {
  let x = Math.floor(ox), y = Math.floor(oy), z = Math.floor(oz);
  const stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
  const tDeltaX = dx === 0 ? Infinity : Math.abs(1 / dx);
  const tDeltaY = dy === 0 ? Infinity : Math.abs(1 / dy);
  const tDeltaZ = dz === 0 ? Infinity : Math.abs(1 / dz);
  let tMaxX = dx === 0 ? Infinity : (dx > 0 ? x + 1 - ox : ox - x) * tDeltaX;
  let tMaxY = dy === 0 ? Infinity : (dy > 0 ? y + 1 - oy : oy - y) * tDeltaY;
  let tMaxZ = dz === 0 ? Infinity : (dz > 0 ? z + 1 - oz : oz - z) * tDeltaZ;
  let t = 0;
  while (t <= maxDist) {
    if (tMaxX < tMaxY && tMaxX < tMaxZ) { t = tMaxX; x += stepX; tMaxX += tDeltaX; }
    else if (tMaxY < tMaxZ) { t = tMaxY; y += stepY; tMaxY += tDeltaY; }
    else { t = tMaxZ; z += stepZ; tMaxZ += tDeltaZ; }
    if (t > maxDist) break;
    if (blocksBullet(world.getBlock(x, y, z))) return t;
  }
  return maxDist;
}

/** Entry distance of a ray into a box, or -1 on a miss (a ray starting inside returns 0). */
export function rayBox(
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
  minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number,
): number {
  let tMin = 0, tMax = Infinity;
  const slab = (o: number, d: number, lo: number, hi: number): boolean => {
    if (Math.abs(d) < 1e-9) return o >= lo && o <= hi;
    let t1 = (lo - o) / d, t2 = (hi - o) / d;
    if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
    if (t1 > tMin) tMin = t1;
    if (t2 < tMax) tMax = t2;
    return tMin <= tMax;
  };
  if (!slab(ox, dx, minX, maxX) || !slab(oy, dy, minY, maxY) || !slab(oz, dz, minZ, maxZ)) return -1;
  return tMin;
}

export interface BodyHit {
  t: number;
  head: boolean;
}

/** Ray against a player standing at (x, y, z) (feet): the hitbox, with the top part as head. */
export function rayPlayer(
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, x: number, y: number, z: number,
): BodyHit | null {
  const hw = HITBOX.width / 2;
  const t = rayBox(ox, oy, oz, dx, dy, dz, x - hw, y, z - hw, x + hw, y + HITBOX.height, z + hw);
  if (t < 0) return null;
  const hy = oy + dy * t;
  return { t, head: hy >= y + HITBOX.height - HITBOX.head };
}

/**
 * A direction inside a cone of `degrees` half-angle around (dx, dy, dz) (normalised), uniform over
 * the cone's disc. `r1` and `r2` are random numbers in [0, 1).
 */
/**
 * Pellet pattern of a multi-pellet shot (shotgun): pellet `k` of `n` gets a fixed place in the cone instead of a random
 * one, so the damage at a distance is consistent (a random cone sometimes put half the pellets beside a target at
 * arm's length). One pellet in the centre, about 40% on an inner ring at 45% of the cone, the rest on an outer ring
 * at 85%; `rot` (0..1) turns the whole pattern per shot and `jitter` (0..1) moves each pellet a little.
 * Returns the (r1, r2) pair for `spreadDirection` in `out`.
 */
export function pelletPattern(k: number, n: number, rot: number, jitter: number, out: [number, number]): [number, number] {
  if (k === 0 || n <= 1) { out[0] = 0.0064 * jitter; out[1] = rot; return out; }
  const inner = Math.max(1, Math.round((n - 1) * 0.4));
  const ring = k <= inner ? 0 : 1;
  const count = ring === 0 ? inner : n - 1 - inner;
  const i = ring === 0 ? k - 1 : k - 1 - inner;
  const radius = (ring === 0 ? 0.45 : 0.85) + (jitter - 0.5) * 0.12;
  out[0] = radius * radius; // spreadDirection takes sqrt(r1) as the share of the cone
  out[1] = (rot + (i + (ring === 0 ? 0 : 0.5)) / count + (jitter - 0.5) * 0.04 + 1) % 1;
  return out;
}

export function spreadDirection(
  dx: number, dy: number, dz: number, degrees: number, r1: number, r2: number, out: [number, number, number],
): [number, number, number] {
  if (degrees <= 0) { out[0] = dx; out[1] = dy; out[2] = dz; return out; }
  const angle = (degrees * Math.PI / 180) * Math.sqrt(r1);
  const az = r2 * Math.PI * 2;
  // Orthonormal basis (u, v) perpendicular to the aim.
  let ux: number, uy: number, uz: number;
  if (Math.abs(dy) < 0.99) { ux = dz; uy = 0; uz = -dx; } else { ux = 0; uy = -dz; uz = dy; }
  const ul = Math.hypot(ux, uy, uz);
  ux /= ul; uy /= ul; uz /= ul;
  const vx = dy * uz - dz * uy, vy = dz * ux - dx * uz, vz = dx * uy - dy * ux;
  const s = Math.sin(angle), c = Math.cos(angle), ca = Math.cos(az) * s, sa = Math.sin(az) * s;
  out[0] = dx * c + ux * ca + vx * sa;
  out[1] = dy * c + uy * ca + vy * sa;
  out[2] = dz * c + uz * ca + vz * sa;
  return out;
}
