import { BLOCK, CUBE_ID } from './BlockRegistry';
import { BIOME } from './Biomes';
import { CaveCarver } from './CaveCarver';
import { CHUNK_HEIGHT, CHUNK_SIZE, CHUNK_VOLUME, SEA_LEVEL, blockIndex } from './constants';
import { SimplexNoise, hash2, hash3, lerp, mulberry32, smoothstep } from './Noise';
import { placeOreBlobs, resolveOres } from './OreTable';
import { type StructureContext, placeStructures } from './Structures';
import { TreeBuilder } from './TreesV3';

/**
 * Terrain generator version 3: climate-driven biomes, rivers, rock variety, deepslate and the new content.
 *
 * It replaces the surface of versions 1 and 2 (those stay in TerrainGenerator.ts, byte-identical) and keeps the underground
 * machinery of version 2 (CaveCarver, OreTable). Everything is a pure function of the seed and the world position, so
 * chunks agree on their borders whatever the generation order.
 *
 * Per column (`col`): the v2 terrain height (continentalness, hills, mountains), then
 *   - badlands terraces and swamp flats, blended by smooth climate weights (not by the biome id, so heights have no seams),
 *   - a river valley: a domain-warped noise contour, carved to a bed below sea level, banks blending into the land,
 * and the biome from temperature, humidity, continentalness, mountain mask and a variant noise.
 */

/** Continentalness → base height spline (same as version 2). */
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

const PAD = 3;
const W = CHUNK_SIZE + PAD * 2;
const TREE_CELL = 5;
/** How far a tree crown reaches from its trunk (jungle branches and the dark oak canopy are the widest). */
const TREE_REACH = 5;

/** River: half width of the channel and of the valley in noise units (the noise gradient is ~0.004 per block). */
const RIVER_CHAN = 0.020;
const RIVER_FREQ = 0.0016;

const C = CUBE_ID;
const MUD = C.mud, PODZOL = C.podzol, COARSE = C.coarse_dirt, RED_SAND = C.red_sand;
const ICE = C.ice, PACKED_ICE = C.packed_ice, DEEPSLATE = C.deepslate, TERRACOTTA = C.terracotta;
const SUGAR_CANE = C.sugar_cane, FERN = C.fern, PUMPKIN = C.pumpkin, MELON = C.melon;
const BROWN_MUSHROOM = C.brown_mushroom, RED_MUSHROOM = C.red_mushroom;
const FLOWERS_ALL = [BLOCK.DANDELION, BLOCK.POPPY, C.blue_orchid, C.allium, C.azure_bluet, C.red_tulip, C.orange_tulip,
  C.oxeye_daisy, C.cornflower, C.lily_of_the_valley];
const FLOWERS_MEADOW = [C.cornflower, C.allium, C.azure_bluet, BLOCK.DANDELION, C.oxeye_daisy];

/** Stained terracotta colours of the badlands bands (index into DYES): orange, white, yellow, brown, red, light gray. */
const BAND_COLOURS = [1, 0, 4, 12, 14, 8];
const BAND_RAW = 140;

/** Chunk-local scratch results of one column. */
interface ColumnScratch {
  h: number;
  biome: number;
  t: number;
}

export class GeneratorV3 {
  private readonly continental: SimplexNoise;
  private readonly hills: SimplexNoise;
  private readonly detail: SimplexNoise;
  private readonly mountain: SimplexNoise;
  private readonly ridge: SimplexNoise;
  private readonly temperature: SimplexNoise;
  private readonly humidity: SimplexNoise;
  private readonly floorNoise: SimplexNoise;
  private readonly variant: SimplexNoise;
  private readonly warpA: SimplexNoise;
  private readonly warpB: SimplexNoise;
  private readonly river: SimplexNoise;
  private readonly patch: SimplexNoise;
  private readonly flat: SimplexNoise;
  private readonly bandN: SimplexNoise;

  readonly carver: CaveCarver;
  private readonly ores: ReturnType<typeof resolveOres>;
  /** Terracotta band per world layer: 0 = plain terracotta, 1.. = stained colour index + 1. */
  private readonly bands = new Uint8Array(BAND_RAW);
  /** What structure features may ask of the world: integer surface heights and biomes of any column. */
  private readonly structureCtx: StructureContext;

  private readonly heights = new Int16Array(W * W);
  private readonly biomes = new Uint8Array(W * W);
  private readonly temps = new Float32Array(W * W);
  private readonly meta = new Uint8Array(CHUNK_VOLUME);
  private metaUsed = false;

  // Cache of the last column (heightAt and biomeAt are nearly always called as a pair).
  private cx = Number.NaN;
  private cz = Number.NaN;
  private readonly out: ColumnScratch = { h: 0, biome: 0, t: 0 };

  // Surface scratch.
  private sTop = 0; private sFill = 0; private sDepth = 3; private sBand = false;

  constructor(readonly seed: number, readonly genVersion: number) {
    let s = seed;
    const next = () => (s = (Math.imul(s ^ (s >>> 15), 2246822519) + 0x9e3779b9) >>> 0);
    // Same stream as TerrainGenerator for the shared noises, so the land has the same shape as before.
    this.continental = new SimplexNoise(next());
    this.hills = new SimplexNoise(next());
    this.detail = new SimplexNoise(next());
    this.mountain = new SimplexNoise(next());
    this.ridge = new SimplexNoise(next());
    this.temperature = new SimplexNoise(next());
    this.humidity = new SimplexNoise(next());
    this.floorNoise = new SimplexNoise(next());
    next(); next(); next(); // the cave noises of version 1
    this.variant = new SimplexNoise(next());
    this.warpA = new SimplexNoise(next());
    this.warpB = new SimplexNoise(next());
    this.river = new SimplexNoise(next());
    this.patch = new SimplexNoise(next());
    this.flat = new SimplexNoise(next());
    this.bandN = new SimplexNoise(next());
    this.carver = new CaveCarver(seed);
    this.structureCtx = {
      seed,
      heightAt: (x, z) => Math.floor(this.heightAt(x, z)),
      biomeAt: (x, z) => this.biomeAt(x, z),
    };
    this.ores = resolveOres(genVersion);

    // Terracotta bands: runs of 1-3 layers, mostly plain terracotta.
    const rand = mulberry32(seed ^ 0x7e44ac07);
    let y = 0;
    while (y < BAND_RAW) {
      const run = 1 + Math.floor(rand() * 3);
      const v = rand() < 0.5 ? 0 : 1 + Math.floor(rand() * BAND_COLOURS.length);
      for (let k = 0; k < run && y < BAND_RAW; k++) this.bands[y++] = v;
    }
  }

  // ------------------------------------------------------------------ columns

  /** Fills `out` (and the mountain/river scratch) for world column (x, z). */
  private col(x: number, z: number): void {
    const c = this.continental.fbm2(x * 0.0011, z * 0.0011, 4);
    const base = spline(c);
    const hilliness = smoothstep(-0.3, 0.6, this.hills.fbm2(x * 0.0021, z * 0.0021, 2));
    const land = smoothstep(-0.25, -0.05, c);
    const detail = this.detail.fbm2(x * 0.011, z * 0.011, 4) * (2.5 + 9 * hilliness) * (0.35 + 0.65 * land);
    const m = smoothstep(0.08, 0.55, this.mountain.fbm2(x * 0.0016, z * 0.0016, 3)) * smoothstep(-0.12, 0.12, c);
    const r = 1 - Math.abs(this.ridge.fbm2(x * 0.0055, z * 0.0055, 4));
    let h = base + detail + m * (r * r * 52 + 6);
    const hBase = h;

    const t = this.temperature.fbm2(x * 0.0009, z * 0.0009, 3);
    const hm = this.humidity.fbm2(x * 0.0011 + 300, z * 0.0011 - 300, 3);
    const v = this.variant.fbm2(x * 0.0024 + 77, z * 0.0024 - 41, 2);

    // Badlands: hot, dry, inland, in patches picked by the variant noise. Terraced mesas.
    const wBad = smoothstep(0.17, 0.27, t) * smoothstep(0.04, -0.08, hm) * smoothstep(-0.05, 0.15, v) * smoothstep(-0.05, 0.08, c);
    if (wBad > 0) {
      const q = (h - 60) / 6;
      const fl = Math.floor(q);
      const terrace = 60 + 6 * (fl + smoothstep(0.8, 1, q - fl)) + 5;
      h = lerp(h, terrace, wBad);
    }
    // Swamp: warm-ish, very wet, low and near the coast. Flat at sea level with shallow pools.
    const wSwamp = smoothstep(0.24, 0.34, hm) * smoothstep(-0.12, -0.02, t) * (1 - smoothstep(0.32, 0.42, t))
      * (1 - smoothstep(66, 74, hBase)) * smoothstep(55, 59, hBase);
    if (wSwamp > 0) h = lerp(h, 62.5 + this.flat.noise2(x * 0.035, z * 0.035) * 1.9, wSwamp);

    // River: contour of a domain-warped noise, a valley that narrows with the terrain it cuts through.
    const wx = x + this.warpA.noise2(x * 0.0035, z * 0.0035) * 55;
    const wz = z + this.warpB.noise2(x * 0.0035 + 13, z * 0.0035 - 7) * 55;
    const rn = Math.abs(this.river.noise2(wx * RIVER_FREQ, wz * RIVER_FREQ));
    const valley = 0.05 + 0.0035 * Math.max(0, h - 62);
    let f = 0;
    if (rn < valley) {
      f = (1 - smoothstep(RIVER_CHAN, valley, rn)) * (1 - smoothstep(84, 104, h));
      if (f > 0) {
        const k = Math.min(1, rn / RIVER_CHAN);
        const bed = 57.6 + 3.8 * k * k;
        const target = lerp(h, bed, f);
        if (target < h) h = target;
      }
    }

    h = Math.max(4, Math.min(CHUNK_HEIGHT - 6, h));
    const hi = Math.floor(h);
    this.out.h = h;
    this.out.t = t;
    this.out.biome = this.pickBiome(hi, hBase, c, t, hm, v, m, wBad, wSwamp, rn, f);
    this.cx = x; this.cz = z;
  }

  private pickBiome(
    hi: number, hBase: number, c: number, t: number, hm: number, v: number, m: number,
    wBad: number, wSwamp: number, rn: number, f: number,
  ): number {
    if (hi < SEA_LEVEL) {
      if (wSwamp > 0.5) return BIOME.SWAMP;
      // River: the channel of a valley cut into land (a few blocks of coastal shallows count as land too).
      if (f > 0.9 && rn < RIVER_CHAN * 1.4 && hBase >= SEA_LEVEL - 4) return t < -0.3 ? BIOME.FROZEN_RIVER : BIOME.RIVER;
      if (hi < 46) return BIOME.DEEP_OCEAN;
      if (t > 0.30) return BIOME.WARM_OCEAN;
      if (t < -0.40) return BIOME.FROZEN_OCEAN;
      if (t < -0.14) return BIOME.COLD_OCEAN;
      return BIOME.OCEAN;
    }
    if (wBad > 0.5) return BIOME.BADLANDS;
    if (wSwamp > 0.5) return BIOME.SWAMP;
    // Shores: beaches along the coast (low continentalness) and the sandy banks of rivers.
    if (hi <= SEA_LEVEL + 1 && (c < 0.0 || f > 0.3)) {
      if (m > 0.3) return BIOME.STONY_SHORE;
      return t < -0.35 ? BIOME.SNOWY_BEACH : BIOME.BEACH;
    }
    if (hi > 90) return BIOME.MOUNTAINS;
    // Foothills of the mountains.
    if (m > 0.12 && hi > 74) {
      if (t < -0.38) return BIOME.MOUNTAINS;
      if (v > 0.3 && t > -0.12 && t < 0.3) return BIOME.CHERRY_GROVE;
      if (v > -0.1 && t > -0.25 && t < 0.3) return BIOME.MEADOW;
      return BIOME.WINDSWEPT_HILLS;
    }
    // Climate table (temperature bands × humidity), thresholds at roughly Minecraft-like area shares.
    if (t < -0.38) return hm > -0.08 ? BIOME.SNOWY_TAIGA : BIOME.SNOWY;
    if (t < -0.13) return hm > -0.25 ? BIOME.TAIGA : BIOME.PLAINS;
    if (t >= 0.15) {
      const hot = t >= 0.32;
      if (hm < (hot ? 0.02 : -0.12)) return BIOME.DESERT;
      return hm < (hot ? 0.22 : 0.18) ? BIOME.SAVANNA : BIOME.JUNGLE;
    }
    if (hm > 0.3) return BIOME.DARK_FOREST;
    if (hm > -0.1) return v > 0.34 ? BIOME.FLOWER_FOREST : v < -0.3 ? BIOME.BIRCH_FOREST : BIOME.FOREST;
    if (hm > -0.22 && v < -0.25) return BIOME.BIRCH_FOREST;
    return BIOME.PLAINS;
  }

  heightAt(x: number, z: number): number {
    if (this.cx !== x || this.cz !== z) this.col(x, z);
    return this.out.h;
  }

  biomeAt(x: number, z: number, _h?: number): number {
    if (this.cx !== x || this.cz !== z) this.col(x, z);
    return this.out.biome;
  }

  surfaceOpen(x: number, z: number): boolean {
    const h = Math.floor(this.heightAt(x, z));
    const mn = Math.floor(Math.min(this.heightAt(x + 1, z), this.heightAt(x - 1, z), this.heightAt(x, z + 1), this.heightAt(x, z - 1)));
    return this.carver.carvedAt(x, h, z, h, mn);
  }

  /** Altitude above which it is snow-covered stone, lower in cold climates. */
  private snowLine(t: number): number {
    return Math.max(76, Math.min(126, 104 + 45 * t));
  }

  // ------------------------------------------------------------------ chunk

  /** Fills `blocks` and `biomesOut`; returns the block state bytes of the chunk, or null when every state is 0. */
  generate(cx: number, cz: number, blocks: Uint8Array, biomesOut?: Uint8Array): Uint8Array | null {
    blocks.fill(0);
    if (this.metaUsed) { this.meta.fill(0); this.metaUsed = false; }
    const ox = cx * CHUNK_SIZE, oz = cz * CHUNK_SIZE;
    const heights = this.heights, biomes = this.biomes, temps = this.temps;

    for (let dz = 0; dz < W; dz++) {
      for (let dx = 0; dx < W; dx++) {
        const wx = ox + dx - PAD, wz = oz + dz - PAD;
        this.col(wx, wz);
        const i = dz * W + dx;
        heights[i] = Math.floor(this.out.h);
        biomes[i] = this.out.biome;
        temps[i] = this.out.t;
      }
    }

    for (let z = 0; z < CHUNK_SIZE; z++) {
      for (let x = 0; x < CHUNK_SIZE; x++) {
        const pi = (z + PAD) * W + (x + PAD);
        this.fillColumn(blocks, x, z, ox + x, oz + z, heights[pi], biomes[pi], this.slopeAt(pi), temps[pi]);
      }
    }

    const biomeMap = biomesOut ?? new Uint8Array(CHUNK_SIZE * CHUNK_SIZE);
    for (let z = 0; z < CHUNK_SIZE; z++) {
      for (let x = 0; x < CHUNK_SIZE; x++) biomeMap[x + z * CHUNK_SIZE] = biomes[(z + PAD) * W + x + PAD];
    }

    this.carver.carve(blocks, ox, oz, heights, W, PAD);
    placeOreBlobs(blocks, this.seed, cx, cz, this.ores, biomeMap);
    this.placeSprings(blocks, cx, cz);
    this.placeCaveMushrooms(blocks, ox, oz);
    this.placeVegetation(blocks, ox, oz);
    if (this.metaUsed) {
      // Band colours of terracotta that caves, ores or plants replaced afterwards must not stay behind.
      const meta = this.meta;
      for (let i = 0; i < CHUNK_VOLUME; i++) if (meta[i] !== 0 && blocks[i] !== BLOCK.STAINED_TERRACOTTA) meta[i] = 0;
    }
    placeStructures(blocks, this.meta, () => { this.metaUsed = true; }, this.structureCtx, cx, cz, this.genVersion);
    return this.metaUsed ? this.meta.slice() : null;
  }

  private slopeAt(pi: number): number {
    const hs = this.heights, h = hs[pi];
    return Math.max(Math.abs(hs[pi + 1] - h), Math.abs(hs[pi - 1] - h), Math.abs(hs[pi + W] - h), Math.abs(hs[pi - W] - h));
  }

  // ------------------------------------------------------------------ surface

  /** Sets sTop/sFill/sDepth/sBand for a column. */
  private surface(biome: number, h: number, slope: number, wx: number, wz: number, t: number): void {
    this.sDepth = 3;
    this.sBand = false;
    let top: number = BLOCK.GRASS;
    let fill = -1;
    const n = this.floorNoise.noise2(wx * 0.05, wz * 0.05);
    switch (biome) {
      case BIOME.OCEAN:
        top = n > 0.45 ? BLOCK.CLAY : n < -0.35 ? BLOCK.GRAVEL : BLOCK.SAND; break;
      case BIOME.WARM_OCEAN:
        top = n > 0.55 ? BLOCK.CLAY : BLOCK.SAND; break;
      case BIOME.COLD_OCEAN: case BIOME.FROZEN_OCEAN:
        top = n > 0.45 ? BLOCK.CLAY : n > -0.1 ? BLOCK.GRAVEL : BLOCK.SAND; break;
      case BIOME.DEEP_OCEAN:
        top = n > 0.3 ? BLOCK.CLAY : n < -0.55 ? BLOCK.SAND : BLOCK.GRAVEL; break;
      case BIOME.RIVER: case BIOME.FROZEN_RIVER:
        top = n > 0.3 ? BLOCK.CLAY : n < -0.2 ? BLOCK.GRAVEL : BLOCK.SAND; break;
      case BIOME.BEACH: case BIOME.SNOWY_BEACH:
        top = BLOCK.SAND;
        break;
      case BIOME.STONY_SHORE:
        top = slope >= 2 ? BLOCK.STONE : BLOCK.GRAVEL; break;
      case BIOME.DESERT:
        top = BLOCK.SAND; this.sDepth = 4; break;
      case BIOME.BADLANDS: {
        const p = this.patch.noise2(wx * 0.06, wz * 0.06);
        const exposed = slope >= 2;
        this.sBand = true;
        this.sDepth = 0;
        top = exposed ? -1 : p > 0.1 ? RED_SAND : p < -0.45 ? COARSE : -1; // -1 = a terracotta band block
        fill = -2;
        break;
      }
      case BIOME.SWAMP:
        if (h <= SEA_LEVEL) { top = n > 0.62 ? BLOCK.CLAY : MUD; fill = top === MUD ? MUD : BLOCK.CLAY; } else top = BLOCK.GRASS;
        break;
      case BIOME.SNOWY:
        top = slope >= 4 ? BLOCK.STONE : BLOCK.SNOWY_GRASS; break;
      case BIOME.SNOWY_TAIGA:
        top = slope >= 5 ? BLOCK.STONE : this.patch.noise2(wx * 0.045, wz * 0.045) > 0.4 ? PODZOL : BLOCK.SNOWY_GRASS; break;
      case BIOME.TAIGA: {
        const p = this.patch.noise2(wx * 0.045, wz * 0.045);
        top = slope >= 5 ? BLOCK.STONE : p > 0.3 ? PODZOL : p < -0.62 ? COARSE : BLOCK.GRASS;
        break;
      }
      case BIOME.SAVANNA:
        top = slope >= 5 ? BLOCK.STONE : this.patch.noise2(wx * 0.045, wz * 0.045) > 0.38 ? COARSE : BLOCK.GRASS; break;
      case BIOME.DARK_FOREST:
        top = slope >= 5 ? BLOCK.STONE : this.patch.noise2(wx * 0.05, wz * 0.05) > 0.5 ? PODZOL : BLOCK.GRASS; break;
      case BIOME.JUNGLE:
        top = slope >= 5 ? BLOCK.STONE : this.patch.noise2(wx * 0.05, wz * 0.05) > 0.6 ? PODZOL : BLOCK.GRASS; break;
      case BIOME.MOUNTAINS: case BIOME.WINDSWEPT_HILLS:
        top = slope >= 3 ? (hash2(this.seed + 7, wx, wz) < 0.15 ? BLOCK.GRAVEL : BLOCK.STONE) : BLOCK.GRASS;
        if (biome === BIOME.WINDSWEPT_HILLS && top === BLOCK.GRASS && this.patch.noise2(wx * 0.07, wz * 0.07) > 0.35) top = BLOCK.GRAVEL;
        break;
      default:
        top = slope >= 5 ? BLOCK.STONE : BLOCK.GRASS;
    }
    // Snow line: by altitude and temperature (colder = lower). Not in the hot biomes.
    if (h >= 80 && biome !== BIOME.DESERT && biome !== BIOME.BADLANDS && biome !== BIOME.SAVANNA && biome !== BIOME.JUNGLE
      && biome !== BIOME.BEACH && biome !== BIOME.RIVER) {
      const jitter = hash2(this.seed, wx, wz) * 4;
      const sl = this.snowLine(t) + jitter;
      if (h > sl) top = hash2(this.seed + 9, wx, wz) < 0.05 && t < -0.1 ? PACKED_ICE : (slope >= 4 ? BLOCK.STONE : BLOCK.SNOW);
      else if (h > sl - 6 && slope < 3 && (top === BLOCK.GRASS || top === PODZOL) && t < 0.1) top = BLOCK.SNOWY_GRASS;
    }
    if (fill === -1) {
      fill = top === BLOCK.SAND ? BLOCK.SAND
        : top === BLOCK.STONE || top === BLOCK.SNOW || top === BLOCK.GRAVEL || top === PACKED_ICE ? BLOCK.STONE
        : top === BLOCK.CLAY ? BLOCK.CLAY : top === MUD ? MUD : BLOCK.DIRT;
    }
    if (top === BLOCK.GRAVEL && (biome === BIOME.RIVER || biome === BIOME.FROZEN_RIVER || biome === BIOME.OCEAN
      || biome === BIOME.COLD_OCEAN || biome === BIOME.FROZEN_OCEAN || biome === BIOME.DEEP_OCEAN)) fill = BLOCK.GRAVEL;
    this.sTop = top;
    this.sFill = fill;
  }

  /** The terracotta band block at layer y of column (wx, wz); writes the state to `meta` index when stained. */
  private bandBlock(y: number, wx: number, wz: number, mi: number): number {
    const shift = Math.floor(this.bandN.noise2(wx * 0.025, wz * 0.025) * 2.5);
    const yy = Math.max(0, Math.min(BAND_RAW - 1, y + shift));
    const b = this.bands[yy];
    if (b === 0) return TERRACOTTA;
    this.meta[mi] = BAND_COLOURS[b - 1];
    this.metaUsed = true;
    return BLOCK.STAINED_TERRACOTTA;
  }

  private fillColumn(
    blocks: Uint8Array, x: number, z: number, wx: number, wz: number,
    h: number, biome: number, slope: number, t: number,
  ): void {
    this.surface(biome, h, slope, wx, wz, t);
    const top = this.sTop, fill = this.sFill, fillDepth = this.sDepth, band = this.sBand;
    const frozen = biome === BIOME.FROZEN_OCEAN || biome === BIOME.FROZEN_RIVER;
    const sandstone = biome === BIOME.DESERT;
    const seed = this.seed;

    for (let y = 0; y <= Math.max(h, SEA_LEVEL); y++) {
      const i = blockIndex(x, y, z);
      if (y > h) {
        blocks[i] = frozen && y === SEA_LEVEL
          ? (this.patch.noise2(wx * 0.04, wz * 0.04) > 0.45 ? PACKED_ICE : ICE)
          : BLOCK.WATER;
        continue;
      }
      if (y === 0 || (y < 4 && hash3(seed, wx, y, wz) < 0.55 - y * 0.15)) { blocks[i] = BLOCK.BEDROCK; continue; }
      const depth = h - y;
      let id: number;
      if (band) {
        // Badlands: banded terracotta from far below the surface up to a thin red-sand/coarse-dirt skin.
        if (depth === 0 && top > 0) id = top;
        else if (y >= SEA_LEVEL - 6 && depth < 26) id = this.bandBlock(y, wx, wz, i);
        else id = BLOCK.STONE;
      } else if (depth === 0) id = top;
      else if (depth <= fillDepth) id = fill;
      else if (sandstone && depth <= fillDepth + 4) id = BLOCK.SANDSTONE;
      else id = BLOCK.STONE;

      if (id === BLOCK.STONE) {
        // Deepslate layer: solid below y 7, a random gradient up to y 16.
        if (y < 7 || (y < 16 && hash3(seed + 101, wx, y, wz) < (16 - y) / 9)) id = DEEPSLATE;
      }
      blocks[i] = id;
    }
  }

  // ------------------------------------------------------------------ springs and cave plants

  /** Minecraft-style springs: a single liquid source in a stone wall with exactly one open side. */
  private placeSprings(blocks: Uint8Array, cx: number, cz: number): void {
    const rand = mulberry32((hash2(this.seed + 211, cx, cz) * 4294967296) >>> 0);
    const spring = (id: number, tries: number, minY: number, maxY: number) => {
      for (let k = 0; k < tries; k++) {
        const x = 1 + Math.floor(rand() * 14), z = 1 + Math.floor(rand() * 14);
        const y = minY + Math.floor(rand() * (maxY - minY));
        const i = blockIndex(x, y, z);
        const b = blocks[i];
        if (b !== BLOCK.STONE && b !== DEEPSLATE) continue;
        let air = 0, solid = 0;
        for (let d = 0; d < 6; d++) {
          const j = d === 0 ? i + 1 : d === 1 ? i - 1 : d === 2 ? i + 16 : d === 3 ? i - 16 : d === 4 ? i + 256 : i - 256;
          const nb = blocks[j];
          if (nb === BLOCK.AIR) air++;
          else if (nb === BLOCK.STONE || nb === DEEPSLATE || nb === C.granite || nb === C.diorite || nb === C.andesite || nb === C.tuff
            || nb === BLOCK.COAL_ORE || nb === BLOCK.IRON_ORE || nb === BLOCK.GRAVEL || nb === BLOCK.DIRT) solid++;
        }
        if (air === 1 && solid === 5) blocks[i] = id;
      }
    };
    spring(BLOCK.WATER, 22, 8, 108);
    spring(BLOCK.LAVA, 9, 6, 52);
  }

  /** Brown and red mushrooms on the floor of deep caves. */
  private placeCaveMushrooms(blocks: Uint8Array, ox: number, oz: number): void {
    const seed = this.seed;
    for (let z = 0; z < CHUNK_SIZE; z++) {
      for (let x = 0; x < CHUNK_SIZE; x++) {
        const h = this.heights[(z + PAD) * W + x + PAD];
        const top = Math.min(h - 8, 52);
        for (let y = 6; y <= top; y++) {
          const i = blockIndex(x, y, z);
          if (blocks[i] !== BLOCK.AIR) continue;
          const below = blocks[i - 256];
          if (below === BLOCK.AIR || below === BLOCK.WATER || below === BLOCK.LAVA || below === BLOCK.BEDROCK) continue;
          if (hash3(seed + 223, ox + x, y, oz + z) >= 0.03) continue;
          blocks[i] = hash3(seed + 227, ox + x, y, oz + z) < 0.5 ? BROWN_MUSHROOM : RED_MUSHROOM;
        }
      }
    }
  }

  // ------------------------------------------------------------------ vegetation

  /** Surface block a tree or plant stands on, computed the same way for any column (used for columns outside the chunk). */
  private topAt(wx: number, wz: number, h: number, biome: number, slope: number, t: number): number {
    this.surface(biome, h, slope, wx, wz, t);
    return this.sTop;
  }

  private placeVegetation(blocks: Uint8Array, ox: number, oz: number): void {
    const heights = this.heights, biomes = this.biomes, temps = this.temps;
    const seed = this.seed;
    const trees = new TreeBuilder(seed, blocks);

    const gx0 = Math.floor((ox - TREE_REACH) / TREE_CELL);
    const gx1 = Math.floor((ox + CHUNK_SIZE + TREE_REACH - 1) / TREE_CELL);
    const gz0 = Math.floor((oz - TREE_REACH) / TREE_CELL);
    const gz1 = Math.floor((oz + CHUNK_SIZE + TREE_REACH - 1) / TREE_CELL);
    for (let gz = gz0; gz <= gz1; gz++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const tx = gx * TREE_CELL + Math.floor(hash2(seed + 11, gx, gz) * TREE_CELL);
        const tz = gz * TREE_CELL + Math.floor(hash2(seed + 13, gx, gz) * TREE_CELL);
        const bx = tx - ox, bz = tz - oz;
        const px = bx + PAD, pz = bz + PAD;
        let h: number, biome: number, t: number, slope: number, mn: number;
        if (px >= 1 && pz >= 1 && px < W - 1 && pz < W - 1) {
          const pi = pz * W + px;
          h = heights[pi]; biome = biomes[pi]; t = temps[pi];
          slope = this.slopeAt(pi);
          mn = Math.min(heights[pi + 1], heights[pi - 1], heights[pi + W], heights[pi - W]);
        } else {
          // Outside the padded height map: the trunk belongs to a neighbouring chunk, look it up directly.
          this.col(tx, tz);
          h = Math.floor(this.out.h); biome = this.out.biome; t = this.out.t;
          const h1 = Math.floor(this.heightAt(tx + 1, tz)), h2 = Math.floor(this.heightAt(tx - 1, tz));
          const h3 = Math.floor(this.heightAt(tx, tz + 1)), h4 = Math.floor(this.heightAt(tx, tz - 1));
          slope = Math.max(Math.abs(h1 - h), Math.abs(h2 - h), Math.abs(h3 - h), Math.abs(h4 - h));
          mn = Math.min(h1, h2, h3, h4);
        }
        if (h <= SEA_LEVEL || slope > 2) continue;
        const roll = hash2(seed + 17, gx, gz);
        if (roll > 0.9) continue; // densest biome tops out at 0.9
        const kind = hash2(seed + 19, gx, gz);
        const size = hash2(seed + 23, gx, gz);
        const ground = this.topAt(tx, tz, h, biome, slope, t);
        const soil = ground === BLOCK.GRASS || ground === BLOCK.SNOWY_GRASS || ground === BLOCK.DIRT || ground === PODZOL || ground === COARSE;
        const sandy = ground === BLOCK.SAND || ground === RED_SAND;
        // The trunk needs ground that is still there after caves and ravines.
        const stands = (): boolean => {
          if (bx >= 0 && bx < CHUNK_SIZE && bz >= 0 && bz < CHUNK_SIZE) {
            const b = blocks[blockIndex(bx, h, bz)];
            return b !== BLOCK.AIR && b !== BLOCK.WATER && b !== BLOCK.LAVA;
          }
          return !this.carver.carvedAt(tx, h, tz, h, mn);
        };
        const y = h + 1;
        switch (biome) {
          case BIOME.FOREST:
            if (roll < 0.75 && soil && stands()) {
              if (kind < 0.25) trees.blob(bx, y, bz, 5 + Math.floor(size * 3), BLOCK.BIRCH_LOG, BLOCK.BIRCH_LEAVES, tx, tz);
              else trees.blob(bx, y, bz, 4 + Math.floor(size * 3), BLOCK.OAK_LOG, BLOCK.OAK_LEAVES, tx, tz);
            }
            break;
          case BIOME.BIRCH_FOREST:
            if (roll < 0.7 && soil && stands()) trees.blob(bx, y, bz, 5 + Math.floor(size * 4), BLOCK.BIRCH_LOG, BLOCK.BIRCH_LEAVES, tx, tz);
            break;
          case BIOME.FLOWER_FOREST:
            if (roll < 0.22 && soil && stands()) {
              if (kind < 0.4) trees.blob(bx, y, bz, 5 + Math.floor(size * 3), BLOCK.BIRCH_LOG, BLOCK.BIRCH_LEAVES, tx, tz);
              else trees.blob(bx, y, bz, 4 + Math.floor(size * 3), BLOCK.OAK_LOG, BLOCK.OAK_LEAVES, tx, tz);
            }
            break;
          case BIOME.DARK_FOREST:
            if (roll < 0.88 && soil && stands()) {
              if (kind < 0.22) trees.blob(bx, y, bz, 4 + Math.floor(size * 2), C.dark_oak_log, C.dark_oak_leaves, tx, tz);
              else if (this.flatSquare(tx, tz, h)) trees.darkOak(bx, y, bz, 6 + Math.floor(size * 3), tx, tz);
            }
            break;
          case BIOME.PLAINS:
            if (roll < 0.04 && soil && stands()) trees.blob(bx, y, bz, 4 + Math.floor(size * 3), BLOCK.OAK_LOG, BLOCK.OAK_LEAVES, tx, tz);
            break;
          case BIOME.MEADOW:
            if (roll < 0.012 && soil && stands()) trees.blob(bx, y, bz, 4 + Math.floor(size * 2), BLOCK.OAK_LOG, BLOCK.OAK_LEAVES, tx, tz);
            break;
          case BIOME.CHERRY_GROVE:
            if (roll < 0.35 && soil && stands()) trees.cherry(bx, y, bz, 4 + Math.floor(size * 3), tx, tz);
            break;
          case BIOME.TAIGA:
            if (roll < 0.6 && soil && stands()) trees.spruce(bx, y, bz, 6 + Math.floor(size * 4));
            break;
          case BIOME.SNOWY_TAIGA:
            if (roll < 0.5 && soil && stands()) trees.spruce(bx, y, bz, 6 + Math.floor(size * 4));
            break;
          case BIOME.SNOWY:
            if (roll < 0.03 && soil && stands()) trees.spruce(bx, y, bz, 6 + Math.floor(size * 4));
            break;
          case BIOME.MOUNTAINS:
            if (roll < 0.1 && h < 96 && soil && stands()) trees.spruce(bx, y, bz, 6 + Math.floor(size * 3));
            break;
          case BIOME.WINDSWEPT_HILLS:
            if (roll < 0.09 && soil && stands()) {
              if (kind < 0.6) trees.spruce(bx, y, bz, 6 + Math.floor(size * 3));
              else trees.blob(bx, y, bz, 4 + Math.floor(size * 3), BLOCK.OAK_LOG, BLOCK.OAK_LEAVES, tx, tz);
            }
            break;
          case BIOME.SAVANNA:
            if (roll < 0.1 && soil && stands()) {
              if (kind < 0.85) trees.acacia(bx, y, bz, 5 + Math.floor(size * 3), tx, tz);
              else trees.blob(bx, y, bz, 4 + Math.floor(size * 2), BLOCK.OAK_LOG, BLOCK.OAK_LEAVES, tx, tz);
            }
            break;
          case BIOME.JUNGLE:
            if (roll < 0.85 && soil && stands()) {
              if (kind < 0.25) trees.blob(bx, y, bz, 3 + Math.floor(size * 2), C.jungle_log, C.jungle_leaves, tx, tz);
              else trees.jungle(bx, y, bz, 8 + Math.floor(size * 7), tx, tz);
            }
            break;
          case BIOME.SWAMP:
            if (roll < 0.3 && soil && stands()) trees.blob(bx, y, bz, 4 + Math.floor(size * 3), BLOCK.OAK_LOG, BLOCK.OAK_LEAVES, tx, tz);
            break;
          case BIOME.DESERT:
          case BIOME.BADLANDS:
            if (roll < (biome === BIOME.DESERT ? 0.08 : 0.03) && sandy && bx >= 0 && bx < 16 && bz >= 0 && bz < 16 && stands()) {
              const ch = 1 + Math.floor(size * 3);
              for (let dy = 0; dy < ch; dy++) {
                const i = blockIndex(bx, h + 1 + dy, bz);
                if (blocks[i] === BLOCK.AIR) blocks[i] = BLOCK.CACTUS;
              }
            }
            break;
        }
      }
    }

    this.placeGroundCover(blocks, ox, oz);
  }

  /** Is the 2×2 area (tx..tx+1, tz..tz+1) one level, so a dark oak trunk can stand on it? */
  private flatSquare(tx: number, tz: number, h: number): boolean {
    return Math.floor(this.heightAt(tx + 1, tz)) === h && Math.floor(this.heightAt(tx, tz + 1)) === h
      && Math.floor(this.heightAt(tx + 1, tz + 1)) === h;
  }

  private placeGroundCover(blocks: Uint8Array, ox: number, oz: number): void {
    const heights = this.heights, biomes = this.biomes;
    const seed = this.seed;
    for (let z = 0; z < CHUNK_SIZE; z++) {
      for (let x = 0; x < CHUNK_SIZE; x++) {
        const pi = (z + PAD) * W + (x + PAD);
        const h = heights[pi];
        if (h + 1 >= CHUNK_HEIGHT) continue;
        const below = blocks[blockIndex(x, h, z)];
        const ai = blockIndex(x, h + 1, z);
        if (blocks[ai] !== BLOCK.AIR) continue;
        const wx = ox + x, wz = oz + z;
        const r = hash2(seed + 29, wx, wz);
        const biome = biomes[pi];
        let plant = 0;
        const grassy = below === BLOCK.GRASS;
        if (grassy || below === PODZOL || below === COARSE) {
          const flower = (list: number[]) => list[Math.floor(hash2(seed + 37, wx, wz) * list.length)];
          switch (biome) {
            case BIOME.PLAINS:
              if (!grassy) break;
              plant = r < 0.2 ? BLOCK.TALL_GRASS : r < 0.215 ? BLOCK.DANDELION : r < 0.228 ? BLOCK.POPPY
                : r < 0.234 ? C.azure_bluet : r < 0.239 ? C.oxeye_daisy : r < 0.243 ? C.cornflower : r < 0.246 ? C.red_tulip : 0;
              break;
            case BIOME.FOREST:
              if (!grassy) break;
              plant = r < 0.1 ? BLOCK.TALL_GRASS : r < 0.108 ? BLOCK.POPPY : r < 0.114 ? BLOCK.DANDELION : r < 0.116 ? C.lily_of_the_valley : 0;
              break;
            case BIOME.BIRCH_FOREST:
              if (!grassy) break;
              plant = r < 0.09 ? BLOCK.TALL_GRASS : r < 0.094 ? C.lily_of_the_valley : r < 0.098 ? BLOCK.DANDELION : 0;
              break;
            case BIOME.FLOWER_FOREST:
              if (!grassy) break;
              plant = r < 0.1 ? BLOCK.TALL_GRASS : r < 0.34 ? flower(FLOWERS_ALL) : 0;
              break;
            case BIOME.MEADOW:
              if (!grassy) break;
              plant = r < 0.26 ? BLOCK.TALL_GRASS : r < 0.36 ? flower(FLOWERS_MEADOW) : 0;
              break;
            case BIOME.CHERRY_GROVE:
              if (!grassy) break;
              plant = r < 0.14 ? BLOCK.TALL_GRASS : r < 0.17 ? flower([C.allium, C.azure_bluet, C.cornflower]) : 0;
              break;
            case BIOME.SAVANNA:
              plant = grassy && r < 0.34 ? BLOCK.TALL_GRASS : 0;
              break;
            case BIOME.JUNGLE:
              plant = r < 0.14 ? FERN : r < 0.34 ? BLOCK.TALL_GRASS : r < 0.3365 ? MELON : 0;
              if (plant === MELON) plant = 0; // melons come in patches (below)
              break;
            case BIOME.SWAMP:
              plant = grassy ? (r < 0.12 ? BLOCK.TALL_GRASS : r < 0.135 ? C.blue_orchid : r < 0.14 ? BROWN_MUSHROOM : r < 0.144 ? RED_MUSHROOM : 0) : 0;
              break;
            case BIOME.DARK_FOREST:
              plant = r < 0.012 ? BROWN_MUSHROOM : r < 0.024 ? RED_MUSHROOM : r < 0.07 ? FERN : r < 0.11 && grassy ? BLOCK.TALL_GRASS : 0;
              break;
            case BIOME.TAIGA:
              plant = r < 0.1 ? FERN : r < 0.15 && grassy ? BLOCK.TALL_GRASS : r < 0.1525 ? BROWN_MUSHROOM : 0;
              break;
            case BIOME.SNOWY_TAIGA:
              plant = r < 0.03 ? FERN : 0;
              break;
            case BIOME.WINDSWEPT_HILLS: case BIOME.MOUNTAINS:
              plant = grassy && r < 0.05 ? BLOCK.TALL_GRASS : 0;
              break;
            case BIOME.SNOWY: case BIOME.BADLANDS:
              break;
            default:
              plant = grassy && r < 0.06 ? BLOCK.TALL_GRASS : 0;
          }
        } else if ((below === BLOCK.SAND || below === RED_SAND || below === TERRACOTTA || below === BLOCK.STAINED_TERRACOTTA)
          && (biome === BIOME.DESERT || biome === BIOME.BADLANDS)) {
          plant = r < (biome === BIOME.BADLANDS ? 0.012 : 0.008) ? BLOCK.DEAD_BUSH : 0;
        } else if (below === MUD && biome === BIOME.SWAMP) {
          plant = r < 0.01 ? BROWN_MUSHROOM : 0;
        }
        if (plant) blocks[ai] = plant;

        // Sugar cane next to water, on sand, dirt or grass at water level.
        if (!plant && h === SEA_LEVEL && (below === BLOCK.SAND || below === BLOCK.GRASS || below === BLOCK.DIRT || below === MUD || below === RED_SAND)
          && biome !== BIOME.SNOWY_BEACH && biome !== BIOME.FROZEN_RIVER && biome !== BIOME.SNOWY) {
          const hs = this.heights;
          if (hs[pi + 1] < SEA_LEVEL || hs[pi - 1] < SEA_LEVEL || hs[pi + W] < SEA_LEVEL || hs[pi - W] < SEA_LEVEL) {
            if (hash2(seed + 43, wx, wz) < 0.32) {
              const ch = 1 + Math.floor(hash2(seed + 47, wx, wz) * 3);
              for (let dy = 0; dy < ch && h + 1 + dy < CHUNK_HEIGHT; dy++) {
                const i = blockIndex(x, h + 1 + dy, z);
                if (blocks[i] === BLOCK.AIR) blocks[i] = SUGAR_CANE;
              }
            }
          }
        }
      }
    }

    // Pumpkin patches (plains, forests) and melon patches (jungle): a few blocks around a chunk-seeded centre.
    const prand = mulberry32((hash2(seed + 53, ox >> 4, oz >> 4) * 4294967296) >>> 0);
    const patchRoll = prand();
    const cxp = Math.floor(prand() * 16), czp = Math.floor(prand() * 16);
    const centreBiome = biomes[(czp + PAD) * W + cxp + PAD];
    const crop = (centreBiome === BIOME.PLAINS || centreBiome === BIOME.FOREST || centreBiome === BIOME.BIRCH_FOREST) && patchRoll < 0.06 ? PUMPKIN
      : centreBiome === BIOME.JUNGLE && patchRoll < 0.18 ? MELON
      : centreBiome === BIOME.MEADOW && patchRoll < 0.05 ? PUMPKIN : 0;
    if (crop) {
      const n = 3 + Math.floor(prand() * 5);
      for (let k = 0; k < n; k++) {
        const x = cxp + Math.round((prand() - 0.5) * 6), z = czp + Math.round((prand() - 0.5) * 6);
        if (x < 0 || x > 15 || z < 0 || z > 15) continue;
        const h = heights[(z + PAD) * W + x + PAD];
        if (blocks[blockIndex(x, h, z)] !== BLOCK.GRASS || blocks[blockIndex(x, h + 1, z)] !== BLOCK.AIR
          && blocks[blockIndex(x, h + 1, z)] !== BLOCK.TALL_GRASS) continue;
        blocks[blockIndex(x, h + 1, z)] = crop;
      }
    }
  }
}
