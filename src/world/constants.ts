export const CHUNK_SIZE = 16;
export const CHUNK_HEIGHT = 128;
export const CHUNK_AREA = CHUNK_SIZE * CHUNK_SIZE;
export const CHUNK_VOLUME = CHUNK_AREA * CHUNK_HEIGHT;
export const SEA_LEVEL = 62;

/** Block index inside a chunk: x + z*16 + y*256 (y-major so whole layers are contiguous). */
export function blockIndex(x: number, y: number, z: number): number {
  return x | (z << 4) | (y << 8);
}

/** Numeric chunk key: avoids allocating strings in hot paths. Valid for |c| < 32768. */
export function chunkKey(cx: number, cz: number): number {
  return (cx + 32768) * 65536 + (cz + 32768);
}

export function keyToCx(key: number): number {
  return Math.floor(key / 65536) - 32768;
}

export function keyToCz(key: number): number {
  return (key % 65536) - 32768;
}
