/**
 * Parties and rejoin together: seats kept for a dropped connection and seats held for a party both count as taken,
 * so a lobby never overfills and a party never splits, and a party member who drops goes back to their team.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PartyTicket } from '../src/modes/Party';
import type { GameServer } from '../server/GameServer';
import type { Match } from '../server/Match';
import { type TestServer, cleanup, createRoom, joinGame, startTestServer } from './helpers/serverHarness';

let t: TestServer;
beforeAll(async () => { t = await startTestServer({ QUICKPLAY_BOTS: '0', REJOIN_GRACE_SEC: '90' }); });
afterAll(async () => { await t.stop(); cleanup(t.dir); });

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const gameOf = (code: string): GameServer => t.server.rooms!.get(code)!.server;
const matchOf = (code: string): Match => (gameOf(code) as unknown as { match: Match }).match;

async function until(test: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!test()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await sleep(20);
  }
}

async function post(path: string, token: string | undefined, body: unknown): Promise<{ status: number; body: Record<string, any> }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const res = await fetch(`${t.base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** A party of `names` (the first leads) taken to the lobby `code`: the ticket and nothing connected yet. */
async function partyTo(names: string[], code: string): Promise<PartyTicket> {
  const lead = await post('/api/party', undefined, { name: names[0], gameType: 'tdm' });
  expect(lead.status).toBe(201);
  for (const n of names.slice(1)) expect((await post('/api/party/join', undefined, { code: lead.body.party.code, name: n })).status).toBe(200);
  const play = await post('/api/party/play', lead.body.token, { code });
  expect(play.status).toBe(200);
  return play.body.ticket as PartyTicket;
}

const kicked = (p: Promise<unknown>) => p.then(() => null, (e: { kick?: { code?: string } }) => e.kick?.code ?? 'error');

describe('parties and rejoin share the seat accounting', () => {
  it('a party member who drops goes back to the party team, and kept seats still block a stranger', async () => {
    const { code } = await createRoom(t.base, { gameType: 'tdm', maxPlayers: 4, scoreLimit: 50, timeLimitSec: 600 });
    const ticket = await partyTo(['pr_lead', 'pr_mate'], code);
    const lead = await joinGame(t, code, 'pr_lead', { party: ticket.key });
    const mate = await joinGame(t, code, 'pr_mate', { party: ticket.key });
    const match = matchOf(code);
    const team = match.players.get(lead.welcome.id)!.team;
    expect(match.players.get(mate.welcome.id)!.team).toBe(team);

    mate.client.close();
    await until(() => match.parked.has(mate.welcome.id));
    expect(gameOf(code).reservedSeats).toBe(1); // kept, not held: the party's hold is used up
    expect(match.parked.get(mate.welcome.id)!.party).toBe(match.players.get(lead.welcome.id)!.party);

    // 4 seats: lead + kept mate + two strangers; a fifth does not fit.
    const s1 = await joinGame(t, code, 'pr_s1');
    const s2 = await joinGame(t, code, 'pr_s2');
    expect(await kicked(joinGame(t, code, 'pr_s3'))).toBe('full');
    expect(match.players.size).toBe(3);

    // The mate comes back with only the rejoin secret (the ticket key is long gone): same seat, same team.
    const back = await joinGame(t, code, 'pr_mate', { rejoin: mate.welcome.rejoin });
    expect(back.welcome).toMatchObject({ id: mate.welcome.id, rejoined: true });
    expect(match.players.get(mate.welcome.id)!.team).toBe(team);
    expect(match.players.get(mate.welcome.id)!.party).toBe(match.players.get(lead.welcome.id)!.party);
    expect(match.players.size).toBe(4);
    expect(gameOf(code).reservedSeats).toBe(0);
    for (const c of [lead, back, s1, s2]) c.client.close();
  });

  it('a kept seat plus a party hold never overfill the lobby, and the dropped player still gets back in', async () => {
    const { code } = await createRoom(t.base, { gameType: 'tdm', maxPlayers: 4, scoreLimit: 50, timeLimitSec: 600 });
    const solo = await joinGame(t, code, 'pr_solo');
    const match = matchOf(code);
    solo.client.close();
    await until(() => match.parked.has(solo.welcome.id));
    expect(gameOf(code).reservedSeats).toBe(1);

    // A party of two holds two seats next to the kept one.
    const ticket = await partyTo(['pr_p1', 'pr_p2'], code);
    expect(gameOf(code).reservedSeats).toBe(3);
    // Only one seat is left for strangers.
    const t1 = await joinGame(t, code, 'pr_t1');
    expect(await kicked(joinGame(t, code, 'pr_t2'))).toBe('full');

    // The dropped player takes the kept seat back; it was never anybody else's.
    const back = await joinGame(t, code, 'pr_solo', { rejoin: solo.welcome.rejoin });
    expect(back.welcome.rejoined).toBe(true);
    const p1 = await joinGame(t, code, 'pr_p1', { party: ticket.key });
    const p2 = await joinGame(t, code, 'pr_p2', { party: ticket.key });
    expect(match.players.size).toBe(4);
    expect(gameOf(code).reservedSeats).toBe(0);
    const teamOf = (n: string) => [...match.players.values()].find((p) => p.name === n)!.team;
    expect(teamOf('pr_p1')).toBe(teamOf('pr_p2'));
    for (const c of [t1, back, p1, p2]) c.client.close();
  });
});
