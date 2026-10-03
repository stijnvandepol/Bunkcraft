import { mulberry32 } from '../world/Noise';
import {
  ENCHANTS, ENCHANT_BY_KEY, type EnchantMap, type EnchantTarget, conflicts, customName, enchantsOf, hasEnchants, levelOf, repairCostOf,
  withCustomName, withEnchants, withRepairCost,
} from './EnchantRules';
import { ITEM, ITEM_ID, type ItemStack, cloneStack, getItemDef, maxDurability } from './ItemRegistry';

/**
 * Enchanting in Minecraft Java 1.21 terms: which items can carry which enchantments, the enchanting table's offers,
 * the anvil's cost rules and the grindstone. DOM-free and deterministic given a seed, so it is tested and the
 * screens only draw its results.
 */

// ---------------------------------------------------------------- what an item can carry

export function isBook(id: number): boolean {
  return id === ITEM.ENCHANTED_BOOK || id === ITEM_ID.book;
}

/** Item groups an item belongs to (see EnchantTarget). */
export function targetsOf(id: number): EnchantTarget[] {
  const def = getItemDef(id);
  if (!def) return [];
  if (def.armor) return ['armor', 'durable', def.armor.slot === 0 ? 'helmet' : def.armor.slot === 3 ? 'boots' : 'armor'];
  const kind = def.tool?.kind;
  if (kind === 'sword') return ['sword', 'weapon', 'durable'];
  if (kind === 'axe') return ['axe', 'weapon', 'digger', 'durable'];
  if (kind === 'pickaxe' || kind === 'shovel' || kind === 'hoe') return [kind, 'digger', 'durable'];
  if (kind === 'shears') return ['shears', 'durable'];
  if (id === ITEM.BOW) return ['bow', 'durable'];
  if (id === ITEM.FLINT_AND_STEEL) return ['durable'];
  return [];
}

/** Can this enchantment be put on this item (ignoring what is already on it)? Books take everything. */
export function canCarry(id: number, key: string): boolean {
  const e = ENCHANT_BY_KEY.get(key);
  if (!e) return false;
  if (isBook(id)) return true;
  const t = targetsOf(id);
  return e.targets.some((x) => t.includes(x));
}

const TOOL_ENCHANTABILITY: Record<string, number> = { wooden: 15, stone: 5, iron: 14, diamond: 10, golden: 22 };
/** Leather, chainmail, iron, gold, diamond armor. */
const ARMOR_ENCHANTABILITY = [15, 12, 9, 25, 10];

/** The enchanting table's "enchantability" of an item: 0 means it cannot be enchanted there. */
export function enchantability(id: number): number {
  const def = getItemDef(id);
  if (!def) return 0;
  if (id === ITEM_ID.book) return 1;
  if (def.armor) return ARMOR_ENCHANTABILITY[def.armor.material] ?? 0;
  const kind = def.tool?.kind;
  if (kind && kind !== 'shears') return TOOL_ENCHANTABILITY[def.name.split('_')[0]] ?? 0;
  if (id === ITEM.BOW) return 1;
  return 0;
}

/** Can the enchanting table work on this stack (a plain book or a tool/armor without enchantments)? */
export function tableAccepts(stack: ItemStack): boolean {
  return stack.count === 1 && enchantability(stack.id) > 0 && !hasEnchants(stack.data);
}

/** A copy of a stack with the enchantments set (an enchanted book for a book). */
export function enchanted(stack: ItemStack, ench: EnchantMap): ItemStack {
  const out = cloneStack(stack);
  if (out.id === ITEM_ID.book) out.id = ITEM.ENCHANTED_BOOK;
  const data = withEnchants(out.data, ench);
  if (data) out.data = data; else delete out.data;
  return out;
}

export function stackEnchants(stack: ItemStack): EnchantMap {
  return enchantsOf(stack.data);
}

/** Display name of a stack: the custom name when it has one. */
export function stackLabel(stack: ItemStack): string {
  return customName(stack.data) || getItemDef(stack.id)?.displayName || '';
}

// ---------------------------------------------------------------- seeded random (java.util.Random shaped)

export class EnchantRandom {
  private readonly next: () => number;

  constructor(seed: number) {
    this.next = mulberry32(seed);
  }

  float(): number {
    return this.next();
  }

  /** Uniform integer 0..n-1. */
  int(n: number): number {
    return n <= 1 ? 0 : Math.floor(this.next() * n);
  }
}

// ---------------------------------------------------------------- the enchanting table

export interface EnchantChoice {
  key: string;
  level: number;
}

export const MAX_BOOKSHELVES = 15;

/**
 * Bookshelves that power a table: the ring two blocks away (5×5 minus the inner 3×3) at the table's height and one above,
 * each only when the block between it and the table is open (air, a plant, a torch...). At most 15 count (Java 1.21).
 */
export function countBookshelves(isShelf: (dx: number, dy: number, dz: number) => boolean, isOpen: (dx: number, dy: number, dz: number) => boolean): number {
  let n = 0;
  for (let dy = 0; dy <= 1; dy++) {
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (Math.abs(dx) !== 2 && Math.abs(dz) !== 2) continue;
        if (isShelf(dx, dy, dz) && isOpen(Math.trunc(dx / 2), dy, Math.trunc(dz / 2))) n++;
      }
    }
  }
  return Math.min(MAX_BOOKSHELVES, n);
}

/** Level requirement of one of the three slots (0 = the slot is empty), from the table's bookshelves (up to 15). */
export function slotCost(random: EnchantRandom, slot: number, bookshelves: number): number {
  const b = Math.min(MAX_BOOKSHELVES, Math.max(0, Math.floor(bookshelves)));
  const base = random.int(8) + 1 + (b >> 1) + random.int(b + 1);
  if (slot === 0) return Math.max(Math.floor(base / 3), 1);
  if (slot === 1) return Math.floor((base * 2) / 3) + 1;
  return Math.max(base, b * 2);
}

/** Every enchantment (at its highest fitting level) the modified level allows on this item. Treasure enchantments are left out. */
function available(id: number, level: number): EnchantChoice[] {
  const out: EnchantChoice[] = [];
  for (const e of ENCHANTS) {
    if (e.treasure || !canCarry(id, e.key)) continue;
    for (let l = e.max; l >= 1; l--) {
      if (level >= e.minPower(l) && level <= e.maxPower(l)) {
        out.push({ key: e.key, level: l });
        break;
      }
    }
  }
  return out;
}

function pickWeighted(random: EnchantRandom, list: EnchantChoice[]): EnchantChoice {
  let total = 0;
  for (const c of list) total += ENCHANT_BY_KEY.get(c.key)!.weight;
  let r = random.int(total);
  for (const c of list) {
    r -= ENCHANT_BY_KEY.get(c.key)!.weight;
    if (r < 0) return c;
  }
  return list[list.length - 1];
}

/**
 * The enchantments a slot of `cost` levels gives to an item (Minecraft's EnchantmentHelper.selectEnchantment): the level is
 * raised by the item's enchantability and a random factor, one enchantment is picked by weight, and more follow with a chance
 * that halves each time. Books get only one.
 */
export function enchantmentList(random: EnchantRandom, id: number, cost: number): EnchantChoice[] {
  const value = enchantability(id);
  if (value <= 0) return [];
  const quarter = Math.floor(value / 4) + 1;
  let level = cost + 1 + random.int(quarter) + random.int(quarter);
  const f = (random.float() + random.float() - 1) * 0.15;
  level = Math.max(1, Math.round(level * (1 + f)));
  let pool = available(id, level);
  const list: EnchantChoice[] = [];
  if (pool.length > 0) {
    list.push(pickWeighted(random, pool));
    while (random.int(50) <= level) {
      const last = list[list.length - 1];
      pool = pool.filter((c) => c.key !== last.key && !conflicts(last.key, c.key));
      if (pool.length === 0) break;
      list.push(pickWeighted(random, pool));
      level = Math.floor(level / 2);
    }
  }
  if (id === ITEM_ID.book && list.length > 1) list.splice(random.int(list.length), 1);
  return list;
}

export interface TableOffer {
  /** Level requirement (shown as the number next to the glyphs); 0 = no offer. */
  cost: number;
  /** Levels and lapis lazuli spent: the slot number + 1. */
  price: number;
  /** The first enchantment, shown when hovering ("Efficiency ..."). */
  clue: EnchantChoice | null;
  /** The enchantments that will be applied. */
  list: EnchantChoice[];
  /** Seed of the glyph text. */
  glyphSeed: number;
}

/** The three offers of an enchanting table for an item and a player's seed. Deterministic: the same seed shows the same offers. */
export function tableOffers(seed: number, stack: ItemStack, bookshelves: number): TableOffer[] {
  const offers: TableOffer[] = [];
  const random = new EnchantRandom(seed);
  const costs = [0, 1, 2].map((slot) => {
    const c = slotCost(random, slot, bookshelves);
    return c < slot + 1 ? 0 : c;
  });
  for (let slot = 0; slot < 3; slot++) {
    const cost = tableAccepts(stack) ? costs[slot] : 0;
    if (cost <= 0) {
      offers.push({ cost: 0, price: slot + 1, clue: null, list: [], glyphSeed: 0 });
      continue;
    }
    const r = new EnchantRandom(seed + slot);
    const list = enchantmentList(r, stack.id, cost);
    const clue = list.length ? list[r.int(list.length)] : null;
    offers.push({ cost, price: slot + 1, clue, list, glyphSeed: (seed * 31 + slot * 7919) >>> 0 });
  }
  return offers;
}

/** Can the player pay this offer? Creative mode pays nothing. */
export function canPayOffer(offer: TableOffer, level: number, lapis: number, free: boolean): boolean {
  if (offer.cost <= 0 || offer.list.length === 0) return false;
  return free || (level >= offer.cost && level >= offer.price && lapis >= offer.price);
}

/** The stack after the offer was applied. */
export function applyOffer(stack: ItemStack, offer: TableOffer): ItemStack {
  const ench: EnchantMap = {};
  for (const c of offer.list) ench[c.key] = c.level;
  return enchanted(stack, ench);
}

/** A new seed after an enchant (the table shows different offers for the next item). */
export function nextEnchantSeed(seed: number): number {
  return Math.floor(mulberry32(seed ^ 0x9e3779b9)() * 0xffffffff) >>> 0;
}

/** The glyph letters of an offer ("the standard galactic alphabet"): a..z, with spaces between words. */
export function glyphText(glyphSeed: number, length = 14): string {
  const r = mulberry32(glyphSeed);
  let out = '';
  while (out.length < length) {
    const word = 2 + Math.floor(r() * 4);
    for (let i = 0; i < word && out.length < length; i++) out += String.fromCharCode(97 + Math.floor(r() * 26));
    if (out.length < length) out += ' ';
  }
  return out.trim();
}

// ---------------------------------------------------------------- the anvil

const REPAIR_MATERIAL: Record<string, string[]> = {
  wooden: ['oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks'],
  stone: ['cobblestone', 'cobbled_deepslate'],
  iron: ['iron_ingot'],
  diamond: ['diamond'],
  golden: ['gold_ingot'],
  leather: ['leather'],
  chainmail: ['iron_ingot'],
};

/** Can `material` repair `item` in an anvil (planks for wooden tools, an iron ingot for iron gear ...)? */
export function repairs(item: number, material: number): boolean {
  const def = getItemDef(item);
  if (!def || !maxDurability(item)) return false;
  const names = REPAIR_MATERIAL[def.name.split('_')[0]];
  const mat = getItemDef(material)?.name;
  return !!names && !!mat && names.includes(mat);
}

export const TOO_EXPENSIVE = 40;

export interface AnvilResult {
  result: ItemStack;
  /** Levels the player pays. */
  cost: number;
  /** Items of the right-hand slot that are used up (the whole stack unless it is repair material). */
  materialUsed: number;
}

export type AnvilOutcome = { kind: 'ok'; value: AnvilResult } | { kind: 'expensive'; cost: number } | { kind: 'none' };

/** The next "prior work" penalty: 0, 1, 3, 7, 15, ... */
export function nextPenalty(p: number): number {
  return p * 2 + 1;
}

/**
 * What the anvil makes of the two input slots (and a new name; null keeps the name). Follows Minecraft's rules:
 * material repairs 25% per item (1 level each), two of the same tool combine durability (+12%) and enchantments, a book
 * adds its enchantments, renaming costs 1; the cost adds the "prior work" of both items and 40 or more is "Too Expensive!"
 * in survival (`creative` removes the limit and the price).
 */
export function anvilCombine(left: ItemStack, right: ItemStack, newName: string | null, creative = false): AnvilOutcome {
  if (!left.id || left.count <= 0) return { kind: 'none' };
  const result = cloneStack(left);
  const penalty = repairCostOf(left.data) + (right.id ? repairCostOf(right.data) : 0);
  let cost = 0;
  let materialUsed = 0;
  let changed = false;
  let enchantChanged = false;
  const max = maxDurability(left.id);
  let ench = enchantsOf(left.data);

  if (right.id && right.count > 0) {
    const rightIsBook = right.id === ITEM.ENCHANTED_BOOK;
    const repairWith = max > 0 && !rightIsBook && repairs(left.id, right.id);
    if (repairWith) {
      let d = Math.min(result.damage ?? 0, Math.floor(max / 4));
      if (d <= 0) return { kind: 'none' };
      let k = 0;
      for (; d > 0 && k < right.count; k++) {
        result.damage = (result.damage ?? 0) - d;
        cost++;
        d = Math.min(result.damage, Math.floor(max / 4));
      }
      materialUsed = k;
      if (!result.damage) delete result.damage;
      changed = true;
    } else {
      if (!rightIsBook && (right.id !== left.id || !max)) return { kind: 'none' };
      if (left.count !== 1) return { kind: 'none' };
      if (max > 0 && !rightIsBook) {
        const remaining = max - (result.damage ?? 0) + (max - (right.damage ?? 0)) + Math.floor((max * 12) / 100);
        const damage = Math.max(0, max - remaining);
        if (damage < (result.damage ?? 0)) {
          if (damage > 0) result.damage = damage; else delete result.damage;
          cost += 2;
          changed = true;
        }
      }
      const rightEnch = enchantsOf(right.data);
      let anyApplied = false;
      for (const [key, rl] of Object.entries(rightEnch)) {
        const e = ENCHANT_BY_KEY.get(key)!;
        const cur = ench[key] ?? 0;
        let level = cur === rl ? rl + 1 : Math.max(cur, rl);
        level = Math.min(level, e.max);
        let ok = canCarry(left.id, key);
        for (const other of Object.keys(ench)) {
          if (other !== key && conflicts(key, other)) {
            ok = false;
            cost++;
          }
        }
        if (!ok) continue;
        ench = { ...ench, [key]: level };
        anyApplied = true;
        const mult = rightIsBook ? e.anvilBook : e.anvilItem;
        cost += mult * level;
        if (left.count > 1) return { kind: 'none' };
      }
      if (anyApplied) { changed = true; enchantChanged = true; }
      // A book that adds nothing and no repair: the anvil refuses.
      if (rightIsBook && !anyApplied && !changed) return { kind: 'none' };
    }
  }

  const work = changed;
  if (newName !== null) {
    const current = customName(left.data);
    const wanted = newName.trim();
    if (wanted !== current && !(wanted === '' && current === '')) {
      result.data = withCustomName(result.data, wanted);
      cost += 1;
      changed = true;
    }
  }
  if (!changed) return { kind: 'none' };
  if (enchantChanged) {
    const data = withEnchants(result.data, ench);
    if (data) result.data = data; else delete result.data;
  }
  // Penalty for the next time: only renaming leaves it as it was.
  if (work) {
    const base = Math.max(repairCostOf(left.data), right.id ? repairCostOf(right.data) : 0);
    const data = withRepairCost(result.data, nextPenalty(base));
    if (data) result.data = data; else delete result.data;
  }
  const total = cost + penalty;
  if (creative) return { kind: 'ok', value: { result, cost: 0, materialUsed } };
  if (total >= TOO_EXPENSIVE) return { kind: 'expensive', cost: total };
  return { kind: 'ok', value: { result, cost: total, materialUsed } };
}

// ---------------------------------------------------------------- the grindstone

export interface GrindResult {
  result: ItemStack;
  /** Experience points the player gets. */
  xp: number;
}

/** Experience of the enchantments a grindstone removes: their minimum power, half to full after a random roll. */
export function disenchantXp(items: ItemStack[], random: () => number = Math.random): number {
  let sum = 0;
  for (const s of items) {
    for (const [k, l] of Object.entries(enchantsOf(s.data))) {
      const e = ENCHANT_BY_KEY.get(k);
      if (e && !e.curse) sum += e.minPower(l);
    }
  }
  if (sum <= 0) return 0;
  const half = Math.ceil(sum / 2);
  return half + Math.floor(random() * half);
}

function stripped(stack: ItemStack): ItemStack {
  const out = cloneStack(stack);
  const kept: EnchantMap = {};
  for (const [k, l] of Object.entries(enchantsOf(stack.data))) if (ENCHANT_BY_KEY.get(k)?.curse) kept[k] = l;
  let data = withEnchants(out.data, kept);
  data = withRepairCost(data, 0);
  if (data) out.data = data; else delete out.data;
  if (out.id === ITEM.ENCHANTED_BOOK) {
    out.id = ITEM_ID.book;
    if (hasEnchants(out.data)) out.id = ITEM.ENCHANTED_BOOK;
  }
  return out;
}

/**
 * The grindstone: one item loses its enchantments (and its prior work), two items of the same kind merge their durability
 * (+5%) and lose theirs. The XP is rolled each time the output is shown, so it is returned separately.
 */
export function grindstoneResult(a: ItemStack, b: ItemStack, random: () => number = Math.random): GrindResult | null {
  const hasA = a.id > 0 && a.count > 0, hasB = b.id > 0 && b.count > 0;
  if (!hasA && !hasB) return null;
  if (hasA !== hasB) {
    const s = hasA ? a : b;
    // A plain item with nothing to remove has no use here.
    if (!hasEnchants(s.data) && repairCostOf(s.data) === 0) return null;
    if (s.count !== 1) return null;
    return { result: stripped(s), xp: disenchantXp([s], random) };
  }
  const max = maxDurability(a.id);
  if (a.id !== b.id || !max || a.count !== 1 || b.count !== 1) return null;
  const remaining = max - (a.damage ?? 0) + (max - (b.damage ?? 0)) + Math.floor((max * 5) / 100);
  const result = stripped(a);
  const damage = Math.max(0, max - Math.min(max, remaining));
  if (damage > 0) result.damage = damage; else delete result.damage;
  return { result, xp: disenchantXp([a, b], random) };
}

// ---------------------------------------------------------------- mending

/**
 * Experience with Mending: one damaged item that has it (picked at random) is repaired 2 durability per point; the points it did not
 * need go to the player. Returns the points that are left.
 */
export function applyMending(items: ItemStack[], xp: number, random: () => number = Math.random): number {
  const candidates = items.filter((s) => s.id > 0 && levelOf(s.data, 'mending') > 0 && (s.damage ?? 0) > 0);
  if (candidates.length === 0 || xp <= 0) return xp;
  const s = candidates[Math.floor(random() * candidates.length)];
  const repair = Math.min(xp * 2, s.damage ?? 0);
  const left = (s.damage ?? 0) - repair;
  if (left > 0) s.damage = left; else delete s.damage;
  return xp - Math.floor(repair / 2);
}
