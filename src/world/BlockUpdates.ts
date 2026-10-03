import { BLOCK, CUBE_ID, SHAPE, SHAPE_CROSS, SHAPE_MODEL, SOLID } from './BlockRegistry';
import { chunkKey } from './constants';
import { isLiquid } from './Liquids';
import { GRAVITY, needsSupport, plantCanStand } from './PlantRules';

/**
 * Scheduled block updates: when a block changes, the blocks around it that care (sand that lost its support, a
 * sugar cane that lost its soil) are checked a tick or two later, like Minecraft's neighbour updates and scheduled
 * ticks. Also owns the falling blocks (sand and gravel that became entities).
 *
 * Pure, like LiquidSim: it works on a grid (the client World, the server's ServerWorld or a fake in tests) and keeps
 * its own queue. Bounded: a budget of checks per tick, a cap on the queue and on simultaneous falling blocks, and
 * everything is iterative, so a collapsing column of sand never recurses.
 */

export interface UpdateGrid {
  /** Unloaded or out-of-range cells must read as BLOCK.UNLOADED. */
  getBlock(x: number, y: number, z: number): number;
  getMeta(x: number, y: number, z: number): number;
  /** Change a block (the grid calls `notify` for it like for any other edit). */
  setState(x: number, y: number, z: number, id: number, meta: number): void;
}

export type BlockUpdateHandler = (sim: BlockUpdates, grid: UpdateGrid, x: number, y: number, z: number) => void;

/** A block in flight (Minecraft's FallingBlockEntity): 0.04 blocks/tick² gravity, 2 % drag per tick. */
export class FallingBlock {
  prevX: number; prevY: number; prevZ: number;
  vy = 0;
  age = 0;
  removed = false;
  constructor(readonly netId: number, readonly id: number, readonly meta: number, public x: number, public y: number, public z: number) {
    this.prevX = x; this.prevY = y; this.prevZ = z;
  }
}

export const FALL_GRAVITY = 0.04;
export const FALL_DRAG = 0.98;
/** Falling blocks alive at once; more sand than this waits where it is (and falls when there is room). */
export const MAX_FALLING = 128;
/** A falling block that has not landed after this many ticks (30 s) drops as an item. */
export const FALL_MAX_AGE = 600;
export const UPDATE_DELAY = 2;
export const MAX_CHECKS_PER_TICK = 400;
export const MAX_PENDING_CHECKS = 20_000;
const RING = 8;

/** Is the cell free for a block to fall into: air, liquid and small plants (torches, flowers). */
export function fallsThrough(id: number): boolean {
  if (id === BLOCK.AIR || isLiquid(id)) return true;
  const s = SHAPE[id];
  return (s === SHAPE_CROSS || s === SHAPE_MODEL) && SOLID[id] === 0;
}

const HANDLERS: (BlockUpdateHandler | null)[] = new Array<BlockUpdateHandler | null>(256).fill(null);
/** Blocks that want a check when something next to them changes (flat lookup for `notify`). */
const WATCHES = new Uint8Array(256);

/** Registers what a block does when updated (a neighbour changed). Other systems can add their own. */
export function registerBlockUpdate(blockId: number, handler: BlockUpdateHandler): void {
  HANDLERS[blockId] = handler;
  WATCHES[blockId] = 1;
}

function gravityUpdate(sim: BlockUpdates, grid: UpdateGrid, x: number, y: number, z: number): void {
  const id = grid.getBlock(x, y, z);
  if (GRAVITY[id] !== 1 || y < 1) return;
  if (!fallsThrough(grid.getBlock(x, y - 1, z))) return;
  if (sim.falling.length >= MAX_FALLING) {
    sim.schedule(x, y, z, UPDATE_DELAY);
    return;
  }
  const meta = grid.getMeta(x, y, z);
  grid.setState(x, y, z, BLOCK.AIR, 0);
  sim.spawnFalling(id, meta, x + 0.5, y, z + 0.5);
}

function supportUpdate(sim: BlockUpdates, grid: UpdateGrid, x: number, y: number, z: number): void {
  const id = grid.getBlock(x, y, z);
  if (!needsSupport(id)) return;
  if (plantCanStand(id, (a, b, c) => grid.getBlock(a, b, c), x, y, z)) return;
  const meta = grid.getMeta(x, y, z);
  grid.setState(x, y, z, BLOCK.AIR, 0);
  sim.onBroken?.(x, y, z, id, meta);
}

registerBlockUpdate(BLOCK.SAND, gravityUpdate);
registerBlockUpdate(BLOCK.GRAVEL, gravityUpdate);

/** Registers a block as gravity-affected (red sand lives in the content table, so Content-aware code calls this). */
export function registerGravityBlock(blockId: number): void {
  GRAVITY[blockId] = 1;
  registerBlockUpdate(blockId, gravityUpdate);
}
export function registerSupportedPlant(blockId: number): void {
  registerBlockUpdate(blockId, supportUpdate);
}

export interface BlockUpdateStats {
  checks: number;
  spawned: number;
  landed: number;
  dropped: number;
  deferred: number;
  refused: number;
}

export class BlockUpdates {
  readonly stats: BlockUpdateStats = { checks: 0, spawned: 0, landed: 0, dropped: 0, deferred: 0, refused: 0 };
  readonly falling: FallingBlock[] = [];
  /** A block was destroyed by the simulation (a plant uprooted, a torch under a landing block): the host may drop its item. */
  onBroken: ((x: number, y: number, z: number, id: number, meta: number) => void) | null = null;
  /** A falling block could not land (its cell got blocked) and becomes an item; (x, y, z) is the block cell. */
  onDropped: ((id: number, meta: number, x: number, y: number, z: number) => void) | null = null;
  /** A falling block started or landed (sound hooks). */
  onSpawn: ((f: FallingBlock) => void) | null = null;
  onLand: ((f: FallingBlock, x: number, y: number, z: number) => void) | null = null;

  private tickNo = 0;
  private nextId = 1;
  private readonly slots: number[][] = Array.from({ length: RING }, () => []);
  private readonly pending = new Map<number, number>();

  constructor(private readonly grid: UpdateGrid) {}

  get pendingCount(): number {
    return this.pending.size;
  }

  private static key(x: number, y: number, z: number): number {
    return chunkKey(x >> 4, z >> 4) * 32768 + ((x & 15) | ((z & 15) << 4) | (y << 8));
  }

  /** Queue a check of the block at (x, y, z) in `delay` ticks (an earlier one wins over a later one). */
  schedule(x: number, y: number, z: number, delay: number): void {
    if (y < 0 || y > 127) return;
    const key = BlockUpdates.key(x, y, z);
    const due = this.tickNo + Math.max(1, delay);
    const old = this.pending.get(key);
    if (old !== undefined && old <= due) return;
    if (old === undefined && this.pending.size >= MAX_PENDING_CHECKS) { this.stats.refused++; return; }
    this.pending.set(key, due);
    this.slots[due % RING].push(x, y, z, due);
  }

  /** The block at (x, y, z) changed: check it and the six blocks around it, if they care. */
  notify(x: number, y: number, z: number): void {
    const g = this.grid;
    if (WATCHES[g.getBlock(x, y, z)]) this.schedule(x, y, z, UPDATE_DELAY);
    if (WATCHES[g.getBlock(x, y + 1, z)]) this.schedule(x, y + 1, z, UPDATE_DELAY);
    if (WATCHES[g.getBlock(x, y - 1, z)]) this.schedule(x, y - 1, z, UPDATE_DELAY);
    if (WATCHES[g.getBlock(x + 1, y, z)]) this.schedule(x + 1, y, z, UPDATE_DELAY);
    if (WATCHES[g.getBlock(x - 1, y, z)]) this.schedule(x - 1, y, z, UPDATE_DELAY);
    if (WATCHES[g.getBlock(x, y, z + 1)]) this.schedule(x, y, z + 1, UPDATE_DELAY);
    if (WATCHES[g.getBlock(x, y, z - 1)]) this.schedule(x, y, z - 1, UPDATE_DELAY);
  }

  clear(): void {
    this.pending.clear();
    for (const s of this.slots) s.length = 0;
    this.falling.length = 0;
  }

  spawnFalling(id: number, meta: number, x: number, y: number, z: number): FallingBlock {
    const f = new FallingBlock(this.nextId++, id, meta, x, y, z);
    this.falling.push(f);
    this.stats.spawned++;
    this.onSpawn?.(f);
    return f;
  }

  /** One game tick (20 Hz): the checks that are due, then every falling block moves. */
  tick(): void {
    this.tickNo++;
    const slot = this.slots[this.tickNo % RING];
    if (slot.length > 0) {
      // Entries pushed while processing (the grid notifies us for every change) land in a fresh array.
      this.slots[this.tickNo % RING] = [];
      let budget = MAX_CHECKS_PER_TICK;
      for (let i = 0; i < slot.length; i += 4) {
        const x = slot[i], y = slot[i + 1], z = slot[i + 2], due = slot[i + 3];
        const key = BlockUpdates.key(x, y, z);
        if (this.pending.get(key) !== due) continue; // superseded by an earlier schedule
        if (budget <= 0) {
          // Out of budget: push to the next tick.
          this.pending.delete(key);
          this.schedule(x, y, z, 1);
          this.stats.deferred++;
          continue;
        }
        budget--;
        this.pending.delete(key);
        this.stats.checks++;
        HANDLERS[this.grid.getBlock(x, y, z)]?.(this, this.grid, x, y, z);
      }
    }
    this.moveFalling();
  }

  private moveFalling(): void {
    const g = this.grid;
    const list = this.falling;
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      if (f.removed) continue;
      const bx = Math.floor(f.x), bz = Math.floor(f.z);
      // Frozen while its column is not loaded.
      if (g.getBlock(bx, Math.max(0, Math.floor(f.y)), bz) === BLOCK.UNLOADED) continue;
      f.prevX = f.x; f.prevY = f.y; f.prevZ = f.z;
      f.age++;
      f.vy -= FALL_GRAVITY;
      const oldY = f.y;
      const newY = oldY + f.vy;
      f.vy *= FALL_DRAG;
      // The first solid surface crossed on the way down stops it: cells whose top lies in [newY, oldY].
      let landY = -1;
      const top = Math.floor(oldY) - 1;
      const bottom = Math.ceil(newY) - 1;
      for (let c = top; c >= bottom; c--) {
        if (c < 0 || !fallsThrough(g.getBlock(bx, c, bz))) { landY = c + 1; break; }
      }
      if (landY < 0) {
        f.y = newY;
        if (f.age > FALL_MAX_AGE) this.finish(f, bx, Math.floor(newY), bz, false);
        continue;
      }
      f.y = landY;
      this.finish(f, bx, landY, bz, true);
    }
    // Compact in place.
    let n = 0;
    for (let i = 0; i < list.length; i++) if (!list[i].removed) list[n++] = list[i];
    list.length = n;
  }

  /** The block lands as a block when its cell can take it, otherwise it drops as an item. */
  private finish(f: FallingBlock, x: number, y: number, z: number, landing: boolean): void {
    const g = this.grid;
    f.removed = true;
    const cur = y >= 0 && y < 128 ? g.getBlock(x, y, z) : BLOCK.UNLOADED;
    if (landing && fallsThrough(cur)) {
      // A torch or flower in the way breaks (Minecraft: it drops).
      if (cur !== BLOCK.AIR && !isLiquid(cur)) this.onBroken?.(x, y, z, cur, g.getMeta(x, y, z));
      g.setState(x, y, z, f.id, f.meta);
      this.stats.landed++;
      this.onLand?.(f, x, y, z);
    } else {
      this.stats.dropped++;
      this.onDropped?.(f.id, f.meta, x, y, z);
    }
  }
}

registerGravityBlock(CUBE_ID.red_sand);
registerSupportedPlant(BLOCK.SAPLING);
registerSupportedPlant(BLOCK.CACTUS);
registerSupportedPlant(CUBE_ID.sugar_cane);
