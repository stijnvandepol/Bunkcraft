/**
 * MATCH_ISOLATION=container end to end, with real child processes standing in for the containers (MATCH_DRIVER=process):
 * the control plane runs in this test process, every arena lobby runs in a `ROLE=match` runner, and players only
 * ever talk to the control plane, which proxies their WebSocket.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PartyTicket } from '../../src/modes/Party';
import { type TestServer, cleanup, createRoom, joinGame, startTestServer } from '../helpers/serverHarness';

let t: TestServer;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

beforeAll(async () => {
  t = await startTestServer({
    MATCH_ISOLATION: 'container', MATCH_DRIVER: 'process', MATCH_WARM_POOL: '1', MAX_MATCH_CONTAINERS: '8', INTERNAL_PORT: '0',
    INTERNAL_HOST: '127.0.0.1', QUICKPLAY_BOTS: '0', REJOIN_GRACE_SEC: '60', MATCH_IDLE_GRACE_SEC: '5',
  });
}, 60_000);
afterAll(async () => { await t?.stop(); cleanup(t.dir); });

async function until(test: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!test()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await sleep(50);
  }
}

async function post(path: string, token: string | undefined, body: unknown): Promise<{ status: number; body: Record<string, any> }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const res = await fetch(`${t.base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

describe('one match runner per arena lobby', () => {
  it('keeps a warm runner and hands it to a new lobby', async () => {
    const control = t.server.control!;
    await until(() => control.pool.count('idle') >= 1, 30_000);
    const { code } = await createRoom(t.base, { gameType: 'tdm', scoreLimit: 50, timeLimitSec: 600 });
    expect(t.server.rooms!.game(code)).toBeNull(); // not in this process
    const a = await joinGame(t, code, 'cont_a');
    expect(a.welcome).toMatchObject({ gameType: 'tdm', worldType: 'arena' });
    expect(control.runners().some((r) => r.room === code && r.state === 'assigned')).toBe(true);
    // The warm pool refills behind it.
    await until(() => control.pool.count('idle') >= 1, 30_000);
    a.client.close();
  });

  it('plays a whole TDM match with bots through the proxy and grants the XP once, on the control plane', async () => {
    const control = t.server.control!;
    const made = await post('/api/profile', undefined, { name: 'cont_xp' });
    expect(made.status).toBe(201);
    const token = made.body.token as string;
    const pid = made.body.profile.id as string;
    const { code } = await createRoom(t.base, { gameType: 'tdm', scoreLimit: 5, timeLimitSec: 120, maxPlayers: 8, bots: 7, botDifficulty: 'veteran' });
    const p = await joinGame(t, code, 'cont_xp', { profile: token, bin: true });
    expect(p.welcome.gameType).toBe('tdm');
    // Binary frames pass the proxy untouched (snapshots are binary for a client that asks).
    await until(() => p.client.frames.length > 5, 20_000);
    const ended = await p.client.waitFor('match', (m) => m.phase === 'ended', 150_000);
    expect(ended.phase).toBe('ended');
    const report = await p.client.waitFor('progress', () => true, 15_000);
    expect(report.report).toBeTruthy();
    const grants = (control as unknown as { grants: Map<string, unknown> }).grants;
    expect(grants.size).toBe(1);
    const prof = await fetch(`${t.base}/api/profile`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json()) as { profile: { id: string; stats: { seconds: number; deaths: number } } };
    expect(prof.profile.id).toBe(pid);
    expect(prof.profile.stats.seconds).toBeGreaterThan(0); // the grant reached the profile store (a short bot match is not "completed")
    // Leaving after the end pays nothing more.
    p.client.close();
    await sleep(500);
    expect(grants.size).toBe(1);
  }, 200_000);

  it('a player who drops comes back to the same seat through the proxy', async () => {
    const { code } = await createRoom(t.base, { gameType: 'tdm', scoreLimit: 50, timeLimitSec: 600 });
    const a = await joinGame(t, code, 'cont_alice', { key: 'a'.repeat(32) });
    const b = await joinGame(t, code, 'cont_bobby', { key: 'b'.repeat(32) });
    const secret = a.welcome.rejoin!;
    expect(secret).toBeTruthy();
    a.client.close();
    await b.client.waitFor('leave', (m) => m.name === 'cont_alice', 10_000);
    const offer = await post('/api/rejoin', undefined, { code, token: secret });
    expect(offer.body).toMatchObject({ state: 'kept', name: 'cont_alice', gameType: 'tdm' });
    expect((await post('/api/rejoin', undefined, { code, token: 'w'.repeat(32) })).body).toMatchObject({ state: 'none' });
    const a2 = await joinGame(t, code, 'cont_alice', { key: 'a'.repeat(32), rejoin: secret });
    expect(a2.welcome).toMatchObject({ id: a.welcome.id, rejoined: true });
    a2.client.close();
    b.client.close();
  });

  it('a party lands together in a quick play lobby on a runner', async () => {
    const lead = await post('/api/party', undefined, { name: 'cont_lead', gameType: 'tdm' });
    expect(lead.status).toBe(201);
    expect((await post('/api/party/join', undefined, { code: lead.body.party.code, name: 'cont_mate' })).status).toBe(200);
    const play = await post('/api/party/play', lead.body.token, { gameType: 'tdm' });
    expect(play.status).toBe(200);
    const ticket = play.body.ticket as PartyTicket;
    expect(t.server.rooms!.game(ticket.code)).toBeNull();
    const l = await joinGame(t, ticket.code, 'cont_lead', { party: ticket.key });
    const m = await joinGame(t, ticket.code, 'cont_mate', { party: ticket.key });
    const roster = await m.client.waitFor('roster', (r) => r.players.filter((x) => x.name.startsWith('cont_')).length === 2);
    const teams = roster.players.filter((x) => x.name.startsWith('cont_')).map((x) => x.team);
    expect(teams[0]).toBeTruthy();
    expect(teams[0]).toBe(teams[1]);
    l.client.close();
    m.client.close();
  });

  it('stops the runner of an empty lobby after the grace period, and the lobby loads again later', async () => {
    const control = t.server.control!;
    const { code } = await createRoom(t.base, { gameType: 'ffa', scoreLimit: 50, timeLimitSec: 600 });
    const a = await joinGame(t, code, 'cont_idle');
    await until(() => control.runners().some((r) => r.room === code));
    a.client.send({ t: 'bye' } as never);
    a.client.close();
    await until(() => !control.runners().some((r) => r.room === code), 90_000);
    const again = await joinGame(t, code, 'cont_idle');
    expect(again.welcome.gameType).toBe('ffa');
    again.client.close();
  }, 120_000);
});
