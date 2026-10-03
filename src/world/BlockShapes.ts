import { BOX_KIND, META_MASK, OPAQUE, SHAPE, SHAPE_BOX, SHAPE_DOOR, SHAPE_SLAB, SHAPE_STAIRS } from './BlockRegistry';
import { BOX_FENCE, BOX_GATE, BOX_PANE, BOX_WALL, SIDE_BIT, boxCollision, gateConnects } from './BoxShapes';
import {
  DOOR_HINGE_RIGHT_BIT, DOOR_OPEN_BIT, DOOR_META_MASK, FACING_DX, FACING_DZ, FACING_OPPOSITE, OCT_ALL, STAIR_META_MASK, octantBoxes, slabOctants, stairOctants, stairShape,
  validSlabMeta,
} from './BlockStates';

/**
 * Geometry of the blocks that depend on their state byte (slabs, stairs, doors): collision boxes and
 * the octant masks the mesher builds faces from. Boxes are in block units (0..1) relative to the block.
 */

export type BlockGetter = (x: number, y: number, z: number) => number;

/** Is `meta` a state this block can really have? Servers use it to refuse made-up states. */
export function isValidMeta(id: number, meta: number): boolean {
  if (!Number.isInteger(meta) || meta < 0 || meta > 255) return false;
  if (meta === 0) return true;
  if ((meta & ~META_MASK[id]) !== 0) return false;
  return SHAPE[id] === SHAPE_SLAB ? validSlabMeta(meta) : true;
}

/**
 * Does a fence, wall or glass pane (`kind`) join the neighbour on `side` (0 north, 1 south, 2 west, 3 east)?
 * Solid blocks, its own kind and gates that run towards it. Shared by collision and the mesher.
 */
export function connectsTo(kind: number, nbId: number, nbMeta: number, side: number): boolean {
  if (kind !== BOX_FENCE && kind !== BOX_WALL && kind !== BOX_PANE) return false;
  if (OPAQUE[nbId]) return true;
  const nk = BOX_KIND[nbId];
  if (kind === BOX_PANE) return nk === BOX_PANE;
  if (nk === BOX_GATE) return gateConnects(nbMeta, FACING_OPPOSITE[side]);
  return nk === kind;
}

/** Connection bits (see SIDE_BIT) of the fence, wall or pane at (x, y, z). */
export function connectMask(kind: number, getBlock: BlockGetter, getMeta: BlockGetter, x: number, y: number, z: number): number {
  if (kind !== BOX_FENCE && kind !== BOX_WALL && kind !== BOX_PANE) return 0;
  let mask = 0;
  for (let s = 0; s < 4; s++) {
    const nx = x + FACING_DX[s], nz = z + FACING_DZ[s];
    if (connectsTo(kind, getBlock(nx, y, nz), getMeta(nx, y, nz), s)) mask |= SIDE_BIT[s];
  }
  return mask;
}

/** Stair meta of the neighbour at (x, y, z), or −1 when it is not a stairs block. */
function stairAt(getBlock: BlockGetter, getMeta: BlockGetter, x: number, y: number, z: number): number {
  return SHAPE[getBlock(x, y, z)] === SHAPE_STAIRS ? getMeta(x, y, z) & STAIR_META_MASK : -1;
}

/** Corner shape of the stair at (x, y, z) from its four horizontal neighbours. */
export function stairShapeAt(getBlock: BlockGetter, getMeta: BlockGetter, x: number, y: number, z: number, meta: number): number {
  return stairShape(
    meta,
    stairAt(getBlock, getMeta, x, y, z - 1), stairAt(getBlock, getMeta, x, y, z + 1),
    stairAt(getBlock, getMeta, x - 1, y, z), stairAt(getBlock, getMeta, x + 1, y, z),
  );
}

/** Octant mask of a slab or stairs block (stairs need their neighbours for the corner shape). */
export function octantsAt(id: number, meta: number, getBlock: BlockGetter, getMeta: BlockGetter, x: number, y: number, z: number): number {
  const shape = SHAPE[id];
  if (shape === SHAPE_SLAB) return slabOctants(meta);
  if (shape === SHAPE_STAIRS) return stairOctants(meta, stairShapeAt(getBlock, getMeta, x, y, z, meta & STAIR_META_MASK));
  return OCT_ALL;
}

// Door boxes: 0 north side (z 13..16), 1 south side (z 0..3), 2 west side (x 13..16), 3 east side (x 0..3).
// Minecraft's DoorBlock: a closed door sits on the side opposite to its facing; an open one swings to the
// side its hinge is on. OPEN_SIDE[facing * 2 + hingeRight].
const OPEN_SIDE = [3, 2, 2, 3, 0, 1, 1, 0];
const DOOR_T = 3 / 16;

/** Which side of its block a door is standing on (see door boxes above). */
export function doorSide(meta: number): number {
  const facing = meta & 3;
  if (!(meta & DOOR_OPEN_BIT)) return facing;
  return OPEN_SIDE[facing * 2 + (meta & DOOR_HINGE_RIGHT_BIT ? 1 : 0)];
}

/** Writes the door's box (x0, y0, z0, x1, y1, z1 in block units) at `at`. */
export function doorBox(meta: number, out: Float64Array | number[], at = 0): void {
  const side = doorSide(meta & DOOR_META_MASK);
  out[at] = side === 2 ? 1 - DOOR_T : 0;
  out[at + 1] = 0;
  out[at + 2] = side === 0 ? 1 - DOOR_T : 0;
  out[at + 3] = side === 3 ? DOOR_T : 1;
  out[at + 4] = 1;
  out[at + 5] = side === 1 ? DOOR_T : 1;
}

/**
 * Collision boxes of a partial block at (x, y, z) in block units, written to `out` (at most 4 boxes,
 * 24 numbers). Returns how many boxes there are.
 */
export function collisionBoxes(
  id: number, meta: number, getBlock: BlockGetter, getMeta: BlockGetter, x: number, y: number, z: number, out: Float64Array,
): number {
  if (SHAPE[id] === SHAPE_BOX) {
    const kind = BOX_KIND[id];
    return boxCollision(kind, meta, connectMask(kind, getBlock, getMeta, x, y, z), out);
  }
  if (SHAPE[id] === SHAPE_DOOR) {
    doorBox(meta, out, 0);
    return 1;
  }
  return octantBoxes(octantsAt(id, meta, getBlock, getMeta, x, y, z), out, 0);
}
