import { type Viewer, Visibility } from '../../server/anticheat/Visibility';
import { BLOCK } from '../../src/world/BlockRegistry';

/**
 * The visibility culling workload shared by the unit test (which counts the work: rays and block
 * lookups) and scripts/bench-visibility.ts (which times it for `npm run test:perf`): 16 players in two
 * teams on a 96 × 96 arena with a long wall and 40 pillars, all moving, at 30 Hz.
 */
export function visibilityScenario() {
  // A dense array world like the server's chunks (the TestWorld map is too slow to measure with).
  const blocks = new Uint8Array(96 * 96 * 16);
  let lookups = 0;
  const get = (x: number, y: number, z: number) => {
    lookups++;
    const ix = x + 48, iz = z + 48, iy = y - 60;
    if (ix < 0 || iz < 0 || iy < 0 || ix >= 96 || iz >= 96 || iy >= 16) return 0;
    return blocks[(iy * 96 + iz) * 96 + ix];
  };
  for (let z = -10; z <= 10; z++) for (let y = 64; y <= 68; y++) blocks[((y - 60) * 96 + z + 48) * 96 + 48] = BLOCK.STONE;
  for (let k = 0; k < 40; k++) {
    const x = (k * 37) % 70 - 35, z = (k * 53) % 70 - 35;
    for (let y = 64; y <= 66; y++) blocks[((y - 60) * 96 + z + 48) * 96 + x + 48] = BLOCK.STONE;
  }
  const vis = new Visibility({ getBlock: get });
  const players: Viewer[] = Array.from({ length: 16 }, (_, i) => ({
    id: i + 1, team: i % 2 ? 'blue' : 'red', alive: true, x: (i % 2 ? 1 : -1) * (14 + (i % 4)), y: 64, z: (i - 8) * 3, firedAt: -1e9,
  }));
  const out = { x: 0, y: 0, z: 0 };
  let t = 0;
  return {
    vis,
    /** Block lookups so far. */
    get lookups() { return lookups; },
    /** One server tick: everybody moves, then every pair is checked. */
    tick(): void {
      for (const p of players) { p.z += Math.sin(t + p.id) * 0.2; vis.track(p, t); }
      for (const r of players) for (const p of players) if (p !== r) vis.select(r, p, true, t, out);
      t += 1 / 30;
    },
  };
}
