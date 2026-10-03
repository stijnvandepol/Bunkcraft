/// <reference lib="webworker" />
import { ChunkMesher, type GeometryData } from '../rendering/ChunkMesher';
import { normalizeGenVersion } from '../world/GenVersion';
import { type WorldGenerator, type WorldType, createGenerator } from '../world/WorldGenerator';
import { CHUNK_AREA, CHUNK_VOLUME } from '../world/constants';
import { BufferPool } from './BufferPool';
import { PACK_CHUNKS, type WorkerRequest, type WorkerResponse } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

let generator: WorldGenerator | null = null;
let generatorType: WorldType = 'terrain';
let generatorVersion = 1;
const mesher = new ChunkMesher();
/** Result buffers come back from the main thread (`recycle`) once their data is on the GPU. */
const pool = new BufferPool();
mesher.alloc = (bytes) => pool.acquire(bytes);

const neighbours: Uint8Array[] = new Array(PACK_CHUNKS);
const biomes: Uint8Array[] = new Array(PACK_CHUNKS);
const metas: (Uint8Array | null)[] = new Array(PACK_CHUNKS).fill(null);

function buffersOf(g: GeometryData | null, out: Transferable[]): void {
  if (!g) return;
  out.push(g.packed.buffer, g.data.buffer, g.tint.buffer, g.index.buffer);
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  const t0 = performance.now();
  if (msg.type === 'recycle') {
    for (const b of msg.buffers) pool.release(b);
  } else if (msg.type === 'generate') {
    const type = msg.worldType ?? 'terrain';
    const version = normalizeGenVersion(msg.genVersion);
    if (!generator || generator.seed !== msg.seed || generatorType !== type || generatorVersion !== version) {
      generator = createGenerator(type, msg.seed, version);
      generatorType = type;
      generatorVersion = version;
    }
    const blocks = new Uint8Array(pool.acquire(CHUNK_VOLUME), 0, CHUNK_VOLUME).fill(0);
    const biomes = new Uint8Array(CHUNK_AREA);
    const meta = generator.generate(msg.cx, msg.cz, blocks, biomes);
    const res: WorkerResponse = { type: 'generate', id: msg.id, blocks, biomes, ms: performance.now() - t0 };
    const transfer: Transferable[] = [blocks.buffer, biomes.buffer];
    if (meta) { res.meta = meta; transfer.push(meta.buffer); }
    self.postMessage(res, transfer);
  } else {
    const pack = msg.pack;
    const biomeBase = PACK_CHUNKS * CHUNK_VOLUME;
    let metaOffset = biomeBase + PACK_CHUNKS * CHUNK_AREA;
    for (let n = 0; n < PACK_CHUNKS; n++) {
      neighbours[n] = new Uint8Array(pack, n * CHUNK_VOLUME, CHUNK_VOLUME);
      biomes[n] = new Uint8Array(pack, biomeBase + n * CHUNK_AREA, CHUNK_AREA);
      if (msg.metaMask & (1 << n)) {
        metas[n] = new Uint8Array(pack, metaOffset, CHUNK_VOLUME);
        metaOffset += CHUNK_VOLUME;
      } else metas[n] = null;
    }
    const result = mesher.mesh(neighbours, biomes, msg.fancyLeaves, metas);
    const transfer: Transferable[] = [pack, result.light.buffer];
    buffersOf(result.opaque, transfer);
    buffersOf(result.cutout, transfer);
    buffersOf(result.water, transfer);
    const res: WorkerResponse = { type: 'mesh', id: msg.id, result, pack, ms: performance.now() - t0 };
    self.postMessage(res, transfer);
  }
};
