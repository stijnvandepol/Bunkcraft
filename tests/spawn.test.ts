import { describe, expect, it } from 'vitest';
import { BLOCK } from '../src/world/BlockRegistry';
import { SPAWN_RADIUS, findStandingSpot, spreadSpawn } from '../src/world/Spawn';

describe('spreadSpawn (multiplayer newcomers)', () => {
  const spawn = { x: 0.5, y: 65, z: 0.5 };
  const dry = () => true;

  it('puts two players on different spots within the spawn radius', () => {
    const a = spreadSpawn(spawn, 'Alice', dry), b = spreadSpawn(spawn, 'Bob', dry);
    expect(a).not.toEqual(b);
    for (const p of [a, b]) {
      const d = Math.hypot(p.x - spawn.x, p.z - spawn.z);
      expect(d).toBeGreaterThanOrEqual(1);
      expect(d).toBeLessThanOrEqual(SPAWN_RADIUS + 1);
      expect(p.y).toBe(65);
      expect(p.x - Math.floor(p.x)).toBe(0.5); // block centre
      expect(p.z - Math.floor(p.z)).toBe(0.5);
    }
  });

  it('is stable per name (case-insensitive) and spreads many names apart', () => {
    expect(spreadSpawn(spawn, 'Alice', dry)).toEqual(spreadSpawn(spawn, 'alice', dry));
    const spots = new Set(Array.from({ length: 20 }, (_, i) => { const p = spreadSpawn(spawn, `p${i}`, dry); return `${p.x},${p.z}`; }));
    expect(spots.size).toBeGreaterThanOrEqual(18);
  });

  it('skips wet candidates and falls back to the world spawn when none is dry', () => {
    const p = spreadSpawn(spawn, 'Alice', (x) => x >= 0);
    expect(p.x).toBeGreaterThanOrEqual(0);
    expect(spreadSpawn(spawn, 'Alice', () => false)).toBe(spawn);
  });
});

describe('findStandingSpot', () => {
  /** A small test world: grass at y 64 everywhere, plus the blocks in `extra`. */
  const world = (extra: Record<string, number>) => (x: number, y: number, z: number): number => {
    const k = `${x},${y},${z}`;
    if (k in extra) return extra[k];
    if (y < 64) return BLOCK.DIRT;
    return y === 64 ? BLOCK.GRASS : BLOCK.AIR;
  };

  it('stands on the ground of the column itself, ignoring a plant on top', () => {
    expect(findStandingSpot(world({ '3,65,3': BLOCK.TALL_GRASS }), 3, 3)).toEqual({ x: 3, y: 65, z: 3 });
  });

  it('moves off a tree canopy to the nearest ground column', () => {
    // A 3x3 canopy at y 72 over (2..4, 2..4) on a trunk: the target column (3, 3) is the trunk top.
    const extra: Record<string, number> = {};
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) extra[`${3 + dx},72,${3 + dz}`] = BLOCK.OAK_LEAVES;
    for (let y = 65; y <= 71; y++) extra[`3,${y},3`] = BLOCK.OAK_LOG;
    const spot = findStandingSpot(world(extra), 3, 3)!;
    expect(spot.y).toBe(65);
    expect(Math.max(Math.abs(spot.x - 3), Math.abs(spot.z - 3))).toBe(2);
    expect(spot.x === 3 || spot.z === 3).toBe(true); // straight out, the nearest column of the ring
  });

  it('avoids water and lava', () => {
    const extra: Record<string, number> = { '0,64,0': BLOCK.WATER, '1,64,0': BLOCK.LAVA, '-1,64,0': BLOCK.WATER, '0,64,1': BLOCK.WATER, '0,64,-1': BLOCK.WATER };
    const spot = findStandingSpot(world(extra), 0, 0)!;
    expect(spot.y).toBe(65);
    expect(extra[`${spot.x},64,${spot.z}`]).toBeUndefined();
  });

  it('returns null when nothing nearby is ground', () => {
    expect(findStandingSpot(() => BLOCK.OAK_LEAVES, 0, 0, 2)).toBeNull();
    expect(findStandingSpot(() => BLOCK.AIR, 0, 0, 2)).toBeNull();
  });
});
