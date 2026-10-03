import { describe, expect, it } from 'vitest';
import type { WorkerRequest } from '../src/workers/protocol';
import { blockDrop, itemId } from '../src/items/ItemRegistry';
import { RECIPES } from '../src/items/Recipes';
import { BLOCK, CUBE_ID, FACE_LAYER, TEXTURE_NAMES } from '../src/world/BlockRegistry';
import { collisionBoxes, isValidMeta } from '../src/world/BlockShapes';
import { WEST } from '../src/world/BlockStates';
import { resolvePlacement } from '../src/world/Placement';
import { LEVER_ON, isRedstoneBlock } from '../src/world/Redstone';
import { BOX_DUST, redstoneBoxes } from '../src/world/RedstoneShapes';
import { makeTestWorld } from './helpers';

const B = BLOCK;

describe('redstone in the World', () => {
  it('a lever → dust → lamp circuit works through World.setBlock', () => {
    const world = makeTestWorld();
    world.enableRedstone();
    for (let x = -2; x <= 10; x++) for (let z = -2; z <= 2; z++) world.setBlock(x, 69, z, B.STONE);
    for (let x = 1; x <= 5; x++) world.setBlock(x, 70, 0, B.REDSTONE_WIRE);
    world.setBlock(6, 70, 0, B.REDSTONE_LAMP);
    world.setBlock(0, 70, 0, B.LEVER, 3);
    world.tickRedstone();
    expect(world.getBlock(6, 70, 0)).toBe(B.REDSTONE_LAMP);
    world.setBlock(0, 70, 0, B.LEVER, 3 | LEVER_ON);
    world.tickRedstone();
    expect(world.getMeta(5, 70, 0) & 15).toBe(11);
    expect(world.getBlock(6, 70, 0)).toBe(B.REDSTONE_LAMP_LIT);
  });

  it('dust strength changes are remeshed in batches, not per change', () => {
    const requests: WorkerRequest[] = [];
    const world = makeTestWorld(new Map(), requests);
    world.enableRedstone();
    for (let x = 0; x <= 15; x++) world.setBlock(x, 69, 0, B.STONE);
    for (let x = 1; x <= 15; x++) world.setBlock(x, 70, 0, B.REDSTONE_WIRE);
    world.tickRedstone();
    const chunk = world.chunks.get(0, 0)!;
    const before = chunk.version;
    world.setBlock(0, 70, 0, CUBE_ID.redstone_block, 0);
    expect(chunk.version).toBe(before + 1); // the placed block itself
    world.tickRedstone(); // 15 dust blocks change strength
    let v = chunk.version;
    for (let i = 0; i < 4; i++) world.tickRedstone();
    // All 15 colour changes land in one remesh.
    expect(chunk.version - v).toBeLessThanOrEqual(1);
    expect(world.getMeta(15, 70, 0) & 15).toBe(1);
  });

  it('popped-off components and saved edits', () => {
    const world = makeTestWorld();
    const sim = world.enableRedstone();
    const broken: number[] = [];
    sim.onBreak = (_x, _y, _z, id) => broken.push(id);
    world.setBlock(0, 70, 0, B.STONE);
    world.setBlock(1, 70, 0, B.REDSTONE_TORCH, 1);
    world.breakBlock(0, 70, 0);
    world.tickRedstone();
    expect(world.getBlock(1, 70, 0)).toBe(B.AIR);
    expect(broken).toEqual([B.REDSTONE_TORCH]);
  });
});

describe('redstone content', () => {
  it('has unique ids and valid states', () => {
    for (const id of [B.REDSTONE_WIRE, B.LEVER, B.BUTTON, B.PRESSURE_PLATE, B.REPEATER, B.REDSTONE_TORCH, B.REDSTONE_LAMP, B.REDSTONE_LAMP_LIT,
      B.NOTE_BLOCK, B.PISTON, B.STICKY_PISTON, B.PISTON_HEAD]) {
      expect(isRedstoneBlock(id)).toBe(true);
    }
    expect(isValidMeta(B.REDSTONE_WIRE, 15)).toBe(true);
    expect(isValidMeta(B.REDSTONE_WIRE, 16)).toBe(false);
    expect(isValidMeta(B.REPEATER, 31)).toBe(true);
    expect(isValidMeta(B.NOTE_BLOCK, 24 | 32)).toBe(true);
    expect(TEXTURE_NAMES.length).toBeLessThanOrEqual(255);
    expect(FACE_LAYER[B.PISTON * 6 + 2]).not.toBe(FACE_LAYER[B.STICKY_PISTON * 6 + 2]);
  });

  it('dust drops redstone, a lit lamp drops a lamp, a piston head nothing', () => {
    expect(blockDrop(B.REDSTONE_WIRE, 0, 7)!.id).toBe(itemId('redstone'));
    expect(blockDrop(B.REDSTONE_LAMP_LIT, 0)!.id).toBe(B.REDSTONE_LAMP);
    expect(blockDrop(B.PISTON_HEAD, 0)).toBeNull();
    expect(blockDrop(B.REDSTONE_TORCH, 0, 9)!.id).toBe(B.REDSTONE_TORCH);
  });

  it('has the Minecraft recipes', () => {
    const made = (id: number) => RECIPES.some((r) => r.result.id === id);
    for (const id of [B.LEVER, B.REDSTONE_TORCH, B.REPEATER, B.REDSTONE_LAMP, B.NOTE_BLOCK, B.PISTON]) expect(made(id)).toBe(true);
  });

  it('places components by the clicked face and the player', () => {
    const get = (x: number, y: number) => (y === 63 ? B.STONE : x === 5 && y === 64 ? B.STONE : B.AIR);
    const base = { hitX: 0, hitY: 63, hitZ: 0, nx: 0, ny: 1, nz: 0, fracY: 1, yaw: 0, getBlock: get, getMeta: () => 0 };
    expect(resolvePlacement({ ...base, id: B.REDSTONE_WIRE })?.meta).toBe(0);
    expect(resolvePlacement({ ...base, id: B.LEVER })?.meta).toBe(3); // on the floor
    // On the west face of the block at x 5: attached towards +X.
    expect(resolvePlacement({ ...base, id: B.BUTTON, hitX: 5, hitY: 64, nx: -1, ny: 0 })?.meta).toBe(0);
    expect(resolvePlacement({ ...base, id: B.REDSTONE_TORCH, hitY: 63, ny: -1 })).toBeNull(); // not on a ceiling
    // yaw 0 looks north: a repeater sends north, a piston faces the player (south, +Z = direction 4).
    expect(resolvePlacement({ ...base, id: B.REPEATER })?.meta).toBe(0);
    expect(resolvePlacement({ ...base, id: B.PISTON })?.meta).toBe(4);
    expect(resolvePlacement({ ...base, id: B.PISTON, pitch: 1.2 })?.meta).toBe(3);
    // Dust needs a floor.
    expect(resolvePlacement({ ...base, id: B.REDSTONE_WIRE, hitX: 5, hitY: 64, nx: 0, ny: 1 })?.y).toBe(65);
    void WEST;
  });

  it('shapes: thin dust, selectable levers, solid pistons', () => {
    const out: number[] = [];
    expect(redstoneBoxes(BOX_DUST, 0, 0, out, true)).toBe(5); // a lone dot is a plus
    expect(redstoneBoxes(BOX_DUST, 0, 1 | 2, out, true)).toBe(3); // a north-south line
    const boxes = new Float64Array(64);
    const g = () => 0;
    expect(collisionBoxes(B.LEVER, 3, g, g, 0, 0, 0, boxes)).toBe(1);
    expect(collisionBoxes(B.PISTON, 0, g, g, 0, 0, 0, boxes)).toBe(1);
    expect(boxes[4]).toBe(1);
  });
});
