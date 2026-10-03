import { BLOCK, CUBE_ID, PARTIAL_MATERIALS, SLAB_FIRST, STAIRS_FIRST } from '../world/BlockRegistry';
import { DYES, PARTIAL_EXT, WALL_MATERIALS, WOODS } from '../world/Content';
import { ARMOR_MATERIALS } from './ItemContent';
import type { PlayerInventory } from './Inventory';
import { ITEM, type ItemStack, getItemDef, itemBlock, itemFromState, itemId } from './ItemRegistry';

export type Station = 'hand' | 'table' | 'furnace';

/** An ingredient accepts any of several items (e.g. any kind of planks). */
export interface Ingredient {
  ids: number[];
  count: number;
}

export interface Recipe {
  result: ItemStack;
  ingredients: Ingredient[];
  station: Station;
}

/**
 * Recipe list in the spirit of the Minecraft recipe book: ingredient counts and result amounts are the vanilla
 * ones (Java 1.21), the grid pattern is not modelled. `hand` recipes fit the 2×2 grid, `table` recipes need a
 * crafting table nearby, `furnace` recipes smelt (one fuel item per result, to keep it simple).
 * Deviations are listed in docs/CONTENT.md (concrete without powder, no dye sources for brown and black...).
 */

const B = BLOCK;
const id = itemId;
const one = (item: number, count = 1): Ingredient => ({ ids: [item], count });
const any = (ids: number[], count: number): Ingredient => ({ ids, count });
const dye = (i: number): number => id(`${DYES[i].name}_dye`);

// ---- material groups ----
const woodIdx = WOODS.map((w) => w.name);
const planksOf = (w: number): number => (w === 0 ? B.OAK_PLANKS : w === 1 ? B.SPRUCE_PLANKS : w === 2 ? B.BIRCH_PLANKS : CUBE_ID[`${woodIdx[w]}_planks`]);
const logOf = (w: number): number => (w === 0 ? B.OAK_LOG : w === 1 ? B.SPRUCE_LOG : w === 2 ? B.BIRCH_LOG : CUBE_ID[`${woodIdx[w]}_log`]);
const strippedOf = (w: number): number => CUBE_ID[`stripped_${woodIdx[w]}_log`];
const PLANKS = WOODS.map((_, w) => planksOf(w));
const LOGS = WOODS.map((_, w) => logOf(w));
const ALL_LOGS = [...LOGS, ...WOODS.map((_, w) => strippedOf(w))];
const COBBLES = [B.COBBLESTONE, CUBE_ID.cobbled_deepslate];
const COAL = [ITEM.COAL, id('charcoal')];
const FUEL = [...COAL, ...PLANKS, ...ALL_LOGS];

const recipes: Recipe[] = [];
function add(result: number, count: number, station: Station, ...ingredients: Ingredient[]): void {
  recipes.push({ result: { id: result, count }, ingredients, station });
}

// ---------------------------------------------------------------- wood
WOODS.forEach((_, w) => {
  add(planksOf(w), 4, 'hand', any([logOf(w), strippedOf(w)], 1));
});
add(ITEM.STICK, 4, 'hand', any(PLANKS, 2));
add(B.CRAFTING_TABLE, 1, 'hand', any(PLANKS, 4));
add(B.FURNACE, 1, 'table', any(COBBLES, 8));
add(id('chest'), 1, 'table', any(PLANKS, 8));
add(id('bowl'), 4, 'table', any(PLANKS, 3));
add(id('ladder'), 3, 'table', one(ITEM.STICK, 7));
add(B.TORCH, 4, 'hand', any(COAL, 1), one(ITEM.STICK));
add(id('lantern'), 1, 'table', one(id('iron_nugget'), 8), one(B.TORCH));
add(B.BOOKSHELF, 1, 'table', any(PLANKS, 6));
// Enchanting blocks (Java 1.21 counts).
add(B.ENCHANTING_TABLE, 1, 'table', one(id('book')), one(ITEM.DIAMOND, 2), one(B.OBSIDIAN, 4));
add(B.ANVIL, 1, 'table', one(id('iron_block'), 3), one(id('iron_ingot'), 4));
add(B.GRINDSTONE, 1, 'table', one(ITEM.STICK, 2), any([SLAB_FIRST + PARTIAL_MATERIALS.findIndex((m) => m.name === 'stone')], 1), any(PLANKS, 2));
WOODS.forEach((_, w) => {
  add(itemFromState(B.DOOR, w << 5), 3, 'table', one(planksOf(w), 6));
  add(itemFromState(B.TRAPDOOR, w << 4), 2, 'table', one(planksOf(w), 6));
  add(itemFromState(B.FENCE, w), 3, 'table', one(planksOf(w), 4), one(ITEM.STICK, 2));
  add(itemFromState(B.FENCE_GATE, w << 3), 1, 'table', one(planksOf(w), 2), one(ITEM.STICK, 4));
});

// ---------------------------------------------------------------- stone and earth
add(B.STONE_BRICKS, 4, 'hand', one(B.STONE, 4));
add(CUBE_ID.polished_granite, 4, 'hand', one(CUBE_ID.granite, 4));
add(CUBE_ID.polished_diorite, 4, 'hand', one(CUBE_ID.diorite, 4));
add(CUBE_ID.polished_andesite, 4, 'hand', one(CUBE_ID.andesite, 4));
add(CUBE_ID.polished_deepslate, 4, 'hand', one(CUBE_ID.cobbled_deepslate, 4));
add(CUBE_ID.deepslate_bricks, 4, 'hand', one(CUBE_ID.polished_deepslate, 4));
add(CUBE_ID.deepslate_tiles, 4, 'hand', one(CUBE_ID.deepslate_bricks, 4));
add(B.MOSSY_COBBLESTONE, 1, 'hand', one(B.COBBLESTONE), one(CUBE_ID.moss_block));
add(CUBE_ID.mossy_stone_bricks, 1, 'hand', one(B.STONE_BRICKS), one(CUBE_ID.moss_block));
add(B.SANDSTONE, 1, 'hand', one(B.SAND, 4));
add(CUBE_ID.red_sandstone, 1, 'hand', one(CUBE_ID.red_sand, 4));
add(CUBE_ID.cut_sandstone, 4, 'hand', one(B.SANDSTONE, 4));
add(CUBE_ID.cut_red_sandstone, 4, 'hand', one(CUBE_ID.red_sandstone, 4));
add(B.CLAY, 1, 'hand', one(id('clay_ball'), 4));
add(B.BRICKS, 1, 'hand', one(id('brick'), 4));
add(CUBE_ID.packed_mud, 1, 'hand', one(CUBE_ID.mud), one(id('wheat')));
add(CUBE_ID.mud_bricks, 4, 'hand', one(CUBE_ID.packed_mud, 4));
add(B.GLOWSTONE, 1, 'hand', one(id('glowstone_dust'), 4));
add(B.SNOW, 1, 'hand', one(id('snowball'), 4));
add(CUBE_ID.packed_ice, 1, 'table', one(CUBE_ID.ice, 9));
add(CUBE_ID.hay_block, 1, 'table', one(id('wheat'), 9));
add(id('wheat'), 9, 'hand', one(CUBE_ID.hay_block));
add(CUBE_ID.melon, 1, 'table', one(id('melon_slice'), 9));
add(CUBE_ID.bone_block, 1, 'table', one(id('bone_meal'), 9));
add(B.TNT, 1, 'table', one(ITEM.GUNPOWDER, 5), one(B.SAND, 4));

// Chiseled blocks: two slabs.
add(CUBE_ID.chiseled_stone_bricks, 1, 'table', one(SLAB_FIRST + PARTIAL_MATERIALS.findIndex((m) => m.name === 'stone_brick'), 2));
add(CUBE_ID.chiseled_sandstone, 1, 'table', one(SLAB_FIRST + PARTIAL_MATERIALS.findIndex((m) => m.name === 'sandstone'), 2));
add(CUBE_ID.chiseled_red_sandstone, 1, 'table', one(itemFromState(B.SLAB_X, PARTIAL_EXT.findIndex((m) => m.base === 'red_sandstone') << 2), 2));

// ---------------------------------------------------------------- slabs, stairs and walls
PARTIAL_MATERIALS.forEach((m, i) => {
  add(SLAB_FIRST + i, 6, 'table', one(m.base, 3));
  add(STAIRS_FIRST + i, 4, 'table', one(m.base, 6));
});
PARTIAL_EXT.forEach((m, i) => {
  const base = id(m.base);
  add(itemFromState(B.SLAB_X, i << 2), 6, 'table', one(base, 3));
  add(itemFromState(B.STAIRS_X, i << 3), 4, 'table', one(base, 6));
});
WALL_MATERIALS.forEach((m, i) => add(itemFromState(B.WALL, i), 6, 'table', one(id(m.base), 6)));

// ---------------------------------------------------------------- metals, gems and their blocks
const storage: [string, string, string][] = [
  ['coal', 'coal_block', 'coal'], ['iron_ingot', 'iron_block', 'iron_ingot'], ['gold_ingot', 'gold_block', 'gold_ingot'],
  ['copper_ingot', 'copper_block', 'copper_ingot'], ['diamond', 'diamond_block', 'diamond'], ['emerald', 'emerald_block', 'emerald'],
  ['lapis_lazuli', 'lapis_block', 'lapis_lazuli'], ['redstone', 'redstone_block', 'redstone'],
  ['raw_iron', 'raw_iron_block', 'raw_iron'], ['raw_copper', 'raw_copper_block', 'raw_copper'], ['raw_gold', 'raw_gold_block', 'raw_gold'],
];
for (const [item, block] of storage) {
  add(id(block), 1, 'table', one(id(item), 9));
  add(id(item), 9, 'hand', one(id(block)));
}
add(id('iron_ingot'), 1, 'table', one(id('iron_nugget'), 9));
add(id('iron_nugget'), 9, 'hand', one(id('iron_ingot')));
add(id('gold_ingot'), 1, 'table', one(id('gold_nugget'), 9));
add(id('gold_nugget'), 9, 'hand', one(id('gold_ingot')));
add(id('iron_bars'), 16, 'table', one(id('iron_ingot'), 6));
add(ITEM.BUCKET, 1, 'table', one(id('iron_ingot'), 3));
add(ITEM.SHEARS, 1, 'hand', one(id('iron_ingot'), 2));
add(ITEM.FLINT_AND_STEEL, 1, 'hand', one(id('iron_ingot')), one(ITEM.FLINT));
add(ITEM.BOW, 1, 'table', one(ITEM.STICK, 3), one(ITEM.STRING, 3));
add(ITEM.ARROW, 4, 'table', one(ITEM.FLINT), one(ITEM.STICK), one(ITEM.FEATHER));

// ---------------------------------------------------------------- tools, weapons and armor
const toolMaterials: Ingredient[] = [any(PLANKS, 1), any(COBBLES, 1), one(id('iron_ingot')), one(id('diamond')), one(id('gold_ingot'))];
const toolIds = (kind: string): number[] => ['wooden', 'stone', 'iron', 'diamond', 'golden'].map((t) => id(`${t}_${kind}`));
const toolHeads: [string, number, number][] = [['pickaxe', 3, 2], ['axe', 3, 2], ['shovel', 1, 2], ['sword', 2, 1], ['hoe', 2, 2]];
for (const [kind, heads, sticks] of toolHeads) {
  toolIds(kind).forEach((tool, tier) => {
    add(tool, 1, 'table', { ids: toolMaterials[tier].ids, count: heads }, one(ITEM.STICK, sticks));
  });
}
const armorMaterial: (Ingredient | null)[] = [one(id('leather')), null, one(id('iron_ingot')), one(id('gold_ingot')), one(id('diamond'))];
const armorPieces = [5, 8, 7, 4];
ARMOR_MATERIALS.forEach((m, mi) => {
  const ing = armorMaterial[mi];
  if (!ing) return; // chainmail has no recipe in vanilla either (loot only)
  ['helmet', 'chestplate', 'leggings', 'boots'].forEach((piece, slot) => {
    add(id(`${m.name}_${piece}`), 1, 'table', { ids: ing.ids, count: armorPieces[slot] });
  });
});

// ---------------------------------------------------------------- food and farm items
add(id('bread'), 1, 'table', one(id('wheat'), 3));
add(id('golden_apple'), 1, 'table', one(id('gold_ingot'), 8), one(id('apple')));
add(id('golden_carrot'), 1, 'table', one(id('gold_nugget'), 8), one(id('carrot')));
add(id('mushroom_stew'), 1, 'hand', one(CUBE_ID.red_mushroom), one(CUBE_ID.brown_mushroom), one(id('bowl')));
add(id('bone_meal'), 3, 'hand', one(ITEM.BONE));
add(id('sugar'), 1, 'hand', one(CUBE_ID.sugar_cane));
add(id('paper'), 3, 'table', one(CUBE_ID.sugar_cane, 3));
add(id('book'), 1, 'hand', one(id('paper'), 3), one(id('leather')));
add(id('melon_seeds'), 1, 'hand', one(id('melon_slice')));
add(id('pumpkin_seeds'), 4, 'hand', one(CUBE_ID.pumpkin));

// ---------------------------------------------------------------- dyes and coloured blocks
add(id('white_dye'), 1, 'hand', one(id('bone_meal')));
add(id('white_dye'), 1, 'hand', one(CUBE_ID.lily_of_the_valley));
add(id('red_dye'), 1, 'hand', one(B.POPPY));
add(id('red_dye'), 1, 'hand', one(CUBE_ID.red_tulip));
add(id('yellow_dye'), 1, 'hand', one(B.DANDELION));
add(id('blue_dye'), 1, 'hand', one(id('lapis_lazuli')));
add(id('blue_dye'), 1, 'hand', one(CUBE_ID.cornflower));
add(id('orange_dye'), 1, 'hand', one(CUBE_ID.orange_tulip));
add(id('light_blue_dye'), 1, 'hand', one(CUBE_ID.blue_orchid));
add(id('magenta_dye'), 1, 'hand', one(CUBE_ID.allium));
add(id('light_gray_dye'), 1, 'hand', one(CUBE_ID.azure_bluet));
add(id('light_gray_dye'), 1, 'hand', one(CUBE_ID.oxeye_daisy));
add(id('black_dye'), 1, 'hand', one(id('ink_sac')));
const mix = (a: string, b: string, out: string): void => add(id(`${out}_dye`), 2, 'hand', one(id(`${a}_dye`)), one(id(`${b}_dye`)));
mix('red', 'yellow', 'orange');
mix('red', 'white', 'pink');
mix('blue', 'white', 'light_blue');
mix('green', 'white', 'lime');
mix('black', 'white', 'gray');
mix('gray', 'white', 'light_gray');
mix('blue', 'green', 'cyan');
mix('blue', 'red', 'purple');
mix('purple', 'pink', 'magenta');

add(B.WOOL, 1, 'hand', one(ITEM.STRING, 4));
DYES.forEach((_, i) => {
  const coloured = (block: number): number => itemFromState(block, i);
  if (i > 0) add(coloured(B.WOOL), 1, 'hand', one(dye(i)), one(B.WOOL));
  add(coloured(B.CARPET), 3, 'hand', one(coloured(B.WOOL), 2));
  add(itemFromState(B.BED, i << 3), 1, 'table', one(coloured(B.WOOL), 3), any(PLANKS, 3));
  // Terracotta and glass are dyed eight at a time; concrete skips the powder step (sand, gravel and a dye).
  add(coloured(B.STAINED_TERRACOTTA), 8, 'table', one(CUBE_ID.terracotta, 8), one(dye(i)));
  add(coloured(B.STAINED_GLASS), 8, 'table', one(B.GLASS, 8), one(dye(i)));
  add(coloured(B.CONCRETE), 8, 'table', one(B.SAND, 4), one(B.GRAVEL, 4), one(dye(i)));
  add(coloured(B.STAINED_GLASS_PANE), 16, 'table', one(coloured(B.STAINED_GLASS), 6));
});
add(B.GLASS_PANE, 16, 'table', one(B.GLASS, 6));

// ---------------------------------------------------------------- smelting
const smelt = (from: number | number[], to: number, count = 1): void => add(to, count, 'furnace', any(Array.isArray(from) ? from : [from], 1), any(FUEL, 1));
smelt([B.IRON_ORE, id('raw_iron')], id('iron_ingot'));
smelt([B.GOLD_ORE, id('raw_gold')], id('gold_ingot'));
smelt([CUBE_ID.copper_ore, id('raw_copper')], id('copper_ingot'));
smelt(B.COAL_ORE, ITEM.COAL);
smelt(CUBE_ID.lapis_ore, id('lapis_lazuli'));
smelt(CUBE_ID.redstone_ore, id('redstone'));
smelt(B.DIAMOND_ORE, id('diamond'));
smelt(CUBE_ID.emerald_ore, id('emerald'));
smelt([B.SAND, CUBE_ID.red_sand], B.GLASS);
smelt(B.COBBLESTONE, B.STONE);
smelt(CUBE_ID.cobbled_deepslate, CUBE_ID.deepslate);
smelt(B.STONE, CUBE_ID.smooth_stone);
smelt(B.SANDSTONE, CUBE_ID.smooth_sandstone);
smelt(CUBE_ID.red_sandstone, CUBE_ID.smooth_red_sandstone);
smelt(B.STONE_BRICKS, CUBE_ID.cracked_stone_bricks);
smelt(id('clay_ball'), id('brick'));
smelt(B.CLAY, CUBE_ID.terracotta);
DYES.forEach((_, i) => smelt(itemFromState(B.STAINED_TERRACOTTA, i), itemFromState(B.GLAZED_TERRACOTTA, i)));
smelt(LOGS, id('charcoal'));
smelt(B.CACTUS, id('green_dye'));
smelt(id('potato'), id('baked_potato'));
smelt(ITEM.PORKCHOP, ITEM.COOKED_PORKCHOP);
smelt(ITEM.BEEF, ITEM.STEAK);
smelt(ITEM.MUTTON, ITEM.COOKED_MUTTON);
smelt(ITEM.CHICKEN, ITEM.COOKED_CHICKEN);
smelt(id('rabbit'), id('cooked_rabbit'));
smelt(id('cod'), id('cooked_cod'));
smelt(id('salmon'), id('cooked_salmon'));

export const RECIPES: Recipe[] = recipes;

export type RecipeCategory = 'building' | 'wood' | 'tools' | 'combat' | 'food' | 'materials' | 'colors' | 'smelting';

export const RECIPE_CATEGORIES: { id: RecipeCategory | 'all'; name: string }[] = [
  { id: 'all', name: 'All' },
  { id: 'building', name: 'Build' },
  { id: 'wood', name: 'Wood' },
  { id: 'tools', name: 'Tools' },
  { id: 'combat', name: 'Combat' },
  { id: 'food', name: 'Food' },
  { id: 'materials', name: 'Items' },
  { id: 'colors', name: 'Colors' },
  { id: 'smelting', name: 'Smelt' },
];

const COLORED = new Set<number>([B.WOOL, B.CARPET, B.BED, B.STAINED_TERRACOTTA, B.STAINED_GLASS, B.CONCRETE, B.STAINED_GLASS_PANE, B.GLAZED_TERRACOTTA]);
const FUNCTIONAL = new Set<number>([B.ENCHANTING_TABLE, B.ANVIL, B.GRINDSTONE, B.CRAFTING_TABLE, B.BOOKSHELF, B.TORCH, B.FURNACE, B.TNT, id('chest'), id('ladder'), id('lantern')]);

/** Which tab of the recipe book a recipe belongs to (derived from the result, so new recipes sort themselves). */
export function recipeCategory(r: Recipe): RecipeCategory {
  if (r.station === 'furnace') return 'smelting';
  const item = r.result.id;
  const def = getItemDef(item);
  if (def?.armor || def?.tool?.kind === 'sword' || item === ITEM.BOW || item === ITEM.ARROW) return 'combat';
  if (def?.tool || item === ITEM.BUCKET || item === ITEM.FLINT_AND_STEEL) return 'tools';
  if (def?.food) return 'food';
  const block = itemBlock(item);
  if (block) {
    if (COLORED.has(block)) return 'colors';
    if (PLANKS.includes(block) || FUNCTIONAL.has(block) || block === B.DOOR || block === B.TRAPDOOR || block === B.FENCE || block === B.FENCE_GATE) return 'wood';
    return 'building';
  }
  return 'materials';
}

export function canCraft(inv: PlayerInventory, r: Recipe, stations: Set<Station>): boolean {
  if (r.station !== 'hand' && !stations.has(r.station)) return false;
  // Simulate taking the ingredients so one item can't count for two of them
  // (e.g. a single log as both the input and the fuel).
  const left = new Map<number, number>();
  for (const ing of r.ingredients) {
    let need = ing.count;
    for (const item of ing.ids) {
      const have = left.has(item) ? left.get(item)! : inv.count(item);
      const take = Math.min(need, have);
      left.set(item, have - take);
      need -= take;
      if (need === 0) break;
    }
    if (need > 0) return false;
  }
  return true;
}

/**
 * Consumes the ingredients (taking from whichever accepted item the player has) and adds
 * the result. Returns how many result items did not fit (-1 if it could not be crafted).
 */
export function craft(inv: PlayerInventory, r: Recipe, stations: Set<Station>): number {
  if (!canCraft(inv, r, stations)) return -1;
  for (const ing of r.ingredients) {
    let left = ing.count;
    for (const item of ing.ids) {
      const n = Math.min(left, inv.count(item));
      if (n > 0) inv.remove(item, n);
      left -= n;
      if (left === 0) break;
    }
  }
  return inv.add({ ...r.result });
}
