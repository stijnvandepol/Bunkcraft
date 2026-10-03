import { describe, expect, it } from 'vitest';
import { PlayerInventory } from '../src/items/Inventory';
import {
  ALL_ITEMS, ITEM, VARIANT_ITEM_BASE, blockDrop, canHarvest, decodeData, encodeData, getItemDef, itemBlock, itemFromState, itemId, itemMeta,
  normalizeItem, sameItem, stackFromArray, stackToArray,
} from '../src/items/ItemRegistry';
import {
  BLOCK, BLOCK_DEFS, CUBE_ID, DYE, FACE_LAYER, TEXTURE_NAMES, VARIANT_MASK, getBlockDef, textureLayer,
} from '../src/world/BlockRegistry';
import { CUBES, CUBE_FIRST, DYES, WOODS } from '../src/world/Content';
import { CONTENT_PAINTERS } from '../src/rendering/ContentPainters';
import { isValidMeta } from '../src/world/BlockShapes';
import { buildCreativeTabs } from '../src/ui/CreativeTabs';
import { BUILTIN_PACKS, MINECRAFT_LAYOUT } from '../src/rendering/TexturePacks';
import { existsSync } from 'node:fs';

describe('block ids', () => {
  it('are unique and below 255', () => {
    const seen = new Set<number>();
    for (const d of BLOCK_DEFS) {
      expect(d.id).toBeLessThan(255);
      expect(seen.has(d.id)).toBe(false);
      seen.add(d.id);
    }
  });

  it('keeps the ids of saved worlds (append-only tables)', () => {
    expect(BLOCK.STONE).toBe(1);
    expect(BLOCK.WOOL).toBe(31);
    expect(BLOCK.OAK_DOOR).toBe(66);
    expect(CUBE_FIRST).toBe(90);
    expect(CUBE_ID.granite).toBe(90);
    expect(CUBE_ID.copper_ore).toBe(CUBE_FIRST + CUBES.findIndex((c) => c.name === 'copper_ore'));
    expect(CUBES[0].name).toBe('granite');
    expect(CUBES[CUBES.length - 1].name).toBe('stripped_birch_log');
    expect(CUBES.some((c) => c.name === 'packed_mud')).toBe(true);
  });

  it('leaves room for what comes next', () => {
    expect([BLOCK.ENCHANTING_TABLE, BLOCK.ANVIL, BLOCK.GRINDSTONE]).toEqual([250, 251, 252]);
  });
});

describe('textures', () => {
  it('fit in the texture array (layers are bytes, WebGL2 guarantees 256)', () => {
    expect(TEXTURE_NAMES.length).toBeLessThan(256);
  });

  it('all have a painter', async () => {
    const { PAINTER_NAMES } = await import('../src/rendering/TextureAtlas');
    for (const name of TEXTURE_NAMES) {
      if (name.startsWith('destroy_')) continue;
      expect(PAINTER_NAMES.has(name), name).toBe(true);
    }
  });

  it('resolve to a layer for every face of every block', () => {
    for (const d of BLOCK_DEFS) {
      if (!d.textures.all && !d.textures.side && !d.textures.top) continue;
      for (let f = 0; f < 6; f++) expect(FACE_LAYER[d.id * 6 + f]).toBeLessThan(TEXTURE_NAMES.length);
    }
    expect(textureLayer('white_wool')).toBeGreaterThanOrEqual(0);
  });

  it('has painters for the content tables only for names the registry uses', () => {
    for (const name of Object.keys(CONTENT_PAINTERS)) expect(TEXTURE_NAMES.includes(name), name).toBe(true);
  });
});

describe('item identity', () => {
  it('packs block + variant bits into one id and back', () => {
    expect(itemFromState(BLOCK.WOOL, 0)).toBe(BLOCK.WOOL);
    for (let colour = 1; colour < 16; colour++) {
      const id = itemFromState(BLOCK.WOOL, colour);
      expect(id).toBeGreaterThanOrEqual(VARIANT_ITEM_BASE);
      expect(itemBlock(id)).toBe(BLOCK.WOOL);
      expect(itemMeta(id)).toBe(colour);
    }
    // State bits that are not variant bits are not part of the item.
    expect(itemFromState(BLOCK.FURNACE, 3)).toBe(BLOCK.FURNACE);
  });

  it('gives every colour its own named item', () => {
    const names = new Set<string>();
    for (let i = 0; i < 16; i++) {
      const def = getItemDef(itemFromState(BLOCK.CONCRETE, i));
      expect(def?.displayName).toBe(`${DYES[i].display} Concrete`);
      names.add(def!.displayName);
    }
    expect(names.size).toBe(16);
  });

  it('rejects made-up variant items', () => {
    expect(getItemDef(9999)).toBeUndefined();
    expect(getItemDef(VARIANT_ITEM_BASE + BLOCK.STONE + (5 << 8))).toBeUndefined();
    expect(getItemDef(VARIANT_ITEM_BASE + 255 * 3000)).toBeUndefined();
  });

  it('maps the old coloured wools to the new variants', () => {
    expect(normalizeItem(BLOCK.RED_WOOL)).toBe(itemFromState(BLOCK.WOOL, 14));
    expect(normalizeItem(BLOCK.STONE)).toBe(BLOCK.STONE);
  });

  it('keeps wool colours when a block is mined and valid states stay valid', () => {
    const red = itemFromState(BLOCK.WOOL, 14);
    expect(blockDrop(BLOCK.WOOL, 0, 14)).toEqual({ id: red, count: 1 });
    expect(isValidMeta(BLOCK.WOOL, 14)).toBe(true);
    expect(isValidMeta(BLOCK.WOOL, 16)).toBe(false);
    expect(DYE[BLOCK.WOOL]).toBe(1);
    expect(VARIANT_MASK[BLOCK.WOOL]).toBe(15);
  });

  it('has an item def for every id in the registry', () => {
    for (const id of ALL_ITEMS) expect(getItemDef(id), String(id)).toBeDefined();
  });
});

describe('per-stack data (enchantments and friends)', () => {
  it('round-trips through the saved form, old records included', () => {
    const s = { id: ITEM.DIAMOND_SWORD, count: 1, damage: 3, data: { sharpness: 3, looting: 2 } };
    const back = stackFromArray(stackToArray(s));
    expect(back).toEqual(s);
    expect(stackFromArray([BLOCK.STONE, 5, 0])).toEqual({ id: BLOCK.STONE, count: 5 });
    expect(stackFromArray([0, 0, 0])).toBeNull();
    expect(decodeData(encodeData({ efficiency: 4 }))).toEqual({ efficiency: 4 });
  });

  it('never merges stacks with different data', () => {
    const a = { id: BLOCK.STONE, count: 1, data: { x: 1 } as Record<string, number> };
    expect(sameItem(a, { id: BLOCK.STONE, count: 1 })).toBe(false);
    const inv = new PlayerInventory();
    inv.add({ id: ITEM.ARROW, count: 4, data: { power: 1 } });
    inv.add({ id: ITEM.ARROW, count: 4 });
    expect(inv.get(0).count).toBe(4);
    expect(inv.get(1).count).toBe(4);
    inv.add({ id: ITEM.ARROW, count: 4, data: { power: 1 } });
    expect(inv.get(0).count).toBe(8);
  });

  it('survives inventory save and load', () => {
    const inv = new PlayerInventory();
    inv.set(2, { id: ITEM.IRON_PICKAXE, count: 1, damage: 7, data: { efficiency: 3 } });
    inv.set(3, { id: itemFromState(BLOCK.WOOL, 6), count: 12 });
    const copy = new PlayerInventory();
    copy.load(JSON.parse(JSON.stringify(inv.serialize())));
    expect(copy.get(2)).toEqual({ id: ITEM.IRON_PICKAXE, count: 1, damage: 7, data: { efficiency: 3 } });
    expect(copy.get(3)).toEqual({ id: itemFromState(BLOCK.WOOL, 6), count: 12 });
  });
});

describe('ores and tiers', () => {
  it('follow the Java 1.21 harvest levels and drops', () => {
    expect(canHarvest(CUBE_ID.copper_ore, ITEM.WOODEN_PICKAXE)).toBe(false);
    expect(canHarvest(CUBE_ID.copper_ore, ITEM.STONE_PICKAXE)).toBe(true);
    expect(canHarvest(CUBE_ID.lapis_ore, ITEM.STONE_PICKAXE)).toBe(true);
    for (const ore of ['emerald_ore', 'redstone_ore']) {
      expect(canHarvest(CUBE_ID[ore], ITEM.STONE_PICKAXE), ore).toBe(false);
      expect(canHarvest(CUBE_ID[ore], ITEM.IRON_PICKAXE), ore).toBe(true);
    }
    expect(canHarvest(BLOCK.GOLD_ORE, ITEM.GOLDEN_PICKAXE)).toBe(false);
    for (let n = 0; n < 50; n++) {
      const lapis = blockDrop(CUBE_ID.lapis_ore, ITEM.IRON_PICKAXE)!;
      expect(lapis.id).toBe(itemId('lapis_lazuli'));
      expect(lapis.count).toBeGreaterThanOrEqual(4);
      expect(lapis.count).toBeLessThanOrEqual(9);
      const copper = blockDrop(CUBE_ID.copper_ore, ITEM.IRON_PICKAXE)!;
      expect(copper.count).toBeGreaterThanOrEqual(2);
      expect(copper.count).toBeLessThanOrEqual(5);
      const red = blockDrop(CUBE_ID.redstone_ore, ITEM.IRON_PICKAXE)!;
      expect(red.count).toBeGreaterThanOrEqual(4);
      expect(red.count).toBeLessThanOrEqual(5);
    }
  });
});

describe('creative inventory', () => {
  it('lists only items that exist, without duplicates inside a tab', () => {
    for (const tab of buildCreativeTabs()) {
      expect(tab.items.length, tab.name).toBeGreaterThan(0);
      expect(new Set(tab.items).size, tab.name).toBe(tab.items.length);
      for (const id of tab.items) expect(getItemDef(id), `${tab.name} ${id}`).toBeDefined();
    }
  });

  it('has every wood and every colour', () => {
    const building = buildCreativeTabs()[0].items.map((id) => getItemDef(id)!.displayName);
    for (const w of WOODS) expect(building).toContain(`${w.display} Planks`);
    const colored = buildCreativeTabs()[1].items.map((id) => getItemDef(id)!.displayName);
    for (const d of DYES) for (const noun of ['Wool', 'Concrete', 'Terracotta', 'Glazed Terracotta', 'Stained Glass']) {
      expect(colored, `${d.display} ${noun}`).toContain(`${d.display} ${noun}`);
    }
  });

  it('knows blocks by name', () => {
    expect(getBlockDef(CUBE_ID.granite)?.displayName).toBe('Granite');
  });
});

describe('texture pack layouts', () => {
  it('only name textures the registry has', () => {
    for (const name of Object.keys(MINECRAFT_LAYOUT.textures)) expect(TEXTURE_NAMES.includes(name), `minecraft ${name}`).toBe(true);
    for (const pack of BUILTIN_PACKS) for (const name of Object.keys(pack.layout.textures)) expect(TEXTURE_NAMES.includes(name), `${pack.id} ${name}`).toBe(true);
  });

  it('ship every file the built-in pack refers to', () => {
    for (const pack of BUILTIN_PACKS) {
      const files = new Set<string>();
      for (const spec of Object.values(pack.layout.textures)) for (const alt of spec.split('|')) for (const part of alt.split('*')[0].split('^')) files.add(part.split('@')[0]);
      for (const f of files) expect(existsSync(`public/${pack.path}${f}.png`), f).toBe(true);
    }
  });
});
