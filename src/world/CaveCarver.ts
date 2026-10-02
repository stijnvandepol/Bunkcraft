import { BLOCK } from './BlockRegistry';
import { CHUNK_HEIGHT, CHUNK_SIZE, SEA_LEVEL, blockIndex } from './constants';
import { SimplexNoise, hash2, lerp, smoothstep } from './Noise';

/**
 * Underground of generator version 2, in the spirit of Minecraft 1.18+ noise caves.
 *
 * Everything is a pure function of the world seed and the world position, so chunks agree on their
 * borders and the result never depends on generation order (no per-chunk random walks):
 *
 *  - 3D noise is sampled on a grid aligned to world coordinates (every 4 blocks, so the same corner
 *    values come out of every chunk that shares it) and trilinearly interpolated. A cell whose
 *    corners cannot reach a threshold is skipped without looking at its 64 voxels.
 *  - cheese:    big caverns where one low-frequency noise is high.
 *  - spaghetti: long winding tunnels, the intersection of the zero-surfaces of two noises.
 *  - noodle:    the same, thin and with a higher frequency.
 *  - entrances: extra wide spaghetti that only exists in the top ~28 blocks and in "zones" picked by a
 *               2D noise, so hillsides get cave mouths; cheese gets easier to breach inside the zones.
 *  - ravines:   canyons along the zero-contours of a 2D noise (gated so they only exist on some of them),
 *               cut from the surface down to a noise-driven floor; sometimes a water pool or lava at the bottom.
 *  - aquifers:  inside "aquifer zones" caves below a quantised water level hold water; air at y <= LAVA_LEVEL
 *               becomes lava (the lava lakes of deep caves).
 *
 * Carving never touches bedrock (y < 5) and never carves where it could open the sea: below an ocean
 * (or at the shore) the sea floor and a lid of a few blocks stay intact.
 */
const STEP = 4;
const NX = CHUNK_SIZE / STEP + 1;
/** First grid layer; grid layer k is at y = Y0 + 4k. */
const Y0 = 4;
const NYG = 32;
export const MIN_CARVE_Y = 5;
export const LAVA_LEVEL = 10;

const CHEESE_THR = 0.50;
const SPAG_W = 0.050, SPAG_WV = 0.040;
const NOODLE_W = 0.030;
const ENT_W = 0.060, ENT_WV = 0.100;
/** Upper bounds on the thresholds, used to skip cells. */
const SPAG_MAX = 0.10, NOODLE_MAX = 0.04, ENT_MAX = 0.17, CHEESE_MIN = 0.30;
const ENT_MIN_Y = 32;
const NOODLE_MIN_Y = 8, NOODLE_MAX_Y = 100;
const ENT_DEPTH = 28;
const AQ_EDGE = 0.14;
const BARRIER = 999;
/** Columns marked BARRIER are not carved up to this y. */
const BARRIER_Y = 48;
const OFF = 9; // sentinel: this family does not exist at this y

const M_CHEESE = 1, M_SPAG = 2, M_NOODLE = 4, M_ENT = 8;

class Fields {
  readonly spa1: Float32Array; readonly spa2: Float32Array;
  readonly noo1: Float32Array; readonly noo2: Float32Array;
  readonly ent1: Float32Array; readonly ent2: Float32Array;
  readonly che: Float32Array; readonly thk: Float32Array;
  constructor(n: number) {
    this.spa1 = new Float32Array(n); this.spa2 = new Float32Array(n);
    this.noo1 = new Float32Array(n); this.noo2 = new Float32Array(n);
    this.ent1 = new Float32Array(n); this.ent2 = new Float32Array(n);
    this.che = new Float32Array(n); this.thk = new Float32Array(n);
  }
}

/** The 2D fields at the corners of a column cell. */
class Fields2D {
  readonly zone: Float32Array; readonly aq: Float32Array; readonly lq: Float32Array;
  readonly rav: Float32Array; readonly gate: Float32Array; readonly floor: Float32Array;
  constructor(n: number) {
    this.zone = new Float32Array(n); this.aq = new Float32Array(n); this.lq = new Float32Array(n);
    this.rav = new Float32Array(n); this.gate = new Float32Array(n); this.floor = new Float32Array(n);
  }
}

function tri(f: Float32Array, i: number, sy: number, sz: number, tx: number, ty: number, tz: number): number {
  const c00 = lerp(f[i], f[i + 1], tx);
  const c01 = lerp(f[i + sz], f[i + sz + 1], tx);
  const c10 = lerp(f[i + sy], f[i + sy + 1], tx);
  const c11 = lerp(f[i + sy + sz], f[i + sy + sz + 1], tx);
  return lerp(lerp(c00, c01, tz), lerp(c10, c11, tz), ty);
}

function bil(f: Float32Array, i: number, tx: number, tz: number): number {
  return lerp(lerp(f[i], f[i + 1], tx), lerp(f[i + NX], f[i + NX + 1], tx), tz);
}

/** Highest y a column may be carved at: the sea floor and the shore stay closed (see class comment). */
export function carveLimit(h: number, minNeighbour: number): number {
  const m = Math.min(h, minNeighbour);
  return m < SEA_LEVEL ? m - 3 : Math.min(h, CHUNK_HEIGHT - 2);
}

export class CaveCarver {
  private readonly spa1: SimplexNoise; private readonly spa2: SimplexNoise;
  private readonly noo1: SimplexNoise; private readonly noo2: SimplexNoise;
  private readonly ent1: SimplexNoise; private readonly ent2: SimplexNoise;
  private readonly che: SimplexNoise; private readonly thk: SimplexNoise;
  private readonly zoneN: SimplexNoise; private readonly aqN: SimplexNoise; private readonly lqN: SimplexNoise;
  private readonly ravN: SimplexNoise; private readonly ravN2: SimplexNoise;
  private readonly gateN: SimplexNoise; private readonly floorN: SimplexNoise;

  private readonly grid = new Fields(NX * NX * NYG);
  private readonly grid2 = new Fields2D(NX * NX);
  /** Eight corners of one cell for point queries: index (dy * 2 + dz) * 2 + dx. */
  private readonly corner = new Fields(8);
  private readonly corner2 = new Fields2D(NX * NX);

  // Per-column scratch (x + z*16).
  private readonly lim = new Int16Array(CHUNK_SIZE * CHUNK_SIZE);
  private readonly zone = new Float32Array(CHUNK_SIZE * CHUNK_SIZE);
  private readonly aqLevel = new Int16Array(CHUNK_SIZE * CHUNK_SIZE);
  private readonly cellMask = new Uint8Array(CHUNK_SIZE / STEP * (CHUNK_SIZE / STEP) * NYG);

  // Ravine query result (scratch, avoids allocations).
  private rvFloor = 0; private rvHalf = 0; private rvDist = 0; private rvKind = 0;

  constructor(seed: number) {
    let s = (seed ^ 0x5bd1e995) >>> 0;
    const next = () => (s = (Math.imul(s ^ (s >>> 15), 2246822519) + 0x9e3779b9) >>> 0);
    this.spa1 = new SimplexNoise(next()); this.spa2 = new SimplexNoise(next());
    this.noo1 = new SimplexNoise(next()); this.noo2 = new SimplexNoise(next());
    this.ent1 = new SimplexNoise(next()); this.ent2 = new SimplexNoise(next());
    this.che = new SimplexNoise(next()); this.thk = new SimplexNoise(next());
    this.zoneN = new SimplexNoise(next()); this.aqN = new SimplexNoise(next()); this.lqN = new SimplexNoise(next());
    this.ravN = new SimplexNoise(next()); this.ravN2 = new SimplexNoise(next());
    this.gateN = new SimplexNoise(next()); this.floorN = new SimplexNoise(next());
    this.seed = seed;
  }
  private readonly seed: number;

  // ------------------------------------------------------------------ samplers

  private sampleInto(f: Fields, i: number, wx: number, wy: number, wz: number): void {
    f.spa1[i] = this.spa1.noise3(wx * 0.0135, wy * 0.021, wz * 0.0135);
    f.spa2[i] = this.spa2.noise3(wx * 0.0135, wy * 0.021, wz * 0.0135);
    f.che[i] = this.che.noise3(wx * 0.0100, wy * 0.0190, wz * 0.0100);
    f.thk[i] = this.thk.noise3(wx * 0.0060, wy * 0.0090, wz * 0.0060);
    if (wy >= NOODLE_MIN_Y && wy <= NOODLE_MAX_Y) {
      f.noo1[i] = this.noo1.noise3(wx * 0.030, wy * 0.040, wz * 0.030);
      f.noo2[i] = this.noo2.noise3(wx * 0.030, wy * 0.040, wz * 0.030);
    } else { f.noo1[i] = OFF; f.noo2[i] = OFF; }
    if (wy >= ENT_MIN_Y) {
      f.ent1[i] = this.ent1.noise3(wx * 0.0165, wy * 0.0150, wz * 0.0165);
      f.ent2[i] = this.ent2.noise3(wx * 0.0165, wy * 0.0150, wz * 0.0165);
    } else { f.ent1[i] = OFF; f.ent2[i] = OFF; }
  }

  private sample2D(f: Fields2D, i: number, wx: number, wz: number): void {
    f.zone[i] = this.zoneN.noise2(wx * 0.0065, wz * 0.0065);
    f.aq[i] = this.aqN.noise2(wx * 0.0070 + 50, wz * 0.0070);
    f.lq[i] = this.lqN.noise2(wx * 0.0025, wz * 0.0025 + 80);
    f.rav[i] = this.ravN.noise2(wx * 0.0045, wz * 0.0045) + 0.22 * this.ravN2.noise2(wx * 0.0160, wz * 0.0160);
    f.gate[i] = this.gateN.noise2(wx * 0.0030 + 100, wz * 0.0030);
    f.floor[i] = this.floorN.noise2(wx * 0.0060, wz * 0.0060 + 400);
  }

  // ------------------------------------------------------------------ cell logic (shared by chunk carving and point queries)

  private static range(f: Float32Array, i: number, sy: number, sz: number): void {
    let lo = f[i], hi = lo;
    for (let k = 0; k < 8; k++) {
      const v = f[i + (k & 1) + ((k >> 1) & 1) * sz + (k >> 2) * sy];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    CaveCarver.lo = lo; CaveCarver.hi = hi;
  }
  private static lo = 0;
  private static hi = 0;

  private cellMaskOf(f: Fields, i: number, sy: number, sz: number): number {
    let m = 0;
    CaveCarver.range(f.che, i, sy, sz);
    if (CaveCarver.hi > CHEESE_MIN) m |= M_CHEESE;
    if (this.pairHits(f.spa1, f.spa2, i, sy, sz, SPAG_MAX)) m |= M_SPAG;
    if (this.pairHits(f.noo1, f.noo2, i, sy, sz, NOODLE_MAX)) m |= M_NOODLE;
    if (this.pairHits(f.ent1, f.ent2, i, sy, sz, ENT_MAX)) m |= M_ENT;
    return m;
  }

  private pairHits(a: Float32Array, b: Float32Array, i: number, sy: number, sz: number, w: number): boolean {
    CaveCarver.range(a, i, sy, sz);
    if (CaveCarver.lo > w || CaveCarver.hi < -w) return false;
    CaveCarver.range(b, i, sy, sz);
    return !(CaveCarver.lo > w || CaveCarver.hi < -w);
  }

  /** Is this voxel carved by one of the 3D cave families? `d` is the depth below the surface. */
  private voxelCave(
    f: Fields, i: number, sy: number, sz: number, tx: number, ty: number, tz: number,
    mask: number, y: number, d: number, zone: number,
  ): boolean {
    if (mask & M_CHEESE) {
      const c = tri(f.che, i, sy, sz, tx, ty, tz);
      let thr = CHEESE_THR - zone * 0.12 - (y < 22 ? 0.05 : 0);
      if (d < 12) thr += (12 - d) * 0.035;
      if (c > thr) return true;
    }
    if (mask & M_SPAG) {
      const a = tri(f.spa1, i, sy, sz, tx, ty, tz);
      const b = tri(f.spa2, i, sy, sz, tx, ty, tz);
      const t = Math.min(1, Math.max(0, (tri(f.thk, i, sy, sz, tx, ty, tz) + 1) * 0.5));
      let w = SPAG_W + SPAG_WV * t;
      if (d < 14) w *= 0.6 + 0.4 * smoothstep(2, 14, d);
      if (a * a + b * b < w * w) return true;
    }
    if (mask & M_NOODLE && d > 3) {
      const a = tri(f.noo1, i, sy, sz, tx, ty, tz);
      const b = tri(f.noo2, i, sy, sz, tx, ty, tz);
      if (a * a + b * b < NOODLE_W * NOODLE_W) return true;
    }
    if (mask & M_ENT && zone > 0.02 && d < ENT_DEPTH) {
      const a = tri(f.ent1, i, sy, sz, tx, ty, tz);
      const b = tri(f.ent2, i, sy, sz, tx, ty, tz);
      const w = (ENT_W + ENT_WV * zone) * (1 - smoothstep(4, ENT_DEPTH, d)) + 0.02;
      if (a * a + b * b < w * w) return true;
    }
    return false;
  }

  /**
   * Ravine at a column (bilinear of the 2D fields at cell index i): fills rvFloor/rvHalf (half width at
   * the top)/rvDist (distance to the ravine's centre line in blocks)/rvKind (0 dry, 1 water pool, 2 lava).
   * Returns false when the column is nowhere near a ravine.
   */
  private ravineAt(f: Fields2D, i: number, tx: number, tz: number, h: number): boolean {
    const gate = smoothstep(0.18, 0.42, bil(f.gate, i, tx, tz));
    if (gate <= 0) return false;
    const r = bil(f.rav, i, tx, tz);
    // Gradient of the contour noise inside this cell, for the distance to the centre line in blocks.
    const gx = ((f.rav[i + 1] + f.rav[i + NX + 1]) - (f.rav[i] + f.rav[i + NX])) / (2 * STEP);
    const gz = ((f.rav[i + NX] + f.rav[i + NX + 1]) - (f.rav[i] + f.rav[i + 1])) / (2 * STEP);
    const gm = Math.max(0.0015, Math.hypot(gx, gz));
    const dist = Math.abs(r) / gm;
    const half = 1.6 + 3.6 * gate;
    if (dist > half * 1.25) return false;
    const fl = bil(f.floor, i, tx, tz);
    let floor = 7 + 27 * smoothstep(-0.5, 0.9, fl);
    let kind = 0;
    if (fl < -0.35) { floor = 7; kind = 2; }
    else if (fl > 0.12 && fl < 0.42) kind = 1;
    floor = Math.max(MIN_CARVE_Y, h - 56, Math.min(floor, h - 14));
    this.rvFloor = Math.floor(floor); this.rvHalf = half; this.rvDist = dist; this.rvKind = kind;
    return true;
  }

  private ravineCarves(y: number, h: number, jitter: number): boolean {
    if (y < this.rvFloor) return false;
    const span = Math.max(1, h - this.rvFloor);
    const t = Math.min(1, (y - this.rvFloor) / span);
    const hw = this.rvHalf * (0.3 + 0.7 * Math.pow(t, 0.6)) * (0.88 + 0.24 * jitter);
    return this.rvDist < hw;
  }

  /**
   * Water level of the aquifer at a column, -1 where there is none. Where the aquifer starts or its level
   * steps, the result is BARRIER: such columns stay solid below BARRIER_Y, so a lake is always held in by
   * rock instead of ending in a wall of water inside an open cave (like the barriers of Minecraft's aquifers).
   */
  private aquiferLevel(f: Fields2D, i: number, tx: number, tz: number): number {
    const a = bil(f.aq, i, tx, tz);
    if (Math.abs(a - AQ_EDGE) < 0.022) return BARRIER;
    if (a < AQ_EDGE) return -1;
    const q = (bil(f.lq, i, tx, tz) + 1) * 2.5;
    const frac = q - Math.floor(q);
    if (frac < 0.035 || frac > 0.965) return BARRIER;
    return 18 + 6 * Math.max(0, Math.min(4, Math.floor(q)));
  }

  // ------------------------------------------------------------------ chunk carving

  /**
   * Carves chunk (ox, oz are its world origin). `heights` is the padded surface height map used by the
   * terrain generator (W×W, PAD columns around the chunk).
   */
  carve(blocks: Uint8Array, ox: number, oz: number, heights: Int16Array, W: number, PAD: number): void {
    const lim = this.lim, zone = this.zone, aq = this.aqLevel;
    let maxLim = 0;
    for (let z = 0; z < CHUNK_SIZE; z++) {
      for (let x = 0; x < CHUNK_SIZE; x++) {
        const pi = (z + PAD) * W + x + PAD;
        const h = heights[pi];
        const mn = Math.min(heights[pi + 1], heights[pi - 1], heights[pi + W], heights[pi - W]);
        const l = carveLimit(h, mn);
        lim[z * CHUNK_SIZE + x] = l;
        if (l > maxLim) maxLim = l;
      }
    }
    if (maxLim < MIN_CARVE_Y) return;

    // 2D grid: entrance zones, aquifers, ravines.
    const g2 = this.grid2;
    for (let iz = 0; iz < NX; iz++) {
      for (let ix = 0; ix < NX; ix++) this.sample2D(g2, iz * NX + ix, ox + ix * STEP, oz + iz * STEP);
    }

    // Column values.
    for (let z = 0; z < CHUNK_SIZE; z++) {
      for (let x = 0; x < CHUNK_SIZE; x++) {
        const c = z * CHUNK_SIZE + x;
        const i2 = (z >> 2) * NX + (x >> 2);
        const tx = (x & 3) / STEP, tz = (z & 3) / STEP;
        zone[c] = smoothstep(-0.1, 0.45, bil(g2.zone, i2, tx, tz));
        aq[c] = this.aquiferLevel(g2, i2, tx, tz);
      }
    }

    // 3D grid, only as high as anything can be carved.
    const ny = Math.min(NYG, Math.ceil((maxLim - Y0) / STEP) + 2);
    const g = this.grid;
    for (let iy = 0; iy < ny; iy++) {
      const wy = Y0 + iy * STEP;
      for (let iz = 0; iz < NX; iz++) {
        for (let ix = 0; ix < NX; ix++) {
          this.sampleInto(g, (iy * NX + iz) * NX + ix, ox + ix * STEP, wy, oz + iz * STEP);
        }
      }
    }

    const sy = NX * NX, sz = NX;
    for (let z = 0; z < CHUNK_SIZE; z++) {
      for (let x = 0; x < CHUNK_SIZE; x++) {
        const c = z * CHUNK_SIZE + x;
        const l = lim[c];
        if (l < MIN_CARVE_Y) continue;
        const pi = (z + PAD) * W + x + PAD;
        const h = heights[pi];
        const i2 = (z >> 2) * NX + (x >> 2);

        // Ravine.
        if (this.ravineAt(g2, i2, (x & 3) / STEP, (z & 3) / STEP, h)) {
          const jitter = hash2(this.seed + 41, ox + x, oz + z);
          const top = Math.min(l, h + 1);
          const poolTop = this.rvKind === 1 ? this.rvFloor + 2 : -1;
          for (let y = Math.max(this.rvFloor, aq[c] === BARRIER ? BARRIER_Y + 1 : 0); y <= top; y++) {
            if (!this.ravineCarves(y, h, jitter)) continue;
            const bi = blockIndex(x, y, z);
            if (!isHost(blocks[bi])) continue;
            blocks[bi] = y <= LAVA_LEVEL ? BLOCK.LAVA : y <= poolTop || y <= aq[c] && aq[c] !== BARRIER ? BLOCK.WATER : BLOCK.AIR;
          }
        }
      }
    }

    // Caves, cell by cell.
    const mask = this.cellMask;
    let any = false;
    for (let iy = 0; iy < ny - 1; iy++) {
      for (let cz = 0; cz < 4; cz++) {
        for (let cx = 0; cx < 4; cx++) {
          const i = (iy * NX + cz) * NX + cx;
          const m = this.cellMaskOf(g, i, sy, sz);
          mask[(iy * 4 + cz) * 4 + cx] = m;
          if (m) any = true;
        }
      }
    }
    if (!any) return;
    for (let iy = 0; iy < ny - 1; iy++) {
      const yBase = Y0 + iy * STEP;
      if (yBase > maxLim) break;
      for (let cz = 0; cz < 4; cz++) {
        for (let cx = 0; cx < 4; cx++) {
          const m = mask[(iy * 4 + cz) * 4 + cx];
          if (!m) continue;
          const i = (iy * NX + cz) * NX + cx;
          for (let dz = 0; dz < STEP; dz++) {
            for (let dx = 0; dx < STEP; dx++) {
              const x = cx * STEP + dx, z = cz * STEP + dz;
              const c = z * CHUNK_SIZE + x;
              const l = lim[c];
              const h = heights[(z + PAD) * W + x + PAD];
              const tx = dx / STEP, tz = dz / STEP;
              for (let dy = 0; dy < STEP; dy++) {
                const y = yBase + dy;
                if (y < MIN_CARVE_Y) continue;
                if (y > l) break;
                if (y <= BARRIER_Y && aq[c] === BARRIER) continue;
                const bi = blockIndex(x, y, z);
                if (!isHost(blocks[bi])) continue;
                if (!this.voxelCave(g, i, sy, sz, tx, dy / STEP, tz, m, y, h - y, zone[c])) continue;
                blocks[bi] = y <= LAVA_LEVEL ? BLOCK.LAVA : y <= aq[c] && aq[c] !== BARRIER ? BLOCK.WATER : BLOCK.AIR;
              }
            }
          }
        }
      }
    }
  }

  // ------------------------------------------------------------------ point query

  /**
   * Would the voxel (wx, y, wz) be carved? Same result as `carve` for the chunk that owns it (the same
   * corner values go through the same arithmetic), but usable for columns outside the chunk being
   * generated: trees use it to know whether a neighbour's trunk has ground below it.
   */
  carvedAt(wx: number, y: number, wz: number, h: number, minNeighbour: number): boolean {
    const l = carveLimit(h, minNeighbour);
    if (y < MIN_CARVE_Y || y > l) return false;
    const gx = wx >> 2, gz = wz >> 2;
    const tx = (wx & 3) / STEP, tz = (wz & 3) / STEP;
    const c2 = this.corner2;
    for (let k = 0; k < 4; k++) this.sample2D(c2, (k >> 1) * NX + (k & 1), (gx + (k & 1)) * STEP, (gz + (k >> 1)) * STEP);
    if (y <= BARRIER_Y && this.aquiferLevel(c2, 0, tx, tz) === BARRIER) return false;
    if (this.ravineAt(c2, 0, tx, tz, h) && this.ravineCarves(y, h, hash2(this.seed + 41, wx, wz))) return true;
    const zone = smoothstep(-0.1, 0.45, bil(c2.zone, 0, tx, tz));
    const iyc = Math.floor((y - Y0) / STEP);
    const f = this.corner;
    for (let k = 0; k < 8; k++) {
      this.sampleInto(f, k, (gx + (k & 1)) * STEP, Y0 + (iyc + (k >> 2)) * STEP, (gz + ((k >> 1) & 1)) * STEP);
    }
    const m = this.cellMaskOf(f, 0, 4, 2);
    if (!m) return false;
    return this.voxelCave(f, 0, 4, 2, tx, (y - Y0 - iyc * STEP) / STEP, tz, m, y, h - y, zone);
  }
}

function isHost(b: number): boolean {
  return b !== BLOCK.AIR && b !== BLOCK.WATER && b !== BLOCK.LAVA && b !== BLOCK.BEDROCK;
}
