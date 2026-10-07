import { type AABB, type BlockGetter, boxIntersectsSolid } from '../../src/player/Collision';
import { JUMP_PAD_VELOCITY, SLIDE, slideExtra } from '../../src/player/ArcadeMove';
import { PHYSICS } from '../../src/player/Physics';
import { BLOCK, SOLID } from '../../src/world/BlockRegistry';

/**
 * Server-side movement validation (DOM-free). The client simulates its own movement with `Player.step`
 * and reports positions about 20-30 times per second; this checks every report against the map with
 * the same collision code (`boxIntersectsSolid`) and against limits derived from the shared physics
 * constants. It never simulates inputs (the server does not know them), it checks what is *possible*:
 *
 *  - noclip: the new position lies inside a solid block.
 *  - wall: no collision-free path (vertical then horizontal, or the other way round, straight or around
 *    a corner) leads from the last valid position to the new one: tunnelling through a wall or floor.
 *  - speed / teleport: horizontal distance against a token bucket that fills with *real* elapsed time at
 *    the speed limit. Packets that were held back and are released in a burst cannot exceed the budget.
 *  - rise / fall: vertical speed limits (jump velocity, terminal velocity).
 *  - fly: while not standing on something (or in a liquid, or on a ladder) the player must follow the
 *    jump parabola: no hovering, gliding or climbing beyond the jump apex.
 *  - clock: the client's simulation clock (see below) runs faster than real time.
 *
 * Time base. Arrival times are a poor clock under load: a server that falls behind, or a network that
 * holds packets back, delivers seconds of movement within a few milliseconds, and the jump curve and
 * the speed budget then see a player who rises or runs impossibly fast (honest flag carriers bunny
 * hopping over the yacht's deck got rubber-banded that way). Clients therefore send `step`, the number
 * of 60 Hz physics steps they have simulated. The physics rules (speed budget, jump curve, fall speed)
 * run on that clock, and a second token bucket keeps it honest: client time may not run ahead of real
 * time by more than CLOCK_SECONDS (what a lag spike legitimately banks). A report without `step` (old
 * clients, scripts) falls back on arrival times; once a player has sent `step`, a report without it
 * counts as no time passed.
 *
 * Arcade movement (src/player/ArcadeMove.ts). A slide is the only thing that lifts the horizontal speed above
 * the run speed, and the client physics decays that excess at least at SLIDE.AIR_DRAG in every state. Clients
 * report the physics step of their latest slide start (`slide`); a start inside the report window and at
 * least the slide cooldown after the previous one raises the speed budget by exactly the envelope
 * maxSpeed · BOOST · e^(−AIR_DRAG·t). Jump pads (BLOCK.JUMP_PAD) launch with JUMP_PAD_VELOCITY: the jump
 * curve uses that speed only when a pad lay under the player's path at the take-off height.
 */

export type Rule = 'noclip' | 'wall' | 'speed' | 'teleport' | 'rise' | 'fall' | 'fly' | 'clock';

export interface Violation {
  ok: false;
  rule: Rule;
  /** Strike weight: how sure we are that this is not lag (0 = forgiven lag spike). */
  weight: number;
  /** The report arrived inside a lag spike: correct the player but do not count a strike. */
  lag: boolean;
}
export type Verdict = { ok: true } | Violation;
const OK: Verdict = { ok: true };

/** Tunables (blocks and seconds). Exported so tests and docs quote the same numbers. */
export const MOVE = {
  /** The player box is shrunk by this on every side for solid tests (float noise, corner cutting). */
  MARGIN: 0.03,
  /** Distance between samples when sweeping a segment: smaller than the box (0.6 wide, 1.8 tall). */
  SAMPLE_STEP: 0.25,
  /** The ground probe reaches this far below the feet. */
  SUPPORT_DEPTH: 0.05,
  /** Speed limit multiplier on top of the physics maximum (bunny hop steering, step-up, rounding). */
  SPEED_ALLOWANCE: 1.03,
  /** The horizontal bucket holds this many seconds of movement (a lag spike that is released at once)... */
  BURST_SECONDS: 0.5,
  /** ...plus this many blocks (step-up, first packet). */
  BURST_BLOCKS: 0.75,
  /** Silence longer than this before a packet counts as a lag spike (violations right after it are forgiven). */
  STALL_GAP: 0.15,
  /** How long after a stall packets are still treated as its burst. */
  STALL_WINDOW: 0.4,
  /** `wall`: a report whose straight or L-shaped route is blocked may take a detour this far off it (blocks)... */
  DETOUR_MARGIN: 0.5,
  /** ...when it covers at most this many blocks (a frame hitch: a quarter second at full speed plus slack). */
  DETOUR_MAX: 3,
  /** Packet timing uncertainty used for the jump curve. */
  JITTER: 0.2,
  /** Extra height tolerated above the jump curve. */
  HEIGHT_SLACK: 0.2,
  /** A report further than this from the last valid position in one go is a teleport. */
  TELEPORT_DISTANCE: 10,
  /**
   * A rising report with ground at most this far below can be a new jump whose take-off fell between two
   * reports: the jump apex (1.32) plus slack, or a bunny hop caught near its top after a frame hitch is missed.
   */
  BOUNCE_GROUND: 1.5,
  /**
   * ...if the jump curve says take-off was no longer ago than the time between the reports (at least
   * REPORT_GAP: bursts squeeze arrival times together) plus this.
   */
  BOUNCE_SLACK: 0.05,
  /** Longest regular gap between two position reports (20 Hz on a 60 fps frame clock). */
  REPORT_GAP: 0.075,
  /** Client clock (`step`): how far it may run ahead of real time (a lag spike's backlog released at once). */
  CLOCK_SECONDS: 2,
  /** Client clock: timing uncertainty of the jump curve (the steps are exact; the curve is continuous). */
  CLOCK_JITTER: 0.05,
  /** Client clock: seconds of movement the horizontal bucket holds (no network bursts to absorb). */
  CLOCK_BURST_SECONDS: 0.25,
  /** A lower speed limit (flag picked up, slower weapon) applies this long after the change: the client learns it a round trip later. */
  SLOWDOWN_GRACE: 2,
  /** A higher speed limit (the client may have switched first) keeps the old one this long. */
  SPEEDUP_GRACE: 1,
} as const;

/** Physics steps per second of the client simulation (`PHYSICS.STEP`). */
export const STEPS_PER_SECOND = Math.round(1 / PHYSICS.STEP);

/** Highest point of a jump from the ground (continuous model; the 60 Hz integration stays below it). */
export const JUMP_APEX = (PHYSICS.JUMP_VELOCITY * PHYSICS.JUMP_VELOCITY) / (2 * PHYSICS.GRAVITY);
const JV = PHYSICS.JUMP_VELOCITY;
const apexOf = (v: number): number => (v * v) / (2 * PHYSICS.GRAVITY);
/** Stepping onto a 0.6 ledge happens within one report. */
const STEP_HEIGHT = 0.6;

export interface MovementWorld {
  getBlock: BlockGetter;
  getMeta?: BlockGetter;
}

export interface MovementOptions {
  /** Horizontal speed (blocks/s) of the fastest legal movement, e.g. sprint × arcade multiplier × weapon speed. */
  maxSpeed: number;
  /** Creative/spectator style flight: skips the vertical rules and the jump curve. */
  canFly?: boolean;
  /** Inside the walkable area (x, z); outside is a violation reported as 'wall'. */
  inBounds?: (x: number, z: number) => boolean;
  /** Arcade: seconds between two slide starts (the player's perk decides; default SLIDE.COOLDOWN). */
  slideCooldown?: number;
}

const hw = PHYSICS.WIDTH / 2;

/**
 * Height (above the launch point) the jump curve allows after `tau` seconds, tolerating `jitter` seconds of
 * timing error; `v` is the launch speed (a jump, or a jump pad).
 */
export function jumpCeiling(tau: number, jitter: number = MOVE.JITTER, v: number = JV): number {
  const lo = Math.max(0, tau - jitter), hi = Math.max(0, tau + jitter);
  return jumpHeight(Math.min(hi, Math.max(lo, v / PHYSICS.GRAVITY)), v);
}

function jumpHeight(t: number, v: number): number {
  // Time at which the fall reaches terminal velocity; after it the descent is linear.
  const terminal = (v + PHYSICS.TERMINAL_VELOCITY) / PHYSICS.GRAVITY;
  if (t <= terminal) return v * t - 0.5 * PHYSICS.GRAVITY * t * t;
  const h = v * terminal - 0.5 * PHYSICS.GRAVITY * terminal * terminal;
  return h - PHYSICS.TERMINAL_VELOCITY * (t - terminal);
}

/** Seconds a launch at `v` needs to reach `h` blocks above the launch point (ascent branch). */
function riseTime(h: number, v: number = JV): number {
  const d = v * v - 2 * PHYSICS.GRAVITY * Math.max(0, h);
  return d <= 0 ? v / PHYSICS.GRAVITY : (v - Math.sqrt(d)) / PHYSICS.GRAVITY;
}

/** Per-player movement state and checks. Times are seconds on any monotonic clock. */
export class MovementValidator {
  /** Last accepted position and its arrival time. */
  x = 0; y = 0; z = 0; t = 0;
  /** Physics time of the last accepted position (client clock, or arrival time without one). */
  private tp = 0;
  /** The accepted position before that (physics time). */
  private px = 0; private pz = 0; private pt = 0;
  private maxSpeed: number;
  private prevMaxSpeed: number;
  private speedChangedAt = -1e9;
  /** Client clock: last `step` seen (NaN until the first report after a reset), whether this client sends it at all. */
  private lastStep = NaN;
  private stepMode = false;
  /** Client clock: seconds the client's clock may still run ahead of real time, and when that was refilled. */
  private clock = 0;
  private clockAt = 0;
  private bucketH = 0;
  private bucketV = 0;
  private refillAt = 0;
  private lastPacketAt = 0;
  private stallUntil = -1e9;
  /** Standing on something, in a liquid or on a ladder at the last accepted position. */
  grounded = true;
  private groundY = 0;
  private groundT = 0;
  /** Air phase: anchor of the jump curve and the lowest point so far. */
  private anchorY = 0;
  private anchorT = 0;
  /** Launch speed of the current air phase (a jump, or a jump pad). */
  private anchorV: number = JV;
  private lowY = 0;
  /** Vertical budget of a jump pad launch (filled at the pad's speed; only spent when a pad is under the path). */
  private bucketVPad = 0;
  /** Slide envelope: physics time and client step of the last accepted slide start, the speed limit then. */
  private slideAt = -1e9;
  private slideStep = NaN;
  private slideBase = 0;
  private started = false;
  private readonly box: AABB = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };

  /**
   * Block states for partial shapes. Without them `boxIntersectsSolid` treats slabs, stairs and fences as
   * full blocks, and a fence one block below the feet as overlapping; the client always collides with
   * the real shapes, so the validator does too (meta 0 when the world has no states).
   */
  private readonly getMeta: BlockGetter;

  private slideCooldown: number;

  constructor(private readonly world: MovementWorld, private readonly opts: MovementOptions) {
    this.maxSpeed = this.prevMaxSpeed = opts.maxSpeed;
    this.slideCooldown = opts.slideCooldown ?? SLIDE.COOLDOWN;
    this.getMeta = world.getMeta ?? (() => 0);
  }

  get hasState(): boolean {
    return this.started;
  }

  /** The server put the player here (spawn, teleport, rubber band): forget everything and start grounded. */
  reset(x: number, y: number, z: number, t: number): void {
    this.x = this.px = x; this.y = y; this.z = this.pz = z; this.t = this.pt = this.tp = t;
    this.refillAt = this.lastPacketAt = this.clockAt = t;
    this.lastStep = NaN;
    this.clock = MOVE.CLOCK_SECONDS;
    this.bucketH = this.capH();
    this.bucketV = this.capV();
    this.bucketVPad = this.capV(JUMP_PAD_VELOCITY);
    this.anchorV = JV;
    this.stallUntil = -1e9;
    this.grounded = true;
    this.groundY = this.anchorY = this.lowY = y;
    this.groundT = this.anchorT = t;
    this.started = true;
  }

  /**
   * The speed limit changed (weapon switch, flag picked up or dropped; `t` is real time); the larger of
   * old and new applies for a while, since the client only learns about a slowdown a round trip later.
   */
  setMaxSpeed(v: number, t: number): void {
    if (v === this.maxSpeed) return;
    // Still inside the grace of an earlier change: keep the larger old limit.
    this.prevMaxSpeed = this.inGrace(t) ? Math.max(this.maxSpeed, this.prevMaxSpeed) : this.maxSpeed;
    this.maxSpeed = v;
    this.speedChangedAt = t;
  }

  /** Arcade: did an accepted slide start recently enough that the player may still be sliding (low hitbox)? */
  get slideActive(): boolean {
    const age = this.tp - this.slideAt;
    return age >= -0.1 && age <= SLIDE.MAX_TIME + 0.7;
  }

  /** Arcade: the slide cooldown changed (perk of the new life). */
  setSlideCooldown(seconds: number): void {
    this.slideCooldown = seconds;
  }

  private inGrace(t: number): boolean {
    const grace = this.prevMaxSpeed > this.maxSpeed ? MOVE.SLOWDOWN_GRACE : MOVE.SPEEDUP_GRACE;
    return t - this.speedChangedAt < grace;
  }

  /** Speed limit at real time `t`. */
  private limit(t: number): number {
    return (this.inGrace(t) ? Math.max(this.maxSpeed, this.prevMaxSpeed) : this.maxSpeed) * MOVE.SPEED_ALLOWANCE;
  }

  private capH(t = -1e9, tp = -1e9): number {
    const seconds = this.stepMode ? MOVE.CLOCK_BURST_SECONDS : MOVE.BURST_SECONDS;
    return (this.limit(t) + this.slideSpeed(tp)) * seconds + MOVE.BURST_BLOCKS;
  }

  /** Speed above the limit the slide envelope allows at physics time `tp` (0 without a slide). */
  private slideSpeed(tp: number): number {
    const age = tp - this.slideAt;
    return age < 0 || age > 30 ? 0 : this.slideBase * SLIDE.BOOST * Math.exp(-SLIDE.AIR_DRAG * age);
  }

  private capV(v: number = JV): number {
    return v * MOVE.SPEED_ALLOWANCE * 0.3 + STEP_HEIGHT + 0.3;
  }

  /** Accepts a reported slide start (client step `at`) if it lies in this report's window and respects the cooldown. */
  private grantSlide(at: number, step: number, tp: number, resync: boolean, t: number): void {
    if (!Number.isFinite(at) || at === this.slideStep || at > step) return;
    // New since the last report (after a resync: within the last two seconds).
    if (resync ? step - at > 2 * STEPS_PER_SECOND : !(at > this.lastStep)) return;
    const cooldown = Math.round(this.slideCooldown * STEPS_PER_SECOND) - 1;
    if (this.slideStep === this.slideStep && at - this.slideStep < cooldown) return;
    this.slideStep = at;
    this.slideAt = tp - (step - at) / STEPS_PER_SECOND;
    this.slideBase = this.limit(t);
  }

  // ------------------------------------------------------------ geometry (shared collision code)

  private setBox(x: number, y: number, z: number, margin: number, side = margin): AABB {
    const b = this.box, m = hw - side;
    b.minX = x - m; b.maxX = x + m;
    b.minY = y + margin; b.maxY = y + PHYSICS.HEIGHT - margin;
    b.minZ = z - m; b.maxZ = z + m;
    return b;
  }

  /** Does the player box at (x, y, z) overlap solid blocks (with the safety margin)? */
  inSolid(x: number, y: number, z: number): boolean {
    return boxIntersectsSolid(this.setBox(x, y, z, MOVE.MARGIN), this.world.getBlock, this.getMeta);
  }

  /** Is there something to stand on right below the feet? */
  private supported(x: number, y: number, z: number): boolean {
    // Slightly wider than the player: standing on the very edge of a block counts.
    const b = this.setBox(x, y, z, MOVE.MARGIN, -MOVE.MARGIN);
    b.minY = y - MOVE.SUPPORT_DEPTH;
    b.maxY = y + 0.1;
    return boxIntersectsSolid(b, this.world.getBlock, this.getMeta);
  }

  /** Height of the ground below (x, y, z) when it is within BOUNCE_GROUND, rounded up to 0.05; NaN when there is none. */
  private floorBelow(x: number, y: number, z: number): number {
    for (let d = 0.05; d <= MOVE.BOUNCE_GROUND + 1e-9; d += 0.05) {
      const b = this.setBox(x, y - d, z, MOVE.MARGIN, -MOVE.MARGIN);
      if (boxIntersectsSolid(b, this.world.getBlock, this.getMeta)) return y - d + 0.05;
    }
    return NaN;
  }

  /**
   * Highest floor within `r` of (x, z) that is at most STEP_HEIGHT above y (a step a player walks up without
   * jumping), or y when there is none.
   */
  private stepFloorNear(x: number, y: number, z: number, r: number): number {
    let best = y;
    for (let k = 0; k < 9; k++) {
      const a = (k / 8) * Math.PI * 2, d = k === 8 ? 0 : r;
      const g = this.floorBelow(x + Math.cos(a) * d, y + STEP_HEIGHT + 0.05, z + Math.sin(a) * d);
      if (g === g && g > best && g <= y + STEP_HEIGHT + 1e-6 && !this.inSolid(x + Math.cos(a) * d, g, z + Math.sin(a) * d)) best = g;
    }
    return best;
  }

  /** Is a jump pad the floor right below (x, z) at feet height y (the client's own test)? */
  private padAt(x: number, y: number, z: number): boolean {
    return this.world.getBlock(Math.floor(x), Math.floor(y - 0.05), Math.floor(z)) === BLOCK.JUMP_PAD;
  }

  /** Does the path (two reports back → last → this one) cross a jump pad at feet height y? */
  private padOnPath(x: number, z: number, y: number): boolean {
    for (let k = 0; k <= 8; k++) {
      const f = k / 4;
      const gx = f <= 1 ? this.px + (this.x - this.px) * f : this.x + (x - this.x) * (f - 1);
      const gz = f <= 1 ? this.pz + (this.z - this.pz) * f : this.z + (z - this.z) * (f - 1);
      if (this.padAt(gx, y, gz)) return true;
    }
    return false;
  }

  /**
   * Top of the highest jump pad that is the first solid block under the path within a pad launch's height
   * below y, or NaN (a launch from a pad, seen somewhere up its flight).
   */
  private padBelowPath(x: number, y: number, z: number): number {
    const g = this.world.getBlock;
    let best = NaN;
    const lowest = Math.floor(y - apexOf(JUMP_PAD_VELOCITY) - 1);
    for (let k = 0; k <= 8; k++) {
      const f = k / 4;
      const bx = Math.floor(f <= 1 ? this.px + (this.x - this.px) * f : this.x + (x - this.x) * (f - 1));
      const bz = Math.floor(f <= 1 ? this.pz + (this.z - this.pz) * f : this.z + (z - this.z) * (f - 1));
      for (let by = Math.floor(y - 0.05); by >= lowest; by--) {
        const id = g(bx, by, bz);
        if (id === BLOCK.JUMP_PAD) { if (!(by + 1 <= best)) best = by + 1; break; }
        if (SOLID[id]) break;
      }
    }
    return best;
  }

  /** In water or lava, or on a ladder: movement rules that replace the jump curve. */
  private inLiquidOrLadder(x: number, y: number, z: number): boolean {
    const bx = Math.floor(x), bz = Math.floor(z);
    const g = this.world.getBlock;
    const feet = g(bx, Math.floor(y + 0.4), bz), low = g(bx, Math.floor(y + 0.1), bz), head = g(bx, Math.floor(y + 1), bz);
    return feet === BLOCK.WATER || feet === BLOCK.LAVA || low === BLOCK.WATER || low === BLOCK.LAVA
      || low === BLOCK.LADDER || head === BLOCK.LADDER;
  }

  private segmentFree(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    const len = Math.hypot(bx - ax, by - ay, bz - az);
    const n = Math.ceil(len / MOVE.SAMPLE_STEP);
    for (let i = 1; i < n; i++) {
      const f = i / n;
      if (this.inSolid(ax + (bx - ax) * f, ay + (by - ay) * f, az + (bz - az) * f)) return false;
    }
    return !this.inSolid(bx, by, bz);
  }

  /** Is there any collision-free route (straight, vertical/horizontal in either order, or around a corner)? */
  private pathFree(x1: number, y1: number, z1: number): boolean {
    const x0 = this.x, y0 = this.y, z0 = this.z;
    const horizontal = Math.abs(x1 - x0) + Math.abs(z1 - z0) > 1e-6;
    // The straight line itself (a jump arcing off a crate seen across a frame hitch: neither L shape is free).
    if (horizontal && Math.abs(y1 - y0) > 1e-6 && this.segmentFree(x0, y0, z0, x1, y1, z1)) return true;
    for (let order = 0; order < 2; order++) {
      // Rising: up first is the natural order (step-up, jump), falling: sideways first (walking off a ledge).
      const upFirst = (order === 0) === (y1 >= y0);
      for (let shape = 0; shape < (horizontal ? 3 : 1); shape++) {
        let cx = x0, cy = y0, cz = z0;
        let ok = true;
        const go = (nx: number, ny: number, nz: number): void => {
          if (ok && (nx !== cx || ny !== cy || nz !== cz)) ok = this.segmentFree(cx, cy, cz, nx, ny, nz);
          cx = nx; cy = ny; cz = nz;
        };
        if (upFirst) go(cx, y1, cz);
        if (shape === 0) go(x1, cy, z1);
        else if (shape === 1) { go(x1, cy, cz); go(x1, cy, z1); } else { go(cx, cy, z1); go(x1, cy, z1); }
        if (!upFirst) go(cx, y1, cz);
        if (ok) return true;
      }
    }
    // Two straight pieces via the horizontal midpoint at either height (a jump that grazed a ceiling or a slab edge).
    if (horizontal && Math.abs(y1 - y0) > 1e-6) {
      const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
      for (const my of [y0, y1]) {
        if (this.segmentFree(x0, y0, z0, mx, my, mz) && this.segmentFree(mx, my, mz, x1, y1, z1)) return true;
      }
    }
    return horizontal && this.detourFree(x0, y0, z0, x1, y1, z1);
  }

  /** Flood fill grid of `detourFree` (0 unknown, 1 free, 2 solid, 3 queued), reused between reports. */
  private grid = new Uint8Array(0);
  private queue = new Int32Array(0);

  /**
   * Fallback of `pathFree` for a report that covers a curved route: a frame hitch on the client sends a
   * quarter second of movement at once, e.g. round the corner of a shed and past a lamp post. A flood
   * fill over a 1/8 block grid in the box spanned by both positions plus DETOUR_MARGIN, at the lower or
   * the upper height (the vertical move first or last). The margin is far too small to get round a wall.
   */
  private detourFree(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): boolean {
    if (Math.hypot(x1 - x0, z1 - z0) > MOVE.DETOUR_MAX) return false;
    const G = 0.125, M = MOVE.DETOUR_MARGIN;
    // Grid aligned to the start position, covering both ends plus the margin.
    const ox = x0 - Math.ceil((x0 - Math.min(x0, x1) + M) / G) * G;
    const oz = z0 - Math.ceil((z0 - Math.min(z0, z1) + M) / G) * G;
    const nx = Math.ceil((Math.max(x0, x1) + M - ox) / G) + 1, nz = Math.ceil((Math.max(z0, z1) + M - oz) / G) + 1;
    const n = nx * nz;
    if (this.grid.length < n) { this.grid = new Uint8Array(n * 2); this.queue = new Int32Array(n * 2); }
    const si = Math.round((x0 - ox) / G), sk = Math.round((z0 - oz) / G);
    const ti = Math.round((x1 - ox) / G), tk = Math.round((z1 - oz) / G);
    for (let order = 0; order < 2; order++) {
      const level = order === 0 ? y1 : y0;
      // Vertical move at the start (then sideways at y1) or at the end (sideways at y0 first).
      if (order === 0 ? !this.segmentFree(x0, y0, z0, x0, y1, z0) : !this.segmentFree(x1, y0, z1, x1, y1, z1)) continue;
      if (this.inSolid(x1, level, z1)) continue;
      const grid = this.grid, queue = this.queue;
      grid.fill(0, 0, n);
      let head = 0, tail = 0;
      queue[tail++] = si * nz + sk;
      grid[si * nz + sk] = 3;
      while (head < tail) {
        const c = queue[head++], i = (c / nz) | 0, k = c - i * nz;
        if (i === ti && k === tk) return true;
        for (let d = 0; d < 4; d++) {
          const ni = i + (d === 0 ? 1 : d === 1 ? -1 : 0), nk = k + (d === 2 ? 1 : d === 3 ? -1 : 0);
          if (ni < 0 || nk < 0 || ni >= nx || nk >= nz) continue;
          const nc = ni * nz + nk;
          if (grid[nc] === 0) grid[nc] = this.inSolid(ox + ni * G, level, oz + nk * G) ? 2 : 1;
          if (grid[nc] !== 1) continue;
          grid[nc] = 3;
          queue[tail++] = nc;
        }
      }
    }
    return false;
  }

  // ------------------------------------------------------------ the check

  /**
   * Checks a position report that arrived at (real) time `t`, with the client's simulation clock `step`
   * (60 Hz physics steps, see the header) when it sent one. On `ok` the position becomes the new last
   * valid one; on a violation nothing changes (apart from the clocks), and the caller rubber-bands the
   * player to (x, y, z) of this validator and calls `reset` once the client has been told. `slide` is the
   * client step of its latest slide start (arcade; with the client clock only).
   */
  check(x: number, y: number, z: number, t: number, step?: number, slide?: number): Verdict {
    const hasStep = typeof step === 'number' && Number.isFinite(step);
    if (hasStep) this.stepMode = true;
    if (!this.started) {
      this.reset(x, y, z, t);
      if (hasStep) this.lastStep = step;
      return OK;
    }
    const gap = t - this.lastPacketAt;
    this.lastPacketAt = t;
    if (gap > MOVE.STALL_GAP) this.stallUntil = t + MOVE.STALL_WINDOW;
    const lagging = t < this.stallUntil;
    const fail = (rule: Rule, weight: number, lag = false): Verdict => ({ ok: false, rule, weight: lag ? 0 : weight, lag });

    // Physics time of this report: the client's clock, kept within real time, or the arrival time.
    let tp = t;
    const stepMode = this.stepMode;
    // First report after a reset: no reference step yet. Real time since the reset stands in for the
    // client time, as an upper bound only: it neither drains the clock nor sharpens the jump curve.
    const resync = stepMode && hasStep && this.lastStep !== this.lastStep;
    if (stepMode) {
      this.clock = Math.min(MOVE.CLOCK_SECONDS, this.clock + Math.max(0, t - this.clockAt));
      this.clockAt = t;
      let dct: number;
      if (!hasStep) dct = 0;
      else if (resync) dct = Math.max(0, t - this.t);
      else dct = (step - this.lastStep) / STEPS_PER_SECOND;
      // A clock that runs backwards is a replay; one that runs ahead of real time buys movement.
      if (dct < 0) return fail('clock', 2);
      if (!resync && dct > this.clock + 1e-6) return fail('clock', 1, lagging);
      tp = this.tp + dct;
      if (hasStep && typeof slide === 'number') this.grantSlide(slide, step, tp, resync, t);
    }
    const jitter = resync ? Math.max(MOVE.JITTER, tp - this.tp) : stepMode ? MOVE.CLOCK_JITTER : MOVE.JITTER;
    // Time-based budget: tokens accrue with elapsed (physics) time, never with the number of packets.
    const dtBucket = Math.max(0, tp - this.refillAt);
    const from = this.refillAt;
    this.refillAt = tp;
    // The slide envelope: exactly the extra distance a slide (and its slide-hop momentum) can cover.
    const extra = this.slideBase > 0 ? this.slideBase * slideExtra(from - this.slideAt, tp - this.slideAt) : 0;
    this.bucketH = Math.min(this.capH(t, Math.max(from, this.slideAt)), this.bucketH + dtBucket * this.limit(t) + extra);
    this.bucketV = Math.min(this.capV(), this.bucketV + dtBucket * JV * MOVE.SPEED_ALLOWANCE);
    this.bucketVPad = Math.min(this.capV(JUMP_PAD_VELOCITY), this.bucketVPad + dtBucket * JUMP_PAD_VELOCITY * MOVE.SPEED_ALLOWANCE);

    if (this.opts.inBounds && !this.opts.inBounds(x, z)) return fail('wall', 2);
    const dx = x - this.x, dz = z - this.z, dy = y - this.y;
    const dist = Math.hypot(dx, dz);

    // Horizontal budget.
    if (dist > this.bucketH + 1e-6) {
      // Arrival times only: a lag spike excuses what the run speed covers in the real time since the last valid report.
      const excusable = !stepMode && lagging && dist <= this.limit(t) * (t - this.t + MOVE.JITTER) + MOVE.BURST_BLOCKS;
      if (dist > MOVE.TELEPORT_DISTANCE && !excusable) return fail('teleport', 3);
      return fail('speed', 1, excusable);
    }
    // Vertical budget (flight trusts the vertical axis, the walls still apply).
    const vLag = lagging && !stepMode;
    // A rise beyond a jump's budget is a pad launch, and only with a pad below the path.
    let padRise = false;
    if (!this.opts.canFly) {
      if (dy > 0 && dy > this.bucketV + 1e-6) {
        const pad = this.padBelowPath(x, y, z);
        padRise = dy <= this.bucketVPad + 1e-6 && pad === pad;
        if (!padRise) return fail('rise', 2, vLag);
      }
      if (dy < 0) {
        const fallLimit = PHYSICS.TERMINAL_VELOCITY * (Math.max(0, tp - this.tp) + jitter) + 0.5;
        if (-dy > fallLimit) return fail('fall', 1, vLag);
      }
    }
    // Geometry: inside a block, or through one.
    if (this.inSolid(x, y, z)) return fail('noclip', 3);
    if ((dist > 1e-6 || Math.abs(dy) > 1e-6) && !this.pathFree(x, y, z)) return fail('wall', 3);

    // Standing, swimming or climbing resets the air phase; otherwise follow the jump curve.
    // Liquids and ladders count when touched anywhere between the two reports (a ladder can be climbed in between).
    const grounded = this.opts.canFly || this.supported(x, y, z) || this.inLiquidOrLadder(x, y, z)
      || this.inLiquidOrLadder((x + this.x) / 2, (y + this.y) / 2, (z + this.z) / 2)
      || this.inLiquidOrLadder(this.x * 0.75 + x * 0.25, this.y * 0.75 + y * 0.25, this.z * 0.75 + z * 0.25)
      || this.inLiquidOrLadder(this.x * 0.25 + x * 0.75, this.y * 0.25 + y * 0.75, this.z * 0.25 + z * 0.75);
    let anchorV = this.anchorV;
    if (grounded) {
      this.groundY = this.anchorY = this.lowY = y;
      this.groundT = this.anchorT = tp;
      anchorV = JV;
    } else {
      let anchorY = this.anchorY, anchorT = this.anchorT, lowY = this.lowY;
      if (this.grounded) {
        anchorY = lowY = this.groundY;
        anchorT = this.groundT;
        // A long gap (frame hitch) may hide a step up (slab, stair) before the take-off, off the straight line.
        const gap = tp - this.groundT;
        if (gap > 2 * MOVE.REPORT_GAP) {
          const reach = (this.limit(t) + this.slideSpeed(this.groundT)) * gap / 2, half = Math.hypot(x - this.x, z - this.z) / 2;
          const r = Math.min(1.5, Math.sqrt(Math.max(0, reach * reach - half * half)));
          anchorY = Math.max(anchorY, this.stepFloorNear((this.x + x) / 2, this.groundY, (this.z + z) / 2, r + half));
        }
        // Left the ground: from a jump pad when one lay under the path at ground height.
        anchorV = this.padOnPath(x, z, this.groundY) ? JUMP_PAD_VELOCITY : JV;
        if (y < lowY) lowY = y;
      } else {
        if (y < lowY) lowY = y;
        // Rising with ground just below: a new jump (bunny hop) whose take-off fell between two reports.
        // Falling but above the old curve: the same, with the new jump already past its top (or cut short
        // by a ceiling: a head bump under a lamp or a deck).
        const rising = dy > 0.001;
        if (rising || y > anchorY + jumpCeiling(tp - anchorT, jitter, anchorV) + MOVE.HEIGHT_SLACK) {
          // Take-off happened somewhere between the two reports: ground below either end counts.
          // The take-off may lie up to two reports back (a report can catch the rise before it is above the last one).
          let gy = NaN;
          for (let k = 0; k <= 8; k++) {
            const f = k / 4;
            const gx = f <= 1 ? this.px + (this.x - this.px) * f : this.x + (x - this.x) * (f - 1);
            const gz = f <= 1 ? this.pz + (this.z - this.pz) * f : this.z + (z - this.z) * (f - 1);
            const g = this.floorBelow(gx, y, gz);
            if (g === g && !(g <= gy)) gy = g;
          }
          // With the client clock the window is exact; arrival times can squeeze a burst together.
          const window = stepMode ? tp - this.pt : rising ? Math.max(t - this.pt, 2 * MOVE.REPORT_GAP) : t - this.pt;
          if (gy === gy && riseTime(y - gy) <= window + MOVE.BOUNCE_SLACK) {
            anchorY = lowY = gy;
            anchorT = tp - riseTime(y - gy);
            anchorV = JV;
          }
          // A jump pad further down: a new launch from it (landed on it between two reports).
          const pad = this.padBelowPath(x, y, z);
          if (pad === pad && riseTime(y - pad, JUMP_PAD_VELOCITY) <= window + MOVE.BOUNCE_SLACK) {
            anchorY = lowY = pad;
            anchorT = tp - riseTime(y - pad, JUMP_PAD_VELOCITY);
            anchorV = JUMP_PAD_VELOCITY;
          }
        }
      }
      const ceiling = anchorY + jumpCeiling(tp - anchorT, jitter, anchorV) + MOVE.HEIGHT_SLACK;
      if (y > ceiling || y > lowY + apexOf(anchorV) + STEP_HEIGHT + MOVE.HEIGHT_SLACK) return fail('fly', 2, vLag);
      // After a resync the take-off time is unknown: the latest one that fits keeps the next reports honest.
      if (resync) anchorT = Math.max(anchorT, tp - riseTime(y - anchorY, anchorV));
      this.anchorY = anchorY; this.anchorT = anchorT; this.lowY = lowY;
    }
    this.grounded = grounded;
    this.anchorV = anchorV;

    this.bucketH -= dist;
    if (dy > 0) {
      this.bucketVPad = Math.max(0, this.bucketVPad - dy);
      this.bucketV = padRise ? 0 : this.bucketV - dy;
    }
    if (stepMode) {
      if (!resync) this.clock -= tp - this.tp;
      if (hasStep) this.lastStep = step;
    }
    this.px = this.x; this.pz = this.z; this.pt = this.tp;
    this.x = x; this.y = y; this.z = z; this.t = t; this.tp = tp;
    return OK;
  }
}
