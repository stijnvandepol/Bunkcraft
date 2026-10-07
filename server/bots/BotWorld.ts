import type { BlockGetter } from '../../src/player/Collision';
import { ARENA_FLOOR_Y, type ArenaMap } from '../../src/modes/maps';
import { MAX_COVER } from '../../src/modes/maps/ArenaMap';
import { NavGraph, type NavWorld, navGraphFor } from './NavGraph';

/** The navigation view of an arena map: its bounds and walkable area with a block source (the server's arena world). */
export function navWorldOf(map: ArenaMap, getBlock: BlockGetter, getMeta?: BlockGetter): NavWorld {
  return {
    getBlock, getMeta, bounds: map.bounds, inBounds: (x, z) => map.inBounds(x, z), floorY: ARENA_FLOOR_Y,
    maxHeight: MAX_COVER + 2,
  };
}

/**
 * The shared graph of a map variant. Arenas are generated from the map and the variant only (no edits), so
 * one graph serves every lobby on that variant; it is built on first use (tens of ms) and kept.
 */
export function arenaGraph(map: ArenaMap, variant: number, getBlock: BlockGetter, getMeta?: BlockGetter): NavGraph {
  return navGraphFor(`${map.id}:${variant}`, () => new NavGraph(navWorldOf(map, getBlock, getMeta), map.spawns.ffa[0]));
}
