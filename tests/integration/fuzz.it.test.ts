import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '../../src/net/protocol';
import { Client, type TestServer, api, createRoom, sleep, startServer } from './harness';

/** Garbage over real sockets: the server process must stay up and keep serving everybody else. */
let srv: TestServer;
beforeAll(async () => { srv = await startServer(); });
afterAll(async () => { await srv.dispose(); });

const healthy = async (): Promise<boolean> => (await api<{ ok: boolean }>(srv, 'GET', '/health')).body.ok === true;

describe('real server under garbage', () => {
  it('survives random text, binary and truncated frames from many sockets, and still serves new players', async () => {
    const code = await createRoom(srv);
    const bystander = await Client.join(`${srv.ws}/ws/${code}`, 'bystander');
    const frames = fc.sample(fc.oneof(
      fc.uint8Array({ maxLength: 300 }).map((u) => Buffer.from(u)),
      fc.string({ maxLength: 120 }),
      fc.jsonValue().filter((v) => v !== null).map((v) => JSON.stringify(v)),
      fc.record({ t: fc.constantFrom('pos', 'block', 'chat', 'fire', 'drop', 'state', 'hello', 'attack', 'shoot'), x: fc.anything(), y: fc.anything(), z: fc.anything(), id: fc.anything(), text: fc.anything(), v: fc.anything() })
        .map((m) => JSON.stringify(m)),
    ), { numRuns: 600, seed: 42 });
    let sent = 0;
    for (let i = 0; i < frames.length; i += 50) {
      let c: Client;
      try { c = await Client.open(`${srv.ws}/ws/${code}`, 'fuzz', undefined); } catch { continue; }
      if (i % 100 === 0) c.send({ t: 'hello', v: PROTOCOL_VERSION, name: `fuzz${i}` });
      for (const f of frames.slice(i, i + 50)) {
        if (c.ws.readyState !== 1) break;
        c.sendRaw(f);
        sent++;
      }
      await sleep(30);
      c.close();
    }
    expect(sent).toBeGreaterThan(300);
    expect(await healthy()).toBe(true);
    expect(bystander.closed).toBeNull();
    bystander.send({ t: 'chat', text: 'unharmed' });
    await bystander.waitFor((m) => m.t === 'chat' && m.text === 'unharmed');
    const fresh = await Client.join(`${srv.ws}/ws/${code}`, 'fresh');
    expect(fresh.welcome.id).toBeGreaterThan(0);
    fresh.close();
    bystander.close();
  }, 40_000);

  it('answers room API garbage with errors, never a crash', async () => {
    for (const body of ['', '[]', 'null', '"x"', '{"name":{"a":1},"seed":[1],"gameMode":5,"gameType":{},"scoreLimit":"x","timeLimitSec":null,"mapId":7}', 'x'.repeat(10_000)]) {
      // An oversized body (> 4 KiB) makes the server hang up instead of answering.
      const res = await fetch(`${srv.http}/api/rooms`, { method: 'POST', body, headers: { 'x-forwarded-for': '10.99.0.1' } }).catch(() => null);
      if (res) expect([201, 400, 500]).toContain(res.status);
      else expect(body.length).toBeGreaterThan(4096);
    }
    for (const path of ['/api/rooms/%00', '/api/rooms/%E0%A4%A', '/api/rooms/' + 'A'.repeat(5000), '/%', '/api/']) {
      const res = await fetch(`${srv.http}${path}`, { headers: { 'x-forwarded-for': '10.99.0.2' } });
      expect(res.status).toBeLessThan(500);
    }
    expect(await healthy()).toBe(true);
  });

  // BUG (server/GameServer.ts accept()): a frame with the JSON literal `null` makes `msg.t` throw inside the socket
  // handler. The exception is not caught anywhere, so one anonymous client can kill the whole server process.
  it.fails('stays up when a client sends the JSON literal null', async () => {
    const own = await startServer();
    try {
      const code = await createRoom(own);
      const c = await Client.open(`${own.ws}/ws/${code}`);
      c.sendRaw('null');
      await sleep(500);
      expect((await api<{ ok: boolean }>(own, 'GET', '/health')).body.ok).toBe(true);
    } finally { await own.dispose(); }
  });
});
