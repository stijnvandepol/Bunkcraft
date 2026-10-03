import { FURNACE_FUEL, FURNACE_INPUT, FURNACE_OUTPUT, insertIntoSlots } from '../world/BlockEntities';
import { type ItemStack, cloneStack, getItemDef, sameItem } from './ItemRegistry';
import { fuelTicks, isSmeltable } from './Smelting';

/**
 * Slot rules and click arithmetic of container screens (chest, furnace), DOM-free. The singleplayer screen and the
 * multiplayer server run the same functions, so a click has the same result on both sides.
 */

export type ContainerKind = 'chest' | 'furnace';

const empty = (): ItemStack => ({ id: 0, count: 0 });
const maxOf = (id: number): number => getItemDef(id)?.maxStack ?? 64;

/** May this stack be put into slot `index` of a container? (The furnace output takes nothing; fuel only takes fuel.) */
export function slotAccepts(kind: ContainerKind, index: number, stack: ItemStack): boolean {
  if (kind !== 'furnace') return true;
  if (index === FURNACE_OUTPUT) return false;
  if (index === FURNACE_FUEL) return fuelTicks(stack.id) > 0;
  return true;
}

/** A furnace output slot can only be emptied. */
export function slotTakeOnly(kind: ContainerKind, index: number): boolean {
  return kind === 'furnace' && index === FURNACE_OUTPUT;
}

/** Which furnace slot a shift-clicked inventory stack goes to: smeltable → input, fuel → fuel slot, else -1. */
export function furnaceTarget(stack: ItemStack): number {
  if (isSmeltable(stack.id)) return FURNACE_INPUT;
  if (fuelTicks(stack.id) > 0) return FURNACE_FUEL;
  return -1;
}

export interface ClickOutcome {
  slot: ItemStack;
  cursor: ItemStack;
}

/**
 * One mouse click on a slot with a stack on the cursor (Minecraft's rules): left picks up / places / merges / swaps,
 * right takes half / places one. `canPlace` says whether the cursor stack may go into the slot at all and `takeOnly`
 * marks a slot that cannot receive (a furnace output). Returns the new slot and cursor, or null when nothing happens.
 */
export function clickStacks(slot: ItemStack, cursor: ItemStack, right: boolean, canPlace = true, takeOnly = false): ClickOutcome | null {
  const max = maxOf(slot.id || cursor.id);
  if (takeOnly) {
    if (slot.count === 0) return null;
    if (cursor.count === 0) return { slot: empty(), cursor: cloneStack(slot) };
    if (sameItem(slot, cursor) && cursor.count + slot.count <= max) return { slot: empty(), cursor: { ...cloneStack(cursor), count: cursor.count + slot.count } };
    return null;
  }
  if (cursor.count > 0 && !canPlace) return null;
  if (!right) {
    if (cursor.count === 0) return slot.count === 0 ? null : { slot: empty(), cursor: cloneStack(slot) };
    if (slot.count === 0) return { slot: cloneStack(cursor), cursor: empty() };
    if (sameItem(slot, cursor) && max > 1) {
      const n = Math.min(cursor.count, max - slot.count);
      return { slot: { ...cloneStack(slot), count: slot.count + n }, cursor: cursor.count - n > 0 ? { ...cloneStack(cursor), count: cursor.count - n } : empty() };
    }
    return { slot: cloneStack(cursor), cursor: cloneStack(slot) };
  }
  if (cursor.count === 0 && slot.count > 0) {
    const half = Math.ceil(slot.count / 2);
    const rest = slot.count - half;
    return { slot: rest > 0 ? { ...cloneStack(slot), count: rest } : empty(), cursor: { ...cloneStack(slot), count: half } };
  }
  if (cursor.count > 0 && (slot.count === 0 || (sameItem(slot, cursor) && slot.count < max))) {
    return { slot: { ...cloneStack(cursor), count: slot.count + 1 }, cursor: cursor.count > 1 ? { ...cloneStack(cursor), count: cursor.count - 1 } : empty() };
  }
  return null;
}

/** Items a stack would move into the player's 36 inventory slots (merging first, then free slots). */
export function inventoryRoom(inv: readonly ItemStack[], stack: ItemStack, slots = 36): number {
  const max = maxOf(stack.id);
  let room = 0;
  for (let i = 0; i < Math.min(slots, inv.length); i++) {
    const s = inv[i];
    if (s.count === 0) room += max;
    else if (max > 1 && sameItem(s, stack) && s.count < max) room += max - s.count;
  }
  return room;
}

/**
 * Shift-click into a container: the stack goes to the first slot it fits (a chest: any slot; a furnace: input or fuel
 * by what it is). Returns how many items did not fit.
 */
export function quickInsert(kind: ContainerKind, slots: ItemStack[], stack: ItemStack): number {
  if (kind === 'furnace') {
    const target = furnaceTarget(stack);
    return target < 0 ? stack.count : insertIntoSlots(slots, stack, target, target + 1);
  }
  return insertIntoSlots(slots, stack);
}

export interface ContainerClick {
  /** Container slot clicked; -1 for a shift-click that deposits from the inventory slot `from`. */
  slot: number;
  /** 0 left, 1 right. */
  button: 0 | 1;
  shift: boolean;
  /** Inventory slot (0-35) that a shift-click deposits from. */
  from?: number;
}

export interface ClickResult {
  /** The click was understood (it may still have changed nothing). */
  ok: boolean;
  /** The cursor after the click. */
  cursor: ItemStack;
  /** What left the container (the player now owns it) and what the player put in (the container now owns it). */
  gained: ItemStack[];
  spent: ItemStack[];
  /** Shift-click withdraw: the stack that moves into the inventory. */
  toInv?: ItemStack;
  /** Shift-click deposit: the inventory slot that gives up `count` items. */
  fromInv?: { slot: number; count: number };
  /** The furnace output was taken (experience is due). */
  tookOutput: boolean;
}

/** Items that left (positive) or entered (negative) a slot between `before` and `after`. */
function slotDelta(before: ItemStack, after: ItemStack, gained: ItemStack[], spent: ItemStack[]): void {
  if (before.count > 0 && after.count > 0 && sameItem(before, after)) {
    const d = after.count - before.count;
    if (d > 0) spent.push({ ...cloneStack(after), count: d });
    else if (d < 0) gained.push({ ...cloneStack(before), count: -d });
    return;
  }
  if (before.count > 0) gained.push(cloneStack(before));
  if (after.count > 0) spent.push(cloneStack(after));
}

/**
 * Applies one click to a container's slots (mutating them). `inv` is the player's inventory as the client reported it
 * (36 slots first), needed for the shift-click room check. Pure arithmetic: the server calls this and then moves the
 * difference through the inventory guard.
 */
export function applyContainerClick(kind: ContainerKind, slots: ItemStack[], click: ContainerClick, cursor: ItemStack, inv: readonly ItemStack[]): ClickResult {
  const fail: ClickResult = { ok: false, cursor: cloneStack(cursor), gained: [], spent: [], tookOutput: false };
  const result: ClickResult = { ok: true, cursor: cloneStack(cursor), gained: [], spent: [], tookOutput: false };
  if (click.shift) {
    if (click.slot >= 0) {
      if (click.slot >= slots.length) return fail;
      const stack = slots[click.slot];
      if (stack.count === 0) return result;
      const moved = Math.min(stack.count, inventoryRoom(inv, stack));
      if (moved <= 0) return result;
      const take = { ...cloneStack(stack), count: moved };
      slots[click.slot] = stack.count - moved > 0 ? { ...cloneStack(stack), count: stack.count - moved } : empty();
      result.toInv = take;
      result.gained.push(cloneStack(take));
      result.tookOutput = slotTakeOnly(kind, click.slot);
      return result;
    }
    const from = click.from;
    if (from === undefined || !Number.isInteger(from) || from < 0 || from >= Math.min(36, inv.length)) return fail;
    const stack = inv[from];
    if (stack.count === 0) return result;
    const left = quickInsert(kind, slots, stack);
    const moved = stack.count - left;
    if (moved > 0) {
      result.fromInv = { slot: from, count: moved };
      result.spent.push({ ...cloneStack(stack), count: moved });
    }
    return result;
  }
  if (!Number.isInteger(click.slot) || click.slot < 0 || click.slot >= slots.length) return fail;
  const before = slots[click.slot];
  const out = clickStacks(before, cursor, click.button === 1, cursor.count === 0 || slotAccepts(kind, click.slot, cursor), slotTakeOnly(kind, click.slot));
  if (!out) return result;
  slots[click.slot] = out.slot;
  result.cursor = out.cursor;
  slotDelta(before, out.slot, result.gained, result.spent);
  result.tookOutput = slotTakeOnly(kind, click.slot) && result.gained.length > 0;
  return result;
}
