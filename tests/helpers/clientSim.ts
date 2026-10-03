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

/** A position report as the client would send it, with the time it was sent. */
export interface Report { sent: number; x: number; y: number; z: number; arrive: number }

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
  for (let i = 0; i < steps; i++) {
    const t = i * PHYSICS.STEP;
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
    if (t >= nextSend) {
      out.push({ sent: t, x: p.x, y: p.y, z: p.z, arrive: t });
      nextSend = t + o.interval[0] + r() * (o.interval[1] - o.interval[0]);
    }
  }
  return out;
}

export interface NetOptions {
  /** One-way latency base and uniform jitter (seconds). */
  latency: number;
  jitter: number;
  /** Probability per report that a hold-and-release burst starts (reports stuck for `burst` seconds). */
  burstChance: number;
  burst: number;
}

/** Applies latency, jitter and bursts; delivery stays in order (TCP). Returns the reports in arrival order. */
export function throughNetwork(reports: Report[], seed: number, n: NetOptions): Report[] {
  const r = rng(seed ^ 0x9e3779b9);
  let prev = 0;
  let holdUntil = -1;
  return reports.map((rep) => {
    let a = rep.sent + n.latency + r() * n.jitter;
    if (rep.sent > holdUntil && r() < n.burstChance) holdUntil = rep.sent + n.burst;
    if (rep.sent <= holdUntil) a = Math.max(a, holdUntil + n.latency);
    a = Math.max(a, prev);
    prev = a;
    return { ...rep, arrive: a };
  });
}
