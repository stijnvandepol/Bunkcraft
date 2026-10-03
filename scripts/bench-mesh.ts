/**
 * Chunk meshing cost on a fixed seed: generates a 7×7 area and meshes the inner 5×5 chunks
 * (several rounds, after a warm-up), printing the mean and p95 per chunk.
 *
 *   npx tsx scripts/bench-mesh.ts [seed=12345] [rounds=5] [genVersion=2]
 */
import { ChunkMesher } from '../src/rendering/ChunkMesher';
import { CHUNK_AREA, CHUNK_VOLUME } from '../src/world/constants';
import { TerrainGenerator } from '../src/world/TerrainGenerator';

const seed = Number(process.argv[2] ?? 12345);
const rounds = Number(process.argv[3] ?? 5);
const genVersion = Number(process.argv[4] ?? 2);
const gen = new TerrainGenerator(seed, genVersion);
const R = 3;
const blocks = new Map<number, Uint8Array>();
const biomes = new Map<number, Uint8Array>();
for (let cz = -R; cz <= R; cz++) {
  for (let cx = -R; cx <= R; cx++) {
    const b = new Uint8Array(CHUNK_VOLUME), bi = new Uint8Array(CHUNK_AREA);
    gen.generate(cx, cz, b, bi);
    blocks.set(cz * 100 + cx, b);
    biomes.set(cz * 100 + cx, bi);
  }
}
const mesher = new ChunkMesher();
const times: number[] = [];
let tris = 0;
for (let round = -1; round < rounds; round++) {
  for (let cz = -R + 1; cz < R; cz++) {
    for (let cx = -R + 1; cx < R; cx++) {
      const nb: Uint8Array[] = [], bio: Uint8Array[] = [];
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        nb.push(blocks.get((cz + dz) * 100 + cx + dx)!);
        bio.push(biomes.get((cz + dz) * 100 + cx + dx)!);
      }
      const t0 = performance.now();
      const r = mesher.mesh(nb, bio, true);
      const dt = performance.now() - t0;
      if (round >= 0) {
        times.push(dt);
        if (round === 0) tris += ((r.opaque?.index.length ?? 0) + (r.cutout?.index.length ?? 0) + (r.water?.index.length ?? 0)) / 3;
      }
    }
  }
}
times.sort((a, b) => a - b);
const mean = times.reduce((s, t) => s + t, 0) / times.length;
console.log(`seed ${seed} gen v${genVersion}: ${times.length} meshes, mean ${mean.toFixed(2)} ms, p95 ${times[Math.floor(times.length * 0.95)].toFixed(2)} ms, ${Math.round(tris / 25)} triangles/chunk`);
