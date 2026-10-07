import { describe, expect, it } from 'vitest';
import { ARCADE_AIR_ACCEL, ARCADE_SPEED_MULT, arcadeMaxSpeed } from '../src/modes/ArcadeLogic';
import {
  JUMP_PAD_APEX, JUMP_PAD_VELOCITY, POSE, SLIDE, padLandings, padReach, poseEye, poseHeight, slideCooldown, slideEnvelope, slideExtra,
} from '../src/player/ArcadeMove';
import { PHYSICS } from '../src/player/Physics';
import { type MoveInput, Player } from '../src/player/Player';
import { BLOCK, SOLID, TALL } from '../src/world/BlockRegistry';
import { MovementValidator } from '../server/anticheat/Movement';
import { recordClient, rng, throughNetwork } from './helpers/clientSim';
import { TestWorld } from './helpers';

/** Arcade movement (slide, slide-hop, bunny hop momentum, air strafe, crouch, jump pads): the client physics and its bound. */

const RUN = arcadeMaxSpeed(1);

function arena(extra?: (w: TestWorld) => void): TestWorld {
  const w = new TestWorld().fill(-60, 63, -60, 60, 63, 60, BLOCK.STONE);
  extra?.(w);
  return w;
}

function runner(): { p: Player; move: MoveInput } {
  const p = new Player();
  p.arcadeMove = true;
  p.canFly = false;
  p.speedMultiplier = ARCADE_SPEED_MULT;
  p.airAccel = ARCADE_AIR_ACCEL;
  p.setPosition(0.5, 64, 40.5);
  p.yaw = 0; // forward = −z
  return { p, move: { forward: 1, strafe: 0, jump: false, jumpPressed: false, sprint: true, descend: false, crouch: false, crouchPressed: false } };
}

const speed = (p: Player) => Math.hypot(p.vx, p.vz);
const steps = (n: number, f: () => void) => { for (let i = 0; i < n; i++) f(); };

describe('arcade movement: slide', () => {
  it('a slide bursts to 1.45 × the run speed, decays, lowers the eye and ends within its time', () => {
    const w = arena();
    const { p, move } = runner();
    steps(60, () => p.step(move, w.get));
    expect(speed(p)).toBeCloseTo(RUN, 2);
    move.crouch = move.crouchPressed = true;
    p.step(move, w.get);
    move.crouchPressed = false;
    expect(p.sliding).toBe(true);
    expect(p.slideStarts).toBe(1);
    // Peak right after the start, one step of friction later.
    expect(speed(p)).toBeGreaterThan(RUN * (1 + SLIDE.BOOST) * 0.95);
    expect(speed(p)).toBeLessThanOrEqual(RUN * (1 + SLIDE.BOOST) + 1e-9);
    const curve: number[] = [];
    let t = 0;
    while (p.sliding && t < 2) { p.step(move, w.get); curve.push(speed(p)); t += PHYSICS.STEP; }
    // Monotonically decaying, over within MAX_TIME, and the eye went down towards the slide eye.
    for (let i = 1; i < curve.length; i++) expect(curve[i]).toBeLessThanOrEqual(curve[i - 1] + 1e-9);
    expect(t).toBeLessThanOrEqual(SLIDE.MAX_TIME + 2 * PHYSICS.STEP);
    expect(p.eye).toBeLessThan(POSE.SLIDE_EYE + 0.15);
    // Still holding crouch: crouch walk at 55 % after the slide.
    steps(60, () => p.step(move, w.get));
    expect(p.crouching).toBe(true);
    expect(speed(p)).toBeCloseTo(RUN * POSE.CROUCH_SPEED, 1);
    expect(p.eye).toBeCloseTo(POSE.CROUCH_EYE, 2);
  });

  it('the cooldown blocks a second slide until it has run out; holding crouch never re-slides', () => {
    const w = arena();
    const { p, move } = runner();
    steps(60, () => p.step(move, w.get));
    const press = () => { move.crouch = move.crouchPressed = true; p.step(move, w.get); move.crouchPressed = false; };
    press();
    expect(p.slideStarts).toBe(1);
    move.crouch = false;
    steps(20, () => p.step(move, w.get));
    press();
    expect(p.slideStarts).toBe(1); // 0.35 s after the first: cooldown
    move.crouch = false;
    steps(Math.round(SLIDE.COOLDOWN * 60), () => p.step(move, w.get));
    press();
    expect(p.slideStarts).toBe(2);
    // The Lightfoot perk shortens the cooldown.
    expect(slideCooldown(true)).toBeLessThan(slideCooldown(false));
  });

  it('no slide from standing still or walking slowly', () => {
    const w = arena();
    const { p, move } = runner();
    move.forward = 0;
    move.crouch = move.crouchPressed = true;
    p.step(move, w.get);
    expect(p.sliding).toBe(false);
  });
});

describe('arcade movement: momentum (slide-hop, bunny hop, air strafe)', () => {
  it('a slide-hop carries the slide speed into the air and it fades slowly', () => {
    const w = arena();
    const { p, move } = runner();
    steps(60, () => p.step(move, w.get));
    move.crouch = move.crouchPressed = true;
    p.step(move, w.get);
    move.crouchPressed = false;
    steps(4, () => p.step(move, w.get));
    move.jump = true;
    p.step(move, w.get);
    move.jump = false;
    expect(p.sliding).toBe(false);
    expect(p.onGround).toBe(false);
    steps(18, () => p.step(move, w.get)); // 0.3 s in the air
    expect(speed(p)).toBeGreaterThan(RUN * 1.25);
  });

  it('a bunny hop chain keeps the momentum on every landing; without jumping the ground friction eats it', () => {
    const w = arena();
    const hop = (jump: boolean) => {
      const { p, move } = runner();
      steps(60, () => p.step(move, w.get));
      move.crouch = move.crouchPressed = true;
      p.step(move, w.get);
      move.crouchPressed = false;
      move.crouch = false;
      move.jump = true;
      steps(2, () => p.step(move, w.get));
      move.jump = jump;
      steps(90, () => p.step(move, w.get)); // 1.5 s: about three hops
      return speed(p);
    };
    const hopping = hop(true), running = hop(false);
    expect(hopping).toBeGreaterThan(RUN * 1.08);
    expect(running).toBeLessThan(RUN * 1.01);
  });

  it('air strafing turns the momentum without adding speed', () => {
    const w = arena();
    const { p, move } = runner();
    steps(60, () => p.step(move, w.get));
    move.crouch = move.crouchPressed = true;
    p.step(move, w.get);
    move.crouch = move.crouchPressed = false;
    move.jump = true;
    p.step(move, w.get);
    move.jump = false;
    move.forward = 0; move.strafe = 1;
    const dir0 = Math.atan2(p.vx, p.vz);
    let prev = speed(p);
    for (let i = 0; i < 30 && !p.onGround; i++) {
      p.yaw -= 2.5 * PHYSICS.STEP; // mouse turns right with the strafe key
      p.step(move, w.get);
      expect(speed(p)).toBeLessThanOrEqual(prev + 1e-9);
      prev = speed(p);
    }
    const turned = Math.abs(Math.atan2(Math.sin(Math.atan2(p.vx, p.vz) - dir0), Math.cos(Math.atan2(p.vx, p.vz) - dir0)));
    expect(turned).toBeGreaterThan(0.3);
    expect(prev).toBeGreaterThan(RUN);
  });

  it('every honest input keeps the speed under the server envelope: run × (1 + BOOST·e^(−AIR_DRAG·t)) after the last slide', () => {
    const w = arena((t) => {
      // Crates, a step pyramid and stairs down to slide on.
      t.fill(-4, 64, 0, 4, 64, 2, BLOCK.STONE).fill(-2, 65, 0, 2, 65, 2, BLOCK.STONE);
      for (let i = 0; i < 4; i++) t.fill(10 + i, 64, -10, 10 + i, 67 - i, 10, BLOCK.STONE);
    });
    let worst = 0, total = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const r = rng(seed);
      const { p, move } = runner();
      p.setPosition(0.5, 70, 20.5);
      let lastSlide = -1e9, slides = 0;
      for (let i = 0; i < 60 * 30; i++) {
        if (i % 7 === 0) {
          move.forward = r() < 0.85 ? 1 : 0; move.strafe = r() < 0.6 ? 0 : r() < 0.5 ? 1 : -1;
          move.jump = r() < 0.5;
          const c = r() < 0.4;
          move.crouchPressed = c && !move.crouch;
          move.crouch = c;
        }
        p.yaw += (r() - 0.5) * 0.2;
        p.step(move, w.get);
        move.crouchPressed = false;
        if (p.slideStarts !== slides) { slides = p.slideStarts; lastSlide = i * PHYSICS.STEP; }
        const bound = RUN * slideEnvelope(i * PHYSICS.STEP - lastSlide);
        worst = Math.max(worst, speed(p) / bound);
      }
      total += slides;
    }
    expect(total).toBeGreaterThan(30);
    expect(worst).toBeLessThanOrEqual(1 + 1e-9);
  });

  it('the envelope integral matches the decay it bounds', () => {
    // ∫0^∞ BOOST·e^(−kt) dt = BOOST / k; a split interval sums up.
    expect(slideExtra(0, 1e6)).toBeCloseTo(SLIDE.BOOST / SLIDE.AIR_DRAG, 9);
    expect(slideExtra(0, 0.5) + slideExtra(0.5, 2)).toBeCloseTo(slideExtra(0, 2), 12);
    expect(slideExtra(-1, 0)).toBe(0);
    expect(slideEnvelope(0)).toBeCloseTo(1 + SLIDE.BOOST, 12);
    expect(poseHeight(false, true, 1.8)).toBe(POSE.SLIDE_HEIGHT);
    expect(poseHeight(true, false, 1.8)).toBe(POSE.CROUCH_HEIGHT);
    expect(poseEye(false, false)).toBe(PHYSICS.EYE_HEIGHT);
  });

  it('Minecraft movement ignores the crouch input entirely (arcadeMove off)', () => {
    const w = arena();
    const a = new Player(), b = new Player();
    for (const p of [a, b]) { p.canFly = false; p.setPosition(0.5, 64, 0.5); }
    const r = rng(9);
    const mv: MoveInput = { forward: 1, strafe: 0, jump: false, jumpPressed: false, sprint: true, descend: false };
    for (let i = 0; i < 600; i++) {
      if (i % 9 === 0) { mv.forward = r() < 0.8 ? 1 : -1; mv.jump = r() < 0.4; mv.strafe = r() < 0.5 ? 0 : 1; }
      a.step(mv, w.get);
      b.step({ ...mv, crouch: r() < 0.5, crouchPressed: r() < 0.2 }, w.get);
      a.yaw += 0.01; b.yaw += 0.01;
    }
    expect([b.x, b.y, b.z, b.eye]).toEqual([a.x, a.y, a.z, PHYSICS.EYE_HEIGHT]);
    expect(b.sliding).toBe(false);
  });
});

describe('jump pads', () => {
  const padWorld = () => arena((t) => {
    t.set(0, 63, 30, BLOCK.JUMP_PAD);
    // A ledge 4 blocks up beside the pad, reachable only with it.
    t.fill(-3, 64, 24, 3, 67, 27, BLOCK.STONE);
  });

  it('launches about JUMP_PAD_APEX blocks up and keeps the run speed', () => {
    const w = padWorld();
    const { p, move } = runner();
    p.setPosition(0.5, 64, 33.5);
    let top = 0, launched = false, ledge = false;
    for (let i = 0; i < 90; i++) {
      p.step(move, w.get);
      if (p.padLaunches > 0) launched = true;
      top = Math.max(top, p.y - 64);
      if (p.onGround && p.y === 68) ledge = true;
    }
    expect(launched).toBe(true);
    expect(JUMP_PAD_APEX).toBeCloseTo((JUMP_PAD_VELOCITY ** 2) / 60, 9);
    // Lands on the 4 high ledge (the run speed carried it over the edge).
    expect(ledge).toBe(true);
    expect(top).toBeGreaterThan(3.9);
  });

  it('the server accepts honest pad launches and rejects the same rise without a pad', () => {
    const w = padWorld();
    const { p, move } = runner();
    p.setPosition(0.5, 64, 34.5);
    const reports: { t: number; step: number; x: number; y: number; z: number }[] = [];
    for (let i = 1; i <= 120; i++) {
      p.step(move, w.get);
      if (i % 2 === 0) reports.push({ t: i / 60, step: i, x: p.x, y: p.y, z: p.z });
    }
    const v = new MovementValidator({ getBlock: w.get }, { maxSpeed: RUN });
    v.reset(0.5, 64, 34.5, 0);
    v.check(0.5, 64, 34.5, 0, 0);
    for (const r of reports) expect(v.check(r.x, r.y, r.z, r.t, r.step).ok, `${r.t} ${r.y}`).toBe(true);
    // The same flight two blocks to the side (no pad under the path) is flying.
    const flat = arena();
    const c = new MovementValidator({ getBlock: flat.get }, { maxSpeed: RUN });
    c.reset(0.5, 64, 34.5, 0);
    c.check(0.5, 64, 34.5, 0, 0);
    let caught = false;
    for (const r of reports) if (!c.check(r.x, r.y, r.z, r.t, r.step).ok) { caught = true; break; }
    expect(caught).toBe(true);
  });

  it('reachability: the pad reaches the ledge, walking does not', () => {
    const w = padWorld();
    const out: [number, number, number][] = [];
    padLandings(w.get, (id) => SOLID[id] === 1 && !TALL[id], 0, 63, 30, out);
    expect(out.some(([x, z, y]) => y === 67 && z === 27 && x === 0)).toBe(true);
    expect(padReach(4)).toBeGreaterThan(3.5);
    // A roof over the pad stops it.
    w.set(0, 67, 30, BLOCK.STONE);
    out.length = 0;
    padLandings(w.get, (id) => SOLID[id] === 1 && !TALL[id], 0, 63, 30, out);
    expect(out).toEqual([]);
  });
});

describe('movement validator: slide claims', () => {
  it('a speed hack that claims a slide every cooldown is still caught; slides claimed too often do not count', () => {
    const w = arena();
    const mk = () => {
      const v = new MovementValidator({ getBlock: w.get }, { maxSpeed: RUN });
      v.reset(0.5, 64, -50.5, 0);
      v.check(0.5, 64, -50.5, 0, 0);
      return v;
    };
    // A perfect slide chain averages about 1.32 × the run speed (the envelope); 1.5 × with a claimed slide every 0.9 s is caught.
    const hack = mk();
    let caught = false, x = 0.5;
    for (let i = 2; i <= 360 && !caught; i += 2) {
      x += RUN * 1.5 * (2 / 60);
      caught = !hack.check(x, 64, -50.5, i / 60, i, Math.floor(i / 54) * 54 || undefined).ok;
    }
    expect(caught).toBe(true);
    // A slide burst claimed every 0.3 s (three times the cooldown rate): only every third counts.
    const spam = mk();
    let caught2 = false; x = 0.5;
    for (let i = 2; i <= 360 && !caught2; i += 2) {
      const age = (i % 18) / 60;
      x += RUN * (1 + SLIDE.BOOST * Math.exp(-SLIDE.AIR_DRAG * age)) * (2 / 60);
      caught2 = !spam.check(x, 64, -50.5, i / 60, i, Math.floor(i / 18) * 18 || undefined).ok;
    }
    expect(caught2).toBe(true);
  });

  it('an honest slide run through the network is accepted only with the slide reports', () => {
    const w = arena();
    const reports = recordClient(w.get, undefined, 77, {
      speedMultiplier: ARCADE_SPEED_MULT, airAccel: ARCADE_AIR_ACCEL, canFly: false, seconds: 20, interval: [0.033, 0.05], bunnyHop: true,
      start: { x: 0.5, y: 64, z: 0.5 }, arcade: true,
    });
    const run = (withSlides: boolean) => {
      const v = new MovementValidator({ getBlock: w.get }, { maxSpeed: RUN });
      let bad = 0;
      for (const r of throughNetwork(reports, 77, { latency: 0.02, jitter: 0.01, burstChance: 0, burst: 0 })) {
        if (!v.check(r.x, r.y, r.z, r.arrive, r.step, withSlides ? r.slide : undefined).ok) { bad++; v.reset(r.x, r.y, r.z, r.arrive); }
      }
      return bad;
    };
    expect(run(true)).toBe(0);
    expect(run(false)).toBeGreaterThan(0);
  });
});
