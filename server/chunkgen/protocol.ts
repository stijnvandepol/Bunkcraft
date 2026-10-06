import type { WorldType } from '../../src/world/WorldGenerator';

/** Main thread → chunk generation worker. */
export interface GenRequest {
  id: number;
  worldType: WorldType;
  seed: number;
  genVersion: number;
  cx: number;
  cz: number;
}

/** Worker → main thread: the chunk (buffers transferred) or the error that stopped it. */
export interface GenResponse {
  id: number;
  blocks?: Uint8Array;
  meta?: Uint8Array | null;
  tops?: Int16Array;
  emitters?: Int32Array;
  error?: string;
  /** Time the worker spent on it. */
  ms: number;
}
