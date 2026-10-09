import { spreadPixels } from './ArcadeLogic';
import type { OpticId, WeaponDef } from './Weapons';

/**
 * Aiming math of the arcade client, pure (no DOM, no three.js): aim-down-sights curves per weapon class, look
 * sensitivity while aiming, hold/toggle aiming, the hip-fire crosshair (gap from the spread cone, bloom) and the
 * breathing sway of the open sights. The session, the HUD and the unit tests (tests/aimMath.test.ts) use it.
 */

// ---------------------------------------------------------------- aim-down-sights curves

/** How a weapon comes up: pistols and SMGs (light), rifles (medium), LMGs, snipers and the like (heavy). */
export type AdsClass = 'light' | 'medium' | 'heavy';

/**
 * Aim classes by the weapon's aim time: up to 0.14 s light, up to 0.21 s medium, slower heavy (the limits move with the
 * aim times: the aim-feel pass and the snappier-ADS pass each made weapons quicker, and every weapon kept its class).
 */
export function adsClassOf(w: Pick<WeaponDef, 'adsTime'>): AdsClass {
  return w.adsTime <= 0.14 ? 'light' : w.adsTime <= 0.21 ? 'medium' : 'heavy';
}

/** Per class: power of the rising curve (higher = more front-loaded), power of the falling curve, and how much faster letting go is. */
const ADS_SHAPE: Record<AdsClass, { rise: number; fall: number; outSpeed: number }> = {
  light: { rise: 2.6, fall: 1.9, outSpeed: 1.9 },
  medium: { rise: 2.1, fall: 1.7, outSpeed: 1.6 },
  heavy: { rise: 1.7, fall: 1.5, outSpeed: 1.4 },
};

const smooth = (t: number) => t * t * (3 - 2 * t);
const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);

/**
 * Visual aim blend (0..1) while raising the sights, from the linear progress `t` (0 = hip, 1 = fully aimed). Front-loaded:
 * the view starts moving at once and settles on the sights (a plain smoothstep starts from rest and feels late).
 * Heavy weapons mix in a smoothstep so they still feel weighty.
 */
export function adsEaseIn(t: number, cls: AdsClass): number {
  const x = clamp01(t);
  const out = 1 - Math.pow(1 - x, ADS_SHAPE[cls].rise);
  return cls === 'heavy' ? out * 0.6 + smooth(x) * 0.4 : out;
}

/** Visual blend while lowering the sights: the view leaves the sights quickly and eases onto the hip pose. */
export function adsEaseOut(t: number, cls: AdsClass): number {
  return Math.pow(clamp01(t), ADS_SHAPE[cls].fall);
}

/** How many times faster than raising the sights are lowered (the time to leave the sights is `adsTime / this`). */
export function adsOutSpeed(cls: AdsClass): number {
  return ADS_SHAPE[cls].outSpeed;
}

/** Shortest aim time the blend model assumes (seconds). */
export const ADS_MIN_SECONDS = 0.05;

/**
 * One step of the linear aim progress (0 = hip, 1 = fully aimed): rises in `seconds` while aiming, falls `adsOutSpeed` times
 * faster when the sights go down. Closed form for a stretch of constant intent, so the server can evaluate a whole
 * interval in one call and land exactly where the client's frame-by-frame blend (`AdsBlend`) is.
 */
export function adsStep(t: number, dt: number, want: boolean, seconds: number, cls: AdsClass): number {
  const sec = Math.max(ADS_MIN_SECONDS, seconds);
  return want ? Math.min(1, t + dt / sec) : Math.max(0, t - (dt * adsOutSpeed(cls)) / sec);
}

/**
 * The aim blend over time. `t` is linear in the weapon's aim time (what the gameplay uses: movement speed, the
 * accuracy the server is told), `eased` is what the eye sees. Reversing mid-way keeps the picture continuous: the gap
 * between the old and the new curve is carried over and fades out, so nothing ever jumps.
 */
export class AdsBlend {
  /** Linear progress 0..1. */
  t = 0;
  /** Eased blend 0..1 for the view (FOV, weapon pose, crosshair fade). */
  eased = 0;
  private rising = true;
  private carry = 0;
  /** Linear progress at the moment of the last reversal. */
  private turnAt = 0;

  update(dt: number, want: boolean, seconds: number, cls: AdsClass): void {
    this.t = adsStep(this.t, dt, want, seconds, cls);
    const raw = want ? adsEaseIn(this.t, cls) : adsEaseOut(this.t, cls);
    if (want !== this.rising) {
      this.rising = want;
      this.carry = this.eased - raw;
      this.turnAt = this.t;
    }
    this.carry *= Math.exp(-dt * 14);
    // The carried gap shrinks to nothing on the way to the end the blend travels towards: hip and fully aimed stay exact.
    const span = want ? 1 - this.turnAt : this.turnAt;
    const left = want ? 1 - this.t : this.t;
    this.eased = clamp01(raw + (span > 1e-6 ? this.carry * clamp01(left / span) : 0));
  }

  reset(): void {
    this.t = this.eased = this.carry = this.turnAt = 0;
    this.rising = true;
  }
}

/** Hold the button to aim, or press once to aim and again to stop. */
export type AdsMode = 'hold' | 'toggle';

/**
 * Turns the aim button into "want to aim". Toggle mode keeps aiming after the button comes up; `cancel` (reload, switching
 * weapons, dying) puts the sights down again, and so does a second press.
 */
export class AdsInput {
  private on = false;

  update(mode: AdsMode, down: boolean, pressed: boolean, cancel: boolean): boolean {
    if (cancel) this.on = false;
    if (mode === 'hold') {
      this.on = false;
      return down && !cancel;
    }
    if (pressed && !cancel) this.on = !this.on;
    return this.on;
  }

  reset(): void {
    this.on = false;
  }
}

// ---------------------------------------------------------------- look sensitivity while aiming

/** How the sensitivity follows the zoom: with the field-of-view ratio (uniform angular speed) or so that the cursor covers the same screen distance. */
export type AdsScaling = 'uniform' | 'monitor';

/**
 * Multiplier for the look sensitivity at a point of the aim blend.
 * - `zoom`: field of view multiplier of the optic when fully aimed (0.25 = four times the zoom),
 * - `baseFovDeg`: the vertical field of view from the hip,
 * - `percent`: the "ADS sensitivity" setting (100 = the scaling alone),
 * - `blend`: 0..1 how far the sights are up (the multiplier moves from 1 to its full value with it).
 * `uniform` scales with the field of view ratio, so a degree of mouse turn moves the aim by the same share of the view at every
 * zoom; `monitor` matches the distance on screen at the centre (tan of the half angles), a little slower at high zoom.
 */
export function adsSensitivity(zoom: number, baseFovDeg: number, scaling: AdsScaling, percent: number, blend: number): number {
  const z = Math.max(0.05, Math.min(1, zoom));
  let k = z;
  if (scaling === 'monitor') {
    const half = (Math.max(10, Math.min(170, baseFovDeg)) * Math.PI) / 360;
    k = Math.tan(half * z) / Math.tan(half);
  }
  const full = k * Math.max(0, percent) / 100;
  return 1 + (full - 1) * clamp01(blend);
}

// ---------------------------------------------------------------- crosshair

/** Smallest and largest gap (pixels from the centre to the crosshair lines) the HUD draws. */
export const CROSSHAIR_MIN_GAP = 3;
export const CROSSHAIR_MAX_GAP = 140;

/** The gap of the hip-fire crosshair: the spread cone as drawn on screen, never closer than the minimum. */
export function crosshairGap(spreadDeg: number, fovDeg: number, height: number): number {
  const px = spreadPixels(spreadDeg, fovDeg, height);
  return Math.max(CROSSHAIR_MIN_GAP, Math.min(CROSSHAIR_MAX_GAP, px));
}

/**
 * How visible the hip-fire crosshair is while the sights come up: fully at the hip, gone once the blend passes
 * `CROSSHAIR_FADE_END` (the sights or the reticle are the crosshair then).
 */
export const CROSSHAIR_FADE_END = 0.4;
export function crosshairAlpha(adsEased: number): number {
  return clamp01(1 - adsEased / CROSSHAIR_FADE_END);
}

/**
 * The gap the crosshair shows: opens at once to the real spread (it must never promise more accuracy than there is) and
 * closes smoothly, so stopping or landing reads as the crosshair settling.
 */
export class CrosshairBloom {
  gap = CROSSHAIR_MIN_GAP;

  update(dt: number, target: number): number {
    if (target >= this.gap) this.gap = target;
    else this.gap = target + (this.gap - target) * Math.exp(-dt * 14);
    return this.gap;
  }

  reset(): void {
    this.gap = CROSSHAIR_MIN_GAP;
  }
}

export type CrosshairStyle = 'cross' | 'dot' | 'circle';
export type CrosshairColor = 'white' | 'green' | 'cyan' | 'yellow' | 'red' | 'pink';

export const CROSSHAIR_COLORS: Record<CrosshairColor, string> = {
  white: '#ffffff', green: '#4dff6a', cyan: '#43e8ff', yellow: '#ffe94a', red: '#ff4a4a', pink: '#ff6ad5',
};

// ---------------------------------------------------------------- sway

/**
 * Whether aiming through an optic sways the aim. Only the sniper scope does (ScopeBreath: small, steadied with Shift, calm
 * right after scoping in). Iron sights, red dot, holographic sight and the combat scope are rock steady: the aim-feel pass
 * removed their 0.07-0.17 degree drift, which moved the reticle off a target the player was holding still on.
 */
export function opticSways(optic: OpticId): boolean {
  return optic === 'scope';
}

// ---------------------------------------------------------------- settle

/**
 * The weapon model's settle when the sights arrive (visual only, the reticle stays on the aim point): a short damped dip
 * of `SETTLE_SEC`, peak `SETTLE_DEG` degrees of rotation about the sight. Returns the rotation (degrees) `t` seconds after
 * the sights came fully up; 0 outside the window.
 */
export const SETTLE_SEC = 0.14;
export const SETTLE_DEG = 0.9;
export function adsSettle(t: number): number {
  if (!(t >= 0) || t >= SETTLE_SEC) return 0;
  const x = t / SETTLE_SEC;
  return SETTLE_DEG * Math.sin(x * Math.PI) * (1 - x);
}
