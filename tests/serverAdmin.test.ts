import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '../src/net/protocol';
import { originAllowed } from '../server/App';
import { KEY_A, TestClient, type TestServer, cleanup, createRoom, joinGame as joinRoom, startTestServer } from './helpers/serverHarness';

const stoppers: TestServer[] = [];
afterEach(async () => {
  const all = stoppers.splice(0);
  for (const t of all) await t.stop();
  for (const t of all) cleanup(t.dir);
});

async function start(env: Record<string, string> = {}): Promise<TestServer> {
  const t = await startTestServer(env);
  stoppers.push(t);
  return t;
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe('admin API', () => {
  it('is disabled without ADMIN_TOKEN', async () => {
    const t = await start();
    expect((await fetch(`${t.base}/api/admin/stats`, { headers: auth('anything') })).status).toBe(404);
    expect((await fetch(`${t.base}/admin`)).status).toBe(404);
  });

  it('rejects missing and wrong tokens, then rate limits guessing', async () => {
    const t = await start({ ADMIN_TOKEN: 'correct-horse-battery' });
    expect((await fetch(`${t.base}/api/admin/stats`)).status).toBe(401);
    expect((await fetch(`${t.base}/api/admin/stats`, { headers: auth('wrong') })).status).toBe(401);
    expect((await fetch(`${t.base}/api/admin/stats`, { headers: auth('correct-horse-battery') })).status).toBe(200);
    let last = 0;
    for (let i = 0; i < 25; i++) last = (await fetch(`${t.base}/api/admin/stats`, { headers: auth(`guess${i}`) })).status;
    expect(last).toBe(429);
    // Locked out, even with the right token, until the window passes.
    expect((await fetch(`${t.base}/api/admin/stats`, { headers: auth('correct-horse-battery') })).status).toBe(429);
  });

  it('serves a static admin page with a strict CSP', async () => {
    const t = await start({ ADMIN_TOKEN: 'tok-tok-tok-tok' });
    const res = await fetch(`${t.base}/admin`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    const html = await res.text();
    expect(html).toContain('BunkCraft admin');
    expect(html).not.toContain('tok-tok-tok-tok');
  });

  it('lists games and players, kicks, closes and deletes', async () => {
    const t = await start({ ADMIN_TOKEN: 'tok-tok-tok-tok' });
    const h = auth('tok-tok-tok-tok');
    const { code } = await createRoom(t.base, { name: 'Admin Test' });
    const p = await joinRoom(t, code, 'victim', { key: KEY_A });

    const rooms = await (await fetch(`${t.base}/api/admin/rooms`, { headers: h })).json() as { rooms: { code: string; players: number }[] };
    expect(rooms.rooms.find((r) => r.code === code)?.players).toBe(1);
    const players = await (await fetch(`${t.base}/api/admin/rooms/${code}/players`, { headers: h })).json() as { players: { name: string; ip: string }[] };
    expect(players.players[0].name).toBe('victim');

    const kick = await fetch(`${t.base}/api/admin/rooms/${code}/kick`, { method: 'POST', headers: { ...h, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'victim' }) });
    expect(kick.status).toBe(200);
    expect((await p.client.waitFor('kick')).reason).toMatch(/administrator/);

    const p2 = await joinRoom(t, code, 'victim', { key: KEY_A });
    const close = await fetch(`${t.base}/api/admin/rooms/${code}/close`, { method: 'POST', headers: h, body: '{}' });
    expect(close.status).toBe(200);
    expect((await p2.client.waitFor('kick')).reason).toMatch(/closed/);
    expect(existsSync(join(t.dir, 'rooms', code, 'world.json'))).toBe(true); // closed, not deleted

    const del = await fetch(`${t.base}/api/admin/rooms/${code}/close`, { method: 'POST', headers: { ...h, 'content-type': 'application/json' }, body: JSON.stringify({ remove: true }) });
    expect(del.status).toBe(200);
    expect(existsSync(join(t.dir, 'rooms', code))).toBe(false);
    expect((await fetch(`${t.base}/api/rooms/${code}`)).status).toBe(404);
  });

  it('blocks an address: open connections drop and new ones are refused', async () => {
    const t = await start({ ADMIN_TOKEN: 'tok-tok-tok-tok' });
    const h = { ...auth('tok-tok-tok-tok'), 'content-type': 'application/json' };
    const { code } = await createRoom(t.base);
    const p = await joinRoom(t, code, 'someone', { key: KEY_A });
    expect((await fetch(`${t.base}/api/admin/ip-bans`, { method: 'POST', headers: h, body: JSON.stringify({ ip: 'not an ip' }) })).status).toBe(400);
    const ban = await fetch(`${t.base}/api/admin/ip-bans`, { method: 'POST', headers: h, body: JSON.stringify({ ip: '127.0.0.1' }) });
    expect(ban.status).toBe(200);
    await new Promise((r) => setTimeout(r, 100));
    expect(p.client.closed).not.toBeNull();
    const again = new TestClient(`${t.wsBase}/ws/${code}`);
    await expect(again.open()).rejects.toThrow();
    // HTTP stays reachable so the admin can undo it.
    const undo = await fetch(`${t.base}/api/admin/ip-bans/127.0.0.1`, { method: 'DELETE', headers: h });
    expect(undo.status).toBe(200);
    const ok = await joinRoom(t, code, 'someone', { key: KEY_A });
    ok.client.close();
  });
});

describe('observability', () => {
  it('/health reports version and uptime', async () => {
    const t = await start();
    const h = await (await fetch(`${t.base}/health`)).json() as Record<string, unknown>;
    expect(h).toMatchObject({ ok: true, rooms: 0, players: 0 });
    expect(typeof h.version).toBe('string');
    expect(typeof h.uptime).toBe('number');
  });

  it('/metrics is Prometheus text with players, rooms, tick time, traffic and rate limit hits', async () => {
    const t = await start();
    const { code } = await createRoom(t.base);
    const p = await joinRoom(t, code, 'metric_guy');
    p.client.send({ t: 'pos', x: 0, y: 100, z: 0, yaw: 0, pitch: 0, flags: 0, held: 0 });
    await new Promise((r) => setTimeout(r, 150));
    const res = await fetch(`${t.base}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const text = await res.text();
    for (const name of [
      'bunkcraft_players 1', 'bunkcraft_rooms_loaded 1', 'bunkcraft_rooms_total 1', 'bunkcraft_tick_duration_seconds{quantile="0.5"}',
      'bunkcraft_tick_duration_seconds{quantile="0.99"}', 'process_resident_memory_bytes', 'bunkcraft_ws_messages_received_total',
      'bunkcraft_ws_bytes_sent_total', 'bunkcraft_ws_messages_per_second', 'bunkcraft_rate_limit_hits_total', '# TYPE bunkcraft_players gauge',
    ]) expect(text).toContain(name);
    p.client.close();
  });

  it('/metrics needs the token when one is configured, and refuses proxied requests without one', async () => {
    const t = await start({ METRICS_TOKEN: 'scrape-me-please' });
    expect((await fetch(`${t.base}/metrics`)).status).toBe(401);
    expect((await fetch(`${t.base}/metrics`, { headers: auth('scrape-me-please') })).status).toBe(200);
    const open = await start();
    expect((await fetch(`${open.base}/metrics`, { headers: { 'x-forwarded-for': '203.0.113.9' } })).status).toBe(401);
  });

  it('counts a rate-limit hit when a client floods chat', async () => {
    const t = await start();
    const { code } = await createRoom(t.base);
    const p = await joinRoom(t, code, 'flooder');
    for (let i = 0; i < 12; i++) p.client.send({ t: 'chat', text: `spam ${i}` });
    await new Promise((r) => setTimeout(r, 150));
    const text = await (await fetch(`${t.base}/metrics`)).text();
    expect(text).toMatch(/bunkcraft_rate_limit_hits_total\{kind="chat"\} [1-9]/);
    p.client.close();
  });
});

describe('connection limits and origins', () => {
  it('limits connections per address and globally', async () => {
    const t = await start({ MAX_CONN_PER_IP: '2', MAX_CONNECTIONS: '3' });
    const { code } = await createRoom(t.base);
    const a = await joinRoom(t, code, 'one');
    const b = await joinRoom(t, code, 'two');
    const c = new TestClient(`${t.wsBase}/ws/${code}`);
    await expect(c.open()).rejects.toThrow(/429/);
    a.client.close();
    await new Promise((r) => setTimeout(r, 100));
    const d = await joinRoom(t, code, 'three');
    d.client.close();
    b.client.close();
    const global = await start({ MAX_CONN_PER_IP: '10', MAX_CONNECTIONS: '1' });
    const room = await createRoom(global.base);
    const one = await joinRoom(global, room.code, 'solo');
    await expect(new TestClient(`${global.wsBase}/ws/${room.code}`).open()).rejects.toThrow(/503/);
    one.client.close();
  });

  it('enforces ALLOWED_ORIGINS for the WebSocket and answers CORS only for listed origins', async () => {
    const t = await start({ ALLOWED_ORIGINS: 'https://play.example.com' });
    const { code } = await createRoom(t.base);
    await expect(new TestClient(`${t.wsBase}/ws/${code}`, { origin: 'https://evil.example.org' }).open()).rejects.toThrow(/403/);
    const ok = new TestClient(`${t.wsBase}/ws/${code}`, { origin: 'https://play.example.com' });
    await ok.open();
    ok.close();
    const cors = await fetch(`${t.base}/api/server`, { headers: { origin: 'https://play.example.com' } });
    expect(cors.headers.get('access-control-allow-origin')).toBe('https://play.example.com');
    const noCors = await fetch(`${t.base}/api/server`, { headers: { origin: 'https://evil.example.org' } });
    expect(noCors.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('originAllowed: any origin by default, same-origin keyword, no Origin passes', () => {
    expect(originAllowed('https://x.example', 'localhost', [])).toBe(true);
    expect(originAllowed(undefined, 'localhost', ['https://a.example'])).toBe(true);
    expect(originAllowed('https://a.example/', 'h', ['https://a.example'])).toBe(true);
    expect(originAllowed('https://b.example', 'h', ['https://a.example'])).toBe(false);
    expect(originAllowed('null', 'h', ['https://a.example'])).toBe(false);
    expect(originAllowed('https://play.example.com', 'play.example.com', ['same-origin'])).toBe(true);
    expect(originAllowed('https://other.example.com', 'play.example.com', ['same-origin'])).toBe(false);
  });
});

describe('graceful shutdown and binary frames', () => {
  it('tells clients to reconnect, saves the world and refuses new connections', async () => {
    const t = await start();
    const { code } = await createRoom(t.base);
    const p = await joinRoom(t, code, 'stayer');
    p.client.send({ t: 'pos', x: 5, y: 90, z: 5, yaw: 0, pitch: 0, flags: 0, held: 0 });
    const closing = t.server.close(1234);
    const kick = await p.client.waitFor('kick');
    expect(kick.reconnect).toBe(1234);
    expect(kick.reason).toMatch(/restart/i);
    await closing;
    expect(existsSync(join(t.dir, 'rooms', code, 'world.json'))).toBe(true);
    await expect(fetch(`${t.base}/health`)).rejects.toThrow();
  });

  it('sends snap as binary only to clients that asked for it', async () => {
    const t = await start();
    const { code } = await createRoom(t.base);
    const bin = await joinRoom(t, code, 'binary_guy', { bin: true });
    const json = await joinRoom(t, code, 'json_guy');
    expect(bin.welcome.binary).toBe(true);
    expect(json.welcome.binary).toBeUndefined();
    for (const c of [bin, json]) c.client.send({ t: 'pos', x: 3.5, y: 90, z: -2.25, yaw: 1, pitch: 0.5, flags: 4, held: 7 });
    const snapBin = await bin.client.waitFor('snap', (m) => m.players.length === 2);
    const snapJson = await json.client.waitFor('snap', (m) => m.players.length === 2);
    expect(bin.client.frames.length).toBeGreaterThan(0);
    expect(json.client.frames.length).toBe(0);
    const a = snapBin.players.find((e) => e[0] === bin.welcome.id)!;
    const b = snapJson.players.find((e) => e[0] === bin.welcome.id)!;
    expect(a[1]).toBeCloseTo(b[1], 3);
    expect(a[3]).toBeCloseTo(b[3], 3);
    expect(a[4]).toBeCloseTo(b[4], 3);
    expect(a[6]).toBe(b[6]);
    expect(a[7]).toBe(b[7]);
    bin.client.close();
    json.client.close();
  });

  it('refuses an old protocol version politely', async () => {
    const t = await start();
    const { code } = await createRoom(t.base);
    const c = new TestClient(`${t.wsBase}/ws/${code}`);
    await c.open();
    c.send({ t: 'hello', v: PROTOCOL_VERSION - 1, name: 'oldie' });
    expect((await c.waitFor('kick')).reason).toMatch(/Outdated/);
  });
});
