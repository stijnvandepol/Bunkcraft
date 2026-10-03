import { ALL_ITEMS, getItemDef } from '../items/ItemRegistry';
import type { MobKind } from './MobTypes';

/**
 * Which items count as breeding food, by item *tag*. A tag is a list of item names; names that do not exist (yet) are
 * skipped, so crops that arrive later (beetroot seeds, golden carrots...) work as soon as their item is registered.
 * Minecraft Java 1.21: cow and sheep like wheat, pigs carrots, potatoes and beetroot, chickens seeds, wolves meat,
 * horses golden apples and golden carrots (apples and wheat only heal and grow them: onzeker, left out).
 */
export const FOOD_TAGS: Readonly<Record<string, readonly string[]>> = {
  wheat: ['wheat'],
  seeds: ['wheat_seeds', 'melon_seeds', 'pumpkin_seeds', 'beetroot_seeds', 'torchflower_seeds'],
  pig_food: ['carrot', 'potato', 'beetroot'],
  // Every meat but fish: wolves breed and heal with them.
  wolf_food: ['porkchop', 'beef', 'chicken', 'mutton', 'rabbit', 'cooked_porkchop', 'steak', 'cooked_chicken', 'cooked_mutton', 'cooked_rabbit', 'rotten_flesh'],
  horse_food: ['golden_apple', 'golden_carrot'],
};

/** Breeding food per kind, as tags. */
export const BREED_FOOD: Readonly<Partial<Record<MobKind, readonly string[]>>> = {
  cow: ['wheat'],
  sheep: ['wheat'],
  pig: ['pig_food'],
  chicken: ['seeds'],
  wolf: ['wolf_food'],
  horse: ['horse_food'],
};

let byName: Map<string, number> | null = null;
const cache = new Map<string, ReadonlySet<number>>();

function itemIdByName(name: string): number | undefined {
  if (!byName) {
    byName = new Map();
    for (const id of ALL_ITEMS) {
      const def = getItemDef(id);
      if (def) byName.set(def.name, id);
    }
  }
  return byName.get(name);
}

/** Item ids of a tag (unknown names are skipped). */
export function tagItems(tag: string): ReadonlySet<number> {
  let set = cache.get(tag);
  if (!set) {
    const ids = new Set<number>();
    for (const n of FOOD_TAGS[tag] ?? []) {
      const id = itemIdByName(n);
      if (id !== undefined) ids.add(id);
    }
    set = ids;
    cache.set(tag, set);
  }
  return set;
}

/** Whether this item is breeding food for the kind. */
export function isBreedFood(kind: MobKind, item: number | undefined): boolean {
  if (item === undefined || item <= 0) return false;
  const tags = BREED_FOOD[kind];
  if (!tags) return false;
  for (const t of tags) if (tagItems(t).has(item)) return true;
  return false;
}

/** For tests: drop cached lookups after registering more items. */
export function resetBreedingCache(): void {
  byName = null;
  cache.clear();
}
