import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ITEM } from '../src/items/ItemRegistry';
import type { ServerMessage } from '../src/net/protocol';
import { BLOCK } from '../src/world/BlockRegistry';
import { CHEST_HIGH_BIT, CHEST_LOW_BIT } from '../src/world/BlockEntities';
import { KEY_A, KEY_B, type TestClient, type TestServer, cleanup, createRoom, joinGame, startTestServer } from './helpers/serverHarness';

/** 36 inventory rows with the given stacks first. */
function inv(...rows: number[][]): number[][] {
  return Array.from({ length: 36 }, (_, i) => rows[i] ?? [0, 0, 0]);
}

type Container = Extract<ServerMessage, { t: 'container' }>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function waitContainer<O extends Container['op']>(c: TestClient, op: O, test: (m: Extract<Container, { op: O }>) => boolean = () => true, timeout = 4000) {
  return c.waitFor('container', (m) => m.op === op && test(m as Extract<Container, { op: O }>), timeout) as Promise<Extract<Container, { op: O }>>;
}

/** Opens the container at a position, retrying while the server is still loading the chunk. */
async function open(c: TestClient, x: number, y: number, z: number) {
  for (let i = 0; i < 40; i++) {
    const start = c.messages.length;
    c.send({ t: 'container', op: 'open', x, y, z });
    for (let k = 0; k < 40; k++) {
      await sleep(25);
      const m = c.messages.slice(start).find((x) => x.t === 'container' && (x.op === 'open' || x.op === 'deny')) as Container | undefined;
      if (m?.op === 'open') return m;
      if (m) break;
    }
    await sleep(100);
  }
  throw new Error('could not open');
}

describe('containers over the wire', () => {
  const stoppers: TestServer[] = [];
  afterEach(async () => {
    const all = stoppers.splice(0);
    for (const t of all) await t.stop();
    for (const t of all) cleanup(t.dir);
  });

  it('two players share a chest; transfers are checked and duplicates corrected', async () => {
    const t = await startTestServer();
    stoppers.push(t);
    // Built in creative, then played in survival: the switch makes each player's next inventory the baseline.
    const { code, ownerToken } = await createRoom(t.base, { gameMode: 'creative' });
    const a = await joinGame(t, code, 'alice', { key: KEY_A, owner: ownerToken });
    const b = await joinGame(t, code, 'bob', { key: KEY_B });
    expect(a.welcome.containers).toBe(true);
    const sp = a.welcome.spawn;
    const px = Math.floor(sp.x), py = Math.floor(sp.y), pz = Math.floor(sp.z);
    for (const c of [a.client, b.client]) c.send({ t: 'pos', x: sp.x, y: sp.y, z: sp.z, yaw: 0, pitch: 0, flags: 0, held: 0 });
    await sleep(400);

    // Alice places a chest next to her and both open it.
    const cx = px + 2, cy = py, cz = pz;
    a.client.send({ t: 'block', seq: 1, x: cx, y: cy, z: cz, id: BLOCK.CHEST, meta: 0 });
    const opened = await open(a.client, cx, cy, cz);
    expect(opened.kind).toBe('chest');
    expect(opened.slots).toHaveLength(27);
    await open(b.client, cx, cy, cz);

    a.client.send({ t: 'chat', text: '/gamemode survival' });
    await a.client.waitFor('gamemode');
    // Alice holds one cobblestone and a second chest, Bob nothing.
    a.client.send({ t: 'state', inventory: inv([BLOCK.COBBLESTONE, 1, 0], [BLOCK.CHEST, 1, 0]), stats: [20, 20, 5, 0] });
    b.client.send({ t: 'state', inventory: inv(), stats: [20, 20, 5, 0] });
    // Placing a block she does not have is refused (and would otherwise be mined for diamonds).
    a.client.send({ t: 'block', seq: 2, x: px, y: py + 3, z: pz + 2, id: BLOCK.DIAMOND_ORE });
    expect((await a.client.waitFor('reject', (m) => m.seq === 2)).id).toBe(BLOCK.DIAMOND_ORE);

    // Shift-click it into the chest: accepted, and Bob sees the new contents.
    a.client.send({ t: 'container', op: 'click', seq: 1, slot: -1, from: 0, button: 0, shift: true, inv: inv([BLOCK.COBBLESTONE, 1, 0], [BLOCK.CHEST, 1, 0]), cursor: [] });
    const deposit = await waitContainer(a.client, 'result', (m) => m.seq === 1);
    expect(deposit.ok).toBe(true);
    expect(deposit.fromInv).toEqual({ slot: 0, count: 1 });
    const seen = await waitContainer(b.client, 'slots', (m) => m.slots[0]?.[0] === BLOCK.COBBLESTONE);
    expect(seen.slots[0][1]).toBe(1);

    // Duplicate attempt: the same click again with the stale inventory that still holds the cobblestone.
    a.client.send({ t: 'container', op: 'click', seq: 2, slot: -1, from: 0, button: 0, shift: true, inv: inv([BLOCK.COBBLESTONE, 1, 0], [BLOCK.CHEST, 1, 0]), cursor: [] });
    const dupe = await waitContainer(a.client, 'result', (m) => m.seq === 2);
    expect(dupe.ok).toBe(false);
    const fix = await a.client.waitFor('state');
    expect(fix.inventory.some((row) => row[0] === BLOCK.COBBLESTONE)).toBe(false);
    expect(fix.inventory.filter((row) => row[0] === BLOCK.CHEST)).toHaveLength(1);
    // An invented cursor stack is refused as well.
    a.client.send({ t: 'container', op: 'click', seq: 3, slot: 5, button: 0, inv: inv([0, 0, 0], [BLOCK.CHEST, 1, 0]), cursor: [ITEM.DIAMOND, 64, 0] });
    expect((await waitContainer(a.client, 'result', (m) => m.seq === 3)).ok).toBe(false);

    // Bob takes the cobblestone: it is on his cursor, his next inventory with it passes the guard.
    b.client.send({ t: 'container', op: 'click', seq: 1, slot: 0, button: 0, inv: inv(), cursor: [] });
    const take = await waitContainer(b.client, 'result', (m) => m.seq === 1);
    expect(take.ok).toBe(true);
    expect(take.cursor).toEqual([BLOCK.COBBLESTONE, 1, 0]);
    const emptied = await waitContainer(a.client, 'slots', (m) => m.slots.every((s) => s.length === 0));
    expect(emptied.slots).toHaveLength(27);
    b.client.send({ t: 'container', op: 'close' });
    b.client.send({ t: 'state', inventory: inv([BLOCK.COBBLESTONE, 1, 0]), stats: [20, 20, 5, 0] });
    await sleep(200);
    expect(b.client.messages.some((m) => m.t === 'state')).toBe(false);
    // ...but not twice.
    b.client.send({ t: 'state', inventory: inv([BLOCK.COBBLESTONE, 2, 0]), stats: [20, 20, 5, 0] });
    expect((await b.client.waitFor('state')).reason).toMatch(/appeared/);

    // A second chest next to the first makes a double chest of 54 slots; breaking it closes Alice's screen.
    a.client.send({ t: 'block', seq: 4, x: cx + 1, y: cy, z: cz, id: BLOCK.CHEST, meta: CHEST_HIGH_BIT });
    a.client.send({ t: 'block', seq: 5, x: cx, y: cy, z: cz, id: BLOCK.CHEST, meta: CHEST_LOW_BIT });
    await sleep(100);
    const big = await open(a.client, cx + 1, cy, cz);
    expect(big.title).toBe('Large Chest');
    expect(big.slots).toHaveLength(54);
    a.client.send({ t: 'block', seq: 6, x: cx, y: cy, z: cz, id: 0 });
    await waitContainer(a.client, 'close');
    // The other half became a single chest again (sent to everyone).
    const fixHalf = await b.client.waitFor('blocks', (m) => m.edits[0] === cx + 1 && m.edits[3] === BLOCK.CHEST);
    expect(fixHalf.edits[4]).toBe(0);
    a.client.close();
    b.client.close();
  }, 20000);

  it('a furnace smelts on the server and its output is a valid transfer', async () => {
    const t = await startTestServer();
    stoppers.push(t);
    const { code } = await createRoom(t.base, { gameMode: 'creative' });
    const a = await joinGame(t, code, 'cook', { key: KEY_A });
    const sp = a.welcome.spawn;
    a.client.send({ t: 'pos', x: sp.x, y: sp.y, z: sp.z, yaw: 0, pitch: 0, flags: 0, held: 0 });
    await sleep(400);
    const fx = Math.floor(sp.x) + 2, fy = Math.floor(sp.y), fz = Math.floor(sp.z);
    a.client.send({ t: 'block', seq: 1, x: fx, y: fy, z: fz, id: BLOCK.FURNACE, meta: 1 });
    const opened = await open(a.client, fx, fy, fz);
    expect(opened.kind).toBe('furnace');
    expect(opened.props).toEqual([0, 0, 0, 200]);
    // Creative: no guard, so the stacks can be put in directly.
    a.client.send({ t: 'container', op: 'click', seq: 1, slot: 0, button: 0, inv: inv(), cursor: [BLOCK.COBBLESTONE, 2, 0] });
    await waitContainer(a.client, 'result', (m) => m.seq === 1);
    a.client.send({ t: 'container', op: 'click', seq: 2, slot: 1, button: 0, inv: inv(), cursor: [ITEM.COAL, 1, 0] });
    await waitContainer(a.client, 'result', (m) => m.seq === 2);
    // The furnace lights up for everyone (lit furnace block, same facing).
    const lit = await a.client.waitFor('blocks', (m) => m.edits[3] === BLOCK.LIT_FURNACE);
    expect(lit.edits.slice(0, 5)).toEqual([fx, fy, fz, BLOCK.LIT_FURNACE, 1]);
    // After 10 s (200 ticks) the first stone is in the output.
    const done = await waitContainer(a.client, 'slots', (m) => m.slots[2]?.[0] === BLOCK.STONE, 15000);
    expect(done.slots[2][1]).toBe(1);
    a.client.close();
    // Saved with the world: world.json holds the furnace with its slots and burn state.
    await t.stop();
    stoppers.splice(stoppers.indexOf(t), 1);
    const file = readdirSync(t.dir, { recursive: true }).map(String).find((f) => f.endsWith(`${code}/world.json`) || f.endsWith(`${code}\\world.json`))!;
    const saved = JSON.parse(readFileSync(join(t.dir, file), 'utf8')) as { blockEntities: Record<string, { k: string; s: number[][]; d: number[] }> };
    const furnace = saved.blockEntities[`${fx},${fy},${fz}`];
    expect(furnace.k).toBe('furnace');
    expect(furnace.s[2][0]).toBe(BLOCK.STONE);
    expect(furnace.d[1]).toBe(1600);
    cleanup(t.dir);
  }, 20000);
});
