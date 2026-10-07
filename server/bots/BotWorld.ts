import type { BlockGetter } from '../../src/player/Collision';
import { ARENA_FLOOR_Y, type ArenaMap, MAPS } from '../../src/modes/maps';
import { MAX_COVER } from '../../src/modes/maps/ArenaMap';
import { arenaWorldType } from '../../src/world/WorldGenerator';
import { ServerWorld } from '../ServerWorld';
import { log } from '../Log';
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

/**
 * Builds every map variant's graph in the background (one per event-loop turn, 20-150 ms each), so a lobby that
 * starts or rotates to a map never stalls the server building one mid-match. The source is the same arena world
 * the lobbies use (a variant is picked by seed % variants, so seed = variant).
 */
export function prewarmNavGraphs(onDone?: (ms: number, graphs: number) => void): void {
  const jobs: { map: ArenaMap; variant: number }[] = [];
  for (const map of MAPS) for (let v = 0; v < map.variants; v++) jobs.push({ map, variant: v });
  let i = 0, total = 0;
  const next = () => {
    const job = jobs[i++];
    if (!job) { onDone?.(total, jobs.length); return; }
    try {
      const t0 = performance.now();
      const world = new ServerWorld(job.variant, {}, arenaWorldType(job.map.id as Parameters<typeof arenaWorldType>[0]));
      world.preloadArena();
      arenaGraph(job.map, job.variant, (x, y, z) => world.getBlock(x, y, z), (x, y, z) => world.getMeta(x, y, z));
      total += performance.now() - t0;
    } catch (e) {
      log.warn('nav graph prewarm failed', { map: job.map.id, variant: job.variant, error: String(e) });
    }
    setTimeout(next, 5).unref();
  };
  setTimeout(next, 0).unref();
}
