/**
 * Where does a chunk mesh job spend its time? Wraps the phases of ChunkMesher.mesh() with timers
 * (buildRegion = copy 3x3 chunks, lighting = BFS over 48x48x130, faces = greedy meshing).
 *
 *   npx tsx scripts/experiments/bench-mesh-phases.ts
 */
import { ChunkMesher } from '../../src/rendering/ChunkMesher';
import { CHUNK_AREA, CHUNK_VOLUME } from '../../src/world/constants';
import { TerrainGenerator } from '../../src/world/TerrainGenerator';

const gen = new TerrainGenerator(12345);
const R = 4;
const blocks = new Map<number, Uint8Array>();
const biomes = new Map<number, Uint8Array>();
for (let cz = -R; cz <= R; cz++) for (let cx = -R; cx <= R; cx++) {
  const b = new Uint8Array(CHUNK_VOLUME), bi = new Uint8Array(CHUNK_AREA);
  gen.generate(cx, cz, b, bi);
  blocks.set(cz * 100 + cx, b); biomes.set(cz * 100 + cx, bi);
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const m = new ChunkMesher() as any;
const acc: Record<string, number> = {};
function wrap(obj: any, name: string, label: string): void {
  const orig = obj[name].bind(obj);
  obj[name] = (...a: unknown[]) => { const t = performance.now(); const r = orig(...a); acc[label] = (acc[label] ?? 0) + performance.now() - t; return r; };
}
wrap(m, 'buildRegion', 'buildRegion (copy)');
wrap(m, 'computeTints', 'computeTints');
wrap(m.lighting, 'compute', 'lighting BFS');
wrap(m, 'meshFace', 'meshFace x6 (greedy)');
wrap(m, 'meshCrosses', 'meshCrosses');
wrap(m, 'extractLight', 'extractLight');
const nbOf = (cx: number, cz: number) => {
  const nb: Uint8Array[] = [], bio: Uint8Array[] = [];
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) { nb.push(blocks.get((cz + dz) * 100 + cx + dx)!); bio.push(biomes.get((cz + dz) * 100 + cx + dx)!); }
  return { nb, bio };
};
for (let i = 0; i < 30; i++) { const { nb, bio } = nbOf(0, 0); m.mesh(nb, bio, true); }
for (const k of Object.keys(acc)) delete acc[k];
let n = 0;
const t0 = performance.now();
for (let round = 0; round < 3; round++) for (let cz = -R + 1; cz < R; cz++) for (let cx = -R + 1; cx < R; cx++) { const { nb, bio } = nbOf(cx, cz); m.mesh(nb, bio, true); n++; }
const total = (performance.now() - t0) / n;
console.log(`total ${total.toFixed(2)} ms/chunk over ${n} meshes`);
for (const [k, v] of Object.entries(acc)) console.log(`${k.padEnd(24)} ${(v / n).toFixed(2)} ms  (${((v / n / total) * 100).toFixed(0)}%)`);
