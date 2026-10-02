import { describe, expect, it } from 'vitest';
import {
  ENCHANTS, ENCHANT_BY_KEY, MAX_NAME_LENGTH, cleanName, conflicts, customName, enchantLines, enchantsOf, fortuneMultiplier, levelOf, meleeBonus,
  protectionFactor, reduceByEpf, repairCostOf, roman, takesWear, thornsReflect, totalEpf, withCustomName, withEnchants, withRepairCost, wearChance,
  efficiencyBonus, sweepDamage, respirationKeepsAir, gravelFlintChance, fortuneSaplingChance, depthStriderFactor, fortuneExtra, lootingExtra,
} from '../src/items/EnchantRules';
import {
  EnchantRandom, anvilCombine, applyMending, applyOffer, canCarry, canPayOffer, enchantability, enchanted, glyphText, grindstoneResult, isBook,
  nextEnchantSeed, slotCost, stackLabel, tableAccepts, tableOffers, targetsOf,
} from '../src/items/Enchanting';
import { ITEM, ITEM_DATA_KEYS, ITEM_ID, blockDrop, breakSeconds, decodeData, encodeData, itemId, sameItem, stackFromArray, stackToArray, type ItemStack } from '../src/items/ItemRegistry';
import { PlayerInventory } from '../src/items/Inventory';
import { BLOCK, CUBE_ID } from '../src/world/BlockRegistry';

const stack = (id: number, data?: Record<string, number>, damage?: number): ItemStack => ({ id, count: 1, ...(damage ? { damage } : {}), ...(data ? { data } : {}) });
const sword = (data?: Record<string, number>, damage?: number) => stack(ITEM.IRON_SWORD, data, damage);

describe('enchantment rules', () => {
  it('has every enchantment in the saved key list', () => {
    for (const e of ENCHANTS) expect(ITEM_DATA_KEYS, e.key).toContain(e.key);
    expect(ITEM_DATA_KEYS.indexOf('sharpness')).toBe(0);
    expect(ITEM_DATA_KEYS.indexOf('custom_name')).toBe(25);
  });

  it('max levels are the vanilla ones', () => {
    const max: Record<string, number> = {
      protection: 4, fire_protection: 4, blast_protection: 4, projectile_protection: 4, feather_falling: 4, respiration: 3, aqua_affinity: 1, thorns: 3,
      depth_strider: 3, sharpness: 5, smite: 5, bane_of_arthropods: 5, knockback: 2, fire_aspect: 2, looting: 3, sweeping_edge: 3, efficiency: 5,
      silk_touch: 1, unbreaking: 3, fortune: 3, power: 5, punch: 2, flame: 1, infinity: 1, mending: 1,
    };
    for (const [k, v] of Object.entries(max)) expect(ENCHANT_BY_KEY.get(k)?.max, k).toBe(v);
  });

  it('conflicts follow the vanilla groups', () => {
    expect(conflicts('sharpness', 'smite')).toBe(true);
    expect(conflicts('smite', 'bane_of_arthropods')).toBe(true);
    expect(conflicts('protection', 'blast_protection')).toBe(true);
    expect(conflicts('fire_protection', 'projectile_protection')).toBe(true);
    expect(conflicts('silk_touch', 'fortune')).toBe(true);
    expect(conflicts('infinity', 'mending')).toBe(true);
    expect(conflicts('feather_falling', 'protection')).toBe(false);
    expect(conflicts('sharpness', 'sharpness')).toBe(false);
    expect(conflicts('sharpness', 'looting')).toBe(false);
    for (const a of ENCHANTS) for (const b of ENCHANTS) expect(conflicts(a.key, b.key), `${a.key}/${b.key}`).toBe(conflicts(b.key, a.key));
  });

  it('applicability by item', () => {
    expect(canCarry(ITEM.IRON_SWORD, 'sharpness')).toBe(true);
    expect(canCarry(ITEM.IRON_SWORD, 'efficiency')).toBe(false);
    expect(canCarry(ITEM.IRON_AXE, 'sharpness')).toBe(true);
    expect(canCarry(ITEM.IRON_AXE, 'efficiency')).toBe(true);
    expect(canCarry(ITEM.IRON_PICKAXE, 'fortune')).toBe(true);
    expect(canCarry(ITEM.IRON_PICKAXE, 'sharpness')).toBe(false);
    expect(canCarry(ITEM.SHEARS, 'efficiency')).toBe(true);
    expect(canCarry(ITEM.SHEARS, 'silk_touch')).toBe(false);
    expect(canCarry(ITEM.BOW, 'power')).toBe(true);
    expect(canCarry(ITEM.BOW, 'infinity')).toBe(true);
    expect(canCarry(ITEM.BOW, 'sharpness')).toBe(false);
    expect(canCarry(ITEM_ID.diamond_helmet, 'respiration')).toBe(true);
    expect(canCarry(ITEM_ID.diamond_helmet, 'depth_strider')).toBe(false);
    expect(canCarry(ITEM_ID.diamond_boots, 'feather_falling')).toBe(true);
    expect(canCarry(ITEM_ID.diamond_chestplate, 'feather_falling')).toBe(false);
    expect(canCarry(ITEM_ID.diamond_chestplate, 'thorns')).toBe(true);
    expect(canCarry(ITEM_ID.leather_leggings, 'unbreaking')).toBe(true);
    expect(canCarry(ITEM_ID.leather_leggings, 'mending')).toBe(true);
    expect(canCarry(ITEM.ENCHANTED_BOOK, 'sharpness')).toBe(true);
    expect(canCarry(ITEM_ID.book, 'power')).toBe(true);
    expect(canCarry(BLOCK.STONE, 'unbreaking')).toBe(false);
    expect(targetsOf(ITEM.IRON_SWORD)).toContain('sword');
    expect(isBook(ITEM.ENCHANTED_BOOK)).toBe(true);
  });

  it('enchantability by material', () => {
    expect(enchantability(ITEM.WOODEN_SWORD)).toBe(15);
    expect(enchantability(ITEM.STONE_PICKAXE)).toBe(5);
    expect(enchantability(ITEM.IRON_AXE)).toBe(14);
    expect(enchantability(ITEM.DIAMOND_SHOVEL)).toBe(10);
    expect(enchantability(ITEM.GOLDEN_SWORD)).toBe(22);
    expect(enchantability(ITEM_ID.leather_helmet)).toBe(15);
    expect(enchantability(ITEM_ID.chainmail_boots)).toBe(12);
    expect(enchantability(ITEM_ID.iron_chestplate)).toBe(9);
    expect(enchantability(ITEM_ID.golden_boots)).toBe(25);
    expect(enchantability(ITEM_ID.diamond_leggings)).toBe(10);
    expect(enchantability(ITEM.BOW)).toBe(1);
    expect(enchantability(ITEM_ID.book)).toBe(1);
    expect(enchantability(BLOCK.DIRT)).toBe(0);
    expect(enchantability(ITEM.SHEARS)).toBe(0);
  });

  it('roman numerals and labels', () => {
    expect([1, 2, 3, 4, 5, 6, 9, 10].map(roman)).toEqual(['I', 'II', 'III', 'IV', 'V', 'VI', 'IX', 'X']);
    expect(enchantLines({ sharpness: 5, unbreaking: 3, silk_touch: 1 })).toEqual(['Sharpness V', 'Silk Touch', 'Unbreaking III']);
    expect(enchantLines(undefined)).toEqual([]);
    expect(enchantLines({ repair_cost: 3 })).toEqual([]);
  });

  it('ignores unknown keys and clamps levels', () => {
    expect(enchantsOf({ sharpness: 9, bogus: 3, smite: 0, repair_cost: 7 })).toEqual({ sharpness: 5 });
    expect(levelOf({ sharpness: 9 }, 'sharpness')).toBe(5);
    expect(withEnchants({ repair_cost: 3, sharpness: 2 }, { smite: 1 })).toEqual({ repair_cost: 3, smite: 1 });
    expect(withEnchants({ sharpness: 2 }, {})).toBeUndefined();
  });
});

describe('enchantment effects (numbers)', () => {
  it('melee bonus', () => {
    expect(meleeBonus({ sharpness: 1 }, false, false)).toBe(1);
    expect(meleeBonus({ sharpness: 5 }, false, false)).toBe(3);
    expect(meleeBonus({ smite: 5 }, true, false)).toBe(12.5);
    expect(meleeBonus({ smite: 5 }, false, false)).toBe(0);
    expect(meleeBonus({ bane_of_arthropods: 3 }, false, true)).toBe(7.5);
    expect(meleeBonus({ sharpness: 2, smite: 2 }, true, false)).toBe(1.5 + 5);
    expect(meleeBonus(undefined, true, true)).toBe(0);
    expect(sweepDamage(7, 3)).toBeCloseTo(1 + 7 * 0.75);
    expect(sweepDamage(7, 0)).toBe(1);
  });

  it('protection factors and the damage cut', () => {
    expect(protectionFactor('protection', 4, 'mob')).toBe(4);
    expect(protectionFactor('fire_protection', 4, 'fire')).toBe(8);
    expect(protectionFactor('fire_protection', 4, 'mob')).toBe(0);
    expect(protectionFactor('blast_protection', 4, 'explosion')).toBe(8);
    expect(protectionFactor('projectile_protection', 4, 'arrow')).toBe(8);
    expect(protectionFactor('feather_falling', 4, 'fall')).toBe(12);
    expect(protectionFactor('protection', 4, 'void')).toBe(0);
    const four = Array.from({ length: 4 }, () => ({ protection: 4 }));
    expect(totalEpf(four, 'mob')).toBe(16);
    expect(reduceByEpf(10, 16)).toBeCloseTo(3.6);
    // The cap is 20: a full set of Blast Protection IV (32) cuts 80%.
    const blast = Array.from({ length: 4 }, () => ({ blast_protection: 4 }));
    expect(totalEpf(blast, 'explosion')).toBe(20);
    expect(reduceByEpf(10, 20)).toBeCloseTo(2);
    expect(totalEpf([{ feather_falling: 4 }, { protection: 4 }], 'fall')).toBe(16);
  });

  it('thorns', () => {
    const none = thornsReflect([{ thorns: 3 }], () => 0.99);
    expect(none.damage).toBe(0);
    const hit = thornsReflect([{ thorns: 3 }, undefined, { thorns: 1 }], () => 0.01);
    expect(hit.damage).toBeGreaterThanOrEqual(2);
    expect(hit.wear[0]).toBe(2);
    expect(hit.wear[2]).toBe(2);
  });

  it('efficiency, unbreaking, fortune, looting numbers', () => {
    expect([1, 2, 3, 4, 5].map(efficiencyBonus)).toEqual([2, 5, 10, 17, 26]);
    expect(wearChance(0, false)).toBe(1);
    expect(wearChance(3, false)).toBeCloseTo(0.25);
    expect(wearChance(3, true)).toBeCloseTo(0.7);
    expect(takesWear(3, false, () => 0.3)).toBe(false);
    expect(takesWear(3, false, () => 0.2)).toBe(true);
    // Fortune III: x1 40%, x2/x3/x4 20% each.
    const counts = [0, 0, 0, 0, 0];
    for (let i = 0; i < 100; i++) counts[fortuneMultiplier(3, () => i / 100)]++;
    expect(counts.slice(1)).toEqual([40, 20, 20, 20]);
    expect(fortuneMultiplier(0)).toBe(1);
    expect(fortuneExtra(3, () => 0.99)).toBe(3);
    expect(lootingExtra(3, () => 0.99)).toBe(3);
    expect(lootingExtra(0, () => 0.99)).toBe(0);
    expect([0, 1, 2, 3].map(gravelFlintChance)).toEqual([0.1, 0.14, 0.25, 1]);
    expect(fortuneSaplingChance(0.05, 3)).toBeCloseTo(0.1);
    expect(respirationKeepsAir(3, () => 0.7)).toBe(true);
    expect(respirationKeepsAir(3, () => 0.8)).toBe(false);
    expect(respirationKeepsAir(0, () => 0)).toBe(false);
    expect(depthStriderFactor(3)).toBe(1);
  });
});

describe('items carrying data', () => {
  it('round trips enchantments through the saved form and keeps stacks apart', () => {
    const s: ItemStack = { id: ITEM.DIAMOND_SWORD, count: 1, damage: 12, data: { sharpness: 5, looting: 3, repair_cost: 3 } };
    const flat = stackToArray(s);
    expect(flat.slice(0, 3)).toEqual([ITEM.DIAMOND_SWORD, 1, 12]);
    expect(stackFromArray(flat)).toEqual(s);
    expect(stackFromArray(JSON.parse(JSON.stringify(flat)))).toEqual(s);
    expect(sameItem(s, { ...s, data: { ...s.data, sharpness: 4 } })).toBe(false);
    expect(decodeData(encodeData({ sharpness: 2, bogus: 1 }))).toEqual({ sharpness: 2 });
  });

  it('keeps the data through the player inventory', () => {
    const inv = new PlayerInventory();
    inv.set(2, { id: ITEM.DIAMOND_SWORD, count: 1, data: { sharpness: 5, fire_aspect: 2 } });
    inv.add({ id: ITEM.DIAMOND_SWORD, count: 1 });
    const saved = JSON.parse(JSON.stringify(inv.serialize()));
    const loaded = new PlayerInventory();
    loaded.load(saved);
    expect(loaded.get(2).data).toEqual({ sharpness: 5, fire_aspect: 2 });
    expect(loaded.get(0).data).toBeUndefined();
    // Armor slots too.
    loaded.setArmor(3, { id: ITEM_ID.diamond_boots, count: 1, data: { feather_falling: 4 } });
    const again = new PlayerInventory();
    again.load(JSON.parse(JSON.stringify(loaded.serialize())));
    expect(again.armor[3].data).toEqual({ feather_falling: 4 });
  });

  it('custom names survive the numbers-only data format', () => {
    for (const name of ['Excalibur', 'Ünïcode ✓', 'a', 'x'.repeat(MAX_NAME_LENGTH)]) {
      const data = withCustomName({ sharpness: 3 }, name);
      expect(customName(data)).toBe(name);
      const s: ItemStack = { id: ITEM.IRON_SWORD, count: 1, data };
      expect(customName(stackFromArray(JSON.parse(JSON.stringify(stackToArray(s))))!.data)).toBe(name);
    }
    expect(customName(withCustomName({ custom_name: 5 }, ''))).toBe('');
    expect(withCustomName(undefined, '   ')).toBeUndefined();
    expect(cleanName('  hi\u0000there \n')).toBe('hithere');
    expect(cleanName('y'.repeat(100)).length).toBe(MAX_NAME_LENGTH);
    expect(stackLabel(stack(ITEM.IRON_SWORD, withCustomName(undefined, 'Zed')))).toBe('Zed');
    expect(stackLabel(stack(ITEM.IRON_SWORD))).toBe('Iron Sword');
  });

  it('repair cost helpers', () => {
    expect(repairCostOf(undefined)).toBe(0);
    expect(repairCostOf(withRepairCost(undefined, 7))).toBe(7);
    expect(withRepairCost({ repair_cost: 7 }, 0)).toBeUndefined();
  });
});

describe('the enchanting table', () => {
  it('slot costs depend on the bookshelves', () => {
    // Without bookshelves: slots offer up to level 2, 6 and 8; with 15: up to 10, 21 and exactly 30.
    for (let seed = 0; seed < 200; seed++) {
      const none = [0, 1, 2].map((s) => slotCost(new EnchantRandom(seed), s, 0));
      expect(none[0]).toBeGreaterThanOrEqual(1);
      expect(none[0]).toBeLessThanOrEqual(2);
      expect(none[1]).toBeLessThanOrEqual(6);
      expect(none[2]).toBeLessThanOrEqual(8);
      const full = [0, 1, 2].map((s) => slotCost(new EnchantRandom(seed), s, 15));
      expect(full[0]).toBeLessThanOrEqual(10);
      expect(full[1]).toBeLessThanOrEqual(21);
      expect(full[2]).toBe(30);
      expect(slotCost(new EnchantRandom(seed), 2, 99)).toBe(30);
    }
  });

  it('is deterministic for a seed and changes with it', () => {
    const a = tableOffers(12345, stack(ITEM.DIAMOND_SWORD), 15);
    const b = tableOffers(12345, stack(ITEM.DIAMOND_SWORD), 15);
    expect(b).toEqual(a);
    const seen = new Set<string>();
    for (let seed = 0; seed < 50; seed++) seen.add(JSON.stringify(tableOffers(seed, stack(ITEM.DIAMOND_SWORD), 15)));
    expect(seen.size).toBeGreaterThan(30);
    expect(nextEnchantSeed(1)).toBe(nextEnchantSeed(1));
    expect(nextEnchantSeed(1)).not.toBe(1);
    expect(glyphText(99)).toBe(glyphText(99));
    expect(glyphText(99)).toMatch(/^[a-z ]+$/);
  });

  it('three offers with prices 1, 2, 3 and level requirements', () => {
    const offers = tableOffers(777, stack(ITEM.IRON_PICKAXE), 15);
    expect(offers.map((o) => o.price)).toEqual([1, 2, 3]);
    expect(offers[2].cost).toBe(30);
    for (const o of offers) {
      expect(o.list.length).toBeGreaterThan(0);
      expect(o.clue).not.toBeNull();
      expect(o.list).toContainEqual(o.clue);
    }
  });

  it('only offers legal, non-conflicting enchantments of a legal level', () => {
    const items = [ITEM.DIAMOND_SWORD, ITEM.IRON_PICKAXE, ITEM.IRON_AXE, ITEM.BOW, ITEM_ID.diamond_helmet, ITEM_ID.iron_boots, ITEM_ID.golden_chestplate, ITEM_ID.book];
    for (const id of items) {
      for (let seed = 1; seed <= 300; seed++) {
        for (const o of tableOffers(seed * 7919, stack(id), seed % 16)) {
          if (o.cost === 0) continue;
          for (const c of o.list) {
            const e = ENCHANT_BY_KEY.get(c.key)!;
            expect(canCarry(id, c.key), `${id} ${c.key}`).toBe(true);
            expect(e.treasure).toBeFalsy();
            expect(c.level).toBeGreaterThanOrEqual(1);
            expect(c.level).toBeLessThanOrEqual(e.max);
          }
          for (const a of o.list) for (const b of o.list) expect(conflicts(a.key, b.key)).toBe(false);
          if (id === ITEM_ID.book) expect(o.list.length).toBeGreaterThanOrEqual(1);
        }
      }
    }
  });

  it('a level 30 slot on a diamond sword often gives several enchantments and strong ones', () => {
    let multi = 0, strong = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const o = tableOffers(seed, stack(ITEM.DIAMOND_SWORD), 15)[2];
      if (o.list.length > 1) multi++;
      if (o.list.some((c) => c.level >= 3)) strong++;
    }
    expect(multi).toBeGreaterThan(60);
    expect(strong).toBeGreaterThan(100);
  });

  it('empty for items that cannot be enchanted or already are', () => {
    for (const s of [stack(BLOCK.DIRT), stack(ITEM.SHEARS), stack(ITEM.IRON_SWORD, { sharpness: 1 }), { id: ITEM.IRON_SWORD, count: 2 }]) {
      expect(tableAccepts(s)).toBe(false);
      expect(tableOffers(5, s, 15).every((o) => o.cost === 0)).toBe(true);
    }
  });

  it('applying an offer enchants an item and turns a book into an enchanted book', () => {
    const offer = tableOffers(31337, stack(ITEM.IRON_SWORD), 15)[2];
    const out = applyOffer(stack(ITEM.IRON_SWORD, { custom_name: 0 }), offer);
    expect(out.id).toBe(ITEM.IRON_SWORD);
    expect(Object.keys(enchantsOf(out.data)).length).toBe(offer.list.length);
    const bookOffer = tableOffers(31337, stack(ITEM_ID.book), 15)[2];
    const book = applyOffer(stack(ITEM_ID.book), bookOffer);
    expect(book.id).toBe(ITEM.ENCHANTED_BOOK);
    expect(Object.keys(enchantsOf(book.data)).length).toBeGreaterThanOrEqual(1);
  });

  it('prices: levels and lapis', () => {
    const offers = tableOffers(1, stack(ITEM.DIAMOND_SWORD), 15);
    expect(canPayOffer(offers[2], 30, 3, false)).toBe(true);
    expect(canPayOffer(offers[2], 29, 3, false)).toBe(false);
    expect(canPayOffer(offers[2], 30, 2, false)).toBe(false);
    expect(canPayOffer(offers[2], 0, 0, true)).toBe(true);
    expect(canPayOffer({ cost: 0, price: 1, clue: null, list: [], glyphSeed: 0 }, 99, 9, false)).toBe(false);
  });
});

describe('the anvil', () => {
  const ok = (r: ReturnType<typeof anvilCombine>) => {
    if (r.kind !== 'ok') throw new Error(`expected ok, got ${r.kind}`);
    return r.value;
  };

  it('repairs with material: a quarter per item, a level each', () => {
    const r = ok(anvilCombine(stack(ITEM.IRON_PICKAXE, undefined, 100), { id: ITEM.IRON_INGOT, count: 5 }, null));
    // 250 max: 62 per ingot; 100 damage needs 2 ingots.
    expect(r.materialUsed).toBe(2);
    expect(r.cost).toBe(2);
    expect(r.result.damage).toBeUndefined();
    expect(repairCostOf(r.result.data)).toBe(1);
    const one = ok(anvilCombine(stack(ITEM.IRON_PICKAXE, undefined, 100), { id: ITEM.IRON_INGOT, count: 1 }, null));
    expect(one.result.damage).toBe(38);
    expect(one.cost).toBe(1);
    expect(anvilCombine(stack(ITEM.IRON_PICKAXE), { id: ITEM.IRON_INGOT, count: 1 }, null).kind).toBe('none');
    expect(anvilCombine(stack(ITEM.IRON_PICKAXE, undefined, 10), { id: ITEM.DIAMOND, count: 1 }, null).kind).toBe('none');
    expect(anvilCombine(stack(ITEM.WOODEN_SWORD, undefined, 10), { id: BLOCK.OAK_PLANKS, count: 1 }, null).kind).toBe('ok');
    expect(anvilCombine(stack(ITEM.STONE_SWORD, undefined, 10), { id: BLOCK.COBBLESTONE, count: 1 }, null).kind).toBe('ok');
    expect(anvilCombine(stack(ITEM_ID.diamond_helmet, undefined, 10), { id: ITEM.DIAMOND, count: 1 }, null).kind).toBe('ok');
  });

  it('combines two tools: durability with a 12% bonus and the enchantments', () => {
    const left = stack(ITEM.IRON_SWORD, { sharpness: 2 }, 100);
    const right = stack(ITEM.IRON_SWORD, { sharpness: 2, unbreaking: 1 }, 150);
    const r = ok(anvilCombine(left, right, null));
    // left 150 left + right 100 left + 30 (12% of 250) = 280 -> full.
    expect(r.result.damage).toBeUndefined();
    expect(enchantsOf(r.result.data)).toEqual({ sharpness: 3, unbreaking: 1 });
    // 2 (repair) + sharpness III x1 + unbreaking I x2 (item multipliers).
    expect(r.cost).toBe(2 + 3 + 2);
    expect(repairCostOf(r.result.data)).toBe(1);
  });

  it('book on item: cost is multiplier x level, books count half', () => {
    const r = ok(anvilCombine(stack(ITEM.IRON_SWORD), stack(ITEM.ENCHANTED_BOOK, { sharpness: 3 }), null));
    expect(r.cost).toBe(3);
    expect(enchantsOf(r.result.data)).toEqual({ sharpness: 3 });
    const silk = ok(anvilCombine(stack(ITEM.IRON_PICKAXE), stack(ITEM.ENCHANTED_BOOK, { silk_touch: 1 }), null));
    expect(silk.cost).toBe(4);
    const mending = ok(anvilCombine(stack(ITEM.IRON_PICKAXE), stack(ITEM.ENCHANTED_BOOK, { mending: 1 }), null));
    expect(mending.cost).toBe(2);
    // The same enchantment at the same level goes one up, capped at the maximum.
    const up = ok(anvilCombine(sword({ sharpness: 3 }), stack(ITEM.ENCHANTED_BOOK, { sharpness: 3 }), null));
    expect(enchantsOf(up.result.data).sharpness).toBe(4);
    expect(up.cost).toBe(4);
    const cap = ok(anvilCombine(sword({ sharpness: 5 }), stack(ITEM.ENCHANTED_BOOK, { sharpness: 5, looting: 1 }), null));
    expect(enchantsOf(cap.result.data)).toEqual({ sharpness: 5, looting: 1 });
    // A lower book does not lower the level.
    const low = ok(anvilCombine(sword({ sharpness: 4 }), stack(ITEM.ENCHANTED_BOOK, { sharpness: 2, looting: 1 }), null));
    expect(enchantsOf(low.result.data).sharpness).toBe(4);
  });

  it('conflicting enchantments are refused and cost a level', () => {
    expect(anvilCombine(sword({ sharpness: 3 }), stack(ITEM.ENCHANTED_BOOK, { smite: 3 }), null).kind).toBe('none');
    const mixed = ok(anvilCombine(sword({ sharpness: 3 }), stack(ITEM.ENCHANTED_BOOK, { smite: 3, looting: 1 }), null));
    expect(enchantsOf(mixed.result.data)).toEqual({ sharpness: 3, looting: 1 });
    // conflict 1 + looting (item mult 4, book 2) x 1 = 2 -> 3
    expect(mixed.cost).toBe(3);
    // A book with something the item cannot carry does nothing.
    expect(anvilCombine(sword(), stack(ITEM.ENCHANTED_BOOK, { efficiency: 5 }), null).kind).toBe('none');
  });

  it('books combine into a better book', () => {
    const r = ok(anvilCombine(stack(ITEM.ENCHANTED_BOOK, { sharpness: 2 }), stack(ITEM.ENCHANTED_BOOK, { sharpness: 2, looting: 1 }), null));
    expect(r.result.id).toBe(ITEM.ENCHANTED_BOOK);
    expect(enchantsOf(r.result.data)).toEqual({ sharpness: 3, looting: 1 });
  });

  it('renaming costs one level and keeps the prior work', () => {
    const r = ok(anvilCombine(sword({ sharpness: 1 }), { id: 0, count: 0 }, 'Excalibur'));
    expect(r.cost).toBe(1);
    expect(customName(r.result.data)).toBe('Excalibur');
    expect(enchantsOf(r.result.data)).toEqual({ sharpness: 1 });
    expect(repairCostOf(r.result.data)).toBe(0);
    // Same name again: nothing to do.
    expect(anvilCombine(r.result, { id: 0, count: 0 }, 'Excalibur').kind).toBe('none');
    expect(anvilCombine(sword(), { id: 0, count: 0 }, '   ').kind).toBe('none');
    // Removing a name is a rename too.
    const cleared = ok(anvilCombine(r.result, { id: 0, count: 0 }, ''));
    expect(customName(cleared.result.data)).toBe('');
    // A worked item makes renaming expensive.
    const worked = ok(anvilCombine(stack(ITEM.IRON_SWORD, { repair_cost: 7 }), { id: 0, count: 0 }, 'Zed'));
    expect(worked.cost).toBe(8);
  });

  it('prior work doubles the penalty and 40 levels is too expensive', () => {
    let s = stack(ITEM.IRON_PICKAXE, undefined, 200);
    const penalties: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = anvilCombine(s, { id: ITEM.IRON_INGOT, count: 1 }, null);
      if (r.kind !== 'ok') break;
      s = { ...r.value.result, damage: 200 };
      penalties.push(repairCostOf(s.data));
    }
    expect(penalties).toEqual([1, 3, 7, 15, 31]);
    // Cost of the next repair: 1 + 31 = 32; efficiency V (5) and silk touch (4) from a book on top reach 40.
    const heavy = stack(ITEM.ENCHANTED_BOOK, { efficiency: 5, silk_touch: 1 });
    expect(anvilCombine(s, heavy, null).kind).toBe('expensive');
    const creative = anvilCombine(s, heavy, null, true);
    if (creative.kind === 'ok') expect(creative.value.cost).toBe(0);
    const base = stack(ITEM.IRON_PICKAXE, { repair_cost: 31 }, 100);
    const r = anvilCombine(base, { id: ITEM.IRON_INGOT, count: 1 }, null);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.value.cost).toBe(32);
    expect(anvilCombine(stack(ITEM.IRON_PICKAXE, { repair_cost: 39 }, 100), { id: ITEM.IRON_INGOT, count: 1 }, null).kind).toBe('expensive');
  });

  it('refuses nonsense combinations', () => {
    expect(anvilCombine(sword(), stack(ITEM.IRON_PICKAXE), null).kind).toBe('none');
    expect(anvilCombine({ id: 0, count: 0 }, stack(ITEM.ENCHANTED_BOOK, { sharpness: 1 }), null).kind).toBe('none');
    expect(anvilCombine({ id: ITEM.IRON_SWORD, count: 2 }, stack(ITEM.ENCHANTED_BOOK, { sharpness: 1 }), null).kind).toBe('none');
    expect(anvilCombine(stack(BLOCK.DIRT), stack(BLOCK.DIRT), null).kind).toBe('none');
  });
});

describe('the grindstone', () => {
  it('removes the enchantments and gives experience', () => {
    const g = grindstoneResult(sword({ sharpness: 3, unbreaking: 2, repair_cost: 7 }, 20), { id: 0, count: 0 }, () => 0)!;
    expect(g.result.data).toBeUndefined();
    expect(g.result.damage).toBe(20);
    // Minimum powers 23 + 13 = 36: half is 18, the roll adds 0..17.
    expect(g.xp).toBe(18);
    expect(grindstoneResult(sword({ sharpness: 3, unbreaking: 2 }), { id: 0, count: 0 }, () => 0.999)!.xp).toBe(35);
  });

  it('keeps a custom name, turns an enchanted book into a book', () => {
    const named = grindstoneResult(sword({ sharpness: 1, ...withCustomName(undefined, 'Zed') }), { id: 0, count: 0 })!;
    expect(customName(named.result.data)).toBe('Zed');
    expect(enchantsOf(named.result.data)).toEqual({});
    const book = grindstoneResult({ id: ITEM.ENCHANTED_BOOK, count: 1, data: { power: 3 } }, { id: 0, count: 0 })!;
    expect(book.result.id).toBe(ITEM_ID.book);
    expect(book.result.data).toBeUndefined();
  });

  it('merges two damaged items with a 5% bonus and no enchantments', () => {
    const g = grindstoneResult(stack(ITEM.IRON_PICKAXE, { efficiency: 2 }, 100), stack(ITEM.IRON_PICKAXE, { fortune: 1 }, 200), () => 0)!;
    // 150 + 50 + 12 (5% of 250) = 212 left -> damage 38
    expect(g.result.damage).toBe(38);
    expect(g.result.data).toBeUndefined();
    expect(g.xp).toBeGreaterThan(0);
    expect(grindstoneResult(sword(), stack(ITEM.IRON_PICKAXE))).toBeNull();
  });

  it('has nothing to do for plain items', () => {
    expect(grindstoneResult(sword(), { id: 0, count: 0 })).toBeNull();
    expect(grindstoneResult({ id: 0, count: 0 }, { id: 0, count: 0 })).toBeNull();
  });
});

describe('mending', () => {
  it('repairs 2 durability per point and returns the surplus', () => {
    const s = stack(ITEM.IRON_PICKAXE, { mending: 1 }, 10);
    expect(applyMending([s], 3)).toBe(0 + 3 - 3);
    expect(s.damage).toBe(4);
    const t = stack(ITEM.IRON_PICKAXE, { mending: 1 }, 5);
    expect(applyMending([t], 10)).toBe(10 - 2);
    expect(t.damage).toBeUndefined();
  });

  it('ignores items without mending or damage', () => {
    const plain = stack(ITEM.IRON_PICKAXE, undefined, 10);
    const full = stack(ITEM.IRON_SWORD, { mending: 1 });
    expect(applyMending([plain, full], 7)).toBe(7);
    expect(plain.damage).toBe(10);
  });

  it('picks one of several candidates', () => {
    const a = stack(ITEM.IRON_PICKAXE, { mending: 1 }, 10);
    const b = stack(ITEM.IRON_AXE, { mending: 1 }, 10);
    applyMending([a, b], 2, () => 0.9);
    expect(a.damage).toBe(10);
    expect(b.damage).toBe(6);
  });
});

describe('enchantments on mining', () => {
  const diamondPick = ITEM.DIAMOND_PICKAXE;
  it('efficiency raises the speed, aqua affinity removes the water penalty', () => {
    const base = breakSeconds(BLOCK.STONE, diamondPick, true, false);
    const eff = breakSeconds(BLOCK.STONE, diamondPick, true, false, 0, { efficiency: 5 });
    expect(eff).toBeLessThan(base);
    const wet = breakSeconds(BLOCK.STONE, diamondPick, true, true);
    expect(wet).toBeGreaterThan(base * 4);
    expect(breakSeconds(BLOCK.STONE, diamondPick, true, true, 0, { aqua_affinity: 1 })).toBe(base);
    // Efficiency does nothing on a block the tool is not made for.
    expect(breakSeconds(BLOCK.DIRT, diamondPick, true, false, 0, { efficiency: 5 })).toBe(breakSeconds(BLOCK.DIRT, diamondPick, true, false));
    // Efficiency V on a diamond pickaxe: speed 8 + 26 = 34 on stone: 1.5 / 34 / 30 * ... 
    expect(eff).toBeCloseTo(Math.ceil(1 / (34 / 1.5 / 30)) / 20);
  });

  it('silk touch drops the block itself', () => {
    expect(blockDrop(BLOCK.STONE, diamondPick, 0, { silk_touch: 1 })?.id).toBe(BLOCK.STONE);
    expect(blockDrop(BLOCK.STONE, diamondPick)?.id).toBe(BLOCK.COBBLESTONE);
    expect(blockDrop(BLOCK.DIAMOND_ORE, diamondPick, 0, { silk_touch: 1 })?.id).toBe(BLOCK.DIAMOND_ORE);
    expect(blockDrop(BLOCK.GLASS, diamondPick, 0, { silk_touch: 1 })?.id).toBe(BLOCK.GLASS);
    expect(blockDrop(BLOCK.GLASS, diamondPick)).toBeNull();
    expect(blockDrop(BLOCK.GRASS, ITEM.IRON_SHOVEL, 0, { silk_touch: 1 })?.id).toBe(BLOCK.GRASS);
    expect(blockDrop(BLOCK.GRASS, ITEM.IRON_SHOVEL)?.id).toBe(BLOCK.DIRT);
    expect(blockDrop(BLOCK.OAK_LEAVES, ITEM.IRON_AXE, 0, { silk_touch: 1 })?.id).toBe(BLOCK.OAK_LEAVES);
    // Silk Touch cannot beat a tool that is too weak.
    expect(blockDrop(BLOCK.DIAMOND_ORE, ITEM.STONE_PICKAXE, 0, { silk_touch: 1 })).toBeNull();
  });

  it('fortune multiplies ore drops', () => {
    const real = Math.random;
    try {
      Math.random = () => 0.99;
      expect(blockDrop(BLOCK.DIAMOND_ORE, diamondPick, 0, { fortune: 3 })).toMatchObject({ id: ITEM.DIAMOND, count: 4 });
      expect(blockDrop(BLOCK.COAL_ORE, diamondPick, 0, { fortune: 2 })).toMatchObject({ id: ITEM.COAL, count: 3 });
      expect(blockDrop(CUBE_ID.redstone_ore, diamondPick, 0, { fortune: 3 })?.count).toBe(5 + 3);
      expect(blockDrop(B_MELON(), diamondPick, 0, { fortune: 3 })?.count).toBe(9);
      Math.random = () => 0;
      expect(blockDrop(BLOCK.DIAMOND_ORE, diamondPick, 0, { fortune: 3 })).toMatchObject({ id: ITEM.DIAMOND, count: 1 });
      expect(blockDrop(BLOCK.GRAVEL, ITEM.IRON_SHOVEL, 0, { fortune: 3 })?.id).toBe(ITEM.FLINT);
    } finally {
      Math.random = real;
    }
    expect(itemId('lapis_lazuli')).toBeGreaterThan(0);
  });
});

function B_MELON(): number {
  return CUBE_ID.melon;
}

describe('enchanted stacks in the registry', () => {
  it('the enchanted book is a real item', () => {
    expect(ITEM_ID.enchanted_book).toBe(ITEM.ENCHANTED_BOOK);
    const e = enchanted(stack(ITEM_ID.book), { sharpness: 2 });
    expect(e.id).toBe(ITEM.ENCHANTED_BOOK);
    expect(e.data).toEqual({ sharpness: 2 });
  });
});
