import { describe, expect, it } from 'vitest';
import { type AABB, boxIntersectsSolid, clipAxis } from '../src/player/Collision';
import { PHYSICS } from '../src/player/Physics';
import { type MoveInput, Player } from '../src/player/Player';
import { BLOCK } from '../src/world/BlockRegistry';
import { createRayHit, raycast } from '../src/world/Raycast';
import { TestWorld } from './helpers';

const IDLE: MoveInput = { forward: 0, strafe: 0, jump: false, jumpPressed: false, sprint: false, descend: false };

function box(x: number, y: number, z: number): AABB {
  const hw = PHYSICS.WIDTH / 2;
  return { minX: x - hw, minY: y, minZ: z - hw, maxX: x + hw, maxY: y + PHYSICS.HEIGHT, maxZ: z + hw };
}

describe('Collision', () => {
  const world = new TestWorld().fill(-5, 63, -5, 5, 63, 5, BLOCK.STONE);

  it('clips downward movement onto the floor surface', () => {
    expect(clipAxis(box(0.5, 64.5, 0.5), 1, -2, world.get)).toBeCloseTo(-0.5, 6);
  });

  it('leaves movement through air untouched', () => {
    expect(clipAxis(box(0.5, 70, 0.5), 1, -2, world.get)).toBe(-2);
    expect(clipAxis(box(0.5, 64, 0.5), 0, 1.5, world.get)).toBe(1.5);
  });

  it('stops horizontal movement at a wall', () => {
    const walled = new TestWorld().fill(2, 64, -1, 2, 65, 1, BLOCK.STONE);
    expect(clipAxis(box(0.5, 64, 0.5), 0, 3, walled.get)).toBeCloseTo(2 - 0.5 - PHYSICS.WIDTH / 2, 6);
  });

  it('ignores blocks the box already overlaps (placing a block inside the player)', () => {
    const inside = new TestWorld().set(0, 64, 0, BLOCK.STONE);
    expect(boxIntersectsSolid(box(0.5, 64, 0.5), inside.get)).toBe(true);
    expect(clipAxis(box(0.5, 64, 0.5), 1, 0.5, inside.get)).toBe(0.5);
  });

  it('lets a player stand on a floor without falling through, even for many seconds', () => {
    const p = new Player();
    p.canFly = false;
    p.setPosition(0.5, 66, 0.5);
    for (let i = 0; i < 600; i++) p.step(IDLE, world.get);
    expect(p.onGround).toBe(true);
    expect(p.y).toBeCloseTo(64, 6);
    expect(p.vy).toBe(0);
    expect(p.landedFall).toBeCloseTo(2, 1);
  });

  it('does not tunnel through a 1-block floor at terminal velocity', () => {
    const p = new Player();
    p.canFly = false;
    p.setPosition(0.5, 120, 0.5);
    p.vy = -PHYSICS.TERMINAL_VELOCITY;
    for (let i = 0; i < 600; i++) p.step(IDLE, world.get);
    expect(p.y).toBeCloseTo(64, 6);
  });
});

describe('raycast', () => {
  const world = new TestWorld().set(0, 64, 5, BLOCK.STONE).set(3, 60, 0, BLOCK.DIRT);

  it('hits the expected block and reports the face it entered through', () => {
    const hit = raycast(world.get, 0.5, 64.5, 0.5, 0, 0, 1, 10, createRayHit());
    expect(hit).toMatchObject({ hit: true, x: 0, y: 64, z: 5, nx: 0, ny: 0, nz: -1, id: BLOCK.STONE });
    expect(hit.distance).toBeCloseTo(4.5, 6);
  });

  it('reports the top face when looking straight down', () => {
    const hit = raycast(world.get, 3.5, 63, 0.5, 0, -1, 0, 10, createRayHit());
    expect(hit).toMatchObject({ hit: true, x: 3, y: 60, z: 0, nx: 0, ny: 1, nz: 0, id: BLOCK.DIRT });
    expect(hit.distance).toBeCloseTo(2, 6);
  });

  it('misses a block beyond the maximum distance', () => {
    expect(raycast(world.get, 0.5, 64.5, 0.5, 0, 0, 1, 4, createRayHit()).hit).toBe(false);
  });

  it('passes through water and stops at unloaded chunks', () => {
    const w = new TestWorld().set(0, 64, 1, BLOCK.WATER).set(0, 64, 2, BLOCK.STONE);
    expect(raycast(w.get, 0.5, 64.5, 0.5, 0, 0, 1, 10, createRayHit())).toMatchObject({ hit: true, z: 2 });
    const unloaded = new TestWorld().set(0, 64, 1, BLOCK.UNLOADED).set(0, 64, 2, BLOCK.STONE);
    expect(raycast(unloaded.get, 0.5, 64.5, 0.5, 0, 0, 1, 10, createRayHit()).hit).toBe(false);
  });
});
