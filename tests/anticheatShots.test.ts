import { describe, expect, it } from 'vitest';
import type { ClientMessage, MatchInfo, ServerMessage } from '../src/net/protocol';
import { BLOCK } from '../src/world/BlockRegistry';
import { Match, type MatchHost, SPAWN_PROTECTION, WARMUP_SECONDS } from '../server/Match';
import { ORIGIN_TOLERANCE, isUnitVector, originError, viewDir } from '../server/anticheat/AimCheck';
import { MAX_REWIND, PEEK_LIMIT, bodyVisible, rewindWindow } from '../server/anticheat/LagComp';
import { AimStats, SUSPICION } from '../server/anticheat/Suspicion';
import { rng } from './helpers/clientSim';

type Fire = Extract<ClientMessage, { t: 'fire' }>;

class Host implements MatchHost {
  t = 1000;
  sent: { id: number; msg: ServerMessage }[] = [];
  blockMap = new Map<string, number>();
  blocks = { getBlock: (x: number, y: number, z: number) => this.blockMap.get(`${x},${y},${z}`) ?? BLOCK.AIR };
  pings = new Map<number, number>();
  now() { return this.t; }
  send(id: number, msg: ServerMessage) { this.sent.push({ id, msg }); }
  broadcast() { /* not needed */ }
  random() { return 0; }
  ping(id: number) { return this.pings.get(id) ?? 0; }
  moveTo() { /* not needed */ }
  hits(id: number) { return this.sent.filter((s) => s.id === id && s.msg.t === 'hit').length; }
  wall(x0: number, x1: number, z: number, y0: number, y1: number) {
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) this.blockMap.set(`${x},${y},${z}`, BLOCK.STONE);
  }
}

function duel() {
  const host = new Host();
  const info: MatchInfo = { type: 'ffa', scoreLimit: 50, timeLimitSec: 600 };
  const match = new Match(host, info);
  const advance = (sec: number) => { for (let t = 0; t < sec - 1e-9; t += 0.05) { host.t += 0.05; match.tick(); } };
  match.join(1, 'shooter'); match.join(2, 'victim');
  match.ready(1); match.ready(2);
  advance(WARMUP_SECONDS + SPAWN_PROTECTION + 0.5);
  match.setPosition(1, 0.5, 65, 0.5);
  match.setPosition(2, 0.5, 65, 10.5);
  advance(0.5);
  host.sent = [];
  return { host, match, advance };
}

const aimAt = (x: number, y: number, z: number): Fire => {
  const ox = 0.5, oy = 66.62, oz = 0.5, d = Math.hypot(x - ox, y - oy, z - oz);
  return { t: 'fire', slot: 0, ox, oy, oz, dx: (x - ox) / d, dy: (y - oy) / d, dz: (z - oz) / d, ads: true };
};

describe('lag compensation window', () => {
  it('is RTT/2 plus the interpolation delay, capped at 250 ms', () => {
    expect(rewindWindow(0)).toBeCloseTo(0.1);
    expect(rewindWindow(100)).toBeCloseTo(0.15);
    expect(rewindWindow(200)).toBeCloseTo(0.2);
    expect(rewindWindow(1000)).toBe(MAX_REWIND);
    expect(MAX_REWIND).toBe(0.25);
    expect(rewindWindow(100, 2 / 30)).toBeCloseTo(0.05 + 2 / 30);
  });

  it('body line of sight sees around a low wall but not through a full one', () => {
    const h = new Host();
    h.wall(-2, 2, 5, 65, 65); // waist-high
    expect(bodyVisible(h.blocks, 0.5, 66.62, 0.5, 0.5, 65, 10.5)).toBe(true);
    h.wall(-2, 2, 5, 66, 67);
    expect(bodyVisible(h.blocks, 0.5, 66.62, 0.5, 0.5, 65, 10.5)).toBe(false);
  });
});

describe("peeker's advantage limit: victim runs behind cover while a 200 ms shooter fires", () => {
  // Cover at z = 8 from x = 2 to 6: standing at x = 4.5 the victim is hidden from the shooter at the origin.
  const setup = () => {
    const d = duel();
    d.host.wall(2, 6, 8, 65, 67);
    d.host.pings.set(1, 200); // rewind 0.2 s
    return d;
  };

  it('without the limit the rewound victim would be hit 200 ms after reaching cover (the old behaviour)', () => {
    const { host, match, advance } = setup();
    match.setPosition(2, 4.5, 65, 10.5); // into cover
    advance(0.2);
    // The window alone would allow the hit: the rewound position (0.2 s ago) is in the open.
    expect(rewindWindow(200)).toBeGreaterThan(PEEK_LIMIT);
    match.fire(1, aimAt(0.5, 65.9, 10.5));
    expect(host.hits(1)).toBe(0);
  });

  it('a victim that reached cover only 100 ms ago is still hit (normal lag compensation)', () => {
    const { host, match, advance } = setup();
    match.setPosition(2, 4.5, 65, 10.5);
    advance(0.1);
    match.fire(1, aimAt(0.5, 65.9, 10.5));
    expect(host.hits(1)).toBe(1);
  });

  it('a visible victim is hit with the full rewind', () => {
    const { host, match, advance } = setup();
    match.setPosition(2, -3.5, 65, 10.5); // moved sideways but still in the open
    advance(0.2);
    match.fire(1, aimAt(0.5, 65.9, 10.5));
    expect(host.hits(1)).toBe(1);
  });
});

describe('shot sanity', () => {
  it('needs a unit direction', () => {
    expect(isUnitVector(0, 0, 1)).toBe(true);
    expect(isUnitVector(0.6, 0, 0.8)).toBe(true);
    expect(isUnitVector(0, 0, 5)).toBe(false);
    expect(isUnitVector(0, 0, 0)).toBe(false);
    expect(isUnitVector(NaN, 0, 1)).toBe(false);
  });

  it('accepts the origin of a moving player within 0.6 of the extrapolated eye, not 1.6 away', () => {
    // Running at 8 b/s along +x, 60 ms after the last report: the client's eye is 0.48 ahead.
    expect(originError(0.98, 66.62, 0, 0.5, 65, 0, 8, 0, 0, 0.06)).toBeLessThan(0.01);
    expect(originError(0.5 + 1.5, 66.62, 0, 0.5, 65, 0, 0, 0, 0, 0.06)).toBeGreaterThan(ORIGIN_TOLERANCE);
    expect(originError(0.5, 66.62 + 0.55, 0, 0.5, 65, 0, 0, 0, 0, 0)).toBeLessThan(ORIGIN_TOLERANCE);
  });
});

describe('aim suspicion score', () => {
  const view: [number, number, number] = [0, 0, 0];

  it('a human-like player stays low', () => {
    const r = rng(5);
    const a = new AimStats();
    let t = 0, yaw = 0, pitch = 0;
    for (let i = 0; i < 200; i++) {
      t += 0.1 + r() * 0.4;
      yaw += (r() - 0.5) * 0.4; pitch = (r() - 0.5) * 0.3;
      const d = viewDir(yaw, pitch, [0, 0, 0]);
      const hit = r() < 0.35;
      a.shot({ now: t, dx: d[0], dy: d[1], dz: d[2], view: viewDir(yaw + (r() - 0.5) * 0.05, pitch, view.slice() as [number, number, number]), targetDist: 5 + r() * 40, hit, head: hit && r() < 0.25 });
    }
    expect(a.report().score).toBeLessThan(15);
  });

  it('an aimbot (snaps between targets, headshots, fire direction differs from the camera) scores high', () => {
    const r = rng(6);
    const a = new AimStats();
    let t = 0;
    for (let i = 0; i < 60; i++) {
      t += 0.08;
      const yaw = (i % 2 === 0 ? 1 : -1) * (0.5 + r() * 0.5); // 60-115 degree jumps between shots
      const d = viewDir(yaw, 0, [0, 0, 0]);
      a.shot({ now: t, dx: d[0], dy: d[1], dz: d[2], view: viewDir(0, 0, [0, 0, 0]), targetDist: 35, hit: true, head: r() < 0.9 });
    }
    const rep = a.report();
    expect(rep.score).toBeGreaterThanOrEqual(SUSPICION.WARN_AT);
    expect(rep.snapRatio).toBeGreaterThan(0.5);
    expect(rep.headRatio).toBeGreaterThan(0.7);
  });
});
