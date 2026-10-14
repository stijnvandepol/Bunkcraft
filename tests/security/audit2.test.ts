import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { AccountService } from '../../server/accounts/AccountService';
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
