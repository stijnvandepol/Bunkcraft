import { PHYSICS } from '../../src/player/Physics';
import { type MoveInput, Player } from '../../src/player/Player';
import type { BlockGetter } from '../../src/player/Collision';

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A position report as the client would send it: the (wall clock) time it was sent, the physics steps
 * simulated so far (the `step` field of `pos`), and the time it arrived (see `throughNetwork`).
 */
export interface Report { sent: number; step: number; x: number; y: number; z: number; arrive: number }

export interface SimOptions {
  /** Same fields as Game: arcade scales speed and air control, Minecraft mode leaves them at 1. */
  speedMultiplier: number;
  airAccel: number;
  canFly: boolean;
  /** Seconds of simulated play. */
  seconds: number;
  /** Position messages: interval range in seconds (NetClient waits 0.05 and sends on the next frame). */
  interval: [number, number];
  /** Never hold jump (false) or hold it in long stretches (bunny hopping). */
  bunnyHop: boolean;
  start: { x: number; y: number; z: number };
  /** Chance per frame of a frame hitch of 0.1-0.4 s (a loaded machine); the simulation catches up at most 0.25 s, like Game. */
  hitches?: number;
  /** Run along these (x, z) points instead of wandering (e.g. a flag carrier's route); jumping as with `bunnyHop`. */
  route?: [number, number][];
}

/**
 * Runs the real `Player.step` with a random input script (walking, strafing, turning, jumping in long
 * stretches, bumping into walls) and returns the position reports a client would send.
 */
export function recordClient(getBlock: BlockGetter, getMeta: BlockGetter | undefined, seed: number, o: SimOptions): Report[] {
  const r = rng(seed);
  const p = new Player();
  p.canFly = o.canFly;
  p.speedMultiplier = o.speedMultiplier;
  p.airAccel = o.airAccel;
  p.setPosition(o.start.x, o.start.y, o.start.z);
  p.yaw = r() * Math.PI * 2;
  const move: MoveInput = { forward: 1, strafe: 0, jump: false, jumpPressed: false, sprint: true, descend: false };
  let left = 0, turn = 0;
  const out: Report[] = [];
  let nextSend = 0;
  const steps = Math.round(o.seconds / PHYSICS.STEP);
  // Frames on the wall clock (a separate generator, so runs without hitches keep their input script).
  const hr = rng(seed ^ 0x51ed27);
  const route = o.route?.slice();
  let wall = 0, acc = 0;
  for (let i = 0; i < steps;) {
    const frame = o.hitches && hr() < o.hitches ? 0.1 + hr() * 0.3 : PHYSICS.STEP;
    wall += frame;
    acc = Math.min(acc + frame, 0.25);
    while (acc >= PHYSICS.STEP - 1e-9 && i < steps) {
      acc -= PHYSICS.STEP;
      step(); i++;
    }
    const t = wall - PHYSICS.STEP;
    if (t >= nextSend) {
      out.push({ sent: t, step: i, x: p.x, y: p.y, z: p.z, arrive: t });
      nextSend = t + o.interval[0] + r() * (o.interval[1] - o.interval[0]);
    }
    if (route && route.length === 0) break;
  }
  return out;

  function step(): void {
    if (route) {
      while (route.length && Math.hypot(route[0][0] - p.x, route[0][1] - p.z) < 0.7) route.shift();
      if (route.length) p.yaw = Math.atan2(-(route[0][0] - p.x), -(route[0][1] - p.z));
      move.forward = route.length ? 1 : 0;
      move.strafe = 0;
      if (left-- <= 0) { left = Math.floor(6 + r() * 114); move.jump = o.bunnyHop ? r() < 0.8 : r() < 0.15; }
      move.jumpPressed = move.jump && r() < 0.05;
      p.step(move, getBlock, getMeta);
      return;
    }
    if (left-- <= 0) {
      // A new "decision" every 0.1 to 2 seconds.
      left = Math.floor(6 + r() * 114);
      move.forward = r() < 0.8 ? 1 : r() < 0.5 ? 0 : -1;
      move.strafe = r() < 0.5 ? 0 : r() < 0.5 ? -1 : 1;
      move.jump = o.bunnyHop ? r() < 0.6 : r() < 0.15;
      turn = (r() - 0.5) * (r() < 0.2 ? 14 : 3); // rad/s; sometimes a quick turn into a wall
      if (r() < 0.1) p.yaw += (r() - 0.5) * Math.PI;
    }
    p.yaw += turn * PHYSICS.STEP;
    move.jumpPressed = move.jump && r() < 0.05;
    p.step(move, getBlock, getMeta);
  }
}

export interface NetOptions {
  /** One-way latency base and uniform jitter (seconds). */
  latency: number;
  jitter: number;
  /** Probability per report that a hold-and-release burst starts (reports stuck for `burst` seconds). */
  burstChance: number;
  burst: number;
  /**
   * A loaded server: chance per report that it starts falling behind, the backlog it builds up (seconds)
   * before catching up at once (all queued reports then arrive together).
   */
  backlogChance?: number;
  backlog?: number;
}

/** Applies latency, jitter and bursts; delivery stays in order (TCP). Returns the reports in arrival order. */
export function throughNetwork(reports: Report[], seed: number, n: NetOptions): Report[] {
  const r = rng(seed ^ 0x9e3779b9);
  let prev = 0;
  let holdUntil = -1;
  let lag = 0, lagTo = 0;
  return reports.map((rep) => {
    let a = rep.sent + n.latency + r() * n.jitter;
    if (rep.sent > holdUntil && r() < n.burstChance) holdUntil = rep.sent + n.burst;
    if (rep.sent <= holdUntil) a = Math.max(a, holdUntil + n.latency);
    // Backlog: the delay grows by 20-50 ms per report up to `lagTo`, then drops to zero at once.
    if (n.backlogChance) {
      if (lagTo === 0 && r() < n.backlogChance) lagTo = (n.backlog ?? 0.5) * (0.3 + 0.7 * r());
      if (lagTo > 0) { lag = Math.min(lagTo, lag + 0.02 + r() * 0.03); if (lag >= lagTo && r() < 0.1) lag = lagTo = 0; }
      a += lag;
    }
    a = Math.max(a, prev);
    prev = a;
    return { ...rep, arrive: a };
  });
}
