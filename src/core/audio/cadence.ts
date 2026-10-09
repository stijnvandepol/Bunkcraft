/** Pure movement-sound math: footstep cadence, landing thuds, swimming. No Web Audio. */

export type MoveMode = 'walk' | 'sprint' | 'sneak';

/** Distance (blocks) between footsteps per movement mode. */
export const STEP_DISTANCE: Record<MoveMode, number> = { walk: 1.45, sprint: 1.1, sneak: 1.9 };
/** Step loudness per mode. */
export const STEP_VOLUME: Record<MoveMode, number> = { walk: 1, sprint: 1.1, sneak: 0.4 };
/** Your own footsteps sit well under the mix: other players' steps (positional, in Audio) stay at full level. */
export const OWN_STEP_GAIN = 0.4;

export function moveMode(sprinting: boolean, sneaking: boolean): MoveMode {
  return sneaking ? 'sneak' : sprinting ? 'sprint' : 'walk';
}

/**
 * Accumulates travelled distance and reports when a step sound is due. Alternates feet
 * (`foot` 0/1) so the sound can alternate pitch. Allocation-free.
 */
export class StepCadence {
  private acc = 0;
  foot = 0;

  /** @returns true when a step should sound. `moved` is the distance since the last call. */
  advance(moved: number, mode: MoveMode): boolean {
    this.acc += moved;
    const d = STEP_DISTANCE[mode];
    if (this.acc < d) return false;
    this.acc -= d;
    if (this.acc > d) this.acc = 0; // a teleport or lag spike: one step, not a burst
    this.foot ^= 1;
    return true;
  }

  reset(): void {
    this.acc = 0;
  }
}

/** Landing volume (0..1.2) by fall distance in blocks; null when it is a normal step-down. */
export function landingVolume(fallDistance: number): number | null {
  if (fallDistance < 0.9) return null;
  return Math.min(1.2, 0.35 + fallDistance * 0.09);
}

/** Landing sound kind: a heavy fall (>= 3.5 blocks, damage territory) adds a body thud. */
export function landingKind(fallDistance: number): 'soft' | 'medium' | 'heavy' {
  return fallDistance >= 3.5 ? 'heavy' : fallDistance >= 1.8 ? 'medium' : 'soft';
}

/** Swim stroke interval in blocks moved. */
export const SWIM_STROKE_DISTANCE = 1.6;

/** Splash volume by entry speed (blocks/s); null below the minimum speed. */
export function splashVolume(speed: number): number | null {
  if (speed < 2.5) return null;
  return Math.min(1, 0.3 + speed * 0.045);
}
