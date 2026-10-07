/**
 * Layout metrics for the arena maps, as input for the map critique in docs/research/ARCADE.md.
 *
 *   npx tsx scripts/map-metrics.ts [map id]
 *
 * - cover %      walkable ground cells that are blocked at body height (walls, crates, buildings), inside the wall
 * - free path    mean length (blocks) of a horizontal eye-height ray from a random open cell in a random direction,
 *                capped at 80: how far you can typically see
 * - long %       share of those rays that reach >= 40 blocks (sniper lanes)
 * - route        shortest walking route (4-neighbour BFS over open ground cells) between the nearest red and blue spawn,
 *                divided by the straight distance; 1.0 = open field, >1.5 = a maze that forces a lot of flow
 * - spawn open   mean free path of rays that start at team spawns (high = a spawn that is exposed)
 * - vis %        mean share of the open floor cells a player standing on a random open cell can see (eye to eye):
 *                how open the map is as a whole (Nuketown-like small maps want this low)
 * - ctr %        share of the open floor cells visible from the open cell nearest to the centre
 */
import { traceBlocks } from '../server/Combat';
import { ARENA_FLOOR_Y, MAPS, getMap } from '../src/modes/maps';

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

const maps = process.argv[2] ? [getMap(process.argv[2])] : MAPS;
console.log('map'.padEnd(10) + 'size'.padStart(8) + 'cover%'.padStart(8) + 'freepath'.padStart(10) + 'long%'.padStart(7) + 'route'.padStart(7) + 'spawnopen'.padStart(11) + 'vis%'.padStart(7) + 'ctr%'.padStart(7));
for (const map of maps) {
  const b = map.bounds;
  const world = { getBlock: (x: number, y: number, z: number) => map.blockAt(0, x, y, z) };
  const open = (x: number, z: number): boolean =>
    map.inBounds(x + 0.5, z + 0.5) && map.blockAt(0, x, ARENA_FLOOR_Y + 1, z) === 0 && map.blockAt(0, x, ARENA_FLOOR_Y + 2, z) === 0;
  const cells: [number, number][] = [];
  let blocked = 0, total = 0;
  for (let x = b.minX + 1; x < b.maxX - 1; x++) {
    for (let z = b.minZ + 1; z < b.maxZ - 1; z++) {
      total++;
      if (open(x, z)) cells.push([x, z]); else blocked++;
    }
  }
  const r = rng(12345);
  const ray = (x: number, z: number): number => {
    const a = r() * Math.PI * 2;
    return traceBlocks(world, x + 0.5, ARENA_FLOOR_Y + 1 + 1.62, z + 0.5, Math.cos(a), 0, Math.sin(a), 80);
  };
  let sum = 0, long = 0;
  const N = 20000;
  for (let i = 0; i < N; i++) {
    const [x, z] = cells[Math.floor(r() * cells.length)];
    const d = ray(x, z);
    sum += d;
    if (d >= 40) long++;
  }
  let sp = 0, spn = 0;
  for (const s of map.spawns.red) for (let i = 0; i < 200; i++) { sp += ray(Math.floor(s.x), Math.floor(s.z)); spn++; }

  // BFS from the red spawn nearest to the blue side.
  const idx = (x: number, z: number): number => (x - b.minX) * (b.maxZ - b.minZ) + (z - b.minZ);
  const dist = new Int32Array((b.maxX - b.minX) * (b.maxZ - b.minZ)).fill(-1);
  const red = map.spawns.red[0], blue = map.spawns.blue[0];
  const q: [number, number][] = [[Math.floor(red.x), Math.floor(red.z)]];
  dist[idx(q[0][0], q[0][1])] = 0;
  for (let h = 0; h < q.length; h++) {
    const [x, z] = q[h];
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, nz = z + dz;
      if (!open(nx, nz) || dist[idx(nx, nz)] >= 0) continue;
      dist[idx(nx, nz)] = dist[idx(x, z)] + 1;
      q.push([nx, nz]);
    }
  }
  const route = dist[idx(Math.floor(blue.x), Math.floor(blue.z))];

  // Visibility: eye (1.62) to eye between open floor cells.
  const eye = ARENA_FLOOR_Y + 1 + 1.62;
  const sees = (a: [number, number], c: [number, number]) => {
    const dx = c[0] - a[0], dz = c[1] - a[1], d = Math.hypot(dx, dz);
    return d === 0 || traceBlocks(world, a[0] + 0.5, eye, a[1] + 0.5, dx / d, 0, dz / d, d) >= d - 0.01;
  };
  let vis = 0;
  const VO = 300, VT = 300;
  for (let i = 0; i < VO; i++) {
    const a = cells[Math.floor(r() * cells.length)];
    for (let j = 0; j < VT; j++) if (sees(a, cells[Math.floor(r() * cells.length)])) vis++;
  }
  const centre = cells.reduce((m, c) => (Math.hypot(c[0] + 0.5, c[1] + 0.5) < Math.hypot(m[0] + 0.5, m[1] + 0.5) ? c : m), cells[0]);
  let ctr = 0;
  for (const c of cells) if (sees(centre, c)) ctr++;
  const straight = Math.hypot(red.x - blue.x, red.z - blue.z);
  console.log(
    map.id.padEnd(10) + `${b.maxX - b.minX}x${b.maxZ - b.minZ}`.padStart(8) + (100 * blocked / total).toFixed(1).padStart(8) +
    (sum / N).toFixed(1).padStart(10) + (100 * long / N).toFixed(0).padStart(7) + (route >= 0 ? (route / straight).toFixed(2) : 'n/a').padStart(7) +
    (sp / spn).toFixed(1).padStart(11) + (100 * vis / (VO * VT)).toFixed(1).padStart(7) + (100 * ctr / cells.length).toFixed(1).padStart(7),
  );
}
