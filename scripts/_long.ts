import { traceBlocks } from '../server/Combat';
import { ARENA_FLOOR_Y, getMap } from '../src/modes/maps';
import { SOLID, TALL } from '../src/world/BlockRegistry';

const map = getMap(process.argv[2] as never);
const world = { getBlock: (x: number, y: number, z: number) => map.blockAt(0, x, y, z) };
const b = map.bounds;
const spots: [number, number, number][] = [];
for (let x = b.minX + 1; x < b.maxX - 1; x++) {
  for (let z = b.minZ + 1; z < b.maxZ - 1; z++) {
    for (let y = ARENA_FLOOR_Y; y <= ARENA_FLOOR_Y + 8; y++) {
      if (SOLID[world.getBlock(x, y, z)] && !TALL[world.getBlock(x, y, z)] && world.getBlock(x, y + 1, z) === 0 && world.getBlock(x, y + 2, z) === 0) spots.push([x + 0.5, z + 0.5, y + 1]);
    }
  }
}
const hist = new Map<string, number>();
let total = 0, long = 0;
for (let i = 0; i < 60000; i++) {
  const a = spots[Math.floor(Math.random() * spots.length)], c = spots[Math.floor(Math.random() * spots.length)];
  const dx = c[0] - a[0], dz = c[1] - a[1];
  const d0 = Math.hypot(dx, dz);
  if (d0 < 40) continue;
  total++;
  const ox = a[0], oy = a[2] + 1.62, oz = a[1], ex = c[0], ey = c[2] + 1, ez = c[1];
  const ddx = ex - ox, ddy = ey - oy, ddz = ez - oz, d = Math.hypot(ddx, ddy, ddz);
  if (traceBlocks(world, ox, oy, oz, ddx / d, ddy / d, ddz / d, d) >= d - 0.01) {
    long++;
    const k = `h${a[2] - ARENA_FLOOR_Y - 1} -> h${c[2] - ARENA_FLOOR_Y - 1}  (${Math.round(a[0] / 6) * 6},${Math.round(a[1] / 6) * 6})`;
    hist.set(k, (hist.get(k) ?? 0) + 1);
  }
}
console.log('pairs >40:', total, 'visible', long, ((100 * long) / total).toFixed(1) + '%');
console.log([...hist.entries()].sort((p, q) => q[1] - p[1]).slice(0, 14).map(([k, v]) => `${v} ${k}`).join('\n'));
