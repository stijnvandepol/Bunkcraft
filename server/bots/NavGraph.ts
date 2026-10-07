import type { BlockGetter } from '../../src/player/Collision';
import { PHYSICS } from '../../src/player/Physics';
import { BLOCK, SOLID } from '../../src/world/BlockRegistry';
import { MovementValidator } from '../anticheat/Movement';
import { blocksBullet } from '../Combat';

/**
 * Navigation graph of an arena for the server-side bots (DOM-free, built once per map variant and shared by
 * every lobby that plays it).
 *
 * A node is a standing spot: the centre of a block column at a feet height in half blocks (floors, slabs,
 * roofs, decks). The standing test and every edge test use the movement validator's own collision check
 * (`MovementValidator.inSolid`, the real block shapes), so a route the graph allows is a route the anti-cheat
 * accepts. Edges follow the arcade movement rules of `Player.step`:
 *  - walk to one of the 8 neighbours at the same height (diagonals only when both sides are free), or up a
 *    step of at most half a block (slab, stair: the 0.6 step height);
 *  - jump up one full block (the jump apex is 1.32);
 *  - drop down at most MAX_DROP blocks;
 *  - climb a ladder in the own column.
 * Each edge is checked the way the validator checks a report: vertical then sideways when rising, sideways
 * then vertical when falling, sampled at 1/8 block.
 *
 * Storage is flat typed arrays (CSR adjacency, forward and reverse) so path searches and distance fields do
 * not allocate. Nothing here knows about a particular map: any block getter with bounds works, so new maps
 * get a graph without changes.
 */

export interface NavWorld {
  getBlock: BlockGetter;
  getMeta?: BlockGetter;
  /** Columns x in [minX, maxX), z in [minZ, maxZ). */
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  /** Walkable part (the wall ring is out). */
  inBounds(x: number, z: number): boolean;
  /** Y of the floor surface block; feet stand at floorY + 0.5 (a slab floor) and above. */
  floorY: number;
  /** Highest feet height searched, in blocks above the floor (default 14). */
  maxHeight?: number;
}

/** Standing heights are multiples of this (slabs and stair steps are half blocks). */
export const NAV_STEP = 0.5;
/** Highest drop an edge takes (blocks). */
export const MAX_DROP = 4;
/** Highest climb without a jump (Player's step height is 0.6). */
const STEP_UP = 0.5;
/** Highest climb with a jump (apex 1.32). */
const JUMP_UP = 1;

export const EDGE_JUMP = 1;
export const EDGE_DROP = 2;
export const EDGE_LADDER = 4;
export const EDGE_DIAGONAL = 8;

/** Direction vectors: 4 straight, then 4 diagonal. */
export const DIRS: readonly (readonly [number, number])[] = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

export class NavGraph {
  readonly minX: number;
  readonly minZ: number;
  /** Columns along x and z. */
  readonly w: number;
  readonly d: number;
  readonly floorY: number;
  readonly levels: number;
  /** Per node: column index ((x − minX) · d + (z − minZ)) and level (feet = floorY + 0.5 + level · NAV_STEP). */
  readonly nodeCol: Int32Array;
  readonly nodeLevel: Uint8Array;
  /** Per node: world position of the standing spot (column centre, feet height). */
  readonly nx: Float32Array;
  readonly ny: Float32Array;
  readonly nz: Float32Array;
  /** Per node: bit k set = the neighbour column in direction k (0..3) has a bullet-proof block at chest and head height. */
  readonly cover: Uint8Array;
  /** Node is in the main area: reachable from and back to the first spawn (roaming picks from these). */
  readonly core: Uint8Array;
  /** Nodes per column (CSR). */
  readonly colStart: Int32Array;
  readonly colNodes: Int32Array;
  /** Outgoing edges (CSR). */
  readonly edgeStart: Int32Array;
  readonly edgeTo: Int32Array;
  readonly edgeCost: Float32Array;
  readonly edgeFlags: Uint8Array;
  /** Incoming edges (CSR, the source node in `revFrom`), for distance fields towards a goal. */
  readonly revStart: Int32Array;
  readonly revFrom: Int32Array;
  readonly revCost: Float32Array;
  /** Indices of the core nodes. */
  readonly coreList: Int32Array;
  /** Build time in ms (for the logs and the perf test). */
  readonly buildMs: number;

  // Search scratch (one search at a time: the server is single threaded).
  private readonly g: Float32Array;
  private readonly came: Int32Array;
  private readonly seen: Uint32Array;
  private readonly closed: Uint32Array;
  private gen = 0;
  private heap: Int32Array;
  private heapF: Float32Array;
  private readonly fields = new Map<string, Float32Array>();

  get size(): number {
    return this.nodeCol.length;
  }

  constructor(world: NavWorld, coreSeed?: { x: number; y: number; z: number }) {
    const t0 = performance.now();
    const b = world.bounds;
    this.minX = b.minX; this.minZ = b.minZ;
    this.w = b.maxX - b.minX; this.d = b.maxZ - b.minZ;
    this.floorY = world.floorY;
    this.levels = Math.min(255, Math.round((world.maxHeight ?? 14) / NAV_STEP));
    const mv = new MovementValidator({ getBlock: world.getBlock, getMeta: world.getMeta }, { maxSpeed: 1 });
    const solidAt = (x: number, y: number, z: number) => mv.inSolid(x, y, z);
    const feet = (l: number) => this.floorY + 0.5 + l * NAV_STEP;

    // 1. Standing spots: per column, candidate heights on top of solid blocks, checked with the validator's box.
    const cols = this.w * this.d;
    const colCount = new Int32Array(cols + 1);
    const tmpLevels: number[][] = new Array(cols);
    const top = this.floorY + Math.ceil(this.levels * NAV_STEP) + 1;
    for (let x = b.minX; x < b.maxX; x++) {
      for (let z = b.minZ; z < b.maxZ; z++) {
        const ci = (x - b.minX) * this.d + (z - b.minZ);
        const cx = x + 0.5, cz = z + 0.5;
        if (!world.inBounds(cx, cz)) continue;
        const found: number[] = [];
        let lastL = -1;
        for (let y = this.floorY; y <= top; y++) {
          const id = world.getBlock(x, y, z);
          if (!SOLID[id]) continue;
          // Feet on top of the block, or half a block higher/lower (slabs, stair steps, fences): the box test decides.
          for (const off of [0.5, 1, 1.5]) {
            const fy = y + off;
            const l = Math.round((fy - this.floorY - 0.5) / NAV_STEP);
            if (l < 0 || l >= this.levels || l <= lastL) continue;
            const fyl = feet(l);
            if (solidAt(cx, fyl, cz) || !solidAt(cx, fyl - 0.1, cz)) continue;
            found.push(l);
            lastL = l;
          }
        }
        tmpLevels[ci] = found;
        colCount[ci + 1] = found.length;
      }
    }
    for (let i = 0; i < cols; i++) colCount[i + 1] += colCount[i];
    const n = colCount[cols];
    this.colStart = colCount;
    this.colNodes = new Int32Array(n);
    this.nodeCol = new Int32Array(n);
    this.nodeLevel = new Uint8Array(n);
    this.nx = new Float32Array(n); this.ny = new Float32Array(n); this.nz = new Float32Array(n);
    for (let ci = 0; ci < cols; ci++) {
      const ls = tmpLevels[ci];
      if (!ls) continue;
      for (let k = 0; k < ls.length; k++) {
        const id = colCount[ci] + k;
        this.colNodes[id] = id;
        this.nodeCol[id] = ci;
        this.nodeLevel[id] = ls[k];
        this.nx[id] = Math.floor(ci / this.d) + b.minX + 0.5;
        this.nz[id] = (ci % this.d) + b.minZ + 0.5;
        this.ny[id] = feet(ls[k]);
      }
    }

    // 2. Edges.
    const vertical = (x: number, z: number, y0: number, y1: number): boolean => {
      const lo = Math.min(y0, y1), hi = Math.max(y0, y1);
      for (let y = lo; y <= hi + 1e-9; y += 0.125) if (solidAt(x, y, z)) return false;
      return true;
    };
    const sideways = (ax: number, az: number, bx: number, bz: number, y: number): boolean => {
      for (let f = 0.125; f <= 1.0001; f += 0.125) if (solidAt(ax + (bx - ax) * f, y, az + (bz - az) * f)) return false;
      return true;
    };
    const ladderAt = (x: number, y: number, z: number) => world.getBlock(Math.floor(x), Math.floor(y), Math.floor(z)) === BLOCK.LADDER;
    const edges: number[] = [];
    const counts = new Int32Array(n + 1);
    for (let id = 0; id < n; id++) {
      const ax = this.nx[id], ay = this.ny[id], az = this.nz[id];
      const bx0 = Math.floor(ax), bz0 = Math.floor(az);
      const onLadder = ladderAt(ax, ay + 0.1, az) || ladderAt(ax, ay + 1, az);
      let added = 0;
      for (let k = 0; k < 8; k++) {
        const tx = bx0 + DIRS[k][0], tz = bz0 + DIRS[k][1];
        const tc = this.column(tx, tz);
        if (tc < 0) continue;
        const s = this.colStart[tc], e = this.colStart[tc + 1];
        if (s === e) continue;
        const cx = tx + 0.5, cz = tz + 0.5;
        if (k >= 4) {
          // Diagonal: same height only, both straight neighbours standing at that height, and the diagonal itself free.
          const t = this.nodeIn(tc, this.nodeLevel[id]);
          if (t < 0) continue;
          if (this.nodeIn(this.column(tx, bz0), this.nodeLevel[id]) < 0 || this.nodeIn(this.column(bx0, tz), this.nodeLevel[id]) < 0) continue;
          if (!sideways(ax, az, cx, cz, ay)) continue;
          edges.push(id, t, EDGE_DIAGONAL);
          added++;
          continue;
        }
        // Straight: the highest reachable spot of the neighbour column (a roof above a floor is a different move).
        for (let j = e - 1; j >= s; j--) {
          const t = j;
          const by = this.ny[t];
          const dy = by - ay;
          let flags = 0;
          if (dy > 0) {
            const ladderClimb = onLadder && dy <= 12;
            if (dy > JUMP_UP + 1e-6 && !ladderClimb) continue;
            if (!vertical(ax, az, ay, by + (dy > STEP_UP ? 0.25 : 0)) || !sideways(ax, az, cx, cz, by)) continue;
            if (dy > JUMP_UP + 1e-6 || (ladderClimb && dy > STEP_UP)) flags = ladderClimb && dy > JUMP_UP ? EDGE_LADDER : EDGE_JUMP;
            else if (dy > STEP_UP + 1e-6) flags = EDGE_JUMP;
          } else if (dy < 0) {
            if (-dy > MAX_DROP + 1e-6) continue;
            if (!sideways(ax, az, cx, cz, ay) || !vertical(cx, cz, ay, by)) continue;
            if (-dy > STEP_UP + 1e-6) flags = EDGE_DROP;
          } else if (!sideways(ax, az, cx, cz, ay)) continue;
          edges.push(id, t, flags);
          added++;
          break;
        }
      }
      counts[id + 1] = added;
    }
    for (let i = 0; i < n; i++) counts[i + 1] += counts[i];
    const m = counts[n];
    this.edgeStart = counts;
    this.edgeTo = new Int32Array(m);
    this.edgeCost = new Float32Array(m);
    this.edgeFlags = new Uint8Array(m);
    const fill = new Int32Array(n);
    const revCount = new Int32Array(n + 1);
    for (let i = 0; i < edges.length; i += 3) {
      const from = edges[i], to = edges[i + 1], flags = edges[i + 2];
      const at = counts[from] + fill[from]++;
      this.edgeTo[at] = to;
      this.edgeFlags[at] = flags;
      const horiz = flags & EDGE_DIAGONAL ? Math.SQRT2 : 1;
      // Jumps and climbs are slower than walking; drops a little (landing).
      this.edgeCost[at] = horiz + (flags & EDGE_JUMP ? 0.6 : 0) + (flags & EDGE_LADDER ? Math.abs(this.ny[to] - this.ny[from]) * 1.5 : 0) + (flags & EDGE_DROP ? 0.3 : 0);
      revCount[to + 1]++;
    }
    for (let i = 0; i < n; i++) revCount[i + 1] += revCount[i];
    this.revStart = revCount;
    this.revFrom = new Int32Array(m);
    this.revCost = new Float32Array(m);
    const rfill = new Int32Array(n);
    for (let from = 0; from < n; from++) {
      for (let e = this.edgeStart[from]; e < this.edgeStart[from + 1]; e++) {
        const to = this.edgeTo[e];
        const at = revCount[to] + rfill[to]++;
        this.revFrom[at] = from;
        this.revCost[at] = this.edgeCost[e];
      }
    }

    // 3. Cover: bullet-proof blocks at chest and head height in the straight neighbours.
    this.cover = new Uint8Array(n);
    for (let id = 0; id < n; id++) {
      const x = Math.floor(this.nx[id]), z = Math.floor(this.nz[id]), y = this.ny[id];
      let bits = 0;
      for (let k = 0; k < 4; k++) {
        const ox = x + DIRS[k][0], oz = z + DIRS[k][1];
        if (blocksBullet(world.getBlock(ox, Math.floor(y + 1.1), oz)) && blocksBullet(world.getBlock(ox, Math.floor(y + PHYSICS.EYE_HEIGHT), oz))) bits |= 1 << k;
      }
      this.cover[id] = bits;
    }

    // Scratch.
    this.g = new Float32Array(n);
    this.came = new Int32Array(n);
    this.seen = new Uint32Array(n);
    this.closed = new Uint32Array(n);
    this.heap = new Int32Array(1024);
    this.heapF = new Float32Array(1024);

    // 4. Core area: reachable from the seed and able to get back to it.
    this.core = new Uint8Array(n);
    const seed = coreSeed ? this.nodeAt(coreSeed.x, coreSeed.y, coreSeed.z) : -1;
    if (seed >= 0) {
      const fwd = this.reach(seed, false), back = this.reach(seed, true);
      for (let i = 0; i < n; i++) if (fwd[i] && back[i]) this.core[i] = 1;
    } else this.core.fill(1);
    const list: number[] = [];
    for (let i = 0; i < n; i++) if (this.core[i]) list.push(i);
    this.coreList = Int32Array.from(list);
    this.buildMs = performance.now() - t0;
  }

  /** Column index of block column (x, z), or −1 outside. */
  column(x: number, z: number): number {
    const ix = x - this.minX, iz = z - this.minZ;
    if (ix < 0 || iz < 0 || ix >= this.w || iz >= this.d) return -1;
    return ix * this.d + iz;
  }

  /** Node of a column at an exact level, or −1. */
  nodeIn(col: number, level: number): number {
    if (col < 0) return -1;
    for (let i = this.colStart[col]; i < this.colStart[col + 1]; i++) if (this.nodeLevel[i] === level) return i;
    return -1;
  }

  /**
   * The node a player standing at (x, y, z) is on: the own column's spot nearest below the feet (or just above:
   * half a slab), else the nearest spot of a neighbouring column. −1 when there is none within a block.
   */
  nodeAt(x: number, y: number, z: number): number {
    const bx = Math.floor(x), bz = Math.floor(z);
    let best = -1, bestD = Infinity;
    for (let r = 0; r <= 1; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (r > 0 && Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
          const c = this.column(bx + dx, bz + dz);
          if (c < 0) continue;
          for (let i = this.colStart[c]; i < this.colStart[c + 1]; i++) {
            const dy = this.ny[i] - y;
            if (dy > 0.75 || dy < -2.5) continue;
            const dd = Math.hypot(this.nx[i] - x, this.nz[i] - z) + Math.abs(dy) * 0.5 + (dy > 0 ? 0.5 : 0);
            if (dd < bestD) { bestD = dd; best = i; }
          }
        }
      }
      if (best >= 0) return best;
    }
    return best;
  }

  /** Every node reachable from `start` (forward) or that can reach it (`reverse`). */
  private reach(start: number, reverse: boolean): Uint8Array {
    const n = this.size;
    const out = new Uint8Array(n);
    const q = new Int32Array(n);
    let h = 0, t = 0;
    q[t++] = start;
    out[start] = 1;
    while (h < t) {
      const c = q[h++];
      const s = reverse ? this.revStart : this.edgeStart;
      const arr = reverse ? this.revFrom : this.edgeTo;
      for (let e = s[c]; e < s[c + 1]; e++) {
        const o = arr[e];
        if (!out[o]) { out[o] = 1; q[t++] = o; }
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- A*

  private push(node: number, f: number, size: number): number {
    if (size >= this.heap.length) {
      const h = new Int32Array(this.heap.length * 2); h.set(this.heap); this.heap = h;
      const hf = new Float32Array(this.heapF.length * 2); hf.set(this.heapF); this.heapF = hf;
    }
    let i = size;
    const heap = this.heap, hf = this.heapF;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (hf[p] <= f) break;
      heap[i] = heap[p]; hf[i] = hf[p];
      i = p;
    }
    heap[i] = node; hf[i] = f;
    return size + 1;
  }

  private pop(size: number): number {
    const heap = this.heap, hf = this.heapF;
    const top = heap[0];
    const last = heap[size - 1], lf = hf[size - 1];
    size--;
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= size) break;
      if (c + 1 < size && hf[c + 1] < hf[c]) c++;
      if (hf[c] >= lf) break;
      heap[i] = heap[c]; hf[i] = hf[c];
      i = c;
    }
    heap[i] = last; hf[i] = lf;
    return top;
  }

  private nextGen(): number {
    if (++this.gen >= 0xffffffff) { this.gen = 1; this.seen.fill(0); this.closed.fill(0); }
    return this.gen;
  }

  /**
   * Shortest route from node `from` to node `to` (A*, 3D distance heuristic), as node ids including both ends;
   * null when there is none within `maxExpand` expansions. `out` is reused when given.
   */
  path(from: number, to: number, maxExpand = 8000, out: number[] = []): number[] | null {
    out.length = 0;
    if (from < 0 || to < 0) return null;
    if (from === to) { out.push(from); return out; }
    const gen = this.nextGen();
    const g = this.g, came = this.came, seen = this.seen, closed = this.closed;
    const tx = this.nx[to], ty = this.ny[to], tz = this.nz[to];
    const h = (i: number) => Math.hypot(this.nx[i] - tx, (this.ny[i] - ty) * 0.5, this.nz[i] - tz);
    g[from] = 0; came[from] = -1; seen[from] = gen;
    let size = this.push(from, h(from), 0);
    let expanded = 0;
    while (size > 0) {
      const c = this.pop(size); size--;
      if (closed[c] === gen) continue;
      closed[c] = gen;
      if (c === to) {
        for (let i = c; i >= 0; i = came[i]) out.push(i);
        out.reverse();
        return out;
      }
      if (++expanded > maxExpand) return null;
      const gc = g[c];
      for (let e = this.edgeStart[c]; e < this.edgeStart[c + 1]; e++) {
        const o = this.edgeTo[e];
        if (closed[o] === gen) continue;
        const ng = gc + this.edgeCost[e];
        if (seen[o] === gen && g[o] <= ng) continue;
        seen[o] = gen; g[o] = ng; came[o] = c;
        size = this.push(o, ng + h(o), size);
      }
    }
    return null;
  }

  /**
   * Distance (path cost) from every node to the nearest of `goals` (reverse Dijkstra), cached under `key`:
   * objective routes (a flag base, a zone) are computed once per map and followed downhill by every bot.
   * Unreachable nodes hold Infinity.
   */
  field(key: string, goals: () => readonly number[]): Float32Array {
    let f = this.fields.get(key);
    if (f) return f;
    const n = this.size;
    f = new Float32Array(n).fill(Infinity);
    const gen = this.nextGen();
    const closed = this.closed;
    let size = 0;
    for (const s of goals()) {
      if (s < 0) continue;
      f[s] = 0;
      size = this.push(s, 0, size);
    }
    while (size > 0) {
      const c = this.pop(size); size--;
      if (closed[c] === gen) continue;
      closed[c] = gen;
      const fc = f[c];
      for (let e = this.revStart[c]; e < this.revStart[c + 1]; e++) {
        const o = this.revFrom[e];
        const nd = fc + this.revCost[e];
        if (nd < f[o]) { f[o] = nd; size = this.push(o, nd, size); }
      }
    }
    this.fields.set(key, f);
    return f;
  }

  /** The next node downhill in a distance field from `node` (−1 at the goal or when stuck). */
  downhill(field: Float32Array, node: number): number {
    let best = -1, bestV = field[node];
    for (let e = this.edgeStart[node]; e < this.edgeStart[node + 1]; e++) {
      const o = this.edgeTo[e];
      const v = field[o] + this.edgeCost[e] * 1e-3;
      if (v < bestV) { bestV = v; best = o; }
    }
    return best;
  }

  /** Nodes within `radius` blocks (horizontal) of (x, z) whose feet are within `dy` of y. */
  nodesNear(x: number, y: number, z: number, radius: number, dy: number, out: number[] = []): number[] {
    out.length = 0;
    const r = Math.ceil(radius);
    const bx = Math.floor(x), bz = Math.floor(z);
    for (let ix = bx - r; ix <= bx + r; ix++) {
      for (let iz = bz - r; iz <= bz + r; iz++) {
        const c = this.column(ix, iz);
        if (c < 0) continue;
        for (let i = this.colStart[c]; i < this.colStart[c + 1]; i++) {
          if (Math.abs(this.ny[i] - y) > dy) continue;
          if (Math.hypot(this.nx[i] - x, this.nz[i] - z) > radius) continue;
          out.push(i);
        }
      }
    }
    return out;
  }

  /** Whether a standing spot exists at about feet height y under (x, z) (steering check for strafing). */
  walkable(x: number, y: number, z: number): boolean {
    const c = this.column(Math.floor(x), Math.floor(z));
    if (c < 0) return false;
    for (let i = this.colStart[c]; i < this.colStart[c + 1]; i++) if (Math.abs(this.ny[i] - y) <= 0.55) return true;
    return false;
  }
}

/** Graphs per map variant (any key the caller chooses: map id + variant), built on first use. */
const cache = new Map<string, NavGraph>();

export function navGraphFor(key: string, build: () => NavGraph): NavGraph {
  let g = cache.get(key);
  if (!g) { g = build(); cache.set(key, g); }
  return g;
}

/** For tests: forget cached graphs. */
export function clearNavCache(): void {
  cache.clear();
}
