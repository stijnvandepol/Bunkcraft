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

  it('rejects positions outside the bounds and ignores nothing after reset (server teleport)', () => {
    const w = new TestWorld().fill(-30, 63, -30, 30, 63, 30, BLOCK.STONE);
    const v = new MovementValidator({ getBlock: w.get }, { maxSpeed: SPEED, inBounds: (x, z) => Math.abs(x) < 10 && Math.abs(z) < 10 });
    v.reset(0.5, 64, 0.5, 0);
    expect(rule(v.check(12, 64, 0.5, 0.5))).toBe('wall');
    v.reset(8.5, 64, 8.5, 1);
    expect(v.check(8.6, 64, 8.5, 1.05).ok).toBe(true);
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
  reports: Report[], maxSpeed: number, canFly: boolean, inBounds?: (x: number, z: number) => boolean,
): Totals {
  const v = new MovementValidator({ getBlock, getMeta }, { maxSpeed, canFly, inBounds });
  const tot: Totals = { reports: reports.length, violations: [], lagForgiven: 0, maxSpeedRatio: 0, context: '' };
  let prev: Report | null = null;
  for (const r of reports) {
    if (prev) {
      const s = Math.hypot(r.x - prev.x, r.z - prev.z) / Math.max(0.001, r.sent - prev.sent);
      tot.maxSpeedRatio = Math.max(tot.maxSpeedRatio, s / maxSpeed);
    }
    prev = r;
    const verdict = v.check(r.x, r.y, r.z, r.arrive);
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

describe('movement validator: the real client physics never trips it', () => {
  const seeds = Array.from({ length: Number(process.env.MOVE_SEEDS ?? 24) }, (_, i) => 1000 + i * 37);

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
});
