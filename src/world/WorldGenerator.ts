import { ArenaGenerator } from '../modes/arena';
import { TerrainGenerator } from './TerrainGenerator';

/** "terrain" = generated landscape, "arena" = the fixed arcade map. */
export type WorldType = 'terrain' | 'arena';

/** What chunk workers, the server and the client need from a world generator. */
export interface WorldGenerator {
  readonly seed: number;
  generate(cx: number, cz: number, blocks: Uint8Array, biomesOut?: Uint8Array): void;
  heightAt(x: number, z: number): number;
  biomeAt(x: number, z: number, h: number): number;
}

export function createGenerator(type: WorldType, seed: number): WorldGenerator {
  return type === 'arena' ? new ArenaGenerator(seed) : new TerrainGenerator(seed);
}
