import { type ItemStack, cloneStack, stackFromArray, stackToArray } from '../items/ItemRegistry';

/** Slots of a chest. */
export const CHEST_SLOTS = 27;

/**
 * Contents of the container blocks of a world (chests): the block entity data, kept outside the chunk arrays and
 * saved with the world (`WorldMeta.containers`, keyed by "x,y,z"). Singleplayer only for now: the multiplayer
 * server does not store or sync containers (docs/CONTENT.md).
 */
export class ContainerStore {
  private readonly map = new Map<string, ItemStack[]>();

  private static key(x: number, y: number, z: number): string {
    return `${x},${y},${z}`;
  }

  /** The slots of the container at a position (created empty when `create` is set). */
  slotsAt(x: number, y: number, z: number, create = true, size = CHEST_SLOTS): ItemStack[] | null {
    const key = ContainerStore.key(x, y, z);
    let slots = this.map.get(key);
    if (!slots && create) {
      slots = Array.from({ length: size }, () => ({ id: 0, count: 0 }));
      this.map.set(key, slots);
    }
    return slots ?? null;
  }

  /** Removes the container and returns what was in it (a broken chest drops its contents). */
  take(x: number, y: number, z: number): ItemStack[] {
    const key = ContainerStore.key(x, y, z);
    const slots = this.map.get(key);
    this.map.delete(key);
    return slots ? slots.filter((s) => s.count > 0).map(cloneStack) : [];
  }

  /** Forgets whatever was stored at a position (a new chest starts empty). */
  clear(x: number, y: number, z: number): void {
    this.map.delete(ContainerStore.key(x, y, z));
  }

  get size(): number {
    return this.map.size;
  }

  /** Saved form: position → one `[id, count, damage, ...data]` record per slot; empty containers are left out. */
  serialize(): Record<string, number[][]> | undefined {
    const out: Record<string, number[][]> = {};
    let any = false;
    for (const [key, slots] of this.map) {
      if (!slots.some((s) => s.count > 0)) continue;
      out[key] = slots.map(stackToArray);
      any = true;
    }
    return any ? out : undefined;
  }

  load(data: Record<string, number[][]> | undefined): void {
    this.map.clear();
    if (!data) return;
    for (const [key, records] of Object.entries(data)) {
      const slots = Array.from({ length: CHEST_SLOTS }, (_, i) => stackFromArray(records[i]) ?? { id: 0, count: 0 });
      this.map.set(key, slots);
    }
  }
}
