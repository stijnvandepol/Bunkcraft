import { BLOCK } from '../../world/BlockRegistry';
import type { LayoutBuilder } from './ArenaMap';

/** Block id 0 in a box carves air. */
export const AIR = BLOCK.AIR;

/** An opening (or window) in a wall of a building, in quadrant coordinates along the wall. */
export interface Gap {
  /** Which wall: u0/u1 are the walls at the low/high u side, v0/v1 at the low/high v side. */
  face: 'u0' | 'u1' | 'v0' | 'v1';
  /** Inclusive range along the wall. */
  from: number;
  to: number;
  /** Heights above the floor (default 1..2: a doorway). */
  h0?: number;
  h1?: number;
  /** Block in the opening (default air; use glass for windows). */
  id?: number;
}

export const door = (face: Gap['face'], from: number, to: number): Gap => ({ face, from, to });
export const glass = (face: Gap['face'], from: number, to: number, h0 = 2, h1 = 3): Gap => ({ face, from, to, h0, h1, id: BLOCK.GLASS });

/**
 * A closed building: solid walls up to height h, hollow inside, the roof is the top layer (height
 * h). A side on a centre line (u0 or v0 = 0) is open there, because the map is mirrored over it.
 */
export function building(
  b: LayoutBuilder, u0: number, u1: number, v0: number, v1: number, h: number, wall: number, gaps: Gap[] = [], roof = wall,
): void {
  b.box(u0, u1, v0, v1, 1, h, wall);
  b.box(u0 === 0 ? 0 : u0 + 1, u1 - 1, v0 === 0 ? 0 : v0 + 1, v1 - 1, 1, h - 1, AIR);
  if (roof !== wall) b.box(u0, u1, v0, v1, h, h, roof);
  for (const g of gaps) {
    const h0 = g.h0 ?? 1, h1 = g.h1 ?? 2, id = g.id ?? AIR;
    if (g.face === 'u0') b.box(u0, u0, g.from, g.to, h0, h1, id);
    else if (g.face === 'u1') b.box(u1, u1, g.from, g.to, h0, h1, id);
    else if (g.face === 'v0') b.box(g.from, g.to, v0, v0, h0, h1, id);
    else b.box(g.from, g.to, v1, v1, h0, h1, id);
  }
}

/**
 * A staircase: `steps` columns along `axis` starting at `from` and moving in `dir` (+1/-1); the
 * first column is 1 high, each next one is one higher. `a0..a1` is the width across.
 */
export function stairs(
  b: LayoutBuilder, axis: 'u' | 'v', from: number, dir: 1 | -1, steps: number, a0: number, a1: number, id: number,
): void {
  for (let i = 0; i < steps; i++) {
    const p = from + dir * i;
    if (axis === 'u') b.box(p, p, a0, a1, 1, i + 1, id);
    else b.box(a0, a1, p, p, 1, i + 1, id);
  }
}

/** A car: a wool body with a glass cabin on top. Length along u when `alongU`. */
export function car(b: LayoutBuilder, u: number, v: number, alongU: boolean, color: number): void {
  const [w, d] = alongU ? [4, 2] : [2, 4];
  b.box(u, u + w - 1, v, v + d - 1, 1, 1, color);
  if (alongU) b.box(u + 1, u + 2, v, v + d - 1, 2, 2, BLOCK.GLASS);
  else b.box(u, u + w - 1, v + 1, v + 2, 2, 2, BLOCK.GLASS);
}

/** A shipping container: 6 long, 2 wide and 2 high per layer; stacked `layers` times. */
export function container(b: LayoutBuilder, u: number, v: number, alongU: boolean, layers: number, color: number): void {
  const [w, d] = alongU ? [6, 2] : [2, 6];
  b.box(u, u + w - 1, v, v + d - 1, 1, layers * 2, color);
}

/** A spawn or spot turned 180° around the centre of a free-form map (the point symmetry of its layout). */
export const turn = ([x, z]: [number, number]): [number, number] => [-1 - x, -1 - z];

/**
 * A free-form builder that draws in the coordinates of the west half: `s = -1` turns every box
 * 180° around the centre, so a map drawn once per side with s = 1 and s = -1 is point symmetric.
 */
export function turned(b: LayoutBuilder, s: 1 | -1): LayoutBuilder {
  if (s > 0) return b;
  const t = (n: number) => -1 - n;
  return {
    box: (x0, x1, z0, z1, h0, h1, id) => b.box(t(x0), t(x1), t(z0), t(z1), h0, h1, id),
    paint: (x0, x1, z0, z1, id) => b.paint(t(x0), t(x1), t(z0), t(z1), id),
  };
}
