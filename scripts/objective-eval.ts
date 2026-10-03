/**
 * Checks candidate zone/flag positions (world coordinates) against the rules of tests/mapObjectives.test.ts.
 *
 *   npx tsx scripts/objective-eval.ts <map id> zone <x> <z> <r> ... flag <x> <z> ...
 */
import { ARENA_FLOOR_Y, getMap } from '../src/modes/maps';
import { keyOf, openShare, reachable, seenFrom, standable } from '../tests/helpers/mapAnalysis';

const [id, ...rest] = process.argv.slice(2);
const map = getMap(id);
const rs = reachable(map, 0, Math.floor(map.spawns.red[0].x), Math.floor(map.spawns.red[0].z));
const bs = reachable(map, 0, Math.floor(map.spawns.blue[0].x), Math.floor(map.spawns.blue[0].z));
for (let i = 0; i < rest.length;) {
  const kind = rest[i++];
  const x = Number(rest[i++]), z = Number(rest[i++]);
  const r = kind === 'zone' ? Number(rest[i++]) : 1.6;
  const y = map.heightAt(0, x, z) + 1;
  const stand = standable(map, 0, Math.floor(x), y - 1, Math.floor(z));
  const share = openShare(map, 0, x, z, y, r);
  const k = keyOf(Math.floor(x), Math.floor(z), y - 1);
  const reach = rs.has(k) && bs.has(k);
  const enemies = Math.abs(x) <= 3 ? [...map.spawns.red, ...map.spawns.blue] : x > 0 ? map.spawns.red : map.spawns.blue;
  const seen = seenFrom(map, 0, enemies, x, y, z);
  const own = x > 0 ? map.spawns.blue : map.spawns.red, enemy = x > 0 ? map.spawns.red : map.spawns.blue;
  const dOwn = Math.min(...own.map((s) => Math.hypot(s.x - x, s.z - z)));
  const dEnemy = Math.min(...enemy.map((s) => Math.hypot(s.x - x, s.z - z)));
  const dSpawn = Math.min(dOwn, dEnemy);
  const ok = kind === 'zone'
    ? stand && share >= 0.6 && reach && !seen && dSpawn > r + 3
    : stand && openShare(map, 0, x, z, y, 1.6) >= 0.7 && reach && !seen && dOwn >= 8 && dOwn <= 25 && dEnemy > 30;
  console.log(`${ok ? 'OK ' : 'BAD'} ${kind} ${x},${z} r${r}: level ${y - ARENA_FLOOR_Y - 1} stand=${stand} open=${share.toFixed(2)} reach=${reach} seen=${seen} own=${dOwn.toFixed(0)} enemy=${dEnemy.toFixed(0)}`);
}
