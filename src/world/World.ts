import type { WorkerPool } from '../workers/WorkerPool';
import { tintColor } from './BiomeColors';
import { BLOCK, SHAPE, SHAPE_CROSS, SOLID, TINT } from './BlockRegistry';
import { CHUNK_READY, type Chunk } from './Chunk';
import { ChunkManager, type ChunkMaterials } from './ChunkManager';
import { CHUNK_HEIGHT, SEA_LEVEL, blockIndex, chunkKey } from './constants';
import { BIOME, TerrainGenerator } from './TerrainGenerator';

/** Sparse player edits per chunk: block index → block id. */
export type EditMap = Map<number, Map<number, number>>;

export class World {
  readonly chunks: ChunkManager;
  /** Main-thread generator, only used for cheap 2D queries (spawn search, biome name). */
  readonly generator: TerrainGenerator;
  readonly edits: EditMap;
  readonly dirtyEditChunks = new Set<number>();

  constructor(readonly seed: number, pool: WorkerPool, materials: ChunkMaterials, edits: EditMap = new Map()) {
    this.generator = new TerrainGenerator(seed);
    this.edits = edits;
    this.chunks = new ChunkManager(seed, pool, materials);
    this.chunks.onGenerated = (chunk) => {
      const e = this.edits.get(chunk.key);
      if (e && chunk.blocks) for (const [i, id] of e) chunk.blocks[i] = id;
    };
  }

  private chunkAt(cx: number, cz: number): Chunk | undefined {
    const c = this.chunks.chunks.get(chunkKey(cx, cz));
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

  setBlock(x: number, y: number, z: number, id: number): boolean {
    if (y < 0 || y >= CHUNK_HEIGHT) return false;
    const cx = x >> 4, cz = z >> 4;
    const c = this.chunkAt(cx, cz);
    if (!c || !c.blocks) return false;
    const lx = x & 15, lz = z & 15;
    const i = blockIndex(lx, y, lz);
    if (c.blocks[i] === id) return false;
    c.blocks[i] = id;

    let e = this.edits.get(c.key);
    if (!e) { e = new Map(); this.edits.set(c.key, e); }
    e.set(i, id);
    this.dirtyEditChunks.add(c.key);

    // Light and AO reach into neighbouring chunks: remesh all 9, the edited one first,
    // border neighbours urgently (faces/AO change), the rest normally (light only).
    c.version++;
    this.chunks.requestMeshUrgent(c);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue;
        const n = this.chunks.get(cx + dx, cz + dz);
        if (!n || n.state !== CHUNK_READY) continue;
        n.version++;
        const touches = (dx === -1 ? lx === 0 : dx === 1 ? lx === 15 : true) && (dz === -1 ? lz === 0 : dz === 1 ? lz === 15 : true);
        if (touches) this.chunks.requestMeshUrgent(n);
      }
    }
    this.chunks.markDirty();
    return true;
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
    if (SHAPE[above] === SHAPE_CROSS) this.setBlock(x, y + 1, z, BLOCK.AIR);
    return id;
  }

  dispose(): void {
    this.chunks.dispose();
  }
}
