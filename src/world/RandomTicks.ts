import { CHUNK_HEIGHT } from './constants';

/**
 * Random ticks (Minecraft's randomTickSpeed): every game tick, in every loaded chunk section near a player,
 * `randomTickSpeed` (default 3) random blocks get a random tick. A block type reacts when a handler is registered
 * for it; that is where plants grow, leaves decay and grass spreads (see Growth.ts).
 *
 * DOM-free and shared: singleplayer (`World`) and multiplayer (`ServerWorld`) both drive one RandomTicker through
 * a small RandomTickHost, so the rules cannot drift apart. The hot loop uses a flat id → handler table and a
 * 12-bit position per pick (one RNG call), and allocates nothing.
 *
 * Registering behaviour for a new block (farmland, crops, ...), from anywhere, before the world ticks:
 *
 *     RandomTicker.register(CUBE_ID.farmland, (w, x, y, z) => { ... w.setBlock(x, y, z, id, meta) ... });
 */

/** What a handler may do. Implemented by RandomTicker; coordinates are world coordinates. */
export interface TickContext {
  getBlock(x: number, y: number, z: number): number;
  getMeta(x: number, y: number, z: number): number;
  /** Packed light (sky << 4 | block) as the world stores it (no time of day applied). */
  getLight(x: number, y: number, z: number): number;
  /** Minecraft's getMaxLocalRawBrightness: max(sky − current darkness, block light), 0..15. */
  brightness(x: number, y: number, z: number): number;
  /** Changes a block (broadcast, saved and remeshed by the host). Counts towards the per-tick change cap. */
  setBlock(x: number, y: number, z: number, id: number, meta?: number): void;
  /** Changes only the state byte without a visual update (growth ages, sapling stage): saved, not broadcast. */
  setMeta(x: number, y: number, z: number, meta: number): void;
  /** Removes a block as if it was broken without a tool: the host may drop its item. */
  breakBlock(x: number, y: number, z: number): void;
  /** Uniform random float in [0, 1). */
  random(): number;
  /** Uniform random integer in [0, n). */
  randomInt(n: number): number;
  /** Biome id of a column (see Biomes.ts); plains when the host does not know. */
  biomeAt(x: number, z: number): number;
}

export type RandomTickHandler = (w: TickContext, x: number, y: number, z: number) => void;
/** A handler for the topmost block of a random column (snow and ice style effects). */
export type SurfaceHandler = (w: TickContext, x: number, y: number, z: number, id: number) => void;

/** Random source: one uint32 per call. Injectable so tests are deterministic. */
export interface TickRng {
  nextU32(): number;
}

/** xorshift32: tiny and fast, plenty for picking blocks. */
export class XorShift32 implements TickRng {
  private s: number;
  constructor(seed = (Math.random() * 4294967296) >>> 0) {
    this.s = seed | 0 || 0x9e3779b9;
  }
  nextU32(): number {
    let s = this.s;
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    this.s = s;
    return s >>> 0;
  }
}

/** What the ticker needs from a world. */
export interface RandomTickHost {
  /** Block array of a loaded chunk (index x | z << 4 | y << 8), null when it is not loaded. */
  chunkBlocks(cx: number, cz: number): Uint8Array | null;
  getBlock(x: number, y: number, z: number): number;
  getMeta(x: number, y: number, z: number): number;
  getLight(x: number, y: number, z: number): number;
  /** Writes a block; `quiet` = state change only (no remesh, no broadcast). */
  setState(x: number, y: number, z: number, id: number, meta: number, quiet: boolean): void;
  /** A block was removed by the simulation (plant uprooted, leaves decayed): the host may drop what it would drop. */
  dropBlock?(id: number, meta: number, x: number, y: number, z: number): void;
  biomeAt?(x: number, z: number): number;
  /** Sky light that time of day and weather take away, 0..11. */
  skyDarkness?(): number;
  /** Called around a whole tick so mesh updates can be batched per chunk. */
  begin?(): void;
  end?(): void;
  /** Clock in ms; defaults to performance.now. */
  now?(): number;
}

export interface RandomTickOptions {
  rng?: TickRng;
  /** Picks per 16³ section per tick. */
  speed?: number;
  /** Chunk radius around each player. */
  radius?: number;
  /** Stop for this tick after this many milliseconds (resumes where it stopped next tick). */
  budgetMs?: number;
  /** Stop for this tick after this many block changes (bounds network traffic and remeshing). */
  maxChanges?: number;
}

export interface RandomTickStats {
  /** Time of the last tick, ms. */
  lastMs: number;
  /** Picks and handler calls over the last tick. */
  picks: number;
  handled: number;
  changes: number;
  /** Ticks that stopped early because of the time budget or the change cap, over the lifetime. */
  skipped: number;
  ticks: number;
}

export const DEFAULT_RANDOM_TICK_SPEED = 3;
export const SECTIONS = CHUNK_HEIGHT >> 4;
const MAX_PLAYERS = 64;
const SURFACE_CHANCE_SHIFT = 4; // 1 in 16 chunks per tick get a surface pass, like Minecraft's ice and snow

/** Flat tables: does this block id have behaviour on a random tick, and what is it. */
export const HAS_RANDOM_TICK = new Uint8Array(256);
const HANDLERS: (RandomTickHandler | null)[] = new Array<RandomTickHandler | null>(256).fill(null);
const SURFACE: SurfaceHandler[] = [];

/** Pick a position inside a section from 12 random bits: x | z << 4 | y << 8 (y within the section). */
const POS_MASK = 0xfff;

export class RandomTicker implements TickContext {
  /** Registers (or replaces) what a block does on a random tick. Applies to every ticker, all worlds. */
  static register(blockId: number, handler: RandomTickHandler): void {
    HANDLERS[blockId] = handler;
    HAS_RANDOM_TICK[blockId] = 1;
  }

  static unregister(blockId: number): void {
    HANDLERS[blockId] = null;
    HAS_RANDOM_TICK[blockId] = 0;
  }

  /** Registers a handler that runs for the top block of a random column, about once per 16 chunks per tick. */
  static registerSurface(handler: SurfaceHandler): void {
    if (!SURFACE.includes(handler)) SURFACE.push(handler);
  }

  static handlerOf(blockId: number): RandomTickHandler | null {
    return HANDLERS[blockId];
  }

  /** `/gamerule randomTickSpeed <n>`: picks per section per tick (0 turns random ticks off). */
  speed: number;
  radius: number;
  budgetMs: number;
  maxChanges: number;
  rng: TickRng;
  readonly stats: RandomTickStats = { lastMs: 0, picks: 0, handled: 0, changes: 0, skipped: 0, ticks: 0 };

  private changes = 0;
  /** Where the chunk walk resumes after a tick that ran out of time. */
  private cursor = 0;
  private readonly pcx = new Int32Array(MAX_PLAYERS);
  private readonly pcz = new Int32Array(MAX_PLAYERS);
  private errors = 0;
  private readonly clock: () => number;

  constructor(private readonly host: RandomTickHost, opts: RandomTickOptions = {}) {
    this.rng = opts.rng ?? new XorShift32();
    this.speed = opts.speed ?? DEFAULT_RANDOM_TICK_SPEED;
    this.radius = opts.radius ?? 8;
    this.budgetMs = opts.budgetMs ?? 1.5;
    this.maxChanges = opts.maxChanges ?? 300;
    this.clock = host.now ? host.now.bind(host) : defaultNow;
  }

  setSpeed(n: number): void {
    this.speed = Math.max(0, Math.min(4096, Math.floor(Number.isFinite(n) ? n : DEFAULT_RANDOM_TICK_SPEED)));
  }

  // ---------------------------------------------------------------- TickContext

  getBlock(x: number, y: number, z: number): number { return this.host.getBlock(x, y, z); }
  getMeta(x: number, y: number, z: number): number { return this.host.getMeta(x, y, z); }
  getLight(x: number, y: number, z: number): number { return this.host.getLight(x, y, z); }

  brightness(x: number, y: number, z: number): number {
    const l = this.host.getLight(x, y, z);
    const sky = (l >> 4) - (this.host.skyDarkness ? this.host.skyDarkness() : 0);
    const block = l & 15;
    return sky > block ? (sky > 0 ? sky : 0) : block;
  }

  setBlock(x: number, y: number, z: number, id: number, meta = 0): void {
    this.changes++;
    this.host.setState(x, y, z, id, meta, false);
  }

  setMeta(x: number, y: number, z: number, meta: number): void {
    this.host.setState(x, y, z, this.host.getBlock(x, y, z), meta, true);
  }

  breakBlock(x: number, y: number, z: number): void {
    const id = this.host.getBlock(x, y, z);
    const meta = this.host.getMeta(x, y, z);
    this.setBlock(x, y, z, 0, 0);
    this.host.dropBlock?.(id, meta, x, y, z);
  }

  random(): number { return this.rng.nextU32() / 4294967296; }
  randomInt(n: number): number { return Math.floor((this.rng.nextU32() / 4294967296) * n); }

  biomeAt(x: number, z: number): number {
    return this.host.biomeAt ? this.host.biomeAt(x, z) : 2;
  }

  // ---------------------------------------------------------------- the tick

  /**
   * One game tick around the given players (block coordinates). Cost is bounded: the walk over the chunks stops
   * when the time budget or the change cap is used up and continues from there on the next tick.
   * @returns the number of block changes made
   */
  tick(centers: ArrayLike<{ x: number; z: number }>): number {
    const stats = this.stats;
    stats.ticks++;
    stats.picks = stats.handled = 0;
    this.changes = 0;
    const n = Math.min(centers.length, MAX_PLAYERS);
    const speed = this.speed | 0;
    if (n === 0 || speed <= 0) { stats.lastMs = 0; stats.changes = 0; return 0; }
    const host = this.host;
    const now = this.clock;
    const t0 = now();
    const R = this.radius;
    const side = 2 * R + 1;
    const perPlayer = side * side;
    const total = n * perPlayer;
    for (let i = 0; i < n; i++) {
      this.pcx[i] = Math.floor(centers[i].x) >> 4;
      this.pcz[i] = Math.floor(centers[i].z) >> 4;
    }
    host.begin?.();
    let walked = 0;
    let cut = false;
    const start = this.cursor % total;
    try {
      for (; walked < total; walked++) {
        const m = (start + walked) % total;
        const pi = (m / perPlayer) | 0;
        const r = m - pi * perPlayer;
        const cz = this.pcz[pi] + ((r / side) | 0) - R;
        const cx = this.pcx[pi] + (r % side) - R;
        // A chunk near several players is ticked once (by the first one that covers it).
        let covered = false;
        for (let j = 0; j < pi; j++) {
          if (Math.abs(cx - this.pcx[j]) <= R && Math.abs(cz - this.pcz[j]) <= R) { covered = true; break; }
        }
        if (covered) continue;
        const blocks = host.chunkBlocks(cx, cz);
        if (blocks) this.tickChunk(blocks, cx, cz, speed);
        if ((walked & 3) === 3 && (now() - t0 > this.budgetMs || this.changes >= this.maxChanges)) { cut = true; walked++; break; }
      }
    } catch (e) {
      // A faulty handler must never stop the game tick; report the first few.
      if (this.errors++ < 5) console.error('random tick failed', e);
    } finally {
      host.end?.();
    }
    this.cursor = cut ? (start + walked) % total : start;
    if (cut) stats.skipped++;
    stats.changes = this.changes;
    stats.lastMs = now() - t0;
    return this.changes;
  }

  private tickChunk(blocks: Uint8Array, cx: number, cz: number, speed: number): void {
    const rng = this.rng;
    const ox = cx << 4, oz = cz << 4;
    let handled = 0;
    for (let s = 0; s < SECTIONS; s++) {
      const base = s << 12; // section s starts at y = 16 s, block index y << 8
      for (let k = 0; k < speed; k++) {
        const pos = rng.nextU32() & POS_MASK;
        // pos = x | z << 4 | ys << 8, and the block index is x | z << 4 | (16 s + ys) << 8 = pos + base
        const idx = pos + base;
        const handler = HANDLERS[blocks[idx]];
        if (handler === null) continue;
        handler(this, ox + (pos & 15), (idx >> 8), oz + ((pos >> 4) & 15));
        handled++;
      }
    }
    this.stats.picks += SECTIONS * speed;
    this.stats.handled += handled;
    if (SURFACE.length > 0 && (rng.nextU32() >>> (32 - SURFACE_CHANCE_SHIFT)) === 0) this.surfacePass(blocks, ox, oz);
  }

  /** Top block of one random column, for effects that start at the surface. */
  private surfacePass(blocks: Uint8Array, ox: number, oz: number): void {
    const col = this.rng.nextU32() & 255;
    for (let y = CHUNK_HEIGHT - 1; y >= 0; y--) {
      const id = blocks[col | (y << 8)];
      if (id === 0) continue;
      for (let i = 0; i < SURFACE.length; i++) SURFACE[i](this, ox + (col & 15), y, oz + (col >> 4), id);
      return;
    }
  }
}

function defaultNow(): number {
  return performance.now();
}
