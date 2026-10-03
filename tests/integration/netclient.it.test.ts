import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { NetClient } from '../../src/net/NetClient';
import { BLOCK } from '../../src/world/BlockRegistry';
import { Client, type TestServer, createRoom, sleep, startServer } from './harness';

/** The browser's own NetClient (Node's built-in WebSocket) against the real server process. */
let srv: TestServer;
const open: NetClient[] = [];
beforeAll(async () => {
  srv = await startServer();
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('location', { protocol: 'http:', host: `127.0.0.1:${srv.port}` });
});
afterAll(async () => { await sleep(200); await srv.dispose(); }); // globals stay stubbed: late close events still need `window`
afterEach(() => { open.splice(0).forEach((c) => c.close()); });

describe('NetClient against the real server', () => {
  it('logs in to a room, edits blocks that other players see, and gets rejects rolled back', async () => {
    const code = await createRoom(srv);
    const net = new NetClient();
    open.push(net);
    const welcome = await net.connect(srv.ws, 'browser1', code);
    expect(welcome.gameType).toBe('minecraft');
    const other = await Client.join(`${srv.ws}/ws/${code}`, 'observer');

    const s = welcome.spawn;
    net.update(1, s.x, s.y, s.z, 0, 0, 4, 0);
    await sleep(100);
    const reverted: number[][] = [];
    net.onRevert = (x, y, z, id, meta) => reverted.push([x, y, z, id, meta]);
    const x = Math.floor(s.x) + 1, y = Math.floor(s.y), z = Math.floor(s.z);
    net.sendBlock(x, y, z, BLOCK.STONE, 0, BLOCK.AIR, 0);
    const seen = await other.waitFor<Extract<import('../../src/net/protocol').ServerMessage, { t: 'block' }>>((m) => m.t === 'block');
    expect(seen).toMatchObject({ x, y, z, id: BLOCK.STONE });

    net.sendBlock(x + 500, y, z, BLOCK.STONE, 0, BLOCK.DIRT, 0); // out of reach: refused
    await vi.waitFor(() => expect(reverted).toEqual([[x + 500, y, z, BLOCK.DIRT, 0]]), { timeout: 3000 });
    other.close();
  });

  it('reports a missing game and an outdated login with readable errors', async () => {
    await expect(new NetClient().connect(srv.ws, 'browser2', 'ZZZZZZ')).rejects.toThrow(/Game not found/);
    const code = await createRoom(srv);
    await expect(new NetClient().connect(srv.ws, 'x', code)).rejects.toThrow(/Invalid name/);
  });

  it('refuses a second player who takes a name that is already online, and keeps the first connected', async () => {
    const code = await createRoom(srv);
    const first = new NetClient();
    open.push(first);
    await first.connect(srv.ws, 'twin', code);
    const reasons: string[] = [];
    first.onClose = (r) => reasons.push(r);
    // Another browser (other identity key) cannot steal the name.
    await expect(new NetClient().connect(srv.ws, 'TWIN', code)).rejects.toThrow(/already used/);
    await sleep(200);
    expect(reasons).toEqual([]);
    expect(first.connected).toBe(true);
  });
});
