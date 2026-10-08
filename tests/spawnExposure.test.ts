import { describe, expect, it } from 'vitest';
import { traceBlocks } from '../server/Combat';
import { getMap } from '../src/modes/maps';
import { reachable } from './helpers/mapAnalysis';

/**
 * Spawn trapping: on these maps no spot the enemy can walk to on its own half has a clear line into a team
 * spawn (eye to chest or eye). scripts/qa/map-audit.ts measures every map.
 */
const SHELTERED = [
  'classic', 'suburb', 'quarter', 'dockyard', 'desert', 'atomic', 'bunker', 'villa', 'yacht', 'town', 'station',
  'plaza', 'site', 'carrier', 'shanty', 'mall', 'scrap',
] as const;
const EYE = 1.62;

/** Reachable standing spots that see into one of `team`'s spawns: on the enemy half, and in total. */
function exposure(id: (typeof SHELTERED)[number], team: 'red' | 'blue') {
  const map = getMap(id);
  const world = { getBlock: (x: number, y: number, z: number) => map.blockAt(0, x, y, z) };
  const sp = map.spawns.ffa[0];
  const spots = reachable(map, 0, Math.floor(sp.x), Math.floor(sp.z), Math.round(sp.y) - 1);
  const sees = (x: number, y: number, z: number, tx: number, ty: number, tz: number) => {
    const dx = tx - x, dy = ty - y, dz = tz - z, d = Math.hypot(dx, dy, dz);
    return traceBlocks(world, x, y, z, dx / d, dy / d, dz / d, d) >= d - 0.01;
  };
  let enemyHalf = 0, total = 0;
  for (const k of spots) {
    // keyOf: ((x + 100) * 1000 + (z + 100)) * 1000 + y, y the block stood on.
    const y = (k % 1000) + 1, z = (Math.floor(k / 1000) % 1000) - 100, x = Math.floor(k / 1e6) - 100;
    const ex = x + 0.5, ey = y + EYE, ez = z + 0.5;
    if (!map.spawns[team].some((s) => sees(ex, ey, ez, s.x, s.y + 1.2, s.z) || sees(ex, ey, ez, s.x, s.y + EYE, s.z))) continue;
    total++;
    if (team === 'red' ? x >= 0 : x < 0) enemyHalf++;
  }
  return { enemyHalf, total };
}

describe('spawn exposure', () => {
  for (const id of SHELTERED) {
    it(`${id}: no reachable spot on the enemy half sees into a team spawn`, () => {
      expect(exposure(id, 'red').enemyHalf).toBe(0);
      expect(exposure(id, 'blue').enemyHalf).toBe(0);
    });
  }

  it('yacht: the bow-side and the stern-side spawn are about equally exposed (round 2: 1360 against 914 spots)', () => {
    const red = exposure('yacht', 'red').total, blue = exposure('yacht', 'blue').total;
    expect(Math.max(red, blue) / Math.min(red, blue)).toBeLessThan(1.15);
  });
});
