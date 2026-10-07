/**
 * Hit registration simulation: one shooter, one moving target, a real `Match` on the server side and the
 * client's own snapshot timing (SnapshotClock + interpolate, the code RemotePlayers draws with), joined by a
 * network with latency and jitter. The shooter aims at a random point on the *drawn* player model (the
 * MobTypes model with its render scale, arms raised, legs swinging) the way a perfect human would, and the
 * server's verdict is compared with what was on screen.
 *
 * Used by tests/hitreg.test.ts and printed by `npx tsx scripts/hitreg-sim.ts`.
 */
import { MOB_TYPES } from '../../src/entities/MobTypes';
import type { MatchInfo, ServerMessage } from '../../src/net/protocol';
import { type InterpState, SnapshotClock, type Span, interpolate } from '../../src/net/SnapshotClock';
import { ARCADE_SPEED_MULT, arcadeInterpDelay } from '../../src/modes/ArcadeLogic';
import { PHYSICS } from '../../src/player/Physics';
import { BLOCK } from '../../src/world/BlockRegistry';
import { Match, type MatchHost, SPAWN_PROTECTION, WARMUP_SECONDS, type ShotReport } from '../../server/Match';
import { rng } from './clientSim';

export type Part = 'head' | 'body' | 'arm' | 'leg';
export type Motion = 'still' | 'strafe' | 'run' | 'jump';

export interface SimOptions {
  rttMs: number;
  /** Extra random one-way delay per message, uniform 0..jitterMs (messages stay in order, like TCP). */
  jitterMs: number;
  seconds: number;
  seed: number;
  motion: Motion;
  /** Distance between shooter and target (blocks). */
  distance: number;
  tickHz?: number;
  /** Seconds between shots. */
  fireEvery?: number;
  /** Only aim at this part (default: a random part per shot, head 25 %, body 35 %, arms 20 %, legs 20 %). */
  part?: Part;
  /** Blocks for the bullets (default: none). */
  blocks?: (x: number, y: number, z: number) => number;
}

export interface SimShot { part: Part; hit: boolean; head: boolean }

export interface SimResult {
  shots: SimShot[];
  missRate: number;
  /** Misses per aimed part. */
  byPart: Record<Part, { shots: number; misses: number }>;
  /** Aimed at the head but counted as a body hit, and the other way round. */
  headLost: number;
  headFalse: number;
}

const FLOOR = 64;

/** Tiny time-ordered event queue. */
class Queue {
  private items: { t: number; seq: number; fn: () => void }[] = [];
  private seq = 0;
  push(t: number, fn: () => void): void {
    this.items.push({ t, seq: this.seq++, fn });
  }
  pop(): { t: number; fn: () => void } | undefined {
    if (this.items.length === 0) return undefined;
    let best = 0;
    for (let i = 1; i < this.items.length; i++) {
      const a = this.items[i], b = this.items[best];
      if (a.t < b.t || (a.t === b.t && a.seq < b.seq)) best = i;
    }
    return this.items.splice(best, 1)[0];
  }
}

/** One direction of a connection: latency/2 plus jitter, in order. */
class Link {
  private last = 0;
  constructor(private readonly q: Queue, private readonly oneWay: number, private readonly jitter: number, private readonly r: () => number) {}
  send(now: number, fn: () => void): void {
    const at = Math.max(this.last, now + this.oneWay + this.r() * this.jitter);
    this.last = at;
    this.q.push(at, fn);
  }
}

// ---------------------------------------------------------------- the drawn model

type V3 = [number, number, number];
const rotY = (v: V3, a: number): V3 => [v[0] * Math.cos(a) + v[2] * Math.sin(a), v[1], -v[0] * Math.sin(a) + v[2] * Math.cos(a)];
const rotX = (v: V3, a: number): V3 => [v[0], v[1] * Math.cos(a) - v[2] * Math.sin(a), v[1] * Math.sin(a) + v[2] * Math.cos(a)];

interface Drawn { x: number; y: number; z: number; yaw: number; pitch: number; limbSwing: number; limbAmount: number }

/**
 * A random point inside one part of the drawn player model (inset 15 % from the box edges: "on target").
 * Same transforms as MobRenderer: base yaw and render scale, then the part's rotation about its pivot.
 */
export function modelPoint(d: Drawn, part: Part, r: () => number): V3 {
  const type = MOB_TYPES.player;
  const scale = type.scale ?? 1;
  const anim = part === 'head' ? 'head' : part === 'body' ? 'none' : part === 'arm' ? (r() < 0.5 ? 'armL' : 'armR') : (r() < 0.5 ? 'legA' : 'legB');
  const mp = type.parts.find((p) => p.anim === anim)!;
  const box = mp.boxes[0];
  const p: V3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) p[i] = (box.from[i] + (box.to[i] - box.from[i]) * (0.15 + 0.7 * r())) / 16;
  const pv: V3 = [mp.pivot[0] / 16, mp.pivot[1] / 16, mp.pivot[2] / 16];
  let v: V3 = [p[0] - pv[0], p[1] - pv[1], p[2] - pv[2]];
  const legSwing = Math.cos(d.limbSwing * 0.6662) * 1.4 * d.limbAmount;
  if (anim === 'head') v = rotX(v, d.pitch);
  else if (anim === 'armR') v = rotX(v, Math.PI / 2 + d.pitch);
  else if (anim === 'armL') v = rotY(rotX(v, Math.PI / 2 + d.pitch - 0.25), -0.5);
  else if (anim === 'legA') v = rotX(v, legSwing);
  else if (anim === 'legB') v = rotX(v, -legSwing);
  v = [(v[0] + pv[0]) * scale, (v[1] + pv[1]) * scale, (v[2] + pv[2]) * scale];
  v = rotY(v, d.yaw);
  return [d.x + v[0], d.y + v[1], d.z + v[2]];
}

// ---------------------------------------------------------------- target movement

/** Where the target is at time t: strafing (A/D with acceleration), running in circles, or strafe-jumping. */
function targetMotion(motion: Motion, seed: number): (t: number) => { x: number; y: number; z: number; yaw: number } {
  const speed = PHYSICS.SPRINT_SPEED * ARCADE_SPEED_MULT;
  const r = rng(seed ^ 0x9e3779b9);
  // Strafe legs: random durations 0.25-0.8 s, alternating direction; velocity eases over 0.12 s.
  const legs: { t0: number; dir: number }[] = [];
  let t = 0, dir = 1;
  while (t < 600) { legs.push({ t0: t, dir }); t += 0.25 + r() * 0.55; dir = -dir; }
  const pos = new Float64Array(Math.ceil(600 / 0.005) + 2);
  let x = 0, v = 0, k = 0;
  for (let i = 0; i < pos.length; i++) {
    const tt = i * 0.005;
    while (k + 1 < legs.length && legs[k + 1].t0 <= tt) k++;
    const want = legs[k].dir * speed;
    v += Math.max(-speed / 0.12 * 0.005, Math.min(speed / 0.12 * 0.005, want - v));
    x += v * 0.005;
    pos[i] = x;
  }
  const at = (tt: number) => {
    const i = Math.min(pos.length - 2, Math.max(0, tt / 0.005));
    const i0 = Math.floor(i);
    return pos[i0] + (pos[i0 + 1] - pos[i0]) * (i - i0);
  };
  return (tt: number) => {
    const yaw = Math.PI + Math.sin(tt * 0.7) * 1.2; // facing roughly towards the shooter, turning
    if (motion === 'still') return { x: 0.5, y: FLOOR, z: 0, yaw };
    if (motion === 'run') return { x: Math.cos(tt * speed / 6) * 6, y: FLOOR, z: Math.sin(tt * speed / 6) * 6, yaw };
    const y = motion === 'jump' ? FLOOR + Math.max(0, 1.25 * Math.sin((tt % 0.6) / 0.6 * Math.PI)) : FLOOR;
    return { x: at(tt), y, z: 0, yaw };
  };
}

// ---------------------------------------------------------------- the run

class SimHost implements MatchHost {
  t = 1000;
  rtt = 0;
  blocks: { getBlock(x: number, y: number, z: number): number };
  reports: ShotReport[] = [];
  constructor(getBlock?: (x: number, y: number, z: number) => number) {
    this.blocks = { getBlock: getBlock ?? ((_x, y) => (y < FLOOR ? BLOCK.STONE : BLOCK.AIR)) };
  }
  interpDelay = 0.1;
  now() { return this.t; }
  send(_id: number, _msg: ServerMessage) { /* verdicts come from onShot */ }
  broadcast() { /* nobody listens */ }
  random() { return 0; } // no spread: this measures where the target is, not the weapon
  ping() { return this.rtt; }
  moveTo() { /* spawns are overridden */ }
  onShot(r: ShotReport) { this.reports.push(r); }
}

export function runHitregSim(o: SimOptions): SimResult {
  const tickHz = o.tickHz ?? 30;
  const interp = arcadeInterpDelay(tickHz);
  const r = rng(o.seed);
  const q = new Queue();
  const host = new SimHost(o.blocks);
  host.interpDelay = interp;
  host.rtt = o.rttMs;
  const info: MatchInfo = { type: 'ffa', scoreLimit: 1000, timeLimitSec: 3600 };
  const match = new Match(host, info);
  match.join(1, 'shooter'); match.join(2, 'target');
  match.ready(1); match.ready(2);
  for (let t = 0; t < WARMUP_SECONDS + SPAWN_PROTECTION + 1; t += 0.05) { host.t += 0.05; match.tick(); }
  const t0 = host.t;
  const shooter = { x: 0.5, y: FLOOR, z: o.distance };
  match.setPosition(1, shooter.x, shooter.y, shooter.z);
  const motion = targetMotion(o.motion, o.seed);
  const up = new Link(q, o.rttMs / 2000, o.jitterMs / 1000, r); // client → server
  const down = new Link(q, o.rttMs / 2000, o.jitterMs / 1000, r); // server → client
  const victimUp = new Link(q, 0.03, o.jitterMs / 1000, r);

  // Target client: reports at 30 Hz.
  const posEvery = 1 / 30;
  for (let t = 0; t < o.seconds + 1; t += posEvery) {
    q.push(t0 + t, () => {
      const m = motion(t);
      victimUp.send(host.t, () => match.setPosition(2, m.x, m.y, m.z, m.yaw, 0));
    });
  }
  // Server ticks: history, then a snapshot (positions quantised to 1/32 block like the binary format).
  let tick = 0;
  const clock = new SnapshotClock();
  const buffer: InterpState[] = [];
  for (let t = 0; t < o.seconds + 1; t += 1 / tickHz) {
    q.push(t0 + t + 0.0001, () => {
      match.tick();
      const p = match.players.get(2)!;
      p.health = 100;
      const k = ++tick;
      const snap = { x: Math.round(p.x * 32) / 32, y: Math.round(p.y * 32) / 32, z: Math.round(p.z * 32) / 32, yaw: p.yaw, pitch: p.pitch };
      down.send(host.t, () => {
        const st = clock.stamp(host.t, k);
        buffer.push({ t: st, ...snap, flags: 4 });
        if (buffer.length > 30) buffer.shift();
      });
    });
  }
  // Shooter client: 60 fps; draws the target and fires every `fireEvery` seconds at a point on the drawn model.
  const shots: SimShot[] = [];
  const pending: { part: Part }[] = [];
  const span: Span = { a: 0, c: 0, f: 1 };
  const drawn: Drawn = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, limbSwing: 0, limbAmount: 0 };
  let nextFire = t0 + 1.5;
  let px = NaN, pz = NaN;
  const fireEvery = o.fireEvery ?? 0.1;
  for (let t = 0; t < o.seconds; t += 1 / 60) {
    q.push(t0 + t + 0.0002, () => {
      const now = host.t;
      if (buffer.length === 0) return;
      const renderTime = now - interp;
      const sp = interpolate(buffer, renderTime, span);
      const a = buffer[sp.a], c = buffer[sp.c], f = sp.f;
      drawn.x = a.x + (c.x - a.x) * f; drawn.y = a.y + (c.y - a.y) * f; drawn.z = a.z + (c.z - a.z) * f;
      let dyaw = c.yaw - a.yaw;
      dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
      drawn.yaw = a.yaw + dyaw * f;
      drawn.pitch = a.pitch + (c.pitch - a.pitch) * f;
      // Limb swing exactly like RemotePlayers.
      const moved = Number.isNaN(px) ? 0 : Math.hypot(drawn.x - px, drawn.z - pz);
      px = drawn.x; pz = drawn.z;
      drawn.limbAmount += (Math.min(1, moved * 12) - drawn.limbAmount) * 0.25;
      drawn.limbSwing += drawn.limbAmount * 0.9;
      if (now < nextFire) return;
      nextFire += fireEvery;
      const part: Part = o.part ?? (() => { const u = r(); return u < 0.25 ? 'head' : u < 0.6 ? 'body' : u < 0.8 ? 'arm' : 'leg'; })();
      const aim = modelPoint(drawn, part, r);
      const ox = shooter.x, oy = shooter.y + 1.62, oz = shooter.z;
      const dx = aim[0] - ox, dy = aim[1] - oy, dz = aim[2] - oz, len = Math.hypot(dx, dy, dz);
      const msg = {
        t: 'fire' as const, slot: 1 as const, ox, oy, oz, dx: dx / len, dy: dy / len, dz: dz / len, ads: true,
        rk: clock.renderTick(renderTime),
      };
      pending.push({ part });
      up.send(now, () => {
        const before = host.reports.length;
        const pl = match.players.get(1)!;
        // Endless ammo, no cadence limits: this measures geometry and timing only.
        for (const s of pl.slots) { s.mag = Math.max(1, s.cap); s.nextFireAt = 0; s.reloadDoneAt = 0; }
        match.fire(1, msg);
        const shot = pending.shift()!;
        const rep = host.reports[before];
        const hit = rep?.hits.find((h) => h.victim === 2);
        shots.push({ part: shot.part, hit: !!hit, head: !!hit?.head });
      });
    });
  }
  for (let e = q.pop(); e; e = q.pop()) {
    host.t = Math.max(host.t, e.t);
    e.fn();
  }
  const byPart: SimResult['byPart'] = { head: { shots: 0, misses: 0 }, body: { shots: 0, misses: 0 }, arm: { shots: 0, misses: 0 }, leg: { shots: 0, misses: 0 } };
  let misses = 0, headLost = 0, headFalse = 0;
  for (const s of shots) {
    byPart[s.part].shots++;
    if (!s.hit) { misses++; byPart[s.part].misses++; }
    if (s.hit && s.part === 'head' && !s.head) headLost++;
    if (s.hit && s.part !== 'head' && s.head) headFalse++;
  }
  return { shots, missRate: shots.length ? misses / shots.length : 0, byPart, headLost, headFalse };
}
