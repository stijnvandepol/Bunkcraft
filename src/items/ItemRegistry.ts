import { BLOCK, BLOCK_DEFS, CUBE_ID, PARTIAL_MATERIALS, SLAB_FIRST, STAIRS_FIRST, VARIANT_MASK, getBlockDef } from '../world/BlockRegistry';
import { SLAB_DOUBLE } from '../world/BlockStates';
import {
  ARMOR_BASE_DURABILITY, ARMOR_FIRST, ARMOR_MATERIALS, ARMOR_SLOT_NAMES, FOODS, FOOD_FIRST, HOE_FIRST, MATERIALS, MATERIAL_FIRST,
  SHEARS, type ItemSpec, armorItemId,
} from './ItemContent';

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
  BUCKET: 303,
  WATER_BUCKET: 304,
  LAVA_BUCKET: 305,
  WOODEN_HOE: HOE_FIRST,
  STONE_HOE: HOE_FIRST + 1,
  IRON_HOE: HOE_FIRST + 2,
  DIAMOND_HOE: HOE_FIRST + 3,
  GOLDEN_HOE: HOE_FIRST + 4,
  SHEARS,
} as const;

// ---------------------------------------------------------------- item identity (see docs/CONTENT.md)

/** First id of the variant-block items: `VARIANT_ITEM_BASE + blockId + (meta << 8)`. */
export const VARIANT_ITEM_BASE = 1024;

/** The item of a placed block: block ids below 256 for the plain block, a variant id when the state has variant bits. */
export function itemFromState(block: number, meta: number): number {
  const m = meta & VARIANT_MASK[block];
  return m ? VARIANT_ITEM_BASE + block + (m << 8) : block;
}

/** Block id a block item places (0 for non-block items). */
export function itemBlock(item: number): number {
  if (item >= VARIANT_ITEM_BASE) return (item - VARIANT_ITEM_BASE) & 255;
  return item > 0 && item < 256 ? item : 0;
}

/** State bits a block item carries (colour, material). */
export function itemMeta(item: number): number {
  return item >= VARIANT_ITEM_BASE ? ((item - VARIANT_ITEM_BASE) >> 8) & 255 : 0;
}

/** Old items that became variants of a new block: the four coloured wools that had their own ids. */
export const LEGACY_ITEMS: Record<number, number> = {
  [BLOCK.RED_WOOL]: itemFromState(BLOCK.WOOL, 14),
  [BLOCK.BLUE_WOOL]: itemFromState(BLOCK.WOOL, 11),
  [BLOCK.YELLOW_WOOL]: itemFromState(BLOCK.WOOL, 4),
  [BLOCK.GREEN_WOOL]: itemFromState(BLOCK.WOOL, 13),
};

export function normalizeItem(id: number): number {
  return LEGACY_ITEMS[id] ?? id;
}

export type ToolKind = 'pickaxe' | 'axe' | 'shovel' | 'sword' | 'hoe' | 'shears';

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
  food?: { hunger: number; saturation: number; poison?: number; returns?: string };
  tool?: ToolInfo;
  /** Uses before breaking, for non-tool items that wear out (flint and steel). */
  durability?: number;
  /** Sprite painter key for non-block items (see ItemIcons). */
  sprite?: string;
  /** Armor piece: slot 0 helmet .. 3 boots. */
  armor?: { slot: number; points: number; toughness: number; material: number };
}

export interface ItemStack {
  id: number;
  count: number;
  /** Damage taken by a tool. */
  damage?: number;
  /**
   * Per-stack data such as enchantments (`{ sharpness: 3 }`). Keys must be in ITEM_DATA_KEYS so a stack can be
   * saved and sent over the network; stacks with different data never merge. Absent for ordinary items.
   */
  data?: Record<string, number>;
}

/**
 * Names of the per-stack data entries, as they are stored: a stack is saved as `[id, count, damage, key, value, key, value, ...]`
 * with `key` the index in this list. APPEND-ONLY, like the other id tables.
 */
export const ITEM_DATA_KEYS: readonly string[] = [
  'sharpness', 'smite', 'bane_of_arthropods', 'knockback', 'fire_aspect', 'looting', 'efficiency', 'fortune', 'silk_touch', 'unbreaking',
  'mending', 'protection', 'fire_protection', 'blast_protection', 'projectile_protection', 'feather_falling', 'thorns', 'respiration',
  'aqua_affinity', 'depth_strider', 'power', 'punch', 'flame', 'infinity', 'repair_cost', 'custom_name',
];

/** `[keyIndex, value, ...]` for the data of a stack, undefined when it has none (or only keys that cannot be saved). */
export function encodeData(data: Record<string, number> | undefined): number[] | undefined {
  if (!data) return undefined;
  const out: number[] = [];
  for (const [k, v] of Object.entries(data)) {
    const i = ITEM_DATA_KEYS.indexOf(k);
    if (i >= 0 && Number.isFinite(v)) out.push(i, v);
  }
  return out.length ? out : undefined;
}

/** Inverse of encodeData; unknown key indices are dropped. */
export function decodeData(flat: ArrayLike<number> | undefined): Record<string, number> | undefined {
  if (!flat || flat.length < 2) return undefined;
  let out: Record<string, number> | undefined;
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const key = ITEM_DATA_KEYS[flat[i]];
    if (key !== undefined && Number.isFinite(flat[i + 1])) (out ??= {})[key] = flat[i + 1];
  }
  return out;
}

export function sameData(a: Record<string, number> | undefined, b: Record<string, number> | undefined): boolean {
  if (a === b) return true;
  const ka = a ? Object.keys(a) : [], kb = b ? Object.keys(b) : [];
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!b || a![k] !== b[k]) return false;
  return true;
}

/** Same item and same per-stack data: the condition for two stacks to merge. */
export function sameItem(a: ItemStack, b: ItemStack): boolean {
  return a.id === b.id && sameData(a.data, b.data);
}

/** Saved form of a stack: `[id, count, damage, ...data]`. */
export function stackToArray(s: ItemStack): number[] {
  const d = encodeData(s.data);
  return d ? [s.id, s.count, s.damage ?? 0, ...d] : [s.id, s.count, s.damage ?? 0];
}

/** Stack from its saved form (old 3-entry records included); null for an empty or invalid record. */
export function stackFromArray(d: ArrayLike<number> | undefined | null): ItemStack | null {
  if (!d || !(d[0] > 0) || !(d[1] > 0)) return null;
  const stack: ItemStack = { id: normalizeItem(d[0]), count: d[1] };
  if (d[2]) stack.damage = d[2];
  if (d.length > 3) {
    const data = decodeData(Array.prototype.slice.call(d, 3));
    if (data) stack.data = data;
  }
  return stack;
}

/** Copy of a stack that shares nothing with the original. */
export function cloneStack(s: ItemStack): ItemStack {
  const c: ItemStack = { id: s.id, count: s.count };
  if (s.damage) c.damage = s.damage;
  if (s.data) c.data = { ...s.data };
  return c;
}

export const EMPTY: ItemStack = Object.freeze({ id: 0, count: 0 }) as ItemStack;

/** Material tiers: mining speed, durability, harvest level (gold: fastest, weakest, wood level). */
const TIERS = [
  { name: 'Wooden', speed: 2, durability: 59, level: 0 },
  { name: 'Stone', speed: 4, durability: 131, level: 1 },
  { name: 'Iron', speed: 6, durability: 250, level: 2 },
  { name: 'Diamond', speed: 8, durability: 1561, level: 3 },
  { name: 'Golden', speed: 12, durability: 32, level: 0 },
];
/** Attack damage per tool and tier (wood, stone, iron, diamond, gold), Java 1.21. */
const TOOL_DAMAGE: Record<ToolKind, number[]> = {
  sword: [4, 5, 6, 7, 4],
  axe: [7, 9, 9, 9, 7],
  pickaxe: [2, 3, 4, 5, 2],
  shovel: [2.5, 3.5, 4.5, 5.5, 2.5],
  hoe: [1, 1, 1, 1, 1],
  shears: [1, 1, 1, 1, 1],
};

const items = new Map<number, ItemDef>();

function add(def: ItemDef): void {
  items.set(def.id, def);
}

function addSpec(id: number, spec: ItemSpec): void {
  add({ id, name: spec.name, displayName: spec.display, maxStack: spec.maxStack ?? 64, sprite: spec.sprite, food: spec.food });
}

/** Item id of a named non-block item from the content tables, e.g. itemId('copper_ingot'). */
export const ITEM_ID: Record<string, number> = {};
FOODS.forEach((f, i) => { addSpec(FOOD_FIRST + i, f); ITEM_ID[f.name] = FOOD_FIRST + i; });
MATERIALS.forEach((m, i) => { addSpec(MATERIAL_FIRST + i, m); ITEM_ID[m.name] = MATERIAL_FIRST + i; });
export function itemId(name: string): number {
  const id = ITEM_ID[name] ?? CUBE_ID[name];
  if (id === undefined) throw new Error(`Unknown item ${name}`);
  return id;
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

// Buckets: empty ones stack to 16, full ones are single (Minecraft).
add({ id: ITEM.BUCKET, name: 'bucket', displayName: 'Bucket', maxStack: 16, sprite: 'bucket' });
add({ id: ITEM.WATER_BUCKET, name: 'water_bucket', displayName: 'Water Bucket', maxStack: 1, sprite: 'bucket_water' });
add({ id: ITEM.LAVA_BUCKET, name: 'lava_bucket', displayName: 'Lava Bucket', maxStack: 1, sprite: 'bucket_lava' });

const TOOL_KINDS: ToolKind[] = ['pickaxe', 'axe', 'shovel', 'sword', 'hoe'];
/** First item id per tool kind: wood, stone, iron, diamond follow each other; gold has its own id. */
const TOOL_IDS: Record<string, { base: number; gold: number }> = {
  pickaxe: { base: ITEM.WOODEN_PICKAXE, gold: ITEM.GOLDEN_PICKAXE },
  axe: { base: ITEM.WOODEN_AXE, gold: ITEM.GOLDEN_AXE },
  shovel: { base: ITEM.WOODEN_SHOVEL, gold: ITEM.GOLDEN_SHOVEL },
  sword: { base: ITEM.WOODEN_SWORD, gold: ITEM.GOLDEN_SWORD },
  hoe: { base: ITEM.WOODEN_HOE, gold: ITEM.GOLDEN_HOE },
};
for (const kind of TOOL_KINDS) {
  TIERS.forEach((t, tier) => {
    add({
      id: tier === 4 ? TOOL_IDS[kind].gold : TOOL_IDS[kind].base + tier,
      name: `${t.name.toLowerCase()}_${kind}`,
      displayName: `${t.name} ${kind[0].toUpperCase()}${kind.slice(1)}`,
      maxStack: 1,
      sprite: `${kind}_${tier}`,
      tool: { kind, tier: t.level, speed: t.speed, durability: t.durability, damage: TOOL_DAMAGE[kind][tier] },
    });
  });
}
add({
  id: SHEARS, name: 'shears', displayName: 'Shears', maxStack: 1, sprite: 'shears',
  tool: { kind: 'shears', tier: 0, speed: 1.5, durability: 238, damage: 1 },
});

// Armor: 5 materials × 4 slots (Java 1.21 points, toughness, durability).
ARMOR_MATERIALS.forEach((m, mi) => {
  ARMOR_SLOT_NAMES.forEach((slotName, slot) => {
    const leather: Record<string, string> = { helmet: 'Cap', chestplate: 'Tunic', leggings: 'Pants', boots: 'Boots' };
    const noun = mi === 0 ? leather[slotName] : slotName[0].toUpperCase() + slotName.slice(1);
    add({
      id: armorItemId(mi, slot), name: `${m.name}_${slotName}`, displayName: `${m.display} ${noun}`, maxStack: 1,
      sprite: `armor:${slot}:${mi}`, durability: ARMOR_BASE_DURABILITY[slot] * m.durability,
      armor: { slot, points: m.points[slot], toughness: m.toughness, material: mi },
    });
  });
});
void ARMOR_FIRST;

const blockItemDefs = new Map<number, ItemDef>();

export function getItemDef(id: number): ItemDef | undefined {
  if (id <= 0) return undefined;
  const direct = items.get(id);
  if (direct) return direct;
  let def = blockItemDefs.get(id);
  if (def) return def;
  const block = itemBlock(id);
  const b = block ? getBlockDef(block) : undefined;
  if (!b) return undefined;
  const meta = itemMeta(id);
  // Only the canonical id of a real variant exists (no made-up meta bits, no ids beyond the table).
  if (id >= VARIANT_ITEM_BASE && itemFromState(block, meta) !== id) return undefined;
  const v = b.variant;
  const name = v ? v.names[meta >> v.shift] : undefined;
  if (v && !name) return undefined;
  def = { id, name: b.name, displayName: name ?? b.displayName, maxStack: 64 };
  blockItemDefs.set(id, def);
  return def;
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
  return itemBlock(id) > 0;
}

export const ALL_ITEMS: number[] = [...items.keys()];


// ---------------------------------------------------------------- breaking & drops

/** Minecraft block hardness, the tool that mines it fastest and what it takes to get a drop. */
interface Mining {
  hardness: number;
  tool?: ToolKind;
  /** Lowest tool tier that gets a drop (pickaxe blocks). */
  minTier?: number;
  /** The drop needs one of these tools (cobweb: sword or shears). */
  needs?: ToolKind[];
  /** Mining speed of shears on this block (they are not tiered). */
  shears?: number;
}

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
  [B.GLASS]: { hardness: 0.3 },
  [B.GLOWSTONE]: { hardness: 0.3 },
  [B.CACTUS]: { hardness: 0.4 },
  [B.WOOL]: { hardness: 0.8, shears: 5 },
  [B.RED_WOOL]: { hardness: 0.8, shears: 5 },
  [B.BLUE_WOOL]: { hardness: 0.8, shears: 5 },
  [B.YELLOW_WOOL]: { hardness: 0.8, shears: 5 },
  [B.GREEN_WOOL]: { hardness: 0.8, shears: 5 },
  [B.TNT]: { hardness: 0 },
  [B.OAK_DOOR]: { hardness: 3, tool: 'axe' },
};

// Blocks that carry their mining data in the block table (Content.ts): the new stone, wood, ores and so on.
for (const def of BLOCK_DEFS) {
  if (MINING[def.id]) continue;
  if (def.tool === 'sword') MINING[def.id] = { hardness: def.hardness, tool: 'sword', needs: ['sword', 'shears'], shears: 15 };
  else if (def.tool) MINING[def.id] = { hardness: def.hardness, tool: def.tool, minTier: def.minTier };
  // Leaves: the hoe is the fast tool, shears are fastest.
  if (def.shape === 'cube' && def.sway && def.transparent) MINING[def.id] = { hardness: def.hardness, tool: 'hoe', shears: 15 };
}

// Slabs mine like their full block but are harder (2.0, Minecraft); stairs keep the hardness of the full block.
PARTIAL_MATERIALS.forEach((m, i) => {
  MINING[SLAB_FIRST + i] = { ...MINING[m.base], hardness: 2 };
  MINING[STAIRS_FIRST + i] = { ...MINING[m.base] };
});

export function miningInfo(blockId: number): Readonly<Mining> | undefined {
  return MINING[blockId];
}

/**
 * Survival break time in seconds (Minecraft formula): damage per tick is
 * speed / hardness / (canHarvest ? 30 : 100); ×5 slower in the air or under water.
 */
export function breakSeconds(blockId: number, held: number, onGround: boolean, inWater: boolean): number {
  const m = MINING[blockId];
  const hardness = m?.hardness ?? Math.max(0, getBlockDef(blockId)?.hardness ?? 1);
  if (hardness <= 0) return 0;
  const tool = getItemDef(held)?.tool;
  let speed = 1;
  if (tool && m) {
    if (tool.kind === 'shears') speed = m.shears ?? 1;
    else if (m.tool === tool.kind) speed = tool.kind === 'sword' ? 15 : tool.speed;
  }
  if (!onGround) speed /= 5;
  if (inWater) speed /= 5;
  const perTick = speed / hardness / (canHarvest(blockId, held) ? 30 : 100);
  return Math.ceil(1 / perTick) / 20;
}

export function canHarvest(blockId: number, held: number): boolean {
  const m = MINING[blockId];
  if (!m) return true;
  const tool = getItemDef(held)?.tool;
  if (m.needs) return !!tool && m.needs.includes(tool.kind);
  if (m.minTier === undefined) return true;
  return !!tool && tool.kind === m.tool && tool.tier >= m.minTier;
}

// ---- drops ----

let nameIndex: Map<string, number> | null = null;
/** Id of an item by name, for the drop and recipe tables. */
function named(name: string): number {
  if (!nameIndex) {
    nameIndex = new Map();
    for (const d of items.values()) nameIndex.set(d.name, d.id);
  }
  return nameIndex.get(name) ?? itemId(name);
}

const rand = (min: number, max: number): number => min + Math.floor(Math.random() * (max - min + 1));

/** Ore blocks: what they drop and how many (min..max), Java 1.21 without Fortune. */
const ORE_DROPS: Record<number, { item: string; min: number; max: number }> = {
  [B.COAL_ORE]: { item: 'coal', min: 1, max: 1 },
  [B.IRON_ORE]: { item: 'raw_iron', min: 1, max: 1 },
  [B.GOLD_ORE]: { item: 'raw_gold', min: 1, max: 1 },
  [B.DIAMOND_ORE]: { item: 'diamond', min: 1, max: 1 },
  [CUBE_ID.copper_ore]: { item: 'raw_copper', min: 2, max: 5 },
  [CUBE_ID.lapis_ore]: { item: 'lapis_lazuli', min: 4, max: 9 },
  [CUBE_ID.redstone_ore]: { item: 'redstone', min: 4, max: 5 },
  [CUBE_ID.emerald_ore]: { item: 'emerald', min: 1, max: 1 },
  [B.GLOWSTONE]: { item: 'glowstone_dust', min: 2, max: 4 },
  [B.CLAY]: { item: 'clay_ball', min: 4, max: 4 },
  [B.SNOW]: { item: 'snowball', min: 4, max: 4 },
  [CUBE_ID.melon]: { item: 'melon_slice', min: 3, max: 7 },
};

/** Leaves → index into the sapling variants (oak, spruce, birch, jungle, acacia, dark oak, cherry) and sapling chance. */
const LEAVES_SAPLING: Record<number, { sapling: number; chance: number; apple?: boolean }> = {
  [B.OAK_LEAVES]: { sapling: 0, chance: 0.05, apple: true },
  [B.SPRUCE_LEAVES]: { sapling: 1, chance: 0.05 },
  [B.BIRCH_LEAVES]: { sapling: 2, chance: 0.05 },
  [CUBE_ID.jungle_leaves]: { sapling: 3, chance: 0.025 },
  [CUBE_ID.acacia_leaves]: { sapling: 4, chance: 0.05 },
  [CUBE_ID.dark_oak_leaves]: { sapling: 5, chance: 0.05, apple: true },
  [CUBE_ID.cherry_leaves]: { sapling: 6, chance: 0.05 },
  [CUBE_ID.mangrove_leaves]: { sapling: -1, chance: 0 },
};

const EARTH_TO_DIRT = new Set([B.GRASS, B.SNOWY_GRASS, CUBE_ID.podzol, CUBE_ID.mycelium, CUBE_ID.farmland, CUBE_ID.dirt_path]);
const NO_DROP = new Set([B.GLASS, B.WATER, B.LAVA, B.BEDROCK, B.STAINED_GLASS, CUBE_ID.ice]);
const WITH_SHEARS_ONLY = new Set([B.TALL_GRASS, CUBE_ID.fern, B.DEAD_BUSH]);

/** What a block drops when mined in survival (null = nothing). `meta` is the state it had (a double slab drops two, wool keeps its colour). */
export function blockDrop(blockId: number, held: number, meta = 0): ItemStack | null {
  if (!canHarvest(blockId, held)) return null;
  const heldTool = getItemDef(held)?.tool?.kind;
  if (blockId >= SLAB_FIRST && blockId < STAIRS_FIRST) return { id: blockId, count: meta === SLAB_DOUBLE ? 2 : 1 };
  const ore = ORE_DROPS[blockId];
  if (ore) {
    // Snow needs a shovel (the table is shared with other drops that do not).
    if (blockId === B.SNOW && heldTool !== 'shovel') return null;
    return { id: named(ore.item), count: rand(ore.min, ore.max) };
  }
  const legacy = LEGACY_ITEMS[blockId];
  if (legacy) return { id: legacy, count: 1 };
  if (EARTH_TO_DIRT.has(blockId)) return { id: B.DIRT, count: 1 };
  if (NO_DROP.has(blockId)) return null;
  const leaves = LEAVES_SAPLING[blockId];
  if (leaves) {
    if (heldTool === 'shears') return { id: blockId, count: 1 };
    if (leaves.sapling >= 0 && Math.random() < leaves.chance) return { id: itemFromState(B.SAPLING, leaves.sapling), count: 1 };
    if (Math.random() < 0.02) return { id: ITEM.STICK, count: rand(1, 2) };
    if (leaves.apple && Math.random() < 0.005) return { id: named('apple'), count: 1 };
    return null;
  }
  if (WITH_SHEARS_ONLY.has(blockId)) {
    if (heldTool === 'shears') return { id: blockId, count: 1 };
    if (blockId === B.DEAD_BUSH) return Math.random() < 0.5 ? { id: ITEM.STICK, count: rand(1, 2) } : null;
    return Math.random() < 0.125 ? { id: named('wheat_seeds'), count: 1 } : null;
  }
  switch (blockId) {
    case B.STONE: return { id: B.COBBLESTONE, count: 1 };
    case CUBE_ID.deepslate: return { id: CUBE_ID.cobbled_deepslate, count: 1 };
    // Gravel drops flint 10% of the time (no Fortune).
    case B.GRAVEL: return { id: Math.random() < 0.1 ? ITEM.FLINT : B.GRAVEL, count: 1 };
    case CUBE_ID.cobweb: return { id: ITEM.STRING, count: 1 };
    default: return { id: itemFromState(blockId, meta), count: 1 };
  }
}

// Every non-block item by name (the content tables fill ITEM_ID as they register).
for (const d of items.values()) ITEM_ID[d.name] = d.id;
