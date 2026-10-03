import { ARENA_FLOOR_Y, type ArenaMap } from '../../src/modes/maps';

/**
 * Bot helpers for the arcade scripts: honest movement that the server's movement validator accepts.
 * Paths run over open floor cells (4-neighbour BFS through cell centres, so the 0.6 wide player box
 * never touches a wall) at a pace below the arcade run speed.
 */

/** Blocks per second: below the slowest arcade run speed (sniper, 0.92 × 7.29 ≈ 6.7). */
export const BOT_SPEED = 6;

/** A walking path from `from` to `to` (x, z) over open floor, as cell centres; null when there is none. */
export function arenaPath(map: ArenaMap, variant: number, from: [number, number], to: [number, number]): [number, number][] | null {
  const b = map.bounds, w = b.maxX - b.minX, d = b.maxZ - b.minZ;
  const open = (x: number, z: number) => map.inBounds(x + 0.5, z + 0.5)
    && map.blockAt(variant, x, ARENA_FLOOR_Y + 1, z) === 0 && map.blockAt(variant, x, ARENA_FLOOR_Y + 2, z) === 0
    && map.blockAt(variant, x, ARENA_FLOOR_Y, z) !== 0;
  const idx = (x: number, z: number) => (x - b.minX) * d + (z - b.minZ);
  const prev = new Int32Array(w * d).fill(-1);
  const sx = Math.floor(from[0]), sz = Math.floor(from[1]), tx = Math.floor(to[0]), tz = Math.floor(to[1]);
  if (!open(tx, tz)) return null;
  const q = [idx(sx, sz)];
  prev[q[0]] = q[0];
  for (let h = 0; h < q.length; h++) {
    const c = q[h], x = Math.floor(c / d) + b.minX, z = (c % d) + b.minZ;
    if (x === tx && z === tz) break;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, nz = z + dz;
      if (!open(nx, nz) || prev[idx(nx, nz)] >= 0) continue;
      prev[idx(nx, nz)] = c;
      q.push(idx(nx, nz));
    }
  }
  if (prev[idx(tx, tz)] < 0) return null;
  const out: [number, number][] = [[to[0], to[1]]];
  for (let c = prev[idx(tx, tz)]; c !== prev[c]; c = prev[c]) out.push([Math.floor(c / d) + b.minX + 0.5, (c % d) + b.minZ + 0.5]);
  // Start from the centre of the own cell so the first leg is axis-aligned too.
  out.push([sx + 0.5, sz + 0.5]);
  return out.reverse();
}

/** Moves (x, z) along `route` by `step` blocks, consuming reached points. */
export function follow(pos: { x: number; z: number }, route: [number, number][], step: number): void {
  while (step > 0 && route.length) {
    const [tx, tz] = route[0];
    const dx = tx - pos.x, dz = tz - pos.z, dist = Math.hypot(dx, dz);
    if (dist <= step) { pos.x = tx; pos.z = tz; route.shift(); step -= dist; } else { pos.x += (dx / dist) * step; pos.z += (dz / dist) * step; step = 0; }
  }
}

/** Unit aim vector from (ox, oy, oz) to (tx, ty, tz): the server only accepts unit directions. */
export function aimAt(ox: number, oy: number, oz: number, tx: number, ty: number, tz: number): { dx: number; dy: number; dz: number } {
  const dx = tx - ox, dy = ty - oy, dz = tz - oz, d = Math.hypot(dx, dy, dz) || 1;
  return { dx: dx / d, dy: dy / d, dz: dz / d };
}
