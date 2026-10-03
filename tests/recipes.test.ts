import { describe, expect, it } from 'vitest';
import { PlayerInventory } from '../src/items/Inventory';
import { ITEM, getItemDef, itemFromState, itemId } from '../src/items/ItemRegistry';
import { RECIPES, RECIPE_CATEGORIES, type Recipe, type Station, canCraft, craft, recipeCategory } from '../src/items/Recipes';
import { BLOCK, CUBE_ID } from '../src/world/BlockRegistry';
import { DYES, WOODS } from '../src/world/Content';

const B = BLOCK;

describe('recipe list', () => {
  it('only uses items that exist', () => {
    for (const r of RECIPES) {
      expect(getItemDef(r.result.id), `result ${r.result.id}`).toBeDefined();
      expect(r.result.count).toBeGreaterThan(0);
      expect(r.ingredients.length).toBeGreaterThan(0);
      for (const ing of r.ingredients) {
        expect(ing.count).toBeGreaterThan(0);
        expect(ing.ids.length).toBeGreaterThan(0);
        for (const i of ing.ids) expect(getItemDef(i), `ingredient ${i} of ${r.result.id}`).toBeDefined();
      }
    }
  });

  it('has no duplicate recipes', () => {
    const seen = new Set<string>();
    for (const r of RECIPES) {
      const key = `${r.station}|${r.result.id}x${r.result.count}|${r.ingredients.map((i) => `${[...i.ids].sort().join(',')}x${i.count}`).sort().join('+')}`;
      expect(seen.has(key), `duplicate ${key}`).toBe(false);
      seen.add(key);
    }
  });

  it('puts every recipe in a category', () => {
    const known = new Set(RECIPE_CATEGORIES.map((c) => c.id));
    for (const r of RECIPES) expect(known.has(recipeCategory(r))).toBe(true);
  });

  it('uses the vanilla amounts for the staples', () => {
    const find = (item: number, station?: Station): Recipe => RECIPES.find((r) => r.result.id === item && (!station || r.station === station))!;
    expect(find(B.OAK_PLANKS).result.count).toBe(4);
    expect(find(itemId('stick')).ingredients[0].count).toBe(2);
    expect(find(itemFromState(B.FENCE, 0)).result.count).toBe(3);
    expect(find(itemFromState(B.TRAPDOOR, 0)).result.count).toBe(2);
    expect(find(itemId('iron_chestplate')).ingredients[0].count).toBe(8);
    expect(find(itemId('diamond_helmet')).ingredients[0].count).toBe(5);
    expect(find(itemId('iron_leggings')).ingredients[0].count).toBe(7);
    expect(find(itemId('golden_boots')).ingredients[0].count).toBe(4);
    expect(find(ITEM.IRON_HOE).ingredients.map((i) => i.count)).toEqual([2, 2]);
    expect(find(itemId('iron_bars')).result.count).toBe(16);
    expect(find(itemFromState(B.CARPET, 0)).result.count).toBe(3);
    expect(find(itemId('bread')).ingredients[0].count).toBe(3);
  });

  it('crafts every colour of every dyed block', () => {
    for (let i = 1; i < DYES.length; i++) {
      for (const block of [B.WOOL, B.CARPET, B.STAINED_TERRACOTTA, B.STAINED_GLASS, B.CONCRETE, B.STAINED_GLASS_PANE]) {
        expect(RECIPES.some((r) => r.result.id === itemFromState(block, i)), `${DYES[i].name} ${block}`).toBe(true);
      }
      expect(RECIPES.some((r) => r.station === 'furnace' && r.result.id === itemFromState(B.GLAZED_TERRACOTTA, i))).toBe(true);
    }
  });

  it('crafts doors, trapdoors, fences and gates of every wood', () => {
    WOODS.forEach((_, w) => {
      for (const id of [itemFromState(B.DOOR, w << 5), itemFromState(B.TRAPDOOR, w << 4), itemFromState(B.FENCE, w), itemFromState(B.FENCE_GATE, w << 3)]) {
        expect(RECIPES.some((r) => r.result.id === id), `wood ${w} item ${id}`).toBe(true);
      }
    });
  });
});

/**
 * Everything the player can get without a recipe in survival: what blocks drop, what the world places, what mobs drop.
 * Recipe results that are still out of reach are listed explicitly (they need systems or world generation that
 * the game does not have yet, see docs/CONTENT.md).
 */
const NATURAL = [
  'stone', 'cobblestone', 'dirt', 'sand', 'gravel', 'clay_ball', 'snowball', 'oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log',
  'dark_oak_log', 'mangrove_log', 'cherry_log', 'cactus', 'sugar_cane', 'poppy', 'dandelion', 'blue_orchid', 'allium', 'azure_bluet', 'red_tulip',
  'orange_tulip', 'oxeye_daisy', 'cornflower', 'lily_of_the_valley', 'red_mushroom', 'brown_mushroom', 'pumpkin', 'melon_slice', 'moss_block',
  'mud', 'red_sand', 'ice', 'granite', 'diorite', 'andesite', 'tuff', 'calcite', 'cobbled_deepslate', 'raw_iron', 'raw_gold', 'raw_copper', 'coal',
  'lapis_lazuli', 'redstone', 'diamond', 'emerald', 'flint', 'string', 'bone', 'feather', 'gunpowder', 'porkchop', 'beef', 'mutton', 'chicken',
  'rotten_flesh', 'spider_eye', 'glowstone_dust', 'stick', 'wheat_seeds', 'leather',
];
/**
 * Results nobody can make yet, and why: wheat and the foods that need farming, leather (no cow drops yet), mud (needs wheat),
 * and the dyes without a source (brown needs cocoa, black an ink sac, gray needs black).
 */
const OUT_OF_REACH = /^(Packed Mud|Mud Brick|Hay Bale|Wheat|Leather|Bread|Golden Apple|Golden Carrot|Book|Baked Potato|Cooked|.*(Black|Gray|Brown).*)/;

describe('recipes are craftable from survival resources', () => {
  it('reaches every result from natural items except the known gaps', () => {
    const have = new Set<number>(NATURAL.map((n) => itemId(n)));
    // Plain tools and blocks that are mined directly are natural too.
    for (const id of [B.TNT, B.GLASS, B.OBSIDIAN]) have.add(id);
    let changed = true;
    while (changed) {
      changed = false;
      for (const r of RECIPES) {
        if (have.has(r.result.id)) continue;
        if (r.ingredients.every((ing) => ing.ids.some((i) => have.has(i)))) {
          have.add(r.result.id);
          changed = true;
        }
      }
    }
    const missing = new Set<string>();
    for (const r of RECIPES) if (!have.has(r.result.id)) missing.add(getItemDef(r.result.id)!.displayName);
    for (const name of missing) expect(OUT_OF_REACH.test(name), `unreachable: ${name}`).toBe(true);
    // Some things must work: the basic progression.
    for (const name of ['crafting_table', 'furnace', 'iron_pickaxe', 'diamond_sword', 'shears', 'iron_chestplate', 'bucket', 'glass', 'torch']) {
      expect(have.has(itemId(name)), name).toBe(true);
    }
    expect(have.has(itemFromState(B.WOOL, 5))).toBe(true);
  });
});

describe('crafting with the new recipes', () => {
  const HAND = new Set<Station>();
  const TABLE = new Set<Station>(['table']);

  it('makes slabs of a material with a variant state', () => {
    const inv = new PlayerInventory();
    inv.add({ id: CUBE_ID.granite, count: 3 });
    const slab = RECIPES.find((r) => r.result.id === itemFromState(B.SLAB_X, 0))!;
    expect(canCraft(inv, slab, HAND)).toBe(false);
    expect(craft(inv, slab, TABLE)).toBe(0);
    expect(inv.count(itemFromState(B.SLAB_X, 0))).toBe(6);
  });

  it('dyes wool', () => {
    const inv = new PlayerInventory();
    inv.add({ id: B.WOOL, count: 1 });
    inv.add({ id: itemId('red_dye'), count: 1 });
    const red = RECIPES.find((r) => r.result.id === itemFromState(B.WOOL, 14))!;
    expect(craft(inv, red, HAND)).toBe(0);
    expect(inv.count(itemFromState(B.WOOL, 14))).toBe(1);
  });
});
