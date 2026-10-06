import { levelOf, takesWear } from './EnchantRules';
import { type ItemStack, cloneStack, getItemDef, maxDurability, sameItem, stackFromArray, stackToArray } from './ItemRegistry';

export const HOTBAR_SLOTS = 9;
export const INVENTORY_SLOTS = 36; // 0–8 hotbar, 9–35 main inventory
export const ARMOR_SLOTS = 4; // helmet, chestplate, leggings, boots

/** Player inventory as plain stacks; empty slots have id 0. */
export class PlayerInventory {
  readonly slots: ItemStack[] = Array.from({ length: INVENTORY_SLOTS }, () => ({ id: 0, count: 0 }));
  /** Worn armor: helmet, chestplate, leggings, boots. Saved as slots 36-39 of the inventory record. */
  readonly armor: ItemStack[] = Array.from({ length: ARMOR_SLOTS }, () => ({ id: 0, count: 0 }));
  /** Fired after any change (UI refresh, autosave). */
  onChange: (() => void) | null = null;
  /** Fired with the item id whenever `add` stored something (pickup, crafting, smelting). */
  onAdd: ((id: number) => void) | null = null;
  /** Fired with the item id when a tool or a worn armor piece wears out (Minecraft's item-break sound). */
  onBreak: ((id: number) => void) | null = null;

  static maxStack(id: number): number {
    return getItemDef(id)?.maxStack ?? 64;
  }

  get(i: number): ItemStack {
    return this.slots[i];
  }

  set(i: number, stack: ItemStack): void {
    this.slots[i] = stack.count > 0 && stack.id > 0 ? cloneStack(stack) : { id: 0, count: 0 };
    this.onChange?.();
  }

  /** Total armor points and toughness of what is worn. */
  armorTotals(): { points: number; toughness: number } {
    let points = 0, toughness = 0;
    for (const s of this.armor) {
      const a = s.id ? getItemDef(s.id)?.armor : undefined;
      if (a) { points += a.points; toughness += a.toughness; }
    }
    return { points, toughness };
  }

  setArmor(slot: number, stack: ItemStack): void {
    this.armor[slot] = stack.count > 0 && stack.id > 0 ? cloneStack(stack) : { id: 0, count: 0 };
    this.onChange?.();
  }

  /**
   * Wears the armor piece in an inventory slot (right click with it in hand): it goes to its armor slot and
   * whatever was worn there takes its place. Returns false when the item is not armor.
   */
  equipFromSlot(i: number): boolean {
    const stack = this.slots[i];
    const a = stack.id ? getItemDef(stack.id)?.armor : undefined;
    if (!a) return false;
    const worn = this.armor[a.slot];
    this.armor[a.slot] = cloneStack(stack);
    this.armor[a.slot].count = 1;
    if (stack.count > 1) {
      stack.count--;
      if (worn.id) this.add(worn);
    } else {
      this.slots[i] = worn.id ? worn : { id: 0, count: 0 };
    }
    this.onChange?.();
    return true;
  }

  /** Every worn piece loses `wear` durability (a hit that armor applied to); returns the pieces that broke. */
  wearArmor(wear: number): number {
    let broke = 0;
    for (let k = 0; k < ARMOR_SLOTS; k++) {
      const s = this.armor[k];
      const max = s.id ? maxDurability(s.id) : 0;
      if (!max) continue;
      // Unbreaking: each point of wear is skipped with the armor chance.
      const unbreaking = levelOf(s.data, 'unbreaking');
      let taken = 0;
      for (let w = 0; w < wear; w++) if (takesWear(unbreaking, true)) taken++;
      s.damage = (s.damage ?? 0) + taken;
      if (s.damage >= max) {
        this.armor[k] = { id: 0, count: 0 };
        broke++;
        this.onBreak?.(s.id);
      }
    }
    this.onChange?.();
    return broke;
  }

  clear(): void {
    for (let k = 0; k < ARMOR_SLOTS; k++) this.armor[k] = { id: 0, count: 0 };
    for (let i = 0; i < INVENTORY_SLOTS; i++) this.slots[i] = { id: 0, count: 0 };
    this.onChange?.();
  }

  /** Whether `add` would take the whole stack (checked before asking a server for an item). */
  canFit(stack: ItemStack): boolean {
    let left = stack.count;
    const max = PlayerInventory.maxStack(stack.id);
    for (const s of this.slots) {
      if (s.id === 0) left -= max;
      else if (max > 1 && sameItem(s, stack) && s.count < max) left -= max - s.count;
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
        if (sameItem(s, stack) && s.count < max) {
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
        this.slots[i] = { ...cloneStack(stack), count: n };
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
    // Unbreaking: a use costs durability only with chance 1/(level+1).
    if (!takesWear(levelOf(s.data, 'unbreaking'), false)) return false;
    s.damage = (s.damage ?? 0) + 1;
    const broke = s.damage >= max;
    if (broke) this.slots[i] = { id: 0, count: 0 };
    this.onChange?.();
    if (broke) this.onBreak?.(s.id);
    return broke;
  }

  serialize(): number[][] {
    return [...this.slots, ...this.armor].map((s) => stackToArray(s));
  }

  load(data: number[][] | undefined): void {
    for (let i = 0; i < INVENTORY_SLOTS; i++) {
      const d = data?.[i];
      this.slots[i] = stackFromArray(d) ?? { id: 0, count: 0 };
    }
    // Old saves have 36 records: no armor.
    for (let k = 0; k < ARMOR_SLOTS; k++) {
      const s = stackFromArray(data?.[INVENTORY_SLOTS + k]);
      this.armor[k] = s && getItemDef(s.id)?.armor?.slot === k ? s : { id: 0, count: 0 };
    }
    this.onChange?.();
  }
}
