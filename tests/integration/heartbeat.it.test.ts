import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, type TestServer, createRoom, sleep, startServer } from './harness';

/** Real-time tests that must wait for the server's own timers (25 s heartbeat, 10 s hello deadline). */
let srv: TestServer;
beforeAll(async () => { srv = await startServer(); });
afterAll(async () => { await srv.dispose(); });

describe('connection liveness', () => {
  it.concurrent('pings idle clients every 25 s and keeps answering clients alive for more than 30 s', async () => {
    const code = await createRoom(srv);
    const c = await Client.join(`${srv.ws}/ws/${code}`, 'sleeper');
    const other = await Client.join(`${srv.ws}/ws/${code}`, 'chatter');
    try {
      await sleep(27_000);
      expect(c.pings).toBeGreaterThanOrEqual(1);
      expect(c.closed).toBeNull();
      other.send({ t: 'chat', text: 'still here' });
      await c.waitFor((m) => m.t === 'chat' && m.text === 'still here');
    } finally { c.close(); other.close(); }
  }, 40_000);

  it.concurrent('closes a socket that never says hello within 10 s', async () => {
    const code = await createRoom(srv);
    const c = await Client.open(`${srv.ws}/ws/${code}`);
    const closed = await c.waitClosed(13_000);
    expect(closed.code).toBe(1008);
    expect(closed.reason).toMatch(/No hello/);
  }, 20_000);
});
