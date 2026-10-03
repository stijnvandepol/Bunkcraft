import { afterEach, describe, expect, it } from 'vitest';
import { ITEM } from '../src/items/ItemRegistry';
import { BLOCK } from '../src/world/BlockRegistry';
import { InventoryGuard, parseInventory } from '../server/InventoryGuard';
import { KEY_A, type TestServer, cleanup, createRoom, joinGame, startTestServer } from './helpers/serverHarness';

/** 36 slots with the given stacks in the first slots. */
const inv = (...stacks: number[][]): number[][] => [...stacks, ...Array.from({ length: 36 - stacks.length }, () => [0, 0, 0])];

describe('parseInventory', () => {
  it('accepts well-formed inventories, integer data columns, and rejects garbage columns', () => {
    expect(parseInventory(inv([BLOCK.STONE, 64, 0])).error).toBeUndefined();
    expect(parseInventory([[BLOCK.STONE, 64, 0, 0, 3]]).error).toBeUndefined(); // key index, value
    expect(parseInventory([[BLOCK.STONE, 64, 0, { some: 'data' }]] as unknown as number[][]).error).toMatch(/item data/);
    expect(parseInventory([]).error).toBeUndefined();
  });

  it('rejects unknown ids, bad counts, too many slots, non-integers and tool damage out of range', () => {
    expect(parseInventory(inv([9999, 1, 0])).error).toMatch(/unknown item/);
    expect(parseInventory(inv([BLOCK.STONE, 65, 0])).error).toMatch(/stack size/);
    expect(parseInventory(inv([BLOCK.STONE, 0, 0])).error).toMatch(/stack size/);
    expect(parseInventory(inv([BLOCK.STONE, -3, 0])).error).toMatch(/stack size/);
    expect(parseInventory(inv([BLOCK.STONE, 1.5, 0])).error).toBeDefined();
    // 36 inventory slots + 4 worn armor slots is the most there can be.
    expect(parseInventory(Array.from({ length: 41 }, () => [0, 0, 0])).error).toMatch(/too many/);
    expect(parseInventory(inv([ITEM.WOODEN_PICKAXE, 2, 0])).error).toMatch(/stack size/); // tools do not stack
    expect(parseInventory(inv([ITEM.WOODEN_PICKAXE, 1, 100000])).error).toMatch(/damage/);
    expect(parseInventory('lots').error).toBeDefined();
    expect(parseInventory([[1]]).error).toBeDefined();
  });
});

describe('InventoryGuard: items only enter through routes the server saw', () => {
  it('rejects items that appear from nowhere', () => {
    const g = new InventoryGuard([]);
    const r = g.check(inv([ITEM.DIAMOND, 64, 0]));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/appeared/);
      expect(r.correction.every((s) => s[0] === 0)).toBe(true);
    }
  });

  it('accepts pickups the server approved, rearranging, using and dropping items', () => {
    const g = new InventoryGuard([]);
    g.creditPickup(BLOCK.COBBLESTONE, 10);
    expect(g.check(inv([BLOCK.COBBLESTONE, 10, 0])).ok).toBe(true);
    // Moving stacks around is always fine.
    expect(g.check(inv([0, 0, 0], [BLOCK.COBBLESTONE, 4, 0], [BLOCK.COBBLESTONE, 6, 0])).ok).toBe(true);
    // Using some (placing blocks) lowers the count.
    expect(g.check(inv([BLOCK.COBBLESTONE, 3, 0])).ok).toBe(true);
    // A second state with more than the pool allows is refused.
    expect(g.check(inv([BLOCK.COBBLESTONE, 30, 0])).ok).toBe(false);
  });

  it('allows crafting from what the player held, including chains', () => {
    const g = new InventoryGuard([{ id: BLOCK.OAK_LOG, count: 1 }]);
    // 1 log → 4 planks
    expect(g.check(inv([BLOCK.OAK_PLANKS, 4, 0])).ok).toBe(true);
    // 4 planks → crafting table (4 planks)
    expect(g.check(inv([BLOCK.CRAFTING_TABLE, 1, 0])).ok).toBe(true);
    const chain = new InventoryGuard([{ id: BLOCK.OAK_LOG, count: 1 }]);
    // 1 log → planks → sticks, in one go between two updates
    expect(chain.check(inv([ITEM.STICK, 4, 0], [BLOCK.OAK_PLANKS, 2, 0])).ok).toBe(true);
  });

  it('refuses crafting without the ingredients and results the recipes cannot produce', () => {
    const g = new InventoryGuard([{ id: BLOCK.OAK_LOG, count: 1 }]);
    expect(g.check(inv([BLOCK.OAK_PLANKS, 8, 0])).ok).toBe(false); // 1 log makes only 4
    expect(g.check(inv([ITEM.DIAMOND_PICKAXE, 1, 0])).ok).toBe(false);
    expect(g.check(inv([ITEM.DIAMOND, 1, 0])).ok).toBe(false); // no recipe at all
  });

  it('crafting consumes its ingredients: keeping the log and the planks is refused', () => {
    const g = new InventoryGuard([{ id: BLOCK.OAK_LOG, count: 1 }]);
    expect(g.check(inv([BLOCK.OAK_LOG, 1, 0], [BLOCK.OAK_PLANKS, 4, 0])).ok).toBe(false);
    // Repeating it would otherwise turn one log into endless planks.
    expect(g.check(inv([BLOCK.OAK_PLANKS, 4, 0])).ok).toBe(true);
  });

  it('crafting uses the alternative the player actually spent (birch planks used, oak planks kept)', () => {
    const g = new InventoryGuard([{ id: BLOCK.OAK_PLANKS, count: 2 }, { id: BLOCK.BIRCH_LOG, count: 1 }]);
    expect(g.check(inv([BLOCK.OAK_PLANKS, 2, 0], [BLOCK.BIRCH_PLANKS, 2, 0], [ITEM.STICK, 4, 0])).ok).toBe(true);
  });

  it('refuses stack sizes the client could not build', () => {
    const g = new InventoryGuard([{ id: BLOCK.DIRT, count: 64 }, { id: BLOCK.DIRT, count: 64 }]);
    expect(g.check(inv([BLOCK.DIRT, 100, 0])).ok).toBe(false);
  });

  it('the correction is the last accepted inventory plus approved pickups, in the same slots', () => {
    const g = new InventoryGuard([]);
    g.creditPickup(BLOCK.DIRT, 5);
    expect(g.check(inv([0, 0, 0], [BLOCK.DIRT, 5, 0])).ok).toBe(true);
    g.creditPickup(BLOCK.STONE, 2);
    const bad = g.check(inv([0, 0, 0], [BLOCK.DIRT, 5, 0], [ITEM.DIAMOND, 9, 0]));
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.correction[1]).toEqual([BLOCK.DIRT, 5, 0]);
      expect(bad.correction.find((s) => s[0] === BLOCK.STONE)?.[1]).toBe(2);
      expect(bad.correction.some((s) => s[0] === ITEM.DIAMOND)).toBe(false);
      expect(bad.correction).toHaveLength(36);
    }
  });

  it('a new baseline can be trusted once (game mode changed)', () => {
    const g = new InventoryGuard([]);
    g.trustNextState();
    expect(g.check(inv([ITEM.DIAMOND, 64, 0])).ok).toBe(true);
    expect(g.check(inv([ITEM.DIAMOND, 64, 0], [ITEM.GOLD_INGOT, 1, 0])).ok).toBe(false);
  });
});

describe('InventoryGuard: drops', () => {
  it('a block the player broke explains its drop, once', () => {
    const g = new InventoryGuard([]);
    expect(g.authorizeDrop(BLOCK.STONE, 1)).toBe(false);
    g.creditBreak(BLOCK.STONE); // drops cobblestone
    expect(g.authorizeDrop(BLOCK.COBBLESTONE, 1)).toBe(true);
    expect(g.authorizeDrop(BLOCK.COBBLESTONE, 1)).toBe(false); // the credit is used up
  });

  it('gravel may drop flint, and a block never explains an unrelated item', () => {
    const g = new InventoryGuard([]);
    g.creditBreak(BLOCK.GRAVEL);
    expect(g.authorizeDrop(ITEM.FLINT, 1)).toBe(true);
    g.creditBreak(BLOCK.DIRT);
    expect(g.authorizeDrop(ITEM.DIAMOND, 1)).toBe(false);
  });

  it('inventory-backed drops (Q, death) are limited to what the player holds and cannot be repeated', () => {
    const g = new InventoryGuard([{ id: BLOCK.DIRT, count: 10 }]);
    expect(g.authorizeDrop(BLOCK.DIRT, 6)).toBe(true);
    expect(g.authorizeDrop(BLOCK.DIRT, 6)).toBe(false); // only 4 left: no duplicating by repeating drop
    expect(g.authorizeDrop(BLOCK.DIRT, 4)).toBe(true);
    // A rollback does not hand the dropped items back.
    const r = g.check(inv([BLOCK.DIRT, 10, 0]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.correction.some((s) => s[0] === BLOCK.DIRT)).toBe(false);
  });

  it('drop then pick up is not a duplication route: the pickup is credited once', () => {
    const g = new InventoryGuard([{ id: BLOCK.DIRT, count: 5 }]);
    expect(g.authorizeDrop(BLOCK.DIRT, 5)).toBe(true);
    g.creditPickup(BLOCK.DIRT, 5); // the server item entity was taken back
    expect(g.check(inv([BLOCK.DIRT, 5, 0])).ok).toBe(true);
    expect(g.check(inv([BLOCK.DIRT, 10, 0])).ok).toBe(false);
  });

  it('break credits expire', () => {
    let now = 1_000_000;
    const g = new InventoryGuard([], () => now);
    g.creditBreak(BLOCK.STONE);
    now += 120_000;
    expect(g.authorizeDrop(BLOCK.COBBLESTONE, 1)).toBe(false);
  });
});

describe('inventory guard over the wire', () => {
  const stoppers: TestServer[] = [];
  afterEach(async () => {
    const all = stoppers.splice(0);
    for (const t of all) await t.stop();
    for (const t of all) cleanup(t.dir);
  });

  it('rolls an invented survival inventory back with a state message; creative rooms are exempt', async () => {
    const t = await startTestServer();
    stoppers.push(t);
    const survival = await createRoom(t.base, { gameMode: 'survival' });
    const creative = await createRoom(t.base, { gameMode: 'creative' });

    const s = await joinGame(t, survival.code, 'cheater', { key: KEY_A });
    s.client.send({ t: 'state', inventory: inv([ITEM.DIAMOND, 64, 0]), stats: [20, 20, 5, 0] });
    const fix = await s.client.waitFor('state');
    expect(fix.inventory.every((row) => row[0] === 0)).toBe(true);
    expect(fix.reason).toMatch(/appeared/);
    // The bad inventory was not stored: a later login starts empty.
    s.client.close();
    await new Promise((r) => setTimeout(r, 50));
    const again = await joinGame(t, survival.code, 'cheater', { key: KEY_A });
    expect(again.welcome.player?.inventory ?? []).toEqual([]);
    again.client.close();

    const c = await joinGame(t, creative.code, 'builder', { key: KEY_A });
    c.client.send({ t: 'state', inventory: inv([ITEM.DIAMOND, 64, 0]), stats: [20, 20, 5, 0] });
    await new Promise((r) => setTimeout(r, 150));
    expect(c.client.messages.some((m) => m.t === 'state')).toBe(false);
    c.client.close();
  });

  it('survival drops need a block break or an item in the inventory', async () => {
    const t = await startTestServer();
    stoppers.push(t);
    const { code } = await createRoom(t.base, { gameMode: 'survival' });
    const p = await joinGame(t, code, 'dropper', { key: KEY_A });
    p.client.send({ t: 'pos', x: 0.5, y: 100, z: 0.5, yaw: 0, pitch: 0, flags: 0, held: 0 });
    // A forged drop of 64 diamonds creates no item entity.
    p.client.send({ t: 'drop', id: ITEM.DIAMOND, count: 64, x: 0.5, y: 101, z: 0.5 });
    await new Promise((r) => setTimeout(r, 300));
    const ents = p.client.messages.filter((m) => m.t === 'ent') as { t: 'ent'; i: unknown[][] }[];
    expect(ents.flatMap((e) => e.i)).toHaveLength(0);
    p.client.close();
  });
});
