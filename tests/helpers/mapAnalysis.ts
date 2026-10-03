import { traceBlocks } from '../../server/Combat';
import { ARENA_FLOOR_Y, type ArenaMap } from '../../src/modes/maps';
import { BLOCK, SOLID } from '../../src/world/BlockRegistry';

/** Geometry helpers shared by the map tests and the scan scripts: standing spots, walking reachability, sight lines. */

export const keyOf = (x: number, z: number, y: number): number => ((x + 100) * 1000 + (z + 100)) * 1000 + y;

export function blockFn(map: ArenaMap, variant = 0) {
  return (x: number, y: number, z: number) => map.blockAt(variant, Math.floor(x), y, Math.floor(z));
}

/** A cell with a solid block at `y` and two free blocks above it. */
export function standable(map: ArenaMap, variant: number, x: number, y: number, z: number): boolean {
  const at = blockFn(map, variant);
  return SOLID[at(x, y, z)] === 1 && at(x, y + 1, z) === BLOCK.AIR && at(x, y + 2, z) === BLOCK.AIR;
}

/** Every standing spot (x, z, surface y) reachable on foot from a start cell: 1-block step ups, free drops. */
export function reachable(map: ArenaMap, variant: number, sx: number, sz: number, sy = ARENA_FLOOR_Y): Set<number> {
  const at = blockFn(map, variant);
  const b = map.bounds;
  const air = (x: number, y: number, z: number) => at(x, y, z) === BLOCK.AIR;
  const ok = (x: number, y: number, z: number) => SOLID[at(x, y, z)] === 1 && air(x, y + 1, z) && air(x, y + 2, z);
  const seen = new Set<number>([keyOf(sx, sz, sy)]);
  const queue: [number, number, number][] = [[sx, sz, sy]];
  while (queue.length) {
    const [x, z, y] = queue.pop()!;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, nz = z + dz;
      if (nx < b.minX || nx >= b.maxX || nz < b.minZ || nz >= b.maxZ) continue;
      for (let ny = y + 1; ny >= ARENA_FLOOR_Y; ny--) {
        if (!ok(nx, ny, nz) || seen.has(keyOf(nx, nz, ny))) continue;
        if (ny <= y && !(air(nx, y + 1, nz) && air(nx, y + 2, nz))) continue;
        seen.add(keyOf(nx, nz, ny));
        queue.push([nx, nz, ny]);
      }
    }
  }
  return seen;
}

/** Whether a straight line from (ax, ay, az) to (bx, by, bz) is free of blocks. */
export function clear(map: ArenaMap, variant: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
  const world = { getBlock: blockFn(map, variant) };
  const dx = bx - ax, dy = by - ay, dz = bz - az, d = Math.hypot(dx, dy, dz);
  return traceBlocks(world, ax, ay, az, dx / d, dy / d, dz / d, d) >= d;
}

/** Whether any spawn in the list sees a point (eye at 1.62, 0.9 and 0.2 above the spawn, target at 1.62 / 0.9 above `y`). */
export function seenFrom(map: ArenaMap, variant: number, spawns: { x: number; y: number; z: number }[], x: number, y: number, z: number): boolean {
  for (const s of spawns) {
    for (const [ay, by] of [[1.62, 1.62], [1.62, 0.9], [0.9, 1.62], [0.2, 1.62]]) {
      if (clear(map, variant, s.x, s.y + ay, s.z, x, y + by, z)) return true;
    }
  }
  return false;
}

/** Share of the cells of a disc (radius r) around (x, z) that are walkable at floor level or on the zone's level. */
export function openShare(map: ArenaMap, variant: number, x: number, z: number, y: number, r: number): number {
  const at = blockFn(map, variant);
  let open = 0, total = 0;
  for (let cx = Math.floor(x - r); cx <= Math.floor(x + r); cx++) {
    for (let cz = Math.floor(z - r); cz <= Math.floor(z + r); cz++) {
      if (Math.hypot(cx + 0.5 - x, cz + 0.5 - z) > r) continue;
      total++;
      if (at(cx, y, cz) === BLOCK.AIR && at(cx, y + 1, cz) === BLOCK.AIR) open++;
    }
  }
  return total ? open / total : 0;
}
