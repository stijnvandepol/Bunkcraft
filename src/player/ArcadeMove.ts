import { BLOCK } from '../world/BlockRegistry';
import { PHYSICS } from './Physics';

/**
 * Arcade movement numbers (slide, slide-hop, bunny hop momentum, air strafe, crouch, jump pads), shared
 * by the client physics (`Player` with `arcadeMove`) and the server's movement validator, which models
 * the slide burst exactly from these constants (see server/anticheat/Movement.ts). Change them together.
 *
 * The one rule that keeps the server model exact: the slide boost is the only way to go faster than the
 * run speed `S`, and every way of moving decays the excess over `S` at least as fast as AIR_DRAG. So after
 * a slide that started at time ts, the horizontal speed is at most S · (1 + BOOST · e^(−AIR_DRAG·(t − ts))).
 */
export const SLIDE = {
  /** Peak speed of a slide: the run speed times (1 + BOOST). */
  BOOST: 0.45,
  /** A slide needs at least this share of the run speed. */
  MIN_SPEED: 0.6,
  /** Decay rate (1/s) of the speed above the run speed while sliding on the ground. */
  FRICTION: 2.4,
  /** Decay rate (1/s) of the speed above the run speed in the air (slide-hop and bunny hop momentum). */
  AIR_DRAG: 0.8,
  /** A slide ends after this much ground time... */
  MAX_TIME: 0.8,
  /** ...or when the speed above the run speed falls under this share of the run speed. */
  END_EXCESS: 0.06,
  /** Seconds between two slide starts. */
  COOLDOWN: 0.9,
  /** Turn rate (1/s) of the slide direction towards the input (curve slide). */
  STEER: 2.5,
} as const;

/** Turn rate (1/s) of the velocity towards the input while airborne with momentum (air strafe). */
export const AIR_STEER = 4;

/** Crouching: slower, lower eye and a lower hitbox. Sliding is lower still. */
export const POSE = {
  CROUCH_SPEED: 0.55,
  CROUCH_EYE: 1.27,
  CROUCH_HEIGHT: 1.5,
  SLIDE_EYE: 1.0,
  SLIDE_HEIGHT: 1.15,
  /** Rate (1/s) at which the eye follows the pose (smooth camera). */
  EYE_RATE: 16,
} as const;

/** Jump pad: launch speed straight up (blocks/s); the horizontal speed is kept. */
export const JUMP_PAD_VELOCITY = 16;
/** Highest point of a jump pad launch above the pad (continuous model). */
export const JUMP_PAD_APEX = (JUMP_PAD_VELOCITY * JUMP_PAD_VELOCITY) / (2 * PHYSICS.GRAVITY);

/** Slide cooldown for a perk (Lightfoot shortens it). */
export function slideCooldown(lightfoot: boolean): number {
  return lightfoot ? 0.65 : SLIDE.COOLDOWN;
}

/** Hitbox height of a pose (flags of a `pos` report; see SNAP_FLAG_CROUCH / SNAP_FLAG_SLIDE in protocol.ts). */
export function poseHeight(crouch: boolean, slide: boolean, standing: number): number {
  return slide ? POSE.SLIDE_HEIGHT : crouch ? POSE.CROUCH_HEIGHT : standing;
}

/** Eye height of a pose. */
export function poseEye(crouch: boolean, slide: boolean): number {
  return slide ? POSE.SLIDE_EYE : crouch ? POSE.CROUCH_EYE : PHYSICS.EYE_HEIGHT;
}

/**
 * Upper bound of the horizontal speed `t` seconds after a slide start, as a multiple of the run speed:
 * 1 + BOOST·e^(−AIR_DRAG·t). The server's speed envelope.
 */
export function slideEnvelope(t: number): number {
  return 1 + SLIDE.BOOST * Math.exp(-SLIDE.AIR_DRAG * Math.max(0, t));
}

/**
 * Extra distance (in units of the run speed × seconds) the envelope allows over [t0, t1] beyond running:
 * ∫ BOOST·e^(−AIR_DRAG·t) dt, with times measured from the slide start (clamped at 0).
 */
export function slideExtra(t0: number, t1: number): number {
  const a = Math.max(0, t0), b = Math.max(a, t1);
  return (SLIDE.BOOST / SLIDE.AIR_DRAG) * (Math.exp(-SLIDE.AIR_DRAG * a) - Math.exp(-SLIDE.AIR_DRAG * b));
}

/** Slowest arcade run speed (blocks/s): the heaviest weapon (0.88) at the always-sprint pace. Pad reach uses it. */
const SLOWEST_RUN = PHYSICS.SPRINT_SPEED * 1.3 * 0.88;

/** Horizontal distance a pad launch covers before it comes back down to `dh` blocks above the pad (slowest runner). */
export function padReach(dh: number): number {
  const v = JUMP_PAD_VELOCITY, g = PHYSICS.GRAVITY;
  const d = v * v - 2 * g * dh;
  if (d < 0) return 0;
  return SLOWEST_RUN * ((v + Math.sqrt(d)) / g);
}

/**
 * Standing spots a jump pad at block (x, y, z) reaches that walking cannot: surfaces (the solid block's y) from
 * y + 1 up to the launch apex within `padReach` (minus half a block) of the pad centre, with a free column
 * over the pad and over the target, and free body room at landing height on the way. For map tests and
 * scans (reachability); `out` receives [x, z, y] triples. Fences and walls (TALL) are no landing.
 */
export function padLandings(
  at: (x: number, y: number, z: number) => number, solid: (id: number) => boolean, x: number, y: number, z: number,
  out: [number, number, number][],
): void {
  const top = Math.floor(JUMP_PAD_APEX);
  for (let h = 1; h <= top + 2; h++) if (at(x, y + h, z) !== BLOCK.AIR) return;
  for (let ny = y + 1; ny <= y + top; ny++) {
    const r = padReach(ny - y) - 0.5;
    const ri = Math.ceil(r);
    for (let dz = -ri; dz <= ri; dz++) {
      for (let dx = -ri; dx <= ri; dx++) {
        if ((dx === 0 && dz === 0) || Math.hypot(dx, dz) > r) continue;
        const nx = x + dx, nz = z + dz;
        if (!solid(at(nx, ny, nz)) || at(nx, ny + 1, nz) !== BLOCK.AIR || at(nx, ny + 2, nz) !== BLOCK.AIR) continue;
        // The body passes over everything between at landing height.
        const n = Math.ceil(Math.hypot(dx, dz) * 2);
        let free = true;
        for (let k = 1; k < n && free; k++) {
          const cx = Math.floor(x + 0.5 + (dx * k) / n), cz = Math.floor(z + 0.5 + (dz * k) / n);
          free = at(cx, ny + 1, cz) === BLOCK.AIR && at(cx, ny + 2, cz) === BLOCK.AIR;
        }
        if (free) out.push([nx, nz, ny]);
      }
    }
  }
}

/** Is there a jump pad right below a player's feet at (x, y, z) (centre column)? */
export function padBelow(getBlock: (x: number, y: number, z: number) => number, x: number, y: number, z: number): boolean {
  return getBlock(Math.floor(x), Math.floor(y - 0.05), Math.floor(z)) === BLOCK.JUMP_PAD;
}
