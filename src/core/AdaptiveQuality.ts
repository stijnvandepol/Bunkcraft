import { QUALITY_PRESETS, type QualityPreset } from './Settings';

/** Frame rate below which the resolution drops, and at which it may rise again. */
const LOW_FPS = 48;
const HIGH_FPS = 57;
const STEP = 0.85;
/** Never render below this many device pixels per CSS pixel (0.5 = quarter of the pixels). */
const MIN_PIXEL_RATIO = 0.5;

/**
 * Dynamic resolution: lowers the internal render resolution when the frame rate stays
 * below target and raises it again when there is headroom. Pixel cost dominates on weak
 * integrated and ARM GPUs (and on Retina screens), so this keeps the game fluid there
 * without the player touching any setting.
 *
 * Measured in 1-second windows. A raise that immediately causes a drop locks raising out
 * for a growing period, so the scale settles instead of oscillating.
 */
export class DynamicResolution {
  /** Multiplier on the user's render scale, in (0, 1]. */
  scale = 1;
  enabled = true;
  private frames = 0;
  private elapsed = 0;
  private slowWindows = 0;
  private fastWindows = 0;
  private cooldown = 0;
  private lockout = 0;
  private lockoutLength = 10;
  private sinceRaise = Infinity;

  /** Call once per rendered frame with the real (unclamped) frame time. Returns true when `scale` changed. */
  update(dt: number, basePixelRatio: number): boolean {
    if (!this.enabled) return this.reset();
    // Long gaps (tab switch, breakpoint, world load) say nothing about rendering cost.
    if (dt > 0.5) {
      this.frames = 0;
      this.elapsed = 0;
      return false;
    }
    this.frames++;
    this.elapsed += dt;
    if (this.elapsed < 1) return false;
    const fps = this.frames / this.elapsed;
    this.frames = 0;
    this.elapsed = 0;
    this.sinceRaise++;
    if (this.lockout > 0) this.lockout--;
    if (this.cooldown > 0) {
      this.cooldown--;
      return false;
    }

    const minScale = Math.min(1, MIN_PIXEL_RATIO / Math.max(0.01, basePixelRatio));
    if (fps < LOW_FPS) {
      this.fastWindows = 0;
      if (++this.slowWindows < 2 || this.scale <= minScale) return false;
      this.slowWindows = 0;
      if (this.sinceRaise <= 3) {
        // The last raise was too much: stay below it for longer each time.
        this.lockout = this.lockoutLength;
        this.lockoutLength = Math.min(120, this.lockoutLength * 2);
      }
      this.scale = Math.max(minScale, this.scale * STEP);
      this.cooldown = 1; // let the new resolution settle before judging it
      return true;
    }
    this.slowWindows = 0;
    if (fps >= HIGH_FPS && this.scale < 1 && this.lockout === 0) {
      if (++this.fastWindows < 4) return false;
      this.fastWindows = 0;
      this.scale = Math.min(1, this.scale / STEP);
      this.sinceRaise = 0;
      this.cooldown = 1;
      return true;
    }
    this.fastWindows = 0;
    return false;
  }

  private reset(): boolean {
    const changed = this.scale !== 1;
    this.scale = 1;
    this.frames = this.elapsed = this.slowWindows = this.fastWindows = this.cooldown = this.lockout = 0;
    return changed;
  }
}

const SOFTWARE_GPU = /swiftshader|llvmpipe|softpipe|basic render|software/i;
const WEAK_GPU = /intel.*(hd|uhd) graphics|intel\(r\) (hd|uhd)|mali|adreno|powervr|videocore|apple a\d|gma|mesa dri intel/i;

/**
 * Starting quality preset for a first launch, from what the browser reveals. Safari reports
 * only "Apple GPU" (all Apple silicon handles Medium); dynamic resolution covers the rest.
 */
export function suggestPreset(gpuName: string, cores: number, memoryGB: number | undefined): QualityPreset {
  const low = QUALITY_PRESETS.find((p) => p.id === 'low')!;
  const medium = QUALITY_PRESETS.find((p) => p.id === 'medium')!;
  if (SOFTWARE_GPU.test(gpuName) || WEAK_GPU.test(gpuName)) return low;
  if (cores > 0 && cores <= 4) return low;
  if (memoryGB !== undefined && memoryGB <= 4) return low;
  return medium;
}
