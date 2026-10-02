import { ArenaGenerator } from '../modes/arena';
import { DEFAULT_MAP, type MapId, getMap } from '../modes/maps';
import { TerrainGenerator } from './TerrainGenerator';

/**
 * "terrain" = generated landscape, "arena" = the fixed arcade map (the default one), and
 * "arena:<mapId>" = a specific arcade map. The map rides along in the world type so the chunk
 * workers, the server and the client all build the same arena.
 */
export type WorldType = 'terrain' | 'arena' | `arena:${MapId}`;

/** What chunk workers, the server and the client need from a world generator. */
export interface WorldGenerator {
  readonly seed: number;
  generate(cx: number, cz: number, blocks: Uint8Array, biomesOut?: Uint8Array): void;
  heightAt(x: number, z: number): number;
  biomeAt(x: number, z: number, h: number): number;
}

export function isArenaWorld(type: WorldType): boolean {
  return type !== 'terrain';
}

/** World type of an arcade map. */
export function arenaWorldType(map: MapId): WorldType {
  return `arena:${map}`;
}

/** The map an arena world type stands for (the default map for plain "arena"). */
export function arenaMapOf(type: WorldType) {
  return getMap(type.startsWith('arena:') ? type.slice(6) : DEFAULT_MAP);
}

export function createGenerator(type: WorldType, seed: number): WorldGenerator {
  return isArenaWorld(type) ? new ArenaGenerator(seed, arenaMapOf(type).id) : new TerrainGenerator(seed);
}
