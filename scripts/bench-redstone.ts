/**
 * Redstone tick cost and GC: a field of dust lines fed by levers that toggle every few ticks.
 *   npx tsx --expose-gc scripts/bench-redstone.ts [lines] [length] [ticks]
 * Prints the tick time distribution and the heap growth per tick (garbage the simulation makes).
 */
import { BLOCK } from '../src/world/BlockRegistry';
import { LEVER_ON, RedstoneSim } from '../src/world/Redstone';

const LINES = Number(process.argv[2] ?? 40);
const LENGTH = Number(process.argv[3] ?? 15);
const TICKS = Number(process.argv[4] ?? 4000);
const FLOOR = 3;
const SIZE = 256;
const ids = new Uint8Array(SIZE * SIZE * 128);
const metas = new Uint8Array(SIZE * SIZE * 128);
const idx = (x: number, y: number, z: number) => (x & 255) | ((z & 255) << 8) | (y << 16);

const world = {
  getBlock: (x: number, y: number, z: number) => (y < 0 ? BLOCK.BEDROCK : y === 63 ? BLOCK.STONE : ids[idx(x, y, z)]),
  getMeta: (x: number, y: number, z: number) => (y < 0 || y > 127 ? 0 : metas[idx(x, y, z)]),
  setState(x: number, y: number, z: number, id: number, meta: number) {
    ids[idx(x, y, z)] = id;
    metas[idx(x, y, z)] = meta;
    sim.notify(x, y, z);
  },
  entitiesOn: () => 0,
};
const sim = new RedstoneSim(world);

for (let l = 0; l < LINES; l++) {
  const z = 4 + l * 2;
  for (let x = 1; x <= LENGTH; x++) world.setState(x, 64, z, BLOCK.REDSTONE_WIRE, 0);
  world.setState(0, 64, z, BLOCK.LEVER, FLOOR);
}
for (let i = 0; i < 20; i++) sim.tick();

const gc = (globalThis as { gc?: () => void }).gc;
const times: number[] = [];
gc?.();
const heap0 = process.memoryUsage().heapUsed;
let maxHeap = heap0;
for (let t = 0; t < TICKS; t++) {
  if (t % 4 === 0) {
    const on = (t / 4) % 2 === 0;
    for (let l = 0; l < LINES; l++) world.setState(0, 64, 4 + l * 2, BLOCK.LEVER, FLOOR | (on ? LEVER_ON : 0));
  }
  const t0 = performance.now();
  sim.tick();
  times.push(performance.now() - t0);
  maxHeap = Math.max(maxHeap, process.memoryUsage().heapUsed);
}
times.sort((a, b) => a - b);
const q = (p: number) => times[Math.min(times.length - 1, Math.floor(times.length * p))].toFixed(3);
console.log(`${LINES} lines x ${LENGTH} dust, ${TICKS} ticks: median ${q(0.5)} ms, p99 ${q(0.99)} ms, max ${times[times.length - 1].toFixed(2)} ms, ` +
  `ticks > 20 ms: ${times.filter((x) => x > 20).length}, heap high-water +${((maxHeap - heap0) / 1048576).toFixed(1)} MB`);
