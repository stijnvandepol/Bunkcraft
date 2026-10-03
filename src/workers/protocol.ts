import type { MeshResult } from '../rendering/ChunkMesher';
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

export interface MeshRequest {
  type: 'mesh';
  id: number;
  /** neighbours[(dz + 1) * 3 + (dx + 1)] */
  neighbours: Uint8Array[];
  /** Block state bytes for the same 9 chunks; null where a chunk has none. */
  metas: (Uint8Array | null)[];
  /** Biome per column for the same 9 chunks (biome tinting). */
  biomes: Uint8Array[];
  fancyLeaves: boolean;
}

export type WorkerRequest = GenerateRequest | MeshRequest;

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
  ms: number;
}

export type WorkerResponse = GenerateResponse | MeshResponse;
