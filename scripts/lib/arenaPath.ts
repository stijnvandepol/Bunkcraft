import { MovementValidator } from '../../server/anticheat/Movement';
import { ARENA_FLOOR_Y, type ArenaMap } from '../../src/modes/maps';

/**
 * Bot helpers for the arcade scripts: honest movement that the server's movement validator accepts.
 * Paths run through the centres of standing cells (4-neighbour BFS, so the 0.6 wide player box never
 * touches a wall) at a pace below the arcade run speed, over every standing height: floors, platforms,
 * slabs and stairs. A step up (at most one block, as a jump would) or a drop is one move: the bot rises
 * at its own cell and then moves over, or moves over and then drops, the routes the validator checks.
 */

/** Blocks per second: below the slowest arcade run speed (sniper, 0.92 × 7.29 ≈ 6.7). */
export const BOT_SPEED = 6;

/** A route point: cell centre (x, z) and, from `arenaPath`, the feet height there. */
export type RoutePoint = [number, number, number?];

/** Standing heights are multiples of this (slabs and stair steps are half blocks). */
const H = 0.5;
/** Highest feet height above the floor that is searched. */
const LEVELS = 26;
const MAX_UP = 1;
const MAX_DROP = 4;

interface Grid {
  map: ArenaMap; variant: number;
  w: number; d: number;
  /** Per column and level: 0 unknown, 1 standing spot, 2 not. */
  stand: Uint8Array;
  /** Moves already checked: (node, direction, target level) → passable. */
  edge: Map<number, boolean>;
  mv: MovementValidator;
}

const grids = new WeakMap<ArenaMap, Map<number, Grid>>();

function grid(map: ArenaMap, variant: number): Grid {
  let byVariant = grids.get(map);
  if (!byVariant) grids.set(map, byVariant = new Map());
  let g = byVariant.get(variant);
  if (!g) {
    const b = map.bounds, w = b.maxX - b.minX, d = b.maxZ - b.minZ;
    // The validator's own collision test (block shapes as the server sees them) decides where a bot fits.
    const mv = new MovementValidator({ getBlock: (x, y, z) => map.blockAt(variant, x, y, z), getMeta: () => 0 }, { maxSpeed: 1 });
    g = { map, variant, w, d, stand: new Uint8Array(w * d * LEVELS), edge: new Map(), mv };
    byVariant.set(variant, g);
  }
  return g;
}

/** Feet height of level `l` (half blocks above the floor surface). */
const feet = (l: number) => ARENA_FLOOR_Y + 1 + l * H;

/** Is level `l` (feet at ARENA_FLOOR_Y + 1 + l/2) of column (x, z) a standing spot? */
function standing(g: Grid, x: number, z: number, l: number): boolean {
  const b = g.map.bounds;
  if (x < b.minX || z < b.minZ || x >= b.maxX || z >= b.maxZ || l < 0 || l >= LEVELS) return false;
  const i = ((x - b.minX) * g.d + (z - b.minZ)) * LEVELS + l;
  if (g.stand[i] === 0) {
    const cx = x + 0.5, cz = z + 0.5, y = feet(l);
    const ok = g.map.inBounds(cx, cz) && !g.mv.inSolid(cx, y, cz) && g.mv.inSolid(cx, y - 0.1, cz)
      // Not a spot half a block above the real one (the probe below reaches 0.1).
      && !(l > 0 && !g.mv.inSolid(cx, y - H, cz) && g.mv.inSolid(cx, y - H - 0.1, cz));
    g.stand[i] = ok ? 1 : 2;
  }
  return g.stand[i] === 1;
}

/** Sideways from (ax, az) to (bx, bz) at feet height y: free all the way (validator sampling). */
function sideways(g: Grid, ax: number, az: number, bx: number, bz: number, y: number): boolean {
  for (let f = 0.125; f <= 1.0001; f += 0.125) if (g.mv.inSolid(ax + (bx - ax) * f, y, az + (bz - az) * f)) return false;
  return true;
}

function vertical(g: Grid, x: number, z: number, y0: number, y1: number): boolean {
  const lo = Math.min(y0, y1), hi = Math.max(y0, y1);
  for (let y = lo; y <= hi + 1e-9; y += 0.125) if (g.mv.inSolid(x, y, z)) return false;
  return true;
}

const DIRS: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** Can a bot get from level l of (x, z) to level nl of the neighbour in direction k? */
function passable(g: Grid, node: number, x: number, z: number, l: number, k: number, nl: number): boolean {
  const key = (node * 4 + k) * LEVELS + nl;
  let ok = g.edge.get(key);
  if (ok === undefined) {
    const ax = x + 0.5, az = z + 0.5, bx = ax + DIRS[k][0], bz = az + DIRS[k][1];
    const y0 = feet(l), y1 = feet(nl);
    ok = y1 > y0 ? vertical(g, ax, az, y0, y1) && sideways(g, ax, az, bx, bz, y1)
      : y1 < y0 ? sideways(g, ax, az, bx, bz, y0) && vertical(g, bx, bz, y0, y1)
        : sideways(g, ax, az, bx, bz, y0);
    g.edge.set(key, ok);
  }
  return ok;
}

/**
 * A route from `from` to `to` (x, z, optional feet y: the start level nearest to it, by default the floor)
 * through standing cells, as cell centres with the feet height; null when there is none.
 */
export function arenaPath(map: ArenaMap, variant: number, from: [number, number, number?], to: [number, number, number?]): [number, number, number][] | null {
  const g = grid(map, variant);
  const b = map.bounds, d = g.d;
  const sx = Math.floor(from[0]), sz = Math.floor(from[1]), tx = Math.floor(to[0]), tz = Math.floor(to[1]);
  const level = (y: number) => Math.round((y - ARENA_FLOOR_Y - 1) / H);
  // Start: the standing level of the own column nearest to the given height.
  const want = level(from[2] ?? ARENA_FLOOR_Y + 1);
  let sl = -1;
  for (let k = 0; k < LEVELS && sl < 0; k++) {
    if (standing(g, sx, sz, want - k)) sl = want - k;
    else if (standing(g, sx, sz, want + k)) sl = want + k;
  }
  if (sl < 0) return null;
  const node = (x: number, z: number, l: number) => ((x - b.minX) * d + (z - b.minZ)) * LEVELS + l;
  const prev = new Int32Array(g.w * d * LEVELS).fill(-1);
  const start = node(sx, sz, sl);
  prev[start] = start;
  const q = [start];
  const wantT = to[2] === undefined ? -1 : level(to[2]);
  let found = -1;
  for (let h = 0; h < q.length; h++) {
    const c = q[h], l = c % LEVELS, col = (c - l) / LEVELS, x = Math.floor(col / d) + b.minX, z = (col % d) + b.minZ;
    if (x === tx && z === tz && (wantT < 0 || l === wantT)) { found = c; break; }
    for (let k = 0; k < 4; k++) {
      const nx = x + DIRS[k][0], nz = z + DIRS[k][1];
      for (let nl = Math.min(LEVELS - 1, l + MAX_UP / H); nl >= Math.max(0, l - MAX_DROP / H); nl--) {
        if (!standing(g, nx, nz, nl)) continue;
        const n = node(nx, nz, nl);
        if (prev[n] < 0) {
          // Blocked (a low ceiling, a wall at head height): maybe a lower level of that column.
          if (!passable(g, c, x, z, l, k, nl)) continue;
          prev[n] = c;
          q.push(n);
        }
        break;
      }
    }
  }
  if (found < 0) return null;
  const centre = (c: number): [number, number, number] => {
    const l = c % LEVELS, col = (c - l) / LEVELS;
    return [Math.floor(col / d) + b.minX + 0.5, (col % d) + b.minZ + 0.5, feet(l)];
  };
  const out: [number, number, number][] = [[to[0], to[1], feet(found % LEVELS)]];
  for (let c = prev[found]; c !== prev[c]; c = prev[c]) out.push(centre(c));
  // Start from the centre of the own cell so the first leg is axis-aligned too.
  out.push(centre(start));
  return out.reverse();
}

/** Walking budget a bot saved up for a step up or down (it takes such a move in one report). */
const banked = new WeakMap<object, number>();

/**
 * Moves (x, z) along `route` by `step` blocks, consuming reached points. A point with a different feet
 * height is a step up or a drop: the bot saves up the walking budget for that leg and then takes it in
 * one move (straight onto the next cell centre), so its average pace stays `step` per call.
 */
export function follow(pos: { x: number; y?: number; z: number }, route: RoutePoint[], step: number): void {
  step += banked.get(pos) ?? 0;
  banked.delete(pos);
  while (step > 0 && route.length) {
    const [tx, tz, ty] = route[0];
    const dx = tx - pos.x, dz = tz - pos.z, dist = Math.hypot(dx, dz);
    if (ty !== undefined && pos.y !== undefined && Math.abs(ty - pos.y) > 0.01) {
      if (step < dist) { banked.set(pos, step); return; }
      pos.x = tx; pos.z = tz; pos.y = ty;
      route.shift();
      // One height change per report: the validator sees the step and the landing separately.
      return;
    }
    if (dist <= step) { pos.x = tx; pos.z = tz; route.shift(); step -= dist; } else { pos.x += (dx / dist) * step; pos.z += (dz / dist) * step; step = 0; }
  }
}

/**
 * The `step` field of a position report: the client's physics clock in 60 Hz steps. Bots move by real
 * time, so their clock is real time (rounded down: never ahead of it). The server times the jump curve
 * and the speed budget with it instead of arrival times, which bunch up when the machine is loaded.
 */
export function clientStep(): number {
  return Math.floor(performance.now() * 0.06);
}

/** Unit aim vector from (ox, oy, oz) to (tx, ty, tz): the server only accepts unit directions. */
export function aimAt(ox: number, oy: number, oz: number, tx: number, ty: number, tz: number): { dx: number; dy: number; dz: number } {
  const dx = tx - ox, dy = ty - oy, dz = tz - oz, d = Math.hypot(dx, dy, dz) || 1;
  return { dx: dx / d, dy: dy / d, dz: dz / d };
}
