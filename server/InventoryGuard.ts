import { ARMOR_SLOTS, INVENTORY_SLOTS } from '../src/items/Inventory';
import { ALL_ITEMS, ITEM, type ToolKind, getItemDef, itemFromState, itemId, maxDurability, normalizeItem, possibleBlockDrops } from '../src/items/ItemRegistry';
import { RECIPES } from '../src/items/Recipes';
import { toolUse } from '../src/items/ToolUse';
import { BLOCK, BOX_KIND, SHAPE, SHAPE_DOOR, SHAPE_SLAB, VARIANT_MASK } from '../src/world/BlockRegistry';
import { SLAB_DOUBLE, SLAB_HALF_MASK } from '../src/world/BlockStates';
import { BOX_BED } from '../src/world/BoxShapes';

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
 * Placing a block is paid from the same pool (`authorizeEdit`): a block nobody holds (or can craft from what they
 * hold) is refused, so a modified client cannot place diamond ore and mine it for diamonds.
 *
 * What it cannot see: which crafting station was used and whether it was near (the client's
 * recipe book decides), tool damage resets, and moving items between slots (a pure rearrangement is always valid).
 */
export interface Stack {
  id: number;
  count: number;
  damage?: number;
  /** Per-stack data columns as sent (key index, value pairs: enchantments and such); passed through untouched. */
  extra?: number[];
}

/** A row is [id, count, damage, ...data pairs]: room for the enchantments, the repair cost and a custom name. */
const MAX_ROW_LENGTH = 40;

/**
 * Item changes that are not recipes: the enchanting table turns a book into an enchanted book, the grindstone turns it back.
 * The guard treats them as one-ingredient recipes.
 */
const CONVERSIONS: { result: number; from: number }[] = [
  { result: ITEM.ENCHANTED_BOOK, from: itemId('book') },
  { result: itemId('book'), from: ITEM.ENCHANTED_BOOK },
  // Buckets fill and empty in the world (the liquid itself is a block edit the server sees); milk comes from `mobused`.
  { result: ITEM.WATER_BUCKET, from: ITEM.BUCKET },
  { result: ITEM.LAVA_BUCKET, from: ITEM.BUCKET },
  { result: ITEM.BUCKET, from: ITEM.WATER_BUCKET },
  { result: ITEM.BUCKET, from: ITEM.LAVA_BUCKET },
  { result: ITEM.BUCKET, from: itemId('milk_bucket') },
  // Eating a stew leaves its bowl (food.returns).
  ...ALL_ITEMS.flatMap((id) => {
    const back = getItemDef(id)?.food?.returns;
    return back ? [{ result: itemId(back), from: id }] : [];
  }),
];

export type StateCheck = { ok: true; inventory: number[][] } | { ok: false; reason: string; correction: number[][] };

const CREDIT_TTL_MS = 60_000;
const MAX_BREAK_CREDITS = 256;
const MAX_LEDGER = 256;
const MAX_CRAFT_DEPTH = 3;

interface BreakCredit { id: number; count: number; until: number }

/** The second half of a door or bed that was just paid for: free once, at this spot, for a moment. */
interface Companion { x: number; y: number; z: number; id: number; until: number }
const COMPANION_TTL_MS = 3_000;

const REDSTONE_ITEM = itemId('redstone');
const TOOL_KINDS: readonly ToolKind[] = ['axe', 'shears', 'hoe', 'shovel'];

/** What a block edit costs the player who made it (see `classifyEdit`). */
export type EditCost =
  /** Breaking, toggling, a tool turning grass into farmland: nothing from the inventory. */
  | { kind: 'free' }
  /** A block placed from an item (one of `item`). */
  | { kind: 'place'; item: number }
  /** A full bucket poured out (the empty bucket comes back). */
  | { kind: 'pour'; bucket: number }
  /** A liquid source scooped up with an empty bucket. */
  | { kind: 'scoop'; bucket: number }
  /** A tool used on a block (`tool` of this kind needed), possibly dropping something (shears on a pumpkin). */
  | { kind: 'tool'; tool: ToolKind; drops?: { id: number; count: number } }
  /** A block no item places (fire, portals, the upper half of a door on its own...). */
  | { kind: 'refuse' };

/** The item that places this block state (variant bits kept, facing and other state bits dropped); 0 = none. */
export function placingItem(id: number, meta: number): number {
  if (id === BLOCK.REDSTONE_WIRE) return REDSTONE_ITEM;
  const item = normalizeItem(itemFromState(id, meta));
  return validItem(item) ? item : 0;
}

/**
 * What changing block `prev` into `id` costs, as the client's Interaction makes such changes in multiplayer (the
 * server itself grows plants, flows liquids, runs redstone and ignites TNT; those never arrive as a `block`).
 */
export function classifyEdit(prev: number, prevMeta: number, id: number, meta: number, above: number): EditCost {
  if (id === BLOCK.AIR) {
    // Scooping a source block with an empty bucket; anything else is breaking (credited separately).
    if ((prev === BLOCK.WATER || prev === BLOCK.LAVA) && prevMeta === 0) return { kind: 'scoop', bucket: prev === BLOCK.LAVA ? ITEM.LAVA_BUCKET : ITEM.WATER_BUCKET };
    return { kind: 'free' };
  }
  if (id === prev) {
    // A slab on a slab of the same kind makes a double slab: that is one more slab.
    if (SHAPE[id] === SHAPE_SLAB && (meta & SLAB_HALF_MASK) === SLAB_DOUBLE && (prevMeta & SLAB_HALF_MASK) !== SLAB_DOUBLE) {
      const item = placingItem(id, meta);
      return item ? { kind: 'place', item } : { kind: 'refuse' };
    }
    // Same block, other material or colour: no tool or click does that, so it is a new block.
    if ((meta & VARIANT_MASK[id]) !== (prevMeta & VARIANT_MASK[id])) {
      const item = placingItem(id, meta);
      return item ? { kind: 'place', item } : { kind: 'refuse' };
    }
    // Levers, doors, trapdoors, repeaters, a second chest joining, a bucket poured into flowing water of its kind.
    return { kind: 'free' };
  }
  if (id === BLOCK.WATER || id === BLOCK.LAVA) return { kind: 'pour', bucket: id === BLOCK.LAVA ? ITEM.LAVA_BUCKET : ITEM.WATER_BUCKET };
  for (const tool of TOOL_KINDS) {
    const use = toolUse(tool, prev, above);
    if (use && use.to === id) return { kind: 'tool', tool, drops: use.drops ? { id: itemId(use.drops.name), count: use.drops.count } : undefined };
  }
  const item = placingItem(id, meta);
  return item ? { kind: 'place', item } : { kind: 'refuse' };
}

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

/** Parses the stack on a player's cursor (`[]` or null = nothing). Same validation as an inventory row. */
export function parseCursor(raw: unknown): { stack: Stack | null; error?: string } {
  if (raw === undefined || raw === null || (Array.isArray(raw) && raw.length === 0)) return { stack: null };
  const parsed = parseInventory([raw]);
  if (parsed.error) return { stack: null, error: parsed.error };
  return { stack: parsed.stacks[0] ?? null };
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
  private companions: Companion[] = [];
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

  /**
   * Items moved out of a container into the player's hands (a chest slot picked up, a furnace output taken): they
   * belong to the pool from now on. Container transfers are neutral for the pool: what comes out of a container
   * goes in here, what the player puts in is taken out with `spendTransfer`, so a correct transfer passes the next
   * state check and an invented or duplicated stack does not.
   */
  creditTransfer(id: number, count: number, damage?: number): void {
    this.creditPickup(id, count, damage);
  }

  /**
   * A block edit by this player (survival). Pays for a placed block from the pool, crafting it on the spot when the
   * client crafted it after its last `state` (planks from a log, then placed at once). Returns false, changing nothing,
   * when the player could not have held the block. `at` and `above` are the position and the block above it (tools).
   */
  authorizeEdit(at: { x: number; y: number; z: number }, prev: number, prevMeta: number, id: number, meta: number, above: number): boolean {
    // Right after creative the pool is not known yet: the next state becomes the baseline anyway.
    if (this.trustNext) return true;
    const cost = classifyEdit(prev, prevMeta, id, meta, above);
    switch (cost.kind) {
      case 'free': return true;
      case 'refuse': return this.takeCompanion(at, id);
      case 'scoop':
        // Never refused (the liquid simply goes); the bucket fills when the pool has an empty one.
        if (this.take(ITEM.BUCKET)) this.give(cost.bucket, 1);
        return true;
      case 'pour':
        if (!this.take(cost.bucket)) return false;
        this.give(ITEM.BUCKET, 1);
        return true;
      case 'tool':
        // Tilling or stripping makes nothing out of nothing, so it is never refused (the tool may be freshly crafted);
        // what it drops (shears on a pumpkin) is only backed when the player has such a tool.
        if (cost.drops && this.holdsTool(cost.tool)) this.addBreakCredit(cost.drops.id, cost.drops.count);
        return true;
      case 'place': {
        // The other half of a door or bed placed a moment ago is part of the same item.
        if (this.takeCompanion(at, id)) return true;
        if (!this.take(cost.item)) return false;
        const now = this.now();
        this.companions = this.companions.filter((c) => c.until > now);
        if (SHAPE[id] === SHAPE_DOOR) this.companions.push({ x: at.x, y: at.y + 1, z: at.z, id, until: now + COMPANION_TTL_MS });
        else if (BOX_KIND[id] === BOX_BED) {
          for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) this.companions.push({ x: at.x + dx, y: at.y, z: at.z + dz, id, until: now + COMPANION_TTL_MS });
        }
        return true;
      }
    }
  }

  /** Is there a tool of this kind in the pool? */
  private holdsTool(kind: ToolKind): boolean {
    for (const [id, n] of this.pool) if (n > 0 && getItemDef(id)?.tool?.kind === kind) return true;
    return false;
  }

  private takeCompanion(at: { x: number; y: number; z: number }, id: number): boolean {
    const now = this.now();
    const i = this.companions.findIndex((c) => c.until > now && c.id === id && c.x === at.x && c.y === at.y && c.z === at.z);
    if (i < 0) return false;
    // A door or bed has one other half: the rest of its spots are void now.
    this.companions = [];
    return true;
  }

  private addBreakCredit(id: number, count: number): void {
    const now = this.now();
    this.credits = this.credits.filter((c) => c.until > now);
    if (this.credits.length < MAX_BREAK_CREDITS) this.credits.push({ id, count, until: now + CREDIT_TTL_MS });
  }

  /** Takes one `id` from the pool, crafting it from the pool when the client crafted it since its last state. */
  private take(id: number): boolean {
    const have = this.pool.get(id) ?? 0;
    if (have > 0) {
      this.pool.set(id, have - 1);
      if (this.ledger.length < MAX_LEDGER) this.ledger.push({ id, count: -1 });
      return true;
    }
    const work = new Map(this.pool);
    if (!this.craft(id, 1, work, 0, new Map(), false)) return false;
    // `craft` banks the surplus and leaves out the one item made for this placement: that one is used up now.
    for (const [k, v] of work) {
      const diff = v - (this.pool.get(k) ?? 0);
      if (diff !== 0 && this.ledger.length < MAX_LEDGER) this.ledger.push({ id: k, count: diff });
    }
    this.pool = work;
    return true;
  }

  private give(id: number, count: number): void {
    this.pool.set(id, (this.pool.get(id) ?? 0) + count);
    if (this.ledger.length < MAX_LEDGER) this.ledger.push({ id, count });
  }

  /** Items the player put into a container: they must be in the pool (they were part of the checked state/cursor). */
  spendTransfer(id: number, count: number, damage?: number): boolean {
    const have = this.pool.get(id) ?? 0;
    if (have < count) return false;
    this.pool.set(id, have - count);
    if (this.ledger.length < MAX_LEDGER) this.ledger.push({ id, count: -count, damage });
    return true;
  }

  /**
   * Validates a `state` inventory. Accepting makes it the new baseline. `cursor` is the stack on the mouse cursor of
   * an open container screen: it counts as held, so picking a stack up does not make items "disappear" (and putting
   * it back later is not an unexplained gain).
   */
  check(raw: unknown, cursor?: Stack | null): StateCheck {
    const parsed = parseInventory(raw);
    if (parsed.error) return { ok: false, reason: parsed.error, correction: this.correction() };
    const next = totals(cursor ? [...parsed.stacks, cursor] : parsed.stacks);
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
  private craft(id: number, count: number, work: Map<number, number>, depth: number, keep: Map<number, number>, conversions = true): boolean {
    if (depth > MAX_CRAFT_DEPTH) return false;
    // Conversions happen in the world (a bucket filled at a source): a placement pays with what the pool holds instead.
    for (const c of conversions ? CONVERSIONS : []) {
      if (c.result !== id) continue;
      const have = work.get(c.from) ?? 0;
      if (have >= count) {
        work.set(c.from, have - count);
        return true;
      }
    }
    for (const recipe of RECIPES) {
      // Smelting happens in real furnaces now: their output reaches the inventory as a container transfer.
      if (recipe.result.id !== id || recipe.station === 'furnace') continue;
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
            if (this.craft(alt, left, trial, depth + 1, keep, conversions)) { left = 0; break; }
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
