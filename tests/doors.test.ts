import { describe, expect, it } from 'vitest';
import { ITEM, blockDrop, breakSeconds } from '../src/items/ItemRegistry';
import { RECIPES } from '../src/items/Recipes';
import { clipAxis } from '../src/player/Collision';
import { ChunkMesher } from '../src/rendering/ChunkMesher';
import { ServerWorld } from '../server/ServerWorld';
import { BLOCK, getBlockDef } from '../src/world/BlockRegistry';
import { collisionBoxes, doorBox, doorSide, isValidMeta } from '../src/world/BlockShapes';
import {
  DOOR_OPEN_BIT, DOOR_UPPER_BIT, EAST, NORTH, SLAB_BOTTOM, SLAB_TOP, SOUTH, WEST, doorMeta, isDoorUpper, stairMeta,
} from '../src/world/BlockStates';
import { CHUNK_AREA, CHUNK_VOLUME, blockIndex } from '../src/world/constants';
import { type PlaceContext, doorHingeRight, resolvePlacement, topFaceSturdy } from '../src/world/Placement';
import { createRayHit, raycast } from '../src/world/Raycast';
import { emptyChunk, makeTestWorld, setLocal, TestWorld } from './helpers';

const DOOR = BLOCK.OAK_DOOR;

class StateWorld extends TestWorld {
  private readonly metas = new Map<string, number>();
  put(x: number, y: number, z: number, id: number, meta = 0): this {
    this.set(x, y, z, id);
    this.metas.set(`${x},${y},${z}`, meta);
    return this;
  }
  readonly meta = (x: number, y: number, z: number): number => this.metas.get(`${x},${y},${z}`) ?? 0;
}

/** Aim at the top face of the stone at (0, 63, 0), looking `yaw`, click at (fx, fz) in the block. */
function ctx(world: StateWorld, over: Partial<PlaceContext> = {}): PlaceContext {
  return {
    id: DOOR, hitX: 0, hitY: 63, hitZ: 0, nx: 0, ny: 1, nz: 0, fracY: 1, fracX: 0.5, fracZ: 0.5, yaw: 0,
    getBlock: world.get, getMeta: world.meta, ...over,
  };
}

describe('door geometry', () => {
  const box = (meta: number) => {
    const out = [0, 0, 0, 0, 0, 0];
    doorBox(meta, out);
    return out.map((v) => Math.round(v * 16));
  };

  it('puts a closed door on the side opposite its facing (Minecraft DoorBlock)', () => {
    expect(box(doorMeta(SOUTH, false, false, false))).toEqual([0, 0, 0, 16, 16, 3]);
    expect(box(doorMeta(NORTH, false, false, false))).toEqual([0, 0, 13, 16, 16, 16]);
    expect(box(doorMeta(WEST, false, false, false))).toEqual([13, 0, 0, 16, 16, 16]);
    expect(box(doorMeta(EAST, false, false, false))).toEqual([0, 0, 0, 3, 16, 16]);
  });

  it('swings an open door to the hinge side', () => {
    // Facing south: right hinge → east box (x 0..3), left hinge → west box (x 13..16).
    expect(box(doorMeta(SOUTH, false, true, true))).toEqual([0, 0, 0, 3, 16, 16]);
    expect(box(doorMeta(SOUTH, false, false, true))).toEqual([13, 0, 0, 16, 16, 16]);
    expect(box(doorMeta(NORTH, false, true, true))).toEqual([13, 0, 0, 16, 16, 16]);
    expect(box(doorMeta(WEST, false, true, true))).toEqual([0, 0, 0, 16, 16, 3]);
    expect(box(doorMeta(EAST, false, true, true))).toEqual([0, 0, 13, 16, 16, 16]);
    // The upper half has the same box as the lower half.
    expect(box(doorMeta(EAST, true, true, true))).toEqual(box(doorMeta(EAST, false, true, true)));
    expect(doorSide(doorMeta(NORTH, false, false, false))).toBe(0);
  });

  it('collides with the thin plate only: walkable beside it, blocked in front, open lets you through', () => {
    const closed = new StateWorld().put(0, 64, 0, DOOR, doorMeta(NORTH, false, false, false)); // plate at z 0.8125..1
    const open = new StateWorld().put(0, 64, 0, DOOR, doorMeta(NORTH, false, false, true)); // swings to the east side
    const player = { minX: 0.2, maxX: 0.8, minY: 64, maxY: 65.8, minZ: 2.2, maxZ: 2.8 };
    // Walking in −Z through the cell: closed plate at z 13/16..1 stops the box at maxZ… minZ = 1.
    expect(clipAxis({ ...player }, 2, -3, closed.get, closed.meta)).toBeCloseTo(1 - 2.2, 6);
    // Open: the plate is on the east edge (x 13/16..1), and the player's x range 0.2..0.8 passes it.
    expect(clipAxis({ ...player }, 2, -3, open.get, open.meta)).toBe(-3);
    const out = new Float64Array(24);
    expect(collisionBoxes(DOOR, doorMeta(NORTH, false, false, false), closed.get, closed.meta, 0, 64, 0, out)).toBe(1);
  });

  it('is only hit by a ray where its plate is', () => {
    const w = new StateWorld().put(0, 64, 0, DOOR, doorMeta(NORTH, false, false, false)).put(0, 64, -3, BLOCK.STONE);
    const out = createRayHit();
    // Flat ray along −Z at the door's height: starts south, enters at z = 1 (plate 0.8125..1).
    raycast(w.get, 0.5, 64.5, 4, 0, 0, -1, 10, out, w.meta);
    expect(out).toMatchObject({ hit: true, x: 0, y: 64, z: 0, nz: 1, id: DOOR });
    // From the north the plate's far side is hit after crossing the empty part of the cell.
    raycast(w.get, 0.5, 64.5, -2, 0, 0, 1, 10, out, w.meta);
    expect(out).toMatchObject({ hit: true, z: 0, nz: -1 });
    expect(out.distance).toBeCloseTo(2 + 0.8125, 6);
  });

  it('validates the state byte', () => {
    expect(isValidMeta(DOOR, 31)).toBe(true);
    expect(isValidMeta(DOOR, 32)).toBe(false);
    expect(getBlockDef(DOOR)).toMatchObject({ name: 'oak_door', displayName: 'Oak Door', shape: 'door' });
  });
});

describe('door placement', () => {
  const floor = () => new StateWorld().put(0, 63, 0, BLOCK.STONE);

  it('places two halves facing the player, needing something solid below and room above', () => {
    const w = floor();
    const p = resolvePlacement(ctx(w, { yaw: Math.PI }))!; // looking south
    expect(p).toMatchObject({ x: 0, y: 64, z: 0, id: DOOR });
    expect(p.meta & 3).toBe(SOUTH);
    expect(isDoorUpper(p.meta)).toBe(false);
    expect(p.upper).toMatchObject({ x: 0, y: 65, z: 0, id: DOOR });
    expect(isDoorUpper(p.upper!.meta)).toBe(true);
    expect(p.upper!.meta & ~4).toBe(p.meta);
    // Nothing solid below.
    expect(resolvePlacement(ctx(new StateWorld(), { hitY: 63 }))).toBeNull();
    // Blocked above.
    expect(resolvePlacement(ctx(floor().put(0, 65, 0, BLOCK.STONE)))).toBeNull();
    // Plants above are replaced.
    expect(resolvePlacement(ctx(floor().put(0, 65, 0, BLOCK.TALL_GRASS)))).not.toBeNull();
  });

  it('stands on top slabs and upside-down stairs, not on bottom slabs or glass', () => {
    expect(topFaceSturdy(BLOCK.STONE, 0)).toBe(true);
    expect(topFaceSturdy(48, SLAB_TOP)).toBe(true);
    expect(topFaceSturdy(48, 2)).toBe(true);
    expect(topFaceSturdy(48, SLAB_BOTTOM)).toBe(false);
    expect(topFaceSturdy(57, stairMeta(NORTH, true))).toBe(true);
    expect(topFaceSturdy(57, stairMeta(NORTH, false))).toBe(false);
    expect(topFaceSturdy(BLOCK.GLASS, 0)).toBe(false);
  });

  it('picks the hinge side from the click when nothing is around (Minecraft getHinge)', () => {
    const w = floor();
    // Looking north (j = 0, k = −1): left unless the click is on the east half... d0 > 0.5 → right.
    expect(doorHingeRight(ctx(w, { fracX: 0.2 }), 0, 64, 0, NORTH)).toBe(false);
    expect(doorHingeRight(ctx(w, { fracX: 0.8 }), 0, 64, 0, NORTH)).toBe(true);
    // Looking east (j = 1): right when the click is on the south half (d1 > 0.5).
    expect(doorHingeRight(ctx(w, { fracZ: 0.8 }), 0, 64, 0, EAST)).toBe(true);
    expect(doorHingeRight(ctx(w, { fracZ: 0.2 }), 0, 64, 0, EAST)).toBe(false);
  });

  it('hinges next to a wall, and joins a neighbouring door into a double door', () => {
    // Facing north: left (ccw) is west, right (cw) is east. A wall on the east side → right hinge.
    const wallEast = floor().put(1, 64, 0, BLOCK.STONE);
    expect(doorHingeRight(ctx(wallEast), 0, 64, 0, NORTH)).toBe(true);
    const wallWest = floor().put(-1, 64, 0, BLOCK.STONE);
    expect(doorHingeRight(ctx(wallWest), 0, 64, 0, NORTH)).toBe(false);
    // A door on the left (west): our hinge goes right so the pair opens apart.
    const door = floor().put(-1, 64, 0, DOOR, doorMeta(NORTH, false, false, false));
    expect(doorHingeRight(ctx(door), 0, 64, 0, NORTH)).toBe(true);
    const doorEast = floor().put(1, 64, 0, DOOR, doorMeta(NORTH, false, true, false));
    expect(doorHingeRight(ctx(doorEast), 0, 64, 0, NORTH)).toBe(false);
  });
});

describe('World doors', () => {
  function placeDoor(world: ReturnType<typeof makeTestWorld>, x = 2, y = 70, z = 2, facing = SOUTH): void {
    world.setBlock(x, y - 1, z, BLOCK.STONE);
    world.setBlock(x, y, z, DOOR, doorMeta(facing, false, false, false));
    world.setBlock(x, y + 1, z, DOOR, doorMeta(facing, true, false, false));
  }

  it('toggles both halves and reports the new state', () => {
    const w = makeTestWorld();
    placeDoor(w);
    expect(w.toggleDoor(2, 70, 2)).toBe(true);
    expect(w.getMeta(2, 70, 2) & DOOR_OPEN_BIT).toBe(DOOR_OPEN_BIT);
    expect(w.getMeta(2, 71, 2) & DOOR_OPEN_BIT).toBe(DOOR_OPEN_BIT);
    expect(isDoorUpper(w.getMeta(2, 71, 2))).toBe(true); // other bits survive
    // Clicking the upper half closes both again.
    expect(w.toggleDoor(2, 71, 2)).toBe(false);
    expect(w.getMeta(2, 70, 2) & DOOR_OPEN_BIT).toBe(0);
    expect(w.toggleDoor(2, 72, 2)).toBeNull();
  });

  it('syncs every half as its own edit', () => {
    const w = makeTestWorld();
    placeDoor(w);
    const seen: number[][] = [];
    w.onEdit = (...a) => seen.push(a);
    w.toggleDoor(2, 70, 2);
    // x, y, z, id, meta, previous id, previous meta
    expect(seen).toEqual([
      [2, 70, 2, DOOR, DOOR_OPEN_BIT | SOUTH, DOOR, SOUTH],
      [2, 71, 2, DOOR, DOOR_OPEN_BIT | DOOR_UPPER_BIT | SOUTH, DOOR, DOOR_UPPER_BIT | SOUTH],
    ]);
  });

  it('removes both halves when either is broken, and a door standing on a broken block', () => {
    const w = makeTestWorld();
    placeDoor(w);
    expect(w.breakBlock(2, 70, 2)).toBe(DOOR);
    expect(w.getBlock(2, 71, 2)).toBe(BLOCK.AIR);
    placeDoor(w, 4, 70, 4);
    expect(w.breakBlock(4, 71, 4)).toBe(DOOR);
    expect(w.getBlock(4, 70, 4)).toBe(BLOCK.AIR);
    placeDoor(w, 6, 70, 6);
    expect(w.breakBlock(6, 69, 6)).toBe(BLOCK.STONE);
    expect(w.getBlock(6, 70, 6)).toBe(BLOCK.AIR);
    expect(w.getBlock(6, 71, 6)).toBe(BLOCK.AIR);
  });

  it('a blast takes out a door whose half or floor was destroyed', () => {
    const w = makeTestWorld();
    placeDoor(w, 8, 70, 8);
    // Radius 1.5 around the lower half: the lower half goes, and the upper half above it with it.
    w.explode(8.5, 70.5, 8.5, 1.5);
    expect(w.getBlock(8, 70, 8)).toBe(BLOCK.AIR);
    expect(w.getBlock(8, 71, 8)).toBe(BLOCK.AIR);
    // Only the floor is hit: the door standing on it falls apart.
    placeDoor(w, 10, 70, 10);
    w.explode(10.5, 69.5, 10.5, 0.9);
    expect(w.getBlock(10, 69, 10)).toBe(BLOCK.AIR);
    expect(w.getBlock(10, 70, 10)).toBe(BLOCK.AIR);
    expect(w.getBlock(10, 71, 10)).toBe(BLOCK.AIR);
  });
});

describe('ServerWorld doors', () => {
  function server(): ServerWorld {
    const w = new ServerWorld(1, {});
    for (let i = 0; i < 12; i++) w.update([{ x: 0, z: 0 }]);
    w.setBlock(3, 100, 3, BLOCK.STONE);
    w.setBlock(3, 101, 3, DOOR, doorMeta(NORTH, false, false, false));
    w.setBlock(3, 102, 3, DOOR, doorMeta(NORTH, true, false, false));
    return w;
  }

  it('a blast on the lower half takes the upper half too', () => {
    const w = server();
    const positions: number[] = [];
    w.explode(3.5, 101.5, 3.5, 0.9, positions); // only the cell (3, 101, 3) is inside the blast
    expect(w.getBlock(3, 101, 3)).toBe(BLOCK.AIR);
    expect(w.getBlock(3, 102, 3)).toBe(BLOCK.AIR);
    expect(positions).toContain(102);
  });

  it('a blast on the upper half takes the lower half, and on the floor the whole door', () => {
    const w = server();
    w.explode(3.5, 102.5, 3.5, 0.9, []);
    expect(w.getBlock(3, 101, 3)).toBe(BLOCK.AIR);
    const w2 = server();
    w2.explode(3.5, 100.5, 3.5, 0.9, []);
    expect(w2.getBlock(3, 100, 3)).toBe(BLOCK.AIR);
    expect(w2.getBlock(3, 101, 3)).toBe(BLOCK.AIR);
    expect(w2.getBlock(3, 102, 3)).toBe(BLOCK.AIR);
  });
});

describe('mesher: doors', () => {
  const mesher = new ChunkMesher();
  const biomes = () => Array.from({ length: 9 }, () => new Uint8Array(CHUNK_AREA));

  function build(set: (put: (x: number, y: number, z: number, id: number, meta?: number) => void) => void) {
    const nb = Array.from({ length: 9 }, () => emptyChunk());
    const metas: (Uint8Array | null)[] = Array(9).fill(null);
    metas[4] = new Uint8Array(CHUNK_VOLUME);
    set((x, y, z, id, meta = 0) => {
      setLocal(nb[4], x, y, z, id);
      metas[4]![blockIndex(x, y, z)] = meta;
    });
    return mesher.mesh(nb, biomes(), true, metas);
  }

  it('meshes each half as a 3/16 thick box in the cutout geometry', () => {
    const r = build((put) => {
      put(5, 64, 5, DOOR, doorMeta(SOUTH, false, false, false));
      put(5, 65, 5, DOOR, doorMeta(SOUTH, true, false, false));
    });
    expect(r.opaque).toBeNull();
    const g = r.cutout!;
    expect(g.index.length / 6).toBe(12); // 6 faces per half
    expect(g.minY).toBeCloseTo(64, 6);
    expect(g.maxY).toBeCloseTo(66, 6);
    // Facing south, closed: the plate is at z 0..3/16 of the cell.
    let minZ = 99, maxZ = -99;
    for (let v = 0; v < g.packed.length / 4; v++) {
      minZ = Math.min(minZ, g.packed[v * 4 + 2] / 16 - 5);
      maxZ = Math.max(maxZ, g.packed[v * 4 + 2] / 16 - 5);
    }
    expect(minZ).toBeCloseTo(0, 6);
    expect(maxZ).toBeCloseTo(3 / 16, 6);
  });

  it('uses different textures for the lower and the upper half', () => {
    const r = build((put) => {
      put(5, 64, 5, DOOR, doorMeta(SOUTH, false, false, false));
      put(5, 65, 5, DOOR, doorMeta(SOUTH, true, false, false));
    });
    const g = r.cutout!;
    const lower = new Set<number>(), upper = new Set<number>();
    // Four vertices per quad: a quad touching y = 64 belongs to the lower half, one touching y = 66 to the upper.
    for (let q = 0; q < g.packed.length / 16; q++) {
      const ys = [0, 1, 2, 3].map((k) => g.packed[(q * 4 + k) * 4 + 1] / 16);
      const layer = g.data[q * 16];
      if (ys.includes(64)) lower.add(layer);
      if (ys.includes(66)) upper.add(layer);
    }
    expect(lower.size).toBe(1);
    expect(upper.size).toBe(1);
    expect([...lower][0]).not.toBe([...upper][0]);
  });

  it('keeps an open door light: faces are lit from outside, never black', () => {
    const r = build((put) => put(5, 64, 5, DOOR, doorMeta(SOUTH, false, true, true)));
    const g = r.cutout!;
    for (let v = 0; v < g.data.length / 4; v++) expect(g.data[v * 4 + 2]).toBeGreaterThan(100);
  });
});

describe('door items', () => {
  it('crafts 3 doors from 6 oak planks, drops one door, breaks like wood', () => {
    const r = RECIPES.find((x) => x.result.id === DOOR)!;
    expect(r).toMatchObject({ result: { count: 3 }, ingredients: [{ ids: [BLOCK.OAK_PLANKS], count: 6 }], station: 'table' });
    expect(blockDrop(DOOR, 0)).toEqual({ id: DOOR, count: 1 });
    expect(breakSeconds(DOOR, ITEM.WOODEN_AXE, true, false)).toBeLessThan(breakSeconds(DOOR, 0, true, false));
  });
});
