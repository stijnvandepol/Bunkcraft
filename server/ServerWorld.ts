import type { ChunkLike, EntityWorld } from '../src/entities/EntityManager';
import {
  BLOCK, LIGHT_EMIT, OPAQUE, SHAPE, SHAPE_CROSS, SHAPE_MODEL,
} from '../src/world/BlockRegistry';
import { packState, stateId, stateMeta } from '../src/world/BlockStates';
import { CHUNK_HEIGHT, CHUNK_VOLUME, blockIndex, chunkKey } from '../src/world/constants';
import { type WorldGenerator, type WorldType, createGenerator } from '../src/world/WorldGenerator';

/** Chunks kept loaded around each player (mobs only live where terrain exists). */
const LOAD_RADIUS = 4;
const UNLOAD_RADIUS = 6;
/** Chunk generations per update, so a joining player never stalls the 20 Hz tick. */
const MAX_GEN_PER_UPDATE = 2;
/** Light emitters affect blocks up to this far away (torch 14 → needs ≤ 14, mobs only care about 0). */
const EMIT_RADIUS = 14;

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
  onChunkReady: ((chunk: ChunkLike) => void) | null = null;
  onChunkUnloaded: ((key: number) => void) | null = null;

  constructor(readonly seed: number, edits: Record<string, number>, readonly worldType: WorldType = 'terrain') {
    this.generator = createGenerator(worldType, seed);
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

  getBlock(x: number, y: number, z: number): number {
    if (y < 0) return BLOCK.BEDROCK;
    if (y >= CHUNK_HEIGHT) return BLOCK.AIR;
    const c = this.chunks.get(chunkKey(x >> 4, z >> 4));
    return c ? c.blocks[blockIndex(x & 15, y, z & 15)] : BLOCK.UNLOADED;
  }

  /** Block state byte; 0 where unknown or in chunks without any state. */
  getMeta(x: number, y: number, z: number): number {
    if (y < 0 || y >= CHUNK_HEIGHT) return 0;
    const c = this.chunks.get(chunkKey(x >> 4, z >> 4));
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
    const c = this.chunks.get(chunkKey(x >> 4, z >> 4));
    const i = blockIndex(x & 15, y, z & 15);
    this.recordEdit(x, y, z, id, meta);
    if (!c) {
      this.onEdit?.(x, y, z, id, meta);
      return BLOCK.UNLOADED;
    }
    const prev = c.blocks[i];
    if (prev === id && (c.meta ? c.meta[i] : 0) === meta) return -1;
    c.blocks[i] = id;
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
    return prev;
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
    for (let k = 0; k < positions.length; k += 3) {
      const x = positions[k], y = positions[k + 1] + 1, z = positions[k + 2];
      const above = this.getBlock(x, y, z);
      if (SHAPE[above] !== SHAPE_CROSS && SHAPE[above] !== SHAPE_MODEL) continue;
      this.setBlock(x, y, z, BLOCK.AIR);
      destroyed.push(above);
      positions.push(x, y, z);
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
    this.onChunkReady?.(chunk);
  }
}

/** Highest light-blocking block in a column of a chunk, −1 if none. */
function topOf(blocks: Uint8Array, col: number): number {
  for (let y = CHUNK_HEIGHT - 1; y >= 0; y--) if (OPAQUE[blocks[col | (y << 8)]]) return y;
  return -1;
}
