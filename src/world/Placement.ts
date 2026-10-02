import { BLOCK, SHAPE, SHAPE_CROSS, SHAPE_LIQUID, SHAPE_NONE, SHAPE_SLAB, SHAPE_STAIRS } from './BlockRegistry';
import {
  SLAB_BOTTOM, SLAB_DOUBLE, SLAB_TOP, canCombineSlab, facingFromYaw, placedOnUpperHalf, stairMeta,
} from './BlockStates';

/** What the player is aiming at and holding when they press Use. */
export interface PlaceContext {
  /** Block item being placed. */
  id: number;
  /** The clicked block and the normal of the clicked face. */
  hitX: number; hitY: number; hitZ: number;
  nx: number; ny: number; nz: number;
  /** Height of the click inside the clicked block, 0..1. */
  fracY: number;
  /** Player yaw (see Player): decides which way stairs and doors face. */
  yaw: number;
  getBlock(x: number, y: number, z: number): number;
  getMeta(x: number, y: number, z: number): number;
}

export interface Placement {
  x: number; y: number; z: number;
  id: number;
  meta: number;
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
  if (shape === SHAPE_SLAB && c.getBlock(c.hitX, c.hitY, c.hitZ) === id
    && canCombineSlab(c.getMeta(c.hitX, c.hitY, c.hitZ), true, c.ny, c.nx, c.nz, c.fracY)) {
    return { x: c.hitX, y: c.hitY, z: c.hitZ, id, meta: SLAB_DOUBLE };
  }
  let x = c.hitX + c.nx, y = c.hitY + c.ny, z = c.hitZ + c.nz;
  // Placing onto grass and flowers replaces them, like in Minecraft.
  if (SHAPE[c.getBlock(c.hitX, c.hitY, c.hitZ)] === SHAPE_CROSS) { x = c.hitX; y = c.hitY; z = c.hitZ; }
  const existing = c.getBlock(x, y, z);
  if (existing === BLOCK.UNLOADED) return null;
  if (shape === SHAPE_SLAB && existing === id && canCombineSlab(c.getMeta(x, y, z), false, c.ny, c.nx, c.nz, c.fracY)
    && c.getMeta(x, y, z) !== SLAB_DOUBLE) {
    return { x, y, z, id, meta: SLAB_DOUBLE };
  }
  if (!isReplaceable(existing)) return null;
  const upper = placedOnUpperHalf(c.ny, c.fracY);
  if (shape === SHAPE_SLAB) return { x, y, z, id, meta: upper ? SLAB_TOP : SLAB_BOTTOM };
  if (shape === SHAPE_STAIRS) return { x, y, z, id, meta: stairMeta(facingFromYaw(c.yaw), upper) };
  return { x, y, z, id, meta: 0 };
}
