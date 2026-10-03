import { existsSync, readFileSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type ServerMessage } from '../../src/net/protocol';
import { BLOCK, getBlockDef } from '../../src/world/BlockRegistry';

/** A block id the registry does not know (the registry grows, so look one up instead of hard-coding it). */
const UNKNOWN_ID = (() => { for (let id = 254; id > 0; id--) if (!getBlockDef(id) && id !== BLOCK.UNLOADED) return id; return 256; })();
import { Client, type TestServer, api, createRoom, sleep, startServer } from './harness';

/** Real server process, real HTTP and WebSocket clients: a Minecraft-type room end to end. */
let srv: TestServer;
const clients: Client[] = [];
beforeAll(async () => { srv = await startServer(); });
afterAll(async () => { await srv.dispose(); });
afterEach(() => { clients.splice(0).forEach((c) => c.close()); });

async function joinRoom(code: string, name: string): Promise<Client> {
  const c = await Client.open(`${srv.ws}/ws/${code}`, name);
  clients.push(c);
  c.send({ t: 'hello', v: PROTOCOL_VERSION, name });
  await c.waitFor((m) => m.t === 'welcome' || m.t === 'kick');
  return c;
}

/** Announces a position (the server ignores block edits from players that never reported one). */
function standAtSpawn(c: Client): { x: number; y: number; z: number } {
  const s = c.welcome.spawn;
  c.send({ t: 'pos', x: s.x, y: s.y, z: s.z, yaw: 0, pitch: 0, flags: 4, held: 0 });
  return s;
}

describe('HTTP API', () => {
  it('serves /health and /api/server', async () => {
    const h = await api<{ ok: boolean; rooms: number }>(srv, 'GET', '/health');
    expect(h.status).toBe(200);
    expect(h.body.ok).toBe(true);
    const s = await api<{ rooms: boolean; main: boolean }>(srv, 'GET', '/api/server');
    expect(s.body).toMatchObject({ rooms: true, main: false });
  });

  it('creates a room, returns a valid code and info, and 404s on unknown codes', async () => {
    const code = await createRoom(srv, { name: 'My game', gameMode: 'creative' });
    expect(code).toMatch(/^[A-HJKMNP-Z2-9]{6}$/);
    const info = await api<Record<string, unknown>>(srv, 'GET', `/api/rooms/${code}`);
    expect(info.status).toBe(200);
    expect(info.body).toMatchObject({ code, name: 'My game', gameMode: 'creative', gameType: 'minecraft', players: 0, maxPlayers: 8 });
    expect((await api(srv, 'GET', '/api/rooms/ZZZZZZ')).status).toBe(404);
    expect((await api(srv, 'GET', '/api/rooms/not-a-code')).status).toBe(404);
    expect((await api(srv, 'GET', '/api/nope')).status).toBe(404);
  });

  it('rejects a malformed create body with 400 and sanitises names', async () => {
    const bad = await fetch(`${srv.http}/api/rooms`, { method: 'POST', body: '{not json' });
    expect(bad.status).toBe(400);
    const r = await api<{ code: string }>(srv, 'POST', '/api/rooms', { name: `  \u0000evil\u0007${'x'.repeat(100)}`, gameMode: 'bogus', seed: 12 });
    expect(r.status).toBe(201);
    const info = await api<{ name: string; gameMode: string }>(srv, 'GET', `/api/rooms/${r.body.code}`);
    expect(info.body.name.length).toBeLessThanOrEqual(32);
    expect(info.body.name).not.toMatch(/[\u0000-\u001f]/);
    expect(info.body.gameMode).toBe('survival');
  });

  it('serves static files without leaking outside the static dir', async () => {
    const res = await fetch(`${srv.http}/..%2f..%2fpackage.json`);
    // Either a safe fallback or a refusal, never the real package.json.
    expect(await res.text()).not.toContain('"bunkcraft"');
  });

  it('refuses a WebSocket upgrade for unknown rooms and the disabled main world', async () => {
    await expect(Client.open(`${srv.ws}/ws/ZZZZZZ`)).rejects.toThrow();
    await expect(Client.open(`${srv.ws}/ws`)).rejects.toThrow();
  });

  it('rate limits room lookups per address (code guessing)', async () => {
    const lim = await startServer({ ROOM_CREATE_LIMIT: '2' });
    try {
      const codes = [];
      for (let i = 0; i < 2; i++) codes.push((await api<{ code: string }>(lim, 'POST', '/api/rooms', { name: 'x' }, '198.51.100.1')).body.code);
      const third = await api(lim, 'POST', '/api/rooms', { name: 'x' }, '198.51.100.1');
      expect(third.status).toBe(429);
      let limited = 0;
      for (let i = 0; i < 45; i++) if ((await api(lim, 'GET', `/api/rooms/${codes[0]}`, undefined, '203.0.113.9')).status === 429) limited++;
      expect(limited).toBeGreaterThanOrEqual(5);
      // Another visitor is not affected.
      expect((await api(lim, 'GET', `/api/rooms/${codes[0]}`, undefined, '203.0.113.10')).status).toBe(200);
    } finally { await lim.dispose(); }
  });

  it('enforces the room limit with 503', async () => {
    const lim = await startServer({ MAX_ROOMS: '1' });
    try {
      await createRoom(lim);
      expect((await api(lim, 'POST', '/api/rooms', { name: 'x' })).status).toBe(503);
    } finally { await lim.dispose(); }
  });
});

describe('two players in a Minecraft room', () => {
  it('joins, announces players and leaves', async () => {
    const code = await createRoom(srv);
    const a = await joinRoom(code, 'alice');
    expect(a.welcome).toMatchObject({ gameType: 'minecraft', worldType: 'terrain', players: [] });
    const b = await joinRoom(code, 'bob');
    expect(b.welcome.players.map((p) => p.name)).toEqual(['alice']);
    expect(b.welcome.seed).toBe(a.welcome.seed);
    const joinMsg = await a.waitFor((m) => m.t === 'join');
    expect(joinMsg).toMatchObject({ name: 'bob' });
    b.close();
    await a.waitFor((m) => m.t === 'leave');
    const info = await api<{ players: number }>(srv, 'GET', `/api/rooms/${code}`);
    expect(info.body.players).toBe(1);
  });

  it('syncs block edits to the other player and rejects bad ones', async () => {
    const code = await createRoom(srv);
    const a = await joinRoom(code, 'alice');
    const b = await joinRoom(code, 'bob');
    const s = standAtSpawn(a);
    const x = Math.floor(s.x) + 2, y = Math.floor(s.y), z = Math.floor(s.z);

    a.send({ t: 'block', seq: 1, x, y, z, id: BLOCK.STONE });
    const got = await b.waitFor<{ t: 'block'; x: number; y: number; z: number; id: number }>((m) => m.t === 'block');
    expect(got).toMatchObject({ x, y, z, id: BLOCK.STONE });

    const rejects: Array<[string, Record<string, unknown>]> = [
      ['too far', { x: x + 100, y, z, id: BLOCK.STONE }],
      ['bedrock', { x, y, z, id: BLOCK.BEDROCK }],
      ['unknown id', { x, y, z, id: UNKNOWN_ID }],
      ['unloaded marker', { x, y, z, id: BLOCK.UNLOADED }],
      ['negative id', { x, y, z, id: -1 }],
      ['y out of range', { x, y: 200, z, id: BLOCK.STONE }],
      ['non-integer', { x: 1.5, y, z, id: BLOCK.STONE }],
      ['bad meta', { x, y, z, id: BLOCK.STONE, meta: 99 }],
    ];
    let seq = 10;
    for (const [label, body] of rejects) {
      const mark = a.mark();
      a.send({ t: 'block', seq: ++seq, ...body });
      const r = await a.waitType('reject', 3000, mark);
      expect(r.seq, label).toBe(seq);
    }
    // Nobody else saw a rejected edit.
    expect(b.of('block')).toHaveLength(1);
  });

  it('rate limits block edits (20/s, burst 40) and rolls the excess back', async () => {
    const code = await createRoom(srv);
    const a = await joinRoom(code, 'alice');
    const s = standAtSpawn(a);
    const x = Math.floor(s.x) + 1, y = Math.floor(s.y), z = Math.floor(s.z);
    for (let i = 0; i < 120; i++) a.send({ t: 'block', seq: i, x, y, z, id: i % 2 ? BLOCK.STONE : 0 });
    await sleep(500);
    expect(a.of('reject').length).toBeGreaterThan(40);
  });

  it('relays chat, sanitises it and rate limits floods', async () => {
    const code = await createRoom(srv);
    const a = await joinRoom(code, 'alice');
    const b = await joinRoom(code, 'bob');
    a.send({ t: 'chat', text: '  hello\u0000 world  ' });
    const m = await b.waitFor<{ t: 'chat'; from: string; text: string }>((x) => x.t === 'chat' && x.from === 'alice');
    expect(m.text).toBe('hello world');
    const before = b.of('chat').filter((c) => c.from === 'alice').length;
    for (let i = 0; i < 30; i++) a.send({ t: 'chat', text: `spam ${i}` });
    await sleep(600);
    const delivered = b.of('chat').filter((c) => c.from === 'alice').length - before;
    expect(delivered).toBeLessThanOrEqual(7); // burst of 5 plus what refills in the meantime
    expect(delivered).toBeGreaterThanOrEqual(1);
  });

  it('answers slash commands privately', async () => {
    const code = await createRoom(srv);
    const a = await joinRoom(code, 'alice');
    const b = await joinRoom(code, 'bob');
    const mark = b.mark();
    a.send({ t: 'chat', text: '/list' });
    const r = await a.waitFor<Extract<ServerMessage, { t: 'chat' }>>((m) => m.t === 'chat' && m.text.includes('online'));
    expect(r.text).toContain('alice');
    await sleep(150);
    expect(b.msgs.slice(mark).some((m) => m.t === 'chat' && m.text.includes('online'))).toBe(false);
  });

  it('replaces a session that logs in again with the same name (case-insensitive)', async () => {
    const code = await createRoom(srv);
    const first = await joinRoom(code, 'alice');
    const second = await joinRoom(code, 'ALICE');
    const kick = await first.waitFor<{ t: 'kick'; reason: string }>((m) => m.t === 'kick');
    expect(kick.reason).toMatch(/another location/);
    expect(second.of('welcome')).toHaveLength(1);
    const info = await api<{ players: number }>(srv, 'GET', `/api/rooms/${code}`);
    expect(info.body.players).toBe(1);
  });

  it('kicks outdated clients and invalid names', async () => {
    const code = await createRoom(srv);
    const old = await Client.open(`${srv.ws}/ws/${code}`, 'old');
    clients.push(old);
    old.send({ t: 'hello', v: PROTOCOL_VERSION - 1, name: 'oldie' });
    const k = await old.waitFor<{ t: 'kick'; reason: string }>((m) => m.t === 'kick');
    expect(k.reason).toMatch(/Outdated/);
    expect((await old.waitClosed()).code).toBe(1008);

    for (const name of ['ab', 'has space', 'x'.repeat(17), '<script>', '']) {
      const c = await Client.open(`${srv.ws}/ws/${code}`, name);
      clients.push(c);
      c.send({ t: 'hello', v: PROTOCOL_VERSION, name });
      const kick = await c.waitFor<{ t: 'kick'; reason: string }>((m) => m.t === 'kick');
      expect(kick.reason, name).toMatch(/Invalid name/);
    }
  });

  it('enforces the player cap', async () => {
    const lim = await startServer({ ROOM_MAX_PLAYERS: '2' });
    const local: Client[] = [];
    try {
      const code = await createRoom(lim);
      for (const n of ['pl_one', 'pl_two']) local.push(await Client.join(`${lim.ws}/ws/${code}`, n));
      const third = await Client.join(`${lim.ws}/ws/${code}`, 'pl_three');
      local.push(third);
      expect(third.of('kick')[0]?.reason).toMatch(/full/);
    } finally { local.forEach((c) => c.close()); await lim.dispose(); }
  });

  it('closes the socket on malformed JSON and ignores binary frames', async () => {
    const code = await createRoom(srv);
    const bad = await Client.open(`${srv.ws}/ws/${code}`);
    clients.push(bad);
    bad.sendRaw('{this is not json');
    expect((await bad.waitClosed()).code).toBe(1003);

    const bin = await joinRoom(code, 'binary');
    bin.sendRaw(Buffer.from([1, 2, 3, 4]));
    await sleep(150);
    expect(bin.closed).toBeNull();
    bin.send({ t: 'chat', text: 'still alive' });
    await bin.waitFor((m) => m.t === 'chat' && m.text === 'still alive');
  });

  it('closes the socket when a message exceeds the 64 KiB limit', async () => {
    const code = await createRoom(srv);
    const c = await joinRoom(code, 'big');
    c.send({ t: 'chat', text: 'x'.repeat(70 * 1024) });
    expect((await c.waitClosed()).code).toBe(1009);
    // The room survives and accepts new players.
    const d = await joinRoom(code, 'after');
    expect(d.welcome.id).toBeGreaterThan(0);
  });

  it('ignores messages before hello and unknown message types afterwards', async () => {
    const code = await createRoom(srv);
    const c = await Client.open(`${srv.ws}/ws/${code}`);
    clients.push(c);
    c.send({ t: 'chat', text: 'too early' });
    c.send({ t: 'pos', x: 0, y: 0, z: 0, yaw: 0, pitch: 0, flags: 0, held: 0 });
    await sleep(100);
    expect(c.msgs).toHaveLength(0);
    c.send({ t: 'hello', v: PROTOCOL_VERSION, name: 'late_hello' });
    await c.waitType('welcome');
    c.send({ t: 'nonsense', foo: 1 });
    c.send({ t: 'chat', text: 'ok' });
    await c.waitFor((m) => m.t === 'chat' && m.text === 'ok');
  });

  it('keeps edits, position and inventory when a player reconnects', async () => {
    const code = await createRoom(srv);
    const a = await joinRoom(code, 'alice');
    const s = standAtSpawn(a);
    const x = Math.floor(s.x) + 2, y = Math.floor(s.y), z = Math.floor(s.z);
    a.send({ t: 'block', seq: 1, x, y, z, id: BLOCK.COBBLESTONE });
    a.send({ t: 'pos', x: s.x + 3, y: s.y, z: s.z + 3, yaw: 1, pitch: 0.5, flags: 4, held: 0 });
    a.send({ t: 'state', inventory: [[1, 5, 0]], stats: [20, 20, 5, 300] });
    await sleep(300);
    a.close();
    await a.waitClosed();
    await sleep(200);

    const again = await joinRoom(code, 'alice');
    const edits = again.welcome.edits;
    const found = [];
    for (let i = 0; i < edits.length; i += 5) if (edits[i] === x && edits[i + 1] === y && edits[i + 2] === z) found.push(edits[i + 3]);
    expect(found).toEqual([BLOCK.COBBLESTONE]);
    expect(again.welcome.player).toMatchObject({ x: s.x + 3, z: s.z + 3, inventory: [[1, 5, 0]] });
  });

  it('survives a server restart: edits, players and the room itself come back from disk', async () => {
    const own = await startServer();
    try {
      const code = await createRoom(own, { name: 'Persist', seed: 'persist' });
      const a = await Client.join(`${own.ws}/ws/${code}`, 'alice');
      const s = a.welcome.spawn;
      a.send({ t: 'pos', x: s.x, y: s.y, z: s.z, yaw: 0, pitch: 0, flags: 4, held: 0 });
      a.send({ t: 'block', seq: 1, x: Math.floor(s.x) + 1, y: Math.floor(s.y), z: Math.floor(s.z), id: BLOCK.GLOWSTONE });
      await sleep(300);
      a.close();
      await a.waitClosed();
      await own.restart(); // SIGTERM saves, then boots again on the same data dir

      const info = await api<{ name: string; players: number }>(own, 'GET', `/api/rooms/${code}`);
      expect(info.status).toBe(200);
      expect(info.body.name).toBe('Persist');
      const b = await Client.join(`${own.ws}/ws/${code}`, 'alice');
      expect(b.welcome.seed).toBe(a.welcome.seed);
      expect(b.welcome.edits).toContain(BLOCK.GLOWSTONE);
      expect(existsSync(join(own.dataDir, 'rooms', code, 'world.json'))).toBe(true);
      b.close();
    } finally { await own.dispose(); }
  });

  it('expires rooms nobody has joined for ROOM_EXPIRE_DAYS on startup', async () => {
    const own = await startServer({ ROOM_EXPIRE_DAYS: '30' });
    try {
      const old = await createRoom(own);
      const fresh = await createRoom(own);
      await own.stop(); // flush both rooms to disk
      const file = join(own.dataDir, 'rooms', old, 'world.json');
      expect(statSync(file).isFile()).toBe(true);
      const longAgo = new Date(Date.now() - 40 * 86_400_000);
      utimesSync(file, longAgo, longAgo);
      await own.restart();
      expect((await api(own, 'GET', `/api/rooms/${old}`)).status).toBe(404);
      expect((await api(own, 'GET', `/api/rooms/${fresh}`)).status).toBe(200);
      expect(readFileSync(join(own.dataDir, 'rooms', fresh, 'world.json'), 'utf8')).toContain('"seed"');
    } finally { await own.dispose(); }
  });

  it('broadcasts snapshots with positions of the other player', async () => {
    const code = await createRoom(srv);
    const a = await joinRoom(code, 'alice');
    const b = await joinRoom(code, 'bob');
    const s = standAtSpawn(a);
    const snap = await b.waitFor<Extract<ServerMessage, { t: 'snap' }>>((m) => m.t === 'snap' && m.players.some((p) => p[0] === a.id));
    const mine = snap.players.find((p) => p[0] === a.id)!;
    expect(mine[1]).toBeCloseTo(s.x, 1);
  });

  it('teleports a player that moves impossibly fast back after repeated violations', async () => {
    const code = await createRoom(srv);
    const a = await joinRoom(code, 'alice');
    const s = standAtSpawn(a);
    await sleep(100);
    for (let i = 0; i < 8; i++) a.send({ t: 'pos', x: s.x + 500 + i, y: s.y, z: s.z, yaw: 0, pitch: 0, flags: 0, held: 0 });
    const tp = await a.waitType('teleport');
    expect(tp.x).toBeCloseTo(s.x, 0);
  });
});
