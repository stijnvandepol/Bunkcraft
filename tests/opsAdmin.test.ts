/**
 * The ops dashboard's API (/api/ops/*, server/Ops.ts + Admin.ts): who gets in (ADMIN_TOKEN, an admin account's
 * session; not a normal, locked or logged-out one), the same-site rule for changes, the audit log, and the run-time
 * settings (ranges, persistence, applied without a restart).
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type OpsValues, OpsSettings } from '../server/Ops';
import { cleanup, startTestServer, type TestServer } from './helpers/serverHarness';

const PW = 'correct horse battery';
const TOKEN = 'ops-admin-token-0123456789';
const stoppers: TestServer[] = [];
afterEach(async () => {
  const all = stoppers.splice(0);
  for (const t of all) await t.stop();
  for (const t of all) cleanup(t.dir);
});

async function start(env: Record<string, string> = {}, dir?: string): Promise<TestServer> {
  const t = await startTestServer({ ADMIN_ACCOUNTS: 'Stijn', ACCOUNT_REGISTER_LIMIT: '100', ADMIN_TOKEN: TOKEN, ...env }, dir);
  stoppers.push(t);
  return t;
}

type Reply = { status: number; body: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
async function call(t: TestServer, method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  const res = await fetch(`${t.base}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

async function register(t: TestServer, name: string): Promise<string> {
  const r = await call(t, 'POST', '/api/account/register', undefined, { name, password: PW });
  expect(r.status).toBe(201);
  return r.body.token as string;
}

describe('ops API: who gets in', () => {
  it('lets an ADMIN_ACCOUNTS account in with its session (name case-insensitive), refuses a normal account', async () => {
    const t = await start();
    const admin = await register(t, 'stijn');
    const player = await register(t, 'Player1');
    const who = await call(t, 'GET', '/api/ops/whoami', admin);
    expect(who.status).toBe(200);
    expect(who.body).toMatchObject({ who: 'stijn', via: 'account' });
    expect((await call(t, 'GET', '/api/ops/overview', admin)).body).toMatchObject({ isolation: 'inprocess', containers: null });
    expect((await call(t, 'GET', '/api/ops/overview', player)).status).toBe(403);
    expect((await call(t, 'POST', '/api/ops/save', player, {})).status).toBe(403);
    // The old CLI path takes the session too (it needs ADMIN_TOKEN to exist at all).
    expect((await call(t, 'GET', '/api/admin/stats', admin)).status).toBe(200);
    // Only an admin learns that it is one.
    expect((await call(t, 'GET', '/api/account/me', admin)).body.account).toEqual({ name: 'stijn', admin: true });
    expect((await call(t, 'GET', '/api/account/me', player)).body.account).toEqual({ name: 'Player1' });
  });

  it('keeps the admin token working on both paths, and refuses guesses and guest tokens', async () => {
    const t = await start();
    expect((await call(t, 'GET', '/api/ops/whoami', TOKEN)).body).toMatchObject({ who: 'admin token', via: 'token' });
    expect((await call(t, 'GET', '/api/admin/containers', TOKEN)).status).toBe(200);
    expect((await call(t, 'GET', '/api/ops/overview')).status).toBe(401);
    expect((await call(t, 'GET', '/api/ops/overview', 'wrong')).status).toBe(401);
    const guest = await call(t, 'POST', '/api/profile', undefined, { name: 'guesty' });
    expect((await call(t, 'GET', '/api/ops/overview', guest.body.token as string)).status).toBe(401);
    expect((await call(t, 'GET', '/api/ops/overview', 's1.AAAAAAAAAAAAAAAAAAAAAA.' + 'B'.repeat(32))).status).toBe(401);
  });

  it('refuses a logged-out session (401) and a locked account (403 while a session survives, 401 once ended)', async () => {
    const t = await start({ ADMIN_ACCOUNTS: 'Stijn,Second' });
    const a = await register(t, 'Stijn');
    expect((await call(t, 'POST', '/api/account/logout', a, {})).status).toBe(200);
    expect((await call(t, 'GET', '/api/ops/overview', a)).status).toBe(401);

    const b = await register(t, 'Second');
    expect((await call(t, 'GET', '/api/ops/overview', b)).status).toBe(200);
    // A lock flag next to a live session (an edited account file): still no entry.
    const store = (t.server as unknown as { profiles: { accounts: { store: { byName(k: string): { locked?: boolean } } } } }).profiles.accounts.store;
    store.byName('second').locked = true;
    expect((await call(t, 'GET', '/api/ops/overview', b)).status).toBe(403);
    store.byName('second').locked = undefined;
    // The admin lock itself ends every session.
    expect((await call(t, 'POST', '/api/ops/accounts/lock', TOKEN, { name: 'Second' })).status).toBe(200);
    expect((await call(t, 'GET', '/api/ops/overview', b)).status).toBe(401);
  });

  it('a persistent admin flag (CLI: bunkcraft account admin <name> on) works without ADMIN_ACCOUNTS and can be withdrawn', async () => {
    const t = await start({ ADMIN_ACCOUNTS: '' });
    const s = await register(t, 'Helper');
    expect((await call(t, 'GET', '/api/ops/overview', s)).status).toBe(403);
    const on = await call(t, 'POST', '/api/admin/accounts/admin', TOKEN, { name: 'helper', admin: true });
    expect(on.body).toEqual({ ok: true, name: 'Helper', admin: true });
    expect((await call(t, 'GET', '/api/ops/overview', s)).status).toBe(200);
    const list = await call(t, 'GET', '/api/ops/accounts', s);
    expect(list.body.accounts.find((a: { name: string }) => a.name === 'Helper').admin).toBe(true);
    expect((await call(t, 'POST', '/api/admin/accounts/admin', TOKEN, { name: 'Helper', admin: 'yes' })).status).toBe(400);
    expect((await call(t, 'POST', '/api/admin/accounts/admin', TOKEN, { name: 'nobody', admin: true })).status).toBe(404);
    await call(t, 'POST', '/api/admin/accounts/admin', TOKEN, { name: 'Helper', admin: false });
    expect((await call(t, 'GET', '/api/ops/overview', s)).status).toBe(403);
  });

  it('rate limits failures per address like the admin token (then 429, even for a good session)', async () => {
    const t = await start();
    const admin = await register(t, 'Stijn');
    let last = 0;
    for (let i = 0; i < 22; i++) last = (await call(t, 'GET', '/api/ops/overview', `s1.${'A'.repeat(22)}.${String(i).padStart(32, 'x')}`)).status;
    expect(last).toBe(429);
    expect((await call(t, 'GET', '/api/ops/overview', admin)).status).toBe(429);
  });

  it('refuses cross-site changes, and browser sessions must send JSON', async () => {
    const t = await start();
    const admin = await register(t, 'Stijn');
    expect((await call(t, 'POST', '/api/ops/save', admin, {}, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await call(t, 'POST', '/api/ops/save', admin, {}, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await call(t, 'POST', '/api/ops/save', TOKEN, {}, { origin: 'https://evil.example' })).status).toBe(403);
    const form = await fetch(`${t.base}/api/ops/save`, { method: 'POST', headers: { authorization: `Bearer ${admin}`, 'content-type': 'text/plain' }, body: '{}' });
    expect(form.status).toBe(415);
    expect((await call(t, 'POST', '/api/ops/save', admin, {}, { origin: t.base })).status).toBe(200);
    // Reading is fine from anywhere the token is (it never rides along by itself: no cookies).
    expect((await call(t, 'GET', '/api/ops/overview', admin, undefined, { origin: 'https://evil.example' })).status).toBe(200);
  });

  it('writes every change to the audit log with the admin who did it', async () => {
    const t = await start();
    const admin = await register(t, 'Stijn');
    await call(t, 'POST', '/api/ops/announce', admin, { text: 'Restart in 5 minutes' });
    await call(t, 'POST', '/api/ops/settings', TOKEN, { values: { motd: 'Hello' } });
    await call(t, 'GET', '/api/ops/overview', admin);
    const audit = await call(t, 'GET', '/api/ops/audit', admin);
    expect(audit.body.entries.map((e: { who: string; action: string; status: number }) => [e.who, e.action, e.status])).toEqual([
      ['admin token', 'POST settings', 200],
      ['Stijn', 'POST announce', 200],
    ]);
    expect(audit.body.entries[1].detail).toContain('text=Restart in 5 minutes');
  });

  it('never puts the admin token into the dashboard page', async () => {
    const t = await start();
    const html = await (await fetch(`${t.base}/ops`)).text();
    expect(html).not.toContain(TOKEN);
    expect(html).toContain('/api/ops');
    expect(html).not.toContain('/api/admin');
  });
});

describe('ops settings', () => {
  it('validates ranges, applies at once (no restart), persists, and resets to the env value', async () => {
    const t = await start({ ROOM_MAX_PLAYERS: '12', QUICKPLAY_BOTS: '8', MOTD: 'From env' });
    const admin = await register(t, 'Stijn');
    const bad: Record<string, unknown>[] = [
      { roomMaxPlayers: 1 }, { roomMaxPlayers: 17 }, { roomMaxPlayers: 8.5 }, { quickPlayBots: -1 }, { motd: '' }, { motd: 42 },
      { matchWarmPool: 17 }, { maxMatchContainers: 0 }, { matchCpus: 9 }, { matchMemoryMb: 64 }, { matchIdleGraceSec: 1 }, { nope: 1 },
      { matchWarmPool: 6, maxMatchContainers: 4 },
    ];
    for (const values of bad) expect((await call(t, 'POST', '/api/ops/settings', admin, { values })).status, JSON.stringify(values)).toBe(400);
    // Nothing of a refused batch sticks.
    expect((await call(t, 'POST', '/api/ops/settings', admin, { values: { roomMaxPlayers: 8, quickPlayBots: 'x' } })).status).toBe(400);
    expect((await call(t, 'GET', '/api/server')).body.roomMaxPlayers).toBe(12);

    const ok = await call(t, 'POST', '/api/ops/settings', admin, { values: { roomMaxPlayers: 8, quickPlayBots: 0, motd: 'Hi\u0007 there' } });
    expect(ok.status).toBe(200);
    const row = (k: string) => ok.body.settings.find((s: { key: string }) => s.key === k);
    expect(row('roomMaxPlayers')).toMatchObject({ value: 8, envValue: 12, env: 'ROOM_MAX_PLAYERS', overridden: true, min: 2, max: 16 });
    expect(row('motd').value).toBe('Hi there');
    expect((await call(t, 'GET', '/api/server')).body.roomMaxPlayers).toBe(8);
    const opts = (t.server.rooms as unknown as { opts: { maxPlayers: number; quickPlayBots: number; motd: string } }).opts;
    expect(opts).toMatchObject({ maxPlayers: 8, quickPlayBots: 0, motd: 'Hi there' });
    const saved = JSON.parse(readFileSync(join(t.dir, 'ops-settings.json'), 'utf8'));
    expect(saved.values).toEqual({ roomMaxPlayers: 8, quickPlayBots: 0, motd: 'Hi there' });

    // A restart on the same data keeps them.
    const dir = t.dir;
    await t.stop();
    stoppers.splice(stoppers.indexOf(t), 1);
    const t2 = await start({ ROOM_MAX_PLAYERS: '12', QUICKPLAY_BOTS: '8', MOTD: 'From env' }, dir);
    expect((await call(t2, 'GET', '/api/server')).body.roomMaxPlayers).toBe(8);
    const reset = await call(t2, 'POST', '/api/ops/settings/reset', TOKEN, { keys: ['roomMaxPlayers'] });
    expect(reset.status).toBe(200);
    expect((await call(t2, 'GET', '/api/server')).body.roomMaxPlayers).toBe(12);
    expect(JSON.parse(readFileSync(join(dir, 'ops-settings.json'), 'utf8')).values).toEqual({ quickPlayBots: 0, motd: 'Hi there' });
    expect((await call(t2, 'POST', '/api/ops/settings/reset', TOKEN, { keys: ['bogus'] })).status).toBe(400);
  });

  it('caps CPU and memory at what the Docker gate allows, and drops saved values that no longer fit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bunk-ops-'));
    try {
      const defaults: OpsValues = { maxMatchContainers: 16, matchWarmPool: 1, matchCpus: 1, matchMemoryMb: 256, matchIdleGraceSec: 30, motd: 'm', roomMaxPlayers: 12, quickPlayBots: 8 };
      const s = new OpsSettings(dir, defaults, { matchCpus: { max: 1 }, matchMemoryMb: { max: 256 } });
      expect(s.set({ matchCpus: 1.5 })).toMatchObject({ ok: false, key: 'matchCpus' });
      expect(s.set({ matchMemoryMb: 512 })).toMatchObject({ ok: false, key: 'matchMemoryMb' });
      let applied: OpsValues | null = null;
      s.onChange = (v) => { applied = v; };
      expect(s.set({ matchCpus: 0.5, matchMemoryMb: 192, maxMatchContainers: 4 })).toMatchObject({ ok: true });
      expect(applied).toMatchObject({ matchCpus: 0.5, matchMemoryMb: 192, maxMatchContainers: 4 });
      // A value equal to the env default is no override.
      s.set({ maxMatchContainers: 16 });
      expect(s.rows().find((r) => r.key === 'maxMatchContainers')!.overridden).toBe(false);
      // The env went down (MATCH_MEMORY=128 now): the saved 192 no longer fits and is ignored.
      const again = new OpsSettings(dir, { ...defaults, matchMemoryMb: 128 }, { matchMemoryMb: { max: 128 } });
      expect(again.values.matchMemoryMb).toBe(128);
      expect(again.values.matchCpus).toBe(0.5);
      expect(existsSync(join(dir, 'ops-settings.json'))).toBe(true);
    } finally {
      cleanup(dir);
    }
  });
});
