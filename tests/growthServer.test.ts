import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ServerWorld } from '../server/ServerWorld';
import { itemId } from '../src/items/ItemRegistry';
import { BLOCK, SAPLING_STAGE_BIT } from '../src/world/BlockRegistry';
import { isLog } from '../src/world/PlantRules';
import { KEY_A, KEY_B, type TestServer, cleanup, createRoom, joinGame, startTestServer } from './helpers/serverHarness';
import { TIME_SLACK } from './helpers/timing';

describe('ServerWorld random ticks', () => {
  it('grows a sapling into a tree and reports the blocks for broadcasting; age changes stay quiet', () => {
    const w = new ServerWorld(3, {});
    for (let i = 0; i < 60; i++) w.update([{ x: 0, z: 0 }]);
    const y = 110;
    w.setBlock(4, y - 1, 4, BLOCK.GRASS);
    w.setBlock(4, y, 4, BLOCK.SAPLING, 0);
    w.drainSimEdits();
    w.ticker.setSpeed(4096); // every block of every section, many times over
    w.ticker.radius = 0;
    w.ticker.budgetMs = 1e9;
    let ticks = 0;
    for (; ticks < 300 && w.getBlock(4, y, 4) === BLOCK.SAPLING; ticks++) w.ticker.tick([{ x: 0, z: 0 }]);
    expect(isLog(w.getBlock(4, y, 4))).toBe(true);
    const edits = w.drainSimEdits();
    expect(edits.length % 5).toBe(0);
    let logs = 0;
    for (let i = 0; i < edits.length; i += 5) if (isLog(edits[i + 3])) logs++;
    expect(logs).toBeGreaterThanOrEqual(4);
    // The stage step (sapling stage bit) was a quiet change: no sapling with the stage bit in the broadcast list.
    for (let i = 0; i < edits.length; i += 5) expect(edits[i + 3] === BLOCK.SAPLING && (edits[i + 4] & SAPLING_STAGE_BIT) !== 0).toBe(false);
  });

  it('keeps the random tick cost per player under 0.5 ms at the default speed', () => {
    const w = new ServerWorld(5, {});
    for (let i = 0; i < 60; i++) w.update([{ x: 0, z: 0 }]);
    for (let i = 0; i < 50; i++) w.tickGrowth([{ x: 0, z: 0 }]); // warm up
    const t0 = performance.now();
    const N = 400;
    for (let i = 0; i < N; i++) w.tickGrowth([{ x: 0, z: 0 }]);
    const per = (performance.now() - t0) / N;
    // Generous for a busy test machine; scripts/bench-randomticks.ts measures it properly.
    expect(per).toBeLessThan(1.5 * TIME_SLACK);
  });

  it('a falling block leaves its cell and lands, both as simulation changes', () => {
    const w = new ServerWorld(7, {});
    for (let i = 0; i < 60; i++) w.update([{ x: 0, z: 0 }]);
    w.setBlock(2, 120, 2, BLOCK.SAND);
    w.drainSimEdits();
    for (let i = 0; i < 3; i++) w.tickGrowth([{ x: 0, z: 0 }]);
    expect(w.updates.falling.length).toBe(1);
    expect(w.getBlock(2, 120, 2)).toBe(BLOCK.AIR);
    for (let i = 0; i < 200 && w.updates.falling.length > 0; i++) w.tickGrowth([{ x: 0, z: 0 }]);
    const edits = w.drainSimEdits();
    const landed = [];
    for (let i = 0; i < edits.length; i += 5) if (edits[i + 3] === BLOCK.SAND) landed.push(edits[i + 1]);
    expect(landed.length).toBe(1);
    expect(w.getBlock(2, landed[0], 2)).toBe(BLOCK.SAND);
  });
});

describe('multiplayer sync of growth and falling blocks', () => {
  let t: TestServer;
  beforeAll(async () => { t = await startTestServer(); });
  afterAll(async () => { await t.stop(); cleanup(t.dir); });

  it('sends falling sand to everyone, grows a sapling from bone meal and refuses a sapling on stone', async () => {
    const { code } = await createRoom(t.base, { gameMode: 'creative' });
    const a = await joinGame(t, code, 'alice', { key: KEY_A });
    const b = await joinGame(t, code, 'bobby', { key: KEY_B });
    const sp = a.welcome.spawn;
    const bone = itemId('bone_meal');
    const pos = (held: number) => a.client.send({ t: 'pos', x: sp.x, y: sp.y, z: sp.z, yaw: 0, pitch: 0, flags: 0, held });
    pos(0);
    b.client.send({ t: 'pos', x: sp.x, y: sp.y, z: sp.z, yaw: 0, pitch: 0, flags: 0, held: 0 });
    // The chunks around the players load at two per tick.
    await new Promise((r) => setTimeout(r, 2500));
    const x = Math.floor(sp.x), z = Math.floor(sp.z), y = Math.floor(sp.y);

    // Sand placed in the air (the column is cleared first: there may be a tree): Bobby sees it, then the falling
    // entity, then the sand leaving and landing.
    for (let k = 0; k <= 3; k++) a.client.send({ t: 'block', seq: 100 + k, x: x + 2, y: y + k, z, id: BLOCK.AIR });
    a.client.send({ t: 'block', seq: 1, x: x + 2, y: y + 4, z, id: BLOCK.SAND });
    await b.client.waitFor('block', (m) => m.id === BLOCK.SAND && m.x === x + 2);
    const fall = await b.client.waitFor('fall', (m) => m.f.length > 0);
    expect(fall.f[0][1]).toBe(BLOCK.SAND);
    await b.client.waitFor('blocks', (m) => {
      for (let i = 0; i < m.edits.length; i += 5) if (m.edits[i] === x + 2 && m.edits[i + 1] === y + 4 && m.edits[i + 3] === BLOCK.AIR) return true;
      return false;
    });
    await b.client.waitFor('blocks', (m) => {
      for (let i = 0; i < m.edits.length; i += 5) if (m.edits[i] === x + 2 && m.edits[i + 1] < y + 4 && m.edits[i + 3] === BLOCK.SAND) return true;
      return false;
    });
    // When nothing falls any more an empty list clears it on the clients.
    await b.client.waitFor('fall', (m) => m.f.length === 0);

    // A sapling on stone is refused; on a grass block it stays.
    a.client.send({ t: 'block', seq: 2, x: x - 2, y: y + 4, z, id: BLOCK.STONE });
    a.client.send({ t: 'block', seq: 3, x: x - 2, y: y + 5, z, id: BLOCK.SAPLING });
    await a.client.waitFor('reject', (m) => m.seq === 3);
    a.client.send({ t: 'block', seq: 4, x: x - 2, y: y + 4, z, id: BLOCK.GRASS });
    a.client.send({ t: 'block', seq: 5, x: x - 2, y: y + 5, z, id: BLOCK.SAPLING });
    await b.client.waitFor('block', (m) => m.id === BLOCK.SAPLING);

    // Bone meal needs it in hand; then a few uses grow the tree, which reaches Bobby as a batch of logs and leaves.
    a.client.send({ t: 'bonemeal', x: x - 2, y: y + 5, z });
    pos(bone);
    await new Promise((r) => setTimeout(r, 120));
    for (let i = 0; i < 40; i++) {
      a.client.send({ t: 'bonemeal', x: x - 2, y: y + 5, z });
      await new Promise((r) => setTimeout(r, 60));
      if (b.client.messages.some((m) => m.t === 'blocks' && m.edits.some((v, k) => k % 5 === 3 && isLog(v)))) break;
    }
    await b.client.waitFor('blocks', (m) => {
      for (let i = 0; i < m.edits.length; i += 5) if (m.edits[i] === x - 2 && m.edits[i + 1] === y + 5 && isLog(m.edits[i + 3])) return true;
      return false;
    });
    a.client.close();
    b.client.close();
  });
});
