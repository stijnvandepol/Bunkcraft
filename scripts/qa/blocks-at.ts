/**
 * QA: prints the blocks of an arena map around a position (a column stack per x/z), to explain stuck spots.
 *   npx tsx scripts/qa/blocks-at.ts <map> <x> <z> [radius=1] [variant=0]
 */
import { ARENA_FLOOR_Y, getMap } from '../../src/modes/maps';
import { getBlockDef } from '../../src/world/BlockRegistry';

const [mapId, xs, zs, rs, vs] = process.argv.slice(2);
const map = getMap(mapId);
const r = Number(rs ?? 1), v = Number(vs ?? 0);
const name = (id: number) => (id === 0 ? '.' : (getBlockDef(id)?.name ?? String(id)));
for (let x = Number(xs) - r; x <= Number(xs) + r; x++) for (let z = Number(zs) - r; z <= Number(zs) + r; z++) {
  const col: string[] = [];
  for (let y = ARENA_FLOOR_Y; y <= ARENA_FLOOR_Y + 10; y++) col.push(`${y}:${name(map.blockAt(v, x, y, z))}`);
  console.log(`(${x},${z})`, col.join(' '));
}
