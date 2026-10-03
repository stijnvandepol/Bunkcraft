import type { BlockSound } from '../core/audio/profiles';
import { TINT_BIRCH, TINT_FOLIAGE, TINT_GRASS, TINT_NONE, TINT_SPRUCE } from './BiomeColors';
import { BOX_BUTTON, BOX_DUST, BOX_LEVER, BOX_PISTON, BOX_PISTON_HEAD, BOX_PLATE, BOX_REPEATER, BOX_RTORCH } from './RedstoneShapes';
import { BOX_BED, BOX_CARPET, BOX_FENCE, BOX_GATE, BOX_LADDER, BOX_NONE, BOX_PANE, BOX_TRAPDOOR, BOX_WALL, isTall } from './BoxShapes';
import { CUBES, CUBE_FIRST, DYES, type MineTool, PARTIAL_EXT, WALL_MATERIALS, WOODS, titleCase } from './Content';

/**
 * Data-driven block definitions. Everything the mesher, lighting, physics and UI need
 * is derived from this table, so adding a block = adding an entry (+ a texture painter
 * in rendering/TextureAtlas.ts if it uses a new texture name).
 *
 * Face order used everywhere: 0 +X, 1 -X, 2 +Y (top), 3 -Y (bottom), 4 +Z, 5 -Z.
 */

/**
 * "slab" and "stairs" are unions of octants (see BlockStates), "door" a thin box; all three depend on the
 * block's state byte and are collectively the "partial" blocks (not a full cube, but they collide).
 */
export type RenderShape = 'none' | 'cube' | 'cross' | 'liquid' | 'model' | 'slab' | 'stairs' | 'door' | 'box';
/** Sound type of a block; the available types (and their synthesis) live in `core/audio/profiles.ts`. */
export type { BlockSound };

export interface BlockTextures {
  all?: string;
  top?: string;
  bottom?: string;
  side?: string;
  /** Texture of the +Z face (furnace mouth); blocks have no facing state yet. */
  front?: string;
}

export interface VariantSpec {
  shift: number;
  /** Number of variants (≤ 32). */
  count: number;
  /** Display name per variant (used for the item names). */
  names: string[];
  textures?: BlockTextures[];
  /** Sound per variant (default: the block's). */
  sounds?: BlockSound[];
  /** Hardness and tool per variant (default: the block's). */
  mining?: { hardness: number; tool?: MineTool; minTier?: number }[];
}

export interface BlockDef {
  id: number;
  name: string;
  displayName: string;
  shape: RenderShape;
  /** Collides with the player. */
  solid: boolean;
  /** Lets light through / does not hide neighbouring faces. */
  transparent: boolean;
  /** Faces between two blocks of this type are culled (glass, water). */
  cullSelf?: boolean;
  /** Extra light attenuation when light passes through (leaves, water). */
  lightFilter?: number;
  /**
   * The cell receives light but passes none on (slabs and stairs: lit from outside, a roof of them still
   * darkens what is below). Without it a partial block would have no light of its own to be seen by.
   */
  lightStop?: boolean;
  /** Emitted block light 0..15. */
  light?: number;
  /** Seconds to break; -1 = unbreakable. */
  hardness: number;
  sound: BlockSound;
  /** Foliage that sways in the wind. */
  sway?: boolean;
  /** Shown in the creative inventory. */
  inInventory?: boolean;
  /** Biome colour applied to the greyscale tintable texture parts (see BiomeColors). */
  tint?: number;
  /** Bits of the block state byte this block uses (see BlockStates); 0 = no states. Validated on the server. */
  metaMask?: number;
  /** The block is tinted with the dye colour in the low 4 bits of its state (wool, concrete, glass, ...). */
  dye?: boolean;
  /** The 4th texture slot ("front") is on the side the block faces: state bits 0-1 (furnace, chest, pumpkin). */
  facing?: boolean;
  /** Shape kind of a `box` block (see BoxShapes). */
  boxKind?: number;
  /** Mining: the tool that is fastest and the lowest pickaxe tier that still gets the drop. */
  tool?: MineTool;
  minTier?: number;
  /**
   * Variants of one block id that behave the same: the bits `shift..shift+bits` of the state byte pick the
   * variant (colour, wood, material). `textures` (optional) gives each variant its own texture layers.
   */
  variant?: VariantSpec;
  /** For shape "model": boxes in 1/16 block units [x0, y0, z0, x1, y1, z1]. */
  model?: number[][];
  /** Damage per second when touching the block (survival). */
  contactDamage?: number;
  /** Breaking needs a tool in survival (no drop by hand) — informational for now. */
  drops?: number;
  textures: BlockTextures;
}

export const BLOCK = {
  AIR: 0,
  STONE: 1,
  GRASS: 2,
  DIRT: 3,
  COBBLESTONE: 4,
  OAK_PLANKS: 5,
  BEDROCK: 6,
  SAND: 7,
  GRAVEL: 8,
  OAK_LOG: 9,
  OAK_LEAVES: 10,
  GLASS: 11,
  WATER: 12,
  COAL_ORE: 13,
  IRON_ORE: 14,
  GOLD_ORE: 15,
  DIAMOND_ORE: 16,
  BIRCH_LOG: 17,
  BIRCH_LEAVES: 18,
  SPRUCE_LOG: 19,
  SPRUCE_LEAVES: 20,
  SNOWY_GRASS: 21,
  CACTUS: 22,
  TALL_GRASS: 23,
  DANDELION: 24,
  POPPY: 25,
  DEAD_BUSH: 26,
  BRICKS: 27,
  GLOWSTONE: 28,
  SANDSTONE: 29,
  STONE_BRICKS: 30,
  /** Wool of every colour: the colour is the low 4 bits of the state (id 31 stays white wool = state 0). */
  WOOL: 31,
  WHITE_WOOL: 31,
  CLAY: 32,
  OBSIDIAN: 33,
  BOOKSHELF: 34,
  MOSSY_COBBLESTONE: 35,
  SNOW: 36,
  BIRCH_PLANKS: 37,
  SPRUCE_PLANKS: 38,
  RED_WOOL: 39,
  BLUE_WOOL: 40,
  YELLOW_WOOL: 41,
  GREEN_WOOL: 42,
  TORCH: 43,
  LAVA: 44,
  CRAFTING_TABLE: 45,
  FURNACE: 46,
  TNT: 47,
  STONE_SLAB: 48,
  COBBLESTONE_SLAB: 49,
  MOSSY_COBBLESTONE_SLAB: 50,
  STONE_BRICK_SLAB: 51,
  BRICK_SLAB: 52,
  SANDSTONE_SLAB: 53,
  OAK_SLAB: 54,
  BIRCH_SLAB: 55,
  SPRUCE_SLAB: 56,
  STONE_STAIRS: 57,
  COBBLESTONE_STAIRS: 58,
  MOSSY_COBBLESTONE_STAIRS: 59,
  STONE_BRICK_STAIRS: 60,
  BRICK_STAIRS: 61,
  SANDSTONE_STAIRS: 62,
  OAK_STAIRS: 63,
  BIRCH_STAIRS: 64,
  SPRUCE_STAIRS: 65,
  /** Both halves of a door are this block; the state byte says which half (see BlockStates). */
  /** Doors of every wood: the wood is bits 5-7 of the state (see BlockStates, oak = 0). */
  OAK_DOOR: 66,
  DOOR: 66,
  /** Slabs and stairs of every material not in PARTIAL_MATERIALS: the material is in the state byte (see PartialMaterials). */
  SLAB_X: 67,
  STAIRS_X: 68,
  CONCRETE: 69,
  STAINED_TERRACOTTA: 70,
  GLAZED_TERRACOTTA: 71,
  STAINED_GLASS: 72,
  CARPET: 73,
  STAINED_GLASS_PANE: 74,
  BED: 75,
  GLASS_PANE: 76,
  TRAPDOOR: 77,
  FENCE: 78,
  FENCE_GATE: 79,
  WALL: 80,
  LADDER: 81,
  CHEST: 82,
  LANTERN: 83,
  SAPLING: 84,
  IRON_BARS: 85,
  // Redstone (see docs/CONTENT.md): ids are taken from the top of the free range (254 downwards).
  REDSTONE_WIRE: 254,
  LEVER: 253,
  BUTTON: 252,
  PRESSURE_PLATE: 251,
  REPEATER: 250,
  REDSTONE_TORCH: 249,
  REDSTONE_LAMP: 248,
  REDSTONE_LAMP_LIT: 247,
  NOTE_BLOCK: 246,
  PISTON: 245,
  STICKY_PISTON: 244,
  PISTON_HEAD: 243,
  /** Sentinel returned for blocks in chunks that are not loaded (treated as solid). */
  UNLOADED: 255,
} as const;

const B = BLOCK;

/** Variant spec of a dye family: the colour is the low 4 bits of the state. */
function dyeVariant(noun: string): VariantSpec {
  return { shift: 0, count: 16, names: DYES.map((d) => `${d.display} ${noun}`) };
}

function cube(
  id: number,
  name: string,
  displayName: string,
  textures: BlockTextures,
  hardness: number,
  sound: BlockSound,
  extra: Partial<BlockDef> = {},
): BlockDef {
  return { id, name, displayName, shape: 'cube', solid: true, transparent: false, hardness, sound, inInventory: true, textures, ...extra };
}

function plant(id: number, name: string, displayName: string, texture: string): BlockDef {
  return {
    id, name, displayName, shape: 'cross', solid: false, transparent: true, hardness: 0,
    sound: 'grass', sway: true, inInventory: true, textures: { all: texture },
  };
}

/**
 * Slab and stairs families: the full block they are made of, Minecraft's names. Slab id = SLAB_FIRST + index,
 * stairs id = STAIRS_FIRST + index.
 */
export const SLAB_FIRST = 48;
export const STAIRS_FIRST = 57;
export const PARTIAL_MATERIALS = [
  { base: B.STONE, name: 'stone', display: 'Stone' },
  { base: B.COBBLESTONE, name: 'cobblestone', display: 'Cobblestone' },
  { base: B.MOSSY_COBBLESTONE, name: 'mossy_cobblestone', display: 'Mossy Cobblestone' },
  { base: B.STONE_BRICKS, name: 'stone_brick', display: 'Stone Brick' },
  { base: B.BRICKS, name: 'brick', display: 'Brick' },
  { base: B.SANDSTONE, name: 'sandstone', display: 'Sandstone' },
  { base: B.OAK_PLANKS, name: 'oak', display: 'Oak' },
  { base: B.BIRCH_PLANKS, name: 'birch', display: 'Birch' },
  { base: B.SPRUCE_PLANKS, name: 'spruce', display: 'Spruce' },
] as const;

export const BLOCK_DEFS: BlockDef[] = [
  { id: B.AIR, name: 'air', displayName: 'Air', shape: 'none', solid: false, transparent: true, hardness: 0, sound: 'stone', textures: {} },
  cube(B.STONE, 'stone', 'Stone', { all: 'stone' }, 1.0, 'stone'),
  cube(B.GRASS, 'grass_block', 'Grass Block', { top: 'grass_top', side: 'grass_side', bottom: 'dirt' }, 0.45, 'grass', { tint: TINT_GRASS }),
  cube(B.DIRT, 'dirt', 'Dirt', { all: 'dirt' }, 0.4, 'dirt'),
  cube(B.COBBLESTONE, 'cobblestone', 'Cobblestone', { all: 'cobblestone' }, 1.2, 'stone'),
  cube(B.OAK_PLANKS, 'oak_planks', 'Oak Planks', { all: 'oak_planks' }, 0.8, 'wood'),
  cube(B.BEDROCK, 'bedrock', 'Bedrock', { all: 'bedrock' }, -1, 'stone', { inInventory: false }),
  cube(B.SAND, 'sand', 'Sand', { all: 'sand' }, 0.4, 'sand'),
  cube(B.GRAVEL, 'gravel', 'Gravel', { all: 'gravel' }, 0.45, 'gravel'),
  cube(B.OAK_LOG, 'oak_log', 'Oak Log', { top: 'oak_log_top', bottom: 'oak_log_top', side: 'oak_log' }, 0.9, 'wood'),
  cube(B.OAK_LEAVES, 'oak_leaves', 'Oak Leaves', { all: 'oak_leaves' }, 0.2, 'grass', { transparent: true, lightFilter: 1, sway: true, tint: TINT_FOLIAGE }),
  cube(B.GLASS, 'glass', 'Glass', { all: 'glass' }, 0.3, 'glass', { transparent: true, cullSelf: true }),
  {
    id: B.WATER, name: 'water', displayName: 'Water', shape: 'liquid', solid: false, transparent: true,
    cullSelf: true, lightFilter: 2, hardness: -1, sound: 'stone', textures: { all: 'water' }, metaMask: 15,
  },
  cube(B.COAL_ORE, 'coal_ore', 'Coal Ore', { all: 'coal_ore' }, 1.4, 'stone'),
  cube(B.IRON_ORE, 'iron_ore', 'Iron Ore', { all: 'iron_ore' }, 1.5, 'stone'),
  cube(B.GOLD_ORE, 'gold_ore', 'Gold Ore', { all: 'gold_ore' }, 1.5, 'stone'),
  cube(B.DIAMOND_ORE, 'diamond_ore', 'Diamond Ore', { all: 'diamond_ore' }, 1.6, 'stone'),
  cube(B.BIRCH_LOG, 'birch_log', 'Birch Log', { top: 'birch_log_top', bottom: 'birch_log_top', side: 'birch_log' }, 0.9, 'wood'),
  cube(B.BIRCH_LEAVES, 'birch_leaves', 'Birch Leaves', { all: 'birch_leaves' }, 0.2, 'grass', { transparent: true, lightFilter: 1, sway: true, tint: TINT_BIRCH }),
  cube(B.SPRUCE_LOG, 'spruce_log', 'Spruce Log', { top: 'spruce_log_top', bottom: 'spruce_log_top', side: 'spruce_log' }, 0.9, 'wood'),
  cube(B.SPRUCE_LEAVES, 'spruce_leaves', 'Spruce Leaves', { all: 'spruce_leaves' }, 0.2, 'grass', { transparent: true, lightFilter: 1, sway: true, tint: TINT_SPRUCE }),
  cube(B.SNOWY_GRASS, 'snowy_grass', 'Snowy Grass', { top: 'snow', side: 'grass_snow_side', bottom: 'dirt' }, 0.45, 'snow'),
  cube(B.CACTUS, 'cactus', 'Cactus', { top: 'cactus_top', bottom: 'cactus_bottom', side: 'cactus_side' }, 0.3, 'wool'),
  { ...plant(B.TALL_GRASS, 'tall_grass', 'Grass', 'tall_grass'), tint: TINT_GRASS },
  plant(B.DANDELION, 'dandelion', 'Dandelion', 'dandelion'),
  plant(B.POPPY, 'poppy', 'Poppy', 'poppy'),
  plant(B.DEAD_BUSH, 'dead_bush', 'Dead Bush', 'dead_bush'),
  cube(B.BRICKS, 'bricks', 'Bricks', { all: 'bricks' }, 1.4, 'stone'),
  cube(B.GLOWSTONE, 'glowstone', 'Glowstone', { all: 'glowstone' }, 0.4, 'glass', { light: 15 }),
  cube(B.SANDSTONE, 'sandstone', 'Sandstone', { top: 'sandstone_top', bottom: 'sandstone_bottom', side: 'sandstone_side' }, 0.8, 'stone'),
  cube(B.STONE_BRICKS, 'stone_bricks', 'Stone Bricks', { all: 'stone_bricks' }, 1.3, 'stone'),
  cube(B.WOOL, 'wool', 'Wool', { all: 'white_wool' }, 0.8, 'wool', { dye: true, variant: dyeVariant('Wool'), tool: 'shears' }),
  cube(B.CLAY, 'clay', 'Clay', { all: 'clay' }, 0.45, 'dirt'),
  cube(B.OBSIDIAN, 'obsidian', 'Obsidian', { all: 'obsidian' }, 3.0, 'stone'),
  cube(B.BOOKSHELF, 'bookshelf', 'Bookshelf', { top: 'oak_planks', bottom: 'oak_planks', side: 'bookshelf' }, 0.8, 'wood'),
  cube(B.MOSSY_COBBLESTONE, 'mossy_cobblestone', 'Mossy Cobblestone', { all: 'mossy_cobblestone' }, 1.2, 'stone'),
  cube(B.SNOW, 'snow_block', 'Snow Block', { all: 'snow' }, 0.3, 'snow'),
  cube(B.BIRCH_PLANKS, 'birch_planks', 'Birch Planks', { all: 'birch_planks' }, 0.8, 'wood'),
  cube(B.SPRUCE_PLANKS, 'spruce_planks', 'Spruce Planks', { all: 'spruce_planks' }, 0.8, 'wood'),
  cube(B.RED_WOOL, 'red_wool', 'Red Wool', { all: 'red_wool' }, 0.8, 'wool', { inInventory: false }),
  cube(B.BLUE_WOOL, 'blue_wool', 'Blue Wool', { all: 'blue_wool' }, 0.8, 'wool', { inInventory: false }),
  cube(B.YELLOW_WOOL, 'yellow_wool', 'Yellow Wool', { all: 'yellow_wool' }, 0.8, 'wool', { inInventory: false }),
  cube(B.GREEN_WOOL, 'green_wool', 'Green Wool', { all: 'green_wool' }, 0.8, 'wool', { inInventory: false }),
  {
    id: B.TORCH, name: 'torch', displayName: 'Torch', shape: 'model', solid: false, transparent: true,
    hardness: 0, sound: 'wood', light: 14, inInventory: true, textures: { all: 'torch' },
    model: [[7, 0, 7, 9, 10, 9]],
  },
  {
    id: B.LAVA, name: 'lava', displayName: 'Lava', shape: 'liquid', solid: false, transparent: true,
    cullSelf: true, lightFilter: 2, light: 15, hardness: -1, sound: 'stone', contactDamage: 8, textures: { all: 'lava' }, metaMask: 15,
  },
  cube(B.CRAFTING_TABLE, 'crafting_table', 'Crafting Table', { top: 'crafting_table_top', bottom: 'oak_planks', side: 'crafting_table_side' }, 0.8, 'wood'),
  cube(B.FURNACE, 'furnace', 'Furnace', { top: 'furnace_top', bottom: 'furnace_top', side: 'furnace_side', front: 'furnace_front' }, 1.2, 'stone', { facing: true }),
  cube(B.TNT, 'tnt', 'TNT', { top: 'tnt_top', bottom: 'tnt_bottom', side: 'tnt_side' }, 0, 'grass'),
];

// Doors: the lower half uses the "side" texture slot and the upper half the "top" slot; the wood is the variant.
BLOCK_DEFS.push({
  id: B.OAK_DOOR, name: 'oak_door', displayName: 'Oak Door', shape: 'door', solid: true, transparent: true, hardness: 3, sound: 'wood',
  inInventory: true, textures: { side: 'oak_door_lower', top: 'oak_door_upper' }, metaMask: 255, tool: 'axe',
  variant: {
    shift: 5, count: WOODS.length, names: WOODS.map((w) => `${w.display} Door`),
    textures: WOODS.map((w) => ({ side: `${w.name}_door_lower`, top: `${w.name}_door_upper` })),
  },
});

// Slabs and stairs reuse the textures and sounds of the block they are made of.
PARTIAL_MATERIALS.forEach((m, i) => {
  const base = BLOCK_DEFS.find((d) => d.id === m.base)!;
  const partial = (id: number, name: string, displayName: string, shape: RenderShape, hardness: number, metaMask: number): BlockDef => ({
    id, name, displayName, shape, solid: true, transparent: true, hardness, sound: base.sound, inInventory: true,
    textures: base.textures, lightStop: true, metaMask,
  });
  BLOCK_DEFS.push(partial(SLAB_FIRST + i, `${m.name}_slab`, `${m.display} Slab`, 'slab', 2, 3));
  BLOCK_DEFS.push(partial(STAIRS_FIRST + i, `${m.name}_stairs`, `${m.display} Stairs`, 'stairs', base.hardness, 7));
});

// ---- Dye families: one grey texture, tinted per vertex with the colour in the state ----
const dyed = (id: number, name: string, noun: string, tex: string, hardness: number, sound: BlockSound, extra: Partial<BlockDef> = {}): BlockDef =>
  cube(id, name, noun, { all: tex }, hardness, sound, { dye: true, variant: dyeVariant(noun), ...extra });
BLOCK_DEFS.push(
  dyed(B.CONCRETE, 'concrete', 'Concrete', 'white_concrete', 1.8, 'stone', { tool: 'pickaxe', minTier: 0 }),
  dyed(B.STAINED_TERRACOTTA, 'stained_terracotta', 'Terracotta', 'dyed_terracotta', 1.25, 'stone', { tool: 'pickaxe', minTier: 0 }),
  dyed(B.GLAZED_TERRACOTTA, 'glazed_terracotta', 'Glazed Terracotta', 'dyed_glazed_terracotta', 1.4, 'stone', { tool: 'pickaxe', minTier: 0 }),
  dyed(B.STAINED_GLASS, 'stained_glass', 'Stained Glass', 'white_stained_glass', 0.3, 'glass', { transparent: true, cullSelf: true }),
);

// ---- Cubes and plants from the content table (Content.ts) ----
export const CUBE_ID: Record<string, number> = {};
CUBES.forEach((spec, i) => {
  const id = CUBE_FIRST + i;
  CUBE_ID[spec.name] = id;
  const display = spec.display ?? titleCase(spec.name);
  const t = spec.tex;
  const tex: BlockTextures = !t ? { all: spec.name } : typeof t === 'string' ? { all: t } : { top: t[0], side: t[1], bottom: t[2] ?? t[0] };
  if (spec.front) tex.front = spec.front;
  const mining = { tool: spec.tool, minTier: spec.minTier };
  if (spec.kind === 'plant') {
    BLOCK_DEFS.push({ ...plant(id, spec.name, display, spec.name), ...mining });
  } else if (spec.kind === 'cobweb') {
    BLOCK_DEFS.push({ ...plant(id, spec.name, display, spec.name), sway: false, hardness: spec.hardness, ...mining });
  } else {
    const extra: Partial<BlockDef> = { ...mining };
    if (spec.kind === 'leaves') Object.assign(extra, { transparent: true, lightFilter: 1, sway: true, tint: TINT_FOLIAGE });
    if (spec.kind === 'cherry_leaves') Object.assign(extra, { transparent: true, lightFilter: 1, sway: true });
    if (spec.light) extra.light = spec.light;
    if (spec.front) extra.facing = true;
    BLOCK_DEFS.push(cube(id, spec.name, display, tex, spec.hardness, spec.sound, extra));
  }
});

/** Block id of a name from the content tables ('granite', 'jungle_log', ...); throws for a typo. */
export function blockId(name: string): number {
  const id = CUBE_ID[name];
  if (id === undefined) throw new Error(`Unknown block ${name}`);
  return id;
}

// ---- Saplings: one block id, the wood is the state ----
const SAPLING_WOODS = WOODS.filter((w) => w.name !== 'mangrove');
BLOCK_DEFS.push({
  ...plant(B.SAPLING, 'sapling', 'Sapling', 'oak_sapling'),
  variant: {
    shift: 0, count: SAPLING_WOODS.length,
    names: SAPLING_WOODS.map((w) => `${w.display} Sapling`),
    textures: SAPLING_WOODS.map((w) => ({ all: `${w.name}_sapling` })),
  },
});

// ---- Slabs and stairs of the other materials: one block id each, the material is in the state ----
const baseDefOf = (name: string): BlockDef => {
  const d = BLOCK_DEFS.find((x) => x.name === name);
  if (!d) throw new Error(`Unknown partial base ${name}`);
  return d;
};
BLOCK_DEFS.push(
  extPartial(B.SLAB_X, 'slab', 'Slab', 'slab', 2, 2, 3, 0x7f),
  extPartial(B.STAIRS_X, 'stairs', 'Stairs', 'stairs', 3, 0, 7, 0xff),
);
function extPartial(id: number, name: string, noun: string, shape: RenderShape, shift: number, slabHardness: number, stateBits: number, metaMask: number): BlockDef {
  const bases = PARTIAL_EXT.map((m) => baseDefOf(m.base));
  return {
    id, name, displayName: noun, shape, solid: true, transparent: true, hardness: 2, sound: 'stone', inInventory: true,
    textures: bases[0].textures, lightStop: true, metaMask: metaMask | stateBits,
    variant: {
      shift, count: PARTIAL_EXT.length, names: PARTIAL_EXT.map((m) => `${m.display} ${noun}`),
      textures: bases.map((b) => b.textures),
      sounds: bases.map((b) => b.sound),
      // A slab is 2.0 hard whatever it is made of; stairs are as hard as the block.
      mining: bases.map((b) => ({ hardness: slabHardness || b.hardness, tool: b.tool, minTier: b.minTier })),
    },
  };
}
void CUBE_FIRST;

// ---- Thin and connecting blocks (BoxShapes) and the other functional blocks ----
const woodVariant = (shift: number, noun: string): VariantSpec => ({
  shift, count: WOODS.length, names: WOODS.map((w) => `${w.display} ${noun}`),
  textures: WOODS.map((w) => ({ all: `${w.name}_planks` })),
  sounds: WOODS.map(() => 'wood' as BlockSound),
});
const wallBases = WALL_MATERIALS.map((m) => baseDefOf(m.base));
const box = (id: number, name: string, display: string, kind: number, textures: BlockTextures, extra: Partial<BlockDef> = {}): BlockDef => ({
  id, name, displayName: display, shape: 'box', boxKind: kind, solid: true, transparent: true, hardness: 0.5, sound: 'wood', inInventory: true,
  textures, ...extra,
});
BLOCK_DEFS.push(
  box(B.CARPET, 'carpet', 'Carpet', BOX_CARPET, { all: 'white_wool' }, { dye: true, variant: dyeVariant('Carpet'), sound: 'wool', hardness: 0.1 }),
  box(B.BED, 'bed', 'Bed', BOX_BED, { top: 'bed_foot_top', bottom: 'bed_head_top', side: 'bed_side' }, {
    dye: true, variant: { shift: 3, count: 16, names: DYES.map((d) => `${d.display} Bed`) }, hardness: 0.2, metaMask: 0x7f,
  }),
  box(B.GLASS_PANE, 'glass_pane', 'Glass Pane', BOX_PANE, { all: 'glass' }, { sound: 'glass', hardness: 0.3 }),
  box(B.STAINED_GLASS_PANE, 'stained_glass_pane', 'Stained Glass Pane', BOX_PANE, { all: 'white_stained_glass' }, {
    dye: true, variant: dyeVariant('Stained Glass Pane'), sound: 'glass', hardness: 0.3,
  }),
  box(B.IRON_BARS, 'iron_bars', 'Iron Bars', BOX_PANE, { all: 'iron_bars' }, { sound: 'metal', hardness: 5, tool: 'pickaxe', minTier: 0 }),
  box(B.TRAPDOOR, 'trapdoor', 'Trapdoor', BOX_TRAPDOOR, { all: 'oak_planks' }, {
    variant: woodVariant(4, 'Trapdoor'), hardness: 3, tool: 'axe', metaMask: 0xff,
  }),
  box(B.FENCE, 'fence', 'Fence', BOX_FENCE, { all: 'oak_planks' }, { variant: woodVariant(0, 'Fence'), hardness: 2, tool: 'axe' }),
  box(B.FENCE_GATE, 'fence_gate', 'Fence Gate', BOX_GATE, { all: 'oak_planks' }, {
    variant: woodVariant(3, 'Fence Gate'), hardness: 2, tool: 'axe', metaMask: 0x3f,
  }),
  box(B.WALL, 'wall', 'Wall', BOX_WALL, wallBases[0].textures, {
    variant: {
      shift: 0, count: WALL_MATERIALS.length, names: WALL_MATERIALS.map((m) => `${m.display} Wall`),
      textures: wallBases.map((b) => b.textures), sounds: wallBases.map((b) => b.sound),
      mining: wallBases.map(() => ({ hardness: 2, tool: 'pickaxe' as MineTool, minTier: 0 })),
    },
    sound: 'stone', hardness: 2, tool: 'pickaxe', minTier: 0,
  }),
  box(B.LADDER, 'ladder', 'Ladder', BOX_LADDER, { all: 'ladder' }, { solid: false, hardness: 0.4, metaMask: 3, sound: 'ladder' }),
  cube(B.CHEST, 'chest', 'Chest', { top: 'chest_top', bottom: 'chest_top', side: 'chest_side', front: 'chest_front' }, 2.5, 'wood', { facing: true, tool: 'axe' }),
  {
    id: B.LANTERN, name: 'lantern', displayName: 'Lantern', shape: 'model', solid: false, transparent: true, hardness: 3.5, sound: 'metal',
    light: 15, inInventory: true, textures: { all: 'lantern' }, model: [[5, 0, 5, 11, 7, 11], [6, 7, 6, 10, 9, 10]], tool: 'pickaxe', minTier: 0,
  },
);

// ---- Redstone: dust, sources, repeater, lamp, note block and pistons (behaviour in Redstone.ts) ----
const stoneOak = (shift: number, noun: string): VariantSpec => ({
  shift, count: 2, names: [`Stone ${noun}`, `Oak ${noun}`],
  textures: [{ all: 'stone' }, { all: 'oak_planks' }], sounds: ['stone', 'wood'],
});
BLOCK_DEFS.push(
  box(B.REDSTONE_WIRE, 'redstone_wire', 'Redstone Dust', BOX_DUST, { all: 'redstone_dust' }, {
    solid: false, hardness: 0, sound: 'stone', metaMask: 15, inInventory: false,
  }),
  box(B.LEVER, 'lever', 'Lever', BOX_LEVER, { all: 'cobblestone', front: 'lever' }, { solid: false, hardness: 0.5, sound: 'stone', metaMask: 15 }),
  box(B.BUTTON, 'button', 'Button', BOX_BUTTON, { all: 'stone' }, {
    solid: false, hardness: 0.5, sound: 'stone', metaMask: 0x1f, variant: stoneOak(4, 'Button'),
  }),
  box(B.PRESSURE_PLATE, 'pressure_plate', 'Pressure Plate', BOX_PLATE, { all: 'stone' }, {
    solid: false, hardness: 0.5, sound: 'stone', metaMask: 3, variant: stoneOak(1, 'Pressure Plate'),
  }),
  box(B.REPEATER, 'repeater', 'Redstone Repeater', BOX_REPEATER, { top: 'repeater', bottom: 'repeater_on', side: 'smooth_stone', front: 'redstone_torch' }, {
    hardness: 0, sound: 'stone', metaMask: 0x1f,
  }),
  box(B.REDSTONE_TORCH, 'redstone_torch', 'Redstone Torch', BOX_RTORCH, { all: 'redstone_torch', front: 'redstone_torch_off' }, {
    solid: false, hardness: 0, sound: 'wood', metaMask: 15, light: 7,
  }),
  cube(B.REDSTONE_LAMP, 'redstone_lamp', 'Redstone Lamp', { all: 'redstone_lamp' }, 0.3, 'glass'),
  cube(B.REDSTONE_LAMP_LIT, 'redstone_lamp_lit', 'Redstone Lamp', { all: 'redstone_lamp_on' }, 0.3, 'glass', { light: 15, inInventory: false }),
  cube(B.NOTE_BLOCK, 'note_block', 'Note Block', { all: 'note_block' }, 0.8, 'wood', { tool: 'axe', metaMask: 0x3f }),
  box(B.PISTON, 'piston', 'Piston', BOX_PISTON, { top: 'piston_top', bottom: 'piston_bottom', side: 'piston_side', front: 'piston_inner' }, {
    hardness: 1.5, sound: 'stone', metaMask: 15,
  }),
  box(B.STICKY_PISTON, 'sticky_piston', 'Sticky Piston', BOX_PISTON, { top: 'piston_top_sticky', bottom: 'piston_bottom', side: 'piston_side', front: 'piston_inner' }, {
    hardness: 1.5, sound: 'stone', metaMask: 15,
  }),
  box(B.PISTON_HEAD, 'piston_head', 'Piston Head', BOX_PISTON_HEAD, { top: 'piston_top', bottom: 'piston_bottom', side: 'piston_side', front: 'piston_side' }, {
    hardness: 1.5, sound: 'stone', metaMask: 15, inInventory: false,
  }),
);

BLOCK_DEFS.sort((a, b) => a.id - b.id);

/** Extra texture layers that are not tied to a block face (crack overlay stages). */
export const DESTROY_STAGES = 10;
const EXTRA_TEXTURES = Array.from({ length: DESTROY_STAGES }, (_, i) => `destroy_${i}`);

/** Texture array layers, in a deterministic order shared by main thread and workers. */
export const TEXTURE_NAMES: string[] = (() => {
  const names: string[] = [];
  const add = (n: string | undefined) => {
    if (n && !names.includes(n)) names.push(n);
  };
  for (const def of BLOCK_DEFS) {
    const t = def.textures;
    add(t.all); add(t.top); add(t.side); add(t.bottom); add(t.front);
    for (const vt of def.variant?.textures ?? []) { add(vt.all); add(vt.top); add(vt.side); add(vt.bottom); add(vt.front); }
  }
  EXTRA_TEXTURES.forEach(add);
  return names;
})();

export function textureLayer(name: string): number {
  const i = TEXTURE_NAMES.indexOf(name);
  if (i < 0) throw new Error(`Unknown texture ${name}`);
  return i;
}

// ---- Flat lookup tables for hot loops (mesher, lighting, physics) ----
export const SHAPE_NONE = 0;
export const SHAPE_CUBE = 1;
export const SHAPE_CROSS = 2;
export const SHAPE_LIQUID = 3;
export const SHAPE_MODEL = 4;
export const SHAPE_SLAB = 5;
export const SHAPE_STAIRS = 6;
export const SHAPE_DOOR = 7;
export const SHAPE_BOX = 8;

export const SHAPE = new Uint8Array(256);
export const SOLID = new Uint8Array(256);
/** Blocks whose geometry depends on their state byte: slabs, stairs and doors (see BlockShapes). */
export const PARTIAL = new Uint8Array(256);
/** Fully opaque cube: blocks light, hides neighbour faces, casts AO. */
export const OPAQUE = new Uint8Array(256);
export const CULL_SELF = new Uint8Array(256);
export const LIGHT_FILTER = new Uint8Array(256);
export const LIGHT_EMIT = new Uint8Array(256);
/** Cells that receive light but do not pass it on (see BlockDef.lightStop). */
export const LIGHT_STOP = new Uint8Array(256);
export const SWAY = new Uint8Array(256);
/** Biome tint type per block (TINT_* in BiomeColors). */
export const TINT = new Uint8Array(256);
/** Allowed state bits per block (0 = the block has no states). */
export const META_MASK = new Uint8Array(256);
/** Texture layer per face: FACE_LAYER[id * 6 + face]. */
export const FACE_LAYER = new Uint8Array(256 * 6);
/** Blocks tinted with the dye colour in the low 4 bits of their state, and the 16 colours (0xRRGGBB). */
export const DYE = new Uint8Array(256);
export const DYE_RGB = new Int32Array(16);
DYES.forEach((d, i) => { DYE_RGB[i] = d.rgb; });
/** Blocks whose "front" texture turns with state bits 0-1; FRONT_FACE[meta & 3] is the face index it is on. */
export const FACING = new Uint8Array(256);
/** Box kind per block (BOX_* in BoxShapes; 0 = not a box block) and which of them are taller than one block. */
export const BOX_KIND = new Uint8Array(256);
export const TALL = new Uint8Array(256);
export const FRONT_FACE = [4, 5, 0, 1] as const;
/**
 * State bits that belong to the item of a block (colour, wood, material): the item of a placed block keeps them,
 * the rest (direction, open, half) comes from how it is placed. 0 = no variants.
 */
export const VARIANT_MASK = new Uint8Array(256);
/** Blocks whose variants have their own textures: VARIANT_SLOT[id] (0 = none) indexes VARIANT_LAYER. */
export const VARIANT_SLOT = new Uint8Array(256);
export const VARIANT_SHIFT = new Uint8Array(256);
/** Texture layer of variant v and face f of slot k: VARIANT_LAYER[(k * 32 + v) * 6 + f]. */
export const VARIANT_LAYER = new Uint8Array(64 * 32 * 6);

const blockById: (BlockDef | undefined)[] = [];
let variantSlots = 0;

for (const def of BLOCK_DEFS) {
  const id = def.id;
  blockById[id] = def;
  SHAPE[id] = def.shape === 'cube' ? SHAPE_CUBE : def.shape === 'cross' ? SHAPE_CROSS : def.shape === 'liquid' ? SHAPE_LIQUID
    : def.shape === 'model' ? SHAPE_MODEL : def.shape === 'slab' ? SHAPE_SLAB : def.shape === 'stairs' ? SHAPE_STAIRS
    : def.shape === 'door' ? SHAPE_DOOR : def.shape === 'box' ? SHAPE_BOX : SHAPE_NONE;
  PARTIAL[id] = SHAPE[id] >= SHAPE_SLAB ? 1 : 0;
  SOLID[id] = def.solid ? 1 : 0;
  OPAQUE[id] = def.shape === 'cube' && !def.transparent ? 1 : 0;
  CULL_SELF[id] = def.cullSelf ? 1 : 0;
  LIGHT_FILTER[id] = def.lightFilter ?? 0;
  LIGHT_EMIT[id] = def.light ?? 0;
  LIGHT_STOP[id] = def.lightStop ? 1 : 0;
  SWAY[id] = def.sway ? 1 : 0;
  DYE[id] = def.dye ? 1 : 0;
  BOX_KIND[id] = def.boxKind ?? BOX_NONE;
  TALL[id] = def.boxKind && isTall(def.boxKind) ? 1 : 0;
  FACING[id] = def.facing ? 1 : 0;
  const v = def.variant;
  const variantBits = v ? ((1 << Math.ceil(Math.log2(Math.max(2, v.count)))) - 1) << v.shift : 0;
  VARIANT_MASK[id] = variantBits;
  META_MASK[id] = def.metaMask ?? (variantBits | (def.facing ? 3 : 0));
  if (v?.textures) {
    const slot = ++variantSlots;
    VARIANT_SLOT[id] = slot;
    VARIANT_SHIFT[id] = v.shift;
    v.textures.forEach((t, k) => {
      const side = t.side ?? t.all;
      const faces = [side, side, t.top ?? t.all, t.bottom ?? t.all, t.front ?? side, side];
      for (let f = 0; f < 6; f++) VARIANT_LAYER[(slot * 32 + k) * 6 + f] = faces[f] ? textureLayer(faces[f]!) : 0;
    });
  }
  TINT[id] = def.tint ?? TINT_NONE;
  const t = def.textures;
  const side = t.side ?? t.all;
  const faces = [side, side, t.top ?? t.all, t.bottom ?? t.all, t.front ?? side, side];
  for (let f = 0; f < 6; f++) {
    const name = faces[f];
    FACE_LAYER[id * 6 + f] = name ? textureLayer(name) : 0;
  }
}

// Unloaded chunks behave like solid stone so the player never falls into the void.
SOLID[BLOCK.UNLOADED] = 1;
OPAQUE[BLOCK.UNLOADED] = 1;

/**
 * Sky light going down a column, in one lookup per cell: the light filter (0..2), 254 for a cell that receives
 * light but stops it (slabs, stairs), 255 for opaque blocks.
 */
export const LIGHT_COLUMN = new Uint8Array(256);
for (let id = 0; id < 256; id++) LIGHT_COLUMN[id] = OPAQUE[id] ? 255 : LIGHT_STOP[id] ? 254 : LIGHT_FILTER[id];

/**
 * Textures that are converted to greyscale for biome tinting. "full" tints every pixel,
 * "mask" only the green overlay (grass block side: the dirt part stays untinted).
 */
export const TINTED_TEXTURES: Record<string, { type: number; mode: 'full' | 'mask'; opaque: boolean }> = {
  grass_top: { type: TINT_GRASS, mode: 'full', opaque: true },
  grass_side: { type: TINT_GRASS, mode: 'mask', opaque: true },
  tall_grass: { type: TINT_GRASS, mode: 'full', opaque: false },
  oak_leaves: { type: TINT_FOLIAGE, mode: 'full', opaque: false },
  birch_leaves: { type: TINT_BIRCH, mode: 'full', opaque: false },
  spruce_leaves: { type: TINT_SPRUCE, mode: 'full', opaque: false },
  jungle_leaves: { type: TINT_FOLIAGE, mode: 'full', opaque: false },
  acacia_leaves: { type: TINT_FOLIAGE, mode: 'full', opaque: false },
  dark_oak_leaves: { type: TINT_FOLIAGE, mode: 'full', opaque: false },
  mangrove_leaves: { type: TINT_FOLIAGE, mode: 'full', opaque: false },
};

/**
 * Greyscale base textures of the dye families. Opaque ones get alpha 128 on every pixel, which the opaque shader
 * reads as "multiply by the vertex tint"; glass is alpha tested and always multiplied.
 */
export const DYED_TEXTURES: Record<string, { opaque: boolean }> = {
  white_wool: { opaque: true },
  white_concrete: { opaque: true },
  dyed_terracotta: { opaque: true },
  dyed_glazed_terracotta: { opaque: true },
  white_stained_glass: { opaque: false },
};

/** Model boxes per block id (shape "model"). */
export const MODELS: (number[][] | undefined)[] = [];
for (const def of BLOCK_DEFS) if (def.model) MODELS[def.id] = def.model;

/** Texture names of a block in a given state: the variant's own textures where it has them (saplings, doors), else the block's. */
export function stateTextures(def: BlockDef, meta: number): BlockTextures {
  const v = def.variant;
  return v?.textures?.[(meta >> v.shift) & 31] ?? def.textures;
}

/** Sound of a block in a given state (a wooden slab sounds like wood even though slabs share one id). */
export function stateSound(def: BlockDef, meta: number): BlockSound {
  const v = def.variant;
  return v?.sounds?.[(meta >> v.shift) & 31] ?? def.sound;
}

export function getBlockDef(id: number): BlockDef | undefined {
  return blockById[id];
}

export const INVENTORY_BLOCKS: number[] = BLOCK_DEFS.filter((d) => d.inInventory).map((d) => d.id);
