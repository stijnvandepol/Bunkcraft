
import { ServerWorld } from './server/ServerWorld';
import { BLOCK } from './src/world/BlockRegistry';
(() => { if (process.env.SKIP) return;
  const w = new ServerWorld(1, {});
  for (let i = 0; i < 40; i++) w.update([{ x: 0, z: 0 }]);
  const y = 110;
  for (let z = -17; z < 17; z++) {
    for (let x = 0; x <= 15; x++) w.setBlock(x, y - 1, z * 2, BLOCK.STONE);
    for (let x = 1; x <= 15; x++) w.setBlock(x, y, z * 2, BLOCK.REDSTONE_WIRE);
  }
  w.tickRedstone();
  const times: number[] = [];
  for (let round = 0; round < 200; round++) {
    const on = round % 2 === 0;
    for (let z = -17; z < 17; z++) w.setBlock(0, y, z * 2, BLOCK.LEVER, 3 | (on ? 8 : 0));
    const t0 = performance.now();
    w.tickRedstone();
    times.push(performance.now() - t0);
    w.drainSimEdits();
  }
  times.sort((a, b) => a - b);
  process.stdout.write(`median ${times[100].toFixed(2)} p90 ${times[180].toFixed(2)} max ${times[199].toFixed(2)}\n`);
})();
import { makeTestWorld } from './tests/helpers';
(() => {
  const w = makeTestWorld();
  w.enableRedstone();
  const y = 70;
  for (let z = -16; z < 32; z++) {
    for (let x = -16; x <= 16; x++) w.setBlock(x, y - 1, z, BLOCK.STONE);
    if (z % 2 === 0) for (let x = -15; x <= 15; x++) if (x !== 0) w.setBlock(x, y, z, BLOCK.REDSTONE_WIRE);
  }
  w.tickRedstone();
  const times: number[] = [];
  for (let round = 0; round < 200; round++) {
    const on = round % 2 === 0;
    for (let z = -16; z < 32; z += 2) w.setBlock(0, y, z, BLOCK.LEVER, 3 | (on ? 8 : 0));
    const t0 = performance.now();
    w.tickRedstone();
    times.push(performance.now() - t0);
  }
  if (process.env.SKIP) process.stdout.write(times.slice(100, 140).map((t) => t.toFixed(1)).join(' ') + '\n');
  times.sort((a, b) => a - b);
  let n = 0; for (const c of w.chunks.chunks.values()) n++;
  process.stdout.write(`SP median ${times[100].toFixed(2)} p90 ${times[180].toFixed(2)} max ${times[199].toFixed(2)} (dust ${24 * 30})\n`);
})();
