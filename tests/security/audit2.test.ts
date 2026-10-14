import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { EventEmitter } from 'node:events';
import type { WebSocket as WsType } from 'ws';
import { AccountService } from '../../server/accounts/AccountService';
import { weakSecrets } from '../../server/Config';
import { OPS_CSP, OPS_HTML } from '../../server/OpsPage';
import { GameServer } from '../../server/GameServer';
import { RateLimiter, hashPassword } from '../../server/Security';
import { PROTOCOL_VERSION, sanitizeChat } from '../../src/net/protocol';
import { addressKey, blockKey } from '../../server/HttpSecurity';
import { cleanup, startTestServer, type TestServer } from '../helpers/serverHarness';

/** Regression tests of the October 2026 trust-boundary audit (docs/SECURITY.md, A2-xx). */

let t: TestServer | null = null;
afterEach(async () => {
  if (t) { await t.stop(); cleanup(t.dir); t = null; }
});

const ADMIN = 'audit-admin-token-0123456789abcdef';

async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(`${t!.base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) as Record<string, unknown> };
}

function upgradeStatus(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.on('unexpected-response', (_req, res) => { resolve(res.statusCode ?? 0); ws.terminate(); });
    ws.on('open', () => { resolve(101); ws.close(); });
    ws.on('error', () => resolve(-1));
  });
}

describe('A2-01: IPv6 clients are limited and blocked per /64', () => {
  it('addressKey folds an IPv6 address to its /64 and leaves IPv4 alone', () => {
    expect(addressKey('203.0.113.7')).toBe('203.0.113.7');
    expect(addressKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(addressKey('2001:db8:1:2::a')).toBe('2001:db8:1:2::/64');
    expect(addressKey('2001:0db8:0001:0002:ffff:ffff:ffff:ffff')).toBe('2001:db8:1:2::/64');
    expect(addressKey('2001:db8:1:2::/64')).toBe('2001:db8:1:2::/64');
    expect(blockKey('2001:db8:1:2::/64')).toBe('2001:db8:1:2::/64');
    expect(blockKey('not an ip')).toBeNull();
  });

  it('a client cannot step through its /64 past the per-address game creation limit', async () => {
    t = await startTestServer({ TRUST_CLOUDFLARE: '1', ROOM_CREATE_LIMIT: '2' });
    const make = (n: number) => post('/api/rooms', { name: 'x' }, { 'cf-connecting-ip': `2001:db8:1:2::${n.toString(16)}` });
    expect((await make(1)).status).toBe(201);
    expect((await make(2)).status).toBe(201);
    expect((await make(3)).status).toBe(429);
    // another subscriber is not affected
    expect((await post('/api/rooms', { name: 'x' }, { 'cf-connecting-ip': '2001:db8:9:9::1' })).status).toBe(201);
  });

  it('blocking an IPv6 address blocks its /64 (and the key the dashboard shows can be blocked)', async () => {
    t = await startTestServer({ TRUST_CLOUDFLARE: '1', ADMIN_TOKEN: ADMIN, MAIN_WORLD: 'on' });
    const ban = await post('/api/admin/ip-bans', { ip: '2001:db8:5:6::1' }, { authorization: `Bearer ${ADMIN}` });
    expect(ban.status).toBe(200);
    expect(await upgradeStatus(`${t.wsBase}/ws`, { 'cf-connecting-ip': '2001:db8:5:6:dead:beef:0:1' })).toBe(403);
    expect(await upgradeStatus(`${t.wsBase}/ws`, { 'cf-connecting-ip': '2001:db8:5:7::1' })).toBe(101);
    expect((await post('/api/admin/ip-bans', { ip: '2001:db8:7:8::/64' }, { authorization: `Bearer ${ADMIN}` })).status).toBe(200);
    expect(await upgradeStatus(`${t.wsBase}/ws`, { 'cf-connecting-ip': '2001:db8:7:8::99' })).toBe(403);
  });
});

describe('A2-06: /metrics without a token only for this machine, not for proxied requests', () => {
  it('a request a local tunnel or proxy forwarded is refused, whatever proxy header it carries', async () => {
    t = await startTestServer({ TRUST_CLOUDFLARE: '1' });
    const get = (headers: Record<string, string>) => fetch(`${t!.base}/metrics`, { headers }).then((r) => r.status);
    expect(await get({})).toBe(200);
    expect(await get({ 'x-forwarded-for': '203.0.113.1' })).toBe(401);
    expect(await get({ 'cf-connecting-ip': '203.0.113.1' })).toBe(401);
    expect(await get({ forwarded: 'for=203.0.113.1' })).toBe(401);
    expect(await get({ 'x-real-ip': '203.0.113.1' })).toBe(401);
  });
});

describe('A2-08: no bidi overrides or invisible characters in chat and game names', () => {
  it('sanitizeChat drops C1 controls, bidi overrides/isolates and zero-width characters', () => {
    expect(sanitizeChat('hi \u202egnp.exe\u202c there\u0085\u200b\u2066x\u2069\ufeff')).toBe('hi gnp.exe therex');
    expect(sanitizeChat('héllo wörld 日本 🙂')).toBe('héllo wörld 日本 🙂');
  });

  it('a game name cannot carry a right-to-left override into the public list', async () => {
    t = await startTestServer();
    const made = await post('/api/rooms', { name: 'Nice\u202eemag\u200b', listed: true });
    expect(made.status).toBe(201);
    const info = await fetch(`${t.base}/api/rooms/${made.body.code as string}`).then((r) => r.json()) as { name: string };
    expect(info.name).toBe('Niceemag');
  });
});

describe('A2-09 (hardening): short admin and metrics tokens are reported', () => {
  it('weakSecrets names the settings below 24 characters', () => {
    expect(weakSecrets({ adminToken: 'hunter2', metricsToken: undefined })).toEqual(['ADMIN_TOKEN']);
    expect(weakSecrets({ adminToken: ADMIN, metricsToken: 'short' })).toEqual(['METRICS_TOKEN']);
    expect(weakSecrets({ adminToken: undefined, metricsToken: undefined })).toEqual([]);
  });
});

describe('ops dashboard: player-controlled text never becomes HTML (verified, regression guard)', () => {
  it('the page script has no HTML sinks and the page cannot be framed', async () => {
    expect(OPS_HTML).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|srcdoc/);
    expect(OPS_CSP).toContain("frame-ancestors 'none'");
    expect(OPS_CSP).not.toMatch(/'unsafe-inline'|'unsafe-eval'/);
    t = await startTestServer({ ADMIN_TOKEN: ADMIN });
    const r = await fetch(`${t.base}/ops`);
    expect(r.headers.get('x-frame-options')).toBe('DENY');
    expect(r.headers.get('content-security-policy')).toBe(OPS_CSP);
  });
});

class FakeSocket extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  sent: Record<string, unknown>[] = [];
  send(data: string) { this.sent.push(JSON.parse(data) as Record<string, unknown>); }
  close() { this.readyState = 3; this.emit('close'); }
  terminate() { this.close(); }
  ping() { /* no pong */ }
  say(msg: unknown) { this.emit('message', Buffer.from(JSON.stringify(msg)), false); }
}

describe('A2-03: ADMIN_TOKEN guesses over the WebSocket hello are limited', () => {
  it('after 20 wrong owner tokens from one address even the right token makes nobody op there', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bunk-own-'));
    const server = new GameServer({
      dataDir: dir, worldName: 'W', seed: '1', gameMode: 'creative', motd: '', maxPlayers: 64, quiet: true, adminToken: ADMIN, moderated: true,
    });
    try {
      for (let i = 0; i < 25; i++) {
        const ws = new FakeSocket();
        server.accept(ws as unknown as WsType, { ip: '203.0.113.50' });
        ws.say({ t: 'hello', v: PROTOCOL_VERSION, name: `Guess_${i}`, owner: `wrong-guess-${i}-0123456789` });
        ws.close();
      }
      const attacker = new FakeSocket();
      server.accept(attacker as unknown as WsType, { ip: '203.0.113.50' });
      attacker.say({ t: 'hello', v: PROTOCOL_VERSION, name: 'Guess_ok', owner: ADMIN });
      const admin = new FakeSocket();
      server.accept(admin as unknown as WsType, { ip: '198.51.100.20' });
      admin.say({ t: 'hello', v: PROTOCOL_VERSION, name: 'Real_admin', owner: ADMIN });
      const ops = Object.fromEntries(server.playerList().map((p) => [p.name, p.op]));
      expect(ops).toEqual({ Guess_ok: false, Real_admin: true });
    } finally {
      server.shutdown();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('A2-13: parallel hellos cannot run past the wrong-password limit', () => {
  it('ten simultaneous guesses from one address get at most the limit of password checks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bunk-pw-'));
    const limiter = new RateLimiter(5, 600_000);
    const server = new GameServer({
      dataDir: dir, worldName: 'W', seed: '1', gameMode: 'creative', motd: '', maxPlayers: 64, quiet: true, label: 'PWGAME',
      passwordHash: await hashPassword('the real password'), failLimiter: limiter,
    });
    try {
      const sockets = Array.from({ length: 10 }, (_, i) => {
        const ws = new FakeSocket();
        server.accept(ws as unknown as WsType, { ip: '203.0.113.77' });
        ws.say({ t: 'hello', v: PROTOCOL_VERSION, name: `Guesser_${i}`, password: `guess number ${i}` });
        return ws;
      });
      await new Promise((r) => setTimeout(r, 1500));
      const checked = sockets.filter((s) => s.sent.some((m) => m.t === 'kick' && m.reason === 'Wrong password.')).length;
      expect(checked).toBeLessThanOrEqual(5);
    } finally {
      server.shutdown();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('A2-02: one address cannot lock somebody else out of their account', () => {
  const PW = 'correct horse battery';

  it('unit: the guessing source is locked, the owner elsewhere is not; many sources lock the name for all', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bunk-acc-'));
    let n = 0;
    const svc = new AccountService({
      dataDir: dir, maxAccounts: 10, lockBaseMs: 1000,
      profiles: { create: () => `p${n++}`, exists: () => true, rename: () => undefined, remove: () => undefined },
    });
    try {
      await svc.register('Target_01', PW);
      for (let i = 0; i < 6; i++) await svc.login('Target_01', 'nope nope nope', undefined, 'attacker');
      expect(await svc.login('Target_01', PW, undefined, 'attacker')).toMatchObject({ status: 429, error: 'locked' });
      expect(await svc.login('Target_01', PW, undefined, 'owner')).toMatchObject({ ok: true });
      for (let i = 0; i < 60; i++) await svc.login('Target_01', 'nope nope nope', undefined, `bot${i}`);
      expect(await svc.login('Target_01', PW, undefined, 'owner')).toMatchObject({ status: 429, error: 'locked' });
    } finally {
      svc.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('server: failures from one address do not stop the owner logging in from another', async () => {
    t = await startTestServer({ TRUST_CLOUDFLARE: '1' });
    const from = (ip: string) => ({ 'cf-connecting-ip': ip });
    expect((await post('/api/account/register', { name: 'Victim_1', password: PW }, from('198.51.100.1'))).status).toBe(201);
    for (let i = 0; i < 8; i++) await post('/api/account/login', { name: 'Victim_1', password: 'wrong wrong wrong' }, from('203.0.113.66'));
    expect((await post('/api/account/login', { name: 'Victim_1', password: PW }, from('203.0.113.66'))).status).toBe(429);
    expect((await post('/api/account/login', { name: 'victim_1', password: PW }, from('198.51.100.1'))).status).toBe(200);
  }, 60_000);
});
