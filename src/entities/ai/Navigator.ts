import type { Mob } from '../Mob';
import { DEFAULT_PATH, Path, type PathOptions, findPath, lineWalkable } from './Pathfinder';

/** Ticks between path recomputations while following a moving target, plus a per-mob random part. */
const REPATH_CHASE = 10;
const REPATH_WALK = 20;
/** The path is dropped when the mob hardly moved for this many ticks while it should have. */
const STUCK_TICKS = 24;

/**
 * Path-following for one mob. Goals call `moveTo`; every tick the navigator hands the next waypoint to the mob's
 * move control (`mob.setMove`). Short or open routes are walked in a straight line, anything else goes through the
 * A* with a node budget and a recompute interval, and the world-wide per-tick search allowance
 * (`MobWorld.pathBudget`) keeps a crowd of mobs cheap: a mob that is refused steers straight until its next turn.
 */
export class Navigator {
  active = false;
  /** Gave up on the current destination (no path, stuck): goals check this to pick something else. */
  failed = false;
  private readonly path = new Path();
  private hasPath = false;
  private destX = 0; private destY = 0; private destZ = 0;
  private speed = 0;
  private reach = 0.6;
  private repathAt = 0;
  private stuckX = 0; private stuckZ = 0; private stuckAt = 0;
  private stuckCount = 0;
  readonly options: PathOptions = { ...DEFAULT_PATH };
  private readonly jitter = Math.floor(Math.random() * 8);

  constructor(private readonly mob: Mob) {
    this.options.height = Math.max(1, Math.ceil(mob.height - 0.01));
  }

  /** Walk to a point. `reach` is how close counts as arrived (blocks, horizontally). */
  moveTo(x: number, y: number, z: number, speed: number, reach = 0.6): void {
    const moved = !this.active || Math.abs(x - this.destX) + Math.abs(z - this.destZ) > 0.01;
    const farMoved = Math.abs(x - this.destX) + Math.abs(z - this.destZ) > 2.5;
    this.destX = x; this.destY = y; this.destZ = z;
    this.speed = speed;
    this.reach = reach;
    if (!this.active || (moved && farMoved)) {
      this.active = true;
      this.failed = false;
      this.hasPath = false;
      this.repathAt = 0;
      this.stuckCount = 0;
      this.stuckAt = this.mob.age; this.stuckX = this.mob.x; this.stuckZ = this.mob.z;
    }
  }

  stop(): void {
    this.active = false;
    this.hasPath = false;
  }

  /** The destination was reached (or the navigator is idle). */
  get done(): boolean {
    return !this.active;
  }

  /** Cells left in the current path (tests). */
  get pathLength(): number {
    return this.hasPath ? this.path.length - this.path.index : 0;
  }

  tick(): void {
    if (!this.active) return;
    const m = this.mob;
    const dx = this.destX - m.x, dz = this.destZ - m.z;
    const dist2 = dx * dx + dz * dz;
    if (dist2 < this.reach * this.reach && Math.abs(this.destY - m.y) < 2) {
      this.active = false;
      this.hasPath = false;
      return;
    }
    if (m.age >= this.repathAt) this.plan();
    let wx = this.destX, wz = this.destZ;
    if (this.hasPath) {
      const p = this.path;
      // Pass cells we are already at (also skipping over ones we cut a corner on).
      while (p.index < p.length) {
        const cx = p.cells[p.index * 3] + 0.5, cz = p.cells[p.index * 3 + 2] + 0.5;
        const ddx = cx - m.x, ddz = cz - m.z;
        if (ddx * ddx + ddz * ddz > 0.2 || Math.abs(p.cells[p.index * 3 + 1] - m.y) > 1.5) break;
        p.index++;
      }
      if (p.index >= p.length) {
        // Followed the (partial) path to its end: plan the next hop now.
        this.hasPath = false;
        this.repathAt = 0;
      } else {
        wx = p.cells[p.index * 3] + 0.5;
        wz = p.cells[p.index * 3 + 2] + 0.5;
      }
    }
    // Stuck detection: hardly any progress for a second means the path is wrong.
    if (m.age - this.stuckAt >= STUCK_TICKS) {
      if (Math.abs(m.x - this.stuckX) + Math.abs(m.z - this.stuckZ) < 0.35) {
        this.hasPath = false;
        this.repathAt = 0;
        if (++this.stuckCount >= 3) { this.failed = true; this.active = false; return; }
      } else {
        this.stuckCount = 0;
      }
      this.stuckAt = m.age; this.stuckX = m.x; this.stuckZ = m.z;
    }
    m.setMove(wx, wz, this.speed);
  }

  private plan(): void {
    const m = this.mob;
    const world = m.world;
    const sx = Math.floor(m.x), sy = Math.floor(m.y + 0.05), sz = Math.floor(m.z);
    const tx = Math.floor(this.destX), ty = Math.floor(this.destY), tz = Math.floor(this.destZ);
    const o = this.options;
    const interval = (m.target ? REPATH_CHASE : REPATH_WALK) + this.jitter;
    // Close and on the same level: no search needed.
    const near = Math.abs(tx - sx) + Math.abs(tz - sz) <= 1 && Math.abs(ty - sy) <= 1;
    if (near || (ty === sy && lineWalkable(m.getBlock, sx, sy, sz, tx, tz, o.height, o.avoidWater))) {
      this.hasPath = false;
      this.repathAt = m.age + interval;
      return;
    }
    if (world && world.pathBudget <= 0) { this.repathAt = m.age + 1; return; }
    if (world) world.pathBudget--;
    o.reach = Math.max(0, Math.min(2, this.reach - 0.5));
    this.hasPath = findPath(m.getBlock, sx, sy, sz, tx, ty, tz, o, this.path);
    this.repathAt = m.age + interval;
    if (!this.hasPath && !this.path.complete) {
      // Nothing better than where we stand: try again later and steer straight meanwhile.
      this.repathAt = m.age + interval * 2;
    }
  }
}
