/**
 * Statistics of the terrain generator over a grid of chunks and several seeds:
 * air below sea level, surface openings (air columns connecting the surface to a cave below),
 * cave volume per chunk, lava/water pockets underground, ore counts per height band, the area of every biome,
 * rock types and surface sanity checks (floating blocks, water next to air under the sea level).
 *
 *   npx tsx scripts/gen-stats.ts [--gen=1|2|3] [--grid=40] [--seeds=1,2,3,4] [--find]
 *
 * --find prints good screenshot spots (cave entrances, large openings/ravines).
 */
import { BLOCK, CUBE_ID } from '../src/world/BlockRegistry';
import { BIOME_NAMES } from '../src/world/Biomes';
import { TerrainGenerator } from '../src/world/TerrainGenerator';
import { CHUNK_AREA, CHUNK_HEIGHT, CHUNK_SIZE, CHUNK_VOLUME, SEA_LEVEL, blockIndex } from '../src/world/constants';

const arg = (name: string, def: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? def;
const GEN = Number(arg('gen', '3'));
const GRID = Number(arg('grid', '40'));
const SEEDS = arg('seeds', '12345,777,424242,99').split(',').map(Number);
const FIND = process.argv.includes('--find');

const ORES: [string, number][] = [
  ['coal', BLOCK.COAL_ORE], ['iron', BLOCK.IRON_ORE], ['gold', BLOCK.GOLD_ORE], ['diamond', BLOCK.DIAMOND_ORE],
  ['copper', CUBE_ID.copper_ore], ['lapis', CUBE_ID.lapis_ore], ['redstone', CUBE_ID.redstone_ore], ['emerald', CUBE_ID.emerald_ore],
  ['deepslate', CUBE_ID.deepslate], ['tuff', CUBE_ID.tuff], ['granite', CUBE_ID.granite], ['diorite', CUBE_ID.diorite], ['andesite', CUBE_ID.andesite],
];
const BANDS: [number, number][] = [[1, 8], [8, 16], [16, 32], [32, 48], [48, 64], [64, 80], [80, 128]];

interface Totals {
  chunks: number; landChunks: number; ms: number;
  belowSeaVoxels: number; belowSeaAir: number; landBelowVoxels: number; landBelowAir: number;
  caveAir: number; openings: number; lava: number; undergroundWater: number; surfaceLava: number;
  ores: number[][]; // [ore][band]
  airByBand: number[]; // air voxels per 8-layer band below the surface
  spots: { kind: string; x: number; y: number; z: number }[];
  biomes: number[];
  /** Solid blocks with air directly below and above (floating single blocks) outside caves. */
  floating: number;
  /** Water cells at or below sea level with air beside or below them (a hole in the sea). */
  waterHoles: number;
}

function newTotals(): Totals {
  return {
    chunks: 0, landChunks: 0, ms: 0, belowSeaVoxels: 0, belowSeaAir: 0, landBelowVoxels: 0, landBelowAir: 0,
    caveAir: 0, openings: 0, lava: 0, undergroundWater: 0, surfaceLava: 0,
    ores: ORES.map(() => BANDS.map(() => 0)), airByBand: new Array(16).fill(0), spots: [],
    biomes: new Array(BIOME_NAMES.length).fill(0), floating: 0, waterHoles: 0,
  };
}

const solidish = (b: number) => b !== BLOCK.AIR && b !== BLOCK.WATER && b !== BLOCK.LAVA;
const seen = new Uint8Array(CHUNK_AREA);
const stack: number[] = [];
const NEIGHBOURS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

const biomeOut = new Uint8Array(CHUNK_AREA);
const isAirish = (b: number) => b === BLOCK.AIR;
const SOLID_SURFACE = new Set<number>([BLOCK.STONE, BLOCK.DIRT, BLOCK.GRASS, BLOCK.SAND, BLOCK.GRAVEL, BLOCK.SNOWY_GRASS, BLOCK.CLAY]);

function analyze(gen: TerrainGenerator, cx: number, cz: number, t: Totals, blocks: Uint8Array): void {
  const t0 = performance.now();
  gen.generate(cx, cz, blocks, biomeOut);
  t.ms += performance.now() - t0;
  t.chunks++;
  for (let i = 0; i < CHUNK_AREA; i++) t.biomes[biomeOut[i]]++;
  // Floating terrain blocks and holes in the water (inside the chunk only).
  for (let y = 2; y < CHUNK_HEIGHT - 1; y++) {
    for (let z = 1; z < 15; z++) {
      for (let x = 1; x < 15; x++) {
        const i = blockIndex(x, y, z);
        const b = blocks[i];
        if (SOLID_SURFACE.has(b) && isAirish(blocks[i - 256]) && isAirish(blocks[i + 256])
          && isAirish(blocks[i + 1]) && isAirish(blocks[i - 1]) && isAirish(blocks[i + 16]) && isAirish(blocks[i - 16])) t.floating++;
        if (b === BLOCK.WATER && y <= SEA_LEVEL && (isAirish(blocks[i - 256]) || isAirish(blocks[i + 1]) || isAirish(blocks[i - 1])
          || isAirish(blocks[i + 16]) || isAirish(blocks[i - 16]))) t.waterHoles++;
      }
    }
  }
  const ox = cx * CHUNK_SIZE, oz = cz * CHUNK_SIZE;
  let land = 0;
  const open = new Uint8Array(CHUNK_AREA);
  const runLen = new Uint8Array(CHUNK_AREA);
  for (let z = 0; z < CHUNK_SIZE; z++) {
    for (let x = 0; x < CHUNK_SIZE; x++) {
      const h = Math.floor(gen.heightAt(ox + x, oz + z));
      const isLand = h >= SEA_LEVEL;
      if (isLand) land++;
      for (let y = 1; y < SEA_LEVEL; y++) {
        const b = blocks[blockIndex(x, y, z)];
        t.belowSeaVoxels++;
        if (b === BLOCK.AIR) t.belowSeaAir++;
        if (isLand) { t.landBelowVoxels++; if (b === BLOCK.AIR) t.landBelowAir++; }
      }
      for (let y = 1; y < h - 1 && y < CHUNK_HEIGHT; y++) {
        const b = blocks[blockIndex(x, y, z)];
        if (b === BLOCK.AIR) { t.caveAir++; t.airByBand[y >> 3]++; }
        else if (b === BLOCK.LAVA) t.lava++;
        else if (b === BLOCK.WATER) t.undergroundWater++;
        const oi = ORES.findIndex((o) => o[1] === b);
        if (oi >= 0) {
          const band = BANDS.findIndex(([lo, hi]) => y >= lo && y < hi);
          if (band >= 0) t.ores[oi][band]++;
        }
      }
      if (isLand && h < CHUNK_HEIGHT - 2) {
        // Surface opening: the original surface block is gone and air continues down for >= 3 blocks.
        if (!solidish(blocks[blockIndex(x, h, z)])) {
          let run = 0;
          while (run < 40 && h - run > 0 && blocks[blockIndex(x, h - run, z)] === BLOCK.AIR) run++;
          if (run >= 3) { open[z * CHUNK_SIZE + x] = 1; runLen[z * CHUNK_SIZE + x] = run; }
        }
        for (let y = h + 1; y < h + 4 && y < CHUNK_HEIGHT; y++) {
          if (blocks[blockIndex(x, y, z)] === BLOCK.LAVA) t.surfaceLava++;
        }
      }
    }
  }
  if (land > CHUNK_AREA / 2) t.landChunks++;
  // 2D connected components of opening columns.
  seen.fill(0);
  for (let i = 0; i < CHUNK_AREA; i++) {
    if (!open[i] || seen[i]) continue;
    t.openings++;
    let size = 0, sx = 0, sz = 0;
    stack.length = 0; stack.push(i); seen[i] = 1;
    while (stack.length) {
      const c = stack.pop()!;
      size++;
      sx += c & 15; sz += c >> 4;
      const x = c & 15, z = c >> 4;
      for (const [dx, dz] of NEIGHBOURS) {
        const nx = x + dx, nz = z + dz;
        if (nx < 0 || nz < 0 || nx > 15 || nz > 15) continue;
        const ni = nz * 16 + nx;
        if (open[ni] && !seen[ni]) { seen[ni] = 1; stack.push(ni); }
      }
    }
    if (FIND) {
      const mx = Math.round(sx / size), mz = Math.round(sz / size);
      const h = Math.floor(gen.heightAt(ox + mx, oz + mz));
      t.spots.push({ kind: size >= 40 ? 'large opening' : 'entrance', x: ox + mx, y: h, z: oz + mz });
    }
  }
}

console.log(`gen v${GEN}, ${GRID}x${GRID} chunks, seeds ${SEEDS.join(',')}`);
const all = newTotals();
const blocks = new Uint8Array(CHUNK_VOLUME);
const scalar: (keyof Totals)[] = [
  'chunks', 'landChunks', 'ms', 'belowSeaVoxels', 'belowSeaAir', 'landBelowVoxels', 'landBelowAir',
  'caveAir', 'openings', 'lava', 'undergroundWater', 'surfaceLava',
];
for (const seed of SEEDS) {
  const gen = new (TerrainGenerator as any)(seed, GEN) as TerrainGenerator;
  const t = newTotals();
  for (let cz = -GRID / 2; cz < GRID / 2; cz++) for (let cx = -GRID / 2; cx < GRID / 2; cx++) analyze(gen, cx + 7, cz - 5, t, blocks);
  const f = (n: number, d: number) => (n / d).toFixed(1);
  console.log(`seed ${seed}: air<sea ${(100 * t.belowSeaAir / t.belowSeaVoxels).toFixed(2)}% (land cols ${(100 * t.landBelowAir / t.landBelowVoxels).toFixed(2)}%), `
    + `openings/100 land chunks ${(100 * t.openings / Math.max(1, t.landChunks)).toFixed(0)}, cave air/chunk ${f(t.caveAir, t.chunks)}, `
    + `lava ${f(t.lava, t.chunks)}, water ${f(t.undergroundWater, t.chunks)}, surface lava ${t.surfaceLava}, gen ${f(t.ms, t.chunks)} ms/chunk`);
  if (FIND) {
    const byKind = new Map<string, typeof t.spots>();
    for (const s of t.spots) { if (!byKind.has(s.kind)) byKind.set(s.kind, []); byKind.get(s.kind)!.push(s); }
    for (const [k, v] of byKind) console.log(`  ${k}: ${v.slice(0, 4).map((s) => `${s.x},${s.y},${s.z}`).join('  ')}`);
  }
  for (const k of scalar) (all[k] as number) += t[k] as number;
  t.biomes.forEach((v, b) => { all.biomes[b] += v; });
  all.floating += t.floating; all.waterHoles += t.waterHoles;
  t.ores.forEach((row, i) => row.forEach((v, b) => { all.ores[i][b] += v; }));
  t.airByBand.forEach((v, b) => { all.airByBand[b] += v; });
}
const c = all.chunks;
console.log('--- total over seeds');
console.log(`air below sea level: ${(100 * all.belowSeaAir / all.belowSeaVoxels).toFixed(2)}%  (land columns only: ${(100 * all.landBelowAir / all.landBelowVoxels).toFixed(2)}%)`);
console.log(`surface openings per 100 land chunks: ${(100 * all.openings / all.landChunks).toFixed(0)}  (land chunks ${all.landChunks}/${c})`);
console.log(`cave air per chunk: ${(all.caveAir / c).toFixed(0)}, underground lava ${(all.lava / c).toFixed(1)}, underground water ${(all.undergroundWater / c).toFixed(1)}, surface lava cells ${all.surfaceLava}`);
console.log('cave air per chunk by 8-layer band (y 0..127): ' + all.airByBand.map((v) => (v / c).toFixed(0)).join(' '));
console.log(`generate: ${(all.ms / c).toFixed(2)} ms/chunk`);
console.log('ore blocks per chunk by height band ' + BANDS.map(([a, b]) => `${a}-${b - 1}`).join(' | '));
ORES.forEach(([name], i) => console.log(`  ${name.padEnd(9)} ${all.ores[i].map((v) => (v / c).toFixed(1).padStart(6)).join(' |')}  total ${(all.ores[i].reduce((s, v) => s + v, 0) / c).toFixed(1)}`));
console.log(`floating single blocks per chunk: ${(all.floating / c).toFixed(3)}, water cells next to air below sea level per chunk: ${(all.waterHoles / c).toFixed(2)}`);
const area = all.biomes.reduce((s, v) => s + v, 0);
console.log('biome area (% of columns):');
BIOME_NAMES.map((name, b) => [name, all.biomes[b]] as const).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])
  .forEach(([name, v]) => console.log(`  ${name.padEnd(16)} ${(100 * v / area).toFixed(2).padStart(6)} %`));
