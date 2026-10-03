import type { AudioEngine } from '../Audio';
import type { SurfaceLookup } from './playerSounds';

/** The slice of a mob that footsteps need. */
export interface SteppingMob {
  x: number; y: number; z: number;
  onGround: boolean;
  removed?: boolean;
  type: { kind: string };
  dead?: boolean;
}

/** Distance between footfalls per mob kind (blocks). */
const STRIDE: Record<string, number> = { pig: 0.8, cow: 1.0, sheep: 0.8, chicken: 0.45, zombie: 1.1, skeleton: 1.0, creeper: 0.8, spider: 0.55 };
const AUDIBLE = 18;

interface StepState { x: number; z: number; acc: number }

/**
 * Footsteps for mobs near the listener, from their travelled distance. Call once per game tick (20 Hz) with
 * the mob list; state is kept per mob in a WeakMap, so it needs no field on `Mob`.
 */
export class MobSteps {
  private readonly state = new WeakMap<object, StepState>();

  constructor(private readonly audio: AudioEngine, private readonly surfaceAt: SurfaceLookup) {}

  update(mobs: readonly SteppingMob[], listenerX: number, listenerZ: number): void {
    for (let i = 0; i < mobs.length; i++) {
      const m = mobs[i];
      if (m.removed || m.dead) continue;
      let s = this.state.get(m);
      if (!s) {
        s = { x: m.x, z: m.z, acc: 0 };
        this.state.set(m, s);
        continue;
      }
      const moved = Math.hypot(m.x - s.x, m.z - s.z);
      s.x = m.x;
      s.z = m.z;
      if (!m.onGround || moved > 3) { s.acc = 0; continue; }
      if (Math.abs(m.x - listenerX) > AUDIBLE || Math.abs(m.z - listenerZ) > AUDIBLE) continue;
      s.acc += moved;
      const stride = STRIDE[m.type.kind] ?? 0.9;
      if (s.acc >= stride) {
        s.acc -= stride;
        const surface = this.surfaceAt(Math.floor(m.x), Math.floor(m.y - 0.1), Math.floor(m.z)) ?? 'stone';
        this.audio.playMobStep(m.type.kind, surface, m);
      }
    }
  }
}
