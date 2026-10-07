import { AIM_CLIMB, type WeaponDef } from '../../src/modes/Weapons';
import type { BotSkill } from './BotSkill';

const DEG = Math.PI / 180;

/** Standard normal sample (Box-Muller) from a uniform source. */
export function gauss(rng: () => number): number {
  const u = Math.max(1e-9, rng()), v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function wrapAngle(a: number): number {
  a %= 2 * Math.PI;
  if (a > Math.PI) a -= 2 * Math.PI;
  else if (a <= -Math.PI) a += 2 * Math.PI;
  return a;
}

/** Yaw/pitch (the client's convention: yaw 0 looks along −Z, pitch > 0 up) of the direction (dx, dy, dz). */
export function yawPitchOf(dx: number, dy: number, dz: number, out: { yaw: number; pitch: number }): void {
  out.yaw = Math.atan2(-dx, -dz);
  out.pitch = Math.atan2(dy, Math.hypot(dx, dz));
}

/**
 * Human-like aim for one bot (DOM-free, no allocation per update).
 *
 * The view turns towards the aim point at a limited rate (exponential approach, capped at `turnSpeed`), so
 * a target that appears off-screen takes a visible flick, never an instant snap. On top of the perceived aim
 * point lies an error that drifts like a hand on a mouse (Ornstein-Uhlenbeck: mean-reverting noise); right
 * after a new target is acquired it starts large (`acquireError`) and settles. The bot fires when its view has
 * converged on where it *believes* the target is, so the error turns into real misses, not into waiting.
 * Recoil kicks the view up after every shot, as for a player, and the tracking pulls it back down.
 */
export class BotAim {
  yaw = 0;
  pitch = 0;
  /** Current error (radians) on yaw and pitch. */
  private errYaw = 0;
  private errPitch = 0;
  /** When the current target was acquired and when the bot is ready to shoot it. */
  acquiredAt = -1e9;
  readyAt = 0;
  targetId = 0;
  aimHead = false;
  /** Where the bot is trying to look (aim point plus error), for the fire decision. */
  private wantYaw = 0;
  private wantPitch = 0;
  private readonly tmp = { yaw: 0, pitch: 0 };

  constructor(public skill: BotSkill, private readonly rng: () => number) {}

  /** Switches to a new target: reaction delay, head or chest, and a fresh (large) acquisition error. */
  acquire(id: number, now: number): void {
    const s = this.skill;
    this.targetId = id;
    this.acquiredAt = now;
    this.readyAt = now + s.reaction * (0.75 + 0.5 * this.rng());
    this.aimHead = this.rng() < s.headChance;
    const a = this.rng() * 2 * Math.PI;
    this.errYaw = Math.cos(a) * s.acquireError * DEG;
    this.errPitch = Math.sin(a) * s.acquireError * 0.5 * DEG;
  }

  /** Forget the target (it died or went out of sight for good). */
  drop(): void {
    this.targetId = 0;
  }

  /**
   * Tracks the aim point (tx, ty, tz) from the eye (ex, ey, ez). `moving`: the bot itself walks (shakier);
   * `targetSpeed`: how fast the target moves sideways (blocks/s), harder to follow.
   */
  track(dt: number, ex: number, ey: number, ez: number, tx: number, ty: number, tz: number, moving: boolean, targetSpeed: number): void {
    const s = this.skill;
    yawPitchOf(tx - ex, ty - ey, tz - ez, this.tmp);
    // Mean-reverting error: decays over `settle` seconds towards a steady wobble of `aimError`.
    const tau = Math.max(0.05, s.settle);
    const sigma = s.aimError * DEG * (moving ? 1.25 : 1) * (1 + Math.min(1.5, targetSpeed / 10));
    const k = Math.sqrt((2 * dt) / tau) * sigma;
    this.errYaw += (-this.errYaw * dt) / tau + k * gauss(this.rng);
    this.errPitch += (-this.errPitch * dt) / tau + k * 0.6 * gauss(this.rng);
    this.wantYaw = this.tmp.yaw + this.errYaw;
    this.wantPitch = this.tmp.pitch + this.errPitch;
    this.turn(dt, this.wantYaw, this.wantPitch, s.aimRate);
  }

  /** Free look (no target): turn towards a direction at a relaxed pace. */
  look(dt: number, yaw: number, pitch: number): void {
    this.wantYaw = yaw;
    this.wantPitch = pitch;
    this.turn(dt, yaw, pitch, Math.min(5, this.skill.aimRate));
  }

  private turn(dt: number, yaw: number, pitch: number, rate: number): void {
    const f = 1 - Math.exp(-rate * dt);
    let dyaw = wrapAngle(yaw - this.yaw) * f;
    let dpitch = (pitch - this.pitch) * f;
    const max = this.skill.turnSpeed * DEG * dt;
    const len = Math.hypot(dyaw, dpitch);
    if (len > max) { dyaw *= max / len; dpitch *= max / len; }
    this.yaw = wrapAngle(this.yaw + dyaw);
    this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch + dpitch));
  }

  /** Whether the view sits on the aim point it is going for: within `fireCone` target half-widths (`halfAngle`, radians). */
  converged(halfAngle: number): boolean {
    const off = Math.hypot(wrapAngle(this.wantYaw - this.yaw) * Math.cos(this.pitch), this.wantPitch - this.pitch);
    return off <= Math.max(halfAngle * this.skill.fireCone, 0.15 * DEG);
  }

  /** The kick of one shot (`shot`: index in the recoil pattern). */
  recoil(w: WeaponDef, shot: number): void {
    this.pitch = Math.min(1.5, this.pitch + w.recoil * AIM_CLIMB * DEG);
    const p = w.pattern[shot % w.pattern.length] ?? 0;
    this.yaw = wrapAngle(this.yaw - w.recoilX * p * DEG);
  }

  /** Unit view direction (the client's convention, see AimCheck.viewDir). */
  dir(out: [number, number, number]): [number, number, number] {
    const c = Math.cos(this.pitch);
    out[0] = -Math.sin(this.yaw) * c;
    out[1] = Math.sin(this.pitch);
    out[2] = -Math.cos(this.yaw) * c;
    return out;
  }
}
