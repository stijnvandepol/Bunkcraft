import type { ChunkLike, EntityWorld } from '../src/entities/EntityManager';
import {
  BLOCK, LIGHT_EMIT, OPAQUE, SHAPE, SHAPE_CROSS, SHAPE_DOOR, SHAPE_MODEL,
} from '../src/world/BlockRegistry';
import { packState, stateId, stateMeta } from '../src/world/BlockStates';
import { BlockUpdates } from '../src/world/BlockUpdates';
import { createRandomTicker } from '../src/world/Growth';
import { BlockEntityStore } from '../src/world/BlockEntities';
import { LAVA_TICK_DELAY, LiquidSim, WATER_TICK_DELAY, isLiquid } from '../src/world/Liquids';
import { RedstoneSim, isRedstoneBlock } from '../src/world/Redstone';
import { type RandomTicker, noteRandomTickable } from '../src/world/RandomTicks';
import { CHUNK_HEIGHT, CHUNK_VOLUME, blockIndex, chunkKey } from '../src/world/constants';
import { GEN_VERSION_CURRENT } from '../src/world/GenVersion';
import { type WorldGenerator, type WorldType, createGenerator } from '../src/world/WorldGenerator';
import type { ChunkGenPool, GenClient } from './chunkgen/ChunkGenPool';
import { metrics } from './Metrics';
import { type GenSpec, type GeneratedChunk, generateChunk, topOf } from './chunkgen/genChunk';

/** Chunks kept loaded around each player (mobs only live where terrain exists). */
const LOAD_RADIUS = 4;
const UNLOAD_RADIUS = 6;
/** Chunk generations per update on the main thread (no worker pool), so a joining player never stalls the 20 Hz tick. */
const MAX_GEN_PER_UPDATE = 2;
/** Chunks from the worker pool put into the world per update (applying edits, mob spawning: cheap, but bounded). */
const MAX_INSTALL_PER_UPDATE = 8;
/** Light emitters affect blocks up to this far away (torch 14 → needs ≤ 14, mobs only care about 0). */
const EMIT_RADIUS = 14;
/** Empty slot of the chunk lookup cache (no real chunk coordinate gets near it). */
const NO_CHUNK = 0x7fffffff;
/** Random ticks run in the chunks this close to a player (inside the loaded area, so trees and leaves see their neighbours). */
export const SIM_RADIUS = LOAD_RADIUS - 1;

interface ServerChunk extends ChunkLike {
  blocks: Uint8Array;
  /** Block state bytes, allocated on the first non-zero state (null for almost every chunk). */
  meta: Uint8Array | null;
  /** Highest light-blocking block per column (x + z*16), −1 when open to the sky. */
  tops: Int16Array;
  /** Block indices that emit light (torches, glowstone, lava). */
  emitters: Set<number>;
  /**
   * The same indices sorted ascending, built on demand (null after a change). An index is x | z<<4 | y<<8,
   * so the order is by height and getLight only visits emitters within EMIT_RADIUS layers: a generated
   * chunk can hold over a thousand lava blocks deep down that never light anything at the surface.
   */
  emitSorted: Int32Array | null;
}

/**
 * The world as the server's mobs see it: terrain from the shared generator plus the
 * players' edits, loaded around the players only. Sky light is "open to the sky or not" and
 * block light comes from emitters within reach, which is all the spawn and burn rules need.
 */
export class ServerWorld implements EntityWorld, GenClient {
  readonly generator: WorldGenerator;
  readonly genSpec: GenSpec;
  /**
   * Chunks asked from the worker pool and not yet in the world: queued, being generated, or arrived (in `arrived`)
   * and waiting for the next update to install them. Until then they read as UNLOADED, like any chunk out of reach.
   */
  private readonly requested = new Set<number>();
  private readonly arrived: { cx: number; cz: number; key: number; chunk: GeneratedChunk }[] = [];
  /** The pool refused or dropped a request (full queue, failed worker): the next update scans again. */
  private genRetry = false;
  /** Chunks a worker failed on: generated on the main thread instead. */
  private readonly mainOnly = new Set<number>();
  private readonly scanned = new Set<number>();
  private readonly chunks = new Map<number, ServerChunk>();
  /** Edits per chunk: block index → packed state (id | meta << 8). */
  private readonly editsByChunk = new Map<number, Map<number, number>>();
  private readonly wanted = new Set<number>();
  /** Chunk coordinates of the players at the last update (x, z pairs) and whether that update loaded everything. */
  private readonly lastCenters: number[] = [];
  private lastComplete = false;
  /** Fired for every block change (including explosions) so the server can persist it. */
  onEdit: ((x: number, y: number, z: number, id: number, meta: number) => void) | null = null;
  /**
   * Water and lava flow. Chunks only simulate while loaded around a player; a liquid that still flows when a chunk
   * unloads simply carries on when it loads again (see generate()).
   */
  readonly liquids: LiquidSim;
  /**
   * Redstone, simulated only here in multiplayer (clients mirror the changes). `entitiesOn` (pressure plates) is set by the
   * owner of the players and mobs (ServerEntities).
   */
  readonly redstone: RedstoneSim;
  entitiesOn: ((x: number, y: number, z: number, oak: boolean) => number) | null = null;
  /** Block changes made by the liquid simulation since the last drain, as x, y, z, id, meta tuples (to broadcast). */
  private readonly simEdits: number[] = [];
  onChunkReady: ((chunk: ChunkLike) => void) | null = null;
  onChunkUnloaded: ((key: number) => void) | null = null;
  /** Random ticks (growth, leaf decay) and scheduled block updates (falling sand, uprooted plants). */
  readonly ticker: RandomTicker;
  readonly updates: BlockUpdates;
  /** The simulation removed a block that drops something (decayed leaves, an uprooted plant, sand that could not land). */
  onBlockDrop: ((id: number, meta: number, x: number, y: number, z: number) => void) | null = null;
  /** Sky light taken away by night and weather (0..11), for the growth light checks. */
  skyDarkness: () => number = () => 0;
  /**
   * Chests and furnaces: the server owns them in multiplayer (saved in world.json). Block changes they make
   * themselves (a furnace lighting up, the other half of a broken double chest) go out with the simulation edits.
   */
  readonly blockEntities: BlockEntityStore = new BlockEntityStore({
    getBlock: (x, y, z) => this.getBlock(x, y, z),
    getMeta: (x, y, z) => this.getMeta(x, y, z),
    setState: (x, y, z, id, meta) => {
      if (this.setBlock(x, y, z, id, meta) >= 0) this.simEdits.push(x, y, z, id, meta);
    },
  });

  /**
   * `pool`: generate chunks on worker threads (null = on the main thread, a couple per update: the old path, and what
   * the unit tests use). Output is identical either way (tests/chunkGenPool.test.ts).
   */
  constructor(
    readonly seed: number, edits: Record<string, number>, readonly worldType: WorldType = 'terrain', readonly genVersion: number = GEN_VERSION_CURRENT,
    private readonly pool: ChunkGenPool | null = null,
  ) {
    this.generator = createGenerator(worldType, seed, genVersion);
    this.genSpec = { worldType, seed, genVersion };
    this.liquids = new LiquidSim({
      getBlock: (x, y, z) => this.getBlock(x, y, z),
      getMeta: (x, y, z) => this.getMeta(x, y, z),
      setState: (x, y, z, id, meta) => this.simSet(x, y, z, id, meta),
    });
    this.redstone = new RedstoneSim({
      getBlock: (x, y, z) => this.getBlock(x, y, z),
      getMeta: (x, y, z) => this.getMeta(x, y, z),
      setState: (x, y, z, id, meta) => {
        if (this.setBlock(x, y, z, id, meta) >= 0) this.simEdits.push(x, y, z, id, meta);
      },
      entitiesOn: (x, y, z, oak) => this.entitiesOn?.(x, y, z, oak) ?? 0,
    });
    this.ticker = createRandomTicker({
      chunkBlocks: (cx, cz) => this.chunks.get(chunkKey(cx, cz))?.blocks ?? null,
      getBlock: (x, y, z) => this.getBlock(x, y, z),
      getMeta: (x, y, z) => this.getMeta(x, y, z),
      getLight: (x, y, z) => this.getLight(x, y, z),
      setState: (x, y, z, id, meta, quiet) => {
        if (quiet) this.setMetaQuiet(x, y, z, meta);
        else this.simSet(x, y, z, id, meta);
      },
      dropBlock: (id, meta, x, y, z) => this.onBlockDrop?.(id, meta, x, y, z),
      biomeAt: (x, z) => this.generator.biomeAt(x, z, Math.floor(this.generator.heightAt(x, z))),
      skyDarkness: () => this.skyDarkness(),
    }, { radius: SIM_RADIUS, budgetMs: 0.5 });
    this.updates = new BlockUpdates({
      getBlock: (x, y, z) => this.getBlock(x, y, z),
      getMeta: (x, y, z) => this.getMeta(x, y, z),
      setState: (x, y, z, id, meta) => this.simSet(x, y, z, id, meta),
    });
    this.updates.onBroken = (x, y, z, id, meta) => this.onBlockDrop?.(id, meta, x, y, z);
    this.updates.onDropped = (id, meta, x, y, z) => this.onBlockDrop?.(id, meta, x, y, z);
    // Packed states (id | meta << 8); worlds saved before block states hold plain ids, which read as meta 0.
    for (const [k, state] of Object.entries(edits)) {
      const [x, y, z] = k.split(',').map(Number);
      this.recordEdit(x, y, z, stateId(state), stateMeta(state));
    }
  }

  /** The whole arena stays loaded for hitscan (6×6 chunks); nothing is ever unloaded. */
  preloadArena(): void {
    for (let cz = -3; cz < 3; cz++) {
      for (let cx = -3; cx < 3; cx++) {
        const key = chunkKey(cx, cz);
        if (!this.chunks.has(key)) this.generate(cx, cz, key);
      }
    }
  }

  get loadedChunks(): number {
    return this.chunks.size;
  }

  private recordEdit(x: number, y: number, z: number, id: number, meta: number): void {
    const key = chunkKey(x >> 4, z >> 4);
    let m = this.editsByChunk.get(key);
    if (!m) { m = new Map(); this.editsByChunk.set(key, m); }
    m.set(blockIndex(x & 15, y, z & 15), packState(id, meta));
  }

  // Redstone, liquids, mob physics and path finding read the same few chunks over and over: a small direct-mapped
  // cache (4×4 chunk slots) skips the Map. A one-entry cache thrashed when mobs on both sides of a chunk border, or a
  // path search across it, alternated between two chunks.
  private readonly cacheCx = new Int32Array(16).fill(NO_CHUNK);
  private readonly cacheCz = new Int32Array(16);
  private readonly cacheChunks: (ServerChunk | undefined)[] = new Array<ServerChunk | undefined>(16).fill(undefined);

  private chunkAt(cx: number, cz: number): ServerChunk | undefined {
    const s = (cx & 3) | ((cz & 3) << 2);
    if (this.cacheCx[s] !== cx || this.cacheCz[s] !== cz) {
      this.cacheCx[s] = cx;
      this.cacheCz[s] = cz;
      this.cacheChunks[s] = this.chunks.get(chunkKey(cx, cz));
    }
    return this.cacheChunks[s];
  }

  /** A chunk came or went: forget the cached lookups (also the misses). */
  private resetChunkCache(): void {
    this.cacheCx.fill(NO_CHUNK);
    this.cacheChunks.fill(undefined);
  }

  getBlock(x: number, y: number, z: number): number {
    if (y < 0) return BLOCK.BEDROCK;
    if (y >= CHUNK_HEIGHT) return BLOCK.AIR;
    const c = this.chunkAt(x >> 4, z >> 4);
    return c ? c.blocks[blockIndex(x & 15, y, z & 15)] : BLOCK.UNLOADED;
  }

  /** Block state byte; 0 where unknown or in chunks without any state. */
  getMeta(x: number, y: number, z: number): number {
    if (y < 0 || y >= CHUNK_HEIGHT) return 0;
    const c = this.chunkAt(x >> 4, z >> 4);
    return c?.meta ? c.meta[blockIndex(x & 15, y, z & 15)] : 0;
  }

  /** Packed light (sky << 4 | block); full daylight where unknown, like the client. */
  getLight(x: number, y: number, z: number): number {
    if (y >= CHUNK_HEIGHT) return 0xf0;
    if (y < 0) return 0;
    const cx = x >> 4, cz = z >> 4;
    const c = this.chunkAt(cx, cz);
    if (!c) return 0xf0;
    const sky = y > c.tops[(x & 15) | ((z & 15) << 4)] ? 15 : 0;
    let block = 0;
    const lx = x & 15, lz = z & 15;
    // Only emitter layers within reach: indices are sorted by height (see emitSorted).
    const from = Math.max(0, y - EMIT_RADIUS) << 8, to = (y + EMIT_RADIUS + 1) << 8;
    // Emitters in the 3×3 chunks around: level = emission − distance (ignores occlusion).
    for (let dz = -1; dz <= 1; dz++) {
      // Horizontal distance to the nearest column of that neighbour: farther than the radius = nothing to find.
      const hz = dz < 0 ? lz + 1 : dz > 0 ? 16 - lz : 0;
      for (let dx = -1; dx <= 1; dx++) {
        const hx = dx < 0 ? lx + 1 : dx > 0 ? 16 - lx : 0;
        if (hx + hz > EMIT_RADIUS) continue;
        const n = dx === 0 && dz === 0 ? c : this.chunks.get(chunkKey(cx + dx, cz + dz));
        if (!n || n.emitters.size === 0) continue;
        const list = n.emitSorted ??= Int32Array.from(n.emitters).sort();
        for (let k = lowerBound(list, from); k < list.length; k++) {
          const i = list[k];
          if (i >= to) break;
          const ex = ((cx + dx) << 4) + (i & 15), ez = ((cz + dz) << 4) + ((i >> 4) & 15), ey = i >> 8;
          const d = Math.abs(ex - x) + Math.abs(ey - y) + Math.abs(ez - z);
          if (d > EMIT_RADIUS) continue;
          const level = LIGHT_EMIT[n.blocks[i]] - d;
          if (level > block) block = level;
        }
      }
    }
    return (sky << 4) | block;
  }

  getSkyLight(x: number, y: number, z: number): number {
    if (y >= CHUNK_HEIGHT) return 15;
    if (y < 0) return 0;
    const c = this.chunkAt(x >> 4, z >> 4);
    return !c || y > c.tops[(x & 15) | ((z & 15) << 4)] ? 15 : 0;
  }

  /** Highest solid or liquid block in a loaded column; −1 if unknown. */
  surfaceY(x: number, z: number): number {
    const c = this.chunks.get(chunkKey(x >> 4, z >> 4));
    if (!c) return -1;
    for (let y = CHUNK_HEIGHT - 1; y >= 0; y--) {
      const b = c.blocks[blockIndex(x & 15, y, z & 15)];
      if (b !== BLOCK.AIR && SHAPE[b] !== SHAPE_CROSS && SHAPE[b] !== SHAPE_MODEL) return y;
    }
    return 0;
  }

  /** Biome id of a column (spawn rules: husks in deserts, strays in snow, drowned in oceans). */
  biomeName(x: number, z: number): number {
    return this.generator.biomeAt(x, z, Math.floor(this.generator.heightAt(x, z)));
  }

  /**
   * Changes one block (a player edit or an explosion). Unloaded chunks only remember it,
   * so it is applied when they generate. Returns the previous block, or −1 if unchanged.
   */
  setBlock(x: number, y: number, z: number, id: number, meta = 0): number {
    if (y < 0 || y >= CHUNK_HEIGHT) return -1;
    const c = this.chunkAt(x >> 4, z >> 4);
    const i = blockIndex(x & 15, y, z & 15);
    this.recordEdit(x, y, z, id, meta);
    if (!c) {
      this.onEdit?.(x, y, z, id, meta);
      return BLOCK.UNLOADED;
    }
    const prev = c.blocks[i];
    const prevMeta = c.meta ? c.meta[i] : 0;
    if (prev === id && prevMeta === meta) return -1;
    c.blocks[i] = id;
    noteRandomTickable(c.blocks, y, id);
    if (meta !== 0 && !c.meta) c.meta = new Uint8Array(CHUNK_VOLUME);
    if (c.meta) c.meta[i] = meta;
    if (LIGHT_EMIT[id] > 0) {
      if (!c.emitters.has(i)) { c.emitters.add(i); c.emitSorted = null; }
    } else if (c.emitters.delete(i)) c.emitSorted = null;
    const col = (x & 15) | ((z & 15) << 4);
    if (OPAQUE[id]) {
      if (y > c.tops[col]) c.tops[col] = y;
    } else if (y === c.tops[col]) {
      c.tops[col] = topOf(c.blocks, col);
    }
    this.onEdit?.(x, y, z, id, meta);
    this.liquids.notify(x, y, z);
    this.redstone.notify(x, y, z);
    this.updates.notify(x, y, z);
    this.blockEntities.onBlockChange(x, y, z, prev, prevMeta, id, meta);
    return prev;
  }

  /** A change made by a simulation (liquids, growth, falling blocks): only loaded cells change, and it is queued for broadcasting. */
  private simSet(x: number, y: number, z: number, id: number, meta: number): void {
    if (!this.chunks.has(chunkKey(x >> 4, z >> 4))) return;
    if (this.setBlock(x, y, z, id, meta) >= 0) this.simEdits.push(x, y, z, id, meta);
  }

  /** State byte only (growth age, sapling stage): saved, not broadcast (it does not change the look). */
  setMetaQuiet(x: number, y: number, z: number, meta: number): void {
    if (y < 0 || y >= CHUNK_HEIGHT) return;
    const c = this.chunks.get(chunkKey(x >> 4, z >> 4));
    if (!c) return;
    const i = blockIndex(x & 15, y, z & 15);
    if ((c.meta ? c.meta[i] : 0) === meta) return;
    if (meta !== 0 && !c.meta) c.meta = new Uint8Array(CHUNK_VOLUME);
    if (c.meta) c.meta[i] = meta;
    const id = c.blocks[i];
    this.recordEdit(x, y, z, id, meta);
    this.onEdit?.(x, y, z, id, meta);
  }

  /** One game tick of random ticks around the players plus the scheduled block updates; returns the block changes. */
  tickGrowth(centers: ArrayLike<{ x: number; z: number }>): number {
    // Each player brings their own 0.5 ms (a few players never cost more than 2 ms per tick).
    this.ticker.budgetMs = 0.5 * Math.min(4, Math.max(1, centers.length));
    const n = this.ticker.tick(centers);
    this.updates.tick();
    return n;
  }

  /** One game tick of liquid flow; returns how many blocks changed. */
  tickLiquids(): number {
    return this.liquids.tick();
  }

  /** One game tick of redstone; returns how many blocks changed (they join the liquid changes in drainSimEdits). */
  tickRedstone(): number {
    return this.redstone.tick();
  }

  /** The changes the liquid simulation made since the last call (x, y, z, id, meta tuples); clears the list. */
  drainSimEdits(): number[] {
    return this.simEdits.splice(0, this.simEdits.length);
  }

  /**
   * Explosion like the client's World.explode: clears a noisy sphere (never bedrock,
   * obsidian or liquids) and the plants and torches left without support. Returns the ids
   * that were destroyed; `positions` receives their x, y, z triples in the same order.
   */
  explode(cx: number, cy: number, cz: number, radius: number, positions: number[]): number[] {
    const destroyed: number[] = [];
    const r = Math.ceil(radius);
    for (let dy = -r; dy <= r; dy++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.hypot(dx, dy, dz) > radius * (0.75 + Math.random() * 0.35)) continue;
          const x = Math.floor(cx + dx), y = Math.floor(cy + dy), z = Math.floor(cz + dz);
          if (y < 1 || y >= CHUNK_HEIGHT || !this.chunks.has(chunkKey(x >> 4, z >> 4))) continue;
          const id = this.getBlock(x, y, z);
          if (id === BLOCK.AIR || id === BLOCK.BEDROCK || id === BLOCK.OBSIDIAN || id === BLOCK.WATER || id === BLOCK.LAVA) continue;
          this.setBlock(x, y, z, BLOCK.AIR);
          destroyed.push(id);
          positions.push(x, y, z);
        }
      }
    }
    // Plants, torches and doors lose their support, and a door its other half (the list grows while we walk it).
    for (let k = 0; k < positions.length; k += 3) {
      const x = positions[k], y = positions[k + 1], z = positions[k + 2];
      const above = this.getBlock(x, y + 1, z);
      if (SHAPE[above] === SHAPE_CROSS || SHAPE[above] === SHAPE_MODEL || SHAPE[above] === SHAPE_DOOR) {
        this.setBlock(x, y + 1, z, BLOCK.AIR);
        destroyed.push(above);
        positions.push(x, y + 1, z);
      }
      const below = this.getBlock(x, y - 1, z);
      if (SHAPE[below] === SHAPE_DOOR && destroyed[k / 3] === below) {
        this.setBlock(x, y - 1, z, BLOCK.AIR);
        destroyed.push(below);
        positions.push(x, y - 1, z);
      }
    }
    return destroyed;
  }

  /**
   * Loads the chunks around the players and unloads the ones nobody is near any more. `centers` are player
   * positions in blocks. With a worker pool every missing chunk in reach is requested (nearest ring first) and the
   * ones that arrived since the last call are put in; without one a couple are generated here, nearest first.
   */
  update(centers: { x: number; z: number }[]): void {
    const pool = this.pool?.usable ? this.pool : null;
    if (!pool && this.requested.size > 0) {
      // The pool closed or gave up: what it still owed is generated here from now on.
      this.requested.clear();
      this.arrived.length = 0;
      this.lastComplete = false;
    }
    this.installArrived();
    // Runs every tick: when no player changed chunk and everything around them is loaded (or requested), nothing would change.
    let same = this.lastComplete && !this.genRetry && centers.length * 2 === this.lastCenters.length;
    for (let k = 0; k < centers.length && same; k++) {
      same = this.lastCenters[k * 2] === Math.floor(centers[k].x) >> 4 && this.lastCenters[k * 2 + 1] === Math.floor(centers[k].z) >> 4;
    }
    if (same) return;
    this.genRetry = false;
    this.lastCenters.length = 0;
    for (const p of centers) this.lastCenters.push(Math.floor(p.x) >> 4, Math.floor(p.z) >> 4);
    this.wanted.clear();
    for (const p of centers) {
      const pcx = Math.floor(p.x) >> 4, pcz = Math.floor(p.z) >> 4;
      for (let dz = -UNLOAD_RADIUS; dz <= UNLOAD_RADIUS; dz++) {
        for (let dx = -UNLOAD_RADIUS; dx <= UNLOAD_RADIUS; dx++) this.wanted.add(chunkKey(pcx + dx, pcz + dz));
      }
    }
    let generated = 0;
    this.scanned.clear();
    // Nearest-first so the area around a player is ready before the outskirts.
    for (let ring = 0; ring <= LOAD_RADIUS && (pool || generated < MAX_GEN_PER_UPDATE); ring++) {
      for (const p of centers) {
        const pcx = Math.floor(p.x) >> 4, pcz = Math.floor(p.z) >> 4;
        for (let dz = -ring; dz <= ring; dz++) {
          for (let dx = -ring; dx <= ring; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
            const key = chunkKey(pcx + dx, pcz + dz);
            if (this.chunks.has(key)) continue;
            if (pool && !this.mainOnly.has(key)) {
              this.scanned.add(key);
              // Arrived, goes in at the next update.
              if (this.requested.has(key) && !pool.pending(this, key)) continue;
              // Asked again every scan: a nearer player moves a queued chunk up (the pool keeps one request).
              if (pool.request(this, pcx + dx, pcz + dz, key, ring)) this.requested.add(key);
              else this.genRetry = true;
            } else if (generated < MAX_GEN_PER_UPDATE) {
              this.mainOnly.delete(key);
              this.generate(pcx + dx, pcz + dz, key);
              generated++;
            } else this.genRetry = true;
          }
        }
      }
    }
    // Requests for chunks nobody is near any more.
    if (this.requested.size > 0) {
      for (const key of this.requested) {
        if (this.scanned.has(key)) continue;
        this.requested.delete(key);
        this.pool?.cancel(this, key);
      }
    }
    for (const key of this.chunks.keys()) {
      if (this.wanted.has(key)) continue;
      this.chunks.delete(key);
      this.resetChunkCache();
      this.onChunkUnloaded?.(key);
    }
    // Below the budget means the ring loop ran to the end: every chunk in reach is loaded or requested.
    this.lastComplete = generated < MAX_GEN_PER_UPDATE;
  }

  /** The worker pool delivers a chunk (between ticks); it goes into the world at the next update. */
  chunkGenerated(cx: number, cz: number, key: number, chunk: GeneratedChunk): void {
    if (this.requested.has(key)) this.arrived.push({ cx, cz, key, chunk });
  }

  /** The pool dropped a request (queue full of nearer chunks) or a worker failed on it (then the main thread does it). */
  chunkDropped(_cx: number, _cz: number, key: number, failed: boolean): void {
    if (!this.requested.delete(key)) return;
    if (failed) this.mainOnly.add(key);
    this.genRetry = true;
  }

  private installArrived(): void {
    let n = 0;
    while (n < this.arrived.length && n < MAX_INSTALL_PER_UPDATE) {
      const a = this.arrived[n++];
      // Cancelled after it was generated (the players moved away) or already made on the main thread (ensureChunk).
      if (!this.requested.delete(a.key) || this.chunks.has(a.key)) continue;
      this.install(a.cx, a.cz, a.key, a.chunk);
    }
    if (n > 0) this.arrived.splice(0, n);
  }

  /**
   * Makes sure the chunk at block column x, z is in the world now, generating it on the main thread if needed: for the
   * rare request that cannot wait for a worker (a block edit in a chunk that has not arrived yet).
   */
  ensureChunk(x: number, z: number): void {
    const cx = x >> 4, cz = z >> 4, key = chunkKey(cx, cz);
    if (this.chunks.has(key)) return;
    if (this.requested.delete(key)) {
      this.pool?.cancel(this, key);
      const i = this.arrived.findIndex((a) => a.key === key);
      if (i >= 0) {
        const a = this.arrived[i];
        this.arrived.splice(i, 1);
        this.install(cx, cz, key, a.chunk);
        return;
      }
    }
    this.generate(cx, cz, key);
  }

  /** Whether a chunk is loaded (tests and the spawn checks). */
  hasChunk(cx: number, cz: number): boolean {
    return this.chunks.has(chunkKey(cx, cz));
  }

  /** Requests still out with the worker pool (tests, metrics). */
  get pendingChunks(): number {
    return this.requested.size;
  }

  /** The world goes away (game shut down or unloaded): drops its outstanding pool requests. */
  dispose(): void {
    this.pool?.cancelAll(this);
    this.requested.clear();
    this.arrived.length = 0;
  }

  /** Generates a chunk on this thread (no pool, arenas, ensureChunk). */
  private generate(cx: number, cz: number, key: number): void {
    const t0 = performance.now();
    const g = generateChunk(this.generator, cx, cz);
    metrics.chunksMainGenerated++;
    metrics.chunkMainGenMs += performance.now() - t0;
    this.install(cx, cz, key, g);
  }

  /** Puts a generated chunk into the world: the saved edits on top, then its light data patched to match. */
  private install(cx: number, cz: number, key: number, g: GeneratedChunk): void {
    const t0 = performance.now();
    const { blocks, tops } = g;
    let meta = g.meta;
    const edits = this.editsByChunk.get(key);
    let emitters: Set<number>;
    let emitSorted: Int32Array | null = g.emitters;
    if (edits) {
      emitters = new Set(g.emitters);
      const touched = new Uint8Array(256);
      for (const [i, state] of edits) {
        const id = stateId(state);
        blocks[i] = id;
        const m = stateMeta(state);
        // A state-0 edit keeps the generated state byte (as it always has: both paths must stay identical).
        if (m !== 0) { meta ??= new Uint8Array(CHUNK_VOLUME); meta[i] = m; }
        touched[i & 255] = 1;
        if (LIGHT_EMIT[id] > 0) {
          if (!emitters.has(i)) { emitters.add(i); emitSorted = null; }
        } else if (emitters.delete(i)) emitSorted = null;
      }
      for (let col = 0; col < 256; col++) if (touched[col]) tops[col] = topOf(blocks, col);
    } else emitters = new Set(g.emitters);
    const chunk: ServerChunk = { key, cx, cz, blocks, meta, tops, emitters, emitSorted };
    this.chunks.set(key, chunk);
    this.resetChunkCache();
    // Liquid that was still flowing when the chunk went away carries on.
    if (edits) {
      for (const [i, state] of edits) {
        if (isRedstoneBlock(stateId(state))) this.redstone.loaded((cx << 4) + (i & 15), i >> 8, (cz << 4) + ((i >> 4) & 15), stateId(state));
        if (isLiquid(stateId(state)) && stateMeta(state) !== 0) {
          this.liquids.schedule((cx << 4) + (i & 15), i >> 8, (cz << 4) + ((i >> 4) & 15), stateId(state) === BLOCK.LAVA ? LAVA_TICK_DELAY : WATER_TICK_DELAY);
        }
      }
    }
    this.onChunkReady?.(chunk);
    metrics.chunksInstalled++;
    metrics.chunkInstallMs += performance.now() - t0;
  }
}

/** First position in a sorted list whose value is ≥ v. */
function lowerBound(list: Int32Array, v: number): number {
  let lo = 0, hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid] < v) lo = mid + 1; else hi = mid;
  }
  return lo;
}
