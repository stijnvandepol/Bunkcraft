import { describe, expect, it } from 'vitest';
import { BULLET, createBulletTrace, traceBullet } from '../src/modes/Hitscan';
import { BLOCK, OPAQUE } from '../src/world/BlockRegistry';
import { Send, VIS, type Viewer, Visibility, sightClear } from '../server/anticheat/Visibility';
import { TestWorld } from './helpers';
import { visibilityScenario } from './helpers/visibilityScenario';

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

  it('culling and bullets agree on see-through blocks: whatever a bullet passes (glass, panes, leaves) never hides an enemy', () => {
    let thin = 0;
    for (let id = 1; id < 255; id++) {
      if (BULLET[id] !== 2 /* THIN */) continue;
      thin++;
      expect(OPAQUE[id], `block ${id}`).toBe(0);
    }
    expect(thin).toBeGreaterThan(10); // glass, stained glass, panes, every leaves type
    const w = new TestWorld().fill(-40, 63, -40, 40, 63, 40, BLOCK.STONE).fill(0, 64, -10, 0, 66, 10, BLOCK.GLASS);
    expect(sightClear({ getBlock: w.get }, -5, 65.6, 0.5, 5, 65.6, 0.5)).toBe(true);
    const trace = traceBullet({ getBlock: w.get }, -5, 65.6, 0.5, 1, 0, 0, 10, createBulletTrace());
    expect(trace.blocked).toBe(false);
    expect(trace.thin).toBe(1);
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

  it('stays within a small work budget per tick for 16 players at 30 Hz', () => {
    // Counts the work (rays, block lookups), not milliseconds: wall-clock time is noise when the test files
    // run in parallel on a loaded machine. `npm run test:perf` (scripts/bench-visibility.ts) guards the time.
    const sc = visibilityScenario();
    const ticks = 300;
    for (let i = 0; i < ticks; i++) sc.tick();
    const rays = sc.vis.rays / ticks, lookups = sc.lookups / ticks;
    console.log(`visibility: ${rays.toFixed(0)} rays/tick, ${lookups.toFixed(0)} block lookups/tick`);
    expect(rays).toBeLessThan(600);
    // Deterministic: about 450 rays and 10 600 lookups today; the headroom is for deliberate changes, not noise.
    expect(lookups).toBeLessThan(14000);
  });
});
