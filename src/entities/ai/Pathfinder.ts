import type { BlockGetter } from '../../player/Collision';
import { BLOCK, SOLID } from '../../world/BlockRegistry';

/**
 * A* on the voxel grid for walking mobs. A node is the cell of the mob's feet; a move is one block sideways (also
 * diagonally when both neighbours are free), one block up (a jump) or up to three blocks down. Lava and cactus are
 * never entered, water costs extra (or is forbidden). The search is capped by a node budget and returns the best
 * partial path when the target is out of reach, so far-away targets are approached in hops of a few seconds.
 *
 * All scratch memory is module-level and reused: a search allocates nothing.
 */

export interface PathOptions {
  /** Cap on expanded nodes (the cost knob: roughly 2 µs per node). */
  maxNodes: number;
  /** Mob height in whole blocks (1, 2 or 3). */
  height: number;
  /** Water cells are forbidden (random strolls of land mobs). */
  avoidWater: boolean;
  /** Swimmers (drowned) may move freely through water, also up and down. */
  swim: boolean;
  /** The search ends when it is within this many cells (horizontally) of the target. */
  reach: number;
  /** Cells further than this from the start (horizontally) are not searched. */
  range: number;
}

export const DEFAULT_PATH: Readonly<PathOptions> = { maxNodes: 160, height: 2, avoidWater: false, swim: false, reach: 0, range: 32 };

/** Cells of a found path, excluding the start cell. */
export class Path {
  /** x, y, z triples of cells. */
  readonly cells = new Int32Array(3 * PATH_MAX);
  length = 0;
  index = 0;
  /** The last cell is the target (not just the closest the search got). */
  complete = false;
}

export const PATH_MAX = 48;
const NODE_CAP = 1024;
const HASH_SIZE = 4096;
const HEAP_CAP = 8192;

const nx = new Int32Array(NODE_CAP), ny = new Int32Array(NODE_CAP), nz = new Int32Array(NODE_CAP);
const nG = new Float32Array(NODE_CAP), nF = new Float32Array(NODE_CAP), nH = new Float32Array(NODE_CAP);
const nParent = new Int32Array(NODE_CAP);
const nClosed = new Uint8Array(NODE_CAP);
/** Cactus penalty of the node's cell, −1 = not looked up yet (a cell is reached from several neighbours). */
const nCactus = new Int8Array(NODE_CAP);
/** Whether the body fits in the four side neighbours of the node being expanded, −1 = not looked up yet. */
const sideFits = new Int8Array(4);
const hashTable = new Int32Array(HASH_SIZE);
const hashStamp = new Uint32Array(HASH_SIZE);
let stamp = 1;
const heapNode = new Int32Array(HEAP_CAP), heapF = new Float32Array(HEAP_CAP);
let heapSize = 0;
let nodeCount = 0;

/** Statistics for the F3 overlay and the benchmarks; `lastNodes` = nodes the latest search expanded, `deferred` = searches
 * the per-tick budget postponed (Navigator). */
export const pathStats = { searches: 0, nodes: 0, lastNodes: 0, deferred: 0 };

function heapPush(node: number, f: number): void {
  if (heapSize >= HEAP_CAP) return;
  let i = heapSize++;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (heapF[p] <= f) break;
    heapF[i] = heapF[p]; heapNode[i] = heapNode[p];
    i = p;
  }
  heapF[i] = f; heapNode[i] = node;
}

function heapPop(): number {
  const top = heapNode[0];
  heapSize--;
  if (heapSize > 0) {
    const f = heapF[heapSize], node = heapNode[heapSize];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= heapSize) break;
      if (c + 1 < heapSize && heapF[c + 1] < heapF[c]) c++;
      if (heapF[c] >= f) break;
      heapF[i] = heapF[c]; heapNode[i] = heapNode[c];
      i = c;
    }
    heapF[i] = f; heapNode[i] = node;
  }
  return top;
}

/** Index of the node at a cell, creating it when new (−1 when the node table is full). */
function nodeAt(x: number, y: number, z: number): number {
  let h = ((x * 73856093) ^ (y * 19349663) ^ (z * 83492791)) & (HASH_SIZE - 1);
  for (;;) {
    if (hashStamp[h] !== stamp) {
      if (nodeCount >= NODE_CAP) return -1;
      const n = nodeCount++;
      hashStamp[h] = stamp;
      hashTable[h] = n;
      nx[n] = x; ny[n] = y; nz[n] = z;
      nG[n] = Infinity; nClosed[n] = 0; nParent[n] = -1; nCactus[n] = -1;
      return n;
    }
    const n = hashTable[h];
    if (nx[n] === x && ny[n] === y && nz[n] === z) return n;
    h = (h + 1) & (HASH_SIZE - 1);
  }
}

const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DZ = [0, 0, 1, -1, 1, -1, 1, -1];
/** For the diagonal moves 4-7: the side moves along x and along z whose cells must both be free. */
const DIAG_X = [0, 0, 0, 0, 0, 0, 1, 1];
const DIAG_Z = [0, 0, 0, 0, 2, 3, 2, 3];

// Cell classes.
const OPEN = 0, BLOCKED = 1, WATER = 2;

/** How a grid cell can be entered, shared by the A* and the line test. */
export class Grid {
  getBlock: BlockGetter = () => 0;
  avoidWater = false;
  height = 2;

  cell(x: number, y: number, z: number): number {
    if (y < 0) return BLOCKED;
    const b = this.getBlock(x, y, z);
    if (b === 0) return OPEN;
    if (b === BLOCK.WATER) return this.avoidWater ? BLOCKED : WATER;
    if (b === BLOCK.LAVA || b === BLOCK.CACTUS || b === BLOCK.UNLOADED) return BLOCKED;
    return SOLID[b] ? BLOCKED : OPEN;
  }

  /** The body fits at (x, y, z) with its feet in the cell. */
  fits(x: number, y: number, z: number): boolean {
    for (let k = 0; k < this.height; k++) if (this.cell(x, y + k, z) === BLOCKED) return false;
    return true;
  }

  /** A solid, safe block under the feet. */
  supported(x: number, y: number, z: number): boolean {
    const b = this.getBlock(x, y - 1, z);
    return b !== BLOCK.UNLOADED && b !== BLOCK.CACTUS && SOLID[b] !== 0 && b !== BLOCK.LAVA;
  }

  /** Whether the body can stand or float in this cell. */
  canStand(x: number, y: number, z: number): boolean {
    if (!this.fits(x, y, z)) return false;
    return this.supported(x, y, z) || this.cell(x, y, z) === WATER;
  }

  /** Highest standable y at or below `y` within `depth` blocks (−1 if none, also over unloaded columns). */
  groundY(x: number, y: number, z: number, depth: number): number {
    for (let k = 0; k <= depth; k++) {
      const yy = y - k;
      if (yy < 1) return -1;
      if (this.canStand(x, yy, z)) return yy;
    }
    return -1;
  }
}

const grid = new Grid();

/** Straight walk over level ground: every cell on the line is standable at the start height. */
export function lineWalkable(getBlock: BlockGetter, sx: number, sy: number, sz: number, tx: number, tz: number, height: number, avoidWater: boolean): boolean {
  grid.getBlock = getBlock; grid.height = height; grid.avoidWater = avoidWater;
  const dx = tx - sx, dz = tz - sz;
  const n = Math.max(Math.abs(dx), Math.abs(dz));
  let lastX = sx, lastZ = sz;
  for (let i = 1; i <= n; i++) {
    const x = sx + Math.round((dx * i) / n), z = sz + Math.round((dz * i) / n);
    if (!grid.canStand(x, sy, z)) return false;
    // A diagonal hop needs both orthogonal cells free (no corner cutting through a wall).
    if (x !== lastX && z !== lastZ && !(grid.fits(x, sy, lastZ) && grid.fits(lastX, sy, z))) return false;
    lastX = x; lastZ = z;
  }
  return true;
}

/**
 * Finds a path from the feet cell (sx, sy, sz) towards the target cell. Returns false when not even a first step
 * could be found. Fills `out` with the cells to walk (the closest the search got when the target is out of reach).
 */
export function findPath(getBlock: BlockGetter, sx: number, sy: number, sz: number, tx: number, ty: number, tz: number,
  opts: PathOptions, out: Path): boolean {
  const g = grid;
  g.getBlock = getBlock; g.height = opts.height; g.avoidWater = opts.avoidWater;
  out.length = 0; out.index = 0; out.complete = false;
  stamp++;
  if (stamp > 0xfffffff0) { hashStamp.fill(0); stamp = 1; }
  nodeCount = 0; heapSize = 0;
  const max = Math.min(opts.maxNodes, NODE_CAP - 64);
  const reach2 = opts.reach * opts.reach;
  const range = opts.range;
  const height = opts.height;
  pathStats.searches++;

  const h = (x: number, y: number, z: number): number => {
    const dx = Math.abs(x - tx), dz = Math.abs(z - tz);
    return Math.max(dx, dz) + 0.414 * Math.min(dx, dz) + Math.abs(y - ty) * 0.6;
  };

  const start = nodeAt(sx, sy, sz);
  nG[start] = 0; nH[start] = h(sx, sy, sz); nF[start] = nH[start];
  heapPush(start, nF[start]);
  let best = start;
  let expanded = 0;
  let found = false;

  const relax = (from: number, x: number, y: number, z: number, cost: number, cactus = false): void => {
    const n = nodeAt(x, y, z);
    if (n < 0 || nClosed[n]) return;
    if (cactus) {
      let c = nCactus[n];
      if (c < 0) c = nCactus[n] = cactusPenalty(getBlock, x, y, z);
      cost += c;
    }
    const ng = nG[from] + cost;
    if (ng >= nG[n]) return;
    if (nG[n] === Infinity) nH[n] = h(x, y, z);
    nG[n] = ng; nF[n] = ng + nH[n]; nParent[n] = from;
    heapPush(n, nF[n]);
  };

  while (heapSize > 0 && expanded < max) {
    const n = heapPop();
    if (nClosed[n]) continue;
    nClosed[n] = 1;
    expanded++;
    const x = nx[n], y = ny[n], z = nz[n];
    if (nH[n] < nH[best]) best = n;
    const ddx = x - tx, ddz = z - tz;
    if (ddx * ddx + ddz * ddz <= reach2 && Math.abs(y - ty) <= 1) { best = n; found = true; break; }
    const inWater = g.cell(x, y, z) === WATER;
    // The side cells are needed twice (their own move and the corner check of two diagonals): look them up once.
    sideFits[0] = sideFits[1] = sideFits[2] = sideFits[3] = -1;

    for (let d = 0; d < 8; d++) {
      const px = x + DX[d], pz = z + DZ[d];
      if (Math.abs(px - sx) > range || Math.abs(pz - sz) > range) continue;
      const diag = d >= 4;
      const step = diag ? 1.414 : 1;
      if (diag && !(sideFree(DIAG_X[d], x, y, z) && sideFree(DIAG_Z[d], x, y, z))) continue;
      const fits = diag ? g.fits(px, y, pz) : sideFree(d, x, y, z);
      // canStand, with the fit already known.
      if (fits && (g.supported(px, y, pz) || g.cell(px, y, pz) === WATER)) {
        relax(n, px, y, pz, step + (g.cell(px, y, pz) === WATER ? 2.5 : 0), true);
        continue;
      }
      if (diag) continue;
      if (fits) {
        // A hole: fall up to three blocks (a landing in water is safe, lava and cactus are not).
        for (let k = 1; k <= 3; k++) {
          const c = g.cell(px, y - k, pz);
          if (c === BLOCKED) {
            // Solid ground at y - k - 1 holds a body standing in y - k (handled by canStand below).
            break;
          }
          if (g.canStand(px, y - k, pz)) { relax(n, px, y - k, pz, 1 + k * 0.7); break; }
        }
        if (opts.swim && inWater) relax(n, px, y, pz, step);
      } else if (g.fits(px, y + 1, pz) && g.supported(px, y + 1, pz) && g.cell(x, y + height, z) !== BLOCKED) {
        // One block up: the jump needs room above the current cell too.
        relax(n, px, y + 1, pz, 1.6);
      }
    }
    if (opts.swim && inWater) {
      if (g.fits(x, y + 1, z) && g.cell(x, y + 1, z) === WATER) relax(n, x, y + 1, z, 1);
      if (g.cell(x, y - 1, z) === WATER && g.fits(x, y - 1, z)) relax(n, x, y - 1, z, 1);
    }
  }
  pathStats.nodes += expanded;
  pathStats.lastNodes = expanded;

  if (best === start) return false;
  // Walk back from the best node, then keep the first PATH_MAX cells from the start.
  let len = 0;
  for (let n = best; n !== start && n >= 0; n = nParent[n]) len++;
  const skip = Math.max(0, len - PATH_MAX);
  let i = len - 1;
  for (let n = best; n !== start && n >= 0; n = nParent[n], i--) {
    if (i >= PATH_MAX) continue;
    out.cells[i * 3] = nx[n]; out.cells[i * 3 + 1] = ny[n]; out.cells[i * 3 + 2] = nz[n];
  }
  out.length = len - skip;
  out.complete = found && skip === 0;
  return out.length > 0;
}

/** Whether the body fits in side neighbour `d` (0-3) of (x, y, z), memoised per expanded node in `sideFits`. */
function sideFree(d: number, x: number, y: number, z: number): boolean {
  let f = sideFits[d];
  if (f < 0) f = sideFits[d] = grid.fits(x + DX[d], y, z + DZ[d]) ? 1 : 0;
  return f === 1;
}

/** Cells next to a cactus are avoided (contact damage). */
function cactusPenalty(getBlock: BlockGetter, x: number, y: number, z: number): number {
  return getBlock(x + 1, y, z) === BLOCK.CACTUS || getBlock(x - 1, y, z) === BLOCK.CACTUS
    || getBlock(x, y, z + 1) === BLOCK.CACTUS || getBlock(x, y, z - 1) === BLOCK.CACTUS ? 6 : 0;
}

export { grid as pathGrid };
