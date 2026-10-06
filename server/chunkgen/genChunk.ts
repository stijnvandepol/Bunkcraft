import { LIGHT_EMIT, OPAQUE } from '../../src/world/BlockRegistry';
import type { WorldGenerator, WorldType } from '../../src/world/WorldGenerator';
import { CHUNK_HEIGHT, CHUNK_VOLUME } from '../../src/world/constants';

/** Which generator a chunk comes from: the same triple the client's chunk workers get. */
export interface GenSpec {
  worldType: WorldType;
  seed: number;
  genVersion: number;
}

/**
 * A freshly generated chunk as the server stores it, before the players' edits are applied. The worker threads and
 * the synchronous path both build it with generateChunk(), so the two give byte-identical results.
 */
export interface GeneratedChunk {
  blocks: Uint8Array;
  /** Block state bytes, or null when every state is 0 (almost every chunk). */
  meta: Uint8Array | null;
  /** Highest light-blocking block per column (x + z*16), −1 when open to the sky. */
  tops: Int16Array;
  /** Indices of the light-emitting blocks, ascending (so sorted by height: see ServerWorld.getLight). */
  emitters: Int32Array;
}

/** Generates one chunk plus the light data the server keeps for it (sky tops, emitter list). */
export function generateChunk(generator: WorldGenerator, cx: number, cz: number): GeneratedChunk {
  const blocks = new Uint8Array(CHUNK_VOLUME);
  const meta = generator.generate(cx, cz, blocks) ?? null;
  const tops = new Int16Array(256);
  for (let col = 0; col < 256; col++) tops[col] = topOf(blocks, col);
  let n = 0;
  for (let i = 0; i < CHUNK_VOLUME; i++) if (LIGHT_EMIT[blocks[i]] > 0) n++;
  const emitters = new Int32Array(n);
  n = 0;
  for (let i = 0; i < CHUNK_VOLUME; i++) if (LIGHT_EMIT[blocks[i]] > 0) emitters[n++] = i;
  return { blocks, meta, tops, emitters };
}

/** Highest light-blocking block in a column of a chunk, −1 if none. */
export function topOf(blocks: Uint8Array, col: number): number {
  for (let y = CHUNK_HEIGHT - 1; y >= 0; y--) if (OPAQUE[blocks[col | (y << 8)]]) return y;
  return -1;
}
