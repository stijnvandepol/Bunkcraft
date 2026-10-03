import { describe, expect, it } from 'vitest';
import { applyContainerClick, clickStacks } from '../src/items/ContainerOps';
import { ITEM, itemId } from '../src/items/ItemRegistry';
import { LOOT_TABLES, fillContainer, hashSeed, rollLoot, seededRng } from '../src/items/Loot';
import { COOK_TICKS, fuelTicks, smeltRecipe } from '../src/items/Smelting';
import {
  BlockEntityStore, CHEST_HIGH_BIT, CHEST_LOW_BIT, ChestEntity, FURNACE_FUEL, FURNACE_INPUT, FURNACE_OUTPUT, FurnaceEntity,
} from '../src/world/BlockEntities';
import { BLOCK, LIGHT_EMIT } from '../src/world/BlockRegistry';
import { blockDrop } from '../src/items/ItemRegistry';
import { EAST, NORTH } from '../src/world/BlockStates';
import { resolvePlacement } from '../src/world/Placement';

/** A tiny world: blocks and states in maps, every change reported to the store like World.setBlock does. */
class FakeWorld {
  readonly blocks = new Map<string, number>();
  readonly metas = new Map<string, number>();
  readonly drops: { x: number; y: number; z: number; ids: number[] }[] = [];
  readonly store: BlockEntityStore;
  constructor() {
    this.store = new BlockEntityStore({
      getBlock: (x, y, z) => this.blocks.get(`${x},${y},${z}`) ?? 0,
      getMeta: (x, y, z) => this.metas.get(`${x},${y},${z}`) ?? 0,
      setState: (x, y, z, id, meta) => this.set(x, y, z, id, meta),
    });
    this.store.onDrops = (x, y, z, stacks) => this.drops.push({ x, y, z, ids: stacks.flatMap((s) => Array(s.count).fill(s.id)) });
  }

  set(x: number, y: number, z: number, id: number, meta = 0): void {
    const k = `${x},${y},${z}`;
    const prev = this.blocks.get(k) ?? 0, prevMeta = this.metas.get(k) ?? 0;
    if (prev === id && prevMeta === meta) return;
    this.blocks.set(k, id);
    this.metas.set(k, meta);
    this.store.onBlockChange(x, y, z, prev, prevMeta, id, meta);
  }
}

const COBBLE = BLOCK.COBBLESTONE;

describe('smelting rules', () => {
  it('has the wiki fuel table and cook times', () => {
    expect(fuelTicks(ITEM.COAL)).toBe(1600);
    expect(fuelTicks(itemId('charcoal'))).toBe(1600);
    expect(fuelTicks(ITEM.LAVA_BUCKET)).toBe(20000);
    expect(fuelTicks(itemId('coal_block'))).toBe(16000);
    expect(fuelTicks(BLOCK.OAK_PLANKS)).toBe(300);
    expect(fuelTicks(BLOCK.OAK_LOG)).toBe(300);
    expect(fuelTicks(ITEM.STICK)).toBe(100);
    expect(fuelTicks(ITEM.WOODEN_PICKAXE)).toBe(200);
    expect(fuelTicks(BLOCK.STONE)).toBe(0);
    expect(COOK_TICKS.furnace).toBe(200);
    expect(COOK_TICKS.blast).toBe(100);
    expect(COOK_TICKS.smoker).toBe(100);
    expect(smeltRecipe(BLOCK.IRON_ORE)?.result.id).toBe(itemId('iron_ingot'));
    expect(smeltRecipe(BLOCK.IRON_ORE)?.xp).toBe(0.7);
    expect(smeltRecipe(ITEM.BEEF, 'smoker')?.result.id).toBe(ITEM.STEAK);
    expect(smeltRecipe(BLOCK.IRON_ORE, 'smoker')).toBeUndefined();
  });

  it('the lit furnace emits light 13 and drops a plain furnace', () => {
    expect(LIGHT_EMIT[BLOCK.LIT_FURNACE]).toBe(13);
    expect(LIGHT_EMIT[BLOCK.FURNACE]).toBe(0);
    expect(blockDrop(BLOCK.LIT_FURNACE, ITEM.WOODEN_PICKAXE)?.id).toBe(BLOCK.FURNACE);
  });
});

describe('furnace entity', () => {
  it('cooks one item per 200 ticks and burns coal for 8 items', () => {
    const w = new FakeWorld();
    w.set(0, 10, 0, BLOCK.FURNACE, EAST);
    const f = w.store.containerAt(0, 10, 0)!.entity as FurnaceEntity;
    expect(f).toBeInstanceOf(FurnaceEntity);
    f.slots[FURNACE_INPUT] = { id: COBBLE, count: 10 };
    f.slots[FURNACE_FUEL] = { id: ITEM.COAL, count: 2 };
    f.changed();
    w.store.tick();
    // Lights up at once, the block becomes the lit furnace and keeps its facing.
    expect(w.blocks.get('0,10,0')).toBe(BLOCK.LIT_FURNACE);
    expect(w.metas.get('0,10,0')).toBe(EAST);
    expect(f.slots[FURNACE_FUEL].count).toBe(1);
    for (let t = 1; t < 199; t++) w.store.tick();
    expect(f.slots[FURNACE_OUTPUT].count).toBe(0);
    w.store.tick();
    expect(f.slots[FURNACE_OUTPUT]).toEqual({ id: BLOCK.STONE, count: 1 });
    expect(f.slots[FURNACE_INPUT].count).toBe(9);
    // 1600 ticks of coal = 8 items; the second coal starts at the ninth.
    for (let t = 0; t < 1400; t++) w.store.tick();
    expect(f.slots[FURNACE_OUTPUT].count).toBe(8);
    expect(f.slots[FURNACE_FUEL].count).toBe(1);
    w.store.tick();
    expect(f.slots[FURNACE_FUEL].count).toBe(0);
    expect(f.xpStored).toBeCloseTo(0.8, 5);
    let awarded = 0;
    w.store.onXpAwarded = (n) => { awarded += n; };
    expect(f.takeXp(() => 0)).toBe(1);
    expect(awarded).toBe(1);
    expect(f.xpStored).toBe(0);
  });

  it('goes out without fuel, loses progress and turns unlit', () => {
    const w = new FakeWorld();
    w.set(0, 10, 0, BLOCK.FURNACE);
    const f = w.store.containerAt(0, 10, 0)!.entity as FurnaceEntity;
    f.slots[FURNACE_INPUT] = { id: COBBLE, count: 5 };
    f.slots[FURNACE_FUEL] = { id: ITEM.STICK, count: 1 }; // 100 ticks: half an item
    f.changed();
    for (let t = 0; t < 100; t++) w.store.tick();
    expect(f.cookTime).toBe(100);
    w.store.tick();
    expect(f.lit).toBe(false);
    expect(w.blocks.get('0,10,0')).toBe(BLOCK.FURNACE);
    // Progress falls back two ticks per tick while the fire is out.
    expect(f.cookTime).toBe(98);
    for (let t = 0; t < 60; t++) w.store.tick();
    expect(f.cookTime).toBe(0);
    expect(w.store.activeCount).toBe(0);
  });

  it('a lava bucket leaves the bucket behind; a full output stops cooking', () => {
    const w = new FakeWorld();
    w.set(0, 10, 0, BLOCK.FURNACE);
    const f = w.store.containerAt(0, 10, 0)!.entity as FurnaceEntity;
    f.slots[FURNACE_INPUT] = { id: COBBLE, count: 5 };
    f.slots[FURNACE_FUEL] = { id: ITEM.LAVA_BUCKET, count: 1 };
    f.slots[FURNACE_OUTPUT] = { id: BLOCK.STONE, count: 64 };
    f.changed();
    w.store.tick();
    expect(f.lit).toBe(false); // nothing to do: fuel is not wasted
    f.slots[FURNACE_OUTPUT] = { id: 0, count: 0 };
    f.changed();
    w.store.tick();
    expect(f.slots[FURNACE_FUEL]).toEqual({ id: ITEM.BUCKET, count: 1 });
    expect(f.burnTotal).toBe(20000);
  });

  it('does not tick while its chunk is not loaded', () => {
    const w = new FakeWorld();
    w.set(0, 10, 0, BLOCK.FURNACE);
    const f = w.store.containerAt(0, 10, 0)!.entity as FurnaceEntity;
    f.slots[FURNACE_INPUT] = { id: COBBLE, count: 5 };
    f.slots[FURNACE_FUEL] = { id: ITEM.COAL, count: 1 };
    f.changed();
    w.store.tick();
    w.blocks.set('0,10,0', BLOCK.UNLOADED);
    for (let t = 0; t < 50; t++) w.store.tick();
    expect(f.cookTime).toBe(1);
    w.blocks.set('0,10,0', BLOCK.LIT_FURNACE);
    w.store.tick();
    expect(f.cookTime).toBe(2);
  });
});

describe('chests', () => {
  it('drop their contents when broken and survive a save', () => {
    const w = new FakeWorld();
    w.set(1, 64, 2, BLOCK.CHEST);
    const ref = w.store.containerAt(1, 64, 2)!;
    expect(ref.entity.slots.length).toBe(27);
    ref.entity.slots[0] = { id: ITEM.DIAMOND, count: 5 };
    ref.entity.slots[3] = { id: ITEM.IRON_PICKAXE, count: 1, damage: 4, data: { efficiency: 2 } };
    ref.entity.changed();
    const saved = JSON.parse(JSON.stringify(w.store.serialize()));
    const w2 = new FakeWorld();
    w2.blocks.set('1,64,2', BLOCK.CHEST);
    w2.store.load(saved);
    expect(w2.store.get(1, 64, 2)!.slots[3]).toEqual({ id: ITEM.IRON_PICKAXE, count: 1, damage: 4, data: { efficiency: 2 } });
    w2.set(1, 64, 2, BLOCK.AIR);
    expect(w2.drops[0].ids.filter((id) => id === ITEM.DIAMOND).length).toBe(5);
    expect(w2.store.get(1, 64, 2)).toBeUndefined();
    expect(new BlockEntityStore({ getBlock: () => 0, getMeta: () => 0, setState: () => {} }).serialize()).toBeUndefined();
  });

  it('pair into a double chest of 54 slots and split again', () => {
    const w = new FakeWorld();
    const ctx = (x: number) => ({
      id: BLOCK.CHEST, hitX: x, hitY: 9, hitZ: 0, nx: 0, ny: 1, nz: 0, fracY: 1, yaw: 0,
      getBlock: (bx: number, by: number, bz: number) => (by === 9 ? BLOCK.STONE : w.blocks.get(`${bx},${by},${bz}`) ?? 0),
      getMeta: (bx: number, by: number, bz: number) => w.metas.get(`${bx},${by},${bz}`) ?? 0,
    });
    const a = resolvePlacement(ctx(0))!;
    w.set(a.x, a.y, a.z, a.id, a.meta);
    w.store.containerAt(0, 10, 0)!.entity.slots[0] = { id: ITEM.DIAMOND, count: 1 };
    const b = resolvePlacement(ctx(1))!;
    expect(b.meta).toBe(NORTH | CHEST_HIGH_BIT);
    expect(b.neighbor).toEqual({ x: 0, y: 10, z: 0, id: BLOCK.CHEST, meta: NORTH | CHEST_LOW_BIT });
    w.set(b.x, b.y, b.z, b.id, b.meta);
    w.set(b.neighbor!.x, b.neighbor!.y, b.neighbor!.z, b.neighbor!.id, b.neighbor!.meta);
    // Either half opens the same 54 slots (held by the low half), the old contents kept.
    const left = w.store.containerAt(0, 10, 0)!, right = w.store.containerAt(1, 10, 0)!;
    expect(left.entity).toBe(right.entity);
    expect(left.title).toBe('Large Chest');
    expect(left.entity.slots.length).toBe(54);
    expect(left.entity.slots[0].id).toBe(ITEM.DIAMOND);
    left.entity.slots[30] = { id: ITEM.GOLD_INGOT, count: 7 };
    // Breaking the low half drops its 27 slots; the high half keeps slots 27..53 as a single chest.
    w.set(0, 10, 0, BLOCK.AIR);
    expect(w.drops[0].ids).toEqual([ITEM.DIAMOND]);
    expect(w.metas.get('1,10,0')).toBe(NORTH);
    const rest = w.store.containerAt(1, 10, 0)!;
    expect(rest.entity).toBeInstanceOf(ChestEntity);
    expect(rest.entity.slots.length).toBe(27);
    expect(rest.entity.slots[3]).toEqual({ id: ITEM.GOLD_INGOT, count: 7 });
  });

  it('a claimed pair without a real partner stays a single chest', () => {
    const w = new FakeWorld();
    w.set(5, 10, 5, BLOCK.CHEST, NORTH | CHEST_LOW_BIT);
    expect(w.store.containerAt(5, 10, 5)!.entity.slots.length).toBe(27);
  });

  it('roll a loot table on first open, the same for the same seed', () => {
    const open = (seed: number) => {
      const w = new FakeWorld();
      w.set(0, 10, 0, BLOCK.CHEST);
      expect(w.store.setLoot(0, 10, 0, 'dungeon_chest', seed)).toBe(true);
      const saved = JSON.parse(JSON.stringify(w.store.serialize()));
      const w2 = new FakeWorld();
      w2.blocks.set('0,10,0', BLOCK.CHEST);
      w2.store.load(saved);
      return JSON.stringify(w2.store.containerAt(0, 10, 0)!.entity.slots);
    };
    expect(open(7)).toBe(open(7));
    expect(open(7)).not.toBe(open(8));
    expect(JSON.parse(open(7)).some((s: { count: number }) => s.count > 0)).toBe(true);
  });
});

describe('loot tables', () => {
  it('are deterministic for a seed and respect pools and counts', () => {
    for (const table of Object.values(LOOT_TABLES)) {
      const a = rollLoot(table, seededRng(hashSeed(42, 1, 2, 3)));
      const b = rollLoot(table, seededRng(hashSeed(42, 1, 2, 3)));
      expect(a).toEqual(b);
      expect(a.length).toBeGreaterThan(0);
      for (const s of a) expect(s.count).toBeGreaterThan(0);
    }
    const bonus = rollLoot(LOOT_TABLES.spawn_bonus_chest, seededRng(1));
    const axes = bonus.filter((s) => s.id === ITEM.WOODEN_AXE || s.id === ITEM.STONE_AXE);
    expect(axes.length).toBe(1);
  });

  it('conditions: killed by player, chance and looting', () => {
    const table = {
      id: 't', pools: [{ rolls: 1, entries: [{ item: 'spider_eye', weight: 1, conditions: [{ t: 'killed_by_player' as const }] }] }],
    };
    expect(rollLoot(table, seededRng(1))).toEqual([]);
    expect(rollLoot(table, seededRng(1), { killedByPlayer: true })).toEqual([{ id: ITEM.SPIDER_EYE, count: 1 }]);
    const looted = { id: 'l', pools: [{ rolls: 1, entries: [{ item: 'string', weight: 1, count: [0, 2] as const, lootingBonus: 1 }] }] };
    let plain = 0, withLooting = 0;
    for (let i = 0; i < 300; i++) {
      plain += rollLoot(looted, seededRng(i)).reduce((n, s) => n + s.count, 0);
      withLooting += rollLoot(looted, seededRng(i), { looting: 3 }).reduce((n, s) => n + s.count, 0);
    }
    expect(withLooting).toBeGreaterThan(plain);
  });

  it('fillContainer scatters stacks into free slots', () => {
    const slots = Array.from({ length: 27 }, () => ({ id: 0, count: 0 }));
    const left = fillContainer(slots, [{ id: ITEM.BONE, count: 10 }, { id: ITEM.BONE, count: 10 }, { id: ITEM.STRING, count: 3 }], seededRng(3));
    expect(left).toEqual([]);
    expect(slots.filter((s) => s.count > 0).length).toBe(2);
    expect(slots.find((s) => s.id === ITEM.BONE)!.count).toBe(20);
  });
});

describe('container clicks', () => {
  it('follow the cursor rules and keep the furnace output take-only', () => {
    expect(clickStacks({ id: 0, count: 0 }, { id: ITEM.COAL, count: 5 }, true)).toEqual({ slot: { id: ITEM.COAL, count: 1 }, cursor: { id: ITEM.COAL, count: 4 } });
    expect(clickStacks({ id: ITEM.COAL, count: 5 }, { id: 0, count: 0 }, true)).toEqual({ slot: { id: ITEM.COAL, count: 2 }, cursor: { id: ITEM.COAL, count: 3 } });
    const slots = [{ id: 0, count: 0 }, { id: 0, count: 0 }, { id: BLOCK.STONE, count: 4 }];
    // Nothing can be put into the output; stone is no fuel.
    expect(applyContainerClick('furnace', slots, { slot: 2, button: 0, shift: false }, { id: COBBLE, count: 1 }, []).cursor).toEqual({ id: COBBLE, count: 1 });
    expect(applyContainerClick('furnace', slots, { slot: 1, button: 0, shift: false }, { id: BLOCK.STONE, count: 1 }, []).spent).toEqual([]);
    const take = applyContainerClick('furnace', slots, { slot: 2, button: 0, shift: false }, { id: 0, count: 0 }, []);
    expect(take.tookOutput).toBe(true);
    expect(take.gained).toEqual([{ id: BLOCK.STONE, count: 4 }]);
    // Shift from the inventory sends ore to the input and coal to the fuel slot.
    const inv = [{ id: BLOCK.IRON_ORE, count: 3 }, { id: ITEM.COAL, count: 2 }];
    const f = [{ id: 0, count: 0 }, { id: 0, count: 0 }, { id: 0, count: 0 }];
    applyContainerClick('furnace', f, { slot: -1, from: 0, button: 0, shift: true }, { id: 0, count: 0 }, inv);
    applyContainerClick('furnace', f, { slot: -1, from: 1, button: 0, shift: true }, { id: 0, count: 0 }, inv);
    expect(f).toEqual([{ id: BLOCK.IRON_ORE, count: 3 }, { id: ITEM.COAL, count: 2 }, { id: 0, count: 0 }]);
  });
});
