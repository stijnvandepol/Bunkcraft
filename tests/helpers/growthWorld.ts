import { BLOCK } from '../../src/world/BlockRegistry';
import { BlockUpdates, type UpdateGrid } from '../../src/world/BlockUpdates';
import { CHUNK_HEIGHT, CHUNK_VOLUME, blockIndex, chunkKey } from '../../src/world/constants';
import type { RandomTickHost } from '../../src/world/RandomTicks';

/**
 * A small dense world for the random tick and block update tests: loaded chunks around the origin with stone up to
 * `floor` and air above, everything else unloaded. Implements both hosts (RandomTickHost and UpdateGrid).
 */
export class GrowthWorld implements RandomTickHost, UpdateGrid {
  readonly blocks = new Map<number, Uint8Array>();
  readonly metas = new Map<number, Uint8Array>();
  readonly changed: number[] = [];
  readonly quiet: number[] = [];
  readonly drops: { id: number; meta: number }[] = [];
  updates: BlockUpdates | null = null;
  light: (x: number, y: number, z: number) => number = () => 0xf0;
  dark = 0;
  biome = 2;
  /** Clock for the budget tests: advances by `step` ms per call. */
  clock = 0;
  step = 0;
  batches = 0;

  constructor(readonly radius = 2, readonly floor = 60) {
    for (let cz = -radius; cz <= radius; cz++) {
      for (let cx = -radius; cx <= radius; cx++) {
        const b = new Uint8Array(CHUNK_VOLUME);
        b.fill(BLOCK.STONE, 0, (floor + 1) << 8);
        this.blocks.set(chunkKey(cx, cz), b);
      }
    }
  }

  chunkBlocks(cx: number, cz: number): Uint8Array | null { return this.blocks.get(chunkKey(cx, cz)) ?? null; }

  getBlock(x: number, y: number, z: number): number {
    if (y < 0) return BLOCK.BEDROCK;
    if (y >= CHUNK_HEIGHT) return BLOCK.AIR;
    const c = this.blocks.get(chunkKey(x >> 4, z >> 4));
    return c ? c[blockIndex(x & 15, y, z & 15)] : BLOCK.UNLOADED;
  }

  getMeta(x: number, y: number, z: number): number {
    const m = this.metas.get(chunkKey(x >> 4, z >> 4));
    return m && y >= 0 && y < CHUNK_HEIGHT ? m[blockIndex(x & 15, y, z & 15)] : 0;
  }

  getLight(x: number, y: number, z: number): number { return this.light(x, y, z); }
  biomeAt(): number { return this.biome; }
  skyDarkness(): number { return this.dark; }
  now(): number { this.clock += this.step; return this.clock; }
  begin(): void { this.batches++; }
  end(): void { /* nothing */ }

  /** Direct write (test setup): no notifications. */
  set(x: number, y: number, z: number, id: number, meta = 0): void {
    const key = chunkKey(x >> 4, z >> 4);
    const c = this.blocks.get(key);
    if (!c) throw new Error('chunk not loaded');
    const i = blockIndex(x & 15, y, z & 15);
    c[i] = id;
    if (meta) {
      let m = this.metas.get(key);
      if (!m) { m = new Uint8Array(CHUNK_VOLUME); this.metas.set(key, m); }
      m[i] = meta;
    } else {
      const m = this.metas.get(key);
      if (m) m[i] = 0;
    }
  }

  fill(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, id: number): void {
    for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) this.set(x, y, z, id);
  }

  /** Simulation write: records the change and tells the block updates. */
  setState(x: number, y: number, z: number, id: number, meta: number, quiet?: boolean): void {
    this.set(x, y, z, id, meta);
    if (quiet) { this.quiet.push(x, y, z, id, meta); return; }
    this.changed.push(x, y, z, id, meta);
    this.updates?.notify(x, y, z);
  }

  dropBlock(id: number, meta: number): void { this.drops.push({ id, meta }); }

  /** How many blocks of an id exist in the loaded area. */
  count(id: number): number {
    let n = 0;
    for (const b of this.blocks.values()) for (let i = 0; i < b.length; i++) if (b[i] === id) n++;
    return n;
  }
}

/** Mulberry32 as a TickRng: a seeded random source for the tests. */
export function seeded(seed: number): { nextU32(): number } {
  let a = seed >>> 0;
  return {
    nextU32() {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return (t ^ (t >>> 14)) >>> 0;
    },
  };
}
