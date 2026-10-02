import type * as THREE from 'three';

export const CHUNK_EMPTY = 0;
export const CHUNK_GENERATING = 1;
export const CHUNK_READY = 2;

export class Chunk {
  /** Block ids, index = x + z*16 + y*256. Null until generated. */
  blocks: Uint8Array | null = null;
  /**
   * Block state byte per block, same index as `blocks`. Allocated lazily: null while every block
   * of the chunk has the default state (meta 0), which is true for freshly generated terrain.
   */
  meta: Uint8Array | null = null;
  /** Biome id per column (x + z*16). */
  biomes: Uint8Array | null = null;
  /** Packed light (sky << 4 | block) from the last mesh pass. */
  light: Uint8Array | null = null;
  state = CHUNK_EMPTY;
  /** Bumped on every change that requires a new mesh. */
  version = 0;
  meshedVersion = -1;
  meshing = false;
  /** Remesh with priority (player edit) so the change shows up immediately. */
  urgent = false;
  opaque: THREE.Mesh | null = null;
  cutout: THREE.Mesh | null = null;
  water: THREE.Mesh | null = null;

  constructor(readonly cx: number, readonly cz: number, readonly key: number) {}

  get needsMesh(): boolean {
    return this.state === CHUNK_READY && this.meshedVersion !== this.version;
  }
}
