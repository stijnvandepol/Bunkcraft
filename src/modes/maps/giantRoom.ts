import { BLOCK } from '../../world/BlockRegistry';
import type { LayoutBuilder } from './ArenaMap';
import { disc } from './giant';
import { C } from './props';

/**
 * Room dressing of the giant-house maps: the walls and the ceiling of the room and everyday things at giant size.
 * All of it is drawn into the cover cells next to the wall ring (the ring itself is not walkable for bots) or high above
 * the play space, so none of it changes where a player can walk, except the few props that are meant as cover.
 */
type B = LayoutBuilder;

/** A wall of the room: its axis ('z' = a wall along x at z = at), the ring coordinate and the direction into the room. */
export interface Wall { axis: 'x' | 'z'; at: number; dir: 1 | -1 }

/** Box on a wall: `a0..a1` along the wall, heights h0..h1, `depth` cells from the ring (1 = flush against it), `thick` deep. */
export function onWall(b: B, w: Wall, a0: number, a1: number, h0: number, h1: number, id: number, depth = 1, thick = 1): void {
  const d0 = w.at + w.dir * depth, d1 = w.at + w.dir * (depth + thick - 1);
  if (w.axis === 'z') b.box(a0, a1, d0, d1, h0, h1, id);
  else b.box(d0, d1, a0, a1, h0, h1, id);
}

/** The ceiling of a room map over `x0..x1` × `z0..z1` (the wall ring included) in `layer` (wallHeight + 1), with `lamps` = [x, z, half size] light panels. */
export function ceiling(b: B, x0: number, x1: number, z0: number, z1: number, layer: number, lamps: [number, number, number][], light: number = C.SEA_LANTERN): void {
  b.box(x0, x1, z0, z1, layer, layer, BLOCK.CEILING);
  for (const [x, z, r] of lamps) b.box(x - r, x + r, z - r, z + r, layer, layer, light);
}

/** The lamp over the middle of the room (x, z = -0.5): a 2 × 2 cord from `top` down to a shade of radius r (three stepped discs) at height h with a bulb under it. */
export function centerLamp(b: B, top: number, h: number, r: number, shade: number, bulb: number = C.SEA_LANTERN): void {
  b.box(-1, 0, -1, 0, h + 3, top, C.COAL_BLOCK);
  disc(b, -0.5, -0.5, r, h, shade, 0);
  disc(b, -0.5, -0.5, r * 0.75, h + 1, shade, 0);
  disc(b, -0.5, -0.5, r * 0.5, h + 2, shade, 0);
  disc(b, -0.5, -0.5, r * 0.6, h - 1, bulb, 0);
}

/** A window with a frame, muntins, a bright pane (light blocks) and a sill, `a0..a1` wide and h0..h1 high. */
export function windowPane(b: B, w: Wall, a0: number, a1: number, h0: number, h1: number, frame: number, pane: number = C.SEA_LANTERN): void {
  onWall(b, w, a0, a1, h0, h1, frame);
  onWall(b, w, a0 + 1, a1 - 1, h0 + 1, h1 - 1, pane);
  const mid = (a0 + a1) >> 1, midH = (h0 + h1) >> 1;
  onWall(b, w, mid, mid, h0 + 1, h1 - 1, frame);
  onWall(b, w, a0 + 1, a1 - 1, midH, midH, frame);
  onWall(b, w, a0 - 1, a1 + 1, h0 - 1, h0 - 1, frame, 1, 2); // the sill sticks out
}

/** Pleated curtains from h0 to h1: every other column one cell deeper, with a rod on top. */
export function curtain(b: B, w: Wall, a0: number, a1: number, h0: number, h1: number, cloth: number, cloth2: number = cloth): void {
  for (let a = a0; a <= a1; a++) {
    const fold = (a - a0) & 1;
    onWall(b, w, a, a, h0, h1, fold ? cloth2 : cloth, 1 + fold, 1);
  }
  onWall(b, w, a0 - 1, a1 + 1, h1 + 1, h1 + 1, C.DARK_OAK_PLANKS, 2, 1);
}

/** A framed picture or poster: frame, picture and two stripes of accent. */
export function poster(b: B, w: Wall, a0: number, a1: number, h0: number, h1: number, frame: number, fill: number, accent: number): void {
  onWall(b, w, a0, a1, h0, h1, frame);
  onWall(b, w, a0 + 1, a1 - 1, h0 + 1, h1 - 1, fill);
  onWall(b, w, a0 + 2, a1 - 2, h0 + 2, h0 + 3, accent);
  onWall(b, w, (a0 + a1) >> 1, (a0 + a1 + 1) >> 1, h1 - 4, h1 - 3, accent);
}

/** A round wall clock of radius r around (a, h). */
export function clock(b: B, w: Wall, a: number, h: number, r: number, face: number, rim: number): void {
  const R = Math.ceil(r);
  for (let da = -R; da <= R; da++) {
    for (let dh = -R; dh <= R; dh++) {
      const d = Math.hypot(da, dh);
      if (d > r) continue;
      onWall(b, w, a + da, a + da, h + dh, h + dh, d > r - 1 ? rim : face);
    }
  }
  onWall(b, w, a, a, h, h + Math.floor(r) - 1, C.COAL_BLOCK);
  onWall(b, w, a, a + Math.floor(r) - 1, h, h, C.COAL_BLOCK);
}

/** A door in a wall with a gap underneath (a strip of light from the next room), panel seams and a handle. */
export function doorway(b: B, w: Wall, a0: number, a1: number, h1: number, wood: number, frame: number, handle: number = C.IRON_BLOCK): void {
  onWall(b, w, a0 - 1, a1 + 1, 1, h1 + 1, frame);
  onWall(b, w, a0, a1, 3, h1, wood);
  onWall(b, w, a0, a1, 1, 2, C.SEA_LANTERN);
  for (let a = a0 + 2; a <= a1 - 2; a += 3) onWall(b, w, a, a, 6, h1 - 3, frame);
  onWall(b, w, a1 - 1, a1 - 1, 12, 12, handle, 1, 2);
}

/** A plug in a wall socket (at along-position a, height h) with its cable running down and along the floor `run` blocks. */
export function plugCable(b: B, w: Wall, a: number, h: number, run: number, plug: number = BLOCK.WHITE_WOOL): void {
  onWall(b, w, a, a + 1, h, h + 1, plug, 3, 1);
  onWall(b, w, a, a, 1, h - 1, C.COAL_BLOCK, 3, 1);
  onWall(b, w, a, a + run, 1, 1, C.COAL_BLOCK, 3, 1);
}

/** A coin lying on the floor: a disc of radius r, one block high, with a stamped middle. */
export function coin(b: B, x: number, z: number, r: number, metal: number = C.GOLD_BLOCK, stamp: number = C.COPPER_BLOCK): void {
  disc(b, x, z, r, 1, metal, 0);
  disc(b, x, z, r * 0.45, 2, stamp, 0);
}

/** A bottle cap: a disc with a raised iron rim. */
export function bottleCap(b: B, x: number, z: number, r: number, cap: number = BLOCK.RED_WOOL): void {
  disc(b, x, z, r, 1, cap, 1, C.IRON_BLOCK);
}

/** A pencil lying on the floor (2 × 2 section, `len` ≥ 8): pink eraser, iron ferrule, yellow body, wooden cone, dark point. */
export function pencil(b: B, x: number, z: number, len: number, alongX: boolean): void {
  const seg = (a: number, n: number, id: number) => {
    if (alongX) b.box(x + a, x + a + n - 1, z, z + 1, 1, 2, id);
    else b.box(x, x + 1, z + a, z + a + n - 1, 1, 2, id);
  };
  seg(0, 2, BLOCK.RED_WOOL);
  seg(2, 1, C.IRON_BLOCK);
  seg(3, len - 6, BLOCK.YELLOW_WOOL);
  seg(len - 3, 2, BLOCK.OAK_PLANKS);
  seg(len - 1, 1, C.COAL_BLOCK);
}

/** A toy brick (w × d, h high) with studs on top, the way a LEGO-like block lies around. */
export function toyBrick(b: B, x: number, z: number, w: number, d: number, h: number, color: number): void {
  b.box(x, x + w - 1, z, z + d - 1, 1, h, color);
  for (let i = 0; i < w; i += 2) for (let j = 0; j < d; j += 2) b.box(x + i, x + i, z + j, z + j, h + 1, h + 1, color);
}

/** A sock on the floor: two blocks wide, striped, one block high, with a heel bump. */
export function sock(b: B, x: number, z: number, len: number, a: number, c: number): void {
  for (let i = 0; i < len; i++) b.box(x + i, x + i, z, z + 1, 1, 1, ((i >> 1) & 1) ? c : a);
  b.box(x + len - 2, x + len - 1, z + 2, z + 2, 1, 1, a);
}

/** A fork lying on the floor, tines at the +x end: handle `len` long. */
export function fork(b: B, x: number, z: number, len: number, metal: number = C.IRON_BLOCK): void {
  b.box(x, x + len - 1, z + 1, z + 1, 1, 1, metal);
  b.box(x + len, x + len, z, z + 2, 1, 1, metal);
  for (const dz of [0, 2]) b.box(x + len + 1, x + len + 3, z + dz, z + dz, 1, 1, metal);
}
