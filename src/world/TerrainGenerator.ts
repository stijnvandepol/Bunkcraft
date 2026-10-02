import { BLOCK } from './BlockRegistry';
import { CHUNK_HEIGHT, CHUNK_SIZE, SEA_LEVEL, blockIndex } from './constants';
import { SimplexNoise, hash2, hash3, lerp, mulberry32, smoothstep } from './Noise';

import { BIOME } from './Biomes';

export { BIOME, BIOME_NAMES } from './Biomes';

/** Continentalness → base height spline. */
const CONT_X = [-1, -0.45, -0.22, -0.1, 0.05, 0.35, 1];
const CONT_Y = [34, 42, 55, 62, 65, 71, 80];

function spline(x: number): number {
  if (x <= CONT_X[0]) return CONT_Y[0];
  for (let i = 1; i < CONT_X.length; i++) {
    if (x <= CONT_X[i]) {
      const t = (x - CONT_X[i - 1]) / (CONT_X[i] - CONT_X[i - 1]);
      return lerp(CONT_Y[i - 1], CONT_Y[i], t * t * (3 - 2 * t));
    }
  }
  return CONT_Y[CONT_Y.length - 1];
}

// Generation area is padded so trees from neighbouring chunks can drop leaves into this one.
const PAD = 3;
const W = CHUNK_SIZE + PAD * 2;
const TREE_CELL = 5;

// Coarse 3D cave grid: noise is sampled every 4 blocks and trilinearly interpolated.
const CAVE_STEP = 4;
const CAVE_NX = CHUNK_SIZE / CAVE_STEP + 1;
const CAVE_NY = CHUNK_HEIGHT / CAVE_STEP + 1;

/**
 * Deterministic terrain generator. Runs inside Web Workers; the main thread only uses
 * the cheap 2D height/biome functions (e.g. to find a dry spawn point).
 */
export class TerrainGenerator {
  private readonly continental: SimplexNoise;
  private readonly hills: SimplexNoise;
  private readonly detail: SimplexNoise;
  private readonly mountain: SimplexNoise;
  private readonly ridge: SimplexNoise;
  private readonly temperature: SimplexNoise;
  private readonly humidity: SimplexNoise;
  private readonly floorNoise: SimplexNoise;
  private readonly caveA: SimplexNoise;
  private readonly caveB: SimplexNoise;
  private readonly caveC: SimplexNoise;

  // Reused scratch buffers (no per-chunk allocations).
  private readonly heights = new Int16Array(W * W);
  private readonly biomes = new Uint8Array(W * W);
  private readonly caveFieldA = new Float32Array(CAVE_NX * CAVE_NX * CAVE_NY);
  private readonly caveFieldB = new Float32Array(CAVE_NX * CAVE_NX * CAVE_NY);
  private readonly caveFieldC = new Float32Array(CAVE_NX * CAVE_NX * CAVE_NY);

  constructor(readonly seed: number) {
    let s = seed;
    const next = () => (s = (Math.imul(s ^ (s >>> 15), 2246822519) + 0x9e3779b9) >>> 0);
    this.continental = new SimplexNoise(next());
    this.hills = new SimplexNoise(next());
    this.detail = new SimplexNoise(next());
    this.mountain = new SimplexNoise(next());
    this.ridge = new SimplexNoise(next());
    this.temperature = new SimplexNoise(next());
    this.humidity = new SimplexNoise(next());
    this.floorNoise = new SimplexNoise(next());
    this.caveA = new SimplexNoise(next());
    this.caveB = new SimplexNoise(next());
    this.caveC = new SimplexNoise(next());
  }

  heightAt(x: number, z: number): number {
    const c = this.continental.fbm2(x * 0.0011, z * 0.0011, 4);
    const base = spline(c);
    const hilliness = smoothstep(-0.3, 0.6, this.hills.fbm2(x * 0.0021, z * 0.0021, 2));
    const land = smoothstep(-0.25, -0.05, c);
    const detail = this.detail.fbm2(x * 0.011, z * 0.011, 4) * (2.5 + 9 * hilliness) * (0.35 + 0.65 * land);
    const m = smoothstep(0.08, 0.55, this.mountain.fbm2(x * 0.0016, z * 0.0016, 3)) * smoothstep(-0.12, 0.12, c);
    const r = 1 - Math.abs(this.ridge.fbm2(x * 0.0055, z * 0.0055, 4));
    const mountainHeight = m * (r * r * 52 + 6);
    return Math.max(4, Math.min(CHUNK_HEIGHT - 6, base + detail + mountainHeight));
  }

  biomeAt(x: number, z: number, h: number): number {
    if (h < SEA_LEVEL) return BIOME.OCEAN;
    const t = this.temperature.fbm2(x * 0.0009, z * 0.0009, 3);
    const hm = this.humidity.fbm2(x * 0.0011 + 300, z * 0.0011 - 300, 3);
    if (h <= SEA_LEVEL + 1 && t > -0.35) return BIOME.BEACH;
    if (h > 90) return BIOME.MOUNTAINS;
    if (t > 0.28 && hm < 0.12) return BIOME.DESERT;
    if (t < -0.38) return BIOME.SNOWY;
    if (t < -0.12) return BIOME.TAIGA;
    if (hm > 0.08) return BIOME.FOREST;
    return BIOME.PLAINS;
  }

  /** Fills `blocks` (length CHUNK_VOLUME) and `biomesOut` (16×16, x + z*16) for chunk (cx, cz). */
  generate(cx: number, cz: number, blocks: Uint8Array, biomesOut?: Uint8Array): void {
    blocks.fill(0);
    const ox = cx * CHUNK_SIZE;
    const oz = cz * CHUNK_SIZE;
    const heights = this.heights;
    const biomes = this.biomes;

    let maxH = SEA_LEVEL;
    for (let dz = 0; dz < W; dz++) {
      for (let dx = 0; dx < W; dx++) {
        const wx = ox + dx - PAD;
        const wz = oz + dz - PAD;
        const h = Math.floor(this.heightAt(wx, wz));
        heights[dz * W + dx] = h;
        biomes[dz * W + dx] = this.biomeAt(wx, wz, h);
        if (h > maxH) maxH = h;
      }
    }

    this.sampleCaves(ox, oz, Math.min(CHUNK_HEIGHT - 1, maxH + 2));

    for (let z = 0; z < CHUNK_SIZE; z++) {
      for (let x = 0; x < CHUNK_SIZE; x++) {
        const pi = (z + PAD) * W + (x + PAD);
        const h = heights[pi];
        const biome = biomes[pi];
        const slope = Math.max(
          Math.abs(heights[pi + 1] - h), Math.abs(heights[pi - 1] - h),
          Math.abs(heights[pi + W] - h), Math.abs(heights[pi - W] - h),
        );
        this.fillColumn(blocks, x, z, ox + x, oz + z, h, biome, slope);
      }
    }

    if (biomesOut) {
      for (let z = 0; z < CHUNK_SIZE; z++) {
        for (let x = 0; x < CHUNK_SIZE; x++) biomesOut[x + z * CHUNK_SIZE] = biomes[(z + PAD) * W + x + PAD];
      }
    }

    this.placeOres(blocks, cx, cz);
    this.placeVegetation(blocks, ox, oz);
  }

  private surfaceBlock(biome: number, h: number, slope: number, wx: number, wz: number): number {
    switch (biome) {
      case BIOME.OCEAN: {
        const n = this.floorNoise.noise2(wx * 0.05, wz * 0.05);
        return n > 0.45 ? BLOCK.CLAY : n < -0.35 ? BLOCK.GRAVEL : BLOCK.SAND;
      }
      case BIOME.BEACH:
      case BIOME.DESERT:
        return BLOCK.SAND;
      case BIOME.SNOWY:
        return slope >= 4 ? BLOCK.STONE : BLOCK.SNOWY_GRASS;
      case BIOME.MOUNTAINS: {
        const jitter = hash2(this.seed, wx, wz) * 4;
        if (h > 104 + jitter) return BLOCK.SNOW;
        if (slope >= 3) return hash2(this.seed + 7, wx, wz) < 0.15 ? BLOCK.GRAVEL : BLOCK.STONE;
        return h > 96 + jitter ? BLOCK.SNOWY_GRASS : BLOCK.GRASS;
      }
      default:
        return slope >= 5 ? BLOCK.STONE : BLOCK.GRASS;
    }
  }

  private fillColumn(
    blocks: Uint8Array, x: number, z: number, wx: number, wz: number,
    h: number, biome: number, slope: number,
  ): void {
    const top = this.surfaceBlock(biome, h, slope, wx, wz);
    const filler = top === BLOCK.SAND ? BLOCK.SAND
      : top === BLOCK.STONE || top === BLOCK.SNOW || top === BLOCK.GRAVEL ? BLOCK.STONE
      : top === BLOCK.CLAY ? BLOCK.CLAY : BLOCK.DIRT;
    const fillerDepth = biome === BIOME.DESERT ? 4 : 3;
    const underwater = h < SEA_LEVEL + 2;

    for (let y = 0; y <= Math.max(h, SEA_LEVEL); y++) {
      const i = blockIndex(x, y, z);
      if (y > h) {
        blocks[i] = BLOCK.WATER;
        continue;
      }
      if (y === 0 || (y < 4 && hash3(this.seed, wx, y, wz) < 0.55 - y * 0.15)) {
        blocks[i] = BLOCK.BEDROCK;
        continue;
      }
      const depth = h - y;
      let id: number;
      if (depth === 0) id = top;
      else if (depth <= fillerDepth) id = filler;
      else if (biome === BIOME.DESERT && depth <= fillerDepth + 4) id = BLOCK.SANDSTONE;
      else id = BLOCK.STONE;

      // Caves: keep a solid lid under oceans/lakes so water never hangs in mid-air.
      if (y > 4 && !(underwater && y > h - 7) && this.isCave(x, y, z, depth)) {
        // Deep caves fill with lava up to y = 10 (pre-1.18 Minecraft style lava lakes).
        blocks[i] = y <= 10 ? BLOCK.LAVA : BLOCK.AIR;
        continue;
      }
      blocks[i] = id;
    }
  }

  private sampleCaves(ox: number, oz: number, maxY: number): void {
    const ny = Math.min(CAVE_NY, Math.ceil(maxY / CAVE_STEP) + 1);
    for (let iy = 0; iy < ny; iy++) {
      const wy = iy * CAVE_STEP;
      for (let iz = 0; iz < CAVE_NX; iz++) {
        const wz = oz + iz * CAVE_STEP;
        for (let ix = 0; ix < CAVE_NX; ix++) {
          const wx = ox + ix * CAVE_STEP;
          const i = (iy * CAVE_NX + iz) * CAVE_NX + ix;
          this.caveFieldA[i] = this.caveA.noise3(wx * 0.021, wy * 0.034, wz * 0.021);
          this.caveFieldB[i] = this.caveB.noise3(wx * 0.021, wy * 0.034, wz * 0.021);
          this.caveFieldC[i] = this.caveC.noise3(wx * 0.013, wy * 0.024, wz * 0.013);
        }
      }
    }
  }

  private sampleField(field: Float32Array, x: number, y: number, z: number): number {
    const fx = x / CAVE_STEP, fy = y / CAVE_STEP, fz = z / CAVE_STEP;
    const x0 = Math.floor(fx), y0 = Math.floor(fy), z0 = Math.floor(fz);
    const tx = fx - x0, ty = fy - y0, tz = fz - z0;
    const i000 = (y0 * CAVE_NX + z0) * CAVE_NX + x0;
    const sy = CAVE_NX * CAVE_NX, sz = CAVE_NX;
    const c00 = lerp(field[i000], field[i000 + 1], tx);
    const c01 = lerp(field[i000 + sz], field[i000 + sz + 1], tx);
    const c10 = lerp(field[i000 + sy], field[i000 + sy + 1], tx);
    const c11 = lerp(field[i000 + sy + sz], field[i000 + sy + sz + 1], tx);
    return lerp(lerp(c00, c01, tz), lerp(c10, c11, tz), ty);
  }

  private isCave(x: number, y: number, z: number, depth: number): boolean {
    // Spaghetti tunnels: intersection of two noise "zero-surfaces".
    const a = this.sampleField(this.caveFieldA, x, y, z);
    const b = this.sampleField(this.caveFieldB, x, y, z);
    const width = depth < 4 ? 0.0022 : 0.0045;
    if (a * a + b * b < width) return true;
    // Larger "cheese" caverns deep underground.
    if (y < 44) {
      const c = this.sampleField(this.caveFieldC, x, y, z);
      if (c > 0.58 + (44 - y) * -0.002 && depth > 6) return true;
    }
    return false;
  }

  private placeOres(blocks: Uint8Array, cx: number, cz: number): void {
    const rand = mulberry32((hash2(this.seed, cx, cz) * 4294967296) >>> 0);
    const vein = (id: number, count: number, size: number, minY: number, maxY: number) => {
      for (let v = 0; v < count; v++) {
        let x = Math.floor(rand() * 16);
        let y = minY + Math.floor(rand() * (maxY - minY));
        let z = Math.floor(rand() * 16);
        const n = 2 + Math.floor(rand() * size);
        for (let k = 0; k < n; k++) {
          if (x >= 0 && x < 16 && z >= 0 && z < 16 && y > 0 && y < CHUNK_HEIGHT) {
            const i = blockIndex(x, y, z);
            if (blocks[i] === BLOCK.STONE) blocks[i] = id;
          }
          const d = Math.floor(rand() * 6);
          if (d === 0) x++; else if (d === 1) x--; else if (d === 2) y++;
          else if (d === 3) y--; else if (d === 4) z++; else z--;
        }
      }
    };
    vein(BLOCK.COAL_ORE, 16, 9, 6, 110);
    vein(BLOCK.IRON_ORE, 9, 6, 5, 64);
    vein(BLOCK.GOLD_ORE, 2, 5, 5, 32);
    vein(BLOCK.DIAMOND_ORE, 1, 4, 5, 16);
    vein(BLOCK.GRAVEL, 3, 16, 10, 60);
    vein(BLOCK.DIRT, 3, 16, 20, 60);
  }

  private placeVegetation(blocks: Uint8Array, ox: number, oz: number): void {
    const heights = this.heights;
    const biomes = this.biomes;
    const seed = this.seed;

    // Trees on a jittered grid: one candidate per 5×5 cell, evaluated identically by
    // every chunk the tree can reach, so trees crossing chunk borders stay consistent.
    const gx0 = Math.floor((ox - PAD) / TREE_CELL);
    const gx1 = Math.floor((ox + CHUNK_SIZE + PAD - 1) / TREE_CELL);
    const gz0 = Math.floor((oz - PAD) / TREE_CELL);
    const gz1 = Math.floor((oz + CHUNK_SIZE + PAD - 1) / TREE_CELL);
    for (let gz = gz0; gz <= gz1; gz++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const tx = gx * TREE_CELL + Math.floor(hash2(seed + 11, gx, gz) * TREE_CELL);
        const tz = gz * TREE_CELL + Math.floor(hash2(seed + 13, gx, gz) * TREE_CELL);
        const lx = tx - ox + PAD;
        const lz = tz - oz + PAD;
        if (lx < 1 || lz < 1 || lx >= W - 1 || lz >= W - 1) continue;
        const pi = lz * W + lx;
        const h = heights[pi];
        if (h <= SEA_LEVEL) continue;
        const slope = Math.max(
          Math.abs(heights[pi + 1] - h), Math.abs(heights[pi - 1] - h),
          Math.abs(heights[pi + W] - h), Math.abs(heights[pi - W] - h),
        );
        if (slope > 2) continue;
        const biome = biomes[pi];
        const roll = hash2(seed + 17, gx, gz);
        const kind = hash2(seed + 19, gx, gz);
        const size = hash2(seed + 23, gx, gz);
        const bx = tx - ox, bz = tz - oz;
        switch (biome) {
          case BIOME.FOREST:
            if (roll < 0.8) {
              if (kind < 0.3) this.oakTree(blocks, bx, h + 1, bz, 5 + Math.floor(size * 3), BLOCK.BIRCH_LOG, BLOCK.BIRCH_LEAVES, tx, tz);
              else this.oakTree(blocks, bx, h + 1, bz, 4 + Math.floor(size * 3), BLOCK.OAK_LOG, BLOCK.OAK_LEAVES, tx, tz);
            }
            break;
          case BIOME.PLAINS:
            if (roll < 0.05) this.oakTree(blocks, bx, h + 1, bz, 4 + Math.floor(size * 3), BLOCK.OAK_LOG, BLOCK.OAK_LEAVES, tx, tz);
            break;
          case BIOME.TAIGA:
            if (roll < 0.6) this.spruceTree(blocks, bx, h + 1, bz, 6 + Math.floor(size * 4));
            break;
          case BIOME.SNOWY:
            if (roll < 0.12) this.spruceTree(blocks, bx, h + 1, bz, 6 + Math.floor(size * 4));
            break;
          case BIOME.MOUNTAINS:
            if (roll < 0.12 && h < 96) this.spruceTree(blocks, bx, h + 1, bz, 6 + Math.floor(size * 3));
            break;
          case BIOME.DESERT:
            if (roll < 0.1 && bx >= 0 && bx < 16 && bz >= 0 && bz < 16) {
              const ch = 1 + Math.floor(size * 3);
              for (let y = 0; y < ch; y++) this.setIfAir(blocks, bx, h + 1 + y, bz, BLOCK.CACTUS);
            }
            break;
        }
      }
    }

    // Ground cover: grass, flowers, dead bushes.
    for (let z = 0; z < CHUNK_SIZE; z++) {
      for (let x = 0; x < CHUNK_SIZE; x++) {
        const pi = (z + PAD) * W + (x + PAD);
        const h = heights[pi];
        if (h + 1 >= CHUNK_HEIGHT) continue;
        const below = blocks[blockIndex(x, h, z)];
        if (blocks[blockIndex(x, h + 1, z)] !== BLOCK.AIR) continue;
        const r = hash2(seed + 29, ox + x, oz + z);
        const biome = biomes[pi];
        let plant = 0;
        if (below === BLOCK.GRASS) {
          if (biome === BIOME.PLAINS) plant = r < 0.2 ? BLOCK.TALL_GRASS : r < 0.215 ? BLOCK.DANDELION : r < 0.228 ? BLOCK.POPPY : 0;
          else if (biome === BIOME.FOREST) plant = r < 0.1 ? BLOCK.TALL_GRASS : r < 0.108 ? BLOCK.POPPY : r < 0.114 ? BLOCK.DANDELION : 0;
          else plant = r < 0.06 ? BLOCK.TALL_GRASS : 0;
        } else if (below === BLOCK.SAND && biome === BIOME.DESERT) {
          plant = r < 0.008 ? BLOCK.DEAD_BUSH : 0;
        }
        if (plant) blocks[blockIndex(x, h + 1, z)] = plant;
      }
    }
  }

  private setIfAir(blocks: Uint8Array, x: number, y: number, z: number, id: number): void {
    if (x < 0 || x >= 16 || z < 0 || z >= 16 || y < 0 || y >= CHUNK_HEIGHT) return;
    const i = blockIndex(x, y, z);
    const cur = blocks[i];
    if (cur === BLOCK.AIR || cur === BLOCK.TALL_GRASS || cur === BLOCK.DANDELION || cur === BLOCK.POPPY) blocks[i] = id;
  }

  private setLog(blocks: Uint8Array, x: number, y: number, z: number, id: number): void {
    if (x < 0 || x >= 16 || z < 0 || z >= 16 || y < 0 || y >= CHUNK_HEIGHT) return;
    const i = blockIndex(x, y, z);
    const cur = blocks[i];
    if (cur === BLOCK.AIR || cur === BLOCK.OAK_LEAVES || cur === BLOCK.BIRCH_LEAVES || cur === BLOCK.SPRUCE_LEAVES
      || cur === BLOCK.TALL_GRASS || cur === BLOCK.DANDELION || cur === BLOCK.POPPY) blocks[i] = id;
  }

  /** Classic blob tree (oak/birch). (x, z) are chunk-local and may lie outside 0..15. */
  private oakTree(
    blocks: Uint8Array, x: number, y: number, z: number, height: number,
    log: number, leaves: number, wx: number, wz: number,
  ): void {
    if (y + height + 1 >= CHUNK_HEIGHT) return;
    const top = y + height - 1;
    for (let ly = top - 2; ly <= top + 1; ly++) {
      const r = ly >= top ? 1 : 2;
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          const corner = Math.abs(dx) === r && Math.abs(dz) === r;
          if (corner && (ly === top + 1 || hash3(this.seed + 31, wx + dx, ly, wz + dz) < 0.5)) continue;
          this.setIfAir(blocks, x + dx, ly, z + dz, leaves);
        }
      }
    }
    for (let i = 0; i < height; i++) this.setLog(blocks, x, y + i, z, log);
    if (x >= 0 && x < 16 && z >= 0 && z < 16 && y > 0) {
      const under = blockIndex(x, y - 1, z);
      if (blocks[under] === BLOCK.GRASS || blocks[under] === BLOCK.SNOWY_GRASS) blocks[under] = BLOCK.DIRT;
    }
  }

  private spruceTree(blocks: Uint8Array, x: number, y: number, z: number, height: number): void {
    if (y + height + 1 >= CHUNK_HEIGHT) return;
    const top = y + height;
    this.setIfAir(blocks, x, top, z, BLOCK.SPRUCE_LEAVES);
    // Conical shape, alternating radii from the tip down: 1, 0, 1, 2, 1, 2, ...
    for (let ly = top - 1; ly >= y + 2; ly--) {
      const k = top - 1 - ly;
      const r = k === 0 ? 1 : k === 1 ? 0 : k % 2 === 0 ? 1 : 2;
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (r > 0 && Math.abs(dx) === r && Math.abs(dz) === r) continue;
          this.setIfAir(blocks, x + dx, ly, z + dz, BLOCK.SPRUCE_LEAVES);
        }
      }
    }
    for (let i = 0; i < height; i++) this.setLog(blocks, x, y + i, z, BLOCK.SPRUCE_LOG);
  }
}
