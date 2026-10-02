import { DYES } from '../world/Content';

/**
 * Data tables for the non-block items (see docs/CONTENT.md). Item ids are positions in these tables (plus a base),
 * so they are APPEND-ONLY, like the block tables in world/Content.ts.
 */

export interface FoodInfo {
  hunger: number;
  saturation: number;
  /** Ticks of Poison I after eating. */
  poison?: number;
  /** Bowl-like foods stack to 1 and leave a bowl behind (mushroom stew). */
  returns?: string;
}

export interface ItemSpec {
  name: string;
  display: string;
  /** Sprite key (see ui/ItemSprites). */
  sprite: string;
  maxStack?: number;
  food?: FoodInfo;
}

// ---------------------------------------------------------------- materials and ingredients

export const MATERIAL_FIRST = 420;

const dyeItems: ItemSpec[] = DYES.map((d) => ({
  name: `${d.name}_dye`, display: `${d.display} Dye`, sprite: `dye:${d.rgb.toString(16).padStart(6, '0')}`,
}));

export const MATERIALS: ItemSpec[] = [
  { name: 'charcoal', display: 'Charcoal', sprite: 'coal:3a2f28' },
  { name: 'copper_ingot', display: 'Copper Ingot', sprite: 'ingot:d97b4a' },
  { name: 'raw_iron', display: 'Raw Iron', sprite: 'raw:c9a58a' },
  { name: 'raw_copper', display: 'Raw Copper', sprite: 'raw:c4693b' },
  { name: 'raw_gold', display: 'Raw Gold', sprite: 'raw:e9b83a' },
  { name: 'lapis_lazuli', display: 'Lapis Lazuli', sprite: 'gem:2a4cc4' },
  { name: 'redstone', display: 'Redstone Dust', sprite: 'dust:c61a10' },
  { name: 'emerald', display: 'Emerald', sprite: 'gem:17c24e' },
  { name: 'leather', display: 'Leather', sprite: 'leather' },
  { name: 'paper', display: 'Paper', sprite: 'paper' },
  { name: 'book', display: 'Book', sprite: 'book' },
  { name: 'clay_ball', display: 'Clay Ball', sprite: 'clay' },
  { name: 'brick', display: 'Brick', sprite: 'brick' },
  { name: 'snowball', display: 'Snowball', sprite: 'snowball', maxStack: 16 },
  { name: 'bone_meal', display: 'Bone Meal', sprite: 'dust:f2f2ea' },
  { name: 'ink_sac', display: 'Ink Sac', sprite: 'dye:1d1d21' },
  { name: 'wheat', display: 'Wheat', sprite: 'wheat' },
  { name: 'wheat_seeds', display: 'Wheat Seeds', sprite: 'seeds:7ea63a' },
  { name: 'pumpkin_seeds', display: 'Pumpkin Seeds', sprite: 'seeds:d7d3b4' },
  { name: 'melon_seeds', display: 'Melon Seeds', sprite: 'seeds:2f2f2f' },
  { name: 'glowstone_dust', display: 'Glowstone Dust', sprite: 'dust:f6c85a' },
  { name: 'iron_nugget', display: 'Iron Nugget', sprite: 'nugget:d8d8d8' },
  { name: 'gold_nugget', display: 'Gold Nugget', sprite: 'nugget:f0d43c' },
  { name: 'bowl', display: 'Bowl', sprite: 'bowl' },
  { name: 'sugar', display: 'Sugar', sprite: 'dust:f4f4f4' },
  ...dyeItems,
];

// ---------------------------------------------------------------- food

export const FOOD_FIRST = 380;

/** Values from the Minecraft wiki (hunger points, saturation points). */
export const FOODS: ItemSpec[] = [
  { name: 'apple', display: 'Apple', sprite: 'food:apple', food: { hunger: 4, saturation: 2.4 } },
  { name: 'golden_apple', display: 'Golden Apple', sprite: 'food:golden_apple', food: { hunger: 4, saturation: 9.6 } },
  { name: 'bread', display: 'Bread', sprite: 'food:bread', food: { hunger: 5, saturation: 6 } },
  { name: 'cookie', display: 'Cookie', sprite: 'food:cookie', food: { hunger: 2, saturation: 0.4 } },
  { name: 'potato', display: 'Potato', sprite: 'food:potato', food: { hunger: 1, saturation: 0.6 } },
  { name: 'baked_potato', display: 'Baked Potato', sprite: 'food:baked_potato', food: { hunger: 5, saturation: 6 } },
  { name: 'carrot', display: 'Carrot', sprite: 'food:carrot', food: { hunger: 3, saturation: 3.6 } },
  { name: 'golden_carrot', display: 'Golden Carrot', sprite: 'food:golden_carrot', food: { hunger: 6, saturation: 14.4 } },
  { name: 'melon_slice', display: 'Melon Slice', sprite: 'food:melon_slice', food: { hunger: 2, saturation: 1.2 } },
  { name: 'pumpkin_pie', display: 'Pumpkin Pie', sprite: 'food:pumpkin_pie', food: { hunger: 8, saturation: 4.8 } },
  { name: 'mushroom_stew', display: 'Mushroom Stew', sprite: 'food:stew', maxStack: 1, food: { hunger: 6, saturation: 7.2, returns: 'bowl' } },
  { name: 'cod', display: 'Raw Cod', sprite: 'food:cod', food: { hunger: 2, saturation: 0.4 } },
  { name: 'cooked_cod', display: 'Cooked Cod', sprite: 'food:cooked_cod', food: { hunger: 5, saturation: 6 } },
  { name: 'salmon', display: 'Raw Salmon', sprite: 'food:salmon', food: { hunger: 2, saturation: 0.4 } },
  { name: 'cooked_salmon', display: 'Cooked Salmon', sprite: 'food:cooked_salmon', food: { hunger: 6, saturation: 9.6 } },
  { name: 'sweet_berries', display: 'Sweet Berries', sprite: 'food:berries', food: { hunger: 2, saturation: 0.4 } },
  { name: 'beetroot', display: 'Beetroot', sprite: 'food:beetroot', food: { hunger: 1, saturation: 1.2 } },
  { name: 'rabbit', display: 'Raw Rabbit', sprite: 'meat_pink', food: { hunger: 3, saturation: 1.8 } },
  { name: 'cooked_rabbit', display: 'Cooked Rabbit', sprite: 'meat_cooked', food: { hunger: 5, saturation: 6 } },
];

// ---------------------------------------------------------------- tools

export const HOE_FIRST = 340;
export const SHEARS = 346;

// ---------------------------------------------------------------- armor

export const ARMOR_FIRST = 350;

export type ArmorSlot = 0 | 1 | 2 | 3;
export const ARMOR_SLOT_NAMES = ['helmet', 'chestplate', 'leggings', 'boots'] as const;

export interface ArmorMaterial {
  name: string;
  display: string;
  /** Armor points per slot (helmet, chestplate, leggings, boots). */
  points: [number, number, number, number];
  toughness: number;
  /** Durability multiplier; the base per slot is 11, 16, 15, 13. */
  durability: number;
  /** Item that repairs/crafts it. */
  sprite: string;
}

export const ARMOR_MATERIALS: ArmorMaterial[] = [
  { name: 'leather', display: 'Leather', points: [1, 3, 2, 1], toughness: 0, durability: 5, sprite: 'a0' },
  { name: 'chainmail', display: 'Chainmail', points: [2, 5, 4, 1], toughness: 0, durability: 15, sprite: 'a1' },
  { name: 'iron', display: 'Iron', points: [2, 6, 5, 2], toughness: 0, durability: 15, sprite: 'a2' },
  { name: 'golden', display: 'Golden', points: [2, 5, 3, 1], toughness: 0, durability: 7, sprite: 'a3' },
  { name: 'diamond', display: 'Diamond', points: [3, 8, 6, 3], toughness: 2, durability: 33, sprite: 'a4' },
];
export const ARMOR_BASE_DURABILITY = [11, 16, 15, 13] as const;

/** Item id of an armor piece. */
export function armorItemId(material: number, slot: number): number {
  return ARMOR_FIRST + material * 4 + slot;
}
