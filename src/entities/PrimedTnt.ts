import { Entity } from './Entity';

/** Minecraft's default fuse: 80 ticks (4 seconds). */
export const TNT_FUSE = 80;

/**
 * Lit TNT: a falling block-sized entity that explodes (power 4) when its fuse runs out.
 * Ignited by flint and steel, or with a short random fuse by a nearby explosion.
 */
export class PrimedTnt extends Entity {
  fuse: number;

  constructor(fuse = TNT_FUSE) {
    super(0.98, 0.98);
    this.fuse = fuse;
    // Minecraft gives lit TNT a small hop in a random direction.
    const a = Math.random() * Math.PI * 2;
    this.vx = -Math.sin(a) * 0.4;
    this.vz = -Math.cos(a) * 0.4;
    this.vy = 4;
  }

  /** Returns true on the tick it explodes. */
  tick(getBlock: (x: number, y: number, z: number) => number): boolean {
    this.physicsTick(getBlock, false);
    if (--this.fuse > 0) return false;
    this.removed = true;
    return true;
  }
}
