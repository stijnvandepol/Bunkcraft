/**
 * Chunk generation thread of the game server (see ChunkGenPool). Runs the shared terrain generator, exactly like the
 * client's chunk workers, and sends the chunk back with its buffers transferred (no copy).
 *
 * Bundled to dist-server/genWorker.js by scripts/build-server.mjs; from source it runs under tsx.
 */
import { parentPort } from 'node:worker_threads';
import { type WorldGenerator, createGenerator } from '../../src/world/WorldGenerator';
import { generateChunk } from './genChunk';
import type { GenRequest, GenResponse } from './protocol';

if (!parentPort) throw new Error('genWorker must run as a worker thread');
const port = parentPort;

/** Generators per world (rooms with different seeds share the workers); building one takes ~0.2 ms. */
const generators = new Map<string, WorldGenerator>();
const MAX_GENERATORS = 32;

function generatorFor(m: GenRequest): WorldGenerator {
  const id = `${m.worldType}|${m.seed}|${m.genVersion}`;
  let g = generators.get(id);
  if (g) {
    // Most recently used last, so the oldest is the first one out.
    generators.delete(id);
  } else {
    g = createGenerator(m.worldType, m.seed, m.genVersion);
    if (generators.size >= MAX_GENERATORS) generators.delete(generators.keys().next().value!);
  }
  generators.set(id, g);
  return g;
}

port.on('message', (m: GenRequest) => {
  const t0 = performance.now();
  try {
    const c = generateChunk(generatorFor(m), m.cx, m.cz);
    const res: GenResponse = { id: m.id, blocks: c.blocks, meta: c.meta, tops: c.tops, emitters: c.emitters, ms: performance.now() - t0 };
    const transfer: ArrayBuffer[] = [c.blocks.buffer as ArrayBuffer, c.tops.buffer as ArrayBuffer, c.emitters.buffer as ArrayBuffer];
    if (c.meta) transfer.push(c.meta.buffer as ArrayBuffer);
    port.postMessage(res, transfer);
  } catch (e) {
    const res: GenResponse = { id: m.id, error: e instanceof Error ? (e.stack ?? e.message) : String(e), ms: performance.now() - t0 };
    port.postMessage(res);
  }
});
