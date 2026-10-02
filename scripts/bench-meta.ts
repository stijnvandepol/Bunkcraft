/**
 * Cost of the block state byte per chunk: memory and the extra copying when it is always allocated, against the
 * lazy scheme BunkCraft uses (null until a chunk holds a non-default state).
 *
 *   npx tsx scripts/bench-meta.ts
 */
import { ChunkMesher } from '../src/rendering/ChunkMesher';
import { CHUNK_AREA, CHUNK_VOLUME } from '../src/world/constants';
import { TerrainGenerator } from '../src/world/TerrainGenerator';

const gen = new TerrainGenerator(12345);
const blocks: Uint8Array[] = [];
const biomes: Uint8Array[] = [];
for (let i = 0; i < 9; i++) {
  const b = new Uint8Array(CHUNK_VOLUME), bi = new Uint8Array(CHUNK_AREA);
  gen.generate((i % 3) - 1, Math.floor(i / 3) - 1, b, bi);
  blocks.push(b);
  biomes.push(bi);
}
const mesher = new ChunkMesher();

function time(label: string, fn: () => void, rounds = 200): number {
  for (let i = 0; i < 20; i++) fn();
  const t0 = performance.now();
  for (let i = 0; i < rounds; i++) fn();
  const ms = (performance.now() - t0) / rounds;
  console.log(`${label.padEnd(58)} ${ms.toFixed(3)} ms`);
  return ms;
}

const lazy = time('mesh, meta = null for all 9 chunks (lazy scheme)', () => { mesher.mesh(blocks, biomes, true, Array(9).fill(null)); });
const zeros = Array.from({ length: 9 }, () => new Uint8Array(CHUNK_VOLUME));
const always = time('mesh, an all-zero meta array for all 9 chunks (always)', () => { mesher.mesh(blocks, biomes, true, zeros); });
time('structuredClone of the 9 meta arrays (what each mesh job pays)', () => { structuredClone(zeros); }, 100);
time('structuredClone of the 9 block arrays (for comparison)', () => { structuredClone(blocks); }, 100);
console.log(`\nextra per mesh when always allocated: ${(always - lazy).toFixed(3)} ms of mesher time, plus the clone above`);
const chunks = 325; // render distance 8 plus the generation ring
console.log(`resident meta at render distance 8 if always allocated: ${((chunks * CHUNK_VOLUME) / 1048576).toFixed(1)} MB; lazy: 0 MB until a chunk holds a state`);
