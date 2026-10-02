import { BLOCK, PARTIAL_MATERIALS, SLAB_FIRST, STAIRS_FIRST, getBlockDef } from '../world/BlockRegistry';
import { SLAB_DOUBLE } from '../world/BlockStates';

/**
 * Items. Ids below 256 are blocks (same id as the block); ids from 256 up are
 * non-block items (food, tools, materials). Values follow the Minecraft Wiki.
 */
export const ITEM = {
  PORKCHOP: 256,
  BEEF: 257,
  MUTTON: 258,
  CHICKEN: 259,
  ROTTEN_FLESH: 260,
  GUNPOWDER: 261,
  FEATHER: 262,
  COAL: 263,
  DIAMOND: 264,
  IRON_INGOT: 265,
  STICK: 266,
  GOLD_INGOT: 267,
  FLINT: 268,
  FLINT_AND_STEEL: 269,
  WOODEN_PICKAXE: 270,
  STONE_PICKAXE: 271,
  IRON_PICKAXE: 272,
  DIAMOND_PICKAXE: 273,
  WOODEN_AXE: 274,
  STONE_AXE: 275,
  IRON_AXE: 276,
  DIAMOND_AXE: 277,
  WOODEN_SHOVEL: 278,
  STONE_SHOVEL: 279,
  IRON_SHOVEL: 280,
  DIAMOND_SHOVEL: 281,
  WOODEN_SWORD: 282,
  STONE_SWORD: 283,
  IRON_SWORD: 284,
  DIAMOND_SWORD: 285,
  COOKED_PORKCHOP: 290,
  STEAK: 291,
  COOKED_MUTTON: 292,
  COOKED_CHICKEN: 293,
  GOLDEN_PICKAXE: 294,
  GOLDEN_AXE: 295,
  GOLDEN_SHOVEL: 296,
  GOLDEN_SWORD: 297,
  BONE: 298,
  ARROW: 299,
  BOW: 300,
  STRING: 301,
  SPIDER_EYE: 302,
} as const;

export type ToolKind = 'pickaxe' | 'axe' | 'shovel' | 'sword';

export interface ToolInfo {
  kind: ToolKind;
  /** Harvest level: 0 wood/gold, 1 stone, 2 iron, 3 diamond */
  tier: number;
  speed: number;
  durability: number;
  damage: number;
}

export interface ItemDef {
  id: number;
  name: string;
  displayName: string;
  maxStack: number;
  /** `poison`: ticks of Poison I after eating (spider eye). */
  food?: { hunger: number; saturation: number; poison?: number };
  tool?: ToolInfo;
  /** Uses before breaking, for non-tool items that wear out (flint and steel). */
  durability?: number;
  /** Sprite painter key for non-block items (see ItemIcons). */
  sprite?: string;
}

export interface ItemStack {
  id: number;
  count: number;
  /** Damage taken by a tool. */
  damage?: number;
}

export const EMPTY: ItemStack = Object.freeze({ id: 0, count: 0 }) as ItemStack;

const TIERS = [
  { name: 'Wooden', speed: 2, durability: 59, damage: 0 },
  { name: 'Stone', speed: 4, durability: 131, damage: 1 },
  { name: 'Iron', speed: 6, durability: 250, damage: 2 },
  { name: 'Diamond', speed: 8, durability: 1561, damage: 3 },
];

const items = new Map<number, ItemDef>();

function add(def: ItemDef): void {
  items.set(def.id, def);
}

add({ id: ITEM.PORKCHOP, name: 'porkchop', displayName: 'Raw Porkchop', maxStack: 64, food: { hunger: 3, saturation: 1.8 }, sprite: 'meat_pink' });
add({ id: ITEM.BEEF, name: 'beef', displayName: 'Raw Beef', maxStack: 64, food: { hunger: 3, saturation: 1.8 }, sprite: 'meat_red' });
add({ id: ITEM.MUTTON, name: 'mutton', displayName: 'Raw Mutton', maxStack: 64, food: { hunger: 2, saturation: 1.2 }, sprite: 'meat_red' });
add({ id: ITEM.CHICKEN, name: 'chicken', displayName: 'Raw Chicken', maxStack: 64, food: { hunger: 2, saturation: 1.2 }, sprite: 'drumstick_raw' });
add({ id: ITEM.ROTTEN_FLESH, name: 'rotten_flesh', displayName: 'Rotten Flesh', maxStack: 64, food: { hunger: 4, saturation: 0.8 }, sprite: 'rotten' });
add({ id: ITEM.COOKED_PORKCHOP, name: 'cooked_porkchop', displayName: 'Cooked Porkchop', maxStack: 64, food: { hunger: 8, saturation: 12.8 }, sprite: 'meat_cooked' });
add({ id: ITEM.STEAK, name: 'steak', displayName: 'Steak', maxStack: 64, food: { hunger: 8, saturation: 12.8 }, sprite: 'meat_cooked' });
add({ id: ITEM.COOKED_MUTTON, name: 'cooked_mutton', displayName: 'Cooked Mutton', maxStack: 64, food: { hunger: 6, saturation: 9.6 }, sprite: 'meat_cooked' });
add({ id: ITEM.COOKED_CHICKEN, name: 'cooked_chicken', displayName: 'Cooked Chicken', maxStack: 64, food: { hunger: 6, saturation: 7.2 }, sprite: 'drumstick_cooked' });
add({ id: ITEM.GUNPOWDER, name: 'gunpowder', displayName: 'Gunpowder', maxStack: 64, sprite: 'gunpowder' });
add({ id: ITEM.FEATHER, name: 'feather', displayName: 'Feather', maxStack: 64, sprite: 'feather' });
add({ id: ITEM.COAL, name: 'coal', displayName: 'Coal', maxStack: 64, sprite: 'coal' });
add({ id: ITEM.DIAMOND, name: 'diamond', displayName: 'Diamond', maxStack: 64, sprite: 'diamond' });
add({ id: ITEM.IRON_INGOT, name: 'iron_ingot', displayName: 'Iron Ingot', maxStack: 64, sprite: 'ingot' });
add({ id: ITEM.STICK, name: 'stick', displayName: 'Stick', maxStack: 64, sprite: 'stick' });
add({ id: ITEM.GOLD_INGOT, name: 'gold_ingot', displayName: 'Gold Ingot', maxStack: 64, sprite: 'gold_ingot' });
add({ id: ITEM.FLINT, name: 'flint', displayName: 'Flint', maxStack: 64, sprite: 'flint' });
add({ id: ITEM.BONE, name: 'bone', displayName: 'Bone', maxStack: 64, sprite: 'bone' });
add({ id: ITEM.ARROW, name: 'arrow', displayName: 'Arrow', maxStack: 64, sprite: 'arrow' });
add({ id: ITEM.BOW, name: 'bow', displayName: 'Bow', maxStack: 1, durability: 384, sprite: 'bow' });
add({ id: ITEM.STRING, name: 'string', displayName: 'String', maxStack: 64, sprite: 'string' });
add({ id: ITEM.SPIDER_EYE, name: 'spider_eye', displayName: 'Spider Eye', maxStack: 64, food: { hunger: 2, saturation: 3.2, poison: 100 }, sprite: 'spider_eye' });
add({ id: ITEM.FLINT_AND_STEEL, name: 'flint_and_steel', displayName: 'Flint and Steel', maxStack: 1, durability: 64, sprite: 'flint_and_steel' });

const TOOL_BASE: Record<ToolKind, { id: number; damage: number }> = {
  pickaxe: { id: ITEM.WOODEN_PICKAXE, damage: 2 },
  axe: { id: ITEM.WOODEN_AXE, damage: 7 },
  shovel: { id: ITEM.WOODEN_SHOVEL, damage: 2.5 },
  sword: { id: ITEM.WOODEN_SWORD, damage: 4 },
};
for (const [kind, base] of Object.entries(TOOL_BASE) as [ToolKind, { id: number; damage: number }][]) {
  TIERS.forEach((t, tier) => {
    add({
      id: base.id + tier,
      name: `${t.name.toLowerCase()}_${kind}`,
      displayName: `${t.name} ${kind[0].toUpperCase()}${kind.slice(1)}`,
      maxStack: 1,
      sprite: `${kind}_${tier}`,
      tool: { kind, tier, speed: t.speed, durability: t.durability, damage: base.damage + t.damage },
    });
  });
  // Golden tools: fastest, but wood harvest level and very low durability (Minecraft values).
  add({
    id: ITEM.GOLDEN_PICKAXE + Object.keys(TOOL_BASE).indexOf(kind),
    name: `golden_${kind}`,
    displayName: `Golden ${kind[0].toUpperCase()}${kind.slice(1)}`,
    maxStack: 1,
    sprite: `${kind}_4`,
    tool: { kind, tier: 0, speed: 12, durability: 32, damage: base.damage },
  });
}

export function getItemDef(id: number): ItemDef | undefined {
  if (id <= 0) return undefined;
  if (id < 256) {
    const b = getBlockDef(id);
    return b ? { id, name: b.name, displayName: b.displayName, maxStack: 64 } : undefined;
  }
  return items.get(id);
}

/** Uses before the item breaks (tools, flint and steel); 0 = does not wear out. */
export function maxDurability(id: number): number {
  const def = getItemDef(id);
  return def?.tool?.durability ?? def?.durability ?? 0;
}

export function itemName(id: number): string {
  return getItemDef(id)?.displayName ?? '';
}

export function isBlockItem(id: number): boolean {
  return id > 0 && id < 256;
}

export const ALL_ITEMS: number[] = [...items.keys()];

// ---------------------------------------------------------------- breaking & drops

/** Minecraft block hardness and the tool that mines it fastest. */
interface Mining { hardness: number; tool?: ToolKind; minTier?: number }

const B = BLOCK;
const MINING: Record<number, Mining> = {
  [B.STONE]: { hardness: 1.5, tool: 'pickaxe', minTier: 0 },
  [B.COBBLESTONE]: { hardness: 2, tool: 'pickaxe', minTier: 0 },
  [B.MOSSY_COBBLESTONE]: { hardness: 2, tool: 'pickaxe', minTier: 0 },
  [B.STONE_BRICKS]: { hardness: 1.5, tool: 'pickaxe', minTier: 0 },
  [B.BRICKS]: { hardness: 2, tool: 'pickaxe', minTier: 0 },
  [B.SANDSTONE]: { hardness: 0.8, tool: 'pickaxe', minTier: 0 },
  [B.COAL_ORE]: { hardness: 3, tool: 'pickaxe', minTier: 0 },
  [B.IRON_ORE]: { hardness: 3, tool: 'pickaxe', minTier: 1 },
  [B.GOLD_ORE]: { hardness: 3, tool: 'pickaxe', minTier: 2 },
  [B.DIAMOND_ORE]: { hardness: 3, tool: 'pickaxe', minTier: 2 },
  [B.OBSIDIAN]: { hardness: 50, tool: 'pickaxe', minTier: 3 },
  [B.FURNACE]: { hardness: 3.5, tool: 'pickaxe', minTier: 0 },
  [B.DIRT]: { hardness: 0.5, tool: 'shovel' },
  [B.GRASS]: { hardness: 0.6, tool: 'shovel' },
  [B.SNOWY_GRASS]: { hardness: 0.6, tool: 'shovel' },
  [B.SAND]: { hardness: 0.5, tool: 'shovel' },
  [B.GRAVEL]: { hardness: 0.6, tool: 'shovel' },
  [B.CLAY]: { hardness: 0.6, tool: 'shovel' },
  [B.SNOW]: { hardness: 0.2, tool: 'shovel' },
  [B.OAK_LOG]: { hardness: 2, tool: 'axe' },
  [B.BIRCH_LOG]: { hardness: 2, tool: 'axe' },
  [B.SPRUCE_LOG]: { hardness: 2, tool: 'axe' },
  [B.OAK_PLANKS]: { hardness: 2, tool: 'axe' },
  [B.BIRCH_PLANKS]: { hardness: 2, tool: 'axe' },
  [B.SPRUCE_PLANKS]: { hardness: 2, tool: 'axe' },
  [B.BOOKSHELF]: { hardness: 1.5, tool: 'axe' },
  [B.CRAFTING_TABLE]: { hardness: 2.5, tool: 'axe' },
  [B.OAK_LEAVES]: { hardness: 0.2 },
  [B.BIRCH_LEAVES]: { hardness: 0.2 },
  [B.SPRUCE_LEAVES]: { hardness: 0.2 },
  [B.GLASS]: { hardness: 0.3 },
  [B.GLOWSTONE]: { hardness: 0.3 },
  [B.CACTUS]: { hardness: 0.4 },
  [B.WHITE_WOOL]: { hardness: 0.8 },
  [B.RED_WOOL]: { hardness: 0.8 },
  [B.BLUE_WOOL]: { hardness: 0.8 },
  [B.YELLOW_WOOL]: { hardness: 0.8 },
  [B.GREEN_WOOL]: { hardness: 0.8 },
  [B.TNT]: { hardness: 0 },
};

// Slabs mine like their full block but are harder (2.0, Minecraft); stairs keep the hardness of the full block.
PARTIAL_MATERIALS.forEach((m, i) => {
  MINING[SLAB_FIRST + i] = { ...MINING[m.base], hardness: 2 };
  MINING[STAIRS_FIRST + i] = { ...MINING[m.base] };
});

/**
 * Survival break time in seconds (Minecraft formula): damage per tick is
 * speed / hardness / (canHarvest ? 30 : 100); ×5 slower in the air or under water.
 */
export function breakSeconds(blockId: number, held: number, onGround: boolean, inWater: boolean): number {
  const m = MINING[blockId];
  const hardness = m?.hardness ?? Math.max(0, getBlockDef(blockId)?.hardness ?? 1);
  if (hardness <= 0) return 0;
  const tool = getItemDef(held)?.tool;
  let speed = tool && m?.tool === tool.kind ? tool.speed : 1;
  if (!onGround) speed /= 5;
  if (inWater) speed /= 5;
  const perTick = speed / hardness / (canHarvest(blockId, held) ? 30 : 100);
  return Math.ceil(1 / perTick) / 20;
}

export function canHarvest(blockId: number, held: number): boolean {
  const m = MINING[blockId];
  if (!m || m.minTier === undefined) return true;
  const tool = getItemDef(held)?.tool;
  return !!tool && tool.kind === m.tool && tool.tier >= m.minTier;
}

/** What a block drops when mined in survival (0 = nothing). `meta` is the block state it had (a double slab drops two). */
export function blockDrop(blockId: number, held: number, meta = 0): ItemStack | null {
  if (!canHarvest(blockId, held)) return null;
  if (blockId >= SLAB_FIRST && blockId < STAIRS_FIRST) return { id: blockId, count: meta === SLAB_DOUBLE ? 2 : 1 };
  switch (blockId) {
    case B.GRASS: case B.SNOWY_GRASS: return { id: B.DIRT, count: 1 };
    case B.STONE: return { id: B.COBBLESTONE, count: 1 };
    case B.COAL_ORE: return { id: ITEM.COAL, count: 1 };
    case B.DIAMOND_ORE: return { id: ITEM.DIAMOND, count: 1 };
    // Gravel drops flint 10% of the time (no Fortune).
    case B.GRAVEL: return { id: Math.random() < 0.1 ? ITEM.FLINT : B.GRAVEL, count: 1 };
    case B.GLASS: case B.TALL_GRASS: case B.DEAD_BUSH: case B.WATER: case B.LAVA: case B.BEDROCK:
      return null;
    case B.OAK_LEAVES: case B.BIRCH_LEAVES: case B.SPRUCE_LEAVES:
      return Math.random() < 0.05 ? { id: ITEM.STICK, count: 1 } : null;
    default: return { id: blockId, count: 1 };
  }
}
