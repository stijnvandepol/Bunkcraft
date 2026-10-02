import { type ItemStack, getItemDef, maxDurability } from './ItemRegistry';

export const HOTBAR_SLOTS = 9;
export const INVENTORY_SLOTS = 36; // 0–8 hotbar, 9–35 main inventory

/** Player inventory as plain stacks; empty slots have id 0. */
export class PlayerInventory {
  readonly slots: ItemStack[] = Array.from({ length: INVENTORY_SLOTS }, () => ({ id: 0, count: 0 }));
  /** Fired after any change (UI refresh, autosave). */
  onChange: (() => void) | null = null;
  /** Fired with the item id whenever `add` stored something (pickup, crafting, smelting). */
  onAdd: ((id: number) => void) | null = null;

  static maxStack(id: number): number {
    return getItemDef(id)?.maxStack ?? 64;
  }

  get(i: number): ItemStack {
    return this.slots[i];
  }

  set(i: number, stack: ItemStack): void {
    this.slots[i] = stack.count > 0 && stack.id > 0 ? { ...stack } : { id: 0, count: 0 };
    this.onChange?.();
  }

  clear(): void {
    for (let i = 0; i < INVENTORY_SLOTS; i++) this.slots[i] = { id: 0, count: 0 };
    this.onChange?.();
  }

  /** Whether `add` would take the whole stack (checked before asking a server for an item). */
  canFit(stack: ItemStack): boolean {
    let left = stack.count;
    const max = PlayerInventory.maxStack(stack.id);
    for (const s of this.slots) {
      if (s.id === 0) left -= max;
      else if (max > 1 && s.id === stack.id && s.count < max) left -= max - s.count;
      if (left <= 0) return true;
    }
    return false;
  }

  /** Adds a stack, merging into existing stacks first (hotbar before main). Returns what didn't fit. */
  add(stack: ItemStack): number {
    let left = stack.count;
    const max = PlayerInventory.maxStack(stack.id);
    if (max > 1) {
      for (const s of this.slots) {
        if (left === 0) break;
        if (s.id === stack.id && s.count < max) {
          const n = Math.min(left, max - s.count);
          s.count += n;
          left -= n;
        }
      }
    }
    for (let i = 0; i < INVENTORY_SLOTS && left > 0; i++) {
      const s = this.slots[i];
      if (s.id === 0) {
        const n = Math.min(left, max);
        this.slots[i] = { id: stack.id, count: n, damage: stack.damage };
        left -= n;
      }
    }
    if (left !== stack.count) {
      this.onChange?.();
      this.onAdd?.(stack.id);
    }
    return left;
  }

  count(id: number): number {
    let n = 0;
    for (const s of this.slots) if (s.id === id) n += s.count;
    return n;
  }

  /** Removes `count` items of `id` (main inventory first, then hotbar). */
  remove(id: number, count: number): boolean {
    if (this.count(id) < count) return false;
    let left = count;
    for (let i = INVENTORY_SLOTS - 1; i >= 0 && left > 0; i--) {
      const s = this.slots[i];
      if (s.id !== id) continue;
      const n = Math.min(left, s.count);
      s.count -= n;
      left -= n;
      if (s.count === 0) this.slots[i] = { id: 0, count: 0 };
    }
    this.onChange?.();
    return true;
  }

  /** Takes one item from a slot (placing a block, eating). */
  consumeSlot(i: number, n = 1): void {
    const s = this.slots[i];
    s.count -= n;
    if (s.count <= 0) this.slots[i] = { id: 0, count: 0 };
    this.onChange?.();
  }

  /** Damages the tool in a slot; returns true when it broke. */
  damageTool(i: number): boolean {
    const s = this.slots[i];
    const max = maxDurability(s.id);
    if (!max) return false;
    s.damage = (s.damage ?? 0) + 1;
    const broke = s.damage >= max;
    if (broke) this.slots[i] = { id: 0, count: 0 };
    this.onChange?.();
    return broke;
  }

  serialize(): number[][] {
    return this.slots.map((s) => [s.id, s.count, s.damage ?? 0]);
  }

  load(data: number[][] | undefined): void {
    for (let i = 0; i < INVENTORY_SLOTS; i++) {
      const d = data?.[i];
      this.slots[i] = d && d[0] > 0 && d[1] > 0 ? { id: d[0], count: d[1], damage: d[2] || undefined } : { id: 0, count: 0 };
    }
    this.onChange?.();
  }
}
