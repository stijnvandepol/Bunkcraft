import { type ItemStack, cloneStack, getItemDef, itemId } from './ItemRegistry';

const maxStackOf = (id: number): number => getItemDef(id)?.maxStack ?? 64;

/**
 * Loot tables (DOM-free, deterministic from a seeded RNG): pools with rolls, weighted entries, count ranges and
 * conditions, in the shape of Minecraft's loot tables (docs/research/MECHANICS.md 4.7) but as plain TypeScript data.
 * Chests in structures roll `rollLoot(table, rng)` into their slots (see `fillContainer`); a chest that is generated
 * with a table and a seed (`BlockEntityStore.setLoot`) rolls it on first open, so the same seed gives the same chest.
 *
 * Entries name items instead of ids (`'iron_ingot'`, `'oak_log'`): a name this build does not have is skipped at
 * roll time, so a table never breaks when an item is renamed or not added yet.
 */

/** A source of uniform numbers in [0, 1). */
export type Rng = () => number;

/** mulberry32: small, fast and identical on every platform. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A 32-bit seed from a few integers (a world seed and a position), so every chest gets its own sequence. */
export function hashSeed(...parts: number[]): number {
  let h = 0x811c9dc5;
  for (const p of parts) {
    h ^= p | 0;
    h = Math.imul(h, 0x01000193);
    h ^= h >>> 15;
  }
  return h >>> 0;
}

/** What is known about the kill or the opener when a table is rolled. */
export interface LootContext {
  /** Mob drops: killed by a player (some drops need it). */
  killedByPlayer?: boolean;
  /** Looting level of the weapon (adds to counts and chances of entries that opt in). */
  looting?: number;
  /** Luck (fishing, chests of players with the effect); reserved, adds to bonus rolls. */
  luck?: number;
}

export type LootCondition =
  | { t: 'killed_by_player' }
  /** Passes with probability p. */
  | { t: 'chance'; p: number }
  /** Passes with probability base + perLevel × looting. */
  | { t: 'looting_chance'; base: number; perLevel: number };

export type Range = number | readonly [number, number];

export interface LootEntry {
  /** Item or block name (`itemId`). Leave out for an entry that rolls "nothing" (it only takes weight). */
  item?: string;
  weight: number;
  /** Items per roll: a number or an inclusive [min, max] range. Default 1. */
  count?: Range;
  /** Extra max count per level of looting. */
  lootingBonus?: number;
  conditions?: LootCondition[];
}

export interface LootPool {
  /** Number of rolls: fixed or an inclusive range. */
  rolls: Range;
  /** Extra rolls per point of luck. */
  bonusRolls?: number;
  conditions?: LootCondition[];
  entries: LootEntry[];
}

export interface LootTable {
  id: string;
  pools: LootPool[];
}

function inRange(r: Range, rng: Rng): number {
  if (typeof r === 'number') return r;
  return r[0] + Math.floor(rng() * (r[1] - r[0] + 1));
}

function passes(conditions: LootCondition[] | undefined, rng: Rng, ctx: LootContext): boolean {
  if (!conditions) return true;
  for (const c of conditions) {
    if (c.t === 'killed_by_player') { if (!ctx.killedByPlayer) return false; }
    else if (c.t === 'chance') { if (!(rng() < c.p)) return false; }
    else if (!(rng() < c.base + c.perLevel * (ctx.looting ?? 0))) return false;
  }
  return true;
}

const resolved = new Map<string, number>();
/** Item id of a name; -1 when this build does not have it. */
function resolve(name: string): number {
  let id = resolved.get(name);
  if (id === undefined) {
    try { id = itemId(name); } catch { id = -1; }
    resolved.set(name, id);
  }
  return id;
}

/**
 * Rolls a table: for every pool its number of rolls, each picking one entry by weight. Stacks come out already
 * split at the item's stack size and in roll order (merge identical ones with `fillContainer`).
 */
export function rollLoot(table: LootTable, rng: Rng, ctx: LootContext = {}): ItemStack[] {
  const out: ItemStack[] = [];
  for (const pool of table.pools) {
    if (!passes(pool.conditions, rng, ctx)) continue;
    const rolls = inRange(pool.rolls, rng) + Math.floor((pool.bonusRolls ?? 0) * (ctx.luck ?? 0));
    for (let r = 0; r < rolls; r++) {
      const entry = pickEntry(pool.entries, rng);
      if (!entry || !entry.item || !passes(entry.conditions, rng, ctx)) continue;
      const id = resolve(entry.item);
      if (id < 0) continue;
      let count = inRange(entry.count ?? 1, rng);
      if (entry.lootingBonus && ctx.looting) count += Math.floor(rng() * (entry.lootingBonus * ctx.looting + 1));
      for (const stack of splitStacks(id, count)) out.push(stack);
    }
  }
  return out;
}

/** Entry by weight; entries whose item this build lacks keep their weight (so a missing item leaves a gap, like "nothing"). */
function pickEntry(entries: LootEntry[], rng: Rng): LootEntry | null {
  let total = 0;
  for (const e of entries) total += e.weight;
  if (total <= 0) return null;
  let x = rng() * total;
  for (const e of entries) {
    x -= e.weight;
    if (x < 0) return e;
  }
  return entries[entries.length - 1] ?? null;
}

function splitStacks(id: number, count: number): ItemStack[] {
  const max = maxStackOf(id);
  const out: ItemStack[] = [];
  for (let left = count; left > 0; left -= max) out.push({ id, count: Math.min(left, max) });
  return out;
}

/**
 * Puts rolled stacks into a container like Minecraft does: identical stacks are merged first, then every stack
 * goes into a random free slot (so a chest does not fill from the top). Returns the stacks that did not fit.
 */
export function fillContainer(slots: ItemStack[], stacks: ItemStack[], rng: Rng): ItemStack[] {
  const merged: ItemStack[] = [];
  for (const s of stacks) {
    const max = maxStackOf(s.id);
    const into = merged.find((m) => m.id === s.id && m.count < max && !m.data && !s.data);
    if (into) {
      const n = Math.min(s.count, max - into.count);
      into.count += n;
      if (s.count > n) merged.push({ ...cloneStack(s), count: s.count - n });
    } else merged.push(cloneStack(s));
  }
  const free: number[] = [];
  slots.forEach((s, i) => { if (s.count === 0) free.push(i); });
  const left: ItemStack[] = [];
  // Fisher-Yates over the free slots.
  for (let i = free.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [free[i], free[j]] = [free[j], free[i]];
  }
  for (const s of merged) {
    const slot = free.pop();
    if (slot === undefined) left.push(s);
    else slots[slot] = s;
  }
  return left;
}

// ---------------------------------------------------------------- starter tables

const e = (item: string, weight: number, count?: Range): LootEntry => ({ item, weight, count });

/** Loot tables by id. Structure builders reference these ids; add new ones here (or register at runtime). */
export const LOOT_TABLES: Record<string, LootTable> = {
  /** A dungeon (monster room) chest: mixed loot plus the mob drops that dungeons are known for. */
  dungeon_chest: {
    id: 'dungeon_chest',
    pools: [
      {
        rolls: [1, 3],
        entries: [
          e('saddle', 20), e('golden_apple', 15), e('bread', 20), e('wheat', 20, [1, 4]), e('bucket', 10), e('redstone', 15, [1, 4]),
          e('coal', 15, [1, 4]), e('iron_ingot', 15, [1, 4]), e('gold_ingot', 5, [1, 4]), e('diamond', 3, [1, 2]), e('melon_seeds', 10, [2, 4]),
          e('pumpkin_seeds', 10, [2, 4]), e('beetroot_seeds', 10, [2, 4]), e('wheat_seeds', 10, [1, 4]), e('lapis_lazuli', 5, [1, 4]),
        ],
      },
      { rolls: [1, 4], entries: [e('bone', 10, [1, 8]), e('gunpowder', 10, [1, 8]), e('rotten_flesh', 10, [1, 8]), e('string', 10, [1, 8])] },
    ],
  },
  /** An abandoned mineshaft chest: ores, food, rails and torches. */
  mineshaft_chest: {
    id: 'mineshaft_chest',
    pools: [
      {
        rolls: [2, 4],
        entries: [
          e('golden_apple', 20), e('iron_ingot', 10, [1, 5]), e('gold_ingot', 5, [1, 3]), e('redstone', 5, [4, 9]), e('lapis_lazuli', 5, [4, 9]),
          e('diamond', 3, [1, 2]), e('coal', 10, [3, 8]), e('bread', 15, [1, 3]), e('melon_seeds', 10, [2, 4]), e('pumpkin_seeds', 10, [2, 4]),
          e('beetroot_seeds', 10, [2, 4]), e('iron_pickaxe', 1), e('emerald', 2, [1, 2]),
        ],
      },
      { rolls: 3, entries: [e('rail', 20, [4, 8]), e('torch', 15, [2, 8]), e('stick', 10, [2, 6]), e('oak_planks', 10, [2, 6])] },
    ],
  },
  /** A chest in a village house: farm food, some metal, the odd emerald. */
  village_chest: {
    id: 'village_chest',
    pools: [
      {
        rolls: [3, 8],
        entries: [
          e('wheat', 6, [1, 4]), e('bread', 4, [1, 3]), e('apple', 5, [1, 3]), e('potato', 5, [1, 4]), e('carrot', 5, [1, 4]),
          e('iron_ingot', 3, [1, 2]), e('coal', 3, [1, 3]), e('oak_sapling', 5, [1, 2]), e('emerald', 1, [1, 2]), e('oak_log', 5, [1, 3]),
          e('stick', 3, [1, 3]), e('gold_ingot', 1), e('bucket', 1),
        ],
      },
    ],
  },
  /** The bonus chest next to the spawn of a new world: a first tool, food and wood. */
  spawn_bonus_chest: {
    id: 'spawn_bonus_chest',
    pools: [
      { rolls: 1, entries: [e('stone_axe', 1), e('wooden_axe', 3)] },
      { rolls: 1, entries: [e('stone_pickaxe', 1), e('wooden_pickaxe', 3)] },
      { rolls: 3, entries: [e('apple', 5, [1, 2]), e('bread', 3, [1, 2]), e('cooked_salmon', 3, [1, 2])] },
      { rolls: 3, entries: [e('stick', 10, [1, 12]), e('oak_planks', 10, [1, 12]), e('oak_log', 10, [1, 3]), e('spruce_log', 10, [1, 3]), e('birch_log', 10, [1, 3])] },
    ],
  },
};

export function getLootTable(id: string): LootTable | undefined {
  return LOOT_TABLES[id];
}
