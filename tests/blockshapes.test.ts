import { describe, expect, it } from 'vitest';
import { ITEM, blockDrop, breakSeconds } from '../src/items/ItemRegistry';
import { RECIPES } from '../src/items/Recipes';
import { type AABB, boxIntersectsSolid, clipAxis } from '../src/player/Collision';
import { PHYSICS } from '../src/player/Physics';
import { Player } from '../src/player/Player';
import { ChunkMesher, type GeometryData } from '../src/rendering/ChunkMesher';
import { BLOCK, PARTIAL_MATERIALS, SLAB_FIRST, STAIRS_FIRST, getBlockDef } from '../src/world/BlockRegistry';
import { collisionBoxes, isValidMeta } from '../src/world/BlockShapes';
import {
  EAST, FACE_OCTANTS, NORTH, OCT_ALL, OCT_BOTTOM, OCT_TOP, SLAB_BOTTOM, SLAB_DOUBLE, SLAB_TOP, SOUTH, STAIR_INNER_LEFT, STAIR_INNER_RIGHT,
  STAIR_OUTER_LEFT, STAIR_OUTER_RIGHT, STAIR_STRAIGHT, WEST, canCombineSlab, facingFromYaw, octantBoxes, placedOnUpperHalf,
  slabOctants, stairMeta, stairOctants, stairShape,
} from '../src/world/BlockStates';
import { CHUNK_AREA, CHUNK_VOLUME, blockIndex } from '../src/world/constants';
import { type PlaceContext, resolvePlacement } from '../src/world/Placement';
import { createRayHit, raycast } from '../src/world/Raycast';
import { emptyChunk, setLocal, TestWorld } from './helpers';

/** A sparse world with block states. */
class StateWorld extends TestWorld {
  private readonly metas = new Map<string, number>();
  put(x: number, y: number, z: number, id: number, meta = 0): this {
    this.set(x, y, z, id);
    this.metas.set(`${x},${y},${z}`, meta);
    return this;
  }
  readonly meta = (x: number, y: number, z: number): number => this.metas.get(`${x},${y},${z}`) ?? 0;
}

const SLAB = SLAB_FIRST; // stone slab
const STAIRS = STAIRS_FIRST; // stone stairs

describe('stair shapes (Minecraft getStairsShape)', () => {
  // Neighbours in the order north, south, west, east; −1 = not a stair.
  const none = [-1, -1, -1, -1] as const;
  it('is straight without neighbours or with a stair of the same facing', () => {
    expect(stairShape(stairMeta(NORTH, false), ...none)).toBe(STAIR_STRAIGHT);
    expect(stairShape(stairMeta(NORTH, false), -1, -1, stairMeta(NORTH, false), stairMeta(NORTH, false))).toBe(STAIR_STRAIGHT);
  });

  it('makes an outer corner when the stair on the back side runs sideways', () => {
    // Facing north: the back (tall side) is north. A stair to the north facing west makes an outer-left corner (west is to the left).
    expect(stairShape(stairMeta(NORTH, false), stairMeta(WEST, false), -1, -1, -1)).toBe(STAIR_OUTER_LEFT);
    expect(stairShape(stairMeta(NORTH, false), stairMeta(EAST, false), -1, -1, -1)).toBe(STAIR_OUTER_RIGHT);
    // Facing east: a stair to the east facing north is on the left (ccw of east is north).
    expect(stairShape(stairMeta(EAST, false), -1, -1, -1, stairMeta(NORTH, false))).toBe(STAIR_OUTER_LEFT);
  });

  it('makes an inner corner when the stair behind us runs sideways', () => {
    expect(stairShape(stairMeta(NORTH, false), -1, stairMeta(WEST, false), -1, -1)).toBe(STAIR_INNER_LEFT);
    expect(stairShape(stairMeta(NORTH, false), -1, stairMeta(EAST, false), -1, -1)).toBe(STAIR_INNER_RIGHT);
    expect(stairShape(stairMeta(SOUTH, false), stairMeta(EAST, false), -1, -1, -1)).toBe(STAIR_INNER_LEFT);
  });

  it('ignores neighbours on the other half and opposite-axis conflicts', () => {
    expect(stairShape(stairMeta(NORTH, false), stairMeta(WEST, true), -1, -1, -1)).toBe(STAIR_STRAIGHT);
    // Same axis (north/south) never makes a corner.
    expect(stairShape(stairMeta(NORTH, false), stairMeta(SOUTH, false), -1, -1, -1)).toBe(STAIR_STRAIGHT);
  });

  it('does not corner onto a stair that already continues in line with us (canTakeShape)', () => {
    // North-facing stair, west-facing stair to the north would be an outer corner, but a north-facing stair
    // on the side it would turn towards (east) already continues the row: stays straight.
    expect(stairShape(stairMeta(NORTH, false), stairMeta(WEST, false), -1, -1, stairMeta(NORTH, false))).toBe(STAIR_STRAIGHT);
    expect(stairShape(stairMeta(NORTH, false), stairMeta(WEST, false), -1, -1, stairMeta(SOUTH, false))).toBe(STAIR_OUTER_LEFT);
  });
});

describe('octant shapes', () => {
  it('describes slabs and stairs as octant masks', () => {
    expect(slabOctants(SLAB_BOTTOM)).toBe(OCT_BOTTOM);
    expect(slabOctants(SLAB_TOP)).toBe(OCT_TOP);
    expect(slabOctants(SLAB_DOUBLE)).toBe(OCT_ALL);
    expect(FACE_OCTANTS.reduce((a, m) => a | m, 0)).toBe(OCT_ALL);
    // North-facing straight stair: bottom layer + the back half (z = 0) above.
    expect(stairOctants(stairMeta(NORTH, false), STAIR_STRAIGHT)).toBe(OCT_BOTTOM | 0x30);
    // Upside down mirrors the layers.
    expect(stairOctants(stairMeta(NORTH, true), STAIR_STRAIGHT)).toBe(OCT_TOP | 0x03);
    // Rotating a facing north corner piece (north-west) to east puts it north-east.
    expect(stairOctants(stairMeta(EAST, false), STAIR_OUTER_LEFT)).toBe(OCT_BOTTOM | (1 << (1 + 4)));
  });

  it('splits masks into few boxes that add up to the same volume', () => {
    const out: number[] = [];
    for (let mask = 1; mask < 256; mask++) {
      const n = octantBoxes(mask, out);
      expect(n).toBeLessThanOrEqual(4);
      let vol = 0;
      for (let k = 0; k < n; k++) vol += (out[k * 6 + 3] - out[k * 6]) * (out[k * 6 + 4] - out[k * 6 + 1]) * (out[k * 6 + 5] - out[k * 6 + 2]);
      let bits = 0;
      for (let b = 0; b < 8; b++) if (mask & (1 << b)) bits++;
      expect(vol).toBeCloseTo(bits / 8, 9);
    }
    expect(octantBoxes(OCT_BOTTOM, out)).toBe(1);
    expect(octantBoxes(OCT_ALL, out)).toBe(1);
  });

  it('derives the facing from the player yaw', () => {
    expect(facingFromYaw(0)).toBe(NORTH);
    expect(facingFromYaw(Math.PI)).toBe(SOUTH);
    expect(facingFromYaw(Math.PI / 2)).toBe(WEST); // forward = (-sin, -cos) = (−1, 0)
    expect(facingFromYaw(-Math.PI / 2)).toBe(EAST);
  });
});

describe('block registry', () => {
  it('has a slab and stairs for every material, with Minecraft names and the base textures', () => {
    expect(getBlockDef(SLAB)).toMatchObject({ name: 'stone_slab', displayName: 'Stone Slab', shape: 'slab' });
    expect(getBlockDef(STAIRS_FIRST + 6)).toMatchObject({ name: 'oak_stairs', displayName: 'Oak Stairs', shape: 'stairs' });
    PARTIAL_MATERIALS.forEach((m, i) => {
      expect(getBlockDef(SLAB_FIRST + i)!.textures).toEqual(getBlockDef(m.base)!.textures);
      expect(getBlockDef(STAIRS_FIRST + i)!.textures).toEqual(getBlockDef(m.base)!.textures);
    });
  });

  it('validates meta per block kind', () => {
    expect(isValidMeta(BLOCK.STONE, 0)).toBe(true);
    expect(isValidMeta(BLOCK.STONE, 1)).toBe(false);
    expect(isValidMeta(SLAB, SLAB_DOUBLE)).toBe(true);
    expect(isValidMeta(SLAB, 3)).toBe(false);
    expect(isValidMeta(STAIRS, 7)).toBe(true);
    expect(isValidMeta(STAIRS, 8)).toBe(false);
    expect(isValidMeta(STAIRS, -1)).toBe(false);
    expect(isValidMeta(STAIRS, 1.5)).toBe(false);
  });
});

describe('slab and stair placement', () => {
  const air = new StateWorld();
  const ctx = (over: Partial<PlaceContext>, world: StateWorld = air): PlaceContext => ({
    id: SLAB, hitX: 0, hitY: 63, hitZ: 0, nx: 0, ny: 1, nz: 0, fracY: 1, yaw: 0, getBlock: world.get, getMeta: world.meta, ...over,
  });
  const ground = () => new StateWorld().put(0, 63, 0, BLOCK.STONE);

  it('sits on the half of the face that was clicked', () => {
    expect(placedOnUpperHalf(1, 1)).toBe(false); // top face → bottom
    expect(placedOnUpperHalf(-1, 0)).toBe(true); // underside → top
    expect(placedOnUpperHalf(0, 0.3)).toBe(false);
    expect(placedOnUpperHalf(0, 0.7)).toBe(true);
    const w = ground();
    expect(resolvePlacement(ctx({}, w))).toEqual({ x: 0, y: 64, z: 0, id: SLAB, meta: SLAB_BOTTOM });
    const wall = new StateWorld().put(0, 64, 0, BLOCK.STONE);
    expect(resolvePlacement(ctx({ hitY: 64, nx: 1, ny: 0, fracY: 0.8 }, wall))).toEqual({ x: 1, y: 64, z: 0, id: SLAB, meta: SLAB_TOP });
    expect(resolvePlacement(ctx({ hitY: 64, nx: 1, ny: 0, fracY: 0.2 }, wall))!.meta).toBe(SLAB_BOTTOM);
  });

  it('combines two slabs of the same kind into a double slab', () => {
    const w = new StateWorld().put(0, 64, 0, SLAB, SLAB_BOTTOM);
    // Clicking the top of a bottom slab fills it.
    expect(resolvePlacement(ctx({ hitY: 64 }, w))).toEqual({ x: 0, y: 64, z: 0, id: SLAB, meta: SLAB_DOUBLE });
    // Clicking its side: only on the upper half.
    expect(resolvePlacement(ctx({ hitY: 64, nx: 1, ny: 0, fracY: 0.8 }, w))).toEqual({ x: 0, y: 64, z: 0, id: SLAB, meta: SLAB_DOUBLE });
    expect(resolvePlacement(ctx({ hitY: 64, nx: 1, ny: 0, fracY: 0.2 }, w))).toEqual({ x: 1, y: 64, z: 0, id: SLAB, meta: SLAB_BOTTOM });
    // A different slab does not combine; neither does a double one.
    expect(resolvePlacement(ctx({ id: SLAB + 1, hitY: 64 }, w))).toEqual({ x: 0, y: 65, z: 0, id: SLAB + 1, meta: SLAB_BOTTOM });
    const d = new StateWorld().put(0, 64, 0, SLAB, SLAB_DOUBLE);
    expect(resolvePlacement(ctx({ hitY: 64 }, d))!.y).toBe(65);
  });

  it('combines into the slab cell when aiming through a neighbour, and with a top slab from below', () => {
    const w = new StateWorld().put(1, 64, 0, SLAB, SLAB_TOP).put(0, 64, 0, BLOCK.STONE);
    // Click the east face of the stone: the target cell holds a single slab → double.
    expect(resolvePlacement(ctx({ hitX: 0, hitY: 64, nx: 1, ny: 0, fracY: 0.1 }, w))).toEqual({ x: 1, y: 64, z: 0, id: SLAB, meta: SLAB_DOUBLE });
    expect(canCombineSlab(SLAB_TOP, true, -1, 0, 0, 0.1)).toBe(true);
    expect(canCombineSlab(SLAB_TOP, true, 1, 0, 0, 0.9)).toBe(false);
    expect(canCombineSlab(SLAB_BOTTOM, true, 0, 1, 0, 0.9)).toBe(true);
    expect(canCombineSlab(SLAB_BOTTOM, true, 0, 1, 0, 0.1)).toBe(false);
  });

  it('puts stairs against the way the player looks, flipped on the upper half', () => {
    const w = ground();
    expect(resolvePlacement(ctx({ id: STAIRS, yaw: 0 }, w))).toEqual({ x: 0, y: 64, z: 0, id: STAIRS, meta: stairMeta(NORTH, false) });
    expect(resolvePlacement(ctx({ id: STAIRS, yaw: -Math.PI / 2 }, w))!.meta).toBe(stairMeta(EAST, false));
    const wall = new StateWorld().put(0, 64, 0, BLOCK.STONE);
    expect(resolvePlacement(ctx({ id: STAIRS, hitY: 64, nx: 1, ny: 0, fracY: 0.9, yaw: Math.PI }, wall))!.meta).toBe(stairMeta(SOUTH, true));
    expect(resolvePlacement(ctx({ id: STAIRS, hitY: 64, ny: -1, fracY: 0 }, wall))!.meta).toBe(stairMeta(NORTH, true));
  });

  it('refuses a target that is not replaceable and replaces plants and liquids', () => {
    const w = new StateWorld().put(0, 63, 0, BLOCK.STONE).put(0, 64, 0, BLOCK.STONE);
    expect(resolvePlacement(ctx({}, w))).toBeNull();
    const plants = new StateWorld().put(0, 64, 0, BLOCK.TALL_GRASS);
    expect(resolvePlacement(ctx({ id: BLOCK.STONE, hitY: 64, nx: 0, ny: 1 }, plants))).toMatchObject({ x: 0, y: 64, z: 0 });
    const water = new StateWorld().put(0, 64, 0, BLOCK.WATER);
    expect(resolvePlacement(ctx({ id: BLOCK.STONE, hitY: 63 }, water))).toMatchObject({ y: 64 });
  });
});

describe('collision with slabs and stairs', () => {
  const box = (x: number, y: number, z: number): AABB => {
    const hw = PHYSICS.WIDTH / 2;
    return { minX: x - hw, maxX: x + hw, minY: y, maxY: y + PHYSICS.HEIGHT, minZ: z - hw, maxZ: z + hw };
  };

  it('stands on a bottom slab at half height and on a top slab at full height', () => {
    const w = new StateWorld().put(0, 64, 0, SLAB, SLAB_BOTTOM).put(5, 64, 0, SLAB, SLAB_TOP);
    expect(clipAxis(box(0.5, 66, 0.5), 1, -3, w.get, w.meta)).toBeCloseTo(-1.5, 6); // lands at y = 64.5
    expect(clipAxis(box(5.5, 66, 0.5), 1, -3, w.get, w.meta)).toBeCloseTo(-1, 6); // lands at y = 65
    // Without a meta source a slab counts as a full block.
    expect(clipAxis(box(0.5, 66, 0.5), 1, -3, w.get)).toBeCloseTo(-1, 6);
  });

  it('lets a head pass under the empty half of a top slab only at the right height', () => {
    const w = new StateWorld().put(0, 65, 0, SLAB, SLAB_TOP);
    // Rising from y = 63: the slab's underside is at 65.5.
    expect(clipAxis(box(0.5, 63.5, 0.5), 1, 2, w.get, w.meta)).toBeCloseTo(65.5 - (63.5 + PHYSICS.HEIGHT), 6);
  });

  it('collides with the stair back and step as two shapes', () => {
    const w = new StateWorld().put(0, 64, 0, STAIRS, stairMeta(NORTH, false));
    const out = new Float64Array(24);
    const n = collisionBoxes(STAIRS, stairMeta(NORTH, false), w.get, w.meta, 0, 64, 0, out);
    expect(n).toBe(2);
    // Feet above the step (64.6): only the tall back (z 0..0.5, y 64.5..65) is in the way; minZ 2.2 stops at 0.5.
    expect(clipAxis(box(0.5, 64.6, 2.5), 2, -3, w.get, w.meta)).toBeCloseTo(0.5 - 2.2, 6);
    // Feet on the floor: the step (z 0.5..1 at the front) stops the box first, at minZ = 1.
    expect(clipAxis(box(0.5, 64, 2.5), 2, -3, w.get, w.meta)).toBeCloseTo(1 - 2.2, 6);
  });

  it('walks up slabs and stairs without jumping (step height 0.6)', () => {
    const w = new StateWorld().fill(-5, 63, -5, 5, 63, 5, BLOCK.STONE)
      .put(0, 64, -1, STAIRS, stairMeta(NORTH, false)).put(0, 64, -2, SLAB, SLAB_BOTTOM);
    const p = new Player();
    p.setPosition(0.5, 64, 2.5);
    p.yaw = 0;
    p.onGround = true;
    const input = { forward: 1, strafe: 0, jump: false, jumpPressed: false, sprint: false, descend: false };
    let maxY = 0;
    for (let i = 0; i < 90; i++) {
      p.step(input, w.get, w.meta);
      maxY = Math.max(maxY, p.y);
    }
    // It crossed the stair (z −1, back top at 65) and the slab (z −2), and is now back on the floor behind them.
    expect(p.z).toBeLessThan(-3);
    expect(maxY).toBeGreaterThan(64.9);
    expect(p.y).toBeCloseTo(64, 3);
  });

  it('is still blocked by a full block one high', () => {
    const w = new StateWorld().fill(-5, 63, -5, 5, 63, 5, BLOCK.STONE).put(0, 64, -1, BLOCK.STONE);
    const p = new Player();
    p.setPosition(0.5, 64, 2.5);
    p.onGround = true;
    const input = { forward: 1, strafe: 0, jump: false, jumpPressed: false, sprint: false, descend: false };
    for (let i = 0; i < 90; i++) p.step(input, w.get, w.meta);
    expect(p.z).toBeGreaterThan(0.29);
    expect(p.z).toBeLessThan(0.5);
    expect(p.y).toBeCloseTo(64, 3);
  });

  it('knows when a box overlaps a slab', () => {
    const w = new StateWorld().put(0, 64, 0, SLAB, SLAB_BOTTOM);
    expect(boxIntersectsSolid(box(0.5, 64.6, 0.5), w.get, w.meta)).toBe(false);
    expect(boxIntersectsSolid(box(0.5, 64.2, 0.5), w.get, w.meta)).toBe(true);
    expect(boxIntersectsSolid(box(0.5, 64.6, 0.5), w.get)).toBe(true);
  });
});

describe('raycast against slabs', () => {
  it('hits the top of a bottom slab at half height and passes over its empty half', () => {
    const w = new StateWorld().put(0, 64, 0, SLAB, SLAB_BOTTOM).put(0, 63, 0, BLOCK.STONE);
    const out = createRayHit();
    // Straight down onto the slab.
    raycast(w.get, 0.5, 70, 0.5, 0, -1, 0, 10, out, w.meta);
    expect(out).toMatchObject({ hit: true, x: 0, y: 64, z: 0, ny: 1, id: SLAB });
    expect(out.distance).toBeCloseTo(70 - 64.5, 6);
    // A flat ray at y = 64.7 (above the slab) goes through the cell and hits the next block.
    const w2 = new StateWorld().put(0, 64, 0, SLAB, SLAB_BOTTOM).put(3, 64, 0, BLOCK.STONE);
    raycast(w2.get, -2, 64.7, 0.5, 1, 0, 0, 10, out, w2.meta);
    expect(out).toMatchObject({ hit: true, x: 3, y: 64, nx: -1 });
    // At y = 64.3 it hits the slab's side.
    raycast(w2.get, -2, 64.3, 0.5, 1, 0, 0, 10, out, w2.meta);
    expect(out).toMatchObject({ hit: true, x: 0, nx: -1 });
  });

  it('hits a top slab from below', () => {
    const w = new StateWorld().put(0, 64, 0, SLAB, SLAB_TOP);
    const out = createRayHit();
    raycast(w.get, 0.5, 60, 0.5, 0, 1, 0, 10, out, w.meta);
    expect(out).toMatchObject({ hit: true, y: 64, ny: -1 });
    expect(out.distance).toBeCloseTo(4.5, 6);
  });
});

describe('mesher: slabs and stairs', () => {
  const mesher = new ChunkMesher();
  const biomes = () => Array.from({ length: 9 }, () => new Uint8Array(CHUNK_AREA));
  const quads = (g: GeometryData | null) => (g ? g.index.length / 6 : 0);

  function build(fill: (set: (x: number, y: number, z: number, id: number, meta?: number) => void) => void) {
    const nb = Array.from({ length: 9 }, () => emptyChunk());
    const metas: (Uint8Array | null)[] = Array(9).fill(null);
    metas[4] = new Uint8Array(CHUNK_VOLUME);
    fill((x, y, z, id, meta = 0) => {
      setLocal(nb[4], x, y, z, id);
      metas[4]![blockIndex(x, y, z)] = meta;
    });
    return mesher.mesh(nb, biomes(), true, metas);
  }

  it('meshes a bottom slab as a half-height block (6 quads, top at y + 0.5)', () => {
    const r = build((set) => set(5, 64, 5, SLAB, SLAB_BOTTOM));
    expect(quads(r.opaque)).toBe(6);
    expect(r.opaque!.minY).toBeCloseTo(64, 6);
    expect(r.opaque!.maxY).toBeCloseTo(64.5, 6);
  });

  it('meshes a top slab in the upper half and a double slab as a full block', () => {
    const top = build((set) => set(5, 64, 5, SLAB, SLAB_TOP));
    expect(top.opaque!.minY).toBeCloseTo(64.5, 6);
    expect(top.opaque!.maxY).toBeCloseTo(65, 6);
    const dbl = build((set) => set(5, 64, 5, SLAB, SLAB_DOUBLE));
    expect(quads(dbl.opaque)).toBe(6);
    expect(dbl.opaque!.maxY).toBeCloseTo(65, 6);
  });

  it('maps the texture continuously: a bottom slab shows the lower half of the side texture', () => {
    const r = build((set) => set(5, 64, 5, SLAB, SLAB_BOTTOM));
    const g = r.opaque!;
    // Side quads: the vertex v coordinate (packed / 241, in 1/16) spans 0..8.
    let maxV = 0;
    for (let v = 0; v < g.packed.length / 4; v++) {
      const f = g.data[v * 4 + 1] & 7;
      if (f === 2 || f === 3) continue;
      maxV = Math.max(maxV, Math.floor(g.packed[v * 4 + 3] / 241));
    }
    expect(maxV).toBe(8);
  });

  it('meshes a straight stair as an L profile with 10 quads, and merges nothing it should not', () => {
    const r = build((set) => set(5, 64, 5, STAIRS, stairMeta(NORTH, false)));
    expect(quads(r.opaque)).toBe(10);
    expect(r.opaque!.maxY).toBeCloseTo(65, 6);
  });

  it('hides faces between a stair and a full block, and between neighbouring double slabs', () => {
    // A stone block on top of a bottom-layer stair is not visible from below, and the stair's shared face is gone.
    const alone = build((set) => set(5, 64, 5, BLOCK.STONE));
    const pair = build((set) => { set(5, 64, 5, BLOCK.STONE); set(6, 64, 5, SLAB, SLAB_DOUBLE); });
    expect(quads(alone.opaque)).toBe(6);
    expect(quads(pair.opaque)).toBe(10); // 5 + 5: the touching faces are gone on both
    // A single bottom slab only covers the lower half of the cube's side, so the cube keeps that face (6 quads);
    // the slab's own side against the cube is hidden (5).
    const half = build((set) => { set(5, 64, 5, BLOCK.STONE); set(6, 64, 5, SLAB, SLAB_BOTTOM); });
    expect(quads(half.opaque)).toBe(6 + 5);
  });

  it('shows the neighbour face under a bottom slab only where the slab leaves it open', () => {
    // Slab on stone: the stone top is covered by the slab's bottom face (full) → hidden; slab's bottom face hidden too.
    const r = build((set) => { set(5, 63, 5, BLOCK.STONE); set(5, 64, 5, SLAB, SLAB_BOTTOM); });
    expect(quads(r.opaque)).toBe(5 + 5);
  });

  it('lights faces next to a slab from the slab cell, so nothing turns black', () => {
    const r = build((set) => { set(5, 64, 5, BLOCK.STONE); set(6, 64, 5, SLAB, SLAB_BOTTOM); });
    const g = r.opaque!;
    for (let v = 0; v < g.data.length / 4; v++) expect(g.data[v * 4 + 2]).toBeGreaterThan(100); // sky light
  });
});

describe('items: drops, mining and recipes', () => {
  it('drops the slab itself (stone slab, not cobblestone), two for a double slab', () => {
    expect(blockDrop(SLAB, ITEM.WOODEN_PICKAXE)).toEqual({ id: SLAB, count: 1 });
    expect(blockDrop(SLAB, ITEM.WOODEN_PICKAXE, SLAB_DOUBLE)).toEqual({ id: SLAB, count: 2 });
    expect(blockDrop(SLAB, 0)).toBeNull(); // stone needs a pickaxe
    expect(blockDrop(STAIRS, ITEM.WOODEN_PICKAXE)).toEqual({ id: STAIRS, count: 1 });
    expect(blockDrop(STAIRS_FIRST + 6, 0)).toEqual({ id: STAIRS_FIRST + 6, count: 1 }); // oak stairs by hand
  });

  it('mines like the full block, slabs at hardness 2', () => {
    // Stone slab: hardness 2 with a wooden pickaxe: speed 2 / 2 / 30 per tick → 30 ticks.
    expect(breakSeconds(SLAB, ITEM.WOODEN_PICKAXE, true, false)).toBeCloseTo(1.5, 5);
    expect(breakSeconds(STAIRS, ITEM.WOODEN_PICKAXE, true, false)).toBeCloseTo(breakSeconds(BLOCK.STONE, ITEM.WOODEN_PICKAXE, true, false), 5);
    expect(breakSeconds(SLAB_FIRST + 6, ITEM.WOODEN_AXE, true, false)).toBeLessThan(breakSeconds(SLAB_FIRST + 6, 0, true, false));
  });

  it('crafts 6 slabs from 3 blocks and 4 stairs from 6', () => {
    PARTIAL_MATERIALS.forEach((m, i) => {
      const slab = RECIPES.find((r) => r.result.id === SLAB_FIRST + i)!;
      expect(slab).toMatchObject({ result: { count: 6 }, station: 'table', ingredients: [{ ids: [m.base], count: 3 }] });
      const stairs = RECIPES.find((r) => r.result.id === STAIRS_FIRST + i)!;
      expect(stairs).toMatchObject({ result: { count: 4 }, station: 'table', ingredients: [{ ids: [m.base], count: 6 }] });
    });
  });
});
