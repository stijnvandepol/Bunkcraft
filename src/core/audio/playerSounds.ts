import type { AudioEngine } from '../Audio';
import { SWIM_STROKE_DISTANCE, StepCadence, moveMode } from './cadence';
import { stepSurface, type BlockSound } from './profiles';
import { SOLID, getBlockDef } from '../../world/BlockRegistry';

/** The slice of the player the movement sounds need. */
export interface MovingBody {
  x: number; y: number; z: number;
  vy: number;
  onGround: boolean;
  inWater: boolean;
  flying: boolean;
  sprinting: boolean;
  noclip: boolean;
  sneaking?: boolean;
}

/** Block under (or at) a position: returns its sound type, or null for air. */
export type SurfaceLookup = (x: number, y: number, z: number) => BlockSound | string | null;

/**
 * Turns the player's motion into footsteps, jump, landing, splash and swimming sounds. Pure bookkeeping:
 * feed it the player once per frame. Allocation-free.
 */
export class PlayerSounds {
  private readonly cadence = new StepCadence();
  private lastX = NaN;
  private lastZ = NaN;
  private wasOnGround = true;
  private wasInWater = false;
  private lastVy = 0;
  private peakY = 0;
  private swimAcc = 0;
  private surface: BlockSound | string = 'stone';

  constructor(private readonly audio: AudioEngine, private readonly surfaceAt: SurfaceLookup) {}

  /** Forget history (world change, respawn, teleport) so no phantom steps or landings sound. */
  reset(): void {
    this.lastX = NaN;
    this.wasOnGround = true;
    this.wasInWater = false;
    this.cadence.reset();
    this.swimAcc = 0;
  }

  update(p: MovingBody): void {
    const audio = this.audio;
    const moved = Number.isNaN(this.lastX) ? 0 : Math.hypot(p.x - this.lastX, p.z - this.lastZ);
    this.lastX = p.x;
    this.lastZ = p.z;
    if (moved > 5) { // teleport
      this.reset();
      this.lastX = p.x;
      this.lastZ = p.z;
      return;
    }
    if (p.noclip) {
      this.wasOnGround = true;
      return;
    }

    // Splash: entering water at speed.
    if (p.inWater && !this.wasInWater) audio.playSplash(-this.lastVy);
    this.wasInWater = p.inWater;

    // Swimming strokes.
    if (p.inWater) {
      this.swimAcc += moved;
      if (this.swimAcc >= SWIM_STROKE_DISTANCE) {
        this.swimAcc = 0;
        audio.playSwim();
      }
    } else this.swimAcc = 0;

    if (!p.onGround) {
      if (this.wasOnGround) {
        this.peakY = p.y;
        if (p.vy > 3 && !p.inWater && !p.flying) audio.playJump(this.surface);
      } else if (p.y > this.peakY) this.peakY = p.y;
    } else if (!this.wasOnGround && !p.inWater) {
      // Landing: fall distance from the highest point of this flight.
      const sound = this.lookup(p);
      audio.playLand(sound, this.peakY - p.y);
      this.cadence.reset();
    }
    this.wasOnGround = p.onGround || p.inWater;

    // Footsteps by travelled distance.
    if (p.onGround && !p.flying && !p.inWater) {
      this.surface = this.lookup(p);
      if (this.cadence.advance(moved, moveMode(p.sprinting, p.sneaking === true))) {
        audio.playStep(this.surface, moveMode(p.sprinting, p.sneaking === true), this.cadence.foot);
      }
    }
    this.lastVy = p.vy;
  }

  private lookup(p: MovingBody): BlockSound | string {
    const sound = this.surfaceAt(Math.floor(p.x), Math.floor(p.y - 0.1), Math.floor(p.z));
    return stepSurface(sound ?? 'stone', { onLadder: sound === 'ladder' });
  }
}

/** Standard surface lookup over a block getter: the sound of the solid block, null for air and liquids. */
export function surfaceLookup(getBlock: (x: number, y: number, z: number) => number): SurfaceLookup {
  return (x, y, z) => {
    const id = getBlock(x, y, z);
    if (!SOLID[id]) return null;
    return getBlockDef(id)?.sound ?? null;
  };
}
