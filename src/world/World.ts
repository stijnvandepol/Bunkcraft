import type { WorkerPool } from '../workers/WorkerPool';
import { tintColor } from './BiomeColors';
import { BLOCK, SHAPE, SHAPE_CROSS, SHAPE_MODEL, SOLID, TINT } from './BlockRegistry';
import { CHUNK_READY, type Chunk } from './Chunk';
import { ChunkManager, type ChunkMaterials } from './ChunkManager';
import { CHUNK_HEIGHT, SEA_LEVEL, blockIndex, chunkKey } from './constants';
import { ARENA_SPAWNS } from '../modes/arena';
import { BIOME } from './TerrainGenerator';
import { type WorldGenerator, type WorldType, createGenerator } from './WorldGenerator';

/** Sparse player edits per chunk: block index → block id. */
export type EditMap = Map<number, Map<number, number>>;

export class World {
  readonly chunks: ChunkManager;
  /** Main-thread generator, only used for cheap 2D queries (spawn search, biome name). */
  readonly generator: WorldGenerator;
  readonly edits: EditMap;
  readonly dirtyEditChunks = new Set<number>();
  /** Entity hooks: a chunk finished generating / was unloaded. */
  onChunkReady: ((chunk: Chunk) => void) | null = null;
  onChunkUnloaded: ((key: number) => void) | null = null;
  /** Local (player) edits, for multiplayer sync: position, new id, previous id. */
  onEdit: ((x: number, y: number, z: number, id: number, prev: number) => void) | null = null;

  constructor(readonly seed: number, pool: WorkerPool, materials: ChunkMaterials, edits: EditMap = new Map(), readonly worldType: WorldType = 'terrain') {
    this.generator = createGenerator(worldType, seed);
    this.edits = edits;
    this.chunks = new ChunkManager(seed, pool, materials, worldType);
    this.chunks.onGenerated = (chunk) => {
      const e = this.edits.get(chunk.key);
      if (e && chunk.blocks) for (const [i, id] of e) chunk.blocks[i] = id;
      this.onChunkReady?.(chunk);
    };
    this.chunks.onUnloaded = (key) => this.onChunkUnloaded?.(key);
  }

  // chunkKey exceeds the Smi range, so every Map lookup boxes a heap number. Entities, particles and
  // rays mostly query the same chunk repeatedly: a one-entry cache skips the Map in the common case.
  private cacheEpoch = -1;
  private cacheCx = 0;
  private cacheCz = 0;
  private cacheChunk: Chunk | undefined;

  private chunkAt(cx: number, cz: number): Chunk | undefined {
    const mgr = this.chunks;
    if (this.cacheEpoch !== mgr.epoch || this.cacheCx !== cx || this.cacheCz !== cz) {
      this.cacheEpoch = mgr.epoch;
      this.cacheCx = cx;
      this.cacheCz = cz;
      this.cacheChunk = mgr.chunks.get(chunkKey(cx, cz));
    }
    const c = this.cacheChunk;
    return c && c.state === CHUNK_READY ? c : undefined;
  }

  getBlock(x: number, y: number, z: number): number {
    if (y < 0) return BLOCK.BEDROCK;
    if (y >= CHUNK_HEIGHT) return BLOCK.AIR;
    const c = this.chunkAt(x >> 4, z >> 4);
    if (!c || !c.blocks) return BLOCK.UNLOADED;
    return c.blocks[blockIndex(x & 15, y, z & 15)];
  }

  /** Packed light (sky << 4 | block); full daylight where unknown. */
  getLight(x: number, y: number, z: number): number {
    if (y >= CHUNK_HEIGHT) return 0xf0;
    if (y < 0) return 0;
    const c = this.chunkAt(x >> 4, z >> 4);
    if (!c || !c.light) return 0xf0;
    return c.light[blockIndex(x & 15, y, z & 15)];
  }

  /** Biome tint (packed 0xRRGGBB) for a block at a column; white if untinted. */
  tintAt(x: number, z: number, id: number): number {
    if (!TINT[id]) return 0xffffff;
    const c = this.chunkAt(x >> 4, z >> 4);
    const biome = c?.biomes ? c.biomes[(x & 15) + (z & 15) * 16] : 2;
    const t = tintColor(TINT[id], biome);
    return (t[0] << 16) | (t[1] << 8) | t[2];
  }

  /** @param remote true when applying an edit received from the server (not re-sent). */
  setBlock(x: number, y: number, z: number, id: number, remote = false): boolean {
    if (y < 0 || y >= CHUNK_HEIGHT) return false;
    const cx = x >> 4, cz = z >> 4;
    const c = this.chunkAt(cx, cz);
    if (!c || !c.blocks) return false;
    const lx = x & 15, lz = z & 15;
    const i = blockIndex(lx, y, lz);
    const prev = c.blocks[i];
    if (prev === id) return false;
    c.blocks[i] = id;
    if (!remote) this.onEdit?.(x, y, z, id, prev);

    let e = this.edits.get(c.key);
    if (!e) { e = new Map(); this.edits.set(c.key, e); }
    e.set(i, id);
    this.dirtyEditChunks.add(c.key);

    // Faces and AO reach one block into the neighbours: only chunks the edit touches are remeshed
    // right away. Light reaches up to 14 blocks, but ChunkManager remeshes a further neighbour only
    // when the border light of the edited chunk actually changed (see propagateLight).
    c.version++;
    this.chunks.requestMeshUrgent(c);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue;
        const touches = (dx === -1 ? lx === 0 : dx === 1 ? lx === 15 : true) && (dz === -1 ? lz === 0 : dz === 1 ? lz === 15 : true);
        if (!touches) continue;
        const n = this.chunks.get(cx + dx, cz + dz);
        if (!n || n.state !== CHUNK_READY) continue;
        n.version++;
        this.chunks.requestMeshUrgent(n);
      }
    }
    this.chunks.markDirty();
    return true;
  }

  /**
   * Explosion: clears a noisy sphere of blocks in one batch and remeshes each touched
   * chunk once (instead of 9 remeshes per block). Returns the ids that were destroyed;
   * `positions` (optional) receives x, y, z of each destroyed block in the same order.
   */
  explode(cx: number, cy: number, cz: number, radius: number, positions?: number[]): number[] {
    const destroyed: number[] = [];
    const cleared: number[] = [];
    const touched = new Set<Chunk>();
    const r = Math.ceil(radius);
    for (let dy = -r; dy <= r; dy++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          const d = Math.hypot(dx, dy, dz);
          if (d > radius * (0.75 + Math.random() * 0.35)) continue;
          const x = Math.floor(cx + dx), y = Math.floor(cy + dy), z = Math.floor(cz + dz);
          if (y < 1 || y >= CHUNK_HEIGHT) continue;
          const c = this.chunkAt(x >> 4, z >> 4);
          if (!c || !c.blocks) continue;
          const i = blockIndex(x & 15, y, z & 15);
          const id = c.blocks[i];
          if (id === BLOCK.AIR || id === BLOCK.BEDROCK || id === BLOCK.OBSIDIAN || id === BLOCK.WATER || id === BLOCK.LAVA) continue;
          c.blocks[i] = BLOCK.AIR;
          cleared.push(x, y, z);
          let e = this.edits.get(c.key);
          if (!e) { e = new Map(); this.edits.set(c.key, e); }
          e.set(i, BLOCK.AIR);
          this.dirtyEditChunks.add(c.key);
          touched.add(c);
          destroyed.push(id);
          positions?.push(x, y, z);
        }
      }
    }
    // Plants and torches lose their support.
    for (let k = 0; k < cleared.length; k += 3) {
      const x = cleared[k], y = cleared[k + 1] + 1, z = cleared[k + 2];
      const above = this.getBlock(x, y, z);
      if (SHAPE[above] !== SHAPE_CROSS && SHAPE[above] !== SHAPE_MODEL) continue;
      const c = this.chunkAt(x >> 4, z >> 4);
      if (!c || !c.blocks) continue;
      const i = blockIndex(x & 15, y, z & 15);
      c.blocks[i] = BLOCK.AIR;
      this.edits.get(c.key)?.set(i, BLOCK.AIR) ?? this.edits.set(c.key, new Map([[i, BLOCK.AIR]]));
      this.dirtyEditChunks.add(c.key);
      touched.add(c);
    }
    const remesh = new Set<Chunk>();
    for (const c of touched) {
      for (let oz = -1; oz <= 1; oz++) for (let ox = -1; ox <= 1; ox++) {
        const n = this.chunks.get(c.cx + ox, c.cz + oz);
        if (n && n.state === CHUNK_READY) remesh.add(n);
      }
    }
    for (const c of remesh) {
      c.version++;
      if (touched.has(c)) this.chunks.requestMeshUrgent(c);
    }
    this.chunks.markDirty();
    return destroyed;
  }

  /**
   * Edit received from the server. Unloaded chunks just record it, so it is applied
   * when the chunk generates (the same path as saved edits).
   */
  applyRemoteEdit(x: number, y: number, z: number, id: number): void {
    if (y < 0 || y >= CHUNK_HEIGHT) return;
    if (this.setBlock(x, y, z, id, true)) return;
    const key = chunkKey(x >> 4, z >> 4);
    let e = this.edits.get(key);
    if (!e) { e = new Map(); this.edits.set(key, e); }
    e.set(blockIndex(x & 15, y, z & 15), id);
  }

  /**
   * Many removals at once (a server explosion): sets the blocks, then remeshes each touched
   * chunk and its neighbours once instead of nine chunks per block. Unloaded chunks only record the edit.
   */
  applyRemoteRemovals(positions: number[]): void {
    const touched = new Set<Chunk>();
    for (let k = 0; k + 2 < positions.length; k += 3) {
      const x = positions[k], y = positions[k + 1], z = positions[k + 2];
      if (y < 0 || y >= CHUNK_HEIGHT) continue;
      const c = this.chunkAt(x >> 4, z >> 4);
      const i = blockIndex(x & 15, y, z & 15);
      let e = this.edits.get(chunkKey(x >> 4, z >> 4));
      if (!e) { e = new Map(); this.edits.set(chunkKey(x >> 4, z >> 4), e); }
      e.set(i, BLOCK.AIR);
      this.dirtyEditChunks.add(chunkKey(x >> 4, z >> 4));
      if (c?.blocks) {
        c.blocks[i] = BLOCK.AIR;
        touched.add(c);
      }
    }
    const remesh = new Set<Chunk>();
    for (const c of touched) {
      for (let oz = -1; oz <= 1; oz++) for (let ox = -1; ox <= 1; ox++) {
        const n = this.chunks.get(c.cx + ox, c.cz + oz);
        if (n && n.state === CHUNK_READY) remesh.add(n);
      }
    }
    for (const c of remesh) {
      c.version++;
      if (touched.has(c)) this.chunks.requestMeshUrgent(c);
    }
    this.chunks.markDirty();
  }

  /** Highest y whose block is solid, in a loaded chunk; -1 if unknown. */
  surfaceY(x: number, z: number): number {
    const c = this.chunkAt(x >> 4, z >> 4);
    if (!c || !c.blocks) return -1;
    for (let y = CHUNK_HEIGHT - 1; y >= 0; y--) {
      const b = c.blocks[blockIndex(x & 15, y, z & 15)];
      if (SOLID[b] || b === BLOCK.WATER) return y;
    }
    return 0;
  }

  /** Spiral search for dry land near the origin using the 2D height function. */
  findSpawn(): { x: number; z: number } {
    if (this.worldType === 'arena') return ARENA_SPAWNS.ffa[0];
    for (let r = 0; r < 2000; r += 8) {
      const steps = Math.max(1, Math.floor((r * Math.PI * 2) / 16));
      for (let s = 0; s < steps; s++) {
        const a = (s / steps) * Math.PI * 2;
        const x = Math.round(Math.cos(a) * r), z = Math.round(Math.sin(a) * r);
        const h = this.generator.heightAt(x, z);
        const biome = this.generator.biomeAt(x, z, Math.floor(h));
        if (h > SEA_LEVEL + 2 && h < 85 && (biome === BIOME.PLAINS || biome === BIOME.FOREST || biome === BIOME.TAIGA)) {
          return { x: x + 0.5, z: z + 0.5 };
        }
      }
    }
    return { x: 0.5, z: 0.5 };
  }

  biomeName(x: number, z: number): number {
    return this.generator.biomeAt(x, z, Math.floor(this.generator.heightAt(x, z)));
  }

  /** Break a block; a plant standing on top drops with it. */
  breakBlock(x: number, y: number, z: number): number {
    const id = this.getBlock(x, y, z);
    if (!this.setBlock(x, y, z, BLOCK.AIR)) return 0;
    const above = this.getBlock(x, y + 1, z);
    if (SHAPE[above] === SHAPE_CROSS || SHAPE[above] === SHAPE_MODEL) this.setBlock(x, y + 1, z, BLOCK.AIR);
    return id;
  }

  dispose(): void {
    this.chunks.dispose();
  }
}
