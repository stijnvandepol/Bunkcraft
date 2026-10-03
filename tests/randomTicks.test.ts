import { afterEach, describe, expect, it } from 'vitest';
import { BLOCK } from '../src/world/BlockRegistry';
import { HAS_RANDOM_TICK, RandomTicker, SECTIONS, XorShift32 } from '../src/world/RandomTicks';
import { GrowthWorld, seeded } from './helpers/growthWorld';

const MARK = BLOCK.COBBLESTONE;

afterEach(() => { RandomTicker.unregister(MARK); RandomTicker.unregister(BLOCK.GLOWSTONE); });

/** A world that is one solid block of cobblestone (so every pick hits a handler). */
function solid(radius = 0): GrowthWorld {
  const w = new GrowthWorld(radius, 127);
  for (const b of w.blocks.values()) b.fill(MARK);
  return w;
}

describe('RandomTicker', () => {
  it('picks randomTickSpeed blocks per 16x16x16 section per tick, spread evenly', () => {
    const w = solid();
    const perSection = new Array<number>(SECTIONS).fill(0);
    const perX = new Array<number>(16).fill(0);
    const perZ = new Array<number>(16).fill(0);
    const perY = new Array<number>(16).fill(0);
    RandomTicker.register(MARK, (_c, x, y, z) => { perSection[y >> 4]++; perX[x]++; perZ[z]++; perY[y & 15]++; });
    const t = new RandomTicker(w, { rng: seeded(1), radius: 0, speed: 3 });
    const TICKS = 2000;
    for (let i = 0; i < TICKS; i++) t.tick([{ x: 8, z: 8 }]);
    // Exactly 3 per section per tick.
    for (const n of perSection) expect(n).toBe(3 * TICKS);
    // Uniform within a few percent.
    const expected = (3 * TICKS * SECTIONS) / 16;
    for (const arr of [perX, perZ, perY]) for (const n of arr) expect(Math.abs(n - expected) / expected).toBeLessThan(0.08);
    expect(t.stats.handled).toBe(3 * SECTIONS);
  });

  it('is deterministic for a seeded rng and differs between seeds', () => {
    const run = (seed: number): string => {
      const w = solid();
      const hits: number[] = [];
      RandomTicker.register(MARK, (_c, x, y, z) => { hits.push(x, y, z); });
      const t = new RandomTicker(w, { rng: seeded(seed), radius: 0 });
      for (let i = 0; i < 20; i++) t.tick([{ x: 0, z: 0 }]);
      return hits.join(',');
    };
    expect(run(7)).toBe(run(7));
    expect(run(7)).not.toBe(run(8));
    // The default generator is a xorshift: never stuck at zero.
    expect(new XorShift32(0).nextU32()).not.toBe(0);
  });

  it('honours the speed setter, including 0 and clamping', () => {
    const w = solid();
    let n = 0;
    RandomTicker.register(MARK, () => { n++; });
    const t = new RandomTicker(w, { rng: seeded(2), radius: 0 });
    t.setSpeed(0);
    t.tick([{ x: 0, z: 0 }]);
    expect(n).toBe(0);
    t.setSpeed(10);
    t.tick([{ x: 0, z: 0 }]);
    expect(n).toBe(10 * SECTIONS);
    t.setSpeed(-5);
    expect(t.speed).toBe(0);
    t.setSpeed(1e9);
    expect(t.speed).toBe(4096);
    t.setSpeed(NaN);
    expect(t.speed).toBe(3);
  });

  it('only calls handlers of blocks that have one, via the flat table', () => {
    const w = new GrowthWorld(0, 60);
    w.fill(0, 61, 0, 15, 61, 15, BLOCK.GLOWSTONE);
    let n = 0;
    RandomTicker.register(BLOCK.GLOWSTONE, () => { n++; });
    expect(HAS_RANDOM_TICK[BLOCK.GLOWSTONE]).toBe(1);
    const t = new RandomTicker(w, { rng: seeded(3), radius: 0, speed: 3 });
    for (let i = 0; i < 4000; i++) t.tick([{ x: 0, z: 0 }]);
    // One 16x16 layer in one section of 16: 3 picks x 4000 ticks / 16 = 750 expected.
    expect(n).toBeGreaterThan(600);
    expect(n).toBeLessThan(900);
    RandomTicker.unregister(BLOCK.GLOWSTONE);
    expect(HAS_RANDOM_TICK[BLOCK.GLOWSTONE]).toBe(0);
  });

  it('stops at the time budget and continues where it left off on the next tick', () => {
    const w = solid(8);
    w.step = 1; // every clock read costs 1 ms
    const seen = new Set<number>();
    RandomTicker.register(MARK, (_c, x, _y, z) => { seen.add((x >> 4) * 1000 + (z >> 4)); });
    const t = new RandomTicker(w, { rng: seeded(4), radius: 8, budgetMs: 10, speed: 3 });
    t.tick([{ x: 0, z: 0 }]);
    // 289 chunks do not fit in 10 ms: the tick was cut short...
    expect(t.stats.skipped).toBe(1);
    const first = seen.size;
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(289);
    // ...and a few more ticks reach every chunk (graceful skipping, nobody starves).
    for (let i = 0; i < 80 && seen.size < 289; i++) t.tick([{ x: 0, z: 0 }]);
    expect(seen.size).toBe(289);
  });

  it('stops at the change cap', () => {
    const w = solid(2);
    RandomTicker.register(MARK, (c, x, y, z) => { c.setBlock(x, y, z, MARK, 0); });
    const t = new RandomTicker(w, { rng: seeded(5), radius: 2, maxChanges: 50, budgetMs: 1e9 });
    const changes = t.tick([{ x: 0, z: 0 }]);
    // The cap is checked every few chunks, so it can be exceeded a little but not by the whole area (25 chunks x 24 picks).
    expect(changes).toBeGreaterThanOrEqual(50);
    expect(changes).toBeLessThan(25 * 24);
    expect(t.stats.skipped).toBe(1);
  });

  it('ticks a chunk near several players only once', () => {
    const w = solid(3);
    let n = 0;
    RandomTicker.register(MARK, () => { n++; });
    const t = new RandomTicker(w, { rng: seeded(6), radius: 1, speed: 1 });
    t.tick([{ x: 0, z: 0 }, { x: 0, z: 0 }]);
    expect(n).toBe(9 * SECTIONS);
    n = 0;
    // Two players two chunks apart: 3x3 + 3x3 minus the 3x1 overlap.
    t.tick([{ x: 0, z: 0 }, { x: 32, z: 0 }]);
    expect(n).toBe(15 * SECTIONS);
  });

  it('skips unloaded chunks and survives a throwing handler', () => {
    const w = solid(0);
    RandomTicker.register(MARK, () => { throw new Error('boom'); });
    const t = new RandomTicker(w, { rng: seeded(7), radius: 3 });
    const orig = console.error;
    console.error = () => undefined;
    try {
      expect(() => t.tick([{ x: 0, z: 0 }])).not.toThrow();
    } finally { console.error = orig; }
  });

  it('wraps a tick in begin/end so the host can batch remeshing', () => {
    const w = solid(0);
    const t = new RandomTicker(w, { rng: seeded(8), radius: 0 });
    t.tick([{ x: 0, z: 0 }]);
    expect(w.batches).toBe(1);
  });

  it('gives handlers brightness with the time of day taken off', () => {
    const w = solid(0);
    let seen = -1;
    RandomTicker.register(MARK, (c, x, y, z) => { seen = c.brightness(x, y, z); });
    w.light = () => 0xf3;
    const t = new RandomTicker(w, { rng: seeded(9), radius: 0 });
    t.tick([{ x: 0, z: 0 }]);
    expect(seen).toBe(15);
    w.dark = 11;
    t.tick([{ x: 0, z: 0 }]);
    expect(seen).toBe(4);
    w.light = () => 0xf8;
    t.tick([{ x: 0, z: 0 }]);
    expect(seen).toBe(8);
  });
});
