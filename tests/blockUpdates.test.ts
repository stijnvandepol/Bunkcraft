import { describe, expect, it } from 'vitest';
import { BLOCK, CUBE_ID } from '../src/world/BlockRegistry';
import { BlockUpdates, FALL_MAX_AGE, MAX_FALLING, fallsThrough } from '../src/world/BlockUpdates';
import { GrowthWorld } from './helpers/growthWorld';

const B = BLOCK;
const FLOOR = 60;

function setup(): { w: GrowthWorld; u: BlockUpdates; dropped: number[]; broken: number[] } {
  const w = new GrowthWorld(2, FLOOR);
  const u = new BlockUpdates(w);
  w.updates = u;
  const dropped: number[] = [], broken: number[] = [];
  u.onDropped = (id) => dropped.push(id);
  u.onBroken = (_x, _y, _z, id) => broken.push(id);
  return { w, u, dropped, broken };
}

function run(u: BlockUpdates, ticks: number): void {
  for (let i = 0; i < ticks; i++) u.tick();
}

describe('falling blocks', () => {
  it('sand placed in the air falls after two ticks and lands on the ground as a block', () => {
    const { w, u } = setup();
    w.setState(3, 80, 3, B.SAND, 0);
    u.tick();
    expect(u.falling.length).toBe(0);
    u.tick();
    expect(u.falling.length).toBe(1);
    expect(w.getBlock(3, 80, 3)).toBe(B.AIR);
    run(u, 200);
    expect(u.falling.length).toBe(0);
    expect(w.getBlock(3, FLOOR + 1, 3)).toBe(B.SAND);
    expect(u.stats.landed).toBe(1);
  });

  it('accelerates like Minecraft: 0.04 per tick squared with 2% drag', () => {
    const { w, u } = setup();
    w.setState(0, 120, 0, B.GRAVEL, 0);
    run(u, 2);
    const f = u.falling[0];
    const ys = [f.y];
    for (let i = 0; i < 10; i++) { u.tick(); ys.push(f.y); }
    // It already moved once in the tick it spawned: after n = 11 ticks the drop is close to 0.02 n(n+1) (a little less: drag).
    expect(120 - ys[10]).toBeGreaterThan(0.02 * 11 * 12 * 0.9);
    expect(120 - ys[10]).toBeLessThanOrEqual(0.02 * 11 * 12 + 1e-9);
  });

  it('a supported block stays, and so does sand on sand', () => {
    const { w, u } = setup();
    w.setState(0, FLOOR + 1, 0, B.SAND, 0);
    w.setState(0, FLOOR + 2, 0, B.SAND, 0);
    run(u, 10);
    expect(u.stats.spawned).toBe(0);
  });

  it('a whole column collapses when its support is mined, one block after the other (no recursion)', () => {
    const { w, u } = setup();
    w.fill(5, FLOOR + 1, 5, 5, FLOOR + 1, 5, B.STONE);
    w.fill(5, FLOOR + 2, 5, 5, FLOOR + 40, 5, B.SAND); // a 39-high sand pillar on one stone block
    w.setState(5, FLOOR + 1, 5, B.AIR, 0);
    run(u, 600);
    expect(u.falling.length).toBe(0);
    expect(u.stats.landed).toBe(39);
    for (let y = FLOOR + 1; y <= FLOOR + 39; y++) expect(w.getBlock(5, y, 5)).toBe(B.SAND);
    expect(w.getBlock(5, FLOOR + 40, 5)).toBe(B.AIR);
  });

  it('falls through water, flowers and torches; the plant breaks and drops', () => {
    const { w, u, broken } = setup();
    w.set(1, FLOOR + 1, 1, B.TORCH);
    w.set(1, FLOOR + 2, 1, B.WATER);
    w.setState(1, FLOOR + 6, 1, B.SAND, 0);
    run(u, 100);
    expect(w.getBlock(1, FLOOR + 1, 1)).toBe(B.SAND);
    expect(broken).toEqual([B.TORCH]);
    expect(fallsThrough(B.WATER)).toBe(true);
    expect(fallsThrough(B.STONE)).toBe(false);
  });

  it('becomes an item when its landing cell is taken', () => {
    const { w, u, dropped } = setup();
    // A falling block whose own cell was filled meanwhile (a player built into it): it cannot land there.
    w.set(2, FLOOR + 1, 2, B.STONE);
    const f = u.spawnFalling(B.SAND, 0, 2.5, FLOOR + 1, 2.5);
    u.tick();
    expect(f.removed).toBe(true);
    expect(dropped).toEqual([B.SAND]);
    expect(w.getBlock(2, FLOOR + 1, 2)).toBe(B.STONE);
  });

  it('drops as an item if it never lands', () => {
    const { w, u, dropped } = setup();
    w.setState(0, 100, 0, B.SAND, 0);
    run(u, 3);
    const f = u.falling[0];
    // Keep it in the air: reset its position every tick until it is too old.
    for (let i = 0; i < FALL_MAX_AGE + 5 && !f.removed; i++) { f.y = 100; f.vy = 0; u.tick(); }
    expect(f.removed).toBe(true);
    expect(dropped).toEqual([B.SAND]);
  });

  it('caps the number of falling blocks; the rest waits and falls when there is room', () => {
    const { w, u } = setup();
    // A floating sheet of sand: 30 x 30 = 900 blocks, far more than the cap.
    for (let z = -15; z < 15; z++) for (let x = -15; x < 15; x++) w.setState(x, 100, z, B.SAND, 0);
    let max = 0;
    for (let i = 0; i < 2000 && (u.falling.length > 0 || u.pendingCount > 0); i++) {
      u.tick();
      max = Math.max(max, u.falling.length);
    }
    expect(max).toBeLessThanOrEqual(MAX_FALLING);
    expect(u.stats.landed).toBe(900);
    expect(w.count(B.SAND)).toBe(900);
  });

  it('red sand falls too; other blocks do not', () => {
    const { w, u } = setup();
    w.setState(0, 90, 0, CUBE_ID.red_sand, 0);
    w.setState(4, 90, 4, B.DIRT, 0);
    run(u, 100);
    expect(w.getBlock(0, FLOOR + 1, 0)).toBe(CUBE_ID.red_sand);
    expect(w.getBlock(4, 90, 4)).toBe(B.DIRT);
  });

  it('freezes while its column is not loaded', () => {
    const w = new GrowthWorld(0, FLOOR);
    const u = new BlockUpdates(w);
    const f = u.spawnFalling(B.SAND, 0, 40, 90, 40); // outside the only loaded chunk
    run(u, 50);
    expect(f.y).toBe(90);
    expect(f.removed).toBe(false);
  });
});

describe('supported plants', () => {
  it('a sapling on mined ground pops and drops', () => {
    const { w, u, broken } = setup();
    w.set(0, FLOOR, 0, B.GRASS);
    w.set(0, FLOOR + 1, 0, B.SAPLING, 2);
    w.setState(0, FLOOR, 0, B.AIR, 0);
    run(u, 5);
    expect(w.getBlock(0, FLOOR + 1, 0)).toBe(B.AIR);
    expect(broken).toEqual([B.SAPLING]);
  });
});
