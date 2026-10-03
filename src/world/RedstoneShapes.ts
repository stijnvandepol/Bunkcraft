/**
 * Geometry of the redstone components, in the same box format as BoxShapes (block units 0..1). Pure and free of the
 * block registry, so BoxShapes can use it for the mesher, collision and the ray cast.
 *
 * Box kinds 12-19 follow the ones in BoxShapes (1-11).
 *
 * State byte layouts (see docs/CONTENT.md, "Redstone"). Directions `d` use the face order everywhere:
 * 0 +X, 1 −X, 2 +Y, 3 −Y, 4 +Z, 5 −Z.
 *  - dust: bits 0-3 signal strength; the connections are derived from the neighbours (like fences);
 *  - lever: bits 0-2 the direction of the block it is attached to, bit 3 on;
 *  - button: bits 0-2 attached direction, bit 3 pressed, bit 4 oak (variant);
 *  - pressure plate: bit 0 pressed, bit 1 oak (variant);
 *  - repeater: bits 0-1 facing (the way the signal travels: north, south, west, east), bits 2-3 delay − 1, bit 4 powered;
 *  - redstone torch: bits 0-2 attached direction, bit 3 burnt out / unlit;
 *  - note block: bits 0-4 pitch, bit 5 powered;
 *  - piston: bits 0-2 facing, bit 3 extended; piston head: bits 0-2 facing, bit 3 sticky.
 */

export const BOX_DUST = 12;
export const BOX_LEVER = 13;
export const BOX_BUTTON = 14;
export const BOX_PLATE = 15;
export const BOX_REPEATER = 16;
export const BOX_RTORCH = 17;
export const BOX_PISTON = 18;
export const BOX_PISTON_HEAD = 19;

/** Face order direction vectors. */
export const DIR_X = [1, -1, 0, 0, 0, 0] as const;
export const DIR_Y = [0, 0, 1, -1, 0, 0] as const;
export const DIR_Z = [0, 0, 0, 0, 1, -1] as const;
export const DOWN = 3;
export const UP = 2;

/** Horizontal facing (north −Z, south +Z, west −X, east +X as in BlockStates) → direction index. */
export const FACING_DIR = [5, 4, 1, 0] as const;

/** Dust connection mask: bits 0-3 north, south, west, east (same as SIDE_BIT), bits 4-7 the same sides going up a wall. */
export const DUST_SIDE_BIT = [1, 2, 4, 8] as const;
export const DUST_UP_SHIFT = 4;

const P = 1 / 16;

function put(out: Float64Array | number[], n: number, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number {
  const o = n * 6;
  out[o] = x0; out[o + 1] = y0; out[o + 2] = z0; out[o + 3] = x1; out[o + 4] = y1; out[o + 5] = z1;
  return n + 1;
}

/**
 * A box in the frame of a part that sits against the block in direction `d`: `w` is the depth from that block's
 * surface, (u, v) run along it; all in 1/16 block.
 */
function local(out: Float64Array | number[], n: number, d: number, u0: number, v0: number, w0: number, u1: number, v1: number, w1: number): number {
  switch (d) {
    case 0: return put(out, n, (16 - w1) * P, v0 * P, u0 * P, (16 - w0) * P, v1 * P, u1 * P);
    case 1: return put(out, n, w0 * P, v0 * P, u0 * P, w1 * P, v1 * P, u1 * P);
    case 4: return put(out, n, u0 * P, v0 * P, (16 - w1) * P, u1 * P, v1 * P, (16 - w0) * P);
    case 5: return put(out, n, u0 * P, v0 * P, w0 * P, u1 * P, v1 * P, w1 * P);
    case 2: return put(out, n, u0 * P, (16 - w1) * P, v0 * P, u1 * P, (16 - w0) * P, v1 * P);
    default: return put(out, n, u0 * P, w0 * P, v0 * P, u1 * P, w1 * P, v1 * P);
  }
}

/** The arms a dust block draws: a lone dot is a plus, a single connection becomes a line through the block. */
export function dustArms(connect: number): number {
  const sides = connect & 15;
  if (sides === 0) return 15;
  if ((sides & (sides - 1)) === 0) {
    // One side: the opposite side too (north ↔ south, west ↔ east).
    return sides | (sides === 1 ? 2 : sides === 2 ? 1 : sides === 4 ? 8 : 4);
  }
  return sides;
}

function dustBoxes(connect: number, out: Float64Array | number[]): number {
  const arms = dustArms(connect);
  const lone = (connect & 15) === 0;
  const h = P;
  let n = put(out, 0, 5 * P, 0, 5 * P, 11 * P, h, 11 * P);
  for (let s = 0; s < 4; s++) {
    if (!(arms & DUST_SIDE_BIT[s])) continue;
    // A plain plus ends 3/16 short of the edge; an arm that connects reaches it.
    const reach = lone ? 2 * P : 0;
    switch (s) {
      case 0: n = put(out, n, 6 * P, 0, reach, 10 * P, h, 5 * P); break;
      case 1: n = put(out, n, 6 * P, 0, 11 * P, 10 * P, h, 1 - reach); break;
      case 2: n = put(out, n, reach, 0, 6 * P, 5 * P, h, 10 * P); break;
      default: n = put(out, n, 11 * P, 0, 6 * P, 1 - reach, h, 10 * P); break;
    }
    if (connect & (DUST_SIDE_BIT[s] << DUST_UP_SHIFT)) {
      // The dust climbs the wall of the block next to it: a strip along that side of the cell.
      switch (s) {
        case 0: n = put(out, n, 6 * P, 0, 0, 10 * P, 1, h); break;
        case 1: n = put(out, n, 6 * P, 0, 1 - h, 10 * P, 1, 1); break;
        case 2: n = put(out, n, 0, 0, 6 * P, h, 1, 10 * P); break;
        default: n = put(out, n, 1 - h, 0, 6 * P, 1, 1, 10 * P); break;
      }
    }
  }
  return n;
}

function repeaterBoxes(meta: number, out: Float64Array | number[], visual: boolean): number {
  let n = put(out, 0, 0, 0, 0, 1, 2 * P, 1);
  if (!visual) return n;
  const facing = meta & 3;
  const delay = (meta >> 2) & 3;
  // s runs from the input edge to the output edge (1/16 block); u across.
  const torch = (s0: number): void => {
    const s1 = s0 + 2;
    switch (facing) {
      case 0: n = put(out, n, 7 * P, 2 * P, (16 - s1) * P, 9 * P, 7 * P, (16 - s0) * P); break;
      case 1: n = put(out, n, 7 * P, 2 * P, s0 * P, 9 * P, 7 * P, s1 * P); break;
      case 2: n = put(out, n, (16 - s1) * P, 2 * P, 7 * P, (16 - s0) * P, 7 * P, 9 * P); break;
      default: n = put(out, n, s0 * P, 2 * P, 7 * P, s1 * P, 7 * P, 9 * P); break;
    }
  };
  torch(11);
  torch(2 + 2 * delay);
  return n;
}

/**
 * Boxes of a redstone component. `visual` boxes are what the mesher draws; the other set is for the ray cast and
 * collision (selection boxes are a little more generous, and non-solid blocks never collide anyway).
 */
export function redstoneBoxes(kind: number, meta: number, connect: number, out: Float64Array | number[], visual: boolean): number {
  switch (kind) {
    case BOX_DUST:
      return visual ? dustBoxes(connect, out) : put(out, 0, 0, 0, 0, 1, 2 * P, 1);
    case BOX_LEVER: {
      const d = meta & 7;
      let n = local(out, 0, d, 5, 4, 0, 11, 12, 3);
      if (!visual) return n;
      n = (meta & 8) ? local(out, n, d, 7, 8, 3, 9, 14, 5) : local(out, n, d, 7, 2, 3, 9, 8, 5);
      return n;
    }
    case BOX_BUTTON: return local(out, 0, meta & 7, 5, 6, 0, 11, 10, (meta & 8) ? 1 : 2);
    case BOX_PLATE: return put(out, 0, P, 0, P, 15 * P, (meta & 1) ? 0.5 * P : P, 15 * P);
    case BOX_REPEATER: return repeaterBoxes(meta, out, visual);
    case BOX_RTORCH: {
      const d = meta & 7;
      return d === DOWN || d > 5 ? put(out, 0, 7 * P, 0, 7 * P, 9 * P, 10 * P, 9 * P) : local(out, 0, d, 7, 3, 1, 9, 13, 3);
    }
    case BOX_PISTON: return put(out, 0, 0, 0, 0, 1, 1, 1);
    case BOX_PISTON_HEAD: {
      const d = meta & 7;
      const plus = (d & 1) === 0;
      // Plate on the far side (the side the head faces), shaft back towards the piston.
      const a0 = plus ? 12 : 0, a1 = plus ? 16 : 4;
      const s0 = plus ? 0 : 4, s1 = plus ? 12 : 16;
      const axis = d >> 1;
      let n: number;
      if (axis === 0) {
        n = put(out, 0, a0 * P, 0, 0, a1 * P, 1, 1);
        if (visual) n = put(out, n, s0 * P, 6 * P, 6 * P, s1 * P, 10 * P, 10 * P);
      } else if (axis === 1) {
        n = put(out, 0, 0, a0 * P, 0, 1, a1 * P, 1);
        if (visual) n = put(out, n, 6 * P, s0 * P, 6 * P, 10 * P, s1 * P, 10 * P);
      } else {
        n = put(out, 0, 0, 0, a0 * P, 1, 1, a1 * P);
        if (visual) n = put(out, n, 6 * P, 6 * P, s0 * P, 10 * P, 10 * P, s1 * P);
      }
      return n;
    }
    default:
      return 0;
  }
}

/**
 * Which texture slot of the block (0 side, 2 top, 3 bottom, 4 extra: the `FACE_LAYER` index within the block's six)
 * a face of a box uses. Faces normally use their own slot; parts of components pick another one.
 */
export function redstoneFaceSlot(kind: number, meta: number, box: number, face: number): number {
  switch (kind) {
    case BOX_LEVER: return box === 0 ? 0 : 4;
    case BOX_REPEATER:
      if (box > 0) return 4;
      return face === 2 ? ((meta & 16) ? 3 : 2) : face === 3 ? 3 : 0;
    case BOX_RTORCH: return (meta & 8) ? 4 : 0;
    case BOX_PISTON: {
      const d = meta & 7;
      if (face === d) return (meta & 8) ? 4 : 2;
      if (face === (d ^ 1)) return 3;
      return 0;
    }
    case BOX_PISTON_HEAD: {
      const d = meta & 7;
      if (box > 0) return 4;
      return face === d ? 2 : 0;
    }
    default: return face === 2 ? 2 : face === 3 ? 3 : 0;
  }
}
