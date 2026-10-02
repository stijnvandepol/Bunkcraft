import { BLOCK } from '../world/BlockRegistry';
import type { PlayerInventory } from './Inventory';
import { ITEM, type ItemStack } from './ItemRegistry';

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

const B = BLOCK;
const PLANKS = [B.OAK_PLANKS, B.BIRCH_PLANKS, B.SPRUCE_PLANKS];
const FUEL = [ITEM.COAL, B.OAK_PLANKS, B.BIRCH_PLANKS, B.SPRUCE_PLANKS, B.OAK_LOG, B.BIRCH_LOG, B.SPRUCE_LOG];
const one = (id: number, count = 1): Ingredient => ({ ids: [id], count });
const any = (ids: number[], count: number): Ingredient => ({ ids, count });

/**
 * Recipe list in the spirit of the Minecraft recipe book. Ingredient counts match the
 * vanilla shaped recipes; smelting uses one fuel item per result to keep it simple.
 */
export const RECIPES: Recipe[] = [
  { result: { id: B.OAK_PLANKS, count: 4 }, ingredients: [one(B.OAK_LOG)], station: 'hand' },
  { result: { id: B.BIRCH_PLANKS, count: 4 }, ingredients: [one(B.BIRCH_LOG)], station: 'hand' },
  { result: { id: B.SPRUCE_PLANKS, count: 4 }, ingredients: [one(B.SPRUCE_LOG)], station: 'hand' },
  { result: { id: ITEM.STICK, count: 4 }, ingredients: [any(PLANKS, 2)], station: 'hand' },
  { result: { id: B.CRAFTING_TABLE, count: 1 }, ingredients: [any(PLANKS, 4)], station: 'hand' },
  { result: { id: B.TORCH, count: 4 }, ingredients: [one(ITEM.COAL), one(ITEM.STICK)], station: 'hand' },
  { result: { id: B.FURNACE, count: 1 }, ingredients: [one(B.COBBLESTONE, 8)], station: 'table' },
  { result: { id: B.STONE_BRICKS, count: 4 }, ingredients: [one(B.STONE, 4)], station: 'table' },
  { result: { id: B.SANDSTONE, count: 1 }, ingredients: [one(B.SAND, 4)], station: 'hand' },
  { result: { id: B.BOOKSHELF, count: 1 }, ingredients: [any(PLANKS, 6)], station: 'table' },
  // Smelting.
  { result: { id: B.GLASS, count: 1 }, ingredients: [one(B.SAND), any(FUEL, 1)], station: 'furnace' },
  { result: { id: B.STONE, count: 1 }, ingredients: [one(B.COBBLESTONE), any(FUEL, 1)], station: 'furnace' },
  { result: { id: ITEM.IRON_INGOT, count: 1 }, ingredients: [one(B.IRON_ORE), any(FUEL, 1)], station: 'furnace' },
  { result: { id: ITEM.COAL, count: 1 }, ingredients: [one(B.OAK_LOG), any(FUEL, 1)], station: 'furnace' },
  { result: { id: ITEM.COOKED_PORKCHOP, count: 1 }, ingredients: [one(ITEM.PORKCHOP), any(FUEL, 1)], station: 'furnace' },
  { result: { id: ITEM.STEAK, count: 1 }, ingredients: [one(ITEM.BEEF), any(FUEL, 1)], station: 'furnace' },
  { result: { id: ITEM.COOKED_MUTTON, count: 1 }, ingredients: [one(ITEM.MUTTON), any(FUEL, 1)], station: 'furnace' },
  { result: { id: ITEM.COOKED_CHICKEN, count: 1 }, ingredients: [one(ITEM.CHICKEN), any(FUEL, 1)], station: 'furnace' },
];

// Tools: pickaxe 3 + 2 sticks, axe 3 + 2, shovel 1 + 2, sword 2 + 1 (vanilla counts).
const MATERIALS: Ingredient[] = [any(PLANKS, 1), one(B.COBBLESTONE), one(ITEM.IRON_INGOT), one(ITEM.DIAMOND)];
const TOOLS: [number, number, number][] = [
  [ITEM.WOODEN_PICKAXE, 3, 2], [ITEM.WOODEN_AXE, 3, 2], [ITEM.WOODEN_SHOVEL, 1, 2], [ITEM.WOODEN_SWORD, 2, 1],
];
for (const [base, heads, sticks] of TOOLS) {
  MATERIALS.forEach((mat, tier) => {
    RECIPES.push({
      result: { id: base + tier, count: 1 },
      ingredients: [{ ids: mat.ids, count: heads }, one(ITEM.STICK, sticks)],
      station: 'table',
    });
  });
}

function available(inv: PlayerInventory, ing: Ingredient): number {
  return ing.ids.reduce((n, id) => n + inv.count(id), 0);
}

export function canCraft(inv: PlayerInventory, r: Recipe, stations: Set<Station>): boolean {
  if (r.station !== 'hand' && !stations.has(r.station)) return false;
  return r.ingredients.every((ing) => available(inv, ing) >= ing.count);
}

/**
 * Consumes the ingredients (taking from whichever accepted item the player has) and adds
 * the result. Returns how many result items did not fit (-1 if it could not be crafted).
 */
export function craft(inv: PlayerInventory, r: Recipe, stations: Set<Station>): number {
  if (!canCraft(inv, r, stations)) return -1;
  for (const ing of r.ingredients) {
    let left = ing.count;
    for (const id of ing.ids) {
      const n = Math.min(left, inv.count(id));
      if (n > 0) inv.remove(id, n);
      left -= n;
      if (left === 0) break;
    }
  }
  return inv.add({ ...r.result });
}
