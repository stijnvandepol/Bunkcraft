/**
 * QA: plans a walking tour per map for `walk-maps.py`: from the first red spawn to every declared
 * high spot, onto every reachable raised platform (clusters of 4+ spots) and across the floor on a
 * grid, using the walk graph (scripts/qa/walkgraph.ts). The browser then drives the real player
 * physics along it and reports where it gets stuck.
 *
 *   npx tsx scripts/qa/walk-routes.ts <out.json> [seed=4242] [grid=12]
 */
import { writeFileSync } from 'node:fs';
import { ARENA_FLOOR_Y, MAPS } from '../../src/modes/maps';
import { type Node, WalkGraph, spawnNode } from './walkgraph';

const out = process.argv[2] ?? 'walk-routes.json';
const seed = Number(process.argv[3] ?? 4242);
const grid = Number(process.argv[4] ?? 12);

const routes: Record<string, { variant: number; start: Node; legs: { label: string; target: Node; path: [number, number, number][] }[] }> = {};
for (const map of MAPS) {
  const variant = map.variantFor(seed);
  const g = new WalkGraph(map, variant);
  const start = spawnNode(map.spawns.red[0]);
  const reach = g.bfs([start]).dist;
  const reachable = g.nodes.filter((n) => reach[g.key(n)] >= 0 && map.inBounds(n.x + 0.5, n.z + 0.5));
  const targets: { label: string; n: Node }[] = [];
  // Declared high ground: the highest standing spot in that column.
  for (const h of map.highGround) {
    const x = Math.floor(h.x), z = Math.floor(h.z);
    const top = reachable.filter((n) => n.x === x && n.z === z).sort((a, b) => b.y - a.y)[0];
    if (top) targets.push({ label: `high ground (${x},${top.y},${z})`, n: top });
  }
  // Raised platforms: one spot per cluster (6-neighbour flood over reachable spots above the floor).
  const upper = new Map<string, Node>();
  for (const n of reachable) if (n.y > ARENA_FLOOR_Y + 1) upper.set(`${n.x},${n.y},${n.z}`, n);
  const seen = new Set<string>();
  for (const [k, n] of upper) {
    if (seen.has(k)) continue;
    const q = [n]; seen.add(k);
    for (let i = 0; i < q.length; i++) {
      const c = q[i];
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]]) {
        const kk = `${c.x + dx},${c.y + dy},${c.z + dz}`;
        if (upper.has(kk) && !seen.has(kk)) { seen.add(kk); q.push(upper.get(kk)!); }
      }
    }
    if (q.length < 4) continue;
    const top = q.sort((a, b) => b.y - a.y)[Math.floor(q.length / 4)];
    if (!targets.some((t) => t.n.x === top.x && t.n.y === top.y && t.n.z === top.z)) targets.push({ label: `platform h${top.y - ARENA_FLOOR_Y - 1} (${top.x},${top.y},${top.z})`, n: top });
  }
  // Floor grid.
  const b = map.bounds;
  for (let x = b.minX + 3; x < b.maxX - 2; x += grid) for (let z = b.minZ + 3; z < b.maxZ - 2; z += grid) {
    let best: Node | null = null, bd = 1e9;
    for (const n of reachable) {
      if (n.y !== ARENA_FLOOR_Y + 1) continue;
      const d = Math.abs(n.x - x) + Math.abs(n.z - z);
      if (d < bd) { bd = d; best = n; }
    }
    if (best && bd <= 4) targets.push({ label: `floor (${best.x},${best.z})`, n: best });
  }
  // Greedy nearest-neighbour tour.
  const legs: { label: string; target: Node; path: [number, number, number][] }[] = [];
  let cur = start;
  const left = [...targets];
  while (left.length > 0) {
    const { dist } = g.bfs([cur]);
    let bi = -1, bd = Infinity;
    left.forEach((t, i) => { const d = dist[g.key(t.n)]; if (d >= 0 && d < bd) { bd = d; bi = i; } });
    if (bi < 0) break;
    const t = left.splice(bi, 1)[0];
    const path = g.path(cur, t.n)!;
    legs.push({ label: t.label, target: t.n, path: path.map((n) => [n.x, n.y, n.z]) });
    cur = t.n;
  }
  routes[map.id] = { variant, start, legs };
  console.log(`${map.id}: ${legs.length} legs, ${legs.reduce((s, l) => s + l.path.length, 0)} steps`);
}
writeFileSync(out, JSON.stringify(routes));
