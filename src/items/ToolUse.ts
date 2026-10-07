import { BLOCK, CUBE_ID, SOLID, SHAPE, SHAPE_LIQUID } from '../world/BlockRegistry';
import type { ToolKind } from './ItemRegistry';

/**
 * What a tool does when it is used (right click) on a block, as in Minecraft:
 *  - hoe: grass, dirt and paths become farmland, coarse dirt becomes dirt;
 *  - shovel: grass, dirt, podzol, mycelium and coarse dirt become a dirt path;
 *  - axe: logs become stripped logs;
 *  - shears: a pumpkin becomes a carved pumpkin (and gives seeds).
 * The shovel only works when the block above is free (air or a plant), the hoe only with air above (Minecraft 1.21's
 * HoeItem: tilled farmland starts dry, moisture 0, and hydrates on its next random tick near water).
 */

const STRIP: Record<number, number> = {
  [BLOCK.OAK_LOG]: CUBE_ID.stripped_oak_log,
  [BLOCK.SPRUCE_LOG]: CUBE_ID.stripped_spruce_log,
  [BLOCK.BIRCH_LOG]: CUBE_ID.stripped_birch_log,
  [CUBE_ID.jungle_log]: CUBE_ID.stripped_jungle_log,
  [CUBE_ID.acacia_log]: CUBE_ID.stripped_acacia_log,
  [CUBE_ID.dark_oak_log]: CUBE_ID.stripped_dark_oak_log,
  [CUBE_ID.mangrove_log]: CUBE_ID.stripped_mangrove_log,
  [CUBE_ID.cherry_log]: CUBE_ID.stripped_cherry_log,
};

const TILL: Record<number, number> = {
  [BLOCK.GRASS]: CUBE_ID.farmland,
  [BLOCK.DIRT]: CUBE_ID.farmland,
  [CUBE_ID.dirt_path]: CUBE_ID.farmland,
  [CUBE_ID.coarse_dirt]: BLOCK.DIRT,
};

const PATH: Record<number, number> = {
  [BLOCK.GRASS]: CUBE_ID.dirt_path,
  [BLOCK.DIRT]: CUBE_ID.dirt_path,
  [CUBE_ID.podzol]: CUBE_ID.dirt_path,
  [CUBE_ID.mycelium]: CUBE_ID.dirt_path,
  [CUBE_ID.coarse_dirt]: CUBE_ID.dirt_path,
};

export interface ToolUse {
  /** The block the clicked block turns into. */
  to: number;
  /** The new block faces the player (carved pumpkins). */
  facesPlayer?: boolean;
  /** Item dropped by the change: seeds from a carved pumpkin. */
  drops?: { name: string; count: number };
  /** Sound family to play ('place' sound of this block kind). */
  sound: 'wood' | 'grass' | 'gravel';
}

function free(aboveId: number): boolean {
  return !SOLID[aboveId] && SHAPE[aboveId] !== SHAPE_LIQUID;
}

/** The effect of `tool` on `block` (with `above` the block over it), or null when the tool does nothing there. */
export function toolUse(tool: ToolKind, block: number, above: number): ToolUse | null {
  if (tool === 'axe') {
    const to = STRIP[block];
    return to ? { to, sound: 'wood' } : null;
  }
  if (tool === 'shears') {
    return block === CUBE_ID.pumpkin ? { to: CUBE_ID.carved_pumpkin, sound: 'wood', facesPlayer: true, drops: { name: 'pumpkin_seeds', count: 4 } } : null;
  }
  if (!free(above) || above === BLOCK.UNLOADED) return null;
  if (tool === 'hoe') {
    if (above !== BLOCK.AIR) return null;
    const to = TILL[block];
    return to ? { to, sound: 'gravel' } : null;
  }
  if (tool === 'shovel') {
    const to = PATH[block];
    return to ? { to, sound: 'grass' } : null;
  }
  return null;
}
