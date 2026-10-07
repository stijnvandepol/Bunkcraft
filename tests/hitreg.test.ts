import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MOB_TYPES } from '../src/entities/MobTypes';
import { GLASS_PASSES_DEFAULT, PLAYER_MODEL_SCALE, createBulletTrace, setGlassPasses, rayPlayer, shotRandom, shotSpread, spreadDirection, spreadRandom, traceBullet } from '../src/modes/Hitscan';
import { HitregStats } from '../src/modes/HitregStats';
import { weaponDef } from '../src/modes/Weapons';
import { BIN_SNAP_QK, decodeBinary, encodeSnapQ } from '../src/net/binary';
import type { SnapshotEntry } from '../src/net/protocol';
import { SnapshotClock } from '../src/net/SnapshotClock';
import { BLOCK } from '../src/world/BlockRegistry';
import { type Motion, runHitregSim } from './helpers/hitregSim';
import { live, place } from './helpers/matchHost';

/**
 * Hit registration end to end: a shooter aims at random points of the *drawn* model of a moving target, through a
 * network with latency and jitter, and the real server code decides (tests/helpers/hitregSim.ts). Before the fix
 * (rewinding half the round trip, a 1.8 hitbox under a 2.0 model, arms outside it) a strafing target was missed
 * 33 % of the time at 50 ms and 76 % at 150 ms; see docs/qa/ARCADE.md.
 */
describe('hit registration: a shot along the drawn line at the drawn model counts', () => {
  const cases: [number, number, Motion][] = [
    [0, 0, 'strafe'], [50, 10, 'strafe'], [150, 30, 'strafe'], [50, 15, 'jump'], [150, 30, 'run'], [150, 30, 'still'],
  ];
  for (const [rtt, jitter, motion] of cases) {
    it(`${motion} target at ${rtt} ms ± ${jitter} ms: at most 3 % misses, no head shot lost`, () => {
      const r = runHitregSim({ rttMs: rtt, jitterMs: jitter, seconds: 12, seed: 11 + rtt, motion, distance: 20 });
      expect(r.shots.length).toBeGreaterThan(100);
      // Legs swing up to ±80° while running: the box covers most of the sweep, the feet at full stride can miss.
      const body = r.shots.filter((s) => s.part !== 'leg');
      const bodyMiss = body.filter((s) => !s.hit).length / body.length;
      expect(bodyMiss, `misses (head, torso, arms): ${(bodyMiss * 100).toFixed(1)} %`).toBeLessThanOrEqual(0.03);
      expect(r.missRate).toBeLessThanOrEqual(0.06);
      // The server tests the target within a few hundredths of a block of where it was drawn.
      expect(r.meanErr).toBeLessThan(0.06);
      expect(r.headLost).toBeLessThanOrEqual(Math.ceil(r.byPart.head.shots * 0.08));
    });
  }
});

describe('player model and hitboxes', () => {
  it('the player model is drawn at the hitbox scale', () => {
    expect(MOB_TYPES.player.scale).toBe(PLAYER_MODEL_SCALE);
    expect(MOB_TYPES.player_red.scale).toBe(PLAYER_MODEL_SCALE);
  });

  it('a crouch-style pose (lower height) shrinks the hitbox from the feet', () => {
    const at = (h: number, height: number) => rayPlayer(0, 64 + h, 0.5, 1, 0, 0, 10.5, 64, 0.5, Math.PI / 2, 0, height);
    expect(at(1.7, 1)).not.toBeNull();
    expect(at(1.7, 0.8)).toBeNull();
    expect(at(1.3, 0.8)?.part).toBe('head');
  });
});

describe('seeded spread: the tracer you see is the bullet the server tests', () => {
  it('client and server derive the same pellets from the seed and the shot index', () => {
    const s = live('ffa');
    const p1 = s.match.players.get(1)!;
    p1.spreadSeed = 0x1234567; // a real seed (the fake host deals 0 = no spread)
    place(s, 1, 0.5, 65, 0.5);
    place(s, 2, 30.5, 65, 30.5); // out of the way
    s.advance(0.3);
    s.host.clear();
    const w = weaponDef('rifle')!;
    const n = p1.shotN;
    s.match.fire(1, { t: 'fire', slot: 0, ox: 0.5, oy: 66.62, oz: 0.5, dx: 0, dy: 0, dz: 1, ads: false, seq: 7, mv: true });
    const shot = s.host.of('shot')[0];
    // The client's prediction: same seed, same index, same spread rule.
    const rand: [number, number] = [0, 0];
    const dir: [number, number, number] = [0, 0, 0];
    spreadRandom(0x1234567, n, 0, rand);
    spreadDirection(0, 0, 1, shotSpread(w, false, true, false), rand[0], rand[1], dir);
    const tr = traceBullet(s.host.blocks, 0.5, 66.62, 0.5, dir[0], dir[1], dir[2], w.maxRange, createBulletTrace());
    expect(shot.ex).toBeCloseTo(0.5 + dir[0] * tr.t, 1);
    expect(shot.ez).toBeCloseTo(0.5 + dir[2] * tr.t, 1);
    // The direction really deviates (it is not the no-spread case), and the server tells the next index.
    expect(Math.hypot(dir[0], dir[1])).toBeGreaterThan(1e-4);
    const ammo = s.host.of('ammo', 1).at(-1)!;
    expect(ammo).toMatchObject({ sn: n + 1, seq: 7 });
  });

  it('different shots and pellets get different, uniform-looking numbers', () => {
    const r: [number, number] = [0, 0];
    const seen = new Set<number>();
    let sum = 0;
    for (let n = 0; n < 200; n++) for (let k = 0; k < 5; k++) {
      spreadRandom(99, n, k, r);
      seen.add(Math.round(r[0] * 1e6));
      sum += r[0] + r[1];
    }
    expect(seen.size).toBeGreaterThan(990);
    expect(sum / 2000).toBeCloseTo(0.5, 1);
  });

  it('shotgun pellets keep a fixed pattern (same on both sides, turned and jittered by the shared seed)', () => {
    const a: [number, number] = [0, 0], b: [number, number] = [0, 0];
    for (let k = 0; k < 8; k++) {
      shotRandom(0xabcdef, 3, k, 8, a);
      shotRandom(0xabcdef, 3, k, 8, b);
      expect(a).toEqual(b);
    }
    // The first pellet stays (almost) in the cone's centre; the others sit on the inner ring (r1 ~ 0.2) or the outer (~ 0.72).
    shotRandom(0xabcdef, 3, 0, 8, a);
    expect(a[0]).toBeLessThan(0.01);
    for (let k = 1; k < 8; k++) {
      shotRandom(0xabcdef, 3, k, 8, a);
      expect(a[0] > 0.1 && a[0] < 0.4 || a[0] > 0.55 && a[0] < 0.85).toBe(true);
    }
    // A single bullet is still the plain seeded pair.
    shotRandom(99, 5, 0, 1, a); spreadRandom(99, 5, 0, b);
    expect(a).toEqual(b);
  });
});

describe('render tick: the client tells the server which moment it drew', () => {
  it('maps the drawn time back to the server tick between the snapshots', () => {
    const c = new SnapshotClock();
    // Stamps are on the smoothed snapshot clock (what the players are drawn against), not the raw arrival times.
    const st: number[] = [];
    for (let k = 100; k < 110; k++) st.push(c.stamp(10 + (k - 100) / 30 + (k % 2) * 0.004, k));
    expect(c.renderTick((st[7] + st[8]) / 2)).toBeCloseTo(107.5, 3);
    expect(c.renderTick(st[9])).toBeCloseTo(109, 3);
    expect(new SnapshotClock().renderTick(1)).toBe(-1);
  });

  it('binary version 3 snapshots carry the tick', () => {
    const players: SnapshotEntry[] = [[3, 1.5, 65, -2.25, 0.5, 0.1, 4, 0]];
    const buf = encodeSnapQ(players, 0, 64, 0, 123456);
    expect(new DataView(buf).getUint8(0)).toBe(BIN_SNAP_QK);
    const m = decodeBinary(buf) as { t: 'snap'; players: SnapshotEntry[]; k?: number };
    expect(m.k).toBe(123456);
    expect(m.players[0][1]).toBeCloseTo(1.5, 2);
  });

  it('the server rewinds to the claimed tick, but never further than the round trip allows', () => {
    const s = live('ffa');
    s.host.clear();
    const now = s.host.t;
    const k = s.match.tickNo;
    expect(s.match.tickTime(k - 2, now)).toBeCloseTo(now - 0.1, 6); // ticks are 0.05 s apart in the test host
    expect(s.match.tickTime(k - 1.5, now)).toBeCloseTo(now - 0.075, 6);
    expect(Number.isNaN(s.match.tickTime(k - 200, now))).toBe(true);
    expect(Number.isNaN(s.match.tickTime(k + 3, now))).toBe(true);
  });
});

describe('bullets through windows (switch on)', () => {
  beforeAll(() => setGlassPasses(true));
  afterAll(() => setGlassPasses(GLASS_PASSES_DEFAULT));

  it('passes one window (a two-cell window counts once), stops at a second one and in a wall of glass', () => {
    const glass = new Set(['3,0,0', '4,0,0']);
    const world = { getBlock: (x: number, y: number, z: number) => (glass.has(`${x},${y},${z}`) ? BLOCK.GLASS : BLOCK.AIR) };
    const tr = traceBullet(world, 0.5, 0.5, 0.5, 1, 0, 0, 20, createBulletTrace());
    expect(tr.blocked).toBe(false);
    expect(tr.thin).toBe(2);
    expect(tr.keep).toBeCloseTo(0.8, 6);
    glass.add('8,0,0');
    const two = traceBullet(world, 0.5, 0.5, 0.5, 1, 0, 0, 20, createBulletTrace());
    expect(two.blocked).toBe(true);
    expect(two.x).toBe(8);
    const wall = new Set(['3,0,0', '4,0,0', '5,0,0', '6,0,0', '7,0,0']);
    const thick = traceBullet({ getBlock: (x, y, z) => (wall.has(`${x},${y},${z}`) ? BLOCK.GLASS : BLOCK.AIR) }, 0.5, 0.5, 0.5, 1, 0, 0, 20, createBulletTrace());
    expect(thick.blocked).toBe(true);
    expect(thick.x).toBe(7);
  });

  it('stone, slabs where the slab is, fences and iron bars (posts and rails) still stop bullets', () => {
    const one = (id: number, y = 0.5) => traceBullet({ getBlock: (x, yy) => (x === 3 && yy === 0 ? id : BLOCK.AIR) }, 0.5, y, 0.5, 1, 0, 0, 20, createBulletTrace());
    expect(one(BLOCK.STONE).blocked).toBe(true);
    expect(one(BLOCK.STONE_SLAB, 0.25).blocked).toBe(true);
    expect(one(BLOCK.STONE_SLAB, 0.75).blocked).toBe(false);
    expect(one(BLOCK.FENCE, 0.5).blocked).toBe(true); // the post
    expect(one(BLOCK.OAK_LEAVES).blocked).toBe(false);
    expect(one(BLOCK.GLASS_PANE).blocked).toBe(false);
    expect(one(BLOCK.IRON_BARS).blocked).toBe(true); // the centre post
  });
});

describe('client hit registration statistics', () => {
  it('settles shots after the server answered and counts denied on-screen hits', () => {
    const h = new HitregStats();
    h.fired(0, 1, 5, false); h.acked(0, 1.05); h.confirmed(0, false);
    h.fired(1, 1.1, 5, true); h.acked(1, 1.15); h.confirmed(1, true);
    h.fired(2, 1.2, 5, false); h.acked(2, 1.25);
    h.fired(3, 1.3, -1, false); h.acked(3, 1.35); h.confirmed(3, false);
    h.update(1.4);
    expect(h.counts.shots).toBe(2);
    h.update(2);
    expect(h.counts).toMatchObject({ shots: 4, claimed: 3, agreed: 2, denied: 1, surprise: 1, headClaimed: 1, headAgreed: 1 });
    expect(h.denyRate).toBeCloseTo(1 / 3, 6);
  });
});

describe('bullets and glass by default', () => {
  it('glass stops bullets while the maps still use it as spawn cover (GLASS_PASSES_DEFAULT)', () => {
    const tr = traceBullet({ getBlock: (x) => (x === 3 ? BLOCK.GLASS : BLOCK.AIR) }, 0.5, 0.5, 0.5, 1, 0, 0, 20, createBulletTrace());
    expect(tr.blocked).toBe(!GLASS_PASSES_DEFAULT);
  });
});
