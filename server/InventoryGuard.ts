import { ARMOR_SLOTS, INVENTORY_SLOTS } from '../src/items/Inventory';
import { getItemDef, maxDurability, normalizeItem, possibleBlockDrops } from '../src/items/ItemRegistry';
import { RECIPES } from '../src/items/Recipes';

/**
 * Server-side plausibility check of a player's survival inventory.
 *
 * The client still owns the inventory screen (no server round trip per click), but items may only
 * ENTER an inventory through routes the server saw:
 *   - `taken`: pickups of item entities (credit added when the server sends the message),
 *   - crafting and smelting: a gain that no pickup explains must be producible from the previous
 *     contents (plus pickups) with RECIPES, chained recipes allowed (logs → planks → sticks).
 * Items may only LEAVE as a `drop` if they are backed by the same pool or by a block the player just
 * broke (the block-break drop is spawned by the client, see `creditBreak`).
 *
 * What it prevents: invented items, impossible counts and stack sizes, unknown ids, tool damage
 * out of range, duplicating by repeating `drop`, crafting without the ingredients.
 * What it cannot see: which crafting station was used and whether it was near (the client's
 * recipe book decides), items placed as blocks (consumption is trusted: it only lowers the pool),
 * tool damage resets, and moving items between slots (a pure rearrangement is always valid).
 */
export interface Stack {
  id: number;
  count: number;
  damage?: number;
  /** Per-stack data columns as sent (key index, value pairs: enchantments and such); passed through untouched. */
  extra?: number[];
}

/** A row is [id, count, damage, ...data pairs]: room for a handful of enchantments. */
const MAX_ROW_LENGTH = 16;

export type StateCheck = { ok: true; inventory: number[][] } | { ok: false; reason: string; correction: number[][] };

const CREDIT_TTL_MS = 60_000;
const MAX_BREAK_CREDITS = 256;
const MAX_LEDGER = 256;
const MAX_CRAFT_DEPTH = 3;

interface BreakCredit { id: number; count: number; until: number }

/** True for item ids that exist as a block item or in the item registry. */
export function validItem(id: number): boolean {
  return Number.isInteger(id) && id > 0 && !!getItemDef(id);
}

/** Parses the rows a client sent; returns clean stacks or an error. Data columns after the damage are validated as integers and kept. */
export function parseInventory(raw: unknown): { stacks: Stack[]; slots: Stack[]; error?: string } {
  const fail = (error: string) => ({ stacks: [], slots: [], error });
  if (!Array.isArray(raw)) return fail('not a list');
  // 36 inventory slots followed by the 4 worn armor slots.
  if (raw.length > INVENTORY_SLOTS + ARMOR_SLOTS) return fail('too many slots');
  const stacks: Stack[] = [];
  const slots: Stack[] = [];
  for (const row of raw) {
    if (!Array.isArray(row) || row.length < 2 || row.length > MAX_ROW_LENGTH) return fail('bad slot');
    const [rawId, count, damage] = row as unknown[];
    // Saves from before the colour families hold the old wool ids; the client loads them as variants (stackFromArray).
    const id = Number.isInteger(rawId) ? normalizeItem(rawId as number) : rawId;
    const extra = row.length > 3 ? (row.slice(3) as unknown[]) : undefined;
    if (extra && !extra.every((n) => Number.isInteger(n))) return fail('bad item data');
    if (!Number.isInteger(id) || !Number.isInteger(count)) return fail('bad slot numbers');
    if ((id as number) === 0 && (count as number) === 0) { slots.push({ id: 0, count: 0 }); continue; }
    if (!validItem(id as number)) return fail(`unknown item ${String(id)}`);
    const def = getItemDef(id as number)!;
    if ((count as number) < 1 || (count as number) > def.maxStack) return fail(`bad stack size ${String(count)} of ${def.name}`);
    const d = damage === undefined || damage === null ? 0 : damage;
    const max = maxDurability(id as number);
    if (!Number.isInteger(d) || (d as number) < 0 || (d as number) > Math.max(max, 0)) return fail(`bad damage on ${def.name}`);
    const stack: Stack = { id: id as number, count: count as number, damage: (d as number) || undefined };
    if (extra && extra.length >= 2) stack.extra = extra as number[];
    stacks.push(stack);
    slots.push(stack);
  }
  return { stacks, slots };
}

export function toRows(stacks: Stack[]): number[][] {
  return stacks.map((s) => (s.extra ? [s.id, s.count, s.damage ?? 0, ...s.extra] : [s.id, s.count, s.damage ?? 0]));
}

function totals(stacks: Stack[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const s of stacks) m.set(s.id, (m.get(s.id) ?? 0) + s.count);
  return m;
}

export class InventoryGuard {
  /** Slots of the last accepted state (layout kept, empty slots have id 0). */
  private good: Stack[];
  /** Pickups (+) and backed drops (-) since `good`, to rebuild a correction. */
  private ledger: Stack[] = [];
  /** id → items the player may still hold: last accepted totals + pickups − drops. */
  private pool: Map<number, number>;
  private credits: BreakCredit[] = [];
  /** The next valid-looking state becomes the new baseline (new game mode, first login). */
  private trustNext: boolean;

  constructor(initial: Stack[] | undefined, private readonly now: () => number = Date.now) {
    this.good = (initial ?? []).map((s) => ({ ...s }));
    this.pool = totals(this.good.filter((s) => s.id > 0));
    this.trustNext = false;
  }

  /** Switching from creative to survival: whatever is in the inventory then is the baseline. */
  trustNextState(): void {
    this.trustNext = true;
  }

  get poolCount(): number {
    let n = 0;
    for (const c of this.pool.values()) n += c;
    return n;
  }

  /** A pickup the server approved. */
  creditPickup(id: number, count: number, damage?: number): void {
    this.pool.set(id, (this.pool.get(id) ?? 0) + count);
    if (this.ledger.length < MAX_LEDGER) this.ledger.push({ id, count, damage });
  }

  /** The player broke a block (with this state byte): the client may now spawn what that block can drop. */
  creditBreak(blockId: number, meta = 0): void {
    const now = this.now();
    this.credits = this.credits.filter((c) => c.until > now);
    // The held tool and the client's random roll are not known here, so credit every possible drop at its highest count.
    for (const d of possibleBlockDrops(blockId, meta)) {
      if (this.credits.length < MAX_BREAK_CREDITS) this.credits.push({ id: d.id, count: d.count, until: now + CREDIT_TTL_MS });
    }
  }

  /** May this item entity be created from the player's `drop` request? Consumes the backing (nothing when refused). */
  authorizeDrop(id: number, count: number, damage?: number): boolean {
    const now = this.now();
    this.credits = this.credits.filter((c) => c.until > now && c.count > 0);
    // A block just broken explains the drop; whatever it does not cover must come out of the inventory (Q, death).
    let credited = 0;
    for (const c of this.credits) if (c.id === id) credited += c.count;
    const need = Math.max(0, count - credited);
    const have = this.pool.get(id) ?? 0;
    if (have < need) return false;
    let left = count - need;
    for (const c of this.credits) {
      if (c.id !== id || left === 0) continue;
      const n = Math.min(left, c.count);
      c.count -= n;
      left -= n;
    }
    this.credits = this.credits.filter((c) => c.count > 0);
    if (need === 0) return true;
    this.pool.set(id, have - need);
    if (this.ledger.length < MAX_LEDGER) this.ledger.push({ id, count: -need, damage });
    return true;
  }

  /** Validates a `state` inventory. Accepting makes it the new baseline. */
  check(raw: unknown): StateCheck {
    const parsed = parseInventory(raw);
    if (parsed.error) return { ok: false, reason: parsed.error, correction: this.correction() };
    const next = totals(parsed.stacks);
    if (this.trustNext) {
      this.trustNext = false;
      return this.accept(parsed.slots, next);
    }
    // Gains: the pool (including pickups) covers them or a recipe chain must produce them.
    const work = new Map(this.pool);
    const gains: number[] = [];
    for (const [id, n] of next) if (n > (this.pool.get(id) ?? 0)) gains.push(id);
    // Craft each gain from what the player had; ingredients are consumed from `work`, and the surplus of an
    // earlier craft (4 planks from 1 log) can cover a later gain.
    for (const id of gains) {
      const need = (next.get(id) ?? 0) - (work.get(id) ?? 0);
      if (need <= 0) continue;
      if (!this.craft(id, need, work, 0, next)) {
        const def = getItemDef(id);
        return { ok: false, reason: `${need} x ${def?.name ?? id} appeared without a pickup or recipe`, correction: this.correction() };
      }
      work.set(id, (work.get(id) ?? 0) + need); // the crafted items themselves
    }
    // Crafting consumes its ingredients: the new state may not still hold them.
    for (const [id, n] of next) {
      if (n > (work.get(id) ?? 0)) {
        const def = getItemDef(id);
        return { ok: false, reason: `${def?.name ?? id} was used in a recipe but is still there`, correction: this.correction() };
      }
    }
    return this.accept(parsed.slots, next);
  }

  /** Makes `count` of `id` from the pool `work`, crafting up to a few levels deep. */
  private craft(id: number, count: number, work: Map<number, number>, depth: number, keep: Map<number, number>): boolean {
    if (depth > MAX_CRAFT_DEPTH) return false;
    for (const recipe of RECIPES) {
      if (recipe.result.id !== id) continue;
      const crafts = Math.ceil(count / recipe.result.count);
      const trial = new Map(work);
      let ok = true;
      for (const ing of recipe.ingredients) {
        const need = ing.count * crafts;
        let left = need;
        // Take what the new state no longer holds first (oak planks kept, birch planks used), then craft a
        // missing intermediate, and only then dip into items the new state still holds.
        const take = (spareOnly: boolean) => {
          for (const alt of ing.ids) {
            const have = trial.get(alt) ?? 0;
            const free = spareOnly ? Math.min(have, have - (keep.get(alt) ?? 0)) : have;
            const used = Math.min(free, left);
            if (used > 0) { trial.set(alt, have - used); left -= used; }
            if (left === 0) break;
          }
        };
        take(true);
        if (left > 0 && depth < MAX_CRAFT_DEPTH) {
          for (const alt of ing.ids) {
            if (alt === id) continue;
            if (this.craft(alt, left, trial, depth + 1, keep)) { left = 0; break; }
          }
        }
        if (left > 0) take(false);
        if (left > 0) { ok = false; break; }
      }
      if (!ok) continue;
      // Commit the ingredient use and bank the crafted surplus.
      for (const [k, v] of trial) work.set(k, v);
      const surplus = crafts * recipe.result.count - count;
      if (surplus > 0) work.set(id, (work.get(id) ?? 0) + surplus);
      return true;
    }
    return false;
  }

  private accept(slots: Stack[], next: Map<number, number>): StateCheck {
    this.good = slots.map((s) => ({ ...s }));
    this.pool = next;
    this.ledger = [];
    return { ok: true, inventory: toRows(slots) };
  }

  /** The inventory the client should have: last accepted state plus approved pickups and drops. */
  correction(): number[][] {
    const slots = this.good.map((s) => ({ ...s }));
    for (const e of this.ledger) {
      if (e.count > 0) {
        const max = getItemDef(e.id)?.maxStack ?? 64;
        let left = e.count;
        for (const s of slots) {
          if (s.id === e.id && s.count < max && left > 0) { const n = Math.min(left, max - s.count); s.count += n; left -= n; }
        }
        for (let i = 0; i < INVENTORY_SLOTS && left > 0; i++) {
          if (i >= slots.length) slots.push({ id: 0, count: 0 });
          if (slots[i].id !== 0) continue;
          const n = Math.min(left, max);
          slots[i] = { id: e.id, count: n, damage: e.damage };
          left -= n;
        }
      } else {
        let left = -e.count;
        for (let i = slots.length - 1; i >= 0 && left > 0; i--) {
          if (slots[i].id !== e.id) continue;
          const n = Math.min(left, slots[i].count);
          slots[i].count -= n;
          if (slots[i].count === 0) slots[i] = { id: 0, count: 0 };
          left -= n;
        }
      }
    }
    return toRows(slots);
  }
}
