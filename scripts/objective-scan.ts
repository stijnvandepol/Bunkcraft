/**
 * Helps placing zones and flags: prints the blue half of a map (x >= 0), a mark per cell:
 *   '#' blocked at body height, 'S' spawn, 'F' a good flag cell, 'z' a good zone centre, 'o' both, '.' open but not good.
 * A zone centre is good when >= 70% of its disc (r = 5) is open, it is reachable on foot from the blue spawn and no red
 * spawn sees it. A flag cell must also be 8..25 blocks from a blue spawn and > 30 from every red spawn.
 *
 *   npx tsx scripts/objective-scan.ts [map id] [r]
 */
import { ARENA_FLOOR_Y, getMap } from '../src/modes/maps';
import { keyOf, openShare, reachable, seenFrom } from '../tests/helpers/mapAnalysis';

const map = getMap(process.argv[2] ?? 'classic');
const r = Number(process.argv[3] ?? 5);
const b = map.bounds;
const reach = reachable(map, 0, Math.floor(map.spawns.blue[0].x), Math.floor(map.spawns.blue[0].z));
const spawns = new Set([...map.spawns.red, ...map.spawns.blue].map((s) => `${Math.floor(s.x)},${Math.floor(s.z)}`));
const chars: string[] = [];
for (let z = b.minZ + 1; z < b.maxZ - 1; z++) {
  let row = '';
  for (let x = 0; x < b.maxX - 1; x++) {
    const y = map.heightAt(0, x, z) + 1;
    if (spawns.has(`${x},${z}`)) { row += 'S'; continue; }
    if (map.blockAt(0, x, ARENA_FLOOR_Y + 1, z) !== 0 && y === ARENA_FLOOR_Y + 1) { row += '#'; continue; }
    const standOk = reach.has(keyOf(x, z, y - 1));
    if (!standOk) { row += y > ARENA_FLOOR_Y + 1 ? '^' : '#'; continue; }
    const px = x + 0.5, pz = z + 0.5;
    const seen = seenFrom(map, 0, map.spawns.red, px, y, pz);
    const share = openShare(map, 0, px, pz, y, r);
    const zone = !seen && share >= 0.7;
    const own = Math.min(...map.spawns.blue.map((s) => Math.hypot(s.x - px, s.z - pz)));
    const enemy = Math.min(...map.spawns.red.map((s) => Math.hypot(s.x - px, s.z - pz)));
    const flag = !seen && own >= 8 && own <= 25 && enemy > 30;
    row += zone && flag ? 'o' : zone ? 'z' : flag ? 'F' : '.';
  }
  chars.push(`${String(z).padStart(3)} ${row}`);
}
console.log(`${map.name} (blue half, x = 0..${b.maxX - 2}); columns are x`);
console.log(chars.join('\n'));
