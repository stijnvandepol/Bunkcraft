import { describe, expect, it } from 'vitest';
import { PlayerInventory } from '../src/items/Inventory';
import { itemId, maxDurability } from '../src/items/ItemRegistry';

// QA (docs/qa/SURVIVAL.md): a worn-out pickaxe vanished from the hand without any cue. The inventory now reports
// the break so the game can play Minecraft's item-break sound.
describe('tool and armor break notification', () => {
  it('fires onBreak once when a tool wears out', () => {
    const inv = new PlayerInventory();
    const pick = itemId('wooden_pickaxe');
    inv.set(0, { id: pick, count: 1, damage: maxDurability(pick) - 1 });
    const broken: number[] = [];
    inv.onBreak = (id) => broken.push(id);
    expect(inv.damageTool(0)).toBe(true);
    expect(inv.get(0).id).toBe(0);
    expect(broken).toEqual([pick]);
  });

  it('does not fire for ordinary wear', () => {
    const inv = new PlayerInventory();
    const pick = itemId('stone_pickaxe');
    inv.set(0, { id: pick, count: 1 });
    let n = 0;
    inv.onBreak = () => n++;
    inv.damageTool(0);
    expect(n).toBe(0);
  });

  it('fires for a worn armor piece that breaks', () => {
    const inv = new PlayerInventory();
    const helmet = itemId('leather_helmet');
    inv.setArmor(0, { id: helmet, count: 1, damage: maxDurability(helmet) - 1 });
    const broken: number[] = [];
    inv.onBreak = (id) => broken.push(id);
    inv.wearArmor(4);
    expect(broken).toEqual([helmet]);
  });
});
