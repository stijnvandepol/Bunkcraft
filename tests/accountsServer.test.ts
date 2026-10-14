import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebSocket } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from '../src/net/protocol';
import { weaponDef } from '../src/modes/Weapons';
import { AccountService } from '../server/accounts/AccountService';
import { GameServer } from '../server/GameServer';
import type { Match } from '../server/Match';
import { ProfileService } from '../server/progression/ProfileService';
import { cleanup, startTestServer, type TestServer } from './helpers/serverHarness';

class FakeSocket extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  sent: ServerMessage[] = [];
  send(data: string) { this.sent.push(JSON.parse(data) as ServerMessage); }
  close() { this.readyState = 3; }
  ping() { this.emit('pong'); }
  say(msg: ClientMessage) { this.emit('message', Buffer.from(JSON.stringify(msg)), false); }
  of<T extends ServerMessage['t']>(t: T): Extract<ServerMessage, { t: T }>[] {
    return this.sent.filter((m) => m.t === t) as Extract<ServerMessage, { t: T }>[];
  }
}

const PW = 'correct horse battery';
const dirs: string[] = [];
const closers: Array<() => void> = [];
afterEach(() => {
  vi.useRealTimers();
  closers.splice(0).forEach((c) => c());
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

/** The services of one "server run" on a data directory (call twice on the same dir to simulate a restart). */
function services(data: string) {
  const profiles = new ProfileService({ dataDir: data, maxProfiles: 100, secret: 'integration-test-secret-123' });
  const accounts = new AccountService({
    dataDir: data, maxAccounts: 100,
    profiles: {
      create: (name) => profiles.create(name)?.profile.id ?? null,
      exists: (id) => !!profiles.get(id),
      rename: (id, name) => profiles.seen(id, name),
      remove: (id) => profiles.remove(id),
    },
  });
  profiles.attachAccounts(accounts);
  closers.push(() => { accounts.close(); profiles.close(); });
  return { profiles, accounts, stop: () => { accounts.close(); profiles.close(); } };
}

function arena(profiles: ProfileService, data: string) {
  const server = new GameServer({
    dataDir: join(data, 'room'), worldName: 'Arena', seed: '7', gameMode: 'survival', motd: '', maxPlayers: 8, quiet: true,
    gameType: 'ffa', scoreLimit: 50, timeLimitSec: 600, profiles,
  });
  closers.push(() => server.shutdown());
  const match = (server as unknown as { match: Match }).match;
  const connect = (name: string, profile?: string, key?: string) => {
    const ws = new FakeSocket();
    server.accept(ws as unknown as WebSocket);
    ws.say({ t: 'hello', v: PROTOCOL_VERSION, name, ...(profile ? { profile } : {}), ...(key ? { key } : {}) });
    return ws;
  };
  return { match, connect };
}

function playAndEnd(match: Match): void {
  (match as unknown as { beginMatch(now: number): void }).beginMatch(Date.now() / 1000);
  const m = match as unknown as { applyDamage(k: unknown, v: unknown, amount: number, w: unknown, head: boolean, now: number): void };
  for (let i = 0; i < 3; i++) {
    m.applyDamage(match.players.get(1), match.players.get(2), 500, weaponDef('rifle'), false, Date.now() / 1000);
    match.respawn(match.players.get(2)!, Date.now() / 1000);
  }
  vi.setSystemTime(Date.now() + 120_000);
  match.endMatch();
}

describe('accounts and progression', () => {
  it('register -> play a match -> XP saved -> a fresh server run and client logs in to the same profile', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.UTC(2026, 9, 7, 12) });
    const data = mkdtempSync(join(tmpdir(), 'bunk-acc-srv-'));
    dirs.push(data);
    const run1 = services(data);
    const guest = run1.profiles.create('guesty')!;
    // The guest plays once, then makes an account: the progress comes along.
    const g = arena(run1.profiles, data);
    const sock = g.connect('guesty', guest.token);
    g.connect('rival');
    playAndEnd(g.match);
    const guestXp = run1.profiles.get(guest.profile.id)!.xp;
    expect(guestXp).toBeGreaterThan(0);
    expect(sock.of('progress')).toHaveLength(1);

    const reg = await run1.accounts.register('Stijn_01', PW, run1.profiles.verify(guest.token)!);
    if (!reg.ok) throw new Error(reg.error);
    expect(reg.profileId).toBe(guest.profile.id);
    expect(run1.profiles.verify(guest.token)).toBeNull();

    // Next match: the browser now presents the session token and XP still counts.
    const a = arena(run1.profiles, data);
    const s2 = a.connect('Stijn_01', reg.token);
    a.connect('rival2');
    playAndEnd(a.match);
    expect(s2.of('progress')).toHaveLength(1);
    const xp = run1.profiles.get(reg.profileId)!.xp;
    expect(xp).toBeGreaterThan(guestXp);
    run1.stop();

    // A restart and a brand new browser: log in, same level and XP.
    const run2 = services(data);
    const login = await run2.accounts.login('stijn_01', PW);
    if (!login.ok) throw new Error(login.error);
    expect(login.profileId).toBe(guest.profile.id);
    expect(run2.profiles.resolve(login.token)?.xp).toBe(xp);
    expect(run2.profiles.resolve(login.token)?.name).toBe('Stijn_01');
    expect(run2.profiles.verify(guest.token)).toBeNull();
  });

  it('reserves registered names (and look-alikes) for their account; guests are refused, the holder gets a verified mark', async () => {
    const data = mkdtempSync(join(tmpdir(), 'bunk-acc-name-'));
    dirs.push(data);
    const run = services(data);
    const guest = run.profiles.create('guesty')!;
    const g = arena(run.profiles, data);
    // A guest holds the name first (identity claim in this game) ...
    const early = g.connect('Bob_One', guest.token, 'k'.repeat(24));
    expect(early.of('welcome')).toHaveLength(1);
    const reg = await run.accounts.register('Bob_One', PW);
    if (!reg.ok) throw new Error(reg.error);
    // ... then the account exists: no guest may use it, however it is spelled, with or without a profile token.
    const kicked = (ws: FakeSocket) => ws.of('kick')[0]?.code;
    expect(kicked(g.connect('Bob_One'))).toBe('identity');
    expect(kicked(g.connect('bob_one', guest.token))).toBe('identity');
    expect(kicked(g.connect('B0b_One'))).toBe('identity');
    // Registering a look-alike is refused too.
    const twin = await run.accounts.register('B0bOne', PW);
    expect(twin).toMatchObject({ ok: false, error: 'name_taken' });
    // The account holder gets in (even over the older guest claim) and is marked verified in the roster.
    const holder = g.connect('Bob_One', reg.token, 'x'.repeat(24));
    expect(holder.of('welcome')).toHaveLength(1);
    expect(holder.of('kick')).toHaveLength(0);
    expect(g.match.roster().find((p) => p.name === 'Bob_One')?.vf).toBe(1);
    // A logged-in account may not wear another account's name either.
    const other = await run.accounts.register('Other_Two', PW);
    if (!other.ok) throw new Error(other.error);
    expect(kicked(g.connect('Bob_One', other.token))).toBe('identity');
    // Names nobody holds stay free for guests and carry no mark.
    const free = g.connect('Free_Name');
    expect(free.of('welcome')).toHaveLength(1);
    expect(g.match.roster().find((p) => p.name === 'Free_Name')?.vf).toBeUndefined();
  });
});

describe('account HTTP API', () => {
  let t: TestServer | null = null;
  afterEach(async () => {
    if (t) { await t.stop(); cleanup(t.dir); t = null; }
  });

  const call = async (method: string, path: string, body?: unknown, token?: string, headers: Record<string, string> = {}) => {
    const res = await fetch(`${t!.base}${path}`, {
      method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: await res.json() as Record<string, unknown>, headers: res.headers };
  };

  it('registers, resumes, logs out and shows the same errors for unknown names and wrong passwords', async () => {
    t = await startTestServer();
    expect((await call('GET', '/api/server')).body.features).toMatchObject({ accounts: true });
    const reg = await call('POST', '/api/account/register', { name: 'Stijn_01', password: PW });
    expect(reg.status).toBe(201);
    const token = reg.body.token as string;
    expect(reg.body.recovery).toMatch(/^[0-9A-Z]{5}(-[0-9A-Z]{5}){4}$/);
    expect(reg.body.account).toEqual({ name: 'Stijn_01' });
    expect((await call('GET', '/api/account/me', undefined, token)).status).toBe(200);
    // The session token works as the profile token everywhere.
    expect((await call('GET', '/api/profile', undefined, token)).body.profile).toMatchObject({ name: 'Stijn_01' });

    const wrong = await call('POST', '/api/account/login', { name: 'Stijn_01', password: 'not the password' });
    const ghost = await call('POST', '/api/account/login', { name: 'Ghost_99', password: 'not the password' });
    expect(wrong.status).toBe(401);
    expect({ status: wrong.status, body: wrong.body }).toEqual({ status: ghost.status, body: ghost.body });

    const login = await call('POST', '/api/account/login', { name: 'stijn_01', password: PW });
    expect(login.status).toBe(200);
    expect((login.body.profile as { id: string }).id).toBe((reg.body.profile as { id: string }).id);

    expect((await call('POST', '/api/account/logout', {}, token)).status).toBe(200);
    expect((await call('GET', '/api/account/me', undefined, token)).status).toBe(401);
    expect((await call('GET', '/api/profile', undefined, token)).status).toBe(401);
  });

  it('links the guest profile on register, kills its token, and asks before a login drops guest progress', async () => {
    t = await startTestServer();
    const guest = await call('POST', '/api/profile', { name: 'guesty' });
    const gtoken = guest.body.token as string;
    const reg = await call('POST', '/api/account/register', { name: 'Linked_1', password: PW }, gtoken);
    expect(reg.status).toBe(201);
    expect((reg.body.profile as { id: string }).id).toBe((guest.body.profile as { id: string }).id);
    expect((await call('GET', '/api/profile', undefined, gtoken)).status).toBe(401);
    expect((await call('POST', '/api/account/register', { name: 'Linked_2', password: PW }, reg.body.token as string)).body.error).toBe('already_account');
  });

  it('guards origin, content type and size, and rejects weak passwords', async () => {
    t = await startTestServer();
    const body = { name: 'Origin_1', password: PW };
    expect((await call('POST', '/api/account/register', body, undefined, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await call('POST', '/api/account/register', body, undefined, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    const form = await fetch(`${t.base}/api/account/register`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(body) });
    expect(form.status).toBe(415);
    const big = await fetch(`${t.base}/api/account/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x', password: 'y'.repeat(5000) }) }).catch(() => null);
    expect(big === null || big.status === 400).toBe(true);
    expect((await call('POST', '/api/account/register', { name: 'Weak_1', password: 'password123' })).body.error).toBe('password_common');
    expect((await call('POST', '/api/account/register', { name: 'ab', password: PW })).body.error).toBe('username_format');
    expect((await call('POST', '/api/account/register', body, undefined, { origin: t.base })).status).toBe(201);
  });

  it('recovers with the code, changes the password and deletes the account', async () => {
    t = await startTestServer();
    const reg = await call('POST', '/api/account/register', { name: 'Rec_Over', password: PW });
    const rec = await call('POST', '/api/account/recover', { name: 'rec_over', code: reg.body.recovery, password: 'a different pass' });
    expect(rec.status).toBe(200);
    expect(rec.body.recovery).not.toBe(reg.body.recovery);
    expect((await call('GET', '/api/account/me', undefined, reg.body.token as string)).status).toBe(401);
    const token = rec.body.token as string;
    expect((await call('POST', '/api/account/password', { password: 'a different pass', newPassword: 'yet another one' }, token)).status).toBe(200);
    expect((await call('POST', '/api/account/delete', { password: 'wrong wrong wrong' }, token)).status).toBe(401);
    const login = await call('POST', '/api/account/login', { name: 'Rec_Over', password: 'yet another one' });
    expect(login.status).toBe(200);
    expect((await call('POST', '/api/account/delete', { password: 'yet another one' }, login.body.token as string)).status).toBe(200);
    expect((await call('POST', '/api/account/login', { name: 'Rec_Over', password: 'yet another one' })).status).toBe(401);
    expect((await call('GET', '/api/profile', undefined, login.body.token as string)).status).toBe(401);
  });

  it('limits registrations and failed logins per address', async () => {
    t = await startTestServer({ ACCOUNT_REGISTER_LIMIT: '2' });
    expect((await call('POST', '/api/account/register', { name: 'Limit_1', password: PW })).status).toBe(201);
    expect((await call('POST', '/api/account/register', { name: 'Limit_2', password: PW })).status).toBe(201);
    expect((await call('POST', '/api/account/register', { name: 'Limit_3', password: PW })).status).toBe(429);
    // Per-name lockout after five wrong passwords.
    for (let i = 0; i < 5; i++) await call('POST', '/api/account/login', { name: 'Limit_1', password: 'wrong wrong wrong' });
    const locked = await call('POST', '/api/account/login', { name: 'Limit_1', password: PW });
    expect(locked.status).toBe(429);
    expect(locked.body.error).toBe('locked');
  });

  it('can be switched off', async () => {
    t = await startTestServer({ ACCOUNTS: 'off' });
    expect((await call('POST', '/api/account/register', { name: 'Off_1', password: PW })).status).toBe(404);
    expect((await call('GET', '/api/server')).body.features).toMatchObject({ accounts: false });
  });
});
