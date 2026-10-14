/**
 * The ops dashboard against real match runners (MATCH_ISOLATION=container with MATCH_DRIVER=process: child processes
 * stand in for the containers): the containers list, a lobby on its runner, the runner's logs, changing the warm pool
 * at run time, and stopping a runner the graceful way (its players reconnect to the same lobby code).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestServer, cleanup, createRoom, joinGame, startTestServer } from '../helpers/serverHarness';

const TOKEN = 'ops-it-token-0123456789abcdef';
let t: TestServer;
let session = '';
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

beforeAll(async () => {
  t = await startTestServer({
    MATCH_ISOLATION: 'container', MATCH_DRIVER: 'process', MATCH_WARM_POOL: '1', MAX_MATCH_CONTAINERS: '6', INTERNAL_PORT: '0',
    INTERNAL_HOST: '127.0.0.1', QUICKPLAY_BOTS: '0', REJOIN_GRACE_SEC: '60', MATCH_IDLE_GRACE_SEC: '30',
    ADMIN_TOKEN: TOKEN, ACCOUNT_REGISTER_LIMIT: '100',
  });
  const reg = await fetch(`${t.base}/api/account/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Stijn', password: 'correct horse battery' }) });
  session = ((await reg.json()) as { token: string }).token;
  // Admin through the persistent flag (an unclaimed ADMIN_ACCOUNTS name cannot be registered).
  const adm = await fetch(`${t.base}/api/admin/accounts/admin`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ name: 'Stijn', admin: true }) });
  if (adm.status !== 200) throw new Error(`could not make the test account an admin: ${adm.status}`);
}, 60_000);
afterAll(async () => { await t?.stop(); cleanup(t.dir); });

async function until(test: () => boolean | Promise<boolean>, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await test())) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await sleep(100);
  }
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
async function ops(method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const res = await fetch(`${t.base}/api/ops${path}`, {
    method, headers: { authorization: `Bearer ${session}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) as Json };
}
const containers = async () => (await ops('GET', '/containers')).body;

describe('ops dashboard with match runners', () => {
  it('lists the warm runner, then the lobby on its runner with mode, players and logs', async () => {
    await until(async () => (await containers()).runners.some((r: Json) => r.state === 'warm'));
    const overview = (await ops('GET', '/overview')).body;
    expect(overview).toMatchObject({ isolation: 'container', driver: 'process', driverAvailable: true });
    expect(overview.containers).toMatchObject({ max: 6, warmTarget: 1 });

    const { code } = await createRoom(t.base, { gameType: 'tdm', scoreLimit: 50, timeLimitSec: 600, maxPlayers: 8 });
    const p = await joinGame(t, code, 'ops_player');
    await until(async () => (await containers()).runners.some((r: Json) => r.room === code && r.players === 1));
    const c = await containers();
    const row = c.runners.find((r: Json) => r.room === code);
    expect(row).toMatchObject({ state: 'assigned', gameType: 'tdm', players: 1, maxPlayers: 8, bots: 0 });
    expect(row.name).toMatch(/^process \d+$/);
    expect(row.uptimeSec).toBeGreaterThanOrEqual(0);
    expect(c.games.find((g: Json) => g.code === code)).toMatchObject({ remote: true, gameType: 'tdm', players: 1 });
    expect((await ops('GET', `/rooms/${code}/players`)).body.players.map((x: Json) => x.name)).toEqual(['ops_player']);

    const logs = await ops('GET', `/containers/${row.id}/logs?tail=50`);
    expect(logs.status).toBe(200);
    expect(logs.body.lines.length).toBeGreaterThan(0);
    expect(logs.body.lines.length).toBeLessThanOrEqual(50);
    expect(logs.body.lines.some((l: Json) => l.text.includes('match runner ready'))).toBe(true);
    expect((await ops('GET', '/containers/0000000000000000/logs')).status).toBe(404);
    expect((await ops('GET', '/containers/..%2F..%2Fetc/logs')).status).toBe(400);
    p.client.close();
  }, 90_000);

  it('changes the warm pool at run time: up starts runners, down stops the idle ones', async () => {
    const pool = t.server.control!.pool;
    expect((await ops('POST', '/settings', { values: { matchWarmPool: 2 } })).status).toBe(200);
    await until(() => pool.count('idle') === 2, 60_000);
    expect((await containers()).runners.filter((r: Json) => r.state === 'warm')).toHaveLength(2);
    expect((await ops('POST', '/settings', { values: { matchWarmPool: 0 } })).status).toBe(200);
    await until(() => pool.count('idle') === 0 && pool.count('stopping') === 0, 30_000);
    expect(pool.warm).toBe(0);
    // The process driver has no Docker gate: CPU and memory may go up to the general ranges.
    const s = (await ops('GET', '/settings')).body.settings.find((x: Json) => x.key === 'matchCpus');
    expect(s.max).toBe(8);
    const audit = (await ops('GET', '/audit')).body.entries;
    expect(audit[0]).toMatchObject({ who: 'Stijn', action: 'POST settings', detail: 'matchWarmPool=0', status: 200 });
    await ops('POST', '/settings/reset', { keys: ['matchWarmPool'] });
  }, 90_000);

  it('stops a lobby\'s runner gracefully: its player is told to reconnect, and the same code opens on a fresh runner', async () => {
    const control = t.server.control!;
    const { code } = await createRoom(t.base, { gameType: 'ffa', scoreLimit: 50, timeLimitSec: 600 });
    const p = await joinGame(t, code, 'ops_stop');
    await until(() => control.runners().some((r) => r.room === code && r.state === 'assigned'));
    const first = control.runners().find((r) => r.room === code)!.id;
    const stop = await ops('POST', `/containers/${first}/stop`, {});
    expect(stop.body).toEqual({ ok: true, result: 'draining' });
    const kick = await p.client.waitFor('kick', () => true, 15_000);
    expect(kick.reconnect).toBeGreaterThan(0);
    await until(() => !control.pool.runners.has(first), 30_000);
    const back = await joinGame(t, code, 'ops_stop');
    expect(back.welcome.gameType).toBe('ffa');
    await until(() => control.runners().some((r) => r.room === code && r.id !== first));
    back.client.close();
    // A warm runner just goes.
    await ops('POST', '/settings', { values: { matchWarmPool: 1 } });
    await until(() => control.pool.count('idle') === 1, 60_000);
    const warm = control.runners().find((r) => r.state === 'warm')!.id;
    expect((await ops('POST', `/containers/${warm}/stop`, {})).body.result).toBe('stopped');
    await until(() => !control.pool.runners.has(warm));
  }, 120_000);
});
