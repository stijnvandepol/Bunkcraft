import type { LayoutBuilder } from './ArenaMap';
import { AIR } from './helpers';
import { C } from './props';

/**
 * Props for the "you are a rat in a normal house" maps (pantry, couch, workshop): the furniture is the level. Every
 * helper draws with plain solid blocks in the coordinates of the builder it is given (pass the one from `turned`).
 * Heights are cell heights: a cell at height h is a block whose top is h blocks above the floor, so a player can step
 * from a column of height h onto one of h + 1 by jumping (a run of columns that grows by one each is a ramp).
 */
type B = LayoutBuilder;

/**
 * A ramp of stacked books (or boxes, cords, planks): columns of height base..top, each `run` long, starting at `from`
 * and going in `dir` along `axis`, `a0..a1` wide across. The top column is the last one; put the ledge right behind it.
 */
export function ramp(b: B, axis: 'x' | 'z', from: number, dir: 1 | -1, a0: number, a1: number, top: number, ids: number[], run = 2, base = 1): void {
  for (let i = 0; base + i <= top; i++) {
    const p0 = from + dir * i * run, p1 = p0 + dir * (run - 1);
    const id = ids[i % ids.length];
    if (axis === 'x') b.box(p0, p1, a0, a1, 1, base + i, id);
    else b.box(a0, a1, p0, p1, 1, base + i, id);
  }
}

/** A table, desk or bench: a top one block thick at height h on four legs (`leg` × `leg`), free space underneath. */
export function table(b: B, x0: number, x1: number, z0: number, z1: number, h: number, top: number, legId: number, leg = 3): void {
  b.box(x0, x1, z0, z1, h, h, top);
  for (const x of [x0, x1 - leg + 1]) for (const z of [z0, z1 - leg + 1]) b.box(x, x + leg - 1, z, z + leg - 1, 1, h - 1, legId);
}

/** A round plate / rug / cushion: a disc of radius r around (cx, cz) at height h, with a raised rim when rim > 0. */
export function disc(b: B, cx: number, cz: number, r: number, h: number, id: number, rim = 0, rimId = id): void {
  const R = Math.ceil(r);
  for (let x = cx - R; x <= cx + R; x++) {
    for (let z = cz - R; z <= cz + R; z++) {
      const d = Math.hypot(x - cx, z - cz);
      if (d > r) continue;
      b.box(x, x, z, z, h, h, id);
      if (rim > 0 && d > r - 1.1) b.box(x, x, z, z, h + 1, h + rim, rimId);
    }
  }
}

/** A chair: a 3 × 3 seat at height 3 on four 1 × 1 legs, with the back on side `back` ('n' | 's' | 'e' | 'w'). */
export function chair(b: B, x: number, z: number, back: 'n' | 's' | 'e' | 'w', wood: number): void {
  b.box(x, x + 2, z, z + 2, 3, 3, wood);
  for (const cx of [x, x + 2]) for (const cz of [z, z + 2]) b.box(cx, cx, cz, cz, 1, 2, wood);
  if (back === 'n') b.box(x, x + 2, z, z, 4, 6, wood);
  else if (back === 's') b.box(x, x + 2, z + 2, z + 2, 4, 6, wood);
  else if (back === 'w') b.box(x, x, z, z + 2, 4, 6, wood);
  else b.box(x + 2, x + 2, z, z + 2, 4, 6, wood);
}

/** A tin can standing on the floor: 2 × 2 and `h` high with a lid. */
export function can(b: B, x: number, z: number, h: number, body: number, lid: number = C.IRON_BLOCK): void {
  b.box(x, x + 1, z, z + 1, 1, h - 1, body);
  b.box(x, x + 1, z, z + 1, h, h, lid);
}

/** A checkerboard floor of `size` × `size` tiles. */
export function checker(b: B, x0: number, x1: number, z0: number, z1: number, size: number, a: number, c: number): void {
  for (let x = x0; x <= x1; x++) {
    for (let z = z0; z <= z1; z++) {
      const odd = (Math.floor((x - x0) / size) + Math.floor((z - z0) / size)) & 1;
      b.paint(x, x, z, z, odd ? c : a);
    }
  }
}

/**
 * A wall socket on a long wall (the wall ring is at `wall`, `dir` points into the room): a 4 × 4 plate from height h0
 * with two dark slots cut into it. `at` is the first cell along the wall.
 */
export function socket(b: B, axis: 'x' | 'z', wall: number, dir: 1 | -1, at: number, h0: number, plate: number = C.CALCITE): void {
  const back = wall + dir, front = wall + dir * 2;
  const put = (a0: number, a1: number, h: number, h1: number, id: number, depth: number) => {
    if (axis === 'z') b.box(a0, a1, depth, depth, h, h1, id);
    else b.box(depth, depth, a0, a1, h, h1, id);
  };
  put(at, at + 3, h0, h0 + 3, plate, back);
  put(at, at + 3, h0, h0 + 3, plate, front);
  for (const a of [at + 1, at + 2]) {
    put(a, a, h0 + 1, h0 + 2, C.COAL_BLOCK, back);
    put(a, a, h0 + 1, h0 + 2, AIR, front);
  }
}
