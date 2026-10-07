import { BLOCK, BLOCK_DEFS, CUBE_ID, OPAQUE, SHAPE, SHAPE_CROSS, SHAPE_MODEL } from './BlockRegistry';
import { CROP_STYLE, FARMLAND } from './Crops';
import { isLiquid } from './Liquids';

/**
 * Which blocks are logs, leaves, gravity blocks and soil, and which plants may stand where. Flat tables built once
 * from the block registry, shared by the random ticks (Growth.ts), the scheduled block updates (BlockUpdates.ts),
 * placement (Interaction) and the server's edit validation.
 */

export const LOG = new Uint8Array(256);
export const LEAVES = new Uint8Array(256);
/** Sand and gravel: fall when nothing is under them. */
export const GRAVITY = new Uint8Array(256);

for (const d of BLOCK_DEFS) {
  if (d.shape === 'cube' && /(^|_)log$/.test(d.name)) LOG[d.id] = 1;
  if (d.shape === 'cube' && d.sway && d.transparent) LEAVES[d.id] = 1;
}
GRAVITY[BLOCK.SAND] = 1;
GRAVITY[BLOCK.GRAVEL] = 1;
GRAVITY[CUBE_ID.red_sand] = 1;

/** Minecraft's #dirt tag plus farmland: what a sapling may stand on. */
const SOIL = new Uint8Array(256);
for (const id of [BLOCK.DIRT, BLOCK.GRASS, BLOCK.SNOWY_GRASS, CUBE_ID.podzol, CUBE_ID.coarse_dirt, CUBE_ID.mycelium, CUBE_ID.moss_block, CUBE_ID.mud, CUBE_ID.farmland]) SOIL[id] = 1;
/** What sugar cane may stand on (with water next to it): the soils plus sand. */
const CANE_BASE = new Uint8Array(256);
for (let i = 0; i < 256; i++) CANE_BASE[i] = SOIL[i];
CANE_BASE[BLOCK.SAND] = 1;
CANE_BASE[CUBE_ID.red_sand] = 1;
CANE_BASE[CUBE_ID.farmland] = 0;

export const isLog = (id: number): boolean => LOG[id] === 1;
export const isLeaves = (id: number): boolean => LEAVES[id] === 1;
export const isSoil = (id: number): boolean => SOIL[id] === 1;

type Getter = (x: number, y: number, z: number) => number;

/** Is this block a plant that a block change underneath can uproot (sapling, cane, cactus, crops and stems)? */
export function needsSupport(id: number): boolean {
  return id === BLOCK.SAPLING || id === CUBE_ID.sugar_cane || id === BLOCK.CACTUS || CROP_STYLE[id] !== 0;
}

/** Full opaque blocks next to a cactus pop it off (the cactus itself and see-through blocks do not). */
function cactusBlocker(id: number): boolean {
  return OPAQUE[id] === 1 && id !== BLOCK.CACTUS;
}

/**
 * May the plant `id` stand at (x, y, z) given its surroundings (Minecraft's canSurvive):
 *  - sapling: on dirt-like soil;
 *  - sugar cane: on cane, or on soil/sand with water beside the block it stands on;
 *  - cactus: on sand or cactus, with no full block beside it;
 *  - crops and stems (Crops.ts): on farmland.
 * Any other plant just needs something solid underneath (the old rule, used by placement).
 */
export function plantCanStand(id: number, getBlock: Getter, x: number, y: number, z: number): boolean {
  const below = getBlock(x, y - 1, z);
  if (id === BLOCK.SAPLING) return SOIL[below] === 1;
  if (CROP_STYLE[id] !== 0) return below === FARMLAND;
  if (id === CUBE_ID.sugar_cane) {
    if (below === CUBE_ID.sugar_cane) return true;
    if (CANE_BASE[below] !== 1) return false;
    return getBlock(x + 1, y - 1, z) === BLOCK.WATER || getBlock(x - 1, y - 1, z) === BLOCK.WATER
      || getBlock(x, y - 1, z + 1) === BLOCK.WATER || getBlock(x, y - 1, z - 1) === BLOCK.WATER;
  }
  if (id === BLOCK.CACTUS) {
    if (below !== BLOCK.SAND && below !== CUBE_ID.red_sand && below !== BLOCK.CACTUS) return false;
    return !cactusBlocker(getBlock(x + 1, y, z)) && !cactusBlocker(getBlock(x - 1, y, z))
      && !cactusBlocker(getBlock(x, y, z + 1)) && !cactusBlocker(getBlock(x, y, z - 1));
  }
  return below !== BLOCK.UNLOADED && below !== BLOCK.AIR && !isLiquid(below) && SHAPE[below] !== SHAPE_CROSS && SHAPE[below] !== SHAPE_MODEL;
}
