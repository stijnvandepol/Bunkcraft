import { describe, expect, it } from 'vitest';
import { BLOCK, LIGHT_EMIT } from '../src/world/BlockRegistry';
import { CHUNK_HEIGHT, chunkKey } from '../src/world/constants';
import { ServerWorld } from '../server/ServerWorld';

/** The block light rule before the sorted-emitter search: every emitter of the 3×3 chunks, Manhattan distance. */
function referenceBlockLight(w: ServerWorld, x: number, y: number, z: number): number {
  const chunks = (w as unknown as { chunks: Map<number, { blocks: Uint8Array; emitters: Set<number> }> }).chunks;
  const cx = x >> 4, cz = z >> 4;
  let block = 0;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const n = chunks.get(chunkKey(cx + dx, cz + dz));
      if (!n) continue;
      for (const i of n.emitters) {
        const ex = ((cx + dx) << 4) + (i & 15), ez = ((cz + dz) << 4) + ((i >> 4) & 15), ey = i >> 8;
        const d = Math.abs(ex - x) + Math.abs(ey - y) + Math.abs(ez - z);
        if (d > 14) continue;
        block = Math.max(block, LIGHT_EMIT[n.blocks[i]] - d);
      }
    }
  }
  return block;
}

function loaded(seed: number): ServerWorld {
  const w = new ServerWorld(seed, {});
  for (let i = 0; i < 60; i++) w.update([{ x: 0, z: 0 }]);
  return w;
}

describe('ServerWorld performance paths give the same answers', () => {
  it('getLight matches the full emitter scan everywhere, also after torches and lava change', () => {
    const w = loaded(12345);
    let rng = 7;
    const rand = (n: number) => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng % n; };
    // Light sources at many heights and places, then remove some again (the sorted list must follow).
    for (let k = 0; k < 60; k++) w.setBlock(rand(64) - 32, 1 + rand(120), rand(64) - 32, k % 3 ? BLOCK.TORCH : BLOCK.LAVA);
    for (let k = 0; k < 20; k++) w.setBlock(rand(64) - 32, 1 + rand(120), rand(64) - 32, BLOCK.AIR);
    let lit = 0;
    for (let k = 0; k < 4000; k++) {
      const x = rand(80) - 40, y = rand(CHUNK_HEIGHT), z = rand(80) - 40;
      const want = referenceBlockLight(w, x, y, z);
      expect(w.getLight(x, y, z) & 15, `${x},${y},${z}`).toBe(want);
      if (want > 0) lit++;
    }
    expect(lit).toBeGreaterThan(100); // the sample really covers lit places
  });

  it('a removed emitter no longer lights its surroundings', () => {
    const w = loaded(1);
    w.setBlock(0, 110, 0, BLOCK.TORCH);
    expect(w.getLight(2, 110, 0) & 15).toBe(12);
    w.setBlock(0, 110, 0, BLOCK.AIR);
    expect(w.getLight(2, 110, 0) & 15).toBe(0);
  });

  it('update skips the work when nobody changed chunk but still follows players that move on', () => {
    const w = new ServerWorld(3, {});
    for (let i = 0; i < 120; i++) w.update([{ x: 0, z: 0 }, { x: 200, z: 5 }]);
    const before = w.loadedChunks;
    expect(before).toBe(162);
    w.update([{ x: 3, z: 9 }, { x: 204, z: 1 }]); // same chunks
    expect(w.loadedChunks).toBe(before);
    expect(w.getBlock(200, 70, 5)).not.toBe(BLOCK.UNLOADED);
    w.update([{ x: 3, z: 9 }]); // the second player left: their chunks unload
    expect(w.loadedChunks).toBe(81);
    expect(w.getBlock(200, 70, 5)).toBe(BLOCK.UNLOADED);
    for (let i = 0; i < 80; i++) w.update([{ x: 500, z: 500 }]);
    expect(w.loadedChunks).toBe(81);
    expect(w.getBlock(0, 70, 0)).toBe(BLOCK.UNLOADED);
    w.update([]);
    expect(w.loadedChunks).toBe(0);
  });
});
