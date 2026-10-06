/**
 * QA: a tiny local HTTP service that plans walking paths on an arena map for the browser play tests
 * (play-modes.py). Paths come from the walk graph (scripts/qa/walkgraph.ts).
 *
 *   npx tsx scripts/qa/route-server.ts [port=5418]
 *   GET /path?map=atomic&seed=123&from=x,y,z&to=x,y,z  ->  { path: [[x,y,z], ...] } or { path: null }
 *   GET /info?map=atomic&seed=123                      ->  { variant, zones, flags, spawns }
 */
import { createServer } from 'node:http';
import { ARENA_FLOOR_Y, getMap } from '../../src/modes/maps';
import { type Node, WalkGraph } from './walkgraph';

const port = Number(process.argv[2] ?? 5418);
const graphs = new Map<string, WalkGraph>();

function graph(mapId: string, seed: number): WalkGraph {
  const map = getMap(mapId);
  const variant = map.variantFor(seed);
  const key = `${map.id}:${variant}`;
  let g = graphs.get(key);
  if (!g) graphs.set(key, (g = new WalkGraph(map, variant)));
  return g;
}

/** The standing spot nearest to a position (same column first, then a widening search). */
function snap(g: WalkGraph, x: number, y: number, z: number): Node | null {
  const bx = Math.floor(x), bz = Math.floor(z), by = Math.round(y);
  for (let r = 0; r <= 4; r++) {
    let best: Node | null = null, bd = Infinity;
    for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
      for (let yy = by + 2; yy >= Math.max(ARENA_FLOOR_Y + 1, by - 3); yy--) {
        if (!g.isStand(bx + dx, yy, bz + dz)) continue;
        const d = Math.abs(dx) + Math.abs(dz) + Math.abs(yy - by) * 0.5;
        if (d < bd) { bd = d; best = { x: bx + dx, y: yy, z: bz + dz }; }
      }
    }
    if (best) return best;
  }
  return null;
}

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const send = (code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify(body));
  };
  try {
    const mapId = url.searchParams.get('map') ?? 'classic';
    const seed = Number(url.searchParams.get('seed') ?? 0);
    const g = graph(mapId, seed);
    if (url.pathname === '/info') {
      const m = g.map;
      return send(200, { variant: g.variant, zones: m.zones, flags: m.flags, spawns: m.spawns });
    }
    if (url.pathname === '/path') {
      const [fx, fy, fz] = (url.searchParams.get('from') ?? '').split(',').map(Number);
      const [tx, ty, tz] = (url.searchParams.get('to') ?? '').split(',').map(Number);
      const a = snap(g, fx, fy, fz), b = snap(g, tx, ty, tz);
      if (!a || !b) return send(200, { path: null, reason: !a ? 'start not on a standing spot' : 'target not on a standing spot' });
      const p = g.path(a, b);
      return send(200, { path: p ? p.map((n) => [n.x, n.y, n.z]) : null, from: a, to: b });
    }
    send(404, { error: 'not found' });
  } catch (e) {
    send(500, { error: String(e) });
  }
}).listen(port, () => console.log(`route server on :${port}`));
