import { describe, expect, it } from 'vitest';
import { PlayerInventory } from '../src/items/Inventory';
import { ALL_ITEMS, getItemDef, maxDurability } from '../src/items/ItemRegistry';
import { InventoryGuard, parseInventory } from '../server/InventoryGuard';

/**
 * The content update added worn armor (inventory rows 36–39), per-stack data (enchantments) and
 * damaged armor. The server must accept exactly what the client serialises, or every player who
 * wears armor would see "the server corrected your inventory" and lose items.
 */
describe('inventory guard accepts what the client sends', () => {
  const armorId = ALL_ITEMS.find((id) => getItemDef(id)?.armor?.slot === 1)!;
  const helmetId = ALL_ITEMS.find((id) => getItemDef(id)?.armor?.slot === 0)!;

  it('finds armor in the registry', () => {
    expect(armorId).toBeDefined();
    expect(helmetId).toBeDefined();
  });

  it('accepts a full 40-row inventory with worn armor', () => {
    const inv = new PlayerInventory();
    inv.setArmor?.(1, { id: armorId, count: 1 });
    const rows = inv.serialize();
    expect(rows.length).toBe(40);
    expect(parseInventory(rows).error).toBeUndefined();
  });

  it('accepts damaged armor and tools up to their durability', () => {
    const inv = new PlayerInventory();
    const max = maxDurability(armorId);
    inv.setArmor?.(1, { id: armorId, count: 1, damage: Math.max(1, Math.floor(max / 2)) });
    expect(max).toBeGreaterThan(0);
    expect(parseInventory(inv.serialize()).error).toBeUndefined();
  });

  it('keeps per-stack data (enchantments) when it checks and when it corrects', () => {
    const rows = [[armorId, 1, 0, 0, 3, 1, 2], ...Array.from({ length: 35 }, () => [0, 0, 0])];
    const parsed = parseInventory(rows);
    expect(parsed.error).toBeUndefined();
    expect(parsed.slots[0].extra).toEqual([0, 3, 1, 2]);
    const guard = new InventoryGuard(parsed.slots, () => 0);
    const res = guard.check(rows);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.inventory[0]).toEqual([armorId, 1, 0, 0, 3, 1, 2]);
  });

  it('still rejects too many rows and broken data columns', () => {
    expect(parseInventory(Array.from({ length: 41 }, () => [0, 0, 0])).error).toBeDefined();
    expect(parseInventory([[armorId, 1, 0, 0.5, 2]]).error).toBeDefined();
    expect(parseInventory([[armorId, 1, 0, ...Array(14).fill(1)]]).error).toBeDefined();
  });
});
