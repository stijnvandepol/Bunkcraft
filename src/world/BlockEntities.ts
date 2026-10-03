import { type FurnaceKind, COOK_TICKS, fuelRemainder, fuelTicks, smeltRecipe } from '../items/Smelting';
import { type ItemStack, cloneStack, getItemDef, sameItem, stackFromArray, stackToArray } from '../items/ItemRegistry';
import { type Rng, fillContainer, getLootTable, rollLoot, seededRng } from '../items/Loot';
import { BLOCK } from './BlockRegistry';

/**
 * Block entities: the data that belongs to a block position and does not fit in the id + state bytes of a chunk
 * (chest and furnace contents, later spawner, sign, bed and banner data). DOM-free and shared by the client
 * (singleplayer) and the multiplayer server, which owns the entities there.
 *
 * One `BlockEntityStore` per world keeps the entities by position. The world tells it about every block change
 * (`onBlockChange`): an entity is created when its block is placed and removed when the block goes (the contents
 * come out through `onDrops`). Entities that need a tick (a burning furnace) sit in an active list and only tick
 * while their chunk is loaded. The saved form is plain JSON (`SavedEntity`), used by the singleplayer save
 * (`WorldMeta.blockEntities`) and by the server's world.json.
 *
 * Kinds are registered with `registerBlockEntityKind`, so another system adds its own without touching this file.
 */

export const EMPTY_SLOT: ItemStack = Object.freeze({ id: 0, count: 0 }) as ItemStack;
const empty = (): ItemStack => ({ id: 0, count: 0 });

export const CHEST_SLOTS = 27;
export const DOUBLE_CHEST_SLOTS = 54;
export const FURNACE_SLOTS = 3;
/** Furnace slot indices. */
export const FURNACE_INPUT = 0;
export const FURNACE_FUEL = 1;
export const FURNACE_OUTPUT = 2;

/** Chest state bits: 0-1 facing, bit 2 = left/low half of a double chest, bit 3 = right/high half. */
export const CHEST_LOW_BIT = 4;
export const CHEST_HIGH_BIT = 8;
export const CHEST_DOUBLE_MASK = 12;

/** Saved form of one entity (JSON-able). */
export interface SavedEntity {
  /** Kind id (`'chest'`, `'furnace'`, ...). */
  k: string;
  /** Slots as `[id, count, damage, ...data]` records, trailing empty slots left out. */
  s?: number[][];
  /** Kind specific numbers (furnace: burn time, burn total, cook time, cook total, stored xp × 100). */
  d?: number[];
  /** Number of slots when it differs from the kind's default (a double chest has 54). */
  n?: number;
  /** A loot table to roll on first open (`[table id, seed]`). */
  l?: [string, number];
}

/** What the world offers an entity store. `setState` must go through the world's normal block change (sync, saving). */
export interface EntityHost {
  getBlock(x: number, y: number, z: number): number;
  getMeta(x: number, y: number, z: number): number;
  setState(x: number, y: number, z: number, id: number, meta: number): void;
}

/** Callbacks an entity uses to reach its world. */
export interface EntityHooks {
  /** The entity's slots or numbers changed (wakes the tick, marks the save and the open screens dirty). */
  changed(e: BlockEntity): void;
  /** A furnace started or stopped burning: the block must change between lit and unlit. */
  setLit(e: BlockEntity, lit: boolean): void;
  /** Experience was handed out (`takeXp`). */
  xp(amount: number, e: BlockEntity): void;
}

export abstract class BlockEntity {
  abstract readonly kind: string;
  slots: ItemStack[];
  /** Loot table and seed to roll on first open (generated structure chests). */
  loot: { table: string; seed: number } | null = null;
  hooks: EntityHooks | null = null;

  constructor(readonly x: number, readonly y: number, readonly z: number, size: number) {
    this.slots = Array.from({ length: size }, empty);
  }

  /** Call after changing `slots` or any number of the entity. */
  changed(): void {
    this.hooks?.changed(this);
  }

  /** Whether the entity needs `tick()` right now (a furnace that is burning or can start). */
  wantsTick(): boolean {
    return false;
  }

  tick(): void {}

  /** Kind specific numbers for the save (see `SavedEntity.d`). */
  data(): number[] | undefined {
    return undefined;
  }

  loadData(_d: number[]): void {}

  isEmpty(): boolean {
    return this.slots.every((s) => s.count === 0);
  }

  /** Everything inside, for when the block is broken. */
  contents(): ItemStack[] {
    return this.slots.filter((s) => s.count > 0).map(cloneStack);
  }

  serialize(): SavedEntity {
    let last = this.slots.length - 1;
    while (last >= 0 && this.slots[last].count === 0) last--;
    const out: SavedEntity = { k: this.kind };
    if (last >= 0) out.s = this.slots.slice(0, last + 1).map((s) => (s.count > 0 ? stackToArray(s) : [0, 0, 0]));
    const d = this.data();
    if (d) out.d = d;
    if (this.slots.length !== defaultSize(this.kind)) out.n = this.slots.length;
    if (this.loot) out.l = [this.loot.table, this.loot.seed];
    return out;
  }
}

export class ChestEntity extends BlockEntity {
  readonly kind = 'chest';
  constructor(x: number, y: number, z: number, size = CHEST_SLOTS) {
    super(x, y, z, size);
  }

  get isDouble(): boolean {
    return this.slots.length === DOUBLE_CHEST_SLOTS;
  }

  /** Grows a single chest into a double one (the new slots are empty). */
  extend(size: number): void {
    while (this.slots.length < size) this.slots.push(empty());
  }
}

/**
 * A furnace (Minecraft's AbstractFurnaceBlockEntity): input, fuel and output slot; a fuel item burns for its burn
 * time, cooking needs `COOK_TICKS` of burning, the result is added to the output and the experience of the recipe
 * is stored until the output is taken. Progress falls back at 2 ticks per tick when the fire is out.
 */
export class FurnaceEntity extends BlockEntity {
  readonly kind: string = 'furnace';
  /** Ticks of fire left and the burn time of the item that started it (the flame icon scale). */
  burnTime = 0;
  burnTotal = 0;
  /** Cooking progress and what it takes for the current item. */
  cookTime = 0;
  cookTotal: number;
  /** Experience waiting for the player (fractions add up, see `takeXp`). */
  xpStored = 0;
  /** Which furnace this is (blast furnace and smoker cook twice as fast but only metal / food). */
  furnaceKind: FurnaceKind = 'furnace';

  constructor(x: number, y: number, z: number, furnaceKind: FurnaceKind = 'furnace') {
    super(x, y, z, FURNACE_SLOTS);
    this.furnaceKind = furnaceKind;
    this.cookTotal = COOK_TICKS[furnaceKind];
  }

  get lit(): boolean {
    return this.burnTime > 0;
  }

  /** The result of the item in the input slot, or undefined (also when the output is full or holds something else). */
  private recipe() {
    const input = this.slots[FURNACE_INPUT];
    if (input.count === 0) return undefined;
    const r = smeltRecipe(input.id, this.furnaceKind);
    if (!r) return undefined;
    const out = this.slots[FURNACE_OUTPUT];
    if (out.count === 0) return r;
    const max = getItemDef(r.result.id)?.maxStack ?? 64;
    return out.id === r.result.id && !out.data && out.count + r.result.count <= max ? r : undefined;
  }

  wantsTick(): boolean {
    if (this.lit || this.cookTime > 0) return true;
    return this.slots[FURNACE_FUEL].count > 0 && fuelTicks(this.slots[FURNACE_FUEL].id) > 0 && !!this.recipe();
  }

  tick(): void {
    const wasLit = this.lit;
    let dirty = false;
    if (this.lit) { this.burnTime--; dirty = true; }
    const fuel = this.slots[FURNACE_FUEL];
    const recipe = this.recipe();
    if (this.lit || (fuel.count > 0 && recipe)) {
      if (!this.lit && recipe) {
        // Start a new fuel item: fuel is used up when the fire starts, not when it ends.
        const ticks = fuelTicks(fuel.id);
        if (ticks > 0) {
          this.burnTime = this.burnTotal = ticks;
          const rest = fuelRemainder(fuel.id);
          if (rest) this.slots[FURNACE_FUEL] = rest;
          else if (--fuel.count <= 0) this.slots[FURNACE_FUEL] = empty();
          dirty = true;
        }
      }
      if (this.lit && recipe) {
        this.cookTime++;
        dirty = true;
        if (this.cookTime >= this.cookTotal) {
          this.cookTime = 0;
          this.cookTotal = COOK_TICKS[this.furnaceKind];
          const out = this.slots[FURNACE_OUTPUT];
          if (out.count === 0) this.slots[FURNACE_OUTPUT] = cloneStack(recipe.result);
          else out.count += recipe.result.count;
          if (--this.slots[FURNACE_INPUT].count <= 0) this.slots[FURNACE_INPUT] = empty();
          this.xpStored += recipe.xp * recipe.result.count;
        }
      } else if (this.cookTime !== 0) {
        this.cookTime = 0;
        dirty = true;
      }
    } else if (this.cookTime > 0) {
      this.cookTime = Math.max(0, this.cookTime - 2);
      dirty = true;
    }
    if (wasLit !== this.lit) this.hooks?.setLit(this, this.lit);
    if (dirty) this.changed();
  }

  /**
   * The player takes the output: all stored experience is handed out (whole points, the fraction is a chance for one
   * more, like Minecraft) and the store is emptied. Returns the amount.
   */
  takeXp(rng: Rng = Math.random): number {
    if (this.xpStored <= 0) return 0;
    let amount = Math.floor(this.xpStored);
    if (rng() < this.xpStored - amount) amount++;
    this.xpStored = 0;
    this.changed();
    if (amount > 0) this.hooks?.xp(amount, this);
    return amount;
  }

  /** Progress 0..1 of the cooking arrow and the remaining flame 0..1 (for the screen). */
  get progress(): number {
    return this.cookTotal > 0 ? Math.min(1, this.cookTime / this.cookTotal) : 0;
  }

  get flame(): number {
    return this.burnTotal > 0 ? Math.min(1, this.burnTime / this.burnTotal) : 0;
  }

  data(): number[] {
    return [this.burnTime, this.burnTotal, this.cookTime, this.cookTotal, Math.round(this.xpStored * 100), KIND_INDEX.indexOf(this.furnaceKind)];
  }

  loadData(d: number[]): void {
    const n = (i: number, max: number): number => (Number.isFinite(d[i]) ? Math.max(0, Math.min(max, Math.floor(d[i]))) : 0);
    this.burnTime = n(0, 1_000_000);
    this.burnTotal = n(1, 1_000_000);
    this.cookTime = n(2, 10_000);
    this.cookTotal = n(3, 10_000) || COOK_TICKS[this.furnaceKind];
    this.xpStored = n(4, 1_000_000) / 100;
  }
}

const KIND_INDEX: FurnaceKind[] = ['furnace', 'blast', 'smoker'];

// ---------------------------------------------------------------- kind registry

export interface BlockEntityKind {
  kind: string;
  /** Block ids that carry this kind of entity. */
  blocks: number[];
  /** Default slot count. */
  size: number;
  create(x: number, y: number, z: number, size?: number): BlockEntity;
}

const KINDS = new Map<string, BlockEntityKind>();
const KIND_OF_BLOCK = new Map<number, BlockEntityKind>();

export function registerBlockEntityKind(def: BlockEntityKind): void {
  KINDS.set(def.kind, def);
  for (const b of def.blocks) KIND_OF_BLOCK.set(b, def);
}

function defaultSize(kind: string): number {
  return KINDS.get(kind)?.size ?? 0;
}

/** The entity kind a block carries, or undefined for ordinary blocks. */
export function entityKindOf(blockId: number): string | undefined {
  return KIND_OF_BLOCK.get(blockId)?.kind;
}

registerBlockEntityKind({ kind: 'chest', blocks: [BLOCK.CHEST], size: CHEST_SLOTS, create: (x, y, z, size) => new ChestEntity(x, y, z, size) });
registerBlockEntityKind({
  kind: 'furnace', blocks: [BLOCK.FURNACE, BLOCK.LIT_FURNACE], size: FURNACE_SLOTS, create: (x, y, z) => new FurnaceEntity(x, y, z),
});

// ---------------------------------------------------------------- the store

/** A container found at a block position: the entity that holds the slots (the left half for a double chest). */
export interface ContainerRef {
  entity: BlockEntity;
  kind: 'chest' | 'furnace';
  title: string;
  /** Position of the entity (for a double chest the low half, which may differ from the clicked block). */
  x: number; y: number; z: number;
}

/** Entities more than this are not created (a server must not grow without bound). */
export const MAX_BLOCK_ENTITIES = 20000;

const key = (x: number, y: number, z: number): string => `${x},${y},${z}`;

export class BlockEntityStore {
  private readonly map = new Map<string, BlockEntity>();
  /** Entities that need ticking now. */
  private readonly active = new Set<BlockEntity>();
  /** Contents of a removed block, to throw into the world (the host decides: survival drops, creative does not). */
  onDrops: ((x: number, y: number, z: number, stacks: ItemStack[]) => void) | null = null;
  /** Experience handed out when a furnace output was taken. */
  onXpAwarded: ((amount: number, x: number, y: number, z: number) => void) | null = null;
  /** Slots or numbers of an entity changed (the multiplayer server broadcasts to open screens, saves and so on). */
  onChanged: ((e: BlockEntity) => void) | null = null;
  /** An entity is gone (its screens must close). */
  onRemoved: ((e: BlockEntity) => void) | null = null;
  /** Structure generators: loot (table + seed) for a chest that was never touched, by position; null = an ordinary chest. */
  lootAt: ((x: number, y: number, z: number) => { table: string; seed: number } | null) | null = null;
  /** Set when anything that is saved changed since `clearDirty()`. */
  dirty = false;
  /** Off on a multiplayer client: the server owns the entities and the client store stays empty. */
  enabled = true;
  maxEntities = MAX_BLOCK_ENTITIES;

  private readonly hooks: EntityHooks;

  constructor(private readonly host: EntityHost) {
    this.hooks = {
      changed: (e) => {
        this.dirty = true;
        if (e.wantsTick()) this.active.add(e);
        this.onChanged?.(e);
      },
      setLit: (e, lit) => {
        const id = this.host.getBlock(e.x, e.y, e.z);
        if (id !== BLOCK.FURNACE && id !== BLOCK.LIT_FURNACE) return;
        const target = lit ? BLOCK.LIT_FURNACE : BLOCK.FURNACE;
        if (id !== target) this.host.setState(e.x, e.y, e.z, target, this.host.getMeta(e.x, e.y, e.z));
      },
      xp: (amount, e) => this.onXpAwarded?.(amount, e.x, e.y, e.z),
    };
  }

  get size(): number {
    return this.map.size;
  }

  get activeCount(): number {
    return this.active.size;
  }

  entities(): IterableIterator<BlockEntity> {
    return this.map.values();
  }

  get(x: number, y: number, z: number): BlockEntity | undefined {
    return this.map.get(key(x, y, z));
  }

  private add(e: BlockEntity): BlockEntity {
    e.hooks = this.hooks;
    this.map.set(key(e.x, e.y, e.z), e);
    this.dirty = true;
    if (e.wantsTick()) this.active.add(e);
    return e;
  }

  private delete(e: BlockEntity): void {
    this.map.delete(key(e.x, e.y, e.z));
    this.active.delete(e);
    this.dirty = true;
    this.onRemoved?.(e);
  }

  /** Creates the entity of the block at a position when it is missing (null for a block without one, or at the cap). */
  ensure(x: number, y: number, z: number, size?: number): BlockEntity | null {
    const existing = this.map.get(key(x, y, z));
    const id = this.host.getBlock(x, y, z);
    const def = KIND_OF_BLOCK.get(id);
    if (!def) return null;
    if (existing) {
      if (existing.kind !== def.kind) return null;
      if (size && existing instanceof ChestEntity) existing.extend(size);
      return existing;
    }
    if (this.map.size >= this.maxEntities) return null;
    const e = this.add(def.create(x, y, z, size));
    // A chest of a generated structure that nobody opened yet gets its loot on first use.
    const loot = def.kind === 'chest' ? this.lootAt?.(x, y, z) : null;
    if (loot) e.loot = loot;
    return e;
  }

  /** The (validated) partner of a double chest half, or null for a single chest. */
  pairOf(x: number, y: number, z: number): { low: [number, number]; high: [number, number] } | null {
    if (this.host.getBlock(x, y, z) !== BLOCK.CHEST) return null;
    const meta = this.host.getMeta(x, y, z);
    if ((meta & CHEST_DOUBLE_MASK) === 0 || (meta & CHEST_DOUBLE_MASK) === CHEST_DOUBLE_MASK) return null;
    const facing = meta & 3;
    const dx = facing < 2 ? 1 : 0, dz = facing < 2 ? 0 : 1;
    const isLow = (meta & CHEST_LOW_BIT) !== 0;
    const px = x + (isLow ? dx : -dx), pz = z + (isLow ? dz : -dz);
    if (this.host.getBlock(px, y, pz) !== BLOCK.CHEST) return null;
    const pm = this.host.getMeta(px, y, pz);
    // The partner must face the same way and be the other half.
    if ((pm & 3) !== facing || (pm & CHEST_DOUBLE_MASK) !== (isLow ? CHEST_HIGH_BIT : CHEST_LOW_BIT)) return null;
    return isLow ? { low: [x, z], high: [px, pz] } : { low: [px, pz], high: [x, z] };
  }

  /** The container at a block position, creating its entity on first use (a double chest resolves to its shared entity). */
  containerAt(x: number, y: number, z: number): ContainerRef | null {
    const id = this.host.getBlock(x, y, z);
    if (id === BLOCK.CHEST) {
      const pair = this.pairOf(x, y, z);
      if (pair) this.mergePair(x, y, z);
      const [ex, ez] = pair ? pair.low : [x, z];
      const entity = this.ensure(ex, y, ez, pair ? DOUBLE_CHEST_SLOTS : CHEST_SLOTS);
      if (!entity) return null;
      // A double chest whose second half still had its own entity (placed before pairing) was merged in onBlockChange.
      this.rollLoot(entity);
      return { entity, kind: 'chest', title: pair ? 'Large Chest' : 'Chest', x: ex, y, z: ez };
    }
    if (id === BLOCK.FURNACE || id === BLOCK.LIT_FURNACE) {
      const entity = this.ensure(x, y, z);
      return entity ? { entity, kind: 'furnace', title: 'Furnace', x, y, z } : null;
    }
    return null;
  }

  /** Rolls the loot table of a chest that has one (first open); the same table and seed always give the same chest. */
  private rollLoot(e: BlockEntity): void {
    if (!e.loot) return;
    const table = getLootTable(e.loot.table);
    const rng = seededRng(e.loot.seed);
    e.loot = null;
    if (!table) return;
    fillContainer(e.slots, rollLoot(table, rng), rng);
    e.changed();
  }

  /** Marks a chest (a structure generator placed it) to roll a loot table when first opened. */
  setLoot(x: number, y: number, z: number, table: string, seed: number): boolean {
    const e = this.ensure(x, y, z);
    if (!e || !(e instanceof ChestEntity) || !e.isEmpty()) return false;
    e.loot = { table, seed };
    this.dirty = true;
    return true;
  }

  /**
   * The world calls this for every block change at a position. Creates the entity of a newly placed container block,
   * removes it (dropping the contents) when the block went away, and re-pairs chests that become or stop being a
   * double chest.
   */
  onBlockChange(x: number, y: number, z: number, prevId: number, prevMeta: number, id: number, meta: number): void {
    const prevKind = KIND_OF_BLOCK.get(prevId)?.kind;
    const newKind = KIND_OF_BLOCK.get(id)?.kind;
    if (prevKind && prevKind !== newKind) {
      this.removeAt(x, y, z, prevId, prevMeta);
    } else if (prevKind === 'chest' && id === BLOCK.CHEST && (prevMeta & CHEST_DOUBLE_MASK) !== (meta & CHEST_DOUBLE_MASK)) {
      // A half of a double chest was edited by hand (the partner fix after a break): re-pair what is there now.
      if ((meta & CHEST_DOUBLE_MASK) !== 0) this.mergePair(x, y, z);
    }
    if (newKind && !prevKind) {
      this.ensure(x, y, z);
      if (newKind === 'chest' && (meta & CHEST_DOUBLE_MASK)) this.mergePair(x, y, z);
    }
  }

  /** The block at a position was a container and is not any more. */
  private removeAt(x: number, y: number, z: number, prevId: number, prevMeta: number): void {
    if (prevId === BLOCK.CHEST && (prevMeta & CHEST_DOUBLE_MASK)) {
      this.breakDoubleHalf(x, y, z, prevMeta);
      return;
    }
    const e = this.map.get(key(x, y, z));
    if (!e) return;
    this.delete(e);
    this.drop(x, y, z, e.contents());
  }

  private drop(x: number, y: number, z: number, stacks: ItemStack[]): void {
    if (stacks.length > 0) this.onDrops?.(x, y, z, stacks);
  }

  /** One half of a double chest is gone: its 27 slots drop, the other half keeps its 27 and becomes a single chest. */
  private breakDoubleHalf(x: number, y: number, z: number, meta: number): void {
    const facing = meta & 3;
    const dx = facing < 2 ? 1 : 0, dz = facing < 2 ? 0 : 1;
    const isLow = (meta & CHEST_LOW_BIT) !== 0;
    const lowX = isLow ? x : x - dx, lowZ = isLow ? z : z - dz;
    const highX = lowX + dx, highZ = lowZ + dz;
    const shared = this.map.get(key(lowX, y, lowZ));
    const partnerX = isLow ? highX : lowX, partnerZ = isLow ? highZ : lowZ;
    if (shared instanceof ChestEntity && shared.slots.length === DOUBLE_CHEST_SLOTS) {
      const lowSlots = shared.slots.slice(0, CHEST_SLOTS), highSlots = shared.slots.slice(CHEST_SLOTS);
      const gone = isLow ? lowSlots : highSlots;
      const kept = isLow ? highSlots : lowSlots;
      this.delete(shared);
      const survivor = new ChestEntity(partnerX, y, partnerZ);
      survivor.slots = kept;
      if (shared.loot) survivor.loot = shared.loot;
      this.add(survivor);
      this.drop(x, y, z, gone.filter((s) => s.count > 0).map(cloneStack));
    } else {
      // No shared entity (never opened): the broken half's own entity, if any.
      const own = this.map.get(key(x, y, z));
      if (own) { this.delete(own); this.drop(x, y, z, own.contents()); }
    }
    // The other half is a single chest again.
    if (this.host.getBlock(partnerX, y, partnerZ) === BLOCK.CHEST) {
      const pm = this.host.getMeta(partnerX, y, partnerZ);
      if (pm & CHEST_DOUBLE_MASK) this.host.setState(partnerX, y, partnerZ, BLOCK.CHEST, pm & 3);
    }
  }

  /** Two single chests became a double one: their slots join in one entity at the low half (27 + 27). */
  private mergePair(x: number, y: number, z: number): void {
    const pair = this.pairOf(x, y, z);
    if (!pair) return;
    const lowKey = key(pair.low[0], y, pair.low[1]), highKey = key(pair.high[0], y, pair.high[1]);
    const low = this.map.get(lowKey), high = this.map.get(highKey);
    if (!low && !high) return;
    let merged: ChestEntity;
    if (low instanceof ChestEntity && low.slots.length === DOUBLE_CHEST_SLOTS) {
      merged = low;
    } else {
      merged = new ChestEntity(pair.low[0], y, pair.low[1], DOUBLE_CHEST_SLOTS);
      if (low) { for (let i = 0; i < Math.min(CHEST_SLOTS, low.slots.length); i++) merged.slots[i] = low.slots[i]; merged.loot = low.loot; this.delete(low); }
    }
    if (high instanceof ChestEntity) {
      if (high.slots.length === DOUBLE_CHEST_SLOTS) { this.delete(high); } else {
        for (let i = 0; i < high.slots.length; i++) if (high.slots[i].count > 0) merged.slots[CHEST_SLOTS + i] = high.slots[i];
        merged.loot ??= high.loot;
        this.delete(high);
      }
    }
    if (merged !== low) this.add(merged);
    merged.changed();
  }

  // ---------------------------------------------------------------- ticking

  /** One 20 Hz tick of every active entity whose chunk is loaded. */
  tick(): void {
    if (!this.enabled) return;
    for (const e of this.active) {
      const id = this.host.getBlock(e.x, e.y, e.z);
      if (id === 255) continue; // chunk not loaded: the furnace waits (BLOCK.UNLOADED)
      if (KIND_OF_BLOCK.get(id)?.kind !== e.kind) {
        // The block was replaced behind our back (a generator, an old save): drop the entity and its items.
        this.delete(e);
        this.drop(e.x, e.y, e.z, e.contents());
        continue;
      }
      e.tick();
      if (!e.wantsTick()) this.active.delete(e);
    }
  }

  // ---------------------------------------------------------------- saving

  /** Saved form of every entity worth keeping (empty ones stay as bare `{k}` records so they remain "known"). */
  serialize(): Record<string, SavedEntity> | undefined {
    if (this.map.size === 0) return undefined;
    const out: Record<string, SavedEntity> = {};
    for (const [k, e] of this.map) out[k] = e.serialize();
    return out;
  }

  /** Replaces everything with saved entities; unknown kinds and malformed records are dropped. */
  load(saved: Record<string, SavedEntity> | undefined): void {
    this.map.clear();
    this.active.clear();
    this.dirty = false;
    if (!saved || typeof saved !== 'object') return;
    for (const [k, rec] of Object.entries(saved)) {
      if (this.map.size >= this.maxEntities) break;
      const m = /^(-?\d+),(-?\d+),(-?\d+)$/.exec(k);
      if (!m || !rec || typeof rec.k !== 'string') continue;
      const def = KINDS.get(rec.k);
      if (!def) continue;
      const size = Math.max(1, Math.min(DOUBLE_CHEST_SLOTS, Number.isInteger(rec.n) ? (rec.n as number) : def.size));
      const e = def.create(Number(m[1]), Number(m[2]), Number(m[3]), size);
      if (Array.isArray(rec.s)) {
        for (let i = 0; i < Math.min(size, rec.s.length); i++) {
          const row = rec.s[i];
          const s = Array.isArray(row) ? stackFromArray(row) : null;
          if (s && s.count <= (getItemDef(s.id)?.maxStack ?? 0)) e.slots[i] = s;
        }
      }
      if (Array.isArray(rec.d)) e.loadData(rec.d.map(Number));
      if (Array.isArray(rec.l) && typeof rec.l[0] === 'string' && Number.isFinite(rec.l[1])) e.loot = { table: rec.l[0], seed: rec.l[1] };
      this.add(e);
    }
    this.dirty = false;
  }

  clear(): void {
    this.map.clear();
    this.active.clear();
  }
}

/** Adds a stack to a list of slots (merging first, then empty slots); returns how many items did not fit. */
export function insertIntoSlots(slots: ItemStack[], stack: ItemStack, from = 0, to = slots.length): number {
  const max = getItemDef(stack.id)?.maxStack ?? 64;
  let left = stack.count;
  for (let i = from; i < to && left > 0 && max > 1; i++) {
    if (slots[i].count > 0 && sameItem(slots[i], stack) && slots[i].count < max) {
      const n = Math.min(left, max - slots[i].count);
      slots[i].count += n;
      left -= n;
    }
  }
  for (let i = from; i < to && left > 0; i++) {
    if (slots[i].count === 0) {
      const n = Math.min(left, max);
      slots[i] = { ...cloneStack(stack), count: n };
      left -= n;
    }
  }
  return left;
}
