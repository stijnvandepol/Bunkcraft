import { HITBOX } from '../../src/modes/Weapons';
import { PHYSICS } from '../../src/player/Physics';
import { OPAQUE } from '../../src/world/BlockRegistry';
import type { BlockQuery } from '../Combat';

/**
 * Anti-wallhack: which enemies a player's snapshot may contain (DOM-free). An enemy is sent when
 *  (a) there is a line of sight from the recipient's eye, now or anywhere in its last HISTORY seconds,
 *      to one of three body points (feet, chest, head), with a sideways margin around chest and head, or
 *  (b) it is within RANGE blocks, or
 *  (c) it fired within FIRE_REVEAL seconds (the tracer reveals it anyway).
 * Teammates (team games) and anything a dead recipient spectates are always sent. When an enemy drops
 * out, its last sent position goes out with the stale flag for STALE seconds, then nothing.
 *
 * Line of sight is cached per pair and recomputed every CHECK_INTERVAL seconds (pairs are staggered so
 * the cost spreads over the ticks). Only opaque full blocks stop sight; glass, slabs, fences and
 * plants never hide anybody (conservative: when unsure, the enemy is sent).
 */
export const VIS = {
  RANGE: 12,
  FIRE_REVEAL: 0.5,
  HISTORY: 0.5,
  CHECK_INTERVAL: 0.1,
  STALE: 0.3,
  /** Sideways offset of the extra chest/head points (blocks): a little wider than the body (0.3). */
  MARGIN: 0.45,
} as const;

/** Player state the culling needs, refreshed by the caller every tick. */
export interface Viewer {
  id: number;
  team: string;
  alive: boolean;
  x: number; y: number; z: number;
  /** Seconds (same clock as `now`) of the last shot, or a large negative number. */
  firedAt: number;
}

/** What to send about one target: nothing, its current position, or its last visible one as stale. */
export const Send = { None: 0, Fresh: 1, Stale: 2 } as const;
export type Send = typeof Send[keyof typeof Send];

interface Pair {
  checkAt: number;
  los: boolean;
  /** Last time the target was sendable fresh to this recipient. */
  visAt: number;
  /** The position that went out last while fresh. */
  x: number; y: number; z: number;
}

/** Eye samples kept for the history rule: one every HISTORY / 3 seconds. */
const HISTORY_SLOTS = 4;
const TRACK_INTERVAL = VIS.HISTORY / 3;
const BODY = [0.2, HITBOX.height / 2, HITBOX.height - HITBOX.head / 2];

interface Trail { xs: Float64Array; ys: Float64Array; zs: Float64Array; ts: Float64Array; head: number; n: number }

/** True when no opaque block lies between the two points (Amanatides & Woo; end voxels excluded). */
export function sightClear(blocks: BlockQuery, ox: number, oy: number, oz: number, tx: number, ty: number, tz: number): boolean {
  const dxr = tx - ox, dyr = ty - oy, dzr = tz - oz;
  const len = Math.hypot(dxr, dyr, dzr);
  if (len < 1e-6) return true;
  const dx = dxr / len, dy = dyr / len, dz = dzr / len;
  let x = Math.floor(ox), y = Math.floor(oy), z = Math.floor(oz);
  const ex = Math.floor(tx), ey = Math.floor(ty), ez = Math.floor(tz);
  const stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
  const tDeltaX = dx === 0 ? Infinity : Math.abs(1 / dx);
  const tDeltaY = dy === 0 ? Infinity : Math.abs(1 / dy);
  const tDeltaZ = dz === 0 ? Infinity : Math.abs(1 / dz);
  let tMaxX = dx === 0 ? Infinity : (dx > 0 ? x + 1 - ox : ox - x) * tDeltaX;
  let tMaxY = dy === 0 ? Infinity : (dy > 0 ? y + 1 - oy : oy - y) * tDeltaY;
  let tMaxZ = dz === 0 ? Infinity : (dz > 0 ? z + 1 - oz : oz - z) * tDeltaZ;
  for (let guard = 0; guard < 512; guard++) {
    let t: number;
    if (tMaxX < tMaxY && tMaxX < tMaxZ) { t = tMaxX; x += stepX; tMaxX += tDeltaX; } else if (tMaxY < tMaxZ) { t = tMaxY; y += stepY; tMaxY += tDeltaY; } else { t = tMaxZ; z += stepZ; tMaxZ += tDeltaZ; }
    if (t >= len || (x === ex && y === ey && z === ez)) return true;
    if (OPAQUE[blocks.getBlock(x, y, z)]) return false;
  }
  return true;
}

export class Visibility {
  private readonly pairs = new Map<number, Pair>();
  private readonly trails = new Map<number, Trail>();
  /** Line-of-sight rays cast so far (for the benchmark). */
  rays = 0;

  constructor(private readonly blocks: BlockQuery) {}

  /** Records eye positions (one per HISTORY / 3 seconds) for the history rule; call once per tick. */
  track(v: Viewer, now: number): void {
    let tr = this.trails.get(v.id);
    if (!tr) {
      tr = { xs: new Float64Array(HISTORY_SLOTS), ys: new Float64Array(HISTORY_SLOTS), zs: new Float64Array(HISTORY_SLOTS), ts: new Float64Array(HISTORY_SLOTS).fill(-1e9), head: 0, n: 0 };
      this.trails.set(v.id, tr);
    }
    const last = (tr.head + HISTORY_SLOTS - 1) % HISTORY_SLOTS;
    if (tr.n > 0 && now - tr.ts[last] < TRACK_INTERVAL - 1e-6) return;
    tr.xs[tr.head] = v.x; tr.ys[tr.head] = v.y + PHYSICS.EYE_HEIGHT; tr.zs[tr.head] = v.z; tr.ts[tr.head] = now;
    tr.head = (tr.head + 1) % HISTORY_SLOTS;
    if (tr.n < HISTORY_SLOTS) tr.n++;
  }

  /** A player left, or respawned (its history no longer says anything). */
  forget(id: number): void {
    this.trails.delete(id);
    const low = id & 0xffff;
    for (const k of this.pairs.keys()) if (k >>> 16 === low || (k & 0xffff) === low) this.pairs.delete(k);
  }

  /** The server moved a player (spawn): its old eye positions must not reveal anything. */
  resetTrail(id: number): void {
    this.trails.delete(id);
  }

  /**
   * Decides what `recipient` gets about `target` this tick. For Stale the position to send is written
   * to `out` (the last one sent fresh); for Fresh the caller sends the current position.
   */
  select(recipient: Viewer, target: Viewer, teams: boolean, now: number, out: { x: number; y: number; z: number }): Send {
    if (!recipient.alive || (teams && recipient.team !== '' && recipient.team === target.team)) return Send.Fresh;
    const key = ((recipient.id & 0xffff) << 16 | (target.id & 0xffff)) >>> 0;
    let p = this.pairs.get(key);
    if (!p) {
      // Stagger the first check so 16 players do not all recompute on the same tick.
      p = { checkAt: now - ((recipient.id * 7 + target.id * 13) % 3) * (VIS.CHECK_INTERVAL / 3), los: this.lineOfSight(recipient, target), visAt: -1e9, x: 0, y: 0, z: 0 };
      this.pairs.set(key, p);
    }
    let fresh = now - target.firedAt <= VIS.FIRE_REVEAL
      || Math.hypot(target.x - recipient.x, target.y - recipient.y, target.z - recipient.z) <= VIS.RANGE;
    if (!fresh) {
      if (now - p.checkAt >= VIS.CHECK_INTERVAL) {
        p.checkAt = now;
        p.los = this.lineOfSight(recipient, target);
      }
      fresh = p.los;
    }
    if (fresh) {
      p.visAt = now;
      p.x = target.x; p.y = target.y; p.z = target.z;
      return Send.Fresh;
    }
    if (now - p.visAt <= VIS.STALE) {
      out.x = p.x; out.y = p.y; out.z = p.z;
      return Send.Stale;
    }
    return Send.None;
  }

  /** From the current eye or any recorded eye of the last HISTORY seconds to the target's body (with margin). */
  lineOfSight(r: Viewer, t: Viewer): boolean {
    if (this.fromEye(r.x, r.y + PHYSICS.EYE_HEIGHT, r.z, t, true)) return true;
    const tr = this.trails.get(r.id);
    if (!tr) return false;
    const newest = tr.ts[(tr.head + HISTORY_SLOTS - 1) % HISTORY_SLOTS];
    for (let i = 0; i < tr.n; i++) {
      if (newest - tr.ts[i] > VIS.HISTORY + 1e-6) continue;
      if (this.fromEye(tr.xs[i], tr.ys[i], tr.zs[i], t, false)) return true;
    }
    return false;
  }

  private fromEye(ex: number, ey: number, ez: number, t: Viewer, margin: boolean): boolean {
    for (const h of BODY) {
      this.rays++;
      if (sightClear(this.blocks, ex, ey, ez, t.x, t.y + h, t.z)) return true;
    }
    if (!margin) return false;
    // Margin: points beside chest and head, perpendicular to the line of sight (corners, peeking).
    const hx = t.x - ex, hz = t.z - ez, hl = Math.hypot(hx, hz) || 1;
    const sx = (-hz / hl) * VIS.MARGIN, sz = (hx / hl) * VIS.MARGIN;
    for (let k = 1; k < 3; k++) {
      const py = t.y + BODY[k];
      this.rays += 2;
      if (sightClear(this.blocks, ex, ey, ez, t.x + sx, py, t.z + sz)) return true;
      if (sightClear(this.blocks, ex, ey, ez, t.x - sx, py, t.z - sz)) return true;
    }
    return false;
  }
}
