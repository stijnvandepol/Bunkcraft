/**
 * Pipeline micro-benchmarks on real generated chunks (seed 12345):
 *  1. terrain generation and meshing time per chunk (the work the workers do)
 *  2. cost of the mesh request payload: structuredClone (what ChunkManager does today: 9 blocks + 9 biomes + metas)
 *     vs a tiny descriptor (what a SharedArrayBuffer pool would send)
 *  3. storage layout: raw 32 KB column vs palette sections vs RLE vs deflate (fflate) per chunk
 *  4. snapshot size: JSON player snapshot vs quantised binary, with and without deflate
 *
 *   npx tsx scripts/experiments/bench-pipeline.ts
 */
import { MessageChannel, receiveMessageOnPort } from 'node:worker_threads';
import { deflateSync, gzipSync } from 'fflate';
import { ChunkMesher } from '../../src/rendering/ChunkMesher';
import { CHUNK_AREA, CHUNK_VOLUME } from '../../src/world/constants';
import { TerrainGenerator } from '../../src/world/TerrainGenerator';

const gen = new TerrainGenerator(12345);
const R = 4;
const blocks = new Map<number, Uint8Array>();
const biomes = new Map<number, Uint8Array>();
const t0 = performance.now();
let n = 0;
for (let cz = -R; cz <= R; cz++) for (let cx = -R; cx <= R; cx++) {
  const b = new Uint8Array(CHUNK_VOLUME), bi = new Uint8Array(CHUNK_AREA);
  gen.generate(cx, cz, b, bi);
  blocks.set(cz * 100 + cx, b); biomes.set(cz * 100 + cx, bi); n++;
}
const genMs = (performance.now() - t0) / n;
console.log(`1. terrain generate: ${genMs.toFixed(2)} ms/chunk (incl. JIT warm-up of first chunks, ${n} chunks)`);
{
  const b = new Uint8Array(CHUNK_VOLUME), bi = new Uint8Array(CHUNK_AREA);
  const s = performance.now();
  for (let i = 0; i < 40; i++) gen.generate(i, 50, b, bi);
  console.log(`   steady-state generate: ${((performance.now() - s) / 40).toFixed(2)} ms/chunk`);
}

const mesher = new ChunkMesher();
const nbOf = (cx: number, cz: number) => {
  const nb: Uint8Array[] = [], bio: Uint8Array[] = [];
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) { nb.push(blocks.get((cz + dz) * 100 + cx + dx)!); bio.push(biomes.get((cz + dz) * 100 + cx + dx)!); }
  return { nb, bio };
};
for (let i = 0; i < 20; i++) { const { nb, bio } = nbOf(0, 0); mesher.mesh(nb, bio, true); }
let mt = 0, verts = 0, bytes = 0, cnt = 0;
for (let cz = -R + 1; cz < R; cz++) for (let cx = -R + 1; cx < R; cx++) {
  const { nb, bio } = nbOf(cx, cz);
  const s = performance.now();
  const r = mesher.mesh(nb, bio, true);
  mt += performance.now() - s; cnt++;
  for (const g of [r.opaque, r.cutout, r.water]) if (g) { verts += g.packed.length / 4; bytes += g.packed.byteLength + g.data.byteLength + g.tint.byteLength + g.index.byteLength; }
}
console.log(`   mesh: ${(mt / cnt).toFixed(2)} ms/chunk, ${Math.round(verts / cnt)} verts/chunk, ${(bytes / cnt / 1024).toFixed(0)} KiB GPU data/chunk (${(bytes / verts).toFixed(1)} B/vertex incl. index)`);

// 2. payload cost
{
  const { nb, bio } = nbOf(0, 0);
  const msg = { type: 'mesh', id: 1, neighbours: nb, metas: nb.map(() => null), biomes: bio, fancyLeaves: true };
  const mb = nb.reduce((s, a) => s + a.byteLength, 0) + bio.reduce((s, a) => s + a.byteLength, 0);
  let s = performance.now();
  for (let i = 0; i < 300; i++) structuredClone(msg);
  const clone = (performance.now() - s) / 300;
  const { port1, port2 } = new MessageChannel();
  s = performance.now();
  for (let i = 0; i < 300; i++) { port1.postMessage(msg); receiveMessageOnPort(port2); }
  const post = (performance.now() - s) / 300;
  const small = { type: 'mesh', id: 1, slots: [1, 2, 3, 4, 5, 6, 7, 8, 9], fancyLeaves: true };
  s = performance.now();
  for (let i = 0; i < 3000; i++) { port1.postMessage(small); receiveMessageOnPort(port2); }
  const tiny = (performance.now() - s) / 3000;
  console.log(`2. mesh request payload ${(mb / 1024).toFixed(0)} KiB: structuredClone ${clone.toFixed(3)} ms, postMessage+receive ${post.toFixed(3)} ms; SAB descriptor ${tiny.toFixed(4)} ms  (mesh itself: ${(mt / cnt).toFixed(2)} ms)`);
  port1.close(); port2.close();
}

// 3. storage layouts
{
  let raw = 0, pal = 0, rle = 0, dfl = 0, gz = 0, secs = 0, uniform = 0;
  const keys = [...blocks.keys()];
  for (const k of keys) {
    const b = blocks.get(k)!;
    raw += b.length;
    dfl += deflateSync(b, { level: 6 }).length;
    gz += gzipSync(b, { level: 1 }).length;
    let runs = 0;
    for (let i = 0; i < b.length; i++) if (i === 0 || b[i] !== b[i - 1]) runs++;
    rle += runs * 2;
    for (let sIdx = 0; sIdx < 8; sIdx++) {
      const sec = b.subarray(sIdx * 4096, sIdx * 4096 + 4096);
      const set = new Set(sec); secs++;
      if (set.size === 1) { uniform++; pal += 1; continue; }
      const bits = Math.max(1, Math.ceil(Math.log2(set.size)));
      pal += set.size + (4096 * bits) / 8;
    }
  }
  const c = keys.length;
  console.log(`3. per chunk (${c} chunks, 32 KiB raw; only the first 8 of 8 sections of 4096 B counted = 32 KiB): palette sections ${(pal / c / 1024).toFixed(1)} KiB, RLE ${(rle / c / 1024).toFixed(1)} KiB, deflate-6 ${(dfl / c / 1024).toFixed(1)} KiB, gzip-1 ${(gz / c / 1024).toFixed(1)} KiB; uniform sections ${(100 * uniform / secs).toFixed(0)}%`);
  const sample = blocks.get(0)!;
  const s = performance.now(); for (let i = 0; i < 100; i++) deflateSync(sample, { level: 1 }); const dms = (performance.now() - s) / 100;
  console.log(`   fflate deflate level1 on 32 KiB: ${dms.toFixed(2)} ms/chunk`);
}

// 4. snapshot size
{
  const players = 8;
  const snap = { t: 'snap', players: Array.from({ length: players }, (_, i) => [i + 1, 123.456 + i, 64.25, -88.125, 1.5707, -0.3, 5, 261]) };
  const json = JSON.stringify(snap);
  const binBytes = 1 + players * 17;
  const deflated = deflateSync(new TextEncoder().encode(json), { level: 1 }).length;
  console.log(`4. snapshot of ${players} players: JSON ${json.length} B, deflated JSON ${deflated} B, binary quantised ~${binBytes} B -> at 20 Hz: ${(json.length * 20 / 1024).toFixed(1)} KiB/s vs ${(binBytes * 20 / 1024).toFixed(1)} KiB/s per receiver`);
  let s = performance.now(); for (let i = 0; i < 20000; i++) JSON.stringify(snap);
  console.log(`   JSON.stringify ${(((performance.now() - s) / 20000) * 1000).toFixed(1)} us per snapshot`);
  s = performance.now(); for (let i = 0; i < 20000; i++) deflateSync(new TextEncoder().encode(json), { level: 1 });
  console.log(`   deflate (fflate, JS) ${(((performance.now() - s) / 20000) * 1000).toFixed(1)} us per snapshot`);
}
