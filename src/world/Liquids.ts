import { BLOCK, SHAPE, SHAPE_CROSS, SHAPE_MODEL, SOLID } from './BlockRegistry';
import { chunkKey } from './constants';

/**
 * Water and lava flow, following Minecraft Java 1.21's FlowingFluid.
 *
 * A liquid block's state byte is Minecraft's legacy level: 0 = source, 1-7 = flowing (the amount of liquid is
 * 8 − level, so level 7 is the thinnest film), bit 3 = falling (a column of liquid under more liquid, full
 * height). Natural water and lava are plain sources (meta 0) and never tick on their own: a liquid only
 * ticks when a block next to it changes (`notify`), then re-schedules itself while it keeps changing.
 *
 * The simulation is pure: it works on a LiquidGrid (the client's World, the server's ServerWorld, or a fake
 * in tests) and keeps its own queue of scheduled ticks. Water ticks every 5 game ticks, lava every 30
 * (Minecraft's overworld values), at the game's 20 Hz. A per-tick budget on updates and block changes bounds
 * CPU and network use however large the flood is; whatever does not fit waits for the next tick.
 */

/** What the simulation needs from a world. Out-of-range or unloaded cells must read as BLOCK.UNLOADED (treated as solid). */
export interface LiquidGrid {
  getBlock(x: number, y: number, z: number): number;
  getMeta(x: number, y: number, z: number): number;
  /** Change a block (the grid should call `LiquidSim.notify` for the neighbours, like any other edit). */
  setState(x: number, y: number, z: number, id: number, meta: number): void;
}

export const LEVEL_MASK = 7;
export const FALLING_BIT = 8;
export const LIQUID_META_MASK = 15;

export function isLiquid(id: number): boolean {
  return id === BLOCK.WATER || id === BLOCK.LAVA;
}

/** Amount of liquid in a cell: 8 for sources and falling liquid, 7..1 for flowing. */
export function liquidAmount(meta: number): number {
  return meta & FALLING_BIT ? 8 : 8 - (meta & LEVEL_MASK);
}

export function liquidMeta(amount: number, falling: boolean): number {
  return falling ? FALLING_BIT : amount >= 8 ? 0 : 8 - amount;
}

export function isSourceMeta(meta: number): boolean {
  return meta === 0;
}

/**
 * Surface height of a liquid cell (0..1): amount / 9 like Minecraft, so a source stands at 8/9 of the block.
 * (Columns of liquid reach the full block through the "liquid above" rule in the mesher.)
 */
export function liquidHeight(meta: number): number {
  return liquidAmount(meta) / 9;
}

export const WATER_TICK_DELAY = 5;
export const LAVA_TICK_DELAY = 30;
const WATER_DROP_OFF = 1;
/** Overworld lava loses 2 per block, so it reaches 3 blocks from a source. */
const LAVA_DROP_OFF = 2;
const WATER_SLOPE_FIND = 4;
const LAVA_SLOPE_FIND = 2;

/** Updates per game tick and block changes per game tick (the changes are what reaches the network). */
export const MAX_UPDATES_PER_TICK = 600;
export const MAX_CHANGES_PER_TICK = 200;
/** Scheduled ticks kept at once; beyond this new ones are dropped (counted in stats.dropped). */
export const MAX_PENDING = 50_000;

/** Marks a direction the liquid cannot go in (a distance of 1000 means "no drop within reach"). */
const NO_WAY = 2000;
const RING = 64;
const DIRS_X = [0, 0, -1, 1];
const DIRS_Z = [-1, 1, 0, 0];
const OPPOSITE = [1, 0, 3, 2];

/** Blocks a liquid can flow into: air, plants and torches (anything that does not stop movement), and other liquid. */
export function holdsLiquid(id: number): boolean {
  if (id === BLOCK.AIR || isLiquid(id)) return true;
  const s = SHAPE[id];
  return s === SHAPE_CROSS || s === SHAPE_MODEL;
}

function dropOff(kind: number): number {
  return kind === BLOCK.LAVA ? LAVA_DROP_OFF : WATER_DROP_OFF;
}

function tickDelay(kind: number): number {
  return kind === BLOCK.LAVA ? LAVA_TICK_DELAY : WATER_TICK_DELAY;
}

export interface LiquidStats {
  /** Updates processed and block changes made over the lifetime of the simulation. */
  updates: number;
  changes: number;
  /** Scheduled ticks refused because the queue was full. */
  dropped: number;
  /** Entries pushed to a later tick because a tick's budget was used up. */
  deferred: number;
}

export class LiquidSim {
  readonly stats: LiquidStats = { updates: 0, changes: 0, dropped: 0, deferred: 0 };
  /** A block that was not air got replaced by liquid (plants and torches wash away): the caller may drop its item. */
  onDestroyed: ((x: number, y: number, z: number, id: number) => void) | null = null;
  /** Lava met water, or lava flowed onto it: a hook for the hiss. */
  onFizz: ((x: number, y: number, z: number) => void) | null = null;

  private tickNo = 0;
  private changesThisTick = 0;
  /** Scheduled positions per future tick (x, y, z triples), indexed by due tick mod RING. */
  private readonly slots: number[][] = Array.from({ length: RING }, () => []);
  /** Scheduled positions → the tick they are due (an earlier schedule overrides a later one, never the other way round). */
  private readonly pending = new Map<number, number>();
  private readonly slopeDist = [0, 0, 0, 0];

  constructor(private readonly grid: LiquidGrid) {}

  get pendingCount(): number {
    return this.pending.size;
  }

  /** Position key: chunk key × 32768 + the block index in the chunk (fits a double exactly). */
  private static key(x: number, y: number, z: number): number {
    return chunkKey(x >> 4, z >> 4) * 32768 + ((x & 15) | ((z & 15) << 4) | (y << 8));
  }

  /** Schedules the liquid at (x, y, z) to update after `delay` ticks, unless it is already scheduled as soon or sooner. */
  schedule(x: number, y: number, z: number, delay: number): void {
    const key = LiquidSim.key(x, y, z);
    const due = this.tickNo + Math.max(1, delay);
    const old = this.pending.get(key);
    if (old !== undefined && old <= due) return;
    if (old === undefined && this.pending.size >= MAX_PENDING) { this.stats.dropped++; return; }
    this.pending.set(key, due);
    this.slots[due % RING].push(x, y, z);
  }

  /** A block at (x, y, z) changed: the liquids in it and around it get a tick. */
  notify(x: number, y: number, z: number): void {
    this.touch(x, y, z);
    this.touch(x - 1, y, z); this.touch(x + 1, y, z);
    this.touch(x, y - 1, z); this.touch(x, y + 1, z);
    this.touch(x, y, z - 1); this.touch(x, y, z + 1);
  }

  private touch(x: number, y: number, z: number): void {
    if (y < 0 || y > 127) return;
    const id = this.grid.getBlock(x, y, z);
    if (!isLiquid(id)) return;
    // Lava next to water reacts almost at once; everything else at the liquid's own pace.
    this.schedule(x, y, z, id === BLOCK.LAVA && this.touchesWater(x, y, z) ? 1 : tickDelay(id));
  }

  /** Runs the updates that are due this tick, within the budget. Returns how many blocks changed. */
  tick(maxUpdates = MAX_UPDATES_PER_TICK, maxChanges = MAX_CHANGES_PER_TICK): number {
    // tickNo counts completed ticks; a delay of d scheduled between ticks runs on the d-th tick() after it.
    this.tickNo++;
    const slot = this.slots[this.tickNo % RING];
    this.changesThisTick = 0;
    let updates = 0;
    let i = 0;
    for (; i < slot.length; i += 3) {
      if (updates >= maxUpdates || this.changesThisTick >= maxChanges) break;
      const x = slot[i], y = slot[i + 1], z = slot[i + 2];
      this.pending.delete(LiquidSim.key(x, y, z));
      updates++;
      this.update(x, y, z);
    }
    if (i < slot.length) {
      // Out of budget: the rest goes to the next tick (still pending).
      const next = this.slots[(this.tickNo + 1) % RING];
      for (let j = i; j < slot.length; j++) next.push(slot[j]);
      this.stats.deferred += (slot.length - i) / 3;
    }
    slot.length = 0;
    this.stats.updates += updates;
    this.stats.changes += this.changesThisTick;
    return this.changesThisTick;
  }

  /** Forgets everything scheduled (a world was unloaded). */
  clear(): void {
    for (const s of this.slots) s.length = 0;
    this.pending.clear();
  }

  // ---------------------------------------------------------------- one liquid cell

  private set(x: number, y: number, z: number, id: number, meta: number): void {
    this.changesThisTick++;
    this.grid.setState(x, y, z, id, meta);
  }

  private update(x: number, y: number, z: number): void {
    const kind = this.grid.getBlock(x, y, z);
    if (!isLiquid(kind)) return;
    let meta = this.grid.getMeta(x, y, z);
    if (kind === BLOCK.LAVA && this.touchesWater(x, y, z)) {
      // Lava meets water: a source turns to obsidian, flowing lava to cobblestone.
      this.set(x, y, z, isSourceMeta(meta) ? BLOCK.OBSIDIAN : BLOCK.COBBLESTONE, 0);
      this.onFizz?.(x, y, z);
      return;
    }
    if (!isSourceMeta(meta)) {
      const next = this.newLiquid(x, y, z, kind);
      if (next < 0) {
        // Nothing feeds it any more: it dries up.
        this.set(x, y, z, BLOCK.AIR, 0);
        return;
      }
      if (next !== meta) {
        this.set(x, y, z, kind, next);
        this.schedule(x, y, z, tickDelay(kind));
        meta = next;
      }
    }
    this.spread(x, y, z, kind, meta);
  }

  /** Is there water above or beside this cell? (Minecraft's LiquidBlock.shouldSpreadLiquid, without soul soil.) */
  private touchesWater(x: number, y: number, z: number): boolean {
    const g = this.grid;
    return g.getBlock(x, y + 1, z) === BLOCK.WATER || g.getBlock(x - 1, y, z) === BLOCK.WATER || g.getBlock(x + 1, y, z) === BLOCK.WATER
      || g.getBlock(x, y, z - 1) === BLOCK.WATER || g.getBlock(x, y, z + 1) === BLOCK.WATER;
  }

  /**
   * What a cell holds of this liquid after one more update (FlowingFluid.getNewLiquid), as a state byte, or −1 for none:
   * two source neighbours over a solid floor (or a source) make a source (water only), liquid above makes it falling,
   * otherwise the strongest side neighbour minus the drop-off.
   */
  private newLiquid(x: number, y: number, z: number, kind: number): number {
    const g = this.grid;
    let highest = 0, sources = 0;
    for (let d = 0; d < 4; d++) {
      const nx = x + DIRS_X[d], nz = z + DIRS_Z[d];
      if (g.getBlock(nx, y, nz) !== kind) continue;
      const m = g.getMeta(nx, y, nz);
      if (isSourceMeta(m)) sources++;
      const a = liquidAmount(m);
      if (a > highest) highest = a;
    }
    if (kind === BLOCK.WATER && sources >= 2) {
      const below = g.getBlock(x, y - 1, z);
      if (SOLID[below] || (below === kind && isSourceMeta(g.getMeta(x, y - 1, z)))) return 0;
    }
    if (g.getBlock(x, y + 1, z) === kind) return FALLING_BIT;
    const amount = highest - dropOff(kind);
    return amount <= 0 ? -1 : liquidMeta(amount, false);
  }

  /** Is the cell an (unchanged) source of this liquid? Sources are not flowed through. */
  private isSourceOf(x: number, y: number, z: number, kind: number): boolean {
    return this.grid.getBlock(x, y, z) === kind && isSourceMeta(this.grid.getMeta(x, y, z));
  }

  /** Can the liquid `newKind` take the place of what is at the target (FluidState.canBeReplacedWith + canHoldFluid)? */
  private canSpreadTo(tx: number, ty: number, tz: number, down: boolean, newKind: number): boolean {
    const id = this.grid.getBlock(tx, ty, tz);
    if (isLiquid(id)) {
      if (id === BLOCK.WATER) return down && newKind !== BLOCK.WATER;
      // Lava is only displaced by water, and only while it is at least 4/9 deep.
      return newKind === BLOCK.WATER && liquidAmount(this.grid.getMeta(tx, ty, tz)) >= 4;
    }
    return holdsLiquid(id);
  }

  /** Can the cell below take (or already hold) this liquid: a hole the liquid will fall into. */
  private isHole(x: number, y: number, z: number, kind: number): boolean {
    const id = this.grid.getBlock(x, y, z);
    return id === kind || holdsLiquid(id);
  }

  private spreadTo(tx: number, ty: number, tz: number, kind: number, meta: number, down: boolean): void {
    const g = this.grid;
    const old = g.getBlock(tx, ty, tz);
    if (down && kind === BLOCK.LAVA && old === BLOCK.WATER) {
      // Lava falling onto water: stone and a hiss.
      this.set(tx, ty, tz, BLOCK.STONE, 0);
      this.onFizz?.(tx, ty, tz);
      return;
    }
    if (old !== BLOCK.AIR && !isLiquid(old)) this.onDestroyed?.(tx, ty, tz, old);
    this.set(tx, ty, tz, kind, meta);
  }

  /** FlowingFluid.spread: straight down first, otherwise sideways (towards the nearest drop within reach). */
  private spread(x: number, y: number, z: number, kind: number, meta: number): void {
    if (y <= 0) return;
    const by = y - 1;
    const belowNew = this.canSpreadTo(x, by, z, true, kind) ? this.newLiquid(x, by, z, kind) : -1;
    if (belowNew >= 0) {
      this.spreadTo(x, by, z, kind, belowNew, true);
      if (this.sourceNeighbours(x, y, z, kind) >= 3) this.spreadToSides(x, y, z, kind, meta);
    } else if (isSourceMeta(meta) || !this.isHole(x, by, z, kind)) {
      this.spreadToSides(x, y, z, kind, meta);
    }
  }

  private sourceNeighbours(x: number, y: number, z: number, kind: number): number {
    let n = 0;
    for (let d = 0; d < 4; d++) if (this.isSourceOf(x + DIRS_X[d], y, z + DIRS_Z[d], kind)) n++;
    return n;
  }

  private spreadToSides(x: number, y: number, z: number, kind: number, meta: number): void {
    // A falling liquid always has something to give sideways; a flowing one runs out at amount <= drop-off.
    if (!(meta & FALLING_BIT) && liquidAmount(meta) - dropOff(kind) <= 0) return;
    const dist = this.slopeDist;
    let best = 1000;
    for (let d = 0; d < 4; d++) {
      const tx = x + DIRS_X[d], tz = z + DIRS_Z[d];
      dist[d] = NO_WAY;
      if (!this.canPassThrough(tx, y, tz, kind)) continue;
      if (this.newLiquid(tx, y, tz, kind) < 0) continue;
      const j = this.isHole(tx, y - 1, tz, kind) ? 0 : this.slopeDistance(tx, y, tz, 1, OPPOSITE[d], kind);
      dist[d] = j;
      if (j < best) best = j;
    }
    // Only the directions with the shortest way to a drop get the liquid (all of them when none has a drop in reach).
    for (let d = 0; d < 4; d++) {
      if (dist[d] !== best) continue;
      const tx = x + DIRS_X[d], tz = z + DIRS_Z[d];
      const next = this.newLiquid(tx, y, tz, kind);
      if (next >= 0 && this.canSpreadTo(tx, y, tz, false, kind)) this.spreadTo(tx, y, tz, kind, next, false);
    }
  }

  /** The liquid may go sideways into this cell: it can hold liquid and is not already a source of the same kind. */
  private canPassThrough(x: number, y: number, z: number, kind: number): boolean {
    const id = this.grid.getBlock(x, y, z);
    if (id === kind && isSourceMeta(this.grid.getMeta(x, y, z))) return false;
    return holdsLiquid(id);
  }

  /** FlowingFluid.getSlopeDistance: steps to the nearest drop (within the slope find distance), 1000 if none. */
  private slopeDistance(x: number, y: number, z: number, distance: number, from: number, kind: number): number {
    let best = 1000;
    const reach = kind === BLOCK.LAVA ? LAVA_SLOPE_FIND : WATER_SLOPE_FIND;
    for (let d = 0; d < 4; d++) {
      if (d === from) continue;
      const nx = x + DIRS_X[d], nz = z + DIRS_Z[d];
      if (!this.canPassThrough(nx, y, nz, kind)) continue;
      if (this.isHole(nx, y - 1, nz, kind)) return distance;
      if (distance < reach) {
        const j = this.slopeDistance(nx, y, nz, distance + 1, OPPOSITE[d], kind);
        if (j < best) best = j;
      }
    }
    return best;
  }
}
