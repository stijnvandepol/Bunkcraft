/**
 * Chunk generation cost per generator version on a fixed area (after a warm-up), mean and p95 in ms,
 * plus the cost of the main-thread functions used for the spawn search.
 *
 *   npx tsx scripts/bench-gen.ts [seed=12345] [grid=24]
 */
import { TerrainGenerator } from '../src/world/TerrainGenerator';
import { CHUNK_VOLUME } from '../src/world/constants';

const seed = Number(process.argv[2] ?? 12345);
const grid = Number(process.argv[3] ?? 24);
const blocks = new Uint8Array(CHUNK_VOLUME);

for (const version of [1, 2, 3]) {
  const gen = new TerrainGenerator(seed, version);
  for (let i = 0; i < 150; i++) gen.generate(i, -i, blocks);
  const times: number[] = [];
  for (let cz = 0; cz < grid; cz++) {
    for (let cx = 0; cx < grid; cx++) {
      const t0 = performance.now();
      gen.generate(cx - 5, cz + 3, blocks);
      times.push(performance.now() - t0);
    }
  }
  times.sort((a, b) => a - b);
  const mean = times.reduce((s, t) => s + t, 0) / times.length;
  const t0 = performance.now();
  let acc = 0;
  for (let i = 0; i < 20000; i++) {
    const h = gen.heightAt(i * 7, -i * 3);
    acc += gen.biomeAt(i * 7, -i * 3, Math.floor(h)) + (gen.surfaceOpen(i * 7, -i * 3) ? 1 : 0);
  }
  const spawn = (performance.now() - t0) / 20000 * 1000;
  const t1 = performance.now();
  for (let i = 0; i < 20000; i++) acc += gen.biomeAt(i * 5, i * 3, Math.floor(gen.heightAt(i * 5, i * 3)));
  const column = (performance.now() - t1) / 20000 * 1000;
  console.log(`gen v${version}: mean ${mean.toFixed(2)} ms, p50 ${times[times.length >> 1].toFixed(2)}, p95 ${times[Math.floor(times.length * 0.95)].toFixed(2)}, max ${times[times.length - 1].toFixed(2)} (${times.length} chunks); heightAt+biomeAt ${column.toFixed(2)} us, +surfaceOpen ${spawn.toFixed(1)} us per column${acc < 0 ? '!' : ''}`);
}
