import type { ItemStack } from '../items/ItemRegistry';
import { Entity } from './Entity';

/** A dropped item: bobs and spins, is picked up after a short delay, merges with neighbours. */
export class ItemEntity extends Entity {
  age = 0;
  pickupDelay: number;
  /** Pulled towards the player during the last ticks before pickup. */
  magnet = 0;

  constructor(public stack: ItemStack, pickupDelay = 10) {
    super(0.25, 0.25);
    this.pickupDelay = pickupDelay;
  }

  tick(getBlock: (x: number, y: number, z: number) => number): void {
    this.age++;
    if (this.pickupDelay > 0) this.pickupDelay--;
    // Despawn after 5 minutes like Minecraft.
    if (this.age > 6000) this.removed = true;
    this.physicsTick(getBlock, false);
  }
}
