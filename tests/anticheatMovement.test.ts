import { describe, expect, it } from 'vitest';
import { ARCADE_AIR_ACCEL, ARCADE_SPEED_MULT, arcadeMaxSpeed } from '../src/modes/ArcadeLogic';
import { ARENA_FLOOR_Y, MAP_IDS, getMap } from '../src/modes/maps';
import { WEAPONS } from '../src/modes/Weapons';
import { PHYSICS } from '../src/player/Physics';
import { EAST, NORTH, SLAB_BOTTOM, stairMeta } from '../src/world/BlockStates';
import { BLOCK } from '../src/world/BlockRegistry';
import { JUMP_APEX, MOVE, MovementValidator, type Verdict } from '../server/anticheat/Movement';
import { type Report, recordClient, rng, throughNetwork } from './helpers/clientSim';
import { TestWorld } from './helpers';

const SPEED = arcadeMaxSpeed(1);

/** A stone floor (top at y = 64) and a validator for a player standing on it. */
function flat(extra?: (w: TestWorld) => void, speed = SPEED) {
  const w = new TestWorld().fill(-30, 63, -30, 30, 63, 30, BLOCK.STONE);
  extra?.(w);
  const v = new MovementValidator({ getBlock: w.get }, { maxSpeed: speed });
  v.reset(0.5, 64, 0.5, 0);
  return { w, v };
}

const rule = (r: Verdict) => (r.ok ? 'ok' : r.rule);

describe('movement validator: rules', () => {
  it('accepts walking at the speed limit with 50 ms packets for ten seconds', () => {
    const { v } = flat();
    let x = 0.5;
    for (let i = 1; i <= 200; i++) {
      x += SPEED * 0.05;
      if (x > 28) x = -28; // keep it in the floor; resets the position, not the speed
      if (x === -28) v.reset(-28, 64, 0.5, i * 0.05);
      else expect(v.check(x, 64, 0.5, i * 0.05).ok).toBe(true);
    }
  });

  it('rejects a speed burst of twice the limit and corrects within a second', () => {
    const { v } = flat();
    let x = 0.5, firstBad = -1;
    for (let i = 1; i <= 100 && firstBad < 0; i++) {
      x += SPEED * 2 * 0.05;
      if (!v.check(x, 64, 0.5, i * 0.05).ok) firstBad = i * 0.05;
    }
    expect(firstBad).toBeGreaterThan(0);
    expect(firstBad).toBeLessThan(1);
  });

  it('a held-back batch of packets released in a burst cannot exceed the budget', () => {
    const { v } = flat();
    // 2 s of legal walking (40 packets) held back and delivered within 10 ms.
    const verdicts: Verdict[] = [];
    for (let i = 1; i <= 40; i++) verdicts.push(v.check(0.5 + SPEED * 0.05 * i, 64, 0.5, 2 + i * 0.00025));
    const firstBad = verdicts.findIndex((r) => !r.ok);
    expect(firstBad).toBeGreaterThan(0);
    // The accepted part is no more than the bucket (0.5 s of movement plus 0.75 blocks) allows.
    expect(v.x - 0.5).toBeLessThanOrEqual(SPEED * MOVE.SPEED_ALLOWANCE * (MOVE.BURST_SECONDS + 0.01) + MOVE.BURST_BLOCKS + 0.1);
  });

  it('forgives a violation inside a lag spike (weight 0) but not a clean speed hack', () => {
    const { v } = flat();
    v.check(0.5, 64, 0.5, 0.05);
    // 1.2 s of silence, then the backlog arrives in one burst.
    let lagWeight = -1;
    for (let i = 1; i <= 24; i++) {
      const r = v.check(0.5 + SPEED * 0.05 * i, 64, 0.5, 1.25 + i * 0.001);
      if (!r.ok) { lagWeight = r.weight; break; }
    }
    expect(lagWeight).toBe(0);
    const { v: v2 } = flat();
    let x = 0.5, last: Verdict = { ok: true };
    for (let i = 1; i <= 30; i++) { x += 1.5; last = v2.check(x, 64, 0.5, i * 0.05); if (!last.ok) break; }
    expect(last.ok).toBe(false);
    expect((last as { weight: number }).weight).toBeGreaterThan(0);
  });

  it('rejects a teleport', () => {
    const { v } = flat();
    expect(rule(v.check(0.5, 64, 25.5, 0.05))).toBe('teleport');
  });

  it('rejects a position inside a block (noclip)', () => {
    const { v } = flat((w) => w.fill(2, 64, -3, 2, 66, 3, BLOCK.STONE));
    expect(rule(v.check(2.5, 64, 0.5, 0.05))).toBe('noclip');
  });

  it('rejects tunnelling through a thin wall in one packet', () => {
    const { v } = flat((w) => w.fill(2, 64, -3, 2, 66, 3, BLOCK.STONE));
    // 0.8 s since the last report: the budget allows 4 blocks, but the wall is in the way.
    expect(rule(v.check(3.8, 64, 0.5, 0.8))).toBe('wall');
    // The same distance around the wall (no wall at z = 5) is fine.
    expect(v.check(0.5, 64, 4.5, 0.85).ok).toBe(true);
  });

  it('rejects tunnelling through the floor', () => {
    const { v } = flat();
    expect(rule(v.check(0.5, 60, 0.5, 0.2))).not.toBe('ok');
  });

  it('lets a player slide along a wall and walk around its corner', () => {
    const { v } = flat((w) => w.fill(3, 64, -1, 3, 66, 5, BLOCK.STONE));
    // Along the wall with 0.1 gap, then around the end at z = 6 and back at x = 3.7: all with 50 ms packets.
    let t = 0;
    const walk = (x: number, z: number, y = 64) => { t += 0.05; return v.check(x, y, z, t); };
    for (let z = 0.5; z <= 5.5; z += 0.3) expect(walk(2.69, z).ok).toBe(true);
    for (let k = 0; k < 18; k++) expect(walk(2.69 + 0.1 * k, 6.5).ok).toBe(true);
    for (let z = 6.5; z >= 4; z -= 0.3) expect(walk(4.51, z).ok).toBe(true);
  });

  it('accepts a normal jump sampled every 50 ms and a bunny hop sequence', () => {
    const { v } = flat();
    let t = 0;
    for (let hop = 0; hop < 12; hop++) {
      const t0 = t;
      // Samples of the 60 Hz integration of one hop; the landing is missed half of the time.
      for (let k = 1; k <= 11; k++) {
        t += 0.0533;
        const tau = t - t0;
        const y = 64 + Math.max(0, PHYSICS.JUMP_VELOCITY * tau - 0.5 * PHYSICS.GRAVITY * tau * tau - 0.1 * tau);
        const r = v.check(0.5 + t * 2, y, 0.5, t);
        if (hop === 0 && k === 1) continue;
        expect(r.ok, `hop ${hop} sample ${k}: ${rule(r)}`).toBe(true);
      }
      t = t0 + 0.6;
    }
  });

  it('rejects hovering above the jump apex time', () => {
    const { v } = flat();
    let t = 0, bad = '';
    // Rise to 1 block in 0.1 s, then stay there.
    for (let i = 1; i <= 40 && !bad; i++) {
      t += 0.05;
      const r = v.check(0.5, 64 + Math.min(1, i * 0.5), 0.5, t);
      if (!r.ok) bad = r.rule;
    }
    expect(bad).toBe('fly');
    expect(t).toBeLessThan(0.1 + 0.2 + 0.6 + 0.35); // caught around the time the jump would be over
  });

  it('rejects gliding down slowly and climbing in the air', () => {
    const glide = flat((w) => w.fill(-30, 70, -30, 30, 70, 30, BLOCK.AIR));
    glide.v.reset(0.5, 70, 0.5, 0);
    let t = 0, bad = '';
    for (let i = 1; i <= 80 && !bad; i++) { t += 0.05; const r = glide.v.check(0.5, 70 - i * 0.05 * 1, 0.5, t); if (!r.ok) bad = r.rule; }
    // Walking off a ledge is fine for a moment; a glide of 1 block per second is not.
    expect(bad).toBe('fly');
    const climb = flat();
    t = 0; bad = '';
    for (let i = 1; i <= 40 && !bad; i++) { t += 0.05; const r = climb.v.check(0.5, 64 + i * 0.3, 0.5, t); if (!r.ok) bad = r.rule; }
    expect(['fly', 'rise']).toContain(bad);
  });

  it('allows free fall and rejects falling faster than terminal velocity', () => {
    const w = new TestWorld().fill(-30, 20, -30, 30, 20, 30, BLOCK.STONE);
    const v = new MovementValidator({ getBlock: w.get }, { maxSpeed: SPEED });
    v.reset(0.5, 90, 0.5, 0);
    let t = 0, vy = 0, y = 90;
    for (let i = 0; i < 100 && y > 21; i++) {
      t += 0.05; vy = Math.max(vy - PHYSICS.GRAVITY * 0.05, -PHYSICS.TERMINAL_VELOCITY); y = Math.max(21, y + vy * 0.05);
      expect(v.check(0.5, y, 0.5, t).ok).toBe(true);
    }
    const v2 = new MovementValidator({ getBlock: w.get }, { maxSpeed: SPEED });
    v2.reset(0.5, 90, 0.5, 0);
    expect(rule(v2.check(0.5, 40, 0.5, 0.05))).toBe('fall');
  });

  it('steps up 0.5 but not 1.5 blocks in one report', () => {
    const { v } = flat((w) => w.fill(5, 64, -2, 5, 65, 2, BLOCK.STONE));
    const slabWorld = new TestWorld().fill(-30, 63, -30, 30, 63, 30, BLOCK.STONE).set(1, 64, 0, BLOCK.STONE_SLAB);
    const meta = (x: number, y: number, z: number) => (x === 1 && y === 64 && z === 0 ? SLAB_BOTTOM : 0);
    const vs = new MovementValidator({ getBlock: slabWorld.get, getMeta: meta }, { maxSpeed: SPEED });
    vs.reset(0.5, 64, 0.5, 0);
    expect(vs.check(1.5, 64.5, 0.5, 0.05).ok).toBe(true);
    // A full block 1 high: not a step.
    expect(v.check(4.5, 64, 0.5, 0.5).ok).toBe(true);
    expect(rule(v.check(5.5, 65.2, 0.5, 0.55))).not.toBe('ok');
  });

  it('allows climbing a ladder and swimming; a ladder far away does not help', () => {
    const w = new TestWorld().fill(-30, 63, -30, 30, 63, 30, BLOCK.STONE).fill(3, 64, 0, 3, 75, 0, BLOCK.STONE);
    for (let y = 64; y <= 74; y++) w.set(2, y, 0, BLOCK.LADDER);
    const v = new MovementValidator({ getBlock: w.get }, { maxSpeed: SPEED });
    v.reset(2.5, 64, 0.5, 0);
    for (let i = 1; i <= 40; i++) expect(v.check(2.5, 64 + i * 3.5 * 0.05, 0.5, i * 0.05).ok).toBe(true);
    const far = flat();
    let bad = '';
    for (let i = 1; i <= 40 && !bad; i++) { const r = far.v.check(0.5, 64 + i * 3.5 * 0.05, 0.5, i * 0.05); if (!r.ok) bad = r.rule; }
    expect(bad).toBe('fly');
    const pool = new TestWorld().fill(-30, 60, -30, 30, 60, 30, BLOCK.STONE).fill(-30, 61, -30, 30, 66, 30, BLOCK.WATER);
    const sw = new MovementValidator({ getBlock: pool.get }, { maxSpeed: SPEED });
    sw.reset(0.5, 62, 0.5, 0);
    for (let i = 1; i <= 40; i++) expect(sw.check(0.5, 62 + Math.min(i * 4 * 0.05, 3.5), 0.5, i * 0.05).ok).toBe(true);
  });

  it('the weapon speed sets the limit: a sniper is slower than an SMG, and a switch has a one second grace', () => {
    const slow = flat(undefined, arcadeMaxSpeed(0.92)).v;
    const fast = flat(undefined, arcadeMaxSpeed(1.08)).v;
    const run = (v: MovementValidator, speed: number) => {
      let x = 0.5;
      for (let i = 1; i <= 60; i++) { x += speed * 0.05; if (!v.check(x, 64, 0.5, i * 0.05).ok) return false; }
      return true;
    };
    const mid = arcadeMaxSpeed(1.0);
    expect(run(fast, mid)).toBe(true);
    expect(run(slow, mid * 1.2)).toBe(false);
    const sw = flat(undefined, arcadeMaxSpeed(0.92)).v;
    sw.setMaxSpeed(arcadeMaxSpeed(1.08), 0);
    expect(run(sw, arcadeMaxSpeed(1.08))).toBe(true);
  });

  it('a flag carrier (10% slower) running at full speed is caught; at carrier pace it is not', () => {
    const run = (speed: number) => {
      const v = flat(undefined, arcadeMaxSpeed(1) * 0.9).v;
      let x = -28;
      v.reset(x, 64, 0.5, 0);
      for (let i = 1; i <= 15 * 20; i++) {
        x += speed * 0.05;
        if (x > 28) { x = -28; v.reset(x, 64, 0.5, i * 0.05); continue; }
        if (!v.check(x, 64, 0.5, i * 0.05).ok) return i * 0.05;
      }
      return -1;
    };
    expect(run(arcadeMaxSpeed(1) * 0.9)).toBe(-1);
    const caught = run(arcadeMaxSpeed(1));
    expect(caught).toBeGreaterThan(0);
    expect(caught).toBeLessThan(15);
  });

  it('client clock: a server stall of a second, then the backlog at once, is no violation of any kind', () => {
    const { v } = flat(undefined, SPEED);
    let x = -25, step = 0;
    v.reset(x, 64, 0.5, 0);
    // 30 Hz reports at full speed; reports 30..60 are held back and arrive together at 2.0 s.
    for (let i = 1; i <= 90; i++) {
      x += SPEED * 2 / 60; step += 2;
      const arrive = i > 30 && i <= 60 ? 2.0 : i / 30;
      expect(rule(v.check(x, 64, 0.5, arrive, step))).toBe('ok');
    }
  });

  it('client clock: a speed hack with an honest clock is caught at once, one with a fast clock within a second', () => {
    const honest = flat(undefined, SPEED).v;
    let x = -25, caughtAt = -1;
    honest.reset(x, 64, 0.5, 0);
    honest.check(x, 64, 0.5, 0, 0);
    for (let i = 1; i <= 60 && caughtAt < 0; i++) { x += SPEED * 2 * 2 / 60; if (!honest.check(x, 64, 0.5, i / 30, i * 2).ok) caughtAt = i / 30; }
    expect(caughtAt).toBeGreaterThan(0);
    expect(caughtAt).toBeLessThan(0.4);
    // The clock runs three times as fast as real time, so every report looks like legal pace.
    const fast = flat(undefined, SPEED).v;
    x = -25; caughtAt = -1;
    fast.reset(x, 64, 0.5, 0);
    fast.check(x, 64, 0.5, 0, 0);
    let r: Verdict = { ok: true };
    for (let i = 1; i <= 90 && caughtAt < 0; i++) { x += SPEED * 3 * 2 / 60; r = fast.check(x, 64, 0.5, i / 30, i * 6); if (!r.ok) caughtAt = i / 30; }
    expect(rule(r)).toBe('clock');
    expect(caughtAt).toBeLessThan(MOVE.CLOCK_SECONDS / 2 + 0.2);
  });

  it('client clock: a clock that runs backwards (replayed reports) is caught, a report without it moves no time', () => {
    const { v } = flat(undefined, SPEED);
    v.check(0.5, 64, 0.5, 0, 100);
    expect(v.check(0.7, 64, 0.5, 0.033, 102).ok).toBe(true);
    expect(rule(v.check(0.9, 64, 0.5, 0.066, 90))).toBe('clock');
    // Once the client sends its clock, leaving it out does not fall back on arrival times.
    const w = flat(undefined, SPEED).v;
    w.check(0.5, 64, 0.5, 0, 0);
    let x = 0.5, caught = false;
    for (let i = 1; i <= 30 && !caught; i++) { x += SPEED / 30; caught = !w.check(x, 64, 0.5, i / 30).ok; }
    expect(caught).toBe(true);
  });

  it('client clock: the first report after a rubber band may come late and mid-jump', () => {
    const { v } = flat(undefined, SPEED);
    v.check(0.5, 64, 0.5, 0, 0);
    v.reset(0.5, 64, 0.5, 1);
    // The client got the teleport 0.8 s later, jumped and reports from 1.1 blocks up.
    expect(v.check(0.8, 65.1, 0.5, 1.8, 500).ok).toBe(true);
    expect(v.check(1.0, 65.2, 0.5, 1.833, 502).ok).toBe(true);
    expect(v.check(1.2, 65.1, 0.5, 1.866, 504).ok).toBe(true);
  });

  it('a flag carrier slowed while a backlog of full-speed reports is still on its way is not caught', () => {
    const { v } = flat(undefined, SPEED);
    let x = -25, step = 0;
    v.reset(x, 64, 0.5, 0);
    v.check(x, 64, 0.5, 0, 0);
    // The server sets the carrier limit at 1 s; the client hears of it 1.5 s later (a loaded machine).
    for (let i = 1; i <= 90; i++) {
      if (i === 30) v.setMaxSpeed(SPEED * 0.9, 1);
      x += (i < 75 ? SPEED : SPEED * 0.9) * 2 / 60; step += 2;
      expect(rule(v.check(x, 64, 0.5, i / 30, step))).toBe('ok');
    }
  });

  it('rejects positions outside the bounds and ignores nothing after reset (server teleport)', () => {
    const w = new TestWorld().fill(-30, 63, -30, 30, 63, 30, BLOCK.STONE);
    const v = new MovementValidator({ getBlock: w.get }, { maxSpeed: SPEED, inBounds: (x, z) => Math.abs(x) < 10 && Math.abs(z) < 10 });
    v.reset(0.5, 64, 0.5, 0);
    expect(rule(v.check(12, 64, 0.5, 0.5))).toBe('wall');
    v.reset(8.5, 64, 8.5, 1);
    expect(v.check(8.6, 64, 8.5, 1.05).ok).toBe(true);
  });

  it('pressed against a wall in mid-air is no ground: climbing a wall is flying', () => {
    // A wall of 8 blocks; the cheat hugs it (0.3 from its face, the player's half width) and climbs at 4 blocks/s.
    const { v } = flat((w) => w.fill(2, 64, -10, 2, 71, 10, BLOCK.STONE));
    v.reset(1.7, 64, 0.5, 0);
    let t = 0, bad = '';
    for (let i = 1; i <= 60 && !bad; i++) { t += 0.05; const r = v.check(1.7, 64 + i * 0.2, 0.5, t); if (!r.ok) bad = r.rule; }
    expect(bad).toBe('fly');
    expect(t).toBeLessThan(1);
  });

  it('a long gap (frame hitch) is no way through: a wall, a floor or a three block wall stay shut, a one block wall is a jump', () => {
    // With the client clock: 24 steps = 0.4 s between the two reports, then 3 steps = 0.05 s.
    const run = (extra: (w: TestWorld) => void, x: number, y: number, steps: number) => {
      const { v } = flat(extra);
      v.check(0.5, 64, 0.5, 0, 0);
      v.reset(0.5, 64, 0.5, 0.05);
      v.check(0.5, 64, 0.5, 0.1, 0);
      return rule(v.check(x, y, 0.5, 0.1 + steps / 60, steps));
    };
    // A wall a block thick, 6 high and long enough to give no way round it: shut however long the gap.
    const wall = (w: TestWorld) => w.fill(1, 64, -30, 1, 69, 30, BLOCK.STONE);
    expect(run(wall, 2.4, 64, 24)).toBe('wall');
    expect(run(wall, 2.4, 64, 3)).toBe('wall');
    // The floor under the feet is shut too, with a few steps sideways.
    expect(run(() => undefined, 0.7, 62, 24)).not.toBe('ok');
    // A wall of three blocks: higher than a jump.
    expect(run((w) => w.fill(1, 64, -30, 1, 66, 30, BLOCK.STONE), 2.4, 64, 24)).toBe('wall');
    // One block high: a jump over it takes 0.3 s, not 0.05 s.
    const low = (w: TestWorld) => w.fill(1, 64, -30, 1, 64, 30, BLOCK.STONE);
    expect(run(low, 2.4, 64, 24)).toBe('ok');
    expect(run(low, 2.4, 64, 3)).toBe('wall');
  });

  it('canFly skips the vertical rules but keeps the walls', () => {
    const w = new TestWorld().fill(-30, 63, -30, 30, 63, 30, BLOCK.STONE).fill(3, 64, -3, 3, 90, 3, BLOCK.STONE);
    const v = new MovementValidator({ getBlock: w.get }, { maxSpeed: PHYSICS.FLY_SPRINT_SPEED, canFly: true });
    v.reset(0.5, 70, 0.5, 0);
    for (let i = 1; i <= 20; i++) expect(v.check(0.5, 70 + i * 0.3, 0.5, i * 0.05).ok).toBe(true);
    expect(rule(v.check(5, 76, 0.5, 1.2))).toBe('wall');
  });
});

// ------------------------------------------------------------ client physics replay

interface Totals { reports: number; violations: Verdict[]; lagForgiven: number; maxSpeedRatio: number; context: string }

function replay(
  getBlock: (x: number, y: number, z: number) => number, getMeta: ((x: number, y: number, z: number) => number) | undefined,
  reports: Report[], maxSpeed: number, canFly: boolean, inBounds?: (x: number, z: number) => boolean, clientClock = false, slideCooldown?: number,
): Totals {
  const v = new MovementValidator({ getBlock, getMeta }, { maxSpeed, canFly, inBounds, slideCooldown });
  const tot: Totals = { reports: reports.length, violations: [], lagForgiven: 0, maxSpeedRatio: 0, context: '' };
  let prev: Report | null = null;
  for (const r of reports) {
    if (prev) {
      const s = Math.hypot(r.x - prev.x, r.z - prev.z) / Math.max(0.001, r.sent - prev.sent);
      tot.maxSpeedRatio = Math.max(tot.maxSpeedRatio, s / maxSpeed);
    }
    prev = r;
    const verdict = v.check(r.x, r.y, r.z, r.arrive, clientClock ? r.step : undefined, clientClock ? r.slide : undefined);
    if (verdict.ok) continue;
    if (verdict.weight === 0) tot.lagForgiven++;
    else {
      tot.violations.push(verdict);
      if (process.env.MOVE_DEBUG && !tot.context) {
        const i = reports.indexOf(r);
        tot.context = reports.slice(Math.max(0, i - 10), i + 1).map((q) => `${q.sent.toFixed(3)}/${q.arrive.toFixed(3)} ${q.x.toFixed(3)} ${q.y.toFixed(3)} ${q.z.toFixed(3)}`).join('\n');
        console.log(tot.context);
      }
    }
    // The server would rubber band here: restart from where the client really is for the replay's sake.
    v.reset(r.x, r.y, r.z, r.arrive);
  }
  return tot;
}

const NETS = [
  { name: 'LAN', latency: 0.01, jitter: 0.004, burstChance: 0, burst: 0 },
  { name: 'ADSL', latency: 0.04, jitter: 0.06, burstChance: 0.01, burst: 0.2 },
  { name: 'bursts of 4', latency: 0.03, jitter: 0.02, burstChance: 0.05, burst: 0.2 },
];

/** A loaded machine (QA with a dozen bots and two browsers): server stalls and backlogs up to a second. */
const LOAD = [
  { name: 'stalls', latency: 0.02, jitter: 0.03, burstChance: 0.01, burst: 1.0 },
  { name: 'backlog', latency: 0.02, jitter: 0.03, burstChance: 0, burst: 0, backlogChance: 0.02, backlog: 1.0 },
  { name: 'stalls+backlog', latency: 0.04, jitter: 0.06, burstChance: 0.01, burst: 0.6, backlogChance: 0.01, backlog: 0.8 },
];

/** The yacht carrier route of the QA report: dock, gangway, over the bow (hot tub, slab), the deck, the stern, the far dock. */
const YACHT_ROUTE: [number, number][] = [
  [-34.5, -17.5], [-36.5, -11], [-37.5, -0.5], [-35, -0.5], [-31, 3.5], [-27, 3.5], [-20, 3.5], [-14, 5],
  [14, 5], [27, -4], [35, -0.5], [37.5, 0.5], [36.5, 11], [34.5, 17.5],
];

describe('movement validator: the real client physics never trips it', () => {
  const seeds = Array.from({ length: Number(process.env.MOVE_SEEDS ?? 64) }, (_, i) => 1000 + i * 37);

  for (const id of MAP_IDS) {
    it(`arcade physics on map ${id}: ${seeds.length} runs × 40 s, bunny hops, wall sliding, jitter and bursts`, () => {
      const map = getMap(id);
      const variant = map.variantFor(7);
      const getBlock = (x: number, y: number, z: number) => map.blockAt(variant, x, y, z);
      // Arena maps have no block states: meta 0, shapes from the neighbours (as Game passes getMeta to Player.step).
      const getMeta = () => 0;
      const spawns = map.spawns.ffa;
      let total = 0, forgiven = 0, worst = 0;
      const bad: string[] = [];
      for (const seed of seeds) {
        const r = rng(seed);
        const w = WEAPONS[Math.floor(r() * WEAPONS.length)];
        const sp = spawns[Math.floor(r() * spawns.length)];
        const net = NETS[seed % NETS.length];
        const hz30 = seed % 2 === 0;
        const reports = recordClient(getBlock, getMeta, seed, {
          speedMultiplier: ARCADE_SPEED_MULT * w.moveSpeed, airAccel: ARCADE_AIR_ACCEL, canFly: false, seconds: 40,
          interval: hz30 ? [0.033, 0.05] : [0.05, 0.067], bunnyHop: seed % 3 !== 0, start: { x: sp.x, y: sp.y, z: sp.z },
        });
        const tot = replay(getBlock, getMeta, throughNetwork(reports, seed, net), arcadeMaxSpeed(w.moveSpeed), false, (x, z) => map.inBounds(x, z));
        total += tot.reports; forgiven += tot.lagForgiven; worst = Math.max(worst, tot.maxSpeedRatio);
        for (const v of tot.violations.slice(0, 2)) bad.push(`${w.id} seed ${seed} ${net.name}: ${(v as { rule: string }).rule} (${tot.violations.length})`);
      }
      expect(bad).toEqual([]);
      expect(total).toBeGreaterThan(15000);
      // Reports of a client that moves at the limit; bursts are the only source of forgiven violations.
      expect(worst).toBeLessThanOrEqual(1.05);
      expect(forgiven).toBeLessThan(total * 0.002);
    });
  }

  // Capture the flag under load: the carrier runs 10 % slower, bunny hops, and the machine stutters (frame
  // hitches on the client, stalls and backlogs on the server). With the client clock nothing may be
  // corrected, not even as forgiven lag (a forgiven correction still rubber-bands the player).
  const CARRY = 0.9;
  const carrierRun = (id: (typeof MAP_IDS)[number], seed: number, route: [number, number][] | undefined, start: { x: number; y: number; z: number }) => {
    const map = getMap(id);
    const variant = map.variantFor(7);
    const getBlock = (x: number, y: number, z: number) => map.blockAt(variant, x, y, z);
    const getMeta = () => 0;
    const w = WEAPONS[seed % WEAPONS.length];
    const reports = recordClient(getBlock, getMeta, seed, {
      speedMultiplier: ARCADE_SPEED_MULT * w.moveSpeed * CARRY, airAccel: ARCADE_AIR_ACCEL, canFly: false, seconds: route ? 60 : 30,
      interval: seed % 2 ? [0.033, 0.05] : [0.05, 0.067], bunnyHop: seed % 3 !== 0, start, hitches: 0.04, route,
    });
    const net = LOAD[seed % LOAD.length];
    const tot = replay(getBlock, getMeta, throughNetwork(reports, seed, net), arcadeMaxSpeed(w.moveSpeed) * CARRY, false, (x, z) => map.inBounds(x, z), true);
    return { tot, label: `${id} ${w.id} seed ${seed} ${net.name}${route ? ' (route)' : ''}` };
  };
  const failures = (tot: Totals, label: string) =>
    [...tot.violations.slice(0, 2).map((v) => `${label}: ${(v as { rule: string }).rule} (${tot.violations.length})`),
      ...(tot.lagForgiven ? [`${label}: ${tot.lagForgiven} forgiven lag corrections`] : [])];

  /** Run number `i` of the flag carrier test: which flag it starts at and whether it runs for home or wanders. */
  const flagRun = (id: (typeof MAP_IDS)[number], i: number, seed: number) => {
    const map = getMap(id);
    const [own, enemy] = i % 2 ? [map.flags[0], map.flags[1]] : [map.flags[1], map.flags[0]];
    const start = { x: enemy.x, y: enemy.y, z: enemy.z };
    // Straight for home (bumping into whatever is in the way) or wandering around the flag.
    const route: [number, number][] | undefined = i % 3 === 2 ? undefined : [[enemy.x, enemy.z], [0.5, 0.5], [own.x, own.z]];
    return carrierRun(id, seed, route, start);
  };

  for (const id of MAP_IDS.filter((m) => getMap(m).flags.length === 2)) {
    it(`flag carrier under load on map ${id}: runs from both flags, with the client clock, never corrected`, () => {
      const bad: string[] = [];
      let total = 0;
      for (const [i, seed] of seeds.slice(0, 12).entries()) {
        const { tot, label } = flagRun(id, i, seed);
        total += tot.reports;
        bad.push(...failures(tot, label));
      }
      expect(bad).toEqual([]);
      expect(total).toBeGreaterThan(2000);
    });
  }

  // Runs that once got an honest player corrected (QA round 3, found by the replay with the full weapon list and 64 seeds);
  // the weapon (the seed picks it) is part of the case, so adding a weapon must not reshuffle them: the seeds stay here.
  it('flag carrier on station, seed 1333 (a revolver carrier jumping along a ledge under a low ceiling in a hitch): not corrected', () => {
    const { tot, label } = flagRun('station', 9, 1333);
    expect(failures(tot, label)).toEqual([]);
  });

  it('flag carrier on the yacht deck route of the QA report (dock, bow, hot tub, deck, stern), both ways, under load', () => {
    const bad: string[] = [];
    let total = 0;
    for (const seed of seeds) {
      const route = seed % 2 ? YACHT_ROUTE.slice() : YACHT_ROUTE.slice().reverse();
      const { tot, label } = carrierRun('yacht', seed, route, { x: route[0][0], y: ARENA_FLOOR_Y + 1, z: route[0][1] });
      total += tot.reports;
      bad.push(...failures(tot, label));
    }
    expect(bad).toEqual([]);
    expect(total).toBeGreaterThan(5000);
  });

  it('Minecraft physics (walking, sprint-jumping, flying) over stairs, slabs, ladders and water', () => {
    const w = new TestWorld().fill(-24, 63, -24, 24, 63, 24, BLOCK.STONE)
      .fill(-24, 64, -24, 24, 90, -24, BLOCK.STONE).fill(-24, 64, 24, 24, 90, 24, BLOCK.STONE)
      .fill(-24, 64, -24, -24, 90, 24, BLOCK.STONE).fill(24, 64, -24, 24, 90, 24, BLOCK.STONE);
    const meta = new Map<string, number>();
    const put = (x: number, y: number, z: number, id: number, m = 0) => { w.set(x, y, z, id); if (m) meta.set(`${x},${y},${z}`, m); };
    // A staircase up to y = 69 with a platform, slab rows, a ladder tower, a pool and some walls.
    for (let i = 0; i < 5; i++) for (let z = -2; z <= 2; z++) { put(4 + i, 64 + i, z, BLOCK.STONE_STAIRS, stairMeta(EAST, false)); w.fill(4 + i, 64, z, 4 + i, 63 + i, z, BLOCK.STONE); }
    w.fill(9, 64, -2, 12, 68, 2, BLOCK.STONE);
    for (let x = -12; x <= -4; x++) for (let z = -8; z <= 8; z += 2) put(x, 64, z, BLOCK.STONE_SLAB, SLAB_BOTTOM);
    w.fill(-10, 64, 12, -10, 80, 12, BLOCK.STONE);
    for (let y = 64; y <= 79; y++) put(-9, y, 12, BLOCK.LADDER, NORTH);
    w.fill(0, 60, 10, 6, 63, 16, BLOCK.AIR).fill(0, 60, 10, 6, 60, 16, BLOCK.STONE).fill(0, 61, 10, 6, 64, 16, BLOCK.WATER);
    w.fill(-3, 64, -14, 3, 66, -14, BLOCK.STONE).fill(-3, 64, -12, -3, 66, -8, BLOCK.COBBLESTONE);
    const getMeta = (x: number, y: number, z: number) => meta.get(`${x},${y},${z}`) ?? 0;
    const bad: string[] = [];
    let total = 0;
    for (const [i, seed] of seeds.entries()) {
      const flying = i % 4 === 3;
      const reports = recordClient(w.get, getMeta, seed, {
        speedMultiplier: 1, airAccel: PHYSICS.AIR_ACCEL, canFly: flying, seconds: 40, interval: [0.05, 0.067], bunnyHop: seed % 2 === 0,
        start: { x: 0.5, y: 64, z: 0.5 },
      });
      const maxSpeed = flying ? PHYSICS.FLY_SPRINT_SPEED : PHYSICS.SPRINT_SPEED;
      const tot = replay(w.get, getMeta, throughNetwork(reports, seed, NETS[1]), maxSpeed, flying);
      total += tot.reports;
      for (const v of tot.violations.slice(0, 2)) bad.push(`seed ${seed}${flying ? ' (flying)' : ''}: ${(v as { rule: string }).rule} (${tot.violations.length})`);
    }
    expect(total).toBeGreaterThan(10000);
    expect(bad).toEqual([]);
  });

  it('every kind of cheating on the same maps is caught (the flip side of the test above)', () => {
    const map = getMap('classic');
    const variant = map.variantFor(7);
    const getBlock = (x: number, y: number, z: number) => map.blockAt(variant, x, y, z);
    const sp = map.spawns.ffa[0];
    const mk = () => { const v = new MovementValidator({ getBlock }, { maxSpeed: SPEED, inBounds: (x, z) => map.inBounds(x, z) }); v.reset(sp.x, sp.y, sp.z, 0); return v; };
    // Flying: 3 blocks up and stay.
    const fly = mk(); let flyCaught = false;
    for (let i = 1; i <= 60; i++) if (!fly.check(sp.x, sp.y + Math.min(3, i * 0.5), sp.z, i * 0.033).ok) { flyCaught = true; break; }
    expect(flyCaught).toBe(true);
    // Speed 2x for 3 s.
    const sp2 = mk(); let sCaught = false; let x = sp.x;
    for (let i = 1; i <= 90; i++) { x += SPEED * 2 * 0.033; if (!sp2.check(x, sp.y, sp.z, i * 0.033).ok) { sCaught = true; break; } }
    expect(sCaught).toBe(true);
    // Straight through the arena wall.
    const b = map.bounds;
    const wall = mk();
    expect(wall.check(b.maxX + 3, sp.y, sp.z, 1).ok).toBe(false);
    void ARENA_FLOOR_Y; void JUMP_APEX;
  });

  it('the same cheats with the client clock (honest or replayed clock values) are caught too', () => {
    const map = getMap('classic');
    const variant = map.variantFor(7);
    const getBlock = (x: number, y: number, z: number) => map.blockAt(variant, x, y, z);
    const sp = map.spawns.ffa[0];
    const mk = () => { const v = new MovementValidator({ getBlock }, { maxSpeed: SPEED, inBounds: (x, z) => map.inBounds(x, z) }); v.reset(sp.x, sp.y, sp.z, 0); v.check(sp.x, sp.y, sp.z, 0, 0); return v; };
    const fly = mk(); let flyCaught = false;
    for (let i = 1; i <= 60 && !flyCaught; i++) flyCaught = !fly.check(sp.x, sp.y + Math.min(3, i * 0.3), sp.z, i / 30, i * 2).ok;
    expect(flyCaught).toBe(true);
    // Hovering 1 block up (the curve's anchor can only move with a real take-off).
    const hover = mk(); let hoverCaught = false;
    for (let i = 1; i <= 90 && !hoverCaught; i++) hoverCaught = !hover.check(sp.x, sp.y + (i < 5 ? i * 0.25 : 1 + (i % 2) * 0.02), sp.z, i / 30, i * 2).ok;
    expect(hoverCaught).toBe(true);
    const sp2 = mk(); let sCaught = false; let x = sp.x;
    for (let i = 1; i <= 90 && !sCaught; i++) { x += SPEED * 2 / 30; sCaught = !sp2.check(x, sp.y, sp.z, i / 30, i * 2).ok; }
    expect(sCaught).toBe(true);
    const b = map.bounds;
    expect(mk().check(b.maxX + 3, sp.y, sp.z, 1, 60).ok).toBe(false);
    expect(mk().check(sp.x + 25, sp.y, sp.z, 1, 60).ok).toBe(false);
  });
});

// ------------------------------------------------------------ arcade movement: slides, slide-hops, bunny hops, pads

describe('movement validator: arcade slides, slide-hops, bunny hop chains and air strafe', () => {
  const seeds = Array.from({ length: Number(process.env.MOVE_SEEDS ?? 64) }, (_, i) => 2000 + i * 53);
  const arcadeRun = (id: (typeof MAP_IDS)[number], seed: number, nets: typeof NETS | typeof LOAD, cooldown?: number, pads?: [number, number][]) => {
    const map = getMap(id);
    const variant = map.variantFor(7);
    // `pads`: jump pads laid into the floor (the block at ARENA_FLOOR_Y) on top of the map.
    const getBlock = (x: number, y: number, z: number) =>
      pads && y === ARENA_FLOOR_Y && pads.some(([px, pz]) => px === x && pz === z) ? BLOCK.JUMP_PAD : map.blockAt(variant, x, y, z);
    const getMeta = () => 0;
    const r = rng(seed);
    const w = WEAPONS[Math.floor(r() * WEAPONS.length)];
    const sp = map.spawns.ffa[Math.floor(r() * map.spawns.ffa.length)];
    const net = nets[seed % nets.length];
    const reports = recordClient(getBlock, getMeta, seed, {
      speedMultiplier: ARCADE_SPEED_MULT * w.moveSpeed, airAccel: ARCADE_AIR_ACCEL, canFly: false, seconds: 40,
      interval: seed % 2 ? [0.033, 0.05] : [0.05, 0.067], bunnyHop: true, start: { x: sp.x, y: sp.y, z: sp.z },
      arcade: true, slideCooldown: cooldown, hitches: nets === LOAD ? 0.04 : 0,
    });
    const tot = replay(getBlock, getMeta, throughNetwork(reports, seed, net), arcadeMaxSpeed(w.moveSpeed), false, (x, z) => map.inBounds(x, z), true, cooldown);
    const slides = new Set(reports.map((q) => q.slide).filter((q) => q === q)).size;
    return { tot, slides, label: `${id} ${w.id} seed ${seed} ${net.name}` };
  };

  /** Run number `i` of the arcade test of a map: the network (load or not) and the slide cooldown (perk) follow from it. */
  const runOf = (id: (typeof MAP_IDS)[number], i: number, seed: number, pads?: [number, number][]) =>
    arcadeRun(id, seed, i % 2 ? NETS : LOAD, i % 5 === 4 ? 0.65 : undefined, pads);

  // Runs that once got an honest player corrected: [map, seed, run number]. A player pressed against a wall or a pillar
  // was taken for standing on it, a hitch hid a slab or a pad that the take-off came from, a curved route in a hitch
  // (jump along a wall, over a ledge, under a ceiling) matched none of the straight or L shaped paths.
  const REGRESSIONS: [(typeof MAP_IDS)[number], number, number][] = [
    ['atomic', 4120, 40], ['atomic', 4332, 44], ['town', 3272, 24], ['town', 3908, 36], ['town', 4544, 48], ['station', 2742, 14],
    ['plaza', 4756, 52], ['mall', 2636, 12], ['mall', 3696, 32], ['mall', 5180, 60], ['scrap', 4756, 52],
    // Found with more seeds while fixing the above.
    ['atomic', 6558, 86], ['mall', 4173, 41], ['mall', 4067, 39],
  ];
  it('arcade movement: the runs that were wrongly corrected before are not (walls hugged in a jump, slab and pad take-offs, curved routes)', () => {
    const bad: string[] = [];
    for (const [id, seed, i] of REGRESSIONS) {
      const { tot, label } = runOf(id, i, seed);
      for (const v of tot.violations.slice(0, 2)) bad.push(`${label}: ${(v as { rule: string }).rule} (${tot.violations.length})`);
      if (tot.lagForgiven) bad.push(`${label}: ${tot.lagForgiven} forgiven lag corrections`);
    }
    expect(bad).toEqual([]);
  });

  // The Flight Deck's elevator pad ("next to a raised edge") was removed because it got honest players a `fly` correction
  // under a network backlog. Back in place, on the carrier, none of 300 runs may be corrected.
  it('arcade movement on the carrier with its old elevator jump pads (next to a raised edge): never corrected', () => {
    const bad: string[] = [];
    const pads: [number, number][] = [[-8, 11], [7, -12]];
    for (let i = 0; i < 300; i++) {
      const seed = 2000 + i * 53;
      const { tot, label } = runOf('carrier', i, seed, pads);
      for (const v of tot.violations.slice(0, 2)) bad.push(`${label}: ${(v as { rule: string }).rule} (${tot.violations.length})`);
      if (tot.lagForgiven) bad.push(`${label}: ${tot.lagForgiven} forgiven lag corrections`);
    }
    expect(bad).toEqual([]);
  });

  for (const id of MAP_IDS) {
    it(`arcade movement on map ${id}: ${seeds.length} runs × 40 s with the client clock, never corrected`, () => {
      const bad: string[] = [];
      let total = 0, slides = 0, worst = 0;
      for (const [i, seed] of seeds.entries()) {
        const { tot, slides: n, label } = runOf(id, i, seed);
        total += tot.reports; slides += n; worst = Math.max(worst, tot.maxSpeedRatio);
        for (const v of tot.violations.slice(0, 2)) bad.push(`${label}: ${(v as { rule: string }).rule} (${tot.violations.length})`);
        if (tot.lagForgiven) bad.push(`${label}: ${tot.lagForgiven} forgiven lag corrections`);
      }
      expect(bad).toEqual([]);
      expect(total).toBeGreaterThan(seeds.length * 600);
      // The runs really slide and slide-hop: well past the run speed.
      expect(slides).toBeGreaterThan(seeds.length * 8);
      expect(worst).toBeGreaterThan(1.3);
    });
  }
});
