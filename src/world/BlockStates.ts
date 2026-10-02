/**
 * Block states: next to the block id (Uint8) every block has a `meta` byte with its variant
 * (slab half, stair facing, open door, liquid level). Meta 0 is always the default state, so
 * generated terrain needs no meta at all. See docs/BLOCKSTATES.md.
 *
 * A "state" is the pair packed into one number: id | meta << 8. Edit maps, the server's
 * world.json and the network all use that packed form.
 *
 * This file holds the pure meta arithmetic (no block registry): bit layouts, the stair shape
 * rules, placement rules and the octant masks that slabs and stairs are built from.
 */

export function packState(id: number, meta: number): number {
  return id | (meta << 8);
}

export function stateId(state: number): number {
  return state & 255;
}

export function stateMeta(state: number): number {
  return (state >> 8) & 255;
}

// ---------------------------------------------------------------- horizontal facing

/** Horizontal directions, in the order of the facing bits: north (−Z), south (+Z), west (−X), east (+X). */
export const NORTH = 0;
export const SOUTH = 1;
export const WEST = 2;
export const EAST = 3;
export const FACING_DX = [0, 0, -1, 1] as const;
export const FACING_DZ = [-1, 1, 0, 0] as const;
export const FACING_OPPOSITE = [SOUTH, NORTH, EAST, WEST] as const;
/** Counter-clockwise seen from above: north → west → south → east → north. */
export const FACING_CCW = [WEST, EAST, SOUTH, NORTH] as const;
export const FACING_CW = [EAST, WEST, NORTH, SOUTH] as const;

/** Horizontal facing of a player with the given yaw (yaw 0 looks along −Z, like Player.step). */
export function facingFromYaw(yaw: number): number {
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
  if (Math.abs(fx) > Math.abs(fz)) return fx > 0 ? EAST : WEST;
  return fz > 0 ? SOUTH : NORTH;
}

// ---------------------------------------------------------------- slabs

/** Slab meta: which half of the block it fills. */
export const SLAB_BOTTOM = 0;
export const SLAB_TOP = 1;
export const SLAB_DOUBLE = 2;

/** Slab state bits 0-1 are the half; the bits above are the material of a generic slab (see PartialMaterials). */
export const SLAB_HALF_MASK = 3;

export function validSlabMeta(meta: number): boolean {
  const half = meta & SLAB_HALF_MASK;
  return half >= 0 && half <= SLAB_DOUBLE;
}

// ---------------------------------------------------------------- stairs

/** Stair meta: bits 0-1 facing (the side of the tall back, = the way the player looked), bit 2 upside down. */
export const STAIR_FACING_MASK = 3;
export const STAIR_TOP_BIT = 4;
export const STAIR_META_MASK = 7;

export const STAIR_STRAIGHT = 0;
export const STAIR_INNER_LEFT = 1;
export const STAIR_INNER_RIGHT = 2;
export const STAIR_OUTER_LEFT = 3;
export const STAIR_OUTER_RIGHT = 4;

export function stairMeta(facing: number, top: boolean): number {
  return facing | (top ? STAIR_TOP_BIT : 0);
}

/**
 * Corner shape of a stair (Minecraft's StairBlock.getStairsShape). It is derived from the neighbours
 * instead of stored, so placing or removing a neighbour needs no extra edit.
 *
 * `n` holds the meta of the stair block (any material) on each side in the order north, south, west,
 * east, or −1 where the neighbour is not a stairs block.
 */
export function stairShape(meta: number, nNorth: number, nSouth: number, nWest: number, nEast: number): number {
  const facing = meta & STAIR_FACING_MASK;
  const top = meta & STAIR_TOP_BIT;
  // Outer corner: the stair in front of us (the way our back points) runs sideways.
  const front = sideOf(facing, nNorth, nSouth, nWest, nEast);
  if (front >= 0 && (front & STAIR_TOP_BIT) === top) {
    const f1 = front & STAIR_FACING_MASK;
    // Different axis (north/south = 0/1, west/east = 2/3) and not already continued by a stair like ours on the far side.
    if ((f1 >> 1) !== (facing >> 1) && canTakeShape(sideOf(FACING_OPPOSITE[f1], nNorth, nSouth, nWest, nEast), facing, top)) {
      return f1 === FACING_CCW[facing] ? STAIR_OUTER_LEFT : STAIR_OUTER_RIGHT;
    }
  }
  // Inner corner: the stair behind us runs sideways.
  const back = sideOf(FACING_OPPOSITE[facing], nNorth, nSouth, nWest, nEast);
  if (back >= 0 && (back & STAIR_TOP_BIT) === top) {
    const f2 = back & STAIR_FACING_MASK;
    if ((f2 >> 1) !== (facing >> 1) && canTakeShape(sideOf(f2, nNorth, nSouth, nWest, nEast), facing, top)) {
      return f2 === FACING_CCW[facing] ? STAIR_INNER_LEFT : STAIR_INNER_RIGHT;
    }
  }
  return STAIR_STRAIGHT;
}

function sideOf(dir: number, nNorth: number, nSouth: number, nWest: number, nEast: number): number {
  return dir === NORTH ? nNorth : dir === SOUTH ? nSouth : dir === WEST ? nWest : nEast;
}

/** A neighbour of another orientation next to us only blocks a corner when it has the same facing and half. */
function canTakeShape(neighbour: number, facing: number, top: number): boolean {
  return neighbour < 0 || (neighbour & STAIR_FACING_MASK) !== facing || (neighbour & STAIR_TOP_BIT) !== top;
}

// ---------------------------------------------------------------- octants

/**
 * Slabs and stairs are unions of 8×8×8 pieces (octants): bit = x | z << 1 | y << 2, where x, z and y
 * are 0 for the low half of the block and 1 for the high half. The low layer (y = 0) is bits 0-3,
 * the high layer bits 4-7.
 */
export const OCT_BOTTOM = 0x0f;
export const OCT_TOP = 0xf0;
export const OCT_ALL = 0xff;

/** Octant bit of the half-block coordinates (each 0 or 1). */
export function octant(hx: number, hy: number, hz: number): number {
  return 1 << (hx | (hz << 1) | (hy << 2));
}

/** The four octants touching a block face, face order +X −X +Y −Y +Z −Z. */
export const FACE_OCTANTS = [0xaa, 0x55, 0xf0, 0x0f, 0xcc, 0x33] as const;

export function slabOctants(meta: number): number {
  const half = meta & SLAB_HALF_MASK;
  return half === SLAB_BOTTOM ? OCT_BOTTOM : half === SLAB_TOP ? OCT_TOP : OCT_ALL;
}

/** Upper-layer footprint (4 bits, bit = x | z << 1) of a stair facing north, per shape. */
const STAIR_UPPER_NORTH = [
  0b0011, // straight: the back half (z = 0)
  0b0111, // inner left: back half + the south-west piece
  0b1011, // inner right: back half + the south-east piece
  0b0001, // outer left: the north-west piece
  0b0010, // outer right: the north-east piece
];

/** Rotates a half-block footprint of a north-facing stair to another facing. */
function rotateFootprint(foot: number, facing: number): number {
  let out = 0;
  for (let b = 0; b < 4; b++) {
    if (!(foot & (1 << b))) continue;
    const hx = b & 1, hz = b >> 1;
    let rx = hx, rz = hz;
    if (facing === SOUTH) { rx = 1 - hx; rz = 1 - hz; }
    else if (facing === WEST) { rx = hz; rz = 1 - hx; }
    else if (facing === EAST) { rx = 1 - hz; rz = hx; }
    out |= 1 << (rx | (rz << 1));
  }
  return out;
}

/** Octant mask per stair meta (0-7) and shape: STAIR_OCTANTS[meta * 5 + shape]. */
export const STAIR_OCTANTS = new Uint8Array(8 * 5);
for (let meta = 0; meta < 8; meta++) {
  for (let shape = 0; shape < 5; shape++) {
    const upper = rotateFootprint(STAIR_UPPER_NORTH[shape], meta & STAIR_FACING_MASK);
    const top = (meta & STAIR_TOP_BIT) !== 0;
    // Right way up: full bottom layer + upper footprint on top; upside down: the other way round.
    STAIR_OCTANTS[meta * 5 + shape] = top ? (OCT_TOP | upper) : (OCT_BOTTOM | (upper << 4));
  }
}

export function stairOctants(meta: number, shape: number): number {
  return STAIR_OCTANTS[(meta & STAIR_META_MASK) * 5 + shape];
}

/**
 * Splits an octant mask into non-overlapping boxes (block units 0..1), written as
 * x0, y0, z0, x1, y1, z1 into `out` at `at`. Returns the number of boxes (at most 4).
 */
export function octantBoxes(mask: number, out: Float64Array | number[], at = 0): number {
  const low = mask & 15, high = mask >> 4;
  if (low === high) return layerBoxes(low, 0, 1, out, at, 0);
  return layerBoxes(high, 0.5, 1, out, at, layerBoxes(low, 0, 0.5, out, at, 0));
}

/** One layer of boxes (a 2×2 footprint, bit = x | z << 1) between y0 and y1; `n` boxes already written, returns the new count. */
function layerBoxes(foot: number, y0: number, y1: number, out: Float64Array | number[], at: number, n: number): number {
  if (foot === 0) return n;
  const row0 = foot & 3, row1 = foot >> 2;
  if (row0 === row1) return rowBox(row0, 0, 1, y0, y1, out, at, n);
  return rowBox(row1, 0.5, 1, y0, y1, out, at, rowBox(row0, 0, 0.5, y0, y1, out, at, n));
}

/** A strip along x (bits: 3 = full width, 1 = west half, 2 = east half) between z0 and z1. */
function rowBox(bits: number, z0: number, z1: number, y0: number, y1: number, out: Float64Array | number[], at: number, n: number): number {
  if (bits === 0) return n;
  const x0 = bits === 2 ? 0.5 : 0, x1 = bits === 1 ? 0.5 : 1;
  const o = at + n * 6;
  out[o] = x0; out[o + 1] = y0; out[o + 2] = z0; out[o + 3] = x1; out[o + 4] = y1; out[o + 5] = z1;
  return n + 1;
}

// ---------------------------------------------------------------- placement rules

/**
 * Slab or stair half for a click: the clicked block face normal (ny) and the height of the click
 * inside the block (0..1). Like Minecraft: the underside of a block gives the top half, the top face
 * the bottom half, and a side face by where on the side you clicked.
 */
export function placedOnUpperHalf(ny: number, fracY: number): boolean {
  return ny < 0 || (ny === 0 && fracY > 0.5);
}

/**
 * May a slab item be added to the single slab that is already at the target cell (making it a double
 * slab)? `replacingClicked` is true when the cell is the clicked block itself (not the neighbour).
 * Minecraft's SlabBlock.canBeReplaced.
 */
export function canCombineSlab(existingMeta: number, replacingClicked: boolean, ny: number, nx: number, nz: number, fracY: number): boolean {
  if (existingMeta === SLAB_DOUBLE) return false;
  if (!replacingClicked) return true;
  const upperClick = fracY > 0.5;
  const horizontal = nx !== 0 || nz !== 0;
  if (existingMeta === SLAB_BOTTOM) return ny > 0 || (upperClick && horizontal);
  return ny < 0 || (!upperClick && horizontal);
}

// ---------------------------------------------------------------- doors

/** Door meta: bits 0-1 facing, bit 2 upper half, bit 3 hinge on the right, bit 4 open. */
export const DOOR_UPPER_BIT = 4;
export const DOOR_HINGE_RIGHT_BIT = 8;
export const DOOR_OPEN_BIT = 16;
export const DOOR_META_MASK = 31;

export function doorMeta(facing: number, upper: boolean, hingeRight: boolean, open: boolean): number {
  return facing | (upper ? DOOR_UPPER_BIT : 0) | (hingeRight ? DOOR_HINGE_RIGHT_BIT : 0) | (open ? DOOR_OPEN_BIT : 0);
}

export function isDoorUpper(meta: number): boolean {
  return (meta & DOOR_UPPER_BIT) !== 0;
}
