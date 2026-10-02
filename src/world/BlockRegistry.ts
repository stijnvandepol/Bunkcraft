import { TINT_BIRCH, TINT_FOLIAGE, TINT_GRASS, TINT_NONE, TINT_SPRUCE } from './BiomeColors';

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
export type RenderShape = 'none' | 'cube' | 'cross' | 'liquid' | 'model' | 'slab' | 'stairs' | 'door';
export type BlockSound = 'stone' | 'wood' | 'grass' | 'gravel' | 'sand' | 'glass' | 'wool' | 'snow';

export interface BlockTextures {
  all?: string;
  top?: string;
  bottom?: string;
  side?: string;
  /** Texture of the +Z face (furnace mouth); blocks have no facing state yet. */
  front?: string;
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
  OAK_DOOR: 66,
  /** Sentinel returned for blocks in chunks that are not loaded (treated as solid). */
  UNLOADED: 255,
} as const;

const B = BLOCK;

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
  cube(B.DIRT, 'dirt', 'Dirt', { all: 'dirt' }, 0.4, 'gravel'),
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
  cube(B.WHITE_WOOL, 'white_wool', 'White Wool', { all: 'white_wool' }, 0.4, 'wool'),
  cube(B.CLAY, 'clay', 'Clay', { all: 'clay' }, 0.45, 'gravel'),
  cube(B.OBSIDIAN, 'obsidian', 'Obsidian', { all: 'obsidian' }, 3.0, 'stone'),
  cube(B.BOOKSHELF, 'bookshelf', 'Bookshelf', { top: 'oak_planks', bottom: 'oak_planks', side: 'bookshelf' }, 0.8, 'wood'),
  cube(B.MOSSY_COBBLESTONE, 'mossy_cobblestone', 'Mossy Cobblestone', { all: 'mossy_cobblestone' }, 1.2, 'stone'),
  cube(B.SNOW, 'snow_block', 'Snow Block', { all: 'snow' }, 0.3, 'snow'),
  cube(B.BIRCH_PLANKS, 'birch_planks', 'Birch Planks', { all: 'birch_planks' }, 0.8, 'wood'),
  cube(B.SPRUCE_PLANKS, 'spruce_planks', 'Spruce Planks', { all: 'spruce_planks' }, 0.8, 'wood'),
  cube(B.RED_WOOL, 'red_wool', 'Red Wool', { all: 'red_wool' }, 0.4, 'wool'),
  cube(B.BLUE_WOOL, 'blue_wool', 'Blue Wool', { all: 'blue_wool' }, 0.4, 'wool'),
  cube(B.YELLOW_WOOL, 'yellow_wool', 'Yellow Wool', { all: 'yellow_wool' }, 0.4, 'wool'),
  cube(B.GREEN_WOOL, 'green_wool', 'Green Wool', { all: 'green_wool' }, 0.4, 'wool'),
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
  cube(B.FURNACE, 'furnace', 'Furnace', { top: 'furnace_top', bottom: 'furnace_top', side: 'furnace_side', front: 'furnace_front' }, 1.2, 'stone'),
  cube(B.TNT, 'tnt', 'TNT', { top: 'tnt_top', bottom: 'tnt_bottom', side: 'tnt_side' }, 0, 'grass'),
];

// Oak door: the lower half uses the "side" texture slot and the upper half the "top" slot.
BLOCK_DEFS.push({
  id: B.OAK_DOOR, name: 'oak_door', displayName: 'Oak Door', shape: 'door', solid: true, transparent: true, hardness: 3, sound: 'wood',
  inInventory: true, textures: { side: 'oak_door_lower', top: 'oak_door_upper' }, metaMask: 31,
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

const blockById: (BlockDef | undefined)[] = [];

for (const def of BLOCK_DEFS) {
  const id = def.id;
  blockById[id] = def;
  SHAPE[id] = def.shape === 'cube' ? SHAPE_CUBE : def.shape === 'cross' ? SHAPE_CROSS : def.shape === 'liquid' ? SHAPE_LIQUID
    : def.shape === 'model' ? SHAPE_MODEL : def.shape === 'slab' ? SHAPE_SLAB : def.shape === 'stairs' ? SHAPE_STAIRS
    : def.shape === 'door' ? SHAPE_DOOR : SHAPE_NONE;
  PARTIAL[id] = SHAPE[id] >= SHAPE_SLAB ? 1 : 0;
  SOLID[id] = def.solid ? 1 : 0;
  OPAQUE[id] = def.shape === 'cube' && !def.transparent ? 1 : 0;
  CULL_SELF[id] = def.cullSelf ? 1 : 0;
  LIGHT_FILTER[id] = def.lightFilter ?? 0;
  LIGHT_EMIT[id] = def.light ?? 0;
  LIGHT_STOP[id] = def.lightStop ? 1 : 0;
  SWAY[id] = def.sway ? 1 : 0;
  META_MASK[id] = def.metaMask ?? 0;
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
};

/** Model boxes per block id (shape "model"). */
export const MODELS: (number[][] | undefined)[] = [];
for (const def of BLOCK_DEFS) if (def.model) MODELS[def.id] = def.model;

export function getBlockDef(id: number): BlockDef | undefined {
  return blockById[id];
}

export const INVENTORY_BLOCKS: number[] = BLOCK_DEFS.filter((d) => d.inInventory).map((d) => d.id);
