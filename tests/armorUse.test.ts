import { describe, expect, it } from 'vitest';
import { wearsArmorOnUse } from '../src/core/Interaction';
import { itemId } from '../src/items/ItemRegistry';

// QA (docs/qa/SURVIVAL.md): right clicking an iron chestplate while looking at the sky did nothing; it only
// worked when a block was targeted. Minecraft wears armor on "use" anywhere.
describe('wearing armor with a right click', () => {
  it('wears armor without a targeted block', () => {
    expect(wearsArmorOnUse(itemId('iron_chestplate'), false)).toBe(true);
  });
  it('a usable block (door, chest, bed) takes the click instead', () => {
    expect(wearsArmorOnUse(itemId('iron_chestplate'), true)).toBe(false);
  });
  it('only armor', () => {
    expect(wearsArmorOnUse(itemId('stone_pickaxe'), false)).toBe(false);
  });
});
