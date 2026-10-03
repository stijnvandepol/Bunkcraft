import {
  BLOCK, BOX_KIND, FACING, OPAQUE, SHAPE, VARIANT_MASK, SHAPE_CROSS, SHAPE_CUBE, SHAPE_DOOR, SHAPE_LIQUID, SHAPE_NONE, SHAPE_SLAB, SHAPE_STAIRS, SOLID,
} from './BlockRegistry';
import {
  FACING_CCW, FACING_CW, FACING_DX, FACING_DZ, SLAB_BOTTOM, SLAB_DOUBLE, SLAB_HALF_MASK, SLAB_TOP, STAIR_TOP_BIT, canCombineSlab, doorMeta, facingFromYaw,
  isDoorUpper, placedOnUpperHalf, stairMeta,
} from './BlockStates';
import { BED_HEAD_BIT, BOX_BED, BOX_CARPET, BOX_GATE, BOX_LADDER, BOX_TRAPDOOR, TRAPDOOR_TOP_BIT, ladderSide } from './BoxShapes';
import { CHUNK_HEIGHT } from './constants';

/** What the player is aiming at and holding when they press Use. */
export interface PlaceContext {
  /** Block item being placed. */
  id: number;
  /** The clicked block and the normal of the clicked face. */
  hitX: number; hitY: number; hitZ: number;
  nx: number; ny: number; nz: number;
  /** Height of the click inside the clicked block, 0..1. */
  fracY: number;
  /** Where along x and z the click landed inside the block (0..1), used for the hinge side of a door. */
  fracX?: number;
  fracZ?: number;
  /** Variant bits of the item (wood, material, colour): slabs only combine with slabs of the same material. */
  variant?: number;
  /** Player yaw (see Player): decides which way stairs and doors face. */
  yaw: number;
  getBlock(x: number, y: number, z: number): number;
  getMeta(x: number, y: number, z: number): number;
}

export interface Placement {
  x: number; y: number; z: number;
  id: number;
  meta: number;
  /** A second block placed together with this one (the upper half of a door). */
  upper?: Placement;
  /** An existing block whose state changes with this placement (the other half of a new double chest). */
  neighbor?: Placement;
}

/** Can a block stand on top of this one: opaque blocks, double and top slabs, upside-down stairs (isFaceSturdy UP). */
export function topFaceSturdy(id: number, meta: number): boolean {
  if (OPAQUE[id]) return true;
  const s = SHAPE[id];
  if (s === SHAPE_SLAB) return (meta & SLAB_HALF_MASK) !== SLAB_BOTTOM;
  if (s === SHAPE_STAIRS) return (meta & STAIR_TOP_BIT) !== 0;
  return false;
}

/** A solid block with a full-cube collision shape (Minecraft's isCollisionShapeFullBlock): decides door hinges. */
function fullBlock(id: number): boolean {
  return SHAPE[id] === SHAPE_CUBE && SOLID[id] === 1;
}

/**
 * Which side the hinge goes on (Minecraft's DoorBlock.getHinge): next to a wall or another door it joins it
 * (so a double door opens outwards), otherwise by the side of the block that was clicked. true = right.
 */
export function doorHingeRight(c: PlaceContext, x: number, y: number, z: number, facing: number): boolean {
  const ccw = FACING_CCW[facing], cw = FACING_CW[facing];
  const lx = x + FACING_DX[ccw], lz = z + FACING_DZ[ccw];
  const rx = x + FACING_DX[cw], rz = z + FACING_DZ[cw];
  let score = 0;
  if (fullBlock(c.getBlock(lx, y, lz))) score--;
  if (fullBlock(c.getBlock(lx, y + 1, lz))) score--;
  if (fullBlock(c.getBlock(rx, y, rz))) score++;
  if (fullBlock(c.getBlock(rx, y + 1, rz))) score++;
  const leftDoor = SHAPE[c.getBlock(lx, y, lz)] === SHAPE_DOOR && !isDoorUpper(c.getMeta(lx, y, lz));
  const rightDoor = SHAPE[c.getBlock(rx, y, rz)] === SHAPE_DOOR && !isDoorUpper(c.getMeta(rx, y, rz));
  if ((!leftDoor || rightDoor) && score <= 0) {
    if ((!rightDoor || leftDoor) && score >= 0) {
      const j = FACING_DX[facing], k = FACING_DZ[facing];
      const d0 = c.fracX ?? 0.5, d1 = c.fracZ ?? 0.5;
      const left = (j >= 0 || !(d1 < 0.5)) && (j <= 0 || !(d1 > 0.5)) && (k >= 0 || !(d0 > 0.5)) && (k <= 0 || !(d0 < 0.5));
      return !left;
    }
    return false;
  }
  return true;
}

/**
 * Where a full bucket pours its liquid (Minecraft BucketItem): into the cell in front of the clicked face, or into the
 * plant that was clicked. Never into a solid block, and not into a source of the same liquid. `kind` is BLOCK.WATER or LAVA.
 */
export function resolveBucketTarget(
  c: Pick<PlaceContext, 'hitX' | 'hitY' | 'hitZ' | 'nx' | 'ny' | 'nz' | 'getBlock' | 'getMeta'>, kind: number,
): { x: number; y: number; z: number } | null {
  let x = c.hitX + c.nx, y = c.hitY + c.ny, z = c.hitZ + c.nz;
  if (SHAPE[c.getBlock(c.hitX, c.hitY, c.hitZ)] === SHAPE_CROSS) { x = c.hitX; y = c.hitY; z = c.hitZ; }
  const existing = c.getBlock(x, y, z);
  if (existing === BLOCK.UNLOADED || !isReplaceable(existing)) return null;
  if (existing === kind && c.getMeta(x, y, z) === 0) return null;
  return { x, y, z };
}

/** Blocks that give way to whatever is placed into them. */
export function isReplaceable(id: number): boolean {
  const s = SHAPE[id];
  return s === SHAPE_NONE || s === SHAPE_LIQUID || s === SHAPE_CROSS;
}

/**
 * Where a block item goes and with which state, following Minecraft's placement rules:
 *  - a slab on a single slab of the same kind makes a double slab (only on the matching half of the clicked slab);
 *  - slabs sit on the half of the face that was clicked;
 *  - stairs face the way the player looks and flip when placed against a ceiling or the upper half of a wall.
 * Returns null when nothing can be placed there (the target is not replaceable).
 */
export function resolvePlacement(c: PlaceContext): Placement | null {
  const { id } = c;
  const shape = SHAPE[id];
  // Slab on the slab that was clicked.
  const mask = VARIANT_MASK[id];
  const sameMaterial = (x: number, y: number, z: number): boolean => (c.getMeta(x, y, z) & mask) === ((c.variant ?? 0) & mask);
  if (shape === SHAPE_SLAB && c.getBlock(c.hitX, c.hitY, c.hitZ) === id && sameMaterial(c.hitX, c.hitY, c.hitZ)
    && canCombineSlab(c.getMeta(c.hitX, c.hitY, c.hitZ) & SLAB_HALF_MASK, true, c.ny, c.nx, c.nz, c.fracY)) {
    return { x: c.hitX, y: c.hitY, z: c.hitZ, id, meta: SLAB_DOUBLE };
  }
  let x = c.hitX + c.nx, y = c.hitY + c.ny, z = c.hitZ + c.nz;
  // Placing onto grass and flowers replaces them, like in Minecraft.
  if (SHAPE[c.getBlock(c.hitX, c.hitY, c.hitZ)] === SHAPE_CROSS) { x = c.hitX; y = c.hitY; z = c.hitZ; }
  const existing = c.getBlock(x, y, z);
  if (existing === BLOCK.UNLOADED) return null;
  if (shape === SHAPE_SLAB && existing === id && sameMaterial(x, y, z) && canCombineSlab(c.getMeta(x, y, z) & SLAB_HALF_MASK, false, c.ny, c.nx, c.nz, c.fracY)
    && (c.getMeta(x, y, z) & SLAB_HALF_MASK) !== SLAB_DOUBLE) {
    return { x, y, z, id, meta: SLAB_DOUBLE };
  }
  if (!isReplaceable(existing)) return null;
  if (shape === SHAPE_DOOR) {
    // Two blocks tall, on something solid, with room above.
    if (y < 1 || y + 1 >= CHUNK_HEIGHT || !topFaceSturdy(c.getBlock(x, y - 1, z), c.getMeta(x, y - 1, z))) return null;
    const above = c.getBlock(x, y + 1, z);
    if (above === BLOCK.UNLOADED || !isReplaceable(above)) return null;
    const facing = facingFromYaw(c.yaw);
    const hinge = doorHingeRight(c, x, y, z, facing);
    return {
      x, y, z, id, meta: doorMeta(facing, false, hinge, false),
      upper: { x, y: y + 1, z, id, meta: doorMeta(facing, true, hinge, false) },
    };
  }
  const upper = placedOnUpperHalf(c.ny, c.fracY);
  const kind = BOX_KIND[id];
  if (kind) {
    const below = c.getBlock(x, y - 1, z);
    switch (kind) {
      case BOX_CARPET:
        return !isReplaceable(below) && below !== BLOCK.UNLOADED ? { x, y, z, id, meta: 0 } : null;
      case BOX_TRAPDOOR:
        return { x, y, z, id, meta: facingFromYaw(c.yaw) | (upper ? TRAPDOOR_TOP_BIT : 0) };
      case BOX_GATE:
        return { x, y, z, id, meta: facingFromYaw(c.yaw) };
      case BOX_LADDER: {
        // Fixed to the side of a solid block that was clicked.
        if (c.ny !== 0 || !OPAQUE[c.getBlock(c.hitX, c.hitY, c.hitZ)]) return null;
        return { x, y, z, id, meta: ladderSide(c.nx, c.nz) };
      }
      case BOX_BED: {
        // Two blocks: the foot here and the head one step further the way the player looks.
        const facing = facingFromYaw(c.yaw);
        const hx = x + FACING_DX[facing], hz = z + FACING_DZ[facing];
        const headCell = c.getBlock(hx, y, hz);
        if (headCell === BLOCK.UNLOADED || !isReplaceable(headCell)) return null;
        if (!topFaceSturdy(below, c.getMeta(x, y - 1, z)) || !topFaceSturdy(c.getBlock(hx, y - 1, hz), c.getMeta(hx, y - 1, hz))) return null;
        return { x, y, z, id, meta: facing, upper: { x: hx, y, z: hz, id, meta: facing | BED_HEAD_BIT } };
      }
      default:
        return { x, y, z, id, meta: 0 };
    }
  }
  if (shape === SHAPE_SLAB) return { x, y, z, id, meta: upper ? SLAB_TOP : SLAB_BOTTOM };
  if (shape === SHAPE_STAIRS) return { x, y, z, id, meta: stairMeta(facingFromYaw(c.yaw), upper) };
  // Furnaces, chests and pumpkins show their front to the player.
  const facing = FACING[id] ? facingFromYaw(c.yaw) : 0;
  if (id === BLOCK.CHEST) return chestPlacement(c, x, y, z, facing);
  return { x, y, z, id, meta: facing };
}

/**
 * A chest next to a single chest that faces the same way joins it into a double chest: the one with the lower
 * coordinate along the row is the low half (bit 4), the other the high half (bit 8). The neighbour's state changes too.
 */
function chestPlacement(c: PlaceContext, x: number, y: number, z: number, facing: number): Placement {
  const dx = facing < 2 ? 1 : 0, dz = facing < 2 ? 0 : 1;
  const single = (nx: number, nz: number): boolean => c.getBlock(nx, y, nz) === BLOCK.CHEST && (c.getMeta(nx, y, nz) & 15) === facing;
  if (single(x + dx, z + dz)) {
    return { x, y, z, id: BLOCK.CHEST, meta: facing | 4, neighbor: { x: x + dx, y, z: z + dz, id: BLOCK.CHEST, meta: facing | 8 } };
  }
  if (single(x - dx, z - dz)) {
    return { x, y, z, id: BLOCK.CHEST, meta: facing | 8, neighbor: { x: x - dx, y, z: z - dz, id: BLOCK.CHEST, meta: facing | 4 } };
  }
  return { x, y, z, id: BLOCK.CHEST, meta: facing };
}
