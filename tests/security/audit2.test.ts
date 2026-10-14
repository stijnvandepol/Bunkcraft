import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
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
