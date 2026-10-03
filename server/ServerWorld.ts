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

/** Chunks kept loaded around each player (mobs only live where terrain exists). */
const LOAD_RADIUS = 4;
const UNLOAD_RADIUS = 6;
/** Chunk generations per update, so a joining player never stalls the 20 Hz tick. */
const MAX_GEN_PER_UPDATE = 2;
/** Light emitters affect blocks up to this far away (torch 14 → needs ≤ 14, mobs only care about 0). */
const EMIT_RADIUS = 14;
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
}

/**
 * The world as the server's mobs see it: terrain from the shared generator plus the
 * players' edits, loaded around the players only. Sky light is "open to the sky or not" and
 * block light comes from emitters within reach, which is all the spawn and burn rules need.
 */
export class ServerWorld implements EntityWorld {
  readonly generator: WorldGenerator;
  private readonly chunks = new Map<number, ServerChunk>();
  /** Edits per chunk: block index → packed state (id | meta << 8). */
  private readonly editsByChunk = new Map<number, Map<number, number>>();
  private readonly wanted = new Set<number>();
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

  constructor(readonly seed: number, edits: Record<string, number>, readonly worldType: WorldType = 'terrain', readonly genVersion: number = GEN_VERSION_CURRENT) {
    this.generator = createGenerator(worldType, seed, genVersion);
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

  // Redstone and liquids read the same chunk over and over: a one-entry cache skips the Map (like the client's World).
  private cacheCx = NaN;
  private cacheCz = NaN;
  private cacheChunk: ServerChunk | undefined;

  private chunkAt(cx: number, cz: number): ServerChunk | undefined {
    if (cx !== this.cacheCx || cz !== this.cacheCz) {
      this.cacheCx = cx;
      this.cacheCz = cz;
      this.cacheChunk = this.chunks.get(chunkKey(cx, cz));
    }
    return this.cacheChunk;
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
    const c = this.chunks.get(chunkKey(cx, cz));
    if (!c) return 0xf0;
    const sky = y > c.tops[(x & 15) | ((z & 15) << 4)] ? 15 : 0;
    let block = 0;
    // Emitters in the 3×3 chunks around: level = emission − distance (ignores occlusion).
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const n = dx === 0 && dz === 0 ? c : this.chunks.get(chunkKey(cx + dx, cz + dz));
        if (!n || n.emitters.size === 0) continue;
        for (const i of n.emitters) {
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
    const c = this.chunks.get(chunkKey(x >> 4, z >> 4));
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
    if (LIGHT_EMIT[id] > 0) c.emitters.add(i); else c.emitters.delete(i);
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
   * Loads the chunks around the players (a couple per call) and unloads the ones nobody
   * is near any more. `centers` are player positions in blocks.
   */
  update(centers: { x: number; z: number }[]): void {
    this.wanted.clear();
    let generated = 0;
    // Nearest-first so the area around a player is ready before the outskirts.
    for (let ring = 0; ring <= LOAD_RADIUS && generated < MAX_GEN_PER_UPDATE; ring++) {
      for (const p of centers) {
        const pcx = Math.floor(p.x) >> 4, pcz = Math.floor(p.z) >> 4;
        for (let dz = -ring; dz <= ring; dz++) {
          for (let dx = -ring; dx <= ring; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
            const key = chunkKey(pcx + dx, pcz + dz);
            if (this.chunks.has(key) || generated >= MAX_GEN_PER_UPDATE) continue;
            this.generate(pcx + dx, pcz + dz, key);
            generated++;
          }
        }
      }
    }
    for (const p of centers) {
      const pcx = Math.floor(p.x) >> 4, pcz = Math.floor(p.z) >> 4;
      for (let dz = -UNLOAD_RADIUS; dz <= UNLOAD_RADIUS; dz++) {
        for (let dx = -UNLOAD_RADIUS; dx <= UNLOAD_RADIUS; dx++) this.wanted.add(chunkKey(pcx + dx, pcz + dz));
      }
    }
    for (const key of this.chunks.keys()) {
      if (this.wanted.has(key)) continue;
      this.chunks.delete(key);
      this.cacheChunk = undefined;
      this.cacheCx = NaN;
      this.onChunkUnloaded?.(key);
    }
  }

  private generate(cx: number, cz: number, key: number): void {
    const blocks = new Uint8Array(CHUNK_VOLUME);
    this.generator.generate(cx, cz, blocks);
    const edits = this.editsByChunk.get(key);
    let meta: Uint8Array | null = null;
    if (edits) {
      for (const [i, state] of edits) {
        blocks[i] = stateId(state);
        const m = stateMeta(state);
        if (m !== 0) { meta ??= new Uint8Array(CHUNK_VOLUME); meta[i] = m; }
      }
    }
    const tops = new Int16Array(256);
    for (let col = 0; col < 256; col++) tops[col] = topOf(blocks, col);
    const emitters = new Set<number>();
    for (let i = 0; i < CHUNK_VOLUME; i++) if (LIGHT_EMIT[blocks[i]] > 0) emitters.add(i);
    const chunk: ServerChunk = { key, cx, cz, blocks, meta, tops, emitters };
    this.chunks.set(key, chunk);
    this.cacheCx = NaN;
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
  }
}

/** Highest light-blocking block in a column of a chunk, −1 if none. */
function topOf(blocks: Uint8Array, col: number): number {
  for (let y = CHUNK_HEIGHT - 1; y >= 0; y--) if (OPAQUE[blocks[col | (y << 8)]]) return y;
  return -1;
}
