/**
 * Farming in multiplayer: crops grow on the server (random ticks, sent as block changes), planting and tilling go
 * through the placement guard (seeds back crops, no false refusals), trampling and bone meal reach everyone.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ServerWorld } from '../server/ServerWorld';
import { itemId } from '../src/items/ItemRegistry';
import { BLOCK } from '../src/world/BlockRegistry';
import { CROP_BLOCK, FARMLAND } from '../src/world/Crops';
import { KEY_A, KEY_B, type TestServer, cleanup, createRoom, joinGame, startTestServer } from './helpers/serverHarness';

const WHEAT = CROP_BLOCK.WHEAT;
const inv = (...stacks: number[][]): number[][] => [...stacks, ...Array.from({ length: 36 - stacks.length }, () => [0, 0, 0])];

describe('ServerWorld farming', () => {
  it('grows crops on random ticks and reports every stage for broadcasting; farmland hydrates', () => {
    const w = new ServerWorld(3, {});
    for (let i = 0; i < 60; i++) w.update([{ x: 0, z: 0 }]);
    const y = 110;
    for (let x = 2; x <= 6; x++) for (let z = 2; z <= 6; z++) { w.setBlock(x, y - 1, z, FARMLAND, 0); w.setBlock(x, y, z, BLOCK.AIR); }
    w.setBlock(4, y - 1, 6, BLOCK.WATER);
    w.setBlock(4, y, 4, WHEAT, 0);
    w.drainSimEdits();
    w.ticker.setSpeed(4096);
    w.ticker.radius = 0;
    w.ticker.budgetMs = 1e9;
    w.ticker.maxChanges = 1e9;
    for (let i = 0; i < 400 && w.getMeta(4, y, 4) < 7; i++) w.ticker.tick([{ x: 0, z: 0 }]);
    expect(w.getMeta(4, y, 4)).toBe(7);
    expect(w.getMeta(2, y - 1, 2)).toBe(7);
    const edits = w.drainSimEdits();
    const ages: number[] = [];
    for (let i = 0; i < edits.length; i += 5) if (edits[i + 3] === WHEAT) ages.push(edits[i + 4]);
    expect(ages).toEqual([1, 2, 3, 4, 5, 6, 7]);
    // Wet farmland is sent (it looks different); the quiet drying steps are not.
    expect(edits.some((v, k) => k % 5 === 3 && v === FARMLAND)).toBe(true);
  });
});

describe('farming over the wire', () => {
  let t: TestServer;
  beforeAll(async () => { t = await startTestServer(); });
  afterAll(async () => { await t.stop(); cleanup(t.dir); });

  it('tills, plants from seeds (refused without), bone meal grows it for everyone, trampling uproots it', async () => {
    const { code, ownerToken } = await createRoom(t.base, { gameMode: 'creative' });
    const a = await joinGame(t, code, 'alice', { key: KEY_A, owner: ownerToken });
    const b = await joinGame(t, code, 'bobby', { key: KEY_B });
    const sp = a.welcome.spawn;
    const pos = (held: number) => a.client.send({ t: 'pos', x: sp.x, y: sp.y, z: sp.z, yaw: 0, pitch: 0, flags: 0, held });
    pos(0);
    b.client.send({ t: 'pos', x: sp.x, y: sp.y, z: sp.z, yaw: 0, pitch: 0, flags: 0, held: 0 });
    await new Promise((r) => setTimeout(r, 2500));
    const x = Math.floor(sp.x), z = Math.floor(sp.z), y = Math.floor(sp.y);
    // In creative: a strip of dirt with air above (and stone further down) to farm on, water at the end.
    let seq = 1;
    const put = (bx: number, by: number, bz: number, id: number, meta = 0) => a.client.send({ t: 'block', seq: seq++, x: bx, y: by, z: bz, id, meta });
    for (let dx = 1; dx <= 4; dx++) {
      put(x + dx, y - 2, z, BLOCK.STONE);
      put(x + dx, y - 1, z, BLOCK.DIRT);
      put(x + dx, y, z, BLOCK.AIR);
      put(x + dx, y + 1, z, BLOCK.AIR);
    }
    put(x + 5, y - 1, z, BLOCK.WATER);
    await b.client.waitFor('block', (m) => m.x === x + 5 && m.id === BLOCK.WATER);

    // Survival from here: the next inventory is trusted as the baseline (two wheat seeds and a hoe).
    a.client.send({ t: 'chat', text: '/gamemode survival' });
    await a.client.waitFor('chat', (m) => /game mode to survival/.test(m.text));
    a.client.send({ t: 'state', inventory: inv([itemId('wheat_seeds'), 2, 0], [itemId('wooden_hoe'), 1, 0]), stats: [20, 20, 5, 0] });
    await new Promise((r) => setTimeout(r, 150));

    // Tilling is never refused.
    for (let dx = 1; dx <= 4; dx++) put(x + dx, y - 1, z, FARMLAND);
    await b.client.waitFor('block', (m) => m.x === x + 4 && m.id === FARMLAND);
    // Seeds plant wheat on farmland; a third with only two seeds is refused, and so is wheat on dirt.
    const plant = seq; put(x + 1, y, z, WHEAT); put(x + 2, y, z, WHEAT); put(x + 3, y, z, WHEAT);
    await a.client.waitFor('reject', (m) => m.seq === plant + 2);
    expect(a.client.messages.some((m) => m.t === 'reject' && (m.seq === plant || m.seq === plant + 1))).toBe(false);
    await b.client.waitFor('block', (m) => m.x === x + 2 && m.id === WHEAT);
    put(x + 1, y - 3, z, WHEAT);
    await a.client.waitFor('reject', (m) => m.seq === seq - 1);

    // Bone meal (in hand) grows the wheat on the server: Bobby sees the stages arrive.
    pos(itemId('bone_meal'));
    await new Promise((r) => setTimeout(r, 120));
    for (let i = 0; i < 8; i++) {
      a.client.send({ t: 'bonemeal', x: x + 1, y, z });
      await new Promise((r) => setTimeout(r, 60));
    }
    const grown = await b.client.waitFor('blocks', (m) => {
      for (let i = 0; i < m.edits.length; i += 5) if (m.edits[i] === x + 1 && m.edits[i + 3] === WHEAT && m.edits[i + 4] === 7) return true;
      return false;
    });
    expect(grown).toBeTruthy();

    // Landing on the farmland tramples it (free edit); the server's block update uproots the wheat for everyone.
    pos(0);
    const trampleSeq = seq;
    put(x + 2, y - 1, z, BLOCK.DIRT);
    await b.client.waitFor('block', (m) => m.x === x + 2 && m.y === y - 1 && m.id === BLOCK.DIRT);
    await b.client.waitFor('blocks', (m) => {
      for (let i = 0; i < m.edits.length; i += 5) if (m.edits[i] === x + 2 && m.edits[i + 1] === y && m.edits[i + 3] === BLOCK.AIR) return true;
      return false;
    });
    expect(a.client.messages.some((m) => m.t === 'reject' && (m.seq === trampleSeq || (m.seq < plant && m.seq > 0)))).toBe(false);
    a.client.close();
    b.client.close();
  }, 30_000);
});
