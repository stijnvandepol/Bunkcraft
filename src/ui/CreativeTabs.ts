import { ARMOR_MATERIALS, FOODS, MATERIALS } from '../items/ItemContent';
import { ITEM, ITEM_ID, ALL_ITEMS, getItemDef, itemFromState, SHIELD } from '../items/ItemRegistry';
import { BLOCK, BLOCK_DEFS, CUBE_ID, PARTIAL_MATERIALS, SLAB_FIRST, STAIRS_FIRST } from '../world/BlockRegistry';
import { DYES, WOODS } from '../world/Content';

/**
 * The creative inventory's contents, grouped like Minecraft 1.21's tabs. Every id here is an item id (see
 * ItemRegistry: plain blocks, variant blocks and non-block items); ids that do not exist are skipped, so a tab
 * never shows holes while content is added.
 */
export interface CreativeTab {
  id: string;
  name: string;
  /** Item shown on the tab. */
  icon: number;
  items: number[];
  /** Shown on the second row of tabs. */
  bottom?: boolean;
}

const B = BLOCK;
const dyed = (block: number): number[] => DYES.map((_, i) => itemFromState(block, i));
const blk = (name: string): number => CUBE_ID[name];
const itm = (name: string): number => ITEM_ID[name];

/** Extra block ids that other modules register (slabs, trapdoors, ...): looked up by name in BLOCK_DEFS. */
const byName = (name: string): number => BLOCK_DEFS.find((d) => d.name === name)?.id ?? 0;

/** One entry per variant of a block whose variants are 0..count-1 (saplings, ...). */
function variants(block: number): number[] {
  const v = BLOCK_DEFS.find((d) => d.id === block)?.variant;
  return v ? v.names.map((_, i) => itemFromState(block, i << v.shift)) : [block];
}

function ids(list: (number | undefined)[]): number[] {
  return list.filter((x): x is number => !!x && !!getItemDef(x));
}

export function buildCreativeTabs(): CreativeTab[] {
  const woodBlocks = (w: string): number[] => {
    const planks = w === 'oak' ? B.OAK_PLANKS : w === 'spruce' ? B.SPRUCE_PLANKS : w === 'birch' ? B.BIRCH_PLANKS : blk(`${w}_planks`);
    const log = w === 'oak' ? B.OAK_LOG : w === 'spruce' ? B.SPRUCE_LOG : w === 'birch' ? B.BIRCH_LOG : blk(`${w}_log`);
    return [log, blk(`stripped_${w}_log`), planks];
  };

  const slabsAndStairs = [
    ...PARTIAL_MATERIALS.map((_, i) => SLAB_FIRST + i),
    ...PARTIAL_MATERIALS.map((_, i) => STAIRS_FIRST + i),
  ];

  const building = ids([
    B.STONE, blk('granite'), blk('polished_granite'), blk('diorite'), blk('polished_diorite'), blk('andesite'), blk('polished_andesite'),
    blk('deepslate'), blk('cobbled_deepslate'), blk('polished_deepslate'), blk('deepslate_bricks'), blk('deepslate_tiles'),
    blk('calcite'), blk('tuff'), B.COBBLESTONE, B.MOSSY_COBBLESTONE, blk('smooth_stone'),
    B.STONE_BRICKS, blk('mossy_stone_bricks'), blk('cracked_stone_bricks'), blk('chiseled_stone_bricks'),
    blk('mud_bricks'), B.BRICKS,
    B.SANDSTONE, blk('chiseled_sandstone'), blk('cut_sandstone'), blk('smooth_sandstone'),
    blk('red_sandstone'), blk('chiseled_red_sandstone'), blk('cut_red_sandstone'), blk('smooth_red_sandstone'),
    ...WOODS.flatMap((w) => woodBlocks(w.name)),
    B.OBSIDIAN, blk('bone_block'),
    blk('coal_block'), blk('iron_block'), blk('copper_block'), blk('gold_block'), blk('redstone_block'), blk('lapis_block'),
    blk('emerald_block'), blk('diamond_block'), blk('raw_iron_block'), blk('raw_copper_block'), blk('raw_gold_block'),
    B.GLASS,
    ...slabsAndStairs, ...variants(B.SLAB_X), ...variants(B.STAIRS_X),
    ...variants(B.OAK_DOOR),
    ...['trapdoor', 'fence', 'fence_gate', 'wall'].map(byName),
  ]);

  const colored = ids([
    ...dyed(B.WOOL), ...dyed(byName('carpet')), blk('terracotta'), ...dyed(B.STAINED_TERRACOTTA), ...dyed(B.GLAZED_TERRACOTTA),
    ...dyed(B.CONCRETE), ...dyed(B.STAINED_GLASS), ...dyed(byName('stained_glass_pane')), ...variants(B.BED),
  ]);

  const natural = ids([
    B.GRASS, blk('podzol'), blk('mycelium'), blk('dirt_path'), B.DIRT, blk('coarse_dirt'), blk('farmland'), B.CLAY, B.GRAVEL,
    B.SAND, blk('red_sand'), blk('mud'), blk('moss_block'), B.SNOW, B.SNOWY_GRASS, blk('ice'), blk('packed_ice'),
    B.COAL_ORE, B.IRON_ORE, blk('copper_ore'), B.GOLD_ORE, blk('redstone_ore'), blk('lapis_ore'), B.DIAMOND_ORE, blk('emerald_ore'),
    B.OAK_LOG, B.SPRUCE_LOG, B.BIRCH_LOG, blk('jungle_log'), blk('acacia_log'), blk('dark_oak_log'), blk('mangrove_log'), blk('cherry_log'),
    B.OAK_LEAVES, B.SPRUCE_LEAVES, B.BIRCH_LEAVES, blk('jungle_leaves'), blk('acacia_leaves'), blk('dark_oak_leaves'), blk('mangrove_leaves'),
    blk('cherry_leaves'), ...variants(B.SAPLING),
    B.DANDELION, B.POPPY, blk('blue_orchid'), blk('allium'), blk('azure_bluet'), blk('red_tulip'), blk('orange_tulip'),
    blk('oxeye_daisy'), blk('cornflower'), blk('lily_of_the_valley'),
    B.TALL_GRASS, blk('fern'), B.DEAD_BUSH, B.CACTUS, blk('sugar_cane'), blk('brown_mushroom'), blk('red_mushroom'),
    blk('pumpkin'), blk('melon'), blk('hay_block'), blk('cobweb'), blk('sponge'),
  ]);

  const functional = ids([
    B.CRAFTING_TABLE, B.FURNACE, byName('chest'), B.BOOKSHELF, byName('ladder'), B.TORCH, byName('lantern'), B.GLOWSTONE, blk('sea_lantern'),
    blk('carved_pumpkin'), blk('jack_o_lantern'), byName('bed'), B.TNT, byName('iron_bars'), byName('glass_pane'),
    B.ENCHANTING_TABLE, ...variants(B.ANVIL), B.GRINDSTONE,
  ]);

  const redstone = ids([
    itm('redstone'), B.REDSTONE_TORCH, blk('redstone_block'), B.REPEATER, B.PISTON, B.STICKY_PISTON, B.LEVER, ...variants(B.BUTTON),
    ...variants(B.PRESSURE_PLATE), B.NOTE_BLOCK, B.REDSTONE_LAMP, B.TNT, ...variants(B.OAK_DOOR).slice(0, 1), byName('trapdoor'), byName('fence_gate'),
  ]);

  const tiers = ['wooden', 'stone', 'iron', 'diamond', 'golden'];
  const tool = (kind: string): number[] => tiers.map((t) => ITEM_ID[`${t}_${kind}`]);
  const tools = ids([
    ...tool('shovel'), ...tool('pickaxe'), ...tool('axe'), ...tool('hoe'), ITEM.SHEARS, ITEM.FLINT_AND_STEEL,
    ITEM.BUCKET, ITEM.WATER_BUCKET, ITEM.LAVA_BUCKET, ITEM_ID.milk_bucket, ITEM_ID.saddle, ITEM_ID.ender_pearl, itm('bowl'),
  ]);

  const armorIds = ARMOR_MATERIALS.flatMap((m) => ['helmet', 'chestplate', 'leggings', 'boots'].map((s) => ITEM_ID[`${m.name}_${s}`]));
  const combat = ids([...tool('sword'), ...tool('axe'), ITEM.BOW, ITEM.ARROW, SHIELD, ...armorIds]);

  const meat = ['porkchop', 'cooked_porkchop', 'beef', 'steak', 'mutton', 'cooked_mutton', 'chicken', 'cooked_chicken', 'rotten_flesh', 'spider_eye'];
  const foodIds = [
    ...meat.map((n) => ITEM_ID[n]),
    ...FOODS.map((f) => ITEM_ID[f.name]),
  ];
  const food = ids(foodIds);

  const ingredientNames = ['coal', 'charcoal', 'raw_iron', 'raw_copper', 'raw_gold', 'iron_ingot', 'copper_ingot', 'gold_ingot', 'iron_nugget',
    'gold_nugget', 'diamond', 'emerald', 'lapis_lazuli', 'redstone', 'flint', 'stick', 'string', 'feather', 'bone', 'bone_meal', 'gunpowder',
    'egg', 'slime_ball', 'leather', 'paper', 'book', 'clay_ball', 'brick', 'snowball', 'glowstone_dust', 'sugar', 'wheat', 'wheat_seeds', 'pumpkin_seeds', 'melon_seeds',
    'ink_sac', ...DYES.map((d) => `${d.name}_dye`)];
  const ingredients = ids(ingredientNames.map((n) => ITEM_ID[n]));

  const tabs: CreativeTab[] = [
    { id: 'building', name: 'Building Blocks', icon: B.BRICKS, items: building },
    { id: 'colored', name: 'Colored Blocks', icon: itemFromState(B.WOOL, 11), items: colored },
    { id: 'natural', name: 'Natural Blocks', icon: B.GRASS, items: natural },
    { id: 'functional', name: 'Functional Blocks', icon: B.CRAFTING_TABLE, items: functional },
    { id: 'redstone', name: 'Redstone Blocks', icon: itm('redstone'), items: redstone },
    { id: 'tools', name: 'Tools & Utilities', icon: ITEM.IRON_PICKAXE, items: tools, bottom: true },
    { id: 'combat', name: 'Combat', icon: ITEM.IRON_SWORD, items: combat, bottom: true },
    { id: 'food', name: 'Food & Drinks', icon: itm('apple'), items: food, bottom: true },
    { id: 'ingredients', name: 'Ingredients', icon: ITEM.IRON_INGOT, items: ingredients, bottom: true },
  ];
  void MATERIALS;
  return tabs;
}

/** Every item that exists (blocks that are in the inventory, variants and non-block items), for the search tab. */
export function allCreativeItems(tabs: CreativeTab[]): number[] {
  const seen = new Set<number>();
  for (const t of tabs) for (const id of t.items) seen.add(id);
  // Items that no tab lists (hidden helpers) are still found by search when they are real inventory items.
  for (const id of ALL_ITEMS) seen.add(id);
  return [...seen];
}
