import { CHUNK_HEIGHT, CHUNK_SIZE, CHUNK_VOLUME, blockIndex } from '../src/world/constants';

/** FNV-1a (32-bit) over raw bytes, for golden hashes of generated chunks. */
export function fnv1a(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function emptyChunk(): Uint8Array {
  return new Uint8Array(CHUNK_VOLUME);
}

export function setLocal(chunk: Uint8Array, x: number, y: number, z: number, id: number): void {
  if (x < 0 || x >= CHUNK_SIZE || z < 0 || z >= CHUNK_SIZE || y < 0 || y >= CHUNK_HEIGHT) throw new Error('out of chunk');
  chunk[blockIndex(x, y, z)] = id;
}

/** Sparse block world for collision and raycast tests: everything not set is air. */
export class TestWorld {
  private readonly blocks = new Map<string, number>();

  set(x: number, y: number, z: number, id: number): this {
    this.blocks.set(`${x},${y},${z}`, id);
    return this;
  }

  /** Fills an axis-aligned box of blocks (inclusive bounds). */
  fill(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, id: number): this {
    for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) this.set(x, y, z, id);
    return this;
  }

  readonly get = (x: number, y: number, z: number): number => this.blocks.get(`${x},${y},${z}`) ?? 0;
}
