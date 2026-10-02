/**
 * Prints a top-down view of one quadrant of an arena map (x >= 0, z >= 0), two layers side by side:
 * the walking layer ('#' = blocked at body height, 'g' = glass, '.' = open, 'S' = spawn) and the
 * surface height above the floor ('.' = floor, 1..9, A.. = higher).
 *
 *   npx tsx scripts/ascii-map.ts [map id]
 */
import { ARENA_FLOOR_Y, getMap } from '../src/modes/maps';

const map = getMap(process.argv[2] ?? 'classic');
const b = map.bounds;
const spawns = new Set(map.spawns.blue.concat(map.spawns.ffa).map((s) => `${Math.floor(s.x)},${Math.floor(s.z)}`));
const chars = '.123456789ABCDEFGHIJ';
console.log(`${map.name}: ${b.maxX - b.minX} x ${b.maxZ - b.minZ}, wall ${map.wallHeight}`);
for (let z = 0; z < b.maxZ; z++) {
  let walk = '', top = '';
  for (let x = 0; x < b.maxX; x++) {
    const low = map.blockAt(0, x, ARENA_FLOOR_Y + 1, z), mid = map.blockAt(0, x, ARENA_FLOOR_Y + 2, z);
    walk += spawns.has(`${x},${z}`) ? 'S' : low === 0 && mid === 0 ? '.' : low === 11 || mid === 11 ? 'g' : '#';
    top += chars[Math.max(0, Math.min(chars.length - 1, map.heightAt(0, x, z) - ARENA_FLOOR_Y))];
  }
  console.log(String(z).padStart(2) + ' ' + walk + '  ' + top);
}
