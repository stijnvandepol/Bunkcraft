import { ARENA_FLOOR_Y, getMap } from '../src/modes/maps';
import { reachable, keyOf } from '../tests/helpers/mapAnalysis';
import { padLandings } from '../src/player/ArcadeMove';
import { SOLID, TALL } from '../src/world/BlockRegistry';
const map = getMap(process.argv[2] as never);
const at = (x: number, y: number, z: number) => map.blockAt(0, x, y, z);
const sp = map.spawns.red[0];
const seen = reachable(map, 0, Math.floor(sp.x), Math.floor(sp.z));
for (let x = -34; x < 34; x++) {
  for (let z = -22; z < 22; z++) {
    for (let h = 1; h < 8; h++) {
      if (at(x, ARENA_FLOOR_Y + h, z) !== 253) continue;
      const o2: [number, number, number][] = [];
      padLandings(at, (id) => SOLID[id] === 1 && !TALL[id], x, ARENA_FLOOR_Y + h, z, o2);
      console.log('pad', x, z, 'h', h, 'reach', seen.has(keyOf(x, z, ARENA_FLOOR_Y + h)), 'landings', o2.length, 'above', [1, 2, 3, 4, 5, 6, 7].map((k) => at(x, ARENA_FLOOR_Y + h + k, z)).join(','));
    }
  }
}
