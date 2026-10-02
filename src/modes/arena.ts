import { BIOME } from '../world/Biomes';
import { CHUNK_HEIGHT, CHUNK_SIZE, blockIndex } from '../world/constants';
import { ARENA_FLOOR_Y, type ArenaMap, DEFAULT_MAP, getMap } from './maps';

/**
 * The fixed arenas for the arcade game types (see `maps/`): mirror-symmetric in both axes
 * (red on the left, blue on the right), a wall around them, DOM-free so chunk workers, the server
 * (hitscan) and the client share them. The seed only picks a cover layout within a map.
 */
export { ARENA_FLOOR_Y };
export type { Spawn } from './maps';

/** The default map, for code that does not care which map it is. */
export const ARENA_BOUNDS = getMap(DEFAULT_MAP).bounds;
export const ARENA_SPAWNS = getMap(DEFAULT_MAP).spawns;

/**
 * Same interface as TerrainGenerator for the parts the world code uses: chunk generation, a
 * cheap 2D height query and a biome (always plains).
 */
export class ArenaGenerator {
  readonly map: ArenaMap;
  readonly variant: number;

  constructor(readonly seed: number, mapId: string = DEFAULT_MAP) {
    this.map = getMap(mapId);
    this.variant = this.map.variantFor(seed);
  }

  generate(cx: number, cz: number, blocks: Uint8Array, biomesOut?: Uint8Array): void {
    blocks.fill(0);
    if (biomesOut) biomesOut.fill(BIOME.PLAINS);
    const ox = cx * CHUNK_SIZE, oz = cz * CHUNK_SIZE;
    const b = this.map.bounds;
    const top = Math.min(CHUNK_HEIGHT - 1, ARENA_FLOOR_Y + this.map.wallHeight);
    for (let z = 0; z < CHUNK_SIZE; z++) {
      for (let x = 0; x < CHUNK_SIZE; x++) {
        const wx = ox + x, wz = oz + z;
        if (wx < b.minX || wx >= b.maxX || wz < b.minZ || wz >= b.maxZ) continue;
        for (let y = 0; y <= top; y++) blocks[blockIndex(x, y, z)] = this.map.blockAt(this.variant, wx, y, wz);
      }
    }
  }

  /** Top solid block of a column (like TerrainGenerator.heightAt, the y of the surface block). */
  heightAt(x: number, z: number): number {
    return this.map.heightAt(this.variant, x, z);
  }

  biomeAt(_x: number, _z: number, _h: number): number {
    return BIOME.PLAINS;
  }
}
