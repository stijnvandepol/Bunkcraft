import { ARCADE_AIR_ACCEL, ARCADE_SPEED_MULT } from '../../src/modes/ArcadeLogic';
import type { BlockGetter } from '../../src/player/Collision';
import { PHYSICS } from '../../src/player/Physics';
import { type MoveInput, Player } from '../../src/player/Player';
import type { NavGraph } from './NavGraph';

/** Half the player box plus a little: the corners checked when cutting a corner of the route. */
const BODY = 0.34;
/** A route point counts as reached this close (horizontal). */
const REACH = 0.45;

/**
 * The legs of a bot: the client's own `Player` physics (same collision, step-up, jump and air control as a
 * person's browser), stepped at 60 Hz on the real clock, so every position it reports is one an honest
 * client could report. Follows a route of nav nodes, cutting corners only where the whole body fits.
 *
 * The bot counts its physics steps like the client (`pos.step`); the count never runs ahead of real time,
 * which is what the movement validator's clock check demands.
 */
export class BotMover {
  readonly body = new Player();
  /** 60 Hz physics steps simulated so far (the `step` field of position reports). */
  steps = 0;
  private acc = 0;
  route: number[] = [];
  idx = 0;
  /** World direction the bot wants to go this tick (unit or zero), and whether to jump. */
  wantX = 0;
  wantZ = 0;
  jump = false;
  /** Set when the route makes no progress (the brain plans again). */
  stuck = false;
  private bestDist = Infinity;
  private progressAt = 0;
  private readonly input: MoveInput = { forward: 0, strafe: 0, jump: false, jumpPressed: false, sprint: true, descend: false };

  constructor() {
    this.body.canFly = false;
    this.body.canSprint = true;
    this.body.airAccel = ARCADE_AIR_ACCEL;
  }

  get x(): number { return this.body.x; }
  get y(): number { return this.body.y; }
  get z(): number { return this.body.z; }

  /** The server put the bot somewhere (spawn, rubber band). */
  reset(x: number, y: number, z: number): void {
    this.body.setPosition(x, y, z);
    this.body.onGround = true;
    this.clearRoute();
  }

  clearRoute(): void {
    this.route.length = 0;
    this.idx = 0;
    this.stuck = false;
    this.bestDist = Infinity;
  }

  setRoute(nodes: readonly number[], now: number): void {
    this.route.length = 0;
    for (const n of nodes) this.route.push(n);
    // The first node is where the bot stands.
    this.idx = this.route.length > 1 ? 1 : 0;
    this.stuck = false;
    this.bestDist = Infinity;
    this.progressAt = now;
  }

  get hasRoute(): boolean {
    return this.idx < this.route.length;
  }

  /** Last node of the route (−1 without one). */
  get destination(): number {
    return this.route.length ? this.route[this.route.length - 1] : -1;
  }

  /** Can the body walk straight from (x, z) to (tx, tz) at feet height y (standing spots under every corner)? */
  private straight(g: NavGraph, x: number, y: number, z: number, tx: number, tz: number): boolean {
    const dx = tx - x, dz = tz - z, len = Math.hypot(dx, dz);
    const n = Math.max(1, Math.ceil(len / 0.4));
    for (let i = 1; i <= n; i++) {
      const px = x + (dx * i) / n, pz = z + (dz * i) / n;
      if (!g.walkable(px - BODY, y, pz - BODY) || !g.walkable(px + BODY, y, pz - BODY)
        || !g.walkable(px - BODY, y, pz + BODY) || !g.walkable(px + BODY, y, pz + BODY)) return false;
    }
    return true;
  }

  /** Steering along the route for this tick: sets want/jump, advances reached points, notices being stuck. */
  follow(g: NavGraph, now: number): void {
    this.wantX = this.wantZ = 0;
    this.jump = false;
    const b = this.body;
    while (this.idx < this.route.length) {
      const n = this.route[this.idx];
      const hd = Math.hypot(g.nx[n] - b.x, g.nz[n] - b.z);
      const dy = b.y - g.ny[n];
      if (hd < REACH && dy > -0.6 && dy < 1.3) { this.idx++; this.bestDist = Infinity; this.progressAt = now; continue; }
      break;
    }
    if (this.idx >= this.route.length) return;
    // Corner cutting: skip ahead to a later point on the same level when the whole body fits on the straight line.
    if (b.onGround) {
      for (let j = Math.min(this.route.length - 1, this.idx + 4); j > this.idx; j--) {
        const n = this.route[j];
        if (Math.abs(g.ny[n] - b.y) > 0.3) continue;
        let flat = true;
        for (let k = this.idx; k < j && flat; k++) flat = Math.abs(g.ny[this.route[k]] - g.ny[n]) < 0.3;
        if (flat && this.straight(g, b.x, b.y, b.z, g.nx[n], g.nz[n])) { this.idx = j; break; }
      }
    }
    const n = this.route[this.idx];
    const dx = g.nx[n] - b.x, dz = g.nz[n] - b.z, hd = Math.hypot(dx, dz);
    if (hd > 1e-3) { this.wantX = dx / hd; this.wantZ = dz / hd; }
    const rise = g.ny[n] - b.y;
    // A step up of more than the step height: jump at the ledge (or keep climbing a ladder).
    if (rise > 0.55 && hd < 1.6) this.jump = true;
    if (b.horizontalCollision && rise > 0.3) this.jump = true;
    if (hd < this.bestDist - 0.2) { this.bestDist = hd; this.progressAt = now; }
    else if (now - this.progressAt > 1.2) this.stuck = true;
  }

  /**
   * Runs the physics for the real time since the last call (`dt` seconds) with the steering in world
   * direction (wx, wz) while looking along `yaw`. `moveSpeed`: the weapon's speed factor (times ADS and
   * flag carrying), exactly what the client's ArcadeSession feeds its Player.
   */
  step(dt: number, wx: number, wz: number, jump: boolean, yaw: number, moveSpeed: number, getBlock: BlockGetter, getMeta?: BlockGetter): number {
    const b = this.body;
    b.yaw = yaw;
    b.speedMultiplier = ARCADE_SPEED_MULT * moveSpeed;
    const sin = Math.sin(yaw), cos = Math.cos(yaw);
    const inp = this.input;
    inp.forward = -sin * wx - cos * wz;
    inp.strafe = cos * wx - sin * wz;
    inp.jump = jump;
    inp.jumpPressed = false;
    inp.sprint = true;
    this.acc += Math.min(0.25, Math.max(0, dt));
    let n = 0;
    while (this.acc >= PHYSICS.STEP) {
      b.step(inp, getBlock, getMeta);
      this.acc -= PHYSICS.STEP;
      this.steps++;
      n++;
    }
    return n;
  }
}
