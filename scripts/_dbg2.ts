import { ARENA_FLOOR_Y, getMap } from '../src/modes/maps';
import { reachable, keyOf } from '../tests/helpers/mapAnalysis';
import { SOLID, TALL } from '../src/world/BlockRegistry';
const map = getMap(process.argv[2] as never);
const at = (x: number, y: number, z: number) => map.blockAt(0, x, y, z);
const sp = map.spawns.red[0];
const seen = reachable(map, 0, Math.floor(sp.x), Math.floor(sp.z));
const [x0, z0] = [Number(process.argv[3]), Number(process.argv[4])];
for (let dz = -3; dz <= 3; dz++) {
  let row = '';
  for (let dx = -4; dx <= 4; dx++) {
    const x = x0 + dx, z = z0 + dz;
    let top = 0;
    for (let h = 12; h >= 0; h--) if (at(x, ARENA_FLOOR_Y + h, z) !== 0) { top = h; break; }
    row += ` ${top}${seen.has(keyOf(x, z, ARENA_FLOOR_Y + top)) ? '*' : ' '}`;
  }
  console.log(z0 + dz, row);
}
console.log('solid pad', SOLID[253], TALL[253]);
