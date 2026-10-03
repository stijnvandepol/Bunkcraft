import { QUALITY_PRESETS, type QualityPreset } from './Settings';

/** Frame rate below which the resolution drops, and at which it may rise again. */
const LOW_FPS = 48;
const HIGH_FPS = 57;
const STEP = 0.85;
/** Never render below this many device pixels per CSS pixel (0.5 = quarter of the pixels). */
const MIN_PIXEL_RATIO = 0.5;
/** The render distance is never lowered below this many chunks by the adaptive governor. */
export const MIN_ADAPTIVE_DISTANCE = 4;
/** Seconds below LOW_FPS at the minimum resolution before the render distance drops by one chunk. */
const DROP_AFTER = 3;
/** Seconds at HIGH_FPS (at full resolution) before a dropped chunk is given back; doubles after a relapse. */
const RESTORE_AFTER = 12;

/**
 * Dynamic resolution: lowers the internal render resolution when the frame rate stays
 * below target and raises it again when there is headroom. Pixel cost dominates on weak
 * integrated and ARM GPUs (and on Retina screens), so this keeps the game fluid there
 * without the player touching any setting.
 *
 * Measured in 1-second windows. A raise that immediately causes a drop locks raising out
 * for a growing period, so the scale settles instead of oscillating.
 *
 * When the frame rate stays low even at the minimum resolution (a CPU or geometry bound
 * machine), the render distance drops one chunk at a time, and returns once the game runs
 * smoothly at full resolution again.
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
  /** Chunks the user's render distance is lowered by (0 = as configured). Set `maxDistanceDrop` from the setting. */
  distanceDrop = 0;
  maxDistanceDrop = 0;
  private slowAtMin = 0;
  private restoreWindows = 0;
  private restoreAfter = RESTORE_AFTER;
  private sinceDrop = Infinity;

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
    this.sinceDrop++;
    if (this.lockout > 0) this.lockout--;
    if (this.cooldown > 0) {
      this.cooldown--;
      return false;
    }

    const minScale = Math.min(1, MIN_PIXEL_RATIO / Math.max(0.01, basePixelRatio));
    if (fps < LOW_FPS) {
      this.fastWindows = 0;
      if (this.scale <= minScale) return this.dropDistance();
      this.slowAtMin = 0;
      if (++this.slowWindows < 2) return false;
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
    this.slowAtMin = 0;
    if (fps >= HIGH_FPS && this.scale >= 1 && this.distanceDrop > this.maxDistanceDrop) {
      this.distanceDrop = this.maxDistanceDrop; // the user lowered the setting meanwhile
      return true;
    }
    if (fps >= HIGH_FPS && this.scale >= 1 && this.distanceDrop > 0) {
      if (++this.restoreWindows < this.restoreAfter) return false;
      this.restoreWindows = 0;
      this.distanceDrop--;
      this.cooldown = 2;
      return true;
    }
    this.restoreWindows = 0;
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

  /** At the minimum resolution and still too slow: one chunk less render distance after DROP_AFTER windows. */
  private dropDistance(): boolean {
    if (this.distanceDrop >= this.maxDistanceDrop || ++this.slowAtMin < DROP_AFTER) return false;
    this.slowAtMin = 0;
    // Slow again soon after giving a chunk back: wait longer before the next restore.
    if (this.sinceDrop < 60) this.restoreAfter = Math.min(240, this.restoreAfter * 2);
    this.sinceDrop = 0;
    this.distanceDrop++;
    this.cooldown = 2; // the world needs a moment to unload and settle
    return true;
  }

  private reset(): boolean {
    const changed = this.scale !== 1 || this.distanceDrop !== 0;
    this.scale = 1;
    this.distanceDrop = this.slowAtMin = this.restoreWindows = 0;
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
