/**
 * Lists the red/blue spawn pairs that can see each other in a map (they should not: spawn
 * killing), and the pairs with the shortest distance.
 *
 *   npx tsx scripts/spawn-los.ts [map id]
 */
import { traceBlocks } from '../server/Combat';
import { MAPS, getMap } from '../src/modes/maps';

const maps = process.argv[2] ? [getMap(process.argv[2])] : MAPS;
for (const map of maps) {
  const world = { getBlock: (x: number, y: number, z: number) => map.blockAt(0, x, y, z) };
  let seen = 0, nearest = Infinity;
  for (const r of map.spawns.red) {
    for (const bl of map.spawns.blue) {
      nearest = Math.min(nearest, Math.hypot(r.x - bl.x, r.z - bl.z));
      const dx = bl.x - r.x, dy = 0, dz = bl.z - r.z, d = Math.hypot(dx, dz);
      if (traceBlocks(world, r.x, r.y + 1.62, r.z, dx / d, dy, dz / d, d) >= d) seen++;
    }
  }
  console.log(`${map.id}: ${seen} of ${map.spawns.red.length * map.spawns.blue.length} red/blue spawn pairs see each other; nearest ${nearest.toFixed(1)} blocks`);
}
