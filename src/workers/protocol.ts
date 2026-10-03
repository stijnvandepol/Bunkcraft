import type { MeshResult } from '../rendering/ChunkMesher';
import { CHUNK_AREA, CHUNK_VOLUME } from '../world/constants';
import type { WorldType } from '../world/WorldGenerator';

export interface GenerateRequest {
  type: 'generate';
  id: number;
  seed: number;
  /** Absent = terrain. */
  worldType?: WorldType;
  /** Terrain generator version; absent = 1 (requests from before versioning). */
  genVersion?: number;
  cx: number;
  cz: number;
}

/** Chunk order in a mesh pack: (dz + 1) * 3 + (dx + 1). */
export const PACK_CHUNKS = 9;
/** Bytes of the always-present part of a pack: 9 block arrays followed by 9 biome arrays. */
export const PACK_BASE_BYTES = PACK_CHUNKS * (CHUNK_VOLUME + CHUNK_AREA);

export interface MeshRequest {
  type: 'mesh';
  id: number;
  /**
   * One transferable buffer instead of 27 cloned arrays: [9 × blocks][9 × biomes][block state
   * arrays of the chunks flagged in `metaMask`, in chunk order]. The worker returns it in the response.
   */
  pack: ArrayBuffer;
  /** Bit n set = chunk n has a block state array in the pack. */
  metaMask: number;
  fancyLeaves: boolean;
}

/** Buffers that are no longer needed on the main thread go back to a worker's pool. */
export interface RecycleRequest {
  type: 'recycle';
  id: number;
  buffers: ArrayBuffer[];
}

export type WorkerRequest = GenerateRequest | MeshRequest | RecycleRequest;

export interface GenerateResponse {
  type: 'generate';
  id: number;
  blocks: Uint8Array;
  biomes: Uint8Array;
  /** Block state bytes of the generated chunk (generator version 3: terracotta colours); absent when all are 0. */
  meta?: Uint8Array;
  ms: number;
}

export interface MeshResponse {
  type: 'mesh';
  id: number;
  result: MeshResult;
  /** The request's pack, handed back so the main thread can reuse it. */
  pack: ArrayBuffer;
  ms: number;
}

export type WorkerResponse = GenerateResponse | MeshResponse;
