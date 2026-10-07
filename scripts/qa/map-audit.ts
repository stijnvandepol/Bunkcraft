/**
 * QA: static audit of the arcade maps (no browser, no server). Builds a walk graph of every
 * standing spot (2 blocks of headroom on a solid block) with the arcade movement rules (step up
 * 1 block with a jump, drop any height, jump across 1-block gaps) and reports per map and variant:
 *
 *  - reachable / unreachable standing spots above the floor (platforms you cannot get onto)
 *  - traps: spots you can reach but cannot leave (no path back to your spawn)
 *  - wall: spots on or above the boundary wall (out of the arena; the server rubber-bands those)
 *  - highGround: whether every declared high spot is reachable
 *  - spawn exposure: reachable spots with a clear eye-to-chest line into a team spawn, how close
 *    the nearest one is, and how many of them lie on the enemy's own half (spawn-trap positions)
 *  - ffa spawns: pairs that see each other and the closest pair
 *  - first contact: walking time between the nearest red and blue spawn (7.3 b/s)
 *  - long sight lines: share of sampled eye-to-eye pairs ≥ 40 / ≥ 60 blocks apart that see each other
 *
 * Jump pads launch onto every landing `padLandings` (src/player/ArcadeMove) allows.
 *
 *   npx tsx scripts/qa/map-audit.ts [mapId] [--json out.json]
 */
import { writeFileSync } from 'node:fs';
import { traceBlocks } from '../../server/Combat';
import { ARENA_FLOOR_Y, MAPS, getMap } from '../../src/modes/maps';
import type { ArenaMap, Spawn } from '../../src/modes/maps/ArenaMap';
import { padLandings } from '../../src/player/ArcadeMove';
import { BLOCK, SOLID, TALL } from '../../src/world/BlockRegistry';

const args = process.argv.slice(2);
const jsonAt = args.indexOf('--json');
const jsonOut = jsonAt >= 0 ? args[jsonAt + 1] : '';
const only = args.find((a, i) => !a.startsWith('--') && !(jsonAt >= 0 && i === jsonAt + 1));
const maps = only ? [getMap(only)] : MAPS;

const EYE = 1.62;
const RUN_SPEED = 5.61 * 1.3;
const TOP = ARENA_FLOOR_Y + 16;

interface Node { x: number; y: number; z: number }

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

function audit(map: ArenaMap, variant: number) {
  const b = map.bounds;
  const solid = (x: number, y: number, z: number) => {
    const id = map.blockAt(variant, x, y, z);
    return id !== BLOCK.AIR && SOLID[id] === 1;
  };
  const world = { getBlock: (x: number, y: number, z: number) => map.blockAt(variant, x, y, z) };
  const W = b.maxX - b.minX, D = b.maxZ - b.minZ, H = TOP - ARENA_FLOOR_Y + 1;
  const idx = (x: number, y: number, z: number) => ((x - b.minX) * D + (z - b.minZ)) * H + (y - ARENA_FLOOR_Y);
  const stand = new Uint8Array(W * D * H);
  const nodes: Node[] = [];
  for (let x = b.minX; x < b.maxX; x++) for (let z = b.minZ; z < b.maxZ; z++) {
    for (let y = ARENA_FLOOR_Y + 1; y <= TOP - 2; y++) {
      if (solid(x, y - 1, z) && !TALL[map.blockAt(variant, x, y - 1, z)] && !solid(x, y, z) && !solid(x, y + 1, z)) { stand[idx(x, y, z)] = 1; nodes.push({ x, y, z }); }
    }
  }
  const isStand = (x: number, y: number, z: number) =>
    x >= b.minX && x < b.maxX && z >= b.minZ && z < b.maxZ && y > ARENA_FLOOR_Y && y <= TOP - 2 && stand[idx(x, y, z)] === 1;
  /** Highest standing spot in a column at or below y (falling down), or -1. */
  const landing = (x: number, y: number, z: number): number => {
    for (let yy = y; yy > ARENA_FLOOR_Y; yy--) {
      if (solid(x, yy, z)) return -1; // blocked on the way down (should not happen: we start in air)
      if (isStand(x, yy, z)) return yy;
    }
    return -1;
  };
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  /** Moves from a standing spot (forward graph). */
  const at = (x: number, y: number, z: number) => map.blockAt(variant, x, y, z);
  const landable = (id: number) => id !== BLOCK.AIR && SOLID[id] === 1 && !TALL[id];
  const pads: [number, number, number][] = [];
  const moves = (n: Node, out: Node[]): Node[] => {
    out.length = 0;
    if (at(n.x, n.y - 1, n.z) === BLOCK.JUMP_PAD) {
      pads.length = 0;
      padLandings(at, landable, n.x, n.y - 1, n.z, pads);
      for (const [x, z, y] of pads) if (isStand(x, y + 1, z)) out.push({ x, y: y + 1, z });
    }
    const headroomJump = !solid(n.x, n.y + 2, n.z);
    for (const [dx, dz] of DIRS) {
      const x = n.x + dx, z = n.z + dz;
      if (x < b.minX || x >= b.maxX || z < b.minZ || z >= b.maxZ) continue;
      // Step up one block with a jump.
      if (headroomJump && isStand(x, n.y + 1, z)) out.push({ x, y: n.y + 1, z });
      // Walk across or drop down.
      if (!solid(x, n.y, z) && !solid(x, n.y + 1, z)) {
        const l = landing(x, n.y, z);
        if (l > 0) out.push({ x, y: l, z });
        // Jump over a 1-wide gap (or a drop) onto a spot two columns ahead at the same height or one lower.
        if (headroomJump && !solid(x, n.y + 2, z)) {
          const x2 = n.x + 2 * dx, z2 = n.z + 2 * dz;
          for (const y2 of [n.y, n.y - 1]) if (l !== n.y && isStand(x2, y2, z2)) out.push({ x: x2, y: y2, z: z2 });
        }
      }
    }
    return out;
  };
  const key = (n: Node) => idx(n.x, n.y, n.z);
  const bfs = (starts: Node[]): Int32Array => {
    const dist = new Int32Array(W * D * H).fill(-1);
    const q: Node[] = [];
    for (const s of starts) if (isStand(s.x, s.y, s.z) && dist[key(s)] < 0) { dist[key(s)] = 0; q.push(s); }
    const tmp: Node[] = [];
    for (let i = 0; i < q.length; i++) {
      const n = q[i], d = dist[key(n)];
      for (const m of moves(n, tmp)) {
        const k = key(m);
        if (dist[k] < 0) { dist[k] = d + 1; q.push({ ...m }); }
      }
    }
    return dist;
  };
  const spawnNode = (s: Spawn): Node => ({ x: Math.floor(s.x), y: Math.round(s.y), z: Math.floor(s.z) });
  const allSpawns = [...map.spawns.red, ...map.spawns.blue, ...map.spawns.ffa];
  const reach = bfs(allSpawns.map(spawnNode));
  const inside = (n: Node) => map.inBounds(n.x + 0.5, n.z + 0.5);
  const reachable = nodes.filter((n) => reach[key(n)] >= 0);
  const unreachable = nodes.filter((n) => reach[key(n)] < 0 && inside(n));
  // Traps: reachable spots that cannot get back to any spawn (reverse search = forward search from each spot is expensive,
  // so check "can I reach the floor level somewhere connected to a spawn" by a forward BFS per connected chunk).
  const back = new Uint8Array(W * D * H);
  const tmp: Node[] = [];
  // Reverse graph: build predecessor lists once.
  const preds = new Map<number, number[]>();
  for (const n of reachable) for (const m of moves(n, tmp)) {
    const k = key(m);
    let l = preds.get(k);
    if (!l) preds.set(k, (l = []));
    l.push(key(n));
  }
  const q: number[] = [];
  for (const s of allSpawns) { const k = key(spawnNode(s)); if (!back[k]) { back[k] = 1; q.push(k); } }
  for (let i = 0; i < q.length; i++) for (const p of preds.get(q[i]) ?? []) if (!back[p]) { back[p] = 1; q.push(p); }
  const traps = reachable.filter((n) => !back[key(n)]);
  const onWall = reachable.filter((n) => !inside(n));
  const highGround = map.highGround.map((h) => {
    const x = Math.floor(h.x), z = Math.floor(h.z);
    let best = -1;
    for (let y = TOP - 2; y > ARENA_FLOOR_Y; y--) if (isStand(x, y, z)) { best = y; break; }
    return { x, z, y: best, reachable: best > 0 && reach[idx(x, best, z)] >= 0 };
  });
  // Upper levels: standing spots above the floor, grouped by height.
  const upper = (list: Node[]) => list.filter((n) => n.y > ARENA_FLOOR_Y + 1).length;

  // Spawn exposure (team spawns): reachable spots with a clear line from their eye to the spawn's chest/eye.
  const sees = (a: Node, tx: number, ty: number, tz: number): boolean => {
    const ox = a.x + 0.5, oy = a.y + EYE, oz = a.z + 0.5;
    const dx = tx - ox, dy = ty - oy, dz = tz - oz, d = Math.hypot(dx, dy, dz);
    return traceBlocks(world, ox, oy, oz, dx / d, dy / d, dz / d, d) >= d - 0.01;
  };
  const exposure = (team: 'red' | 'blue') => {
    const list = map.spawns[team];
    let total = 0, enemyHalf = 0, nearest = Infinity;
    let nearestAt: Node | null = null;
    const enemyHalfSpots: Node[] = [];
    const ownSide = (x: number) => (team === 'red' ? x < 0 : x >= 0);
    for (const n of reachable) {
      if (!inside(n)) continue;
      let any = false;
      for (const s of list) {
        if (sees(n, s.x, s.y + 1.2, s.z) || sees(n, s.x, s.y + EYE, s.z)) {
          any = true;
          const d = Math.hypot(n.x + 0.5 - s.x, n.z + 0.5 - s.z);
          if (d < nearest && !ownSide(n.x)) { nearest = d; nearestAt = n; }
        }
      }
      if (any) { total++; if (!ownSide(n.x)) { enemyHalf++; enemyHalfSpots.push(n); } }
    }
    // Spawn to enemy spawn.
    const other = map.spawns[team === 'red' ? 'blue' : 'red'];
    let spawnPairs = 0;
    for (const s of list) for (const o of other) if (sees(spawnNode(s), o.x, o.y + 1.2, o.z)) spawnPairs++;
    const far = enemyHalfSpots.sort((a, c) => Math.abs(c.x) - Math.abs(a.x)).slice(0, 3);
    return { seeingSpots: total, fromEnemyHalf: enemyHalf, nearestEnemyHalf: nearest === Infinity ? null : +nearest.toFixed(1), nearestAt, spawnPairs, sampleEnemyHalf: far };
  };
  const ffa = (() => {
    const list = map.spawns.ffa;
    let pairs = 0, seen = 0, closest = Infinity;
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      pairs++;
      const d = Math.hypot(list[i].x - list[j].x, list[i].z - list[j].z);
      closest = Math.min(closest, d);
      if (sees(spawnNode(list[i]), list[j].x, list[j].y + 1.2, list[j].z)) seen++;
    }
    return { spawns: list.length, pairs, seeEachOther: seen, closest: +closest.toFixed(1) };
  })();
  // First contact: BFS steps from all red spawns to the nearest blue spawn.
  const fromRed = bfs(map.spawns.red.map(spawnNode));
  let contact = Infinity;
  for (const s of map.spawns.blue) { const d = fromRed[key(spawnNode(s))]; if (d >= 0) contact = Math.min(contact, d); }
  // Long sight lines between random reachable floor/roof spots.
  const r = rng(99);
  let n40 = 0, s40 = 0, n60 = 0, s60 = 0, longest = 0;
  const pool = reachable.filter(inside);
  for (let i = 0; i < 40000; i++) {
    const a = pool[Math.floor(r() * pool.length)], c = pool[Math.floor(r() * pool.length)];
    const d = Math.hypot(a.x - c.x, a.z - c.z);
    if (d < 40) continue;
    const ok = sees(a, c.x + 0.5, c.y + 1.2, c.z + 0.5);
    n40++; if (ok) s40++;
    if (d >= 60) { n60++; if (ok) s60++; }
    if (ok) longest = Math.max(longest, d);
  }
  // Spawns standing in a block or on nothing, and objectives (zones, flags) nobody can walk to.
  const badSpawns = allSpawns.filter((s) => !isStand(Math.floor(s.x), Math.round(s.y), Math.floor(s.z)))
    .map((s) => `(${s.x},${s.y},${s.z})`);
  const objective = (label: string, x: number, y: number, z: number) => {
    const bx = Math.floor(x), bz = Math.floor(z);
    const ok = isStand(bx, y, bz) && reach[idx(bx, y, bz)] >= 0;
    return { label, x, y, z, ok };
  };
  const objectives = [
    ...map.zones.map((zn) => objective(`zone ${zn.name}`, zn.x, zn.y, zn.z)),
    ...map.flags.map((f) => objective(`flag ${f.team}`, f.x, f.y, f.z)),
  ];
  return {
    badSpawns, objectives,
    map: map.id, variant, size: `${W}x${D}`, wallHeight: map.wallHeight,
    standing: nodes.length, reachable: reachable.length, upperReachable: upper(reachable),
    unreachable: unreachable.length, unreachableUpper: upper(unreachable),
    unreachableSamples: clusters(unreachable.filter((n) => n.y > ARENA_FLOOR_Y + 1)),
    traps: traps.length, trapSamples: clusters(traps), onWall: onWall.length, onWallSamples: clusters(onWall),
    highGround, exposure: { red: exposure('red'), blue: exposure('blue') }, ffa,
    firstContactSec: contact === Infinity ? null : +(contact / RUN_SPEED).toFixed(1),
    longLines: { pairs40: n40, seeing40pct: +(100 * s40 / Math.max(1, n40)).toFixed(1), pairs60: n60, seeing60pct: +(100 * s60 / Math.max(1, n60)).toFixed(1), longest: +longest.toFixed(0) },
  };
}

/** Groups spots into clusters (6-neighbour flood) and returns the centre and size of the biggest ones. */
function clusters(list: Node[]): { x: number; y: number; z: number; size: number; h: number }[] {
  const set = new Map<string, Node>();
  for (const n of list) set.set(`${n.x},${n.y},${n.z}`, n);
  const seen = new Set<string>();
  const out: { x: number; y: number; z: number; size: number; h: number }[] = [];
  for (const [k, n] of set) {
    if (seen.has(k)) continue;
    const q = [n]; seen.add(k);
    let sx = 0, sy = 0, sz = 0;
    for (let i = 0; i < q.length; i++) {
      const c = q[i]; sx += c.x; sy += c.y; sz += c.z;
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]]) {
        const kk = `${c.x + dx},${c.y + dy},${c.z + dz}`;
        if (set.has(kk) && !seen.has(kk)) { seen.add(kk); q.push(set.get(kk)!); }
      }
    }
    out.push({ x: Math.round(sx / q.length), y: Math.round(sy / q.length), z: Math.round(sz / q.length), size: q.length, h: Math.round(sy / q.length) - ARENA_FLOOR_Y - 1 });
  }
  return out.sort((a, b) => b.size - a.size).slice(0, 8);
}

const results = [];
for (const map of maps) {
  for (let v = 0; v < map.variants; v++) {
    const a = audit(map, v);
    results.push(a);
    console.log(`\n== ${a.map} (variant ${v}) ${a.size}, wall ${a.wallHeight}`);
    console.log(`standing spots ${a.standing}, reachable ${a.reachable} (above floor ${a.upperReachable}), unreachable inside ${a.unreachable} (above floor ${a.unreachableUpper})`);
    if (a.unreachableSamples.length) console.log('  unreachable platforms (centre x,y,z  size  height):', a.unreachableSamples.map((c) => `(${c.x},${c.y},${c.z}) ${c.size} h${c.h}`).join('; '));
    console.log(`traps (cannot get back): ${a.traps}`, a.trapSamples.map((c) => `(${c.x},${c.y},${c.z}) ${c.size}`).join('; '));
    console.log(`on/over the wall: ${a.onWall}`, a.onWallSamples.map((c) => `(${c.x},${c.y},${c.z}) ${c.size}`).join('; '));
    console.log('highGround:', a.highGround.map((h) => `(${h.x},${h.y},${h.z})${h.reachable ? '' : ' UNREACHABLE'}`).join(' '));
    for (const t of ['red', 'blue'] as const) {
      const e = a.exposure[t];
      console.log(`${t} spawn: seen from ${e.seeingSpots} spots, ${e.fromEnemyHalf} on the enemy half, nearest enemy-half spot ${e.nearestEnemyHalf} m${e.nearestAt ? ` at (${e.nearestAt.x},${e.nearestAt.y},${e.nearestAt.z})` : ''}; spawn-to-spawn lines ${e.spawnPairs}`);
    }
    console.log(`ffa: ${a.ffa.spawns} spawns, ${a.ffa.seeEachOther}/${a.ffa.pairs} pairs see each other, closest pair ${a.ffa.closest} m`);
    if (a.badSpawns.length) console.log('BAD SPAWNS (not a standing spot):', a.badSpawns.join(' '));
    const badObj = a.objectives.filter((o) => !o.ok);
    console.log(`objectives: ${a.objectives.length}${badObj.length ? ', UNREACHABLE: ' + badObj.map((o) => `${o.label} (${o.x},${o.y},${o.z})`).join('; ') : ' all reachable'}`);
    console.log(`first contact ${a.firstContactSec} s; long lines: ${a.longLines.seeing40pct}% of ≥40 m pairs, ${a.longLines.seeing60pct}% of ≥60 m pairs see each other; longest ${a.longLines.longest} m`);
  }
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(results, null, 1));
