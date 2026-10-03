import type { BlockSound } from './BlockRegistry';

/**
 * Data tables for the bulk of the block content (see docs/CONTENT.md). Pure data: the registries
 * (BlockRegistry, ItemRegistry, Recipes), the texture painters and the creative inventory all read these,
 * so adding a wood or a colour is one line here.
 *
 * Block ids are positions in these tables, so the tables are APPEND-ONLY: never reorder or insert, or
 * saved worlds change their blocks. tests/content.test.ts pins a few ids.
 */

// ---------------------------------------------------------------- dyes

export interface Dye {
  name: string;
  display: string;
  /** Minecraft's dye colour (0xRRGGBB): wool, concrete, terracotta, glass, carpets and beds are tinted with it. */
  rgb: number;
}

/** Minecraft's 16 colours in item order. The index is the `meta & 15` of every coloured block. */
export const DYES: Dye[] = [
  { name: 'white', display: 'White', rgb: 0xf9fffe },
  { name: 'orange', display: 'Orange', rgb: 0xf9801d },
  { name: 'magenta', display: 'Magenta', rgb: 0xc74ebd },
  { name: 'light_blue', display: 'Light Blue', rgb: 0x3ab3da },
  { name: 'yellow', display: 'Yellow', rgb: 0xfed83d },
  { name: 'lime', display: 'Lime', rgb: 0x80c71f },
  { name: 'pink', display: 'Pink', rgb: 0xf38baa },
  { name: 'gray', display: 'Gray', rgb: 0x474f52 },
  { name: 'light_gray', display: 'Light Gray', rgb: 0x9d9d97 },
  { name: 'cyan', display: 'Cyan', rgb: 0x169c9c },
  { name: 'purple', display: 'Purple', rgb: 0x8932b8 },
  { name: 'blue', display: 'Blue', rgb: 0x3c44aa },
  { name: 'brown', display: 'Brown', rgb: 0x835432 },
  { name: 'green', display: 'Green', rgb: 0x5e7c16 },
  { name: 'red', display: 'Red', rgb: 0xb02e26 },
  { name: 'black', display: 'Black', rgb: 0x1d1d21 },
];

// ---------------------------------------------------------------- wood

export interface WoodType {
  name: string;
  display: string;
}

/** Index = the material number in the meta of slabs, stairs, doors, fences and trapdoors. */
export const WOODS: WoodType[] = [
  { name: 'oak', display: 'Oak' },
  { name: 'spruce', display: 'Spruce' },
  { name: 'birch', display: 'Birch' },
  { name: 'jungle', display: 'Jungle' },
  { name: 'acacia', display: 'Acacia' },
  { name: 'dark_oak', display: 'Dark Oak' },
  { name: 'mangrove', display: 'Mangrove' },
  { name: 'cherry', display: 'Cherry' },
];

// ---------------------------------------------------------------- full cubes and plants

export type MineTool = 'pickaxe' | 'axe' | 'shovel' | 'hoe' | 'sword' | 'shears';

export interface CubeSpec {
  /** Registry name; also the default texture name. */
  name: string;
  display?: string;
  /** Minecraft hardness (breaking-time basis). */
  hardness: number;
  tool?: MineTool;
  /** Lowest pickaxe tier that gets a drop (0 wood, 1 stone, 2 iron, 3 diamond). */
  minTier?: number;
  sound: BlockSound;
  /** Textures: one name for all faces, or [top, side, bottom?]. Default: the block name. */
  tex?: string | [string, string, string?];
  /** Cube extras. */
  light?: number;
  /** The front face (texture 4th slot) turns with meta bits 0-1. */
  front?: string;
  /** Plain-text flags: leaves, plant, cobweb. */
  kind?: 'cube' | 'leaves' | 'plant' | 'cherry_leaves' | 'cobweb' | 'ice';
}

const S = 'stone' as const;
const W = 'wood' as const;

/** Wood blocks in this order for the five woods that have no legacy ids (see WOODS 3..7). */
export const NEW_WOODS = WOODS.slice(3);
/** Stripped logs of the three woods that exist already (oak, spruce, birch). */
export const OLD_WOODS = WOODS.slice(0, 3);

/**
 * The cube/plant table. Id = CUBE_FIRST + index.
 */
export const CUBE_FIRST = 90;
export const CUBES: CubeSpec[] = [
  // stone family (0..16)
  { name: 'granite', hardness: 1.5, tool: 'pickaxe', minTier: 0, sound: S },
  { name: 'diorite', hardness: 1.5, tool: 'pickaxe', minTier: 0, sound: S },
  { name: 'andesite', hardness: 1.5, tool: 'pickaxe', minTier: 0, sound: S },
  { name: 'polished_granite', hardness: 1.5, tool: 'pickaxe', minTier: 0, sound: S },
  { name: 'polished_diorite', hardness: 1.5, tool: 'pickaxe', minTier: 0, sound: S },
  { name: 'polished_andesite', hardness: 1.5, tool: 'pickaxe', minTier: 0, sound: S },
  { name: 'smooth_stone', hardness: 2, tool: 'pickaxe', minTier: 0, sound: S },
  { name: 'mossy_stone_bricks', hardness: 1.5, tool: 'pickaxe', minTier: 0, sound: S },
  { name: 'cracked_stone_bricks', hardness: 1.5, tool: 'pickaxe', minTier: 0, sound: S },
  { name: 'chiseled_stone_bricks', hardness: 1.5, tool: 'pickaxe', minTier: 0, sound: S },
  { name: 'tuff', hardness: 1.5, tool: 'pickaxe', minTier: 0, sound: S },
  { name: 'calcite', hardness: 0.75, tool: 'pickaxe', minTier: 0, sound: S },
  { name: 'deepslate', hardness: 3, tool: 'pickaxe', minTier: 0, sound: 'deepslate', tex: ['deepslate_top', 'deepslate'] },
  { name: 'cobbled_deepslate', hardness: 3.5, tool: 'pickaxe', minTier: 0, sound: 'deepslate' },
  { name: 'polished_deepslate', hardness: 3.5, tool: 'pickaxe', minTier: 0, sound: 'deepslate' },
  { name: 'deepslate_bricks', hardness: 3.5, tool: 'pickaxe', minTier: 0, sound: 'deepslate' },
  { name: 'deepslate_tiles', hardness: 3.5, tool: 'pickaxe', minTier: 0, sound: 'deepslate' },
  // sand family (17..24)
  { name: 'red_sand', hardness: 0.5, tool: 'shovel', sound: 'sand' },
  { name: 'red_sandstone', hardness: 0.8, tool: 'pickaxe', minTier: 0, sound: S, tex: ['red_sandstone_top', 'red_sandstone', 'red_sandstone_bottom'] },
  { name: 'chiseled_sandstone', hardness: 0.8, tool: 'pickaxe', minTier: 0, sound: S, tex: ['sandstone_top', 'chiseled_sandstone', 'sandstone_bottom'] },
  { name: 'cut_sandstone', hardness: 0.8, tool: 'pickaxe', minTier: 0, sound: S, tex: ['sandstone_top', 'cut_sandstone', 'sandstone_bottom'] },
  { name: 'smooth_sandstone', hardness: 2, tool: 'pickaxe', minTier: 0, sound: S, tex: 'sandstone_top' },
  { name: 'chiseled_red_sandstone', hardness: 0.8, tool: 'pickaxe', minTier: 0, sound: S, tex: ['red_sandstone_top', 'chiseled_red_sandstone', 'red_sandstone_bottom'] },
  { name: 'cut_red_sandstone', hardness: 0.8, tool: 'pickaxe', minTier: 0, sound: S, tex: ['red_sandstone_top', 'cut_red_sandstone', 'red_sandstone_bottom'] },
  { name: 'smooth_red_sandstone', hardness: 2, tool: 'pickaxe', minTier: 0, sound: S, tex: 'red_sandstone_top' },
  // earth (25..33)
  { name: 'coarse_dirt', hardness: 0.5, tool: 'shovel', sound: 'gravel' },
  { name: 'podzol', hardness: 0.5, tool: 'shovel', sound: 'grass', tex: ['podzol_top', 'podzol_side', 'dirt'] },
  { name: 'mycelium', hardness: 0.6, tool: 'shovel', sound: 'grass', tex: ['mycelium_top', 'mycelium_side', 'dirt'] },
  { name: 'farmland', hardness: 0.6, tool: 'shovel', sound: 'gravel', tex: ['farmland_top', 'dirt', 'dirt'] },
  { name: 'dirt_path', display: 'Dirt Path', hardness: 0.65, tool: 'shovel', sound: 'grass', tex: ['dirt_path_top', 'dirt_path_side', 'dirt'] },
  { name: 'mud', hardness: 0.5, tool: 'shovel', sound: 'mud' },
  { name: 'mud_bricks', hardness: 1.5, tool: 'pickaxe', minTier: 0, sound: 'mud' },
  { name: 'terracotta', hardness: 1.25, tool: 'pickaxe', minTier: 0, sound: S },
  { name: 'moss_block', hardness: 0.1, tool: 'hoe', sound: 'grass' },
  // ores and storage blocks (34..48)
  { name: 'copper_ore', hardness: 3, tool: 'pickaxe', minTier: 1, sound: S },
  { name: 'lapis_ore', hardness: 3, tool: 'pickaxe', minTier: 1, sound: S },
  { name: 'redstone_ore', hardness: 3, tool: 'pickaxe', minTier: 2, sound: S },
  { name: 'emerald_ore', hardness: 3, tool: 'pickaxe', minTier: 2, sound: S },
  { name: 'coal_block', display: 'Block of Coal', hardness: 5, tool: 'pickaxe', minTier: 0, sound: S },
  { name: 'iron_block', display: 'Block of Iron', hardness: 5, tool: 'pickaxe', minTier: 1, sound: 'metal' },
  { name: 'gold_block', display: 'Block of Gold', hardness: 3, tool: 'pickaxe', minTier: 2, sound: 'metal' },
  { name: 'diamond_block', display: 'Block of Diamond', hardness: 5, tool: 'pickaxe', minTier: 2, sound: 'metal' },
  { name: 'copper_block', display: 'Block of Copper', hardness: 3, tool: 'pickaxe', minTier: 1, sound: 'metal' },
  { name: 'lapis_block', display: 'Block of Lapis Lazuli', hardness: 3, tool: 'pickaxe', minTier: 1, sound: S },
  { name: 'emerald_block', display: 'Block of Emerald', hardness: 5, tool: 'pickaxe', minTier: 2, sound: S },
  { name: 'redstone_block', display: 'Block of Redstone', hardness: 5, tool: 'pickaxe', minTier: 0, sound: S },
  { name: 'raw_iron_block', display: 'Block of Raw Iron', hardness: 5, tool: 'pickaxe', minTier: 1, sound: S },
  { name: 'raw_copper_block', display: 'Block of Raw Copper', hardness: 5, tool: 'pickaxe', minTier: 1, sound: S },
  { name: 'raw_gold_block', display: 'Block of Raw Gold', hardness: 5, tool: 'pickaxe', minTier: 2, sound: S },
  // natural and farm blocks (49..59)
  { name: 'hay_block', display: 'Hay Bale', hardness: 0.5, tool: 'hoe', sound: 'grass', tex: ['hay_top', 'hay_side', 'hay_top'] },
  { name: 'pumpkin', hardness: 1, tool: 'axe', sound: W, tex: ['pumpkin_top', 'pumpkin_side', 'pumpkin_top'] },
  { name: 'carved_pumpkin', hardness: 1, tool: 'axe', sound: W, tex: ['pumpkin_top', 'pumpkin_side', 'pumpkin_top'], front: 'carved_pumpkin_front' },
  { name: 'jack_o_lantern', display: "Jack o'Lantern", hardness: 1, tool: 'axe', sound: W, tex: ['pumpkin_top', 'pumpkin_side', 'pumpkin_top'], front: 'jack_o_lantern_front', light: 15 },
  { name: 'melon', hardness: 1, tool: 'axe', sound: W, tex: ['melon_top', 'melon_side', 'melon_top'] },
  { name: 'ice', hardness: 0.5, tool: 'pickaxe', sound: 'glass', kind: 'ice' },
  { name: 'packed_ice', hardness: 0.5, tool: 'pickaxe', sound: 'glass' },
  { name: 'sea_lantern', hardness: 0.3, sound: 'glass', light: 15 },
  { name: 'bone_block', hardness: 2, tool: 'pickaxe', minTier: 0, sound: S, tex: ['bone_block_top', 'bone_block_side', 'bone_block_top'] },
  { name: 'cobweb', hardness: 4, tool: 'sword', sound: 'wool', kind: 'cobweb' },
  { name: 'sponge', hardness: 0.6, tool: 'hoe', sound: 'grass' },
  // plants, plain ids so world generation can place them (60..71)
  { name: 'brown_mushroom', hardness: 0, sound: 'grass', kind: 'plant' },
  { name: 'red_mushroom', hardness: 0, sound: 'grass', kind: 'plant' },
  { name: 'blue_orchid', display: 'Blue Orchid', hardness: 0, sound: 'grass', kind: 'plant' },
  { name: 'allium', hardness: 0, sound: 'grass', kind: 'plant' },
  { name: 'azure_bluet', display: 'Azure Bluet', hardness: 0, sound: 'grass', kind: 'plant' },
  { name: 'red_tulip', display: 'Red Tulip', hardness: 0, sound: 'grass', kind: 'plant' },
  { name: 'orange_tulip', display: 'Orange Tulip', hardness: 0, sound: 'grass', kind: 'plant' },
  { name: 'oxeye_daisy', display: 'Oxeye Daisy', hardness: 0, sound: 'grass', kind: 'plant' },
  { name: 'cornflower', hardness: 0, sound: 'grass', kind: 'plant' },
  { name: 'lily_of_the_valley', display: 'Lily of the Valley', hardness: 0, sound: 'grass', kind: 'plant' },
  { name: 'fern', hardness: 0, sound: 'grass', kind: 'plant' },
  { name: 'sugar_cane', display: 'Sugar Cane', hardness: 0, sound: 'grass', kind: 'plant' },
  // new woods (71..): planks, log, stripped log, leaves per wood; then the stripped logs of the old woods
  ...NEW_WOODS.flatMap((w): CubeSpec[] => [
    { name: `${w.name}_planks`, display: `${w.display} Planks`, hardness: 2, tool: 'axe', sound: W },
    { name: `${w.name}_log`, display: `${w.display} Log`, hardness: 2, tool: 'axe', sound: W, tex: [`${w.name}_log_top`, `${w.name}_log`, `${w.name}_log_top`] },
    { name: `stripped_${w.name}_log`, display: `Stripped ${w.display} Log`, hardness: 2, tool: 'axe', sound: W, tex: [`stripped_${w.name}_log_top`, `stripped_${w.name}_log`, `stripped_${w.name}_log_top`] },
    { name: `${w.name}_leaves`, display: `${w.display} Leaves`, hardness: 0.2, sound: 'grass', kind: w.name === 'cherry' ? 'cherry_leaves' : 'leaves' },
  ]),
  { name: 'packed_mud', hardness: 1, tool: 'pickaxe', minTier: 0, sound: 'mud' },
  ...OLD_WOODS.map((w): CubeSpec => ({
    name: `stripped_${w.name}_log`, display: `Stripped ${w.display} Log`, hardness: 2, tool: 'axe', sound: W,
    tex: [`stripped_${w.name}_log_top`, `stripped_${w.name}_log`, `stripped_${w.name}_log_top`],
  })),
];

export function titleCase(name: string): string {
  return name.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

// ---------------------------------------------------------------- wall materials

/** Materials of walls: the index is the state of the wall block. APPEND-ONLY, at most 32. */
export const WALL_MATERIALS: PartialMaterial[] = [
  { base: 'cobblestone', display: 'Cobblestone' },
  { base: 'mossy_cobblestone', display: 'Mossy Cobblestone' },
  { base: 'stone_bricks', display: 'Stone Brick' },
  { base: 'mossy_stone_bricks', display: 'Mossy Stone Brick' },
  { base: 'sandstone', display: 'Sandstone' },
  { base: 'red_sandstone', display: 'Red Sandstone' },
  { base: 'bricks', display: 'Brick' },
  { base: 'granite', display: 'Granite' },
  { base: 'diorite', display: 'Diorite' },
  { base: 'andesite', display: 'Andesite' },
  { base: 'mud_bricks', display: 'Mud Brick' },
  { base: 'cobbled_deepslate', display: 'Cobbled Deepslate' },
  { base: 'polished_deepslate', display: 'Polished Deepslate' },
  { base: 'deepslate_bricks', display: 'Deepslate Brick' },
  { base: 'deepslate_tiles', display: 'Deepslate Tile' },
  { base: 'tuff', display: 'Tuff' },
];

// ---------------------------------------------------------------- slab and stair materials

export interface PartialMaterial {
  /** Name of the full block it is made of (a name from BLOCK_DEFS: plain blocks and the tables above). */
  base: string;
  display: string;
}

/**
 * Materials of the generic slab and stairs blocks (SLAB_X, STAIRS_X): the index is stored in the state byte
 * (slabs: bits 2-6, stairs: bits 3-7). The nine materials with their own ids (PARTIAL_MATERIALS) are not listed.
 * APPEND-ONLY, at most 32.
 */
export const PARTIAL_EXT: PartialMaterial[] = [
  { base: 'granite', display: 'Granite' },
  { base: 'diorite', display: 'Diorite' },
  { base: 'andesite', display: 'Andesite' },
  { base: 'polished_granite', display: 'Polished Granite' },
  { base: 'polished_diorite', display: 'Polished Diorite' },
  { base: 'polished_andesite', display: 'Polished Andesite' },
  { base: 'smooth_stone', display: 'Smooth Stone' },
  { base: 'jungle_planks', display: 'Jungle' },
  { base: 'acacia_planks', display: 'Acacia' },
  { base: 'dark_oak_planks', display: 'Dark Oak' },
  { base: 'mangrove_planks', display: 'Mangrove' },
  { base: 'cherry_planks', display: 'Cherry' },
  { base: 'mud_bricks', display: 'Mud Brick' },
  { base: 'red_sandstone', display: 'Red Sandstone' },
  { base: 'cut_sandstone', display: 'Cut Sandstone' },
  { base: 'smooth_sandstone', display: 'Smooth Sandstone' },
  { base: 'mossy_stone_bricks', display: 'Mossy Stone Brick' },
  { base: 'cobbled_deepslate', display: 'Cobbled Deepslate' },
  { base: 'polished_deepslate', display: 'Polished Deepslate' },
  { base: 'deepslate_bricks', display: 'Deepslate Brick' },
  { base: 'deepslate_tiles', display: 'Deepslate Tile' },
  { base: 'tuff', display: 'Tuff' },
  { base: 'cut_red_sandstone', display: 'Cut Red Sandstone' },
  { base: 'smooth_red_sandstone', display: 'Smooth Red Sandstone' },
];
