import { BLOCK, CUBE_ID, SLAB_FIRST, STAIRS_FIRST } from '../world/BlockRegistry';
import { WOODS } from '../world/Content';
import { ITEM, type ItemStack, getItemDef, itemBlock, itemId } from './ItemRegistry';
import { RECIPES } from './Recipes';

/**
 * Smelting rules (DOM-free, shared by the client and the server): the fuel table, the cooking times and the
 * smelting recipes with their XP. Numbers are the Java 26.x ones from minecraft.wiki (docs/research/MECHANICS.md 4.2).
 * The recipes themselves are the `furnace` recipes of Recipes.ts, so adding one there adds it to the furnace.
 */

/** Which furnace a block entity is. Only the plain furnace has a block yet; the others are ready for when they get one. */
export type FurnaceKind = 'furnace' | 'blast' | 'smoker';

/** Cooking time of one item in ticks (20 per second). */
export const COOK_TICKS: Record<FurnaceKind, number> = { furnace: 200, blast: 100, smoker: 100 };

/** Item id by name, or -1 when the item does not exist in this build (the fuel table lists a few that may not). */
function tryItem(name: string): number {
  try {
    return itemId(name);
  } catch {
    return -1;
  }
}

const FUEL = new Map<number, number>();
const FUEL_BLOCK = new Map<number, number>();

function fuel(item: number, ticks: number): void {
  if (item >= 0) FUEL.set(item, ticks);
}

// Burn time in ticks: how many items one fuel item smelts is ticks / 200.
fuel(ITEM.LAVA_BUCKET, 20000);
fuel(tryItem('coal_block'), 16000);
fuel(tryItem('dried_kelp_block'), 4000);
fuel(tryItem('blaze_rod'), 2400);
fuel(ITEM.COAL, 1600);
fuel(tryItem('charcoal'), 1600);
fuel(tryItem('oak_boat'), 1200);
fuel(ITEM.BOW, 300);
fuel(tryItem('fishing_rod'), 300);
fuel(ITEM.STICK, 100);
fuel(tryItem('bamboo'), 50);
fuel(ITEM.WOODEN_PICKAXE, 200);
fuel(ITEM.WOODEN_AXE, 200);
fuel(ITEM.WOODEN_SHOVEL, 200);
fuel(ITEM.WOODEN_SWORD, 200);
fuel(ITEM.WOODEN_HOE, 200);

// Blocks (matched by the block of an item, so coloured variants count too).
const blockFuel = (id: number | undefined, ticks: number): void => { if (id !== undefined && id >= 0) FUEL_BLOCK.set(id, ticks); };
blockFuel(BLOCK.OAK_PLANKS, 300);
blockFuel(BLOCK.BIRCH_PLANKS, 300);
blockFuel(BLOCK.SPRUCE_PLANKS, 300);
blockFuel(BLOCK.OAK_LOG, 300);
blockFuel(BLOCK.BIRCH_LOG, 300);
blockFuel(BLOCK.SPRUCE_LOG, 300);
for (const w of WOODS) {
  blockFuel(CUBE_ID[`${w.name}_planks`], 300);
  blockFuel(CUBE_ID[`${w.name}_log`], 300);
  blockFuel(CUBE_ID[`stripped_${w.name}_log`], 300);
}
// Wooden slabs 150, wooden stairs and the other wooden furniture 300.
for (const i of [6, 7, 8]) { blockFuel(SLAB_FIRST + i, 150); blockFuel(STAIRS_FIRST + i, 300); }
for (const b of [BLOCK.CRAFTING_TABLE, BLOCK.BOOKSHELF, BLOCK.CHEST, BLOCK.FENCE, BLOCK.FENCE_GATE, BLOCK.TRAPDOOR, BLOCK.DOOR, BLOCK.LADDER, BLOCK.BED]) blockFuel(b, 300);
for (const b of [BLOCK.WOOL, BLOCK.RED_WOOL, BLOCK.BLUE_WOOL, BLOCK.YELLOW_WOOL, BLOCK.GREEN_WOOL]) blockFuel(b, 100);
blockFuel(BLOCK.CARPET, 67);
blockFuel(BLOCK.SAPLING, 100);

/** Burn time in ticks of an item as furnace fuel; 0 = not a fuel. */
export function fuelTicks(item: number): number {
  const direct = FUEL.get(item);
  if (direct !== undefined) return direct;
  const block = itemBlock(item);
  return block ? FUEL_BLOCK.get(block) ?? 0 : 0;
}

/** What a fuel leaves behind when it burns (the lava bucket turns back into a bucket). */
export function fuelRemainder(item: number): ItemStack | null {
  return item === ITEM.LAVA_BUCKET ? { id: ITEM.BUCKET, count: 1 } : null;
}

export interface SmeltRecipe {
  result: ItemStack;
  /** Experience stored in the furnace per smelted item (wiki table). */
  xp: number;
}

/** XP per result item (Java wiki, "Smelting"); anything not listed gives 0.1. */
const XP_BY_RESULT: Record<string, number> = {
  iron_ingot: 0.7, gold_ingot: 1, copper_ingot: 0.7, coal: 0.1, lapis_lazuli: 0.2, redstone: 0.7, diamond: 1, emerald: 1,
  glass: 0.1, stone: 0.1, deepslate: 0.1, smooth_stone: 0.1, smooth_sandstone: 0.1, smooth_red_sandstone: 0.1, cracked_stone_bricks: 0.1,
  brick: 0.3, terracotta: 0.35, charcoal: 0.15, green_dye: 1, baked_potato: 0.35, cooked_porkchop: 0.35, cooked_beef: 0.35,
  steak: 0.35, cooked_mutton: 0.35, cooked_chicken: 0.35, cooked_rabbit: 0.35, cooked_cod: 0.35, cooked_salmon: 0.35,
};

const SMELT = new Map<number, SmeltRecipe>();
for (const r of RECIPES) {
  if (r.station !== 'furnace') continue;
  const name = getItemDef(r.result.id)?.name ?? '';
  const xp = XP_BY_RESULT[name] ?? 0.1;
  for (const input of r.ingredients[0].ids) if (!SMELT.has(input)) SMELT.set(input, { result: { ...r.result }, xp });
}

/** The smelting recipe for an input item, or undefined. `kind` limits blast furnaces to ores/metal and smokers to food. */
export function smeltRecipe(input: number, kind: FurnaceKind = 'furnace'): SmeltRecipe | undefined {
  const r = SMELT.get(input);
  if (!r || kind === 'furnace') return r;
  const food = !!getItemDef(r.result.id)?.food;
  return (kind === 'smoker') === food ? r : undefined;
}

/** Every smeltable input item (for the shift-click routing of the furnace screen). */
export function isSmeltable(input: number): boolean {
  return SMELT.has(input);
}
