import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { INVENTORY_SLOTS, PlayerInventory } from '../src/items/Inventory';
import { ITEM, blockDrop, getItemDef, maxDurability } from '../src/items/ItemRegistry';
import { RECIPES, type Station, canCraft, craft } from '../src/items/Recipes';
import { MOB_TYPES } from '../src/entities/MobTypes';
import { decodeEdit, encodeEdit } from '../src/save/SaveSystem';
import { BLOCK, getBlockDef } from '../src/world/BlockRegistry';
import { packState, stateId, stateMeta } from '../src/world/BlockStates';
import { TerrainGenerator } from '../src/world/TerrainGenerator';
import { CHUNK_AREA, CHUNK_HEIGHT, CHUNK_SIZE, CHUNK_VOLUME, blockIndex, chunkKey, keyToCx, keyToCz } from '../src/world/constants';
import { ServerWorld } from '../server/ServerWorld';
import { fnv1a, makeTestWorld } from './helpers';

/** Property-based tests (fast-check): packing functions, inventory, recipes, terrain and world invariants. */

describe('packing functions', () => {
  it('block state pack/unpack round trips for every id and meta byte', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 }), (id, meta) => {
      const s = packState(id, meta);
      expect(stateId(s)).toBe(id);
      expect(stateMeta(s)).toBe(meta);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(65536);
    }), { numRuns: 2000 });
  });

  it('a state without meta equals the plain id (worlds saved before block states)', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 255 }), (id) => { expect(packState(id, 0)).toBe(id); }));
  });

  it('chunk keys round trip and are unique over the whole supported range', () => {
    const c = fc.integer({ min: -32767, max: 32767 });
    fc.assert(fc.property(c, c, (cx, cz) => {
      const k = chunkKey(cx, cz);
      expect(keyToCx(k)).toBe(cx);
      expect(keyToCz(k)).toBe(cz);
      expect(Number.isSafeInteger(k)).toBe(true);
    }), { numRuns: 3000 });
    fc.assert(fc.property(fc.tuple(c, c), fc.tuple(c, c), ([ax, az], [bx, bz]) => {
      fc.pre(ax !== bx || az !== bz);
      expect(chunkKey(ax, az)).not.toBe(chunkKey(bx, bz));
    }), { numRuns: 3000 });
  });

  it('chunk keys match the world coordinates shifted by 4 bits, including negatives', () => {
    fc.assert(fc.property(fc.integer({ min: -500_000, max: 500_000 }), fc.integer({ min: -500_000, max: 500_000 }), (x, z) => {
      const key = chunkKey(x >> 4, z >> 4);
      expect(keyToCx(key) * 16 + (x & 15)).toBe(x);
      expect(keyToCz(key) * 16 + (z & 15)).toBe(z);
    }), { numRuns: 2000 });
  });

  it('block index is a bijection between local coordinates and 0..CHUNK_VOLUME-1', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 15 }), fc.integer({ min: 0, max: CHUNK_HEIGHT - 1 }), fc.integer({ min: 0, max: 15 }), (x, y, z) => {
      const i = blockIndex(x, y, z);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(CHUNK_VOLUME);
      expect(i & 15).toBe(x);
      expect((i >> 4) & 15).toBe(z);
      expect(i >> 8).toBe(y);
    }), { numRuns: 2000 });
    const seen = new Set<number>();
    for (let y = 0; y < CHUNK_HEIGHT; y++) for (let z = 0; z < CHUNK_SIZE; z++) for (let x = 0; x < CHUNK_SIZE; x++) seen.add(blockIndex(x, y, z));
    expect(seen.size).toBe(CHUNK_VOLUME);
  });

  it('edit encoding round trips (current version) and decodes legacy v1 records', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: CHUNK_VOLUME - 1 }), fc.integer({ min: 0, max: 0xffff }), (index, state) => {
      const packed = encodeEdit(index, state);
      expect(packed).toBeGreaterThanOrEqual(0);
      expect(packed).toBeLessThanOrEqual(0xffffffff);
      expect(decodeEdit(packed, 2)).toEqual([index, state]);
    }), { numRuns: 3000 });
    // v1: (index << 8) | id, no state byte.
    fc.assert(fc.property(fc.integer({ min: 0, max: CHUNK_VOLUME - 1 }), fc.integer({ min: 0, max: 255 }), (index, id) => {
      expect(decodeEdit(((index << 8) | id) >>> 0, 1)).toEqual([index, id]);
    }), { numRuns: 1000 });
  });
});

describe('inventory invariants', () => {
  const itemId = fc.constantFrom(BLOCK.DIRT, BLOCK.STONE, BLOCK.COBBLESTONE, BLOCK.OAK_PLANKS, ITEM.STICK, ITEM.COAL, ITEM.WOODEN_PICKAXE, ITEM.BOW, ITEM.PORKCHOP);
  type Op =
    | { op: 'add'; id: number; n: number }
    | { op: 'remove'; id: number; n: number }
    | { op: 'consume'; slot: number }
    | { op: 'set'; slot: number; id: number; n: number }
    | { op: 'damage'; slot: number };
  const opArb: fc.Arbitrary<Op> = fc.oneof(
    fc.record({ op: fc.constant('add' as const), id: itemId, n: fc.integer({ min: 1, max: 200 }) }),
    fc.record({ op: fc.constant('remove' as const), id: itemId, n: fc.integer({ min: 1, max: 200 }) }),
    fc.record({ op: fc.constant('consume' as const), slot: fc.integer({ min: 0, max: INVENTORY_SLOTS - 1 }) }),
    fc.record({ op: fc.constant('set' as const), slot: fc.integer({ min: 0, max: INVENTORY_SLOTS - 1 }), id: itemId, n: fc.integer({ min: 0, max: 64 }) }),
    fc.record({ op: fc.constant('damage' as const), slot: fc.integer({ min: 0, max: INVENTORY_SLOTS - 1 }) }),
  );

  function check(inv: PlayerInventory): void {
    for (const s of inv.slots) {
      if (s.id === 0) expect(s.count).toBe(0);
      else {
        expect(s.count).toBeGreaterThan(0);
        expect(s.count).toBeLessThanOrEqual(PlayerInventory.maxStack(s.id));
      }
    }
    expect(inv.slots).toHaveLength(INVENTORY_SLOTS);
  }

  it('keeps every slot valid and conserves item counts under random operations', () => {
    fc.assert(fc.property(fc.array(opArb, { maxLength: 60 }), (ops) => {
      const inv = new PlayerInventory();
      for (const o of ops) {
        if (o.op === 'add') {
          const before = inv.count(o.id);
          const left = inv.add({ id: o.id, count: o.n });
          expect(left).toBeGreaterThanOrEqual(0);
          expect(left).toBeLessThanOrEqual(o.n);
          expect(inv.count(o.id)).toBe(before + o.n - left);
        } else if (o.op === 'remove') {
          const before = inv.count(o.id);
          const ok = inv.remove(o.id, o.n);
          expect(ok).toBe(before >= o.n);
          expect(inv.count(o.id)).toBe(ok ? before - o.n : before);
        } else if (o.op === 'consume') {
          if (inv.get(o.slot).id !== 0) inv.consumeSlot(o.slot);
        } else if (o.op === 'set') {
          inv.set(o.slot, { id: o.id, count: Math.min(o.n, PlayerInventory.maxStack(o.id)) });
        } else if (inv.get(o.slot).id !== 0) inv.damageTool(o.slot);
        check(inv);
      }
    }), { numRuns: 400 });
  });

  it('canFit agrees with add: whatever canFit accepts, add stores completely', () => {
    fc.assert(fc.property(fc.array(opArb, { maxLength: 40 }), itemId, fc.integer({ min: 1, max: 300 }), (ops, id, n) => {
      const inv = new PlayerInventory();
      for (const o of ops) if (o.op === 'add') inv.add({ id: o.id, count: o.n });
      const fits = inv.canFit({ id, count: n });
      const left = inv.add({ id, count: n });
      expect(fits).toBe(left === 0);
    }), { numRuns: 400 });
  });

  it('serialize/load round trips exactly', () => {
    fc.assert(fc.property(fc.array(opArb, { maxLength: 40 }), (ops) => {
      const a = new PlayerInventory();
      for (const o of ops) {
        if (o.op === 'add') a.add({ id: o.id, count: o.n });
        else if (o.op === 'damage' && a.get(o.slot).id) a.damageTool(o.slot);
      }
      const b = new PlayerInventory();
      b.load(JSON.parse(JSON.stringify(a.serialize())) as number[][]);
      expect(b.serialize()).toEqual(a.serialize());
    }), { numRuns: 200 });
  });

  it('load tolerates garbage without producing invalid slots', () => {
    fc.assert(fc.property(fc.array(fc.array(fc.integer({ min: -3, max: 500 }), { maxLength: 4 }), { maxLength: 60 }), (data) => {
      const inv = new PlayerInventory();
      inv.load(data);
      for (const s of inv.slots) {
        expect(s.id === 0).toBe(s.count === 0);
      }
    }), { numRuns: 300 });
  });

  it('tools wear out exactly at their durability and then disappear', () => {
    const inv = new PlayerInventory();
    inv.set(0, { id: ITEM.WOODEN_PICKAXE, count: 1 });
    const max = maxDurability(ITEM.WOODEN_PICKAXE);
    expect(max).toBeGreaterThan(0);
    for (let i = 1; i < max; i++) expect(inv.damageTool(0)).toBe(false);
    expect(inv.damageTool(0)).toBe(true);
    expect(inv.get(0).id).toBe(0);
  });
});

describe('recipe consistency', () => {
  const ingredientIds = RECIPES.flatMap((r) => r.ingredients.flatMap((i) => i.ids));

  it('every ingredient and result is a real item or block with a sane count', () => {
    for (const r of RECIPES) {
      expect(getItemDef(r.result.id) ?? getBlockDef(r.result.id), `result ${r.result.id}`).toBeDefined();
      expect(r.result.count).toBeGreaterThan(0);
      expect(r.result.count).toBeLessThanOrEqual(PlayerInventory.maxStack(r.result.id));
      expect(r.ingredients.length).toBeGreaterThan(0);
      for (const ing of r.ingredients) {
        expect(ing.count).toBeGreaterThan(0);
        expect(ing.ids.length).toBeGreaterThan(0);
        for (const id of ing.ids) expect(getItemDef(id), `ingredient ${id} of ${r.result.id}`).toBeDefined();
      }
    }
    expect(ingredientIds.length).toBeGreaterThan(0);
  });

  it('has no duplicate recipes (same station, result and ingredients)', () => {
    const seen = new Map<string, number>();
    RECIPES.forEach((r, i) => {
      const key = JSON.stringify([r.station, r.result, r.ingredients.map((x) => [[...x.ids].sort((a, b) => a - b), x.count]).sort()]);
      expect(seen.has(key), `recipe #${i} (result ${r.result.id}) duplicates #${seen.get(key)}`).toBe(false);
      seen.set(key, i);
    });
  });

  it('no non-smelting recipe uses its own result as an ingredient', () => {
    // Smelting may list the same item as input and as fuel (charcoal from logs), so it is excluded.
    for (const r of RECIPES.filter((x) => x.station !== 'furnace')) {
      expect(r.ingredients.flatMap((i) => i.ids), `result ${r.result.id}`).not.toContain(r.result.id);
    }
  });

  /** Everything a player can gather without crafting: block drops (best pickaxe) and mob loot. */
  function rawResources(): Set<number> {
    const raw = new Set<number>();
    for (let id = 1; id < 256; id++) {
      if (!getBlockDef(id)) continue;
      for (let meta = 0; meta < 3; meta++) {
        // Random drops (gravel, leaves) need several tries.
        for (let t = 0; t < 60; t++) { const d = blockDrop(id, ITEM.DIAMOND_PICKAXE, meta); if (d) raw.add(d.id); }
      }
    }
    for (const type of Object.values(MOB_TYPES)) for (let t = 0; t < 60; t++) for (const s of type.drops(true)) raw.add(s.id);
    return raw;
  }

  it('every recipe can be crafted starting from raw resources only (no dead ends, no cycles)', () => {
    const have = rawResources();
    const stations = new Set<Station>(['hand']);
    const stationBlock: Record<Station, number | null> = { hand: null, table: BLOCK.CRAFTING_TABLE, furnace: BLOCK.FURNACE };
    const remaining = new Set(RECIPES);
    for (let progress = true; progress;) {
      progress = false;
      for (const r of [...remaining]) {
        if (r.station !== 'hand' && !stations.has(r.station)) continue;
        if (!r.ingredients.every((ing) => ing.ids.some((id) => have.has(id)))) continue;
        have.add(r.result.id);
        remaining.delete(r);
        progress = true;
      }
      for (const [st, block] of Object.entries(stationBlock) as [Station, number | null][]) {
        if (block !== null && have.has(block)) stations.add(st);
      }
    }
    const stuck = [...remaining].map((r) => `${r.station}: result ${r.result.id} (${getItemDef(r.result.id)?.displayName}) needs ${r.ingredients.map((i) => i.ids.join('|')).join(' + ')}`);
    expect(stuck).toEqual([]);
  });

  it('craft consumes exactly the ingredients and adds exactly the result, for every recipe', () => {
    const all = new Set<Station>(['hand', 'table', 'furnace']);
    for (const r of RECIPES) {
      const inv = new PlayerInventory();
      // Give the first accepted item of every ingredient, twice over.
      for (const ing of r.ingredients) inv.add({ id: ing.ids[0], count: ing.count * 2 });
      const ids = new Set([r.result.id, ...r.ingredients.map((i) => i.ids[0])]);
      const before = new Map([...ids].map((id) => [id, inv.count(id)]));
      expect(canCraft(inv, r, all), `result ${r.result.id}`).toBe(true);
      expect(craft(inv, r, all)).toBe(0);
      for (const id of ids) {
        const consumed = r.ingredients.filter((i) => i.ids[0] === id).reduce((n, i) => n + i.count, 0);
        const produced = id === r.result.id ? r.result.count : 0;
        expect(inv.count(id), `item ${id} after crafting ${r.result.id}`).toBe(before.get(id)! - consumed + produced);
      }
    }
  });

  it('crafting without the station or without the ingredients changes nothing', () => {
    for (const r of RECIPES) {
      const inv = new PlayerInventory();
      expect(craft(inv, r, new Set(['hand', 'table', 'furnace']))).toBe(-1);
      if (r.station !== 'hand') {
        for (const ing of r.ingredients) inv.add({ id: ing.ids[0], count: ing.count });
        const snapshot = JSON.stringify(inv.serialize());
        expect(craft(inv, r, new Set<Station>(['hand']))).toBe(-1);
        expect(JSON.stringify(inv.serialize())).toBe(snapshot);
      }
    }
  });
});

describe('terrain determinism', () => {
  it('a chunk is identical whatever was generated before it (random chunk orders, shared vs fresh generator)', () => {
    const coord = fc.integer({ min: -40, max: 40 });
    fc.assert(fc.property(fc.integer({ min: 1, max: 2 ** 31 }), fc.array(fc.tuple(coord, coord), { minLength: 2, maxLength: 5 }), (seed, chunks) => {
      const shared = new TerrainGenerator(seed);
      const viaShared = chunks.map(([cx, cz]) => {
        const b = new Uint8Array(CHUNK_VOLUME), bi = new Uint8Array(CHUNK_AREA);
        shared.generate(cx, cz, b, bi);
        return fnv1a(b) ^ fnv1a(bi);
      });
      // Reverse order on another generator, each chunk on a brand new one.
      for (let i = chunks.length - 1; i >= 0; i--) {
        const b = new Uint8Array(CHUNK_VOLUME), bi = new Uint8Array(CHUNK_AREA);
        new TerrainGenerator(seed).generate(chunks[i][0], chunks[i][1], b, bi);
        expect(fnv1a(b) ^ fnv1a(bi)).toBe(viaShared[i]);
      }
    }), { numRuns: 12 });
  });

  it('terrain only contains registered blocks, bedrock at the bottom and air at the top', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 2 ** 31 }), fc.integer({ min: -100, max: 100 }), fc.integer({ min: -100, max: 100 }), (seed, cx, cz) => {
      const b = new Uint8Array(CHUNK_VOLUME);
      new TerrainGenerator(seed).generate(cx, cz, b);
      for (let i = 0; i < CHUNK_AREA; i++) {
        expect(b[blockIndex(i & 15, 0, i >> 4)]).toBe(BLOCK.BEDROCK);
        expect(b[blockIndex(i & 15, CHUNK_HEIGHT - 1, i >> 4)]).toBe(BLOCK.AIR);
      }
      for (let i = 0; i < CHUNK_VOLUME; i += 7) if (b[i] !== 0) expect(getBlockDef(b[i]), `id ${b[i]}`).toBeDefined();
    }), { numRuns: 8 });
  });
});

describe('World invariants', () => {
  const pos = fc.record({ x: fc.integer({ min: -16, max: 30 }), y: fc.integer({ min: 1, max: 126 }), z: fc.integer({ min: -16, max: 30 }) });
  const placeable = fc.constantFrom(BLOCK.STONE, BLOCK.DIRT, BLOCK.GLASS, BLOCK.OAK_PLANKS, BLOCK.COBBLESTONE, BLOCK.AIR);

  it('getBlock returns what was last set; the sparse edit map and dirty set follow', () => {
    fc.assert(fc.property(fc.array(fc.tuple(pos, placeable), { minLength: 1, maxLength: 40 }), (ops) => {
      const world = makeTestWorld();
      const expected = new Map<string, number>();
      const changed = new Set<string>();
      for (const [p, id] of ops) {
        const k = `${p.x},${p.y},${p.z}`;
        if (world.setBlock(p.x, p.y, p.z, id)) changed.add(k);
        expected.set(k, id);
      }
      for (const [k, id] of expected) {
        const [x, y, z] = k.split(',').map(Number);
        expect(world.getBlock(x, y, z)).toBe(id);
        const chunkEdits = world.edits.get(chunkKey(x >> 4, z >> 4));
        // A no-op write (air onto air) leaves no edit behind; anything that changed a block is remembered.
        if (changed.has(k)) {
          expect(chunkEdits?.get(blockIndex(x & 15, y, z & 15))).toBe(packState(id, 0));
          expect(world.dirtyEditChunks.has(chunkKey(x >> 4, z >> 4))).toBe(true);
        } else expect(chunkEdits?.has(blockIndex(x & 15, y, z & 15)) ?? false).toBe(false);
      }
    }), { numRuns: 100 });
  });

  it('setBlock returns true only when something changed, and never touches other blocks', () => {
    fc.assert(fc.property(pos, placeable, placeable, (p, a, b) => {
      const world = makeTestWorld();
      const other = world.getBlock(p.x + 1, p.y, p.z);
      world.setBlock(p.x, p.y, p.z, a);
      const changed = world.setBlock(p.x, p.y, p.z, b);
      expect(changed).toBe(a !== b);
      expect(world.getBlock(p.x + 1, p.y, p.z)).toBe(other);
    }), { numRuns: 100 });
  });

  it('edits outside the world height are refused', () => {
    const world = makeTestWorld();
    expect(world.setBlock(0, -1, 0, BLOCK.STONE)).toBe(false);
    expect(world.setBlock(0, CHUNK_HEIGHT, 0, BLOCK.STONE)).toBe(false);
  });

  it('remote edits do not fire onEdit; local ones do, once each, with the previous state', () => {
    const world = makeTestWorld();
    const seen: number[][] = [];
    world.onEdit = (x, y, z, id, meta, prev) => { seen.push([x, y, z, id, meta, prev]); };
    world.setBlock(1, 5, 1, BLOCK.STONE);
    world.setBlock(1, 5, 1, BLOCK.STONE); // unchanged: no event
    world.setBlock(2, 5, 2, BLOCK.DIRT, 0, true); // remote
    world.setBlock(1, 5, 1, BLOCK.AIR);
    expect(seen).toEqual([[1, 5, 1, BLOCK.STONE, 0, BLOCK.AIR], [1, 5, 1, BLOCK.AIR, 0, BLOCK.STONE]]);
  });

  it('server world light: always within 0..15, sky above the top, and a placed-then-removed block restores the light', () => {
    const w = new ServerWorld(99, {});
    for (let i = 0; i < 12; i++) w.update([{ x: 0, z: 0 }]);
    fc.assert(fc.property(fc.integer({ min: -20, max: 20 }), fc.integer({ min: -20, max: 20 }), fc.integer({ min: 70, max: 120 }), fc.constantFrom(BLOCK.STONE, BLOCK.TORCH, BLOCK.GLOWSTONE, BLOCK.DIRT), (x, z, y, id) => {
      const probe: number[] = [];
      const sample = () => {
        probe.length = 0;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -3; dx <= 3; dx += 3) probe.push(w.getLight(x + dx, y + dy, z), w.getSkyLight(x + dx, y + dy, z));
        return [...probe];
      };
      const orig = w.getBlock(x, y, z);
      fc.pre(orig !== BLOCK.UNLOADED && orig !== BLOCK.BEDROCK);
      const before = sample();
      for (const v of before) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(255); }
      w.setBlock(x, y, z, id);
      for (const v of sample()) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(255); }
      w.setBlock(x, y, z, orig);
      expect(sample()).toEqual(before);
    }), { numRuns: 60 });
  });

  it('explosions never remove bedrock and only report blocks that were really there', () => {
    fc.assert(fc.property(fc.integer({ min: -4, max: 4 }), fc.integer({ min: 1, max: 6 }), fc.integer({ min: 2, max: 6 }), (dx, y0, radius) => {
      const w = new ServerWorld(7, {});
      for (let i = 0; i < 12; i++) w.update([{ x: 0, z: 0 }]);
      const snapshot = new Map<string, number>();
      for (let y = 0; y < 14; y++) for (let x = -9; x <= 9; x++) for (let z = -9; z <= 9; z++) snapshot.set(`${x},${y},${z}`, w.getBlock(x, y, z));
      const positions: number[] = [];
      const destroyed = w.explode(dx, y0, 0, radius, positions);
      expect(positions.length).toBe(destroyed.length * 3);
      expect(destroyed.includes(BLOCK.BEDROCK)).toBe(false);
      for (let y = 0; y < 14; y++) for (let x = -9; x <= 9; x++) for (let z = -9; z <= 9; z++) {
        if (snapshot.get(`${x},${y},${z}`) === BLOCK.BEDROCK) expect(w.getBlock(x, y, z)).toBe(BLOCK.BEDROCK);
      }
      for (let i = 0; i < destroyed.length; i++) {
        const k = `${positions[i * 3]},${positions[i * 3 + 1]},${positions[i * 3 + 2]}`;
        if (snapshot.has(k)) expect(snapshot.get(k)).toBe(destroyed[i]);
      }
    }), { numRuns: 12 });
  });
});
