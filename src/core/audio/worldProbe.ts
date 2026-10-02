import { estimateEnclosure, scanFluids, type AudioEnvironment } from './environment';
import { countSolidAlong } from './spatial';

/** World access the probe needs, so it carries no dependency on `World`. */
export interface ProbeWorld {
  getBlock(x: number, y: number, z: number): number;
  getMeta(x: number, y: number, z: number): number;
  /** Packed light: sky << 4 | block. */
  getLight(x: number, y: number, z: number): number;
  biomeAt(x: number, z: number): number;
}

export interface ProbeIds {
  water: number;
  lava: number;
  fire?: number;
}

/**
 * Samples the world around the listener into an {@link AudioEnvironment} a couple of times per second:
 * sky light at the head, enclosure (rays), biome, nearest lava and flowing water. The work is spread so
 * each call does one task, keeping the per-frame cost far below the 0.3 ms audio budget.
 */
export class WorldAudioProbe {
  private t = 0;
  private task = 0;

  constructor(private readonly world: ProbeWorld, private readonly isSolid: (x: number, y: number, z: number) => boolean, private readonly ids: ProbeIds) {}

  /** `dayFactor` from DayCycle; call every frame (it only samples every 0.15 s, one task at a time). */
  update(dt: number, env: AudioEnvironment, x: number, y: number, z: number, dayFactor: number, underwater: boolean): void {
    env.x = x; env.y = y; env.z = z;
    env.dayFactor = dayFactor;
    env.underwater = underwater;
    this.t += dt;
    if (this.t < 0.15) return;
    this.t = 0;
    const w = this.world;
    switch (this.task++ % 4) {
      case 0:
        env.skyLight = w.getLight(Math.floor(x), Math.floor(y), Math.floor(z)) >> 4;
        env.biome = w.biomeAt(Math.floor(x), Math.floor(z));
        break;
      case 1:
      case 3:
        env.enclosure += (estimateEnclosure(this.isSolid, x, y, z) - env.enclosure) * 0.6;
        break;
      case 2:
        scanFluids(env, (a, b, c) => w.getBlock(a, b, c), (a, b, c) => w.getMeta(a, b, c), this.ids);
        break;
    }
  }

  /** Occlusion probe for the engine: solid blocks on the line between two points. */
  occlusion = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number =>
    countSolidAlong(this.isSolid, x0, y0, z0, x1, y1, z1);
}
