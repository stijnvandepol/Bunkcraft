import { FACING_DX, FACING_DZ, NORTH, SOUTH, WEST, EAST } from './BlockStates';

/**
 * Thin and connecting blocks built from a few boxes: carpets, trapdoors, fence gates, fences, walls, glass panes,
 * ladders and beds. Pure geometry, shared by the mesher (visual boxes), collision and the ray cast.
 *
 * State byte layouts (the variant bits, which the item keeps, are marked):
 *  - carpet: bits 0-3 colour (variant);
 *  - trapdoor: bits 0-1 facing (the side the hinge is on), bit 2 top half, bit 3 open, bits 4-7 wood (variant);
 *  - fence gate: bits 0-1 facing, bit 2 open, bits 3-7 wood (variant);
 *  - fence: bits 0-2 wood (variant); wall: bits 0-4 material (variant); the connections are derived from the neighbours;
 *  - pane: bits 0-3 colour (stained glass pane) or nothing; iron bars: nothing;
 *  - ladder: bits 0-1 the side of the wall it is fixed to;
 *  - bed: bits 0-1 the way from foot to head, bit 2 head half, bits 3-6 colour (variant);
 *  - enchanting table: nothing (a 12 px high slab);
 *  - anvil: bits 0-1 facing (east/west turn it), bits 2-3 damage: anvil, chipped, damaged (variant);
 *  - grindstone: bits 0-1 facing (east/west turn it).
 */

export const BOX_NONE = 0;
export const BOX_CARPET = 1;
export const BOX_TRAPDOOR = 2;
export const BOX_GATE = 3;
export const BOX_FENCE = 4;
export const BOX_WALL = 5;
export const BOX_PANE = 6;
export const BOX_LADDER = 7;
export const BOX_BED = 8;
export const BOX_TABLE = 9;
export const BOX_ANVIL = 10;
export const BOX_GRINDSTONE = 11;

export const TRAPDOOR_TOP_BIT = 4;
export const TRAPDOOR_OPEN_BIT = 8;
export const GATE_OPEN_BIT = 4;
export const BED_HEAD_BIT = 4;
export const FACING_MASK = 3;

/** Most boxes any shape produces (a fence with four arms: two bars per arm and the post). */
export const MAX_BOXES = 9;
/** Numbers per box in the output arrays. */
export const BOX_STRIDE = 6;

const P = 1 / 16;

function put(out: Float64Array | number[], n: number, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number {
  const o = n * BOX_STRIDE;
  out[o] = x0; out[o + 1] = y0; out[o + 2] = z0; out[o + 3] = x1; out[o + 4] = y1; out[o + 5] = z1;
  return n + 1;
}

/** Connection bit of a side: north (−Z) 1, south (+Z) 2, west (−X) 4, east (+X) 8. */
export const SIDE_BIT = [1, 2, 4, 8] as const;

/** Does a gate with this state connect to a fence or wall on the given side (its panel runs along the other axis)? */
export function gateConnects(gateMeta: number, side: number): boolean {
  const facing = gateMeta & FACING_MASK;
  const panelAlongX = facing === NORTH || facing === SOUTH;
  return panelAlongX ? side === WEST || side === EAST : side === NORTH || side === SOUTH;
}

/**
 * Visual boxes (block units) of a block. `connect` is the neighbour mask for fences, walls and panes. Returns the
 * number of boxes written to `out`.
 */
export function visualBoxes(kind: number, meta: number, connect: number, out: Float64Array | number[]): number {
  switch (kind) {
    case BOX_CARPET:
      return put(out, 0, 0, 0, 0, 1, P, 1);
    case BOX_BED:
      return put(out, 0, 0, 3 * P, 0, 1, 9 * P, 1);
    case BOX_TRAPDOOR: return trapdoorBox(meta, out, 0, 1);
    case BOX_LADDER: return ladderBox(meta, out);
    case BOX_GATE: return gateBoxes(meta, out, 1, true);
    case BOX_FENCE: {
      let n = put(out, 0, 6 * P, 0, 6 * P, 10 * P, 1, 10 * P);
      for (let s = 0; s < 4; s++) {
        if (!(connect & SIDE_BIT[s])) continue;
        for (const [y0, y1] of [[6 * P, 9 * P], [12 * P, 15 * P]]) n = arm(out, n, s, 7 * P, 9 * P, y0, y1, 6 * P);
      }
      return n;
    }
    case BOX_WALL: {
      let n = put(out, 0, 4 * P, 0, 4 * P, 12 * P, 1, 12 * P);
      for (let s = 0; s < 4; s++) if (connect & SIDE_BIT[s]) n = arm(out, n, s, 5 * P, 11 * P, 0, 14 * P, 4 * P);
      return n;
    }
    case BOX_PANE: {
      let n = put(out, 0, 7 * P, 0, 7 * P, 9 * P, 1, 9 * P);
      for (let s = 0; s < 4; s++) if (connect & SIDE_BIT[s]) n = arm(out, n, s, 7 * P, 9 * P, 0, 1, 7 * P);
      return n;
    }
    case BOX_TABLE:
    case BOX_ANVIL:
    case BOX_GRINDSTONE:
      return stationBoxes(kind, meta, out);
    default:
      return 0;
  }
}

/** Boxes of the enchanting table, anvil and grindstone in 1/16 units, the long side along z; east/west facing turns them. */
const STATION_MODELS: Record<number, number[][]> = {
  [BOX_TABLE]: [[0, 0, 0, 16, 12, 16]],
  // Minecraft's anvil: foot, two neck pieces and the long top.
  [BOX_ANVIL]: [[2, 0, 2, 14, 4, 14], [4, 4, 3, 12, 5, 13], [6, 5, 4, 10, 10, 12], [3, 10, 0, 13, 16, 16]],
  // Grindstone: the wheel between two posts, with the pivots.
  [BOX_GRINDSTONE]: [[6, 4, 2, 10, 16, 14], [2, 0, 6, 4, 13, 10], [12, 0, 6, 14, 13, 10], [4, 7, 7, 6, 11, 9], [10, 7, 7, 12, 11, 9]],
};

function stationBoxes(kind: number, meta: number, out: Float64Array | number[]): number {
  const turn = kind !== BOX_TABLE && ((meta & FACING_MASK) === EAST || (meta & FACING_MASK) === WEST);
  let n = 0;
  for (const [x0, y0, z0, x1, y1, z1] of STATION_MODELS[kind]) {
    n = turn ? put(out, n, z0 * P, y0 * P, x0 * P, z1 * P, y1 * P, x1 * P) : put(out, n, x0 * P, y0 * P, z0 * P, x1 * P, y1 * P, z1 * P);
  }
  return n;
}

/** Collision boxes: like the visual ones, but fences, walls and gates are 1.5 blocks tall and arms are merged. */
export function boxCollision(kind: number, meta: number, connect: number, out: Float64Array | number[]): number {
  switch (kind) {
    case BOX_CARPET: return put(out, 0, 0, 0, 0, 1, P, 1);
    case BOX_BED: return put(out, 0, 0, 0, 0, 1, 9 * P, 1);
    case BOX_TRAPDOOR: return trapdoorBox(meta, out, 0, 1);
    case BOX_LADDER: return ladderBox(meta, out);
    case BOX_GATE: return (meta & GATE_OPEN_BIT) ? 0 : gateBoxes(meta, out, 1.5, false);
    case BOX_FENCE: {
      let n = put(out, 0, 6 * P, 0, 6 * P, 10 * P, 1.5, 10 * P);
      for (let s = 0; s < 4; s++) if (connect & SIDE_BIT[s]) n = arm(out, n, s, 6 * P, 10 * P, 0, 1.5, 6 * P);
      return n;
    }
    case BOX_WALL: {
      let n = put(out, 0, 4 * P, 0, 4 * P, 12 * P, 1.5, 12 * P);
      for (let s = 0; s < 4; s++) if (connect & SIDE_BIT[s]) n = arm(out, n, s, 5 * P, 11 * P, 0, 1.5, 4 * P);
      return n;
    }
    case BOX_PANE: {
      let n = put(out, 0, 7 * P, 0, 7 * P, 9 * P, 1, 9 * P);
      for (let s = 0; s < 4; s++) if (connect & SIDE_BIT[s]) n = arm(out, n, s, 7 * P, 9 * P, 0, 1, 7 * P);
      return n;
    }
    case BOX_TABLE:
    case BOX_ANVIL:
    case BOX_GRINDSTONE:
      return stationBoxes(kind, meta, out);
    default:
      return 0;
  }
}

/** Is any part of this kind taller than one block (the physics must look one cell lower for it)? */
export function isTall(kind: number): boolean {
  return kind === BOX_FENCE || kind === BOX_WALL || kind === BOX_GATE;
}

/**
 * An arm from the post towards `side`, `lo..hi` wide across and `y0..y1` high, reaching the block edge from `from`
 * (the distance of the post face from the cell edge).
 */
function arm(out: Float64Array | number[], n: number, side: number, lo: number, hi: number, y0: number, y1: number, from: number): number {
  switch (side) {
    case NORTH: return put(out, n, lo, y0, 0, hi, y1, from);
    case SOUTH: return put(out, n, lo, y0, 1 - from, hi, y1, 1);
    case WEST: return put(out, n, 0, y0, lo, from, y1, hi);
    default: return put(out, n, 1 - from, y0, lo, 1, y1, hi);
  }
}

function trapdoorBox(meta: number, out: Float64Array | number[], n: number, _h: number): number {
  const t = 3 * P;
  if (!(meta & TRAPDOOR_OPEN_BIT)) {
    return (meta & TRAPDOOR_TOP_BIT) ? put(out, n, 0, 1 - t, 0, 1, 1, 1) : put(out, n, 0, 0, 0, 1, t, 1);
  }
  switch (meta & FACING_MASK) {
    case NORTH: return put(out, n, 0, 0, 0, 1, 1, t);
    case SOUTH: return put(out, n, 0, 0, 1 - t, 1, 1, 1);
    case WEST: return put(out, n, 0, 0, 0, t, 1, 1);
    default: return put(out, n, 1 - t, 0, 0, 1, 1, 1);
  }
}

function ladderBox(meta: number, out: Float64Array | number[]): number {
  const t = 2 * P;
  switch (meta & FACING_MASK) {
    case NORTH: return put(out, 0, 0, 0, 0, 1, 1, t);
    case SOUTH: return put(out, 0, 0, 0, 1 - t, 1, 1, 1);
    case WEST: return put(out, 0, 0, 0, 0, t, 1, 1);
    default: return put(out, 0, 1 - t, 0, 0, 1, 1, 1);
  }
}

/** Gate: two posts and (visually) two rails; closed collision is one slab 1.5 high. */
function gateBoxes(meta: number, out: Float64Array | number[], height: number, visual: boolean): number {
  const facing = meta & FACING_MASK;
  const alongX = facing === NORTH || facing === SOUTH;
  const open = (meta & GATE_OPEN_BIT) !== 0;
  const y0 = visual ? 5 * P : 0;
  const y1 = visual ? 1 : height;
  let n = 0;
  const post = (a: number, b: number): void => {
    n = alongX ? put(out, n, a, y0, 6 * P, b, y1, 10 * P) : put(out, n, 6 * P, y0, a, 10 * P, y1, b);
  };
  const rail = (a: number, b: number, ry0: number, ry1: number, depth0: number, depth1: number): void => {
    n = alongX ? put(out, n, a, ry0, depth0, b, ry1, depth1) : put(out, n, depth0, ry0, a, depth1, ry1, b);
  };
  if (!visual) {
    if (open) return 0;
    post(0, 1);
    return n;
  }
  post(0, 2 * P);
  post(14 * P, 1);
  if (open) {
    // The leaves swing to the side of the hinge posts: two short bars along the other axis.
    for (const [ry0, ry1] of [[6 * P, 9 * P], [12 * P, 15 * P]]) {
      rail(0, 2 * P, ry0, ry1, 10 * P, 1);
      rail(14 * P, 1, ry0, ry1, 10 * P, 1);
    }
  } else {
    for (const [ry0, ry1] of [[6 * P, 9 * P], [12 * P, 15 * P]]) rail(2 * P, 14 * P, ry0, ry1, 7 * P, 9 * P);
  }
  return n;
}

/** The two cells of a bed: the other half is one step along (or against) the foot→head direction. */
export function bedPartner(x: number, z: number, meta: number): { x: number; z: number } {
  const f = meta & FACING_MASK;
  const sign = (meta & BED_HEAD_BIT) ? -1 : 1;
  return { x: x + FACING_DX[f] * sign, z: z + FACING_DZ[f] * sign };
}

/** Facing of the side where the wall is for a ladder placed against a clicked face with normal (nx, nz). */
export function ladderSide(nx: number, nz: number): number {
  if (nz > 0) return NORTH;
  if (nz < 0) return SOUTH;
  return nx > 0 ? WEST : EAST;
}
