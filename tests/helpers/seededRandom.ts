import { afterEach, beforeEach, vi } from 'vitest';

/** Mulberry32: a small, fast, well-distributed 32-bit PRNG. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Replaces Math.random with a seeded generator for every test in the calling file (re-seeded per test), so code that
 * rolls dice (mob AI goals, wandering, drops) behaves the same on every run instead of failing once in a while.
 */
export function useSeededRandom(seed = 0x5eed): void {
  beforeEach(() => { vi.spyOn(Math, 'random').mockImplementation(mulberry32(seed)); });
  afterEach(() => { vi.restoreAllMocks(); });
}
