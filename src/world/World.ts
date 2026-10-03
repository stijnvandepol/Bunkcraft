import type { WorkerPool } from '../workers/WorkerPool';
import { tintColor } from './BiomeColors';
import { ContainerStore } from './Containers';
import { BLOCK, BOX_KIND, DYE, DYE_RGB, SHAPE, SHAPE_CROSS, SHAPE_DOOR, SHAPE_MODEL, SOLID, TINT } from './BlockRegistry';
import { CHUNK_READY, type Chunk } from './Chunk';
import { ChunkManager, type ChunkMaterials } from './ChunkManager';
import { CHUNK_HEIGHT, CHUNK_VOLUME, SEA_LEVEL, blockIndex, chunkKey } from './constants';
import { GEN_VERSION_CURRENT } from './GenVersion';
import { DOOR_OPEN_BIT, isDoorUpper, packState, stateId, stateMeta } from './BlockStates';
import { BOX_BED, BOX_GATE, BOX_TRAPDOOR, GATE_OPEN_BIT, TRAPDOOR_OPEN_BIT, bedPartner } from './BoxShapes';
import { BIOME } from './TerrainGenerator';
import { LAVA_TICK_DELAY, LiquidSim, WATER_TICK_DELAY, isLiquid } from './Liquids';
import { RedstoneSim, isRedstoneBlock } from './Redstone';
import { type WorldGenerator, type WorldType, arenaMapOf, createGenerator, isArenaWorld } from './WorldGenerator';

/** Sparse player edits per chunk: block index → packed state (id | meta << 8, see BlockStates). */
export type EditMap = Map<number, Map<number, number>>;

export class World {
  readonly chunks: ChunkManager;
  /** Main-thread generator, only used for cheap 2D queries (spawn search, biome name). */
  readonly generator: WorldGenerator;
  readonly edits: EditMap;
  readonly dirtyEditChunks = new Set<number>();
  /** Chest contents (singleplayer; saved with the world). */
  readonly containers = new ContainerStore();
  /**
   * Water and lava flow (singleplayer only: on a multiplayer server the server simulates and the client mirrors
   * its block changes). Null until enableLiquids().
   */
  liquids: LiquidSim | null = null;
  /** Redstone (singleplayer only, like the liquids: a server simulates it and the client mirrors). Null until enableRedstone(). */
  redstone: RedstoneSim | null = null;
  /**
   * A redstone block changed state through the simulation or the server (not the local player's own click): hook for its
   * sound (lever, button, plate, piston, door, note block).
   */
  onRedstoneChange: ((x: number, y: number, z: number, prevId: number, prevMeta: number, id: number, meta: number) => void) | null = null;
  /** Chunks whose only changes were dust strength (vertex colours): remeshed together at most 5 times a second. */
  private readonly deferredMesh = new Map<Chunk, number>();
  private deferTicks = 0;
  private simEdit = false;
  /** Entity hooks: a chunk finished generating / was unloaded. */
  onChunkReady: ((chunk: Chunk) => void) | null = null;
  onChunkUnloaded: ((key: number) => void) | null = null;
  /** Local (player) edits, for multiplayer sync: position, new id and meta, previous id and meta. */
  onEdit: ((x: number, y: number, z: number, id: number, meta: number, prev: number, prevMeta: number) => void) | null = null;

  constructor(readonly seed: number, pool: WorkerPool, materials: ChunkMaterials, edits: EditMap = new Map(), readonly worldType: WorldType = 'terrain', readonly genVersion: number = GEN_VERSION_CURRENT) {
    this.generator = createGenerator(worldType, seed, genVersion);
    this.edits = edits;
    this.chunks = new ChunkManager(seed, pool, materials, worldType, genVersion);
    this.chunks.onGenerated = (chunk) => {
      const e = this.edits.get(chunk.key);
      if (e && chunk.blocks) {
        for (const [i, state] of e) {
          writeState(chunk, i, stateId(state), stateMeta(state));
          // Liquid that was still flowing when the world was saved carries on.
          if (this.redstone && isRedstoneBlock(stateId(state))) {
            this.redstone.loaded(chunk.cx * 16 + (i & 15), i >> 8, chunk.cz * 16 + ((i >> 4) & 15), stateId(state));
          }
          if (this.liquids && isLiquid(stateId(state)) && stateMeta(state) !== 0) {
            this.liquids.schedule(chunk.cx * 16 + (i & 15), i >> 8, chunk.cz * 16 + ((i >> 4) & 15), stateId(state) === BLOCK.LAVA ? LAVA_TICK_DELAY : WATER_TICK_DELAY);
          }
        }
      }
      this.onChunkReady?.(chunk);
    };
    this.chunks.onUnloaded = (key) => this.onChunkUnloaded?.(key);
  }

  /** Turns on the liquid simulation; the caller ticks it with tickLiquids() at 20 Hz. */
  enableLiquids(): LiquidSim {
    const sim = new LiquidSim({
      getBlock: (x, y, z) => this.getBlock(x, y, z),
      getMeta: (x, y, z) => this.getMeta(x, y, z),
      setState: (x, y, z, id, meta) => { this.setBlock(x, y, z, id, meta); },
    });
    this.liquids = sim;
    return sim;
  }

  tickLiquids(): void {
    this.liquids?.tick();
  }

  /** Turns on redstone; the caller ticks it with tickRedstone() at 20 Hz. */
  enableRedstone(entitiesOn?: (x: number, y: number, z: number, oak: boolean) => number): RedstoneSim {
    const sim = new RedstoneSim({
      entitiesOn,
      getBlock: (x, y, z) => this.getBlock(x, y, z),
      getMeta: (x, y, z) => this.getMeta(x, y, z),
      setState: (x, y, z, id, meta) => {
        this.simEdit = true;
        try { this.setBlock(x, y, z, id, meta); } finally { this.simEdit = false; }
      },
    });
    this.redstone = sim;
    return sim;
  }

  /** One game tick of redstone (singleplayer), then the batched dust remeshes (also in multiplayer, for the server's changes). */
  tickRedstone(): void {
    this.redstone?.tick();
    if (++this.deferTicks % 4 !== 0 || this.deferredMesh.size === 0) return;
    for (const [c, border] of this.deferredMesh) {
      if (this.chunks.chunks.get(c.key) !== c) continue;
      this.remeshAround(c, border);
    }
    this.deferredMesh.clear();
  }

  /** Remesh a chunk now, and the neighbours whose border it touched (`border`: bit 0 −x, 1 +x, 2 −z, 3 +z). */
  private remeshAround(c: Chunk, border: number): void {
    c.version++;
    this.chunks.requestMeshUrgent(c);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue;
        const touches = (dx === -1 ? (border & 1) !== 0 : dx === 1 ? (border & 2) !== 0 : true)
          && (dz === -1 ? (border & 4) !== 0 : dz === 1 ? (border & 8) !== 0 : true);
        if (!touches) continue;
        const n = this.chunks.get(c.cx + dx, c.cz + dz);
        if (!n || n.state !== CHUNK_READY) continue;
        n.version++;
        this.chunks.requestMeshUrgent(n);
      }
    }
    this.chunks.markDirty();
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

  /** Block state byte (see BlockStates); 0 where unknown or in chunks without any state. */
  getMeta(x: number, y: number, z: number): number {
    if (y < 0 || y >= CHUNK_HEIGHT) return 0;
    const c = this.chunkAt(x >> 4, z >> 4);
    if (!c || !c.meta) return 0;
    return c.meta[blockIndex(x & 15, y, z & 15)];
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
  tintAt(x: number, z: number, id: number, meta = 0): number {
    if (DYE[id]) return DYE_RGB[meta & 15];
    if (!TINT[id]) return 0xffffff;
    const c = this.chunkAt(x >> 4, z >> 4);
    const biome = c?.biomes ? c.biomes[(x & 15) + (z & 15) * 16] : 2;
    const t = tintColor(TINT[id], biome);
    return (t[0] << 16) | (t[1] << 8) | t[2];
  }

  /** @param remote true when applying an edit received from the server (not re-sent). */
  setBlock(x: number, y: number, z: number, id: number, meta = 0, remote = false): boolean {
    if (y < 0 || y >= CHUNK_HEIGHT) return false;
    const cx = x >> 4, cz = z >> 4;
    const c = this.chunkAt(cx, cz);
    if (!c || !c.blocks) return false;
    const lx = x & 15, lz = z & 15;
    const i = blockIndex(lx, y, lz);
    const prev = c.blocks[i];
    const prevMeta = c.meta ? c.meta[i] : 0;
    if (prev === id && prevMeta === meta) return false;
    writeState(c, i, id, meta);
    if (!remote) this.onEdit?.(x, y, z, id, meta, prev, prevMeta);

    let e = this.edits.get(c.key);
    if (!e) { e = new Map(); this.edits.set(c.key, e); }
    e.set(i, packState(id, meta));
    this.dirtyEditChunks.add(c.key);

    // Faces and AO reach one block into the neighbours: only chunks the edit touches are remeshed
    // right away. Light reaches up to 14 blocks, but ChunkManager remeshes a further neighbour only
    // when the border light of the edited chunk actually changed (see propagateLight).
    const border = (lx === 0 ? 1 : 0) | (lx === 15 ? 2 : 0) | (lz === 0 ? 4 : 0) | (lz === 15 ? 8 : 0);
    if (prev === BLOCK.REDSTONE_WIRE && id === BLOCK.REDSTONE_WIRE) {
      // Only the dust colour changed: batched (a clock would otherwise remesh its chunk every tick).
      this.deferredMesh.set(c, (this.deferredMesh.get(c) ?? 0) | border);
    } else {
      this.remeshAround(c, border);
    }
    if ((remote || this.simEdit) && (isRedstoneBlock(id) || isRedstoneBlock(prev) || SHAPE[id] === SHAPE_DOOR || BOX_KIND[id] !== 0)) {
      this.onRedstoneChange?.(x, y, z, prev, prevMeta, id, meta);
    }
    this.liquids?.notify(x, y, z);
    this.redstone?.notify(x, y, z);
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
          writeState(c, i, BLOCK.AIR, 0);
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
    // Plants, torches and doors lose their support (a door loses its other half too); the list grows while we walk it.
    const clearExtra = (x: number, y: number, z: number): void => {
      const c = this.chunkAt(x >> 4, z >> 4);
      if (!c || !c.blocks) return;
      const i = blockIndex(x & 15, y, z & 15);
      writeState(c, i, BLOCK.AIR, 0);
      this.edits.get(c.key)?.set(i, BLOCK.AIR) ?? this.edits.set(c.key, new Map([[i, BLOCK.AIR]]));
      this.dirtyEditChunks.add(c.key);
      touched.add(c);
      cleared.push(x, y, z);
    };
    for (let k = 0; k < cleared.length; k += 3) {
      const x = cleared[k], y = cleared[k + 1], z = cleared[k + 2];
      const above = this.getBlock(x, y + 1, z);
      if (SHAPE[above] === SHAPE_CROSS || SHAPE[above] === SHAPE_MODEL || SHAPE[above] === SHAPE_DOOR) clearExtra(x, y + 1, z);
      // A door half whose partner below was cleared (the cleared cell itself held the other half).
      const below = this.getBlock(x, y - 1, z);
      if (SHAPE[below] === SHAPE_DOOR && k / 3 < destroyed.length && destroyed[k / 3] === below) clearExtra(x, y - 1, z);
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
    if (this.liquids) for (let k = 0; k < cleared.length; k += 3) this.liquids.notify(cleared[k], cleared[k + 1], cleared[k + 2]);
    if (this.redstone) for (let k = 0; k < cleared.length; k += 3) this.redstone.notify(cleared[k], cleared[k + 1], cleared[k + 2]);
    return destroyed;
  }

  /**
   * Edit received from the server. Unloaded chunks just record it, so it is applied
   * when the chunk generates (the same path as saved edits).
   */
  applyRemoteEdit(x: number, y: number, z: number, id: number, meta = 0): void {
    if (y < 0 || y >= CHUNK_HEIGHT) return;
    if (this.setBlock(x, y, z, id, meta, true)) return;
    const key = chunkKey(x >> 4, z >> 4);
    let e = this.edits.get(key);
    if (!e) { e = new Map(); this.edits.set(key, e); }
    e.set(blockIndex(x & 15, y, z & 15), packState(id, meta));
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
        writeState(c, i, BLOCK.AIR, 0);
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
    if (isArenaWorld(this.worldType)) return arenaMapOf(this.worldType).spawns.ffa[0];
    for (let r = 0; r < 2000; r += 8) {
      const steps = Math.max(1, Math.floor((r * Math.PI * 2) / 16));
      for (let s = 0; s < steps; s++) {
        const a = (s / steps) * Math.PI * 2;
        const x = Math.round(Math.cos(a) * r), z = Math.round(Math.sin(a) * r);
        const h = this.generator.heightAt(x, z);
        const biome = this.generator.biomeAt(x, z, Math.floor(h));
        if (h > SEA_LEVEL + 2 && h < 85 && (biome === BIOME.PLAINS || biome === BIOME.FOREST || biome === BIOME.TAIGA) && !this.generator.surfaceOpen?.(x, z)) {
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
    const meta = this.getMeta(x, y, z);
    if (!this.setBlock(x, y, z, BLOCK.AIR)) return 0;
    if (SHAPE[id] === SHAPE_DOOR) {
      // Both halves go at once.
      const oy = isDoorUpper(meta) ? y - 1 : y + 1;
      if (this.getBlock(x, oy, z) === id) this.setBlock(x, oy, z, BLOCK.AIR);
    }
    if (BOX_KIND[id] === BOX_BED) {
      // Both halves of a bed go at once.
      const other = bedPartner(x, z, meta);
      if (this.getBlock(other.x, y, other.z) === id) this.setBlock(other.x, y, other.z, BLOCK.AIR);
    }
    const above = this.getBlock(x, y + 1, z);
    if (SHAPE[above] === SHAPE_CROSS || SHAPE[above] === SHAPE_MODEL) this.setBlock(x, y + 1, z, BLOCK.AIR);
    else if (SHAPE[above] === SHAPE_DOOR && SHAPE[id] !== SHAPE_DOOR) {
      // A door standing on the block that was broken falls apart.
      this.setBlock(x, y + 1, z, BLOCK.AIR);
      this.setBlock(x, y + 2, z, BLOCK.AIR);
    }
    return id;
  }

  /**
   * Opens or closes the door at (x, y, z), both halves together. Returns the new state (true = open), or
   * null when there is no door.
   */
  toggleDoor(x: number, y: number, z: number): boolean | null {
    const id = this.getBlock(x, y, z);
    if (SHAPE[id] !== SHAPE_DOOR) return null;
    const meta = this.getMeta(x, y, z);
    const open = (meta & DOOR_OPEN_BIT) === 0;
    const withOpen = (m: number) => (open ? m | DOOR_OPEN_BIT : m & ~DOOR_OPEN_BIT);
    this.setBlock(x, y, z, id, withOpen(meta));
    const oy = isDoorUpper(meta) ? y - 1 : y + 1;
    if (this.getBlock(x, oy, z) === id) this.setBlock(x, oy, z, id, withOpen(this.getMeta(x, oy, z)));
    return open;
  }

  /** Opens or closes the trapdoor or fence gate at (x, y, z); the new state (true = open), or null for any other block. */
  toggleBox(x: number, y: number, z: number): boolean | null {
    const id = this.getBlock(x, y, z);
    const kind = BOX_KIND[id];
    const bit = kind === BOX_TRAPDOOR ? TRAPDOOR_OPEN_BIT : kind === BOX_GATE ? GATE_OPEN_BIT : 0;
    if (!bit) return null;
    const meta = this.getMeta(x, y, z) ^ bit;
    this.setBlock(x, y, z, id, meta);
    return (meta & bit) !== 0;
  }

  dispose(): void {
    this.liquids?.clear();
    this.redstone?.clear();
    this.chunks.dispose();
  }
}

/** Writes id and state byte into a chunk, allocating its meta array only when a non-zero state first appears. */
function writeState(c: Chunk, i: number, id: number, meta: number): void {
  c.blocks![i] = id;
  if (meta !== 0 && !c.meta) c.meta = new Uint8Array(CHUNK_VOLUME);
  if (c.meta) c.meta[i] = meta;
}
