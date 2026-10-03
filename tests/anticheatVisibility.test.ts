import { describe, expect, it } from 'vitest';
import { BLOCK } from '../src/world/BlockRegistry';
import { Send, VIS, type Viewer, Visibility, sightClear } from '../server/anticheat/Visibility';
import { TestWorld } from './helpers';

const viewer = (id: number, x: number, z: number, team = '', y = 64): Viewer => ({ id, team, alive: true, x, y, z, firedAt: -1e9 });

/** Floor at 63, a full-height wall along x = 0 from z = -10 to 10 (y 64..68). */
function walled() {
  const w = new TestWorld().fill(-40, 63, -40, 40, 63, 40, BLOCK.STONE).fill(0, 64, -10, 0, 68, 10, BLOCK.STONE);
  return { w, vis: new Visibility({ getBlock: w.get }) };
}

const out = { x: 0, y: 0, z: 0 };

describe('visibility (anti-wallhack culling)', () => {
  it('sight passes air, glass and slabs but not stone', () => {
    const w = new TestWorld().set(2, 64, 0, BLOCK.GLASS).set(4, 64, 0, BLOCK.STONE_SLAB);
    expect(sightClear({ getBlock: w.get }, 0.5, 64.5, 0.5, 8.5, 64.5, 0.5)).toBe(true);
    w.set(6, 64, 0, BLOCK.STONE);
    expect(sightClear({ getBlock: w.get }, 0.5, 64.5, 0.5, 8.5, 64.5, 0.5)).toBe(false);
  });

  it('hides an enemy behind a wall beyond 12 blocks and shows it in the open', () => {
    const { vis } = walled();
    const a = viewer(1, -10, 0), b = viewer(2, 10, 0);
    vis.track(a, 0); vis.track(b, 0);
    expect(vis.select(a, b, false, 0, out)).toBe(Send.None);
    const c = viewer(3, 10, 30); // the line passes the end of the wall
    vis.track(c, 0);
    expect(vis.select(a, c, false, 0, out)).toBe(Send.Fresh);
  });

  it('always sends enemies within 12 blocks, teammates, enemies that just fired, and everything to the dead', () => {
    const { vis } = walled();
    const a = viewer(1, -5, 0, 'red'), near = viewer(2, 5, 0, 'blue');
    expect(vis.select(a, near, true, 0, out)).toBe(Send.Fresh); // 10 blocks through the wall
    const far = viewer(3, 15, 0, 'blue');
    expect(vis.select(a, far, true, 0, out)).toBe(Send.None);
    const mate = viewer(4, 15, 0, 'red');
    expect(vis.select(a, mate, true, 0, out)).toBe(Send.Fresh);
    far.firedAt = 1;
    expect(vis.select(a, far, true, 1.2, out)).toBe(Send.Fresh);
    expect(vis.select(a, far, true, 1.2 + VIS.FIRE_REVEAL + VIS.STALE + 0.2, out)).toBe(Send.None);
    const dead = { ...a, alive: false };
    expect(vis.select(dead, viewer(5, 20, 0, 'blue'), true, 0, out)).toBe(Send.Fresh);
  });

  it('corner peeking: the margin shows a body that sticks out past the corner before its centre does', () => {
    // The wall's last block covers z < 11. Seen almost along the wall, the target's centre is hidden
    // but its shoulder (0.45 to the side) sticks out past the end.
    const { w, vis } = walled();
    const a = viewer(1, -20, 10.9), peek = viewer(2, 13, 10.75);
    expect(sightClear({ getBlock: w.get }, a.x, a.y + 1.62, a.z, peek.x, peek.y + 0.9, peek.z)).toBe(false);
    expect(vis.lineOfSight(a, peek)).toBe(true);
    expect(vis.lineOfSight(a, viewer(3, 13, 0))).toBe(false);
  });

  it('remembers where the recipient was in the last 0.5 s (it just stepped back behind cover)', () => {
    const { vis } = walled();
    const a = viewer(1, -10, 30); // the line to b passes the end of the wall
    const b = viewer(2, 14, 0);
    vis.track(a, 0);
    expect(vis.lineOfSight(a, b)).toBe(true);
    a.z = 0; // steps behind the wall
    vis.track(a, 0.1);
    expect(vis.lineOfSight(a, b)).toBe(true);
    for (let t = 0.2; t <= 0.8; t += 0.1) vis.track(a, t);
    expect(vis.lineOfSight(a, b)).toBe(false);
  });

  it('an enemy that leaves view goes out stale (last visible position) for 300 ms, then not at all', () => {
    const { vis } = walled();
    const a = viewer(1, -10, 0), b = viewer(2, 10, 30);
    vis.track(a, 0); vis.track(b, 0);
    expect(vis.select(a, b, false, 0, out)).toBe(Send.Fresh);
    b.z = 0; // behind the wall now
    let t = 0.1;
    let got: number = vis.select(a, b, false, t, out);
    while (got === Send.Fresh && t < 1) { t += 0.05; got = vis.select(a, b, false, t, out); }
    expect(got).toBe(Send.Stale);
    expect(out.z).toBe(30); // the last visible position, not the current one
    expect(vis.select(a, b, false, t + VIS.STALE + 0.11, out)).toBe(Send.None);
  });

  it('stays within a small ray budget per tick for 16 players at 30 Hz', () => {
    // A dense array world like the server's chunks (the TestWorld map is too slow to measure with).
    const blocks = new Uint8Array(96 * 96 * 16);
    const get = (x: number, y: number, z: number) => {
      const ix = x + 48, iz = z + 48, iy = y - 60;
      if (ix < 0 || iz < 0 || iy < 0 || ix >= 96 || iz >= 96 || iy >= 16) return 0;
      return blocks[(iy * 96 + iz) * 96 + ix];
    };
    for (let z = -10; z <= 10; z++) for (let y = 64; y <= 68; y++) blocks[((y - 60) * 96 + z + 48) * 96 + 48] = BLOCK.STONE;
    for (let k = 0; k < 40; k++) { const x = (k * 37) % 70 - 35, z = (k * 53) % 70 - 35; for (let y = 64; y <= 66; y++) blocks[((y - 60) * 96 + z + 48) * 96 + x + 48] = BLOCK.STONE; }
    const vis = new Visibility({ getBlock: get });
    const players = Array.from({ length: 16 }, (_, i) => viewer(i + 1, (i % 2 ? 1 : -1) * (14 + (i % 4)), (i - 8) * 3, i % 2 ? 'blue' : 'red'));
    const t0 = performance.now();
    let ticks = 0;
    for (let t = 0; t < 10; t += 1 / 30, ticks++) {
      for (const p of players) { p.z += Math.sin(t + p.id) * 0.2; vis.track(p, t); }
      for (const r of players) for (const p of players) if (p !== r) vis.select(r, p, true, t, out);
    }
    const perTick = (performance.now() - t0) / ticks;
    // Timing is noisy when the test files run in parallel: assert the work (rays) and a loose time bound;
    // scripts/bench-arena.ts measures the real cost.
    console.log(`visibility: ${(vis.rays / ticks).toFixed(0)} rays/tick, ${perTick.toFixed(3)} ms/tick`);
    expect(vis.rays / ticks).toBeLessThan(600);
    expect(perTick).toBeLessThan(5);
  });
});
