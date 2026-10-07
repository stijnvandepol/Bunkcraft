/**
 * Helps placing bomb sites (search and destroy): ranks pairs of floor spots in the blue half (x > 0) of a map.
 *
 * A spot is a candidate when, in every cover variant, its centre is standable floor, at least `MIN_OPEN` of its
 * disc (r = 3) is open, both sides can walk to it, no red (attacker) spawn sees it, it is more than 6 blocks from
 * every blue spawn and the defenders get there clearly first (walk ≤ 75% of the attackers'). Mirrored maps pair a
 * spot with its mirror over the z axis (A at z < 0, B at z > 0: equal by construction); free maps pair spots whose
 * attacker walks differ by at most 15% and that lie at least 20 blocks apart. Pairs are scored on an attacker
 * walk near `TARGET` cells (about 9 s), a defender walk near `DEF_SHARE` of it and a little cover around the site.
 *
 *   npx tsx scripts/site-scan.ts [map id ...]
 */
import { ARENA_FLOOR_Y, MAPS, getMap, type ArenaMap } from '../src/modes/maps';
import { keyOf, openShare, seenFrom, standable, walkDistances } from '../tests/helpers/mapAnalysis';

const R = 3;
const MIN_OPEN = 0.72;
const TARGET = 62;
/** The share of the attackers' walk the defenders should need (they hold, the attackers push). */
const DEF_SHARE = 0.45;

interface Spot { x: number; z: number; att: number; def: number; open: number }

function spots(map: ArenaMap): Spot[] {
  const b = map.bounds;
  const att = Array.from({ length: map.variants }, (_, v) => walkDistances(map, v, map.spawns.red));
  const def = Array.from({ length: map.variants }, (_, v) => walkDistances(map, v, map.spawns.blue));
  const out: Spot[] = [];
  for (let x = 4; x < b.maxX - 5; x++) {
    for (let z = b.minZ + 5; z < b.maxZ - 5; z++) {
      const px = x + 0.5, pz = z + 0.5, y = ARENA_FLOOR_Y + 1;
      if (map.spawns.blue.some((s) => Math.hypot(s.x - px, s.z - pz) <= R + 3)) continue;
      let a = 0, d = 0, open = 1, ok = true;
      for (let v = 0; v < map.variants && ok; v++) {
        const k = keyOf(x, z, ARENA_FLOOR_Y);
        const da = att[v].get(k), dd = def[v].get(k);
        if (!standable(map, v, x, ARENA_FLOOR_Y, z) || da === undefined || dd === undefined) { ok = false; break; }
        open = Math.min(open, openShare(map, v, px, pz, y, R));
        if (open < MIN_OPEN || seenFrom(map, v, map.spawns.red, px, y, pz)) ok = false;
        a = Math.max(a, da); d = Math.max(d, dd);
      }
      if (ok && d <= a * 0.75) out.push({ x: px, z: pz, att: a, def: d, open });
    }
  }
  return out;
}

const score = (s: Spot) => Math.abs(s.att - TARGET) + 40 * Math.abs(s.def / s.att - DEF_SHARE) + (s.open > 0.95 ? 6 : 0) + Math.max(0, 10 - s.def);

function scan(map: ArenaMap): void {
  const list = spots(map);
  const pairs: { a: Spot; b: Spot; score: number }[] = [];
  if (map.mirrored) {
    for (const s of list) {
      if (s.z > -8) continue;
      const twin = list.find((o) => o.x === s.x && o.z === -s.z);
      if (twin) pairs.push({ a: s, b: twin, score: score(s) + score(twin) });
    }
  } else {
    const top = list.sort((p, q) => score(p) - score(q)).slice(0, 400);
    for (let i = 0; i < top.length; i++) {
      for (let j = i + 1; j < top.length; j++) {
        const a = top[i], b = top[j];
        if (Math.hypot(a.x - b.x, a.z - b.z) < 20 || Math.abs(a.att - b.att) > 0.15 * Math.max(a.att, b.att)) continue;
        const [first, second] = a.z <= b.z ? [a, b] : [b, a];
        pairs.push({ a: first, b: second, score: score(a) + score(b) });
      }
    }
  }
  pairs.sort((p, q) => p.score - q.score);
  console.log(`\n${map.id} (${map.mirrored ? 'mirrored' : 'free'}): ${list.length} spots, ${pairs.length} pairs`);
  for (const p of pairs.slice(0, 5)) {
    const f = (s: Spot) => `(${s.x}, ${s.z}) att ${s.att} def ${s.def} open ${s.open.toFixed(2)}`;
    console.log(`  A ${f(p.a)} | B ${f(p.b)}`);
  }
}

const ids = process.argv.slice(2);
for (const map of ids.length ? ids.map((id) => getMap(id)) : MAPS) scan(map);
