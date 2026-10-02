import { describe, expect, it } from 'vitest';
import { INVENTORY_SLOTS, PlayerInventory } from '../src/items/Inventory';
import { ITEM, blockDrop, breakSeconds, canHarvest, itemId } from '../src/items/ItemRegistry';
import { RECIPES, type Recipe, type Station, canCraft, craft } from '../src/items/Recipes';
import { BLOCK } from '../src/world/BlockRegistry';

const HAND = new Set<Station>();
const TABLE = new Set<Station>(['table']);
const FURNACE = new Set<Station>(['furnace']);

function recipeFor(id: number, station?: Station): Recipe {
  const r = RECIPES.find((x) => x.result.id === id && (!station || x.station === station));
  if (!r) throw new Error(`no recipe for ${id}`);
  return r;
}

describe('PlayerInventory', () => {
  it('stacks up to 64 and spills into the next free slot', () => {
    const inv = new PlayerInventory();
    expect(inv.add({ id: BLOCK.DIRT, count: 100 })).toBe(0);
    expect(inv.get(0)).toMatchObject({ id: BLOCK.DIRT, count: 64 });
    expect(inv.get(1)).toMatchObject({ id: BLOCK.DIRT, count: 36 });
    expect(inv.count(BLOCK.DIRT)).toBe(100);
  });

  it('merges into existing partial stacks before using empty slots', () => {
    const inv = new PlayerInventory();
    inv.set(3, { id: BLOCK.STONE, count: 60 });
    inv.add({ id: BLOCK.STONE, count: 10 });
    expect(inv.get(3).count).toBe(64);
    expect(inv.get(0)).toMatchObject({ id: BLOCK.STONE, count: 6 });
  });

  it('never stacks tools (maxStack 1)', () => {
    const inv = new PlayerInventory();
    inv.add({ id: ITEM.WOODEN_PICKAXE, count: 1 });
    inv.add({ id: ITEM.WOODEN_PICKAXE, count: 1 });
    expect(PlayerInventory.maxStack(ITEM.WOODEN_PICKAXE)).toBe(1);
    expect(inv.get(0).count).toBe(1);
    expect(inv.get(1).count).toBe(1);
  });

  it('returns what does not fit in a full inventory', () => {
    const inv = new PlayerInventory();
    expect(inv.add({ id: BLOCK.DIRT, count: 64 * INVENTORY_SLOTS + 5 })).toBe(5);
    expect(inv.add({ id: BLOCK.STONE, count: 1 })).toBe(1);
  });

  it('removes across stacks and refuses to remove more than it has', () => {
    const inv = new PlayerInventory();
    inv.add({ id: BLOCK.DIRT, count: 70 });
    expect(inv.remove(BLOCK.DIRT, 71)).toBe(false);
    expect(inv.count(BLOCK.DIRT)).toBe(70);
    expect(inv.remove(BLOCK.DIRT, 68)).toBe(true);
    expect(inv.count(BLOCK.DIRT)).toBe(2);
    // Taken from the main inventory end first, so the hotbar stack survives.
    expect(inv.get(0)).toMatchObject({ id: BLOCK.DIRT, count: 2 });
    expect(inv.get(1)).toMatchObject({ id: 0, count: 0 });
  });

  it('breaks a tool after its durability runs out', () => {
    const inv = new PlayerInventory();
    inv.add({ id: ITEM.WOODEN_PICKAXE, count: 1 });
    let broke = false;
    for (let i = 0; i < 59; i++) broke = inv.damageTool(0);
    expect(broke).toBe(true);
    expect(inv.get(0).id).toBe(0);
  });

  it('round-trips through serialize/load', () => {
    const inv = new PlayerInventory();
    inv.add({ id: BLOCK.DIRT, count: 12 });
    inv.set(8, { id: ITEM.IRON_PICKAXE, count: 1, damage: 7 });
    const copy = new PlayerInventory();
    copy.load(inv.serialize());
    expect(copy.slots).toEqual(inv.slots);
  });
});

describe('Recipes', () => {
  it('crafting consumes the ingredients and adds the result', () => {
    const inv = new PlayerInventory();
    inv.add({ id: BLOCK.OAK_LOG, count: 2 });
    expect(craft(inv, recipeFor(BLOCK.OAK_PLANKS), HAND)).toBe(0);
    expect(inv.count(BLOCK.OAK_LOG)).toBe(1);
    expect(inv.count(BLOCK.OAK_PLANKS)).toBe(4);
  });

  it('accepts mixed plank kinds for one ingredient', () => {
    const inv = new PlayerInventory();
    inv.add({ id: BLOCK.OAK_PLANKS, count: 2 });
    inv.add({ id: BLOCK.BIRCH_PLANKS, count: 2 });
    expect(craft(inv, recipeFor(BLOCK.CRAFTING_TABLE), HAND)).toBe(0);
    expect(inv.count(BLOCK.OAK_PLANKS) + inv.count(BLOCK.BIRCH_PLANKS)).toBe(0);
    expect(inv.count(BLOCK.CRAFTING_TABLE)).toBe(1);
  });

  it('refuses when ingredients are missing and leaves the inventory untouched', () => {
    const inv = new PlayerInventory();
    inv.add({ id: BLOCK.OAK_PLANKS, count: 3 });
    expect(craft(inv, recipeFor(BLOCK.CRAFTING_TABLE), HAND)).toBe(-1);
    expect(inv.count(BLOCK.OAK_PLANKS)).toBe(3);
  });

  it('requires the right station', () => {
    const inv = new PlayerInventory();
    inv.add({ id: BLOCK.COBBLESTONE, count: 8 });
    const furnace = recipeFor(BLOCK.FURNACE);
    expect(canCraft(inv, furnace, HAND)).toBe(false);
    expect(canCraft(inv, furnace, TABLE)).toBe(true);
  });

  it('a single log cannot be both the ingredient and the fuel', () => {
    const coal = recipeFor(ITEM.COAL, 'furnace');
    const inv = new PlayerInventory();
    inv.add({ id: BLOCK.OAK_LOG, count: 1 });
    expect(canCraft(inv, coal, FURNACE)).toBe(false);
    inv.add({ id: BLOCK.OAK_LOG, count: 1 });
    expect(canCraft(inv, coal, FURNACE)).toBe(true);
    expect(craft(inv, coal, FURNACE)).toBe(0);
    expect(inv.count(BLOCK.OAK_LOG)).toBe(0);
    expect(inv.count(ITEM.COAL)).toBe(1);
  });

  it('crafts tools with vanilla ingredient counts', () => {
    const inv = new PlayerInventory();
    inv.add({ id: BLOCK.COBBLESTONE, count: 3 });
    inv.add({ id: ITEM.STICK, count: 2 });
    expect(craft(inv, recipeFor(ITEM.STONE_PICKAXE), TABLE)).toBe(0);
    expect(inv.count(BLOCK.COBBLESTONE)).toBe(0);
    expect(inv.count(ITEM.STICK)).toBe(0);
    expect(inv.count(ITEM.STONE_PICKAXE)).toBe(1);
  });
});

describe('Mining rules', () => {
  it('stone needs a pickaxe to drop anything', () => {
    expect(canHarvest(BLOCK.STONE, 0)).toBe(false);
    expect(blockDrop(BLOCK.STONE, 0)).toBeNull();
    expect(blockDrop(BLOCK.STONE, ITEM.WOODEN_SHOVEL)).toBeNull();
    expect(blockDrop(BLOCK.STONE, ITEM.WOODEN_PICKAXE)).toEqual({ id: BLOCK.COBBLESTONE, count: 1 });
  });

  it('iron ore needs at least a stone pickaxe', () => {
    expect(canHarvest(BLOCK.IRON_ORE, ITEM.WOODEN_PICKAXE)).toBe(false);
    expect(canHarvest(BLOCK.IRON_ORE, ITEM.STONE_PICKAXE)).toBe(true);
    expect(blockDrop(BLOCK.IRON_ORE, ITEM.STONE_PICKAXE)).toEqual({ id: itemId('raw_iron'), count: 1 });
  });

  it('diamond ore needs at least an iron pickaxe', () => {
    expect(canHarvest(BLOCK.DIAMOND_ORE, ITEM.STONE_PICKAXE)).toBe(false);
    expect(canHarvest(BLOCK.DIAMOND_ORE, ITEM.IRON_PICKAXE)).toBe(true);
    expect(canHarvest(BLOCK.DIAMOND_ORE, ITEM.DIAMOND_PICKAXE)).toBe(true);
    expect(blockDrop(BLOCK.DIAMOND_ORE, ITEM.IRON_PICKAXE)).toEqual({ id: ITEM.DIAMOND, count: 1 });
  });

  it('dirt and logs drop by hand', () => {
    expect(blockDrop(BLOCK.DIRT, 0)).toEqual({ id: BLOCK.DIRT, count: 1 });
    expect(blockDrop(BLOCK.GRASS, 0)).toEqual({ id: BLOCK.DIRT, count: 1 });
    expect(blockDrop(BLOCK.OAK_LOG, 0)).toEqual({ id: BLOCK.OAK_LOG, count: 1 });
  });

  it('break times follow the Minecraft formula', () => {
    // Stone (hardness 1.5): by hand 1.5 × 5 = 7.5 s, wooden pickaxe 1.5 × 1.5 / 2 ≈ 1.15 s.
    expect(breakSeconds(BLOCK.STONE, 0, true, false)).toBeCloseTo(7.5, 2);
    expect(breakSeconds(BLOCK.STONE, ITEM.WOODEN_PICKAXE, true, false)).toBeCloseTo(1.15, 2);
    // Dirt (0.5) by hand: 0.75 s; the right tool is faster, the wrong one is not.
    expect(breakSeconds(BLOCK.DIRT, 0, true, false)).toBeCloseTo(0.75, 2);
    expect(breakSeconds(BLOCK.DIRT, ITEM.WOODEN_SHOVEL, true, false)).toBeLessThan(0.75);
    expect(breakSeconds(BLOCK.DIRT, ITEM.WOODEN_PICKAXE, true, false)).toBeCloseTo(0.75, 2);
  });

  it('mining is 5× slower in the air and 5× slower again under water', () => {
    const ground = breakSeconds(BLOCK.DIRT, 0, true, false);
    expect(breakSeconds(BLOCK.DIRT, 0, false, false)).toBeCloseTo(ground * 5, 1);
    expect(breakSeconds(BLOCK.DIRT, 0, false, true)).toBeCloseTo(ground * 25, 1);
  });

  it('every tier mines faster than the one below it', () => {
    const picks = [ITEM.WOODEN_PICKAXE, ITEM.STONE_PICKAXE, ITEM.IRON_PICKAXE, ITEM.DIAMOND_PICKAXE];
    const times = picks.map((p) => breakSeconds(BLOCK.STONE, p, true, false));
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeLessThan(times[i - 1]);
  });
});
