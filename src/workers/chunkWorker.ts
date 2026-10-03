/// <reference lib="webworker" />
import { ChunkMesher, type GeometryData } from '../rendering/ChunkMesher';
import { normalizeGenVersion } from '../world/GenVersion';
import { type WorldGenerator, type WorldType, createGenerator } from '../world/WorldGenerator';
import { CHUNK_AREA, CHUNK_VOLUME } from '../world/constants';
import type { WorkerRequest, WorkerResponse } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

let generator: WorldGenerator | null = null;
let generatorType: WorldType = 'terrain';
let generatorVersion = 1;
const mesher = new ChunkMesher();

function buffersOf(g: GeometryData | null, out: Transferable[]): void {
  if (!g) return;
  out.push(g.packed.buffer, g.data.buffer, g.tint.buffer, g.index.buffer);
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  const t0 = performance.now();
  if (msg.type === 'generate') {
    const type = msg.worldType ?? 'terrain';
    const version = normalizeGenVersion(msg.genVersion);
    if (!generator || generator.seed !== msg.seed || generatorType !== type || generatorVersion !== version) {
      generator = createGenerator(type, msg.seed, version);
      generatorType = type;
      generatorVersion = version;
    }
    const blocks = new Uint8Array(CHUNK_VOLUME);
    const biomes = new Uint8Array(CHUNK_AREA);
    generator.generate(msg.cx, msg.cz, blocks, biomes);
    const res: WorkerResponse = { type: 'generate', id: msg.id, blocks, biomes, ms: performance.now() - t0 };
    self.postMessage(res, [blocks.buffer, biomes.buffer]);
  } else {
    const result = mesher.mesh(msg.neighbours, msg.biomes, msg.fancyLeaves, msg.metas);
    const transfer: Transferable[] = [result.light.buffer];
    buffersOf(result.opaque, transfer);
    buffersOf(result.cutout, transfer);
    buffersOf(result.water, transfer);
    const res: WorkerResponse = { type: 'mesh', id: msg.id, result, ms: performance.now() - t0 };
    self.postMessage(res, transfer);
  }
};
