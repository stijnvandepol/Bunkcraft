/**
 * Prints a top-down view of an arena map, two layers side by side: the walking layer ('#' = blocked at
 * body height, 'g' = glass, '.' = open, 'R'/'B' = red/blue spawn, 'f' = ffa spawn, 'Z' = zone centre,
 * 'F' = flag) and the surface height above the floor ('.' = floor, 1..9, A.. = higher). Mirrored maps
 * print one quadrant (x >= 0, z >= 0), free-form maps (or `--full`) the whole arena.
 *
 *   npx tsx scripts/ascii-map.ts [map id] [--full] [--layer=h]   (h: walking layer height above the floor, default 1)
 */
import { ARENA_FLOOR_Y, getMap } from '../src/modes/maps';

const args = process.argv.slice(2);
const map = getMap(args.find((a) => !a.startsWith('--')) ?? 'classic');
const full = args.includes('--full') || !map.mirrored;
const layer = Number(args.find((a) => a.startsWith('--layer='))?.slice(8) ?? 1);
const b = map.bounds;
const marks = new Map<string, string>();
const cell = (x: number, z: number) => `${Math.floor(x)},${Math.floor(z)}`;
for (const s of map.spawns.ffa) marks.set(cell(s.x, s.z), 'f');
for (const s of map.spawns.red) marks.set(cell(s.x, s.z), 'R');
for (const s of map.spawns.blue) marks.set(cell(s.x, s.z), 'B');
for (const z of map.zones) marks.set(cell(z.x, z.z), 'Z');
for (const f of map.flags) marks.set(cell(f.x, f.z), 'F');
const chars = '.123456789ABCDEFGHIJ';
const x0 = full ? b.minX : 0, z0 = full ? b.minZ : 0;
console.log(`${map.name}: ${b.maxX - b.minX} x ${b.maxZ - b.minZ}, wall ${map.wallHeight}${full ? ` (x ${x0}..${b.maxX - 1} left to right)` : ''}`);
for (let z = z0; z < b.maxZ; z++) {
  let walk = '', top = '';
  for (let x = x0; x < b.maxX; x++) {
    const low = map.blockAt(0, x, ARENA_FLOOR_Y + layer, z), mid = map.blockAt(0, x, ARENA_FLOOR_Y + layer + 1, z);
    walk += marks.get(`${x},${z}`) ?? (low === 0 && mid === 0 ? '.' : low === 11 || mid === 11 ? 'g' : '#');
    top += chars[Math.max(0, Math.min(chars.length - 1, map.heightAt(0, x, z) - ARENA_FLOOR_Y))];
  }
  console.log(String(z).padStart(3) + ' ' + walk + '  ' + top);
}
