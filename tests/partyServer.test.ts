import { afterEach, describe, expect, it } from 'vitest';
import type { PartyTicket, PartyView } from '../src/modes/Party';
import { type TestServer, cleanup, joinGame, startTestServer } from './helpers/serverHarness';

const stoppers: TestServer[] = [];
afterEach(async () => {
  const all = stoppers.splice(0);
  for (const t of all) await t.stop();
  for (const t of all) cleanup(t.dir);
});

async function start(env: Record<string, string> = {}): Promise<TestServer> {
  const t = await startTestServer({ QUICKPLAY_BOTS: '0', ...env });
  stoppers.push(t);
  return t;
}

interface Reply { status: number; body: Record<string, any> } // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(t: TestServer, method: 'GET' | 'POST', path: string, token?: string, body?: unknown): Promise<Reply> {
  const res = await fetch(`${t.base}${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** A browser of a player: a party token and, with `profile`, a Realms profile. */
class Player {
  partyToken = '';
  profileToken = '';
  view!: PartyView;
  constructor(readonly t: TestServer, readonly name: string) {}

  async makeProfile(): Promise<this> {
    const r = await call(this.t, 'POST', '/api/profile', undefined, { name: this.name });
    expect(r.status).toBe(201);
    this.profileToken = r.body.token;
    return this;
  }

  async create(): Promise<this> {
    const r = await call(this.t, 'POST', '/api/party', this.profileToken || undefined, { name: this.name, gameType: 'tdm' });
    expect(r.status).toBe(201);
    this.partyToken = r.body.token;
    this.view = r.body.party;
    return this;
  }

  async join(code: string): Promise<this> {
    const r = await call(this.t, 'POST', '/api/party/join', this.profileToken || undefined, { code, name: this.name });
    expect(r.status).toBe(200);
    this.partyToken = r.body.token;
    this.view = r.body.party;
    return this;
  }

  async poll(status: 'menu' | 'game' = 'menu'): Promise<PartyView> {
    const r = await call(this.t, 'GET', `/api/party?status=${status}`, this.partyToken);
    expect(r.status).toBe(200);
    this.view = r.body.party;
    return this.view;
  }
}

describe('parties over the API', () => {
  it('three players form a party, the leader quick plays, and all three land in one lobby on the same team', async () => {
    const t = await start();
    const lead = await new Player(t, 'lead_one').makeProfile();
    await lead.create();
    const code = lead.view.code;
    expect(code).toMatch(/^[A-Z0-9]{5}$/);
    const a = await new Player(t, 'friend_a').makeProfile();
    const b = await new Player(t, 'friend_b').makeProfile();
    await a.join(code);
    await b.join(code);

    // Everybody sees three members; the leader wears the crown; the ranks come from the profiles.
    const v = await b.poll();
    expect(v.members.map((m) => m.name)).toEqual(['lead_one', 'friend_a', 'friend_b']);
    expect(v.members.filter((m) => m.leader).map((m) => m.name)).toEqual(['lead_one']);
    expect(v.members.every((m) => m.rank >= 1)).toBe(true);

    // Only the leader can start the match.
    expect((await call(t, 'POST', '/api/party/play', a.partyToken, { gameType: 'tdm' })).status).toBe(403);

    const play = await call(t, 'POST', '/api/party/play', lead.partyToken, { gameType: 'tdm' });
    expect(play.status).toBe(200);
    const ticket = play.body.ticket as PartyTicket;
    expect(ticket.code).toMatch(/^[A-Z0-9]{6}$/);

    // Members find the same ticket on their next poll.
    const seen = [await a.poll(), await b.poll()].map((p) => p.ticket!);
    for (const s of seen) expect(s).toMatchObject({ id: ticket.id, code: ticket.code, key: ticket.key, gameType: 'tdm' });

    // A stranger who is quicker than the party's slowest member does not break the plan.
    const joined = [];
    joined.push(await joinGame(t, ticket.code, 'lead_one', { party: ticket.key, profile: lead.profileToken }));
    joined.push(await joinGame(t, ticket.code, 'friend_a', { party: ticket.key, profile: a.profileToken }));
    const stranger = await joinGame(t, ticket.code, 'stranger_x');
    joined.push(await joinGame(t, ticket.code, 'friend_b', { party: ticket.key, profile: b.profileToken }));

    const room = t.server.rooms!.get(ticket.code)!.server as unknown as { match: { players: Map<number, { name: string; team: string; party?: string }> } };
    const players = [...room.match.players.values()];
    const team = (name: string) => players.find((p) => p.name === name)?.team;
    expect(new Set(['lead_one', 'friend_a', 'friend_b'].map(team)).size).toBe(1);
    expect(team('stranger_x')).not.toBe(team('lead_one'));
    // ... and every party member carries the same party id (the team balance keeps them together).
    expect(new Set(players.filter((p) => p.name.startsWith('friend_') || p.name === 'lead_one').map((p) => p.party)).size).toBe(1);
    // the welcome tells everybody who plays on which team
    expect(joined[2].welcome.players.map((p) => p.name)).toEqual(expect.arrayContaining(['lead_one', 'friend_a']));
    for (const j of [...joined, stranger]) j.client.close();
  });

  it('the party survives a match and a reload: the profile finds it again, the leader queues again', async () => {
    const t = await start();
    const lead = await new Player(t, 'lead_two').makeProfile();
    await lead.create();
    const friend = await new Player(t, 'friend_c').makeProfile();
    await friend.join(lead.view.code);

    const first = (await call(t, 'POST', '/api/party/play', lead.partyToken, { gameType: 'tdm' })).body.ticket as PartyTicket;
    const j = await Promise.all([
      joinGame(t, first.code, 'lead_two', { party: first.key }),
      joinGame(t, first.code, 'friend_c', { party: first.key }),
    ]);
    j.forEach((x) => x.client.close());
    // the page of the friend reloads: no sessionStorage token, but the profile token is still there
    const lost = friend.partyToken;
    const resumed = await call(t, 'POST', '/api/party/resume', friend.profileToken, { name: 'friend_c' });
    expect(resumed.status).toBe(200);
    expect(resumed.body.party.me).toBe(friend.view.me);
    expect((await call(t, 'GET', '/api/party', lost)).status).toBe(404); // the old token is dead
    friend.partyToken = resumed.body.token;

    // The match is over for both, the party is still two people. The leader goes again.
    expect((await friend.poll()).members).toHaveLength(2);
    const second = (await call(t, 'POST', '/api/party/play', lead.partyToken, { gameType: 'tdm' })).body.ticket as PartyTicket;
    expect(second.id).toBe(first.id + 1);
    expect(second.key).not.toBe(first.key);
    expect((await friend.poll()).ticket?.id).toBe(second.id);
  });

  it('the leader leaving hands the crown over, and the new leader can start the match', async () => {
    const t = await start();
    const lead = await new Player(t, 'lead_three').create();
    const friend = await new Player(t, 'friend_d').join(lead.view.code);
    expect((await call(t, 'POST', '/api/party/leave', lead.partyToken, {})).status).toBe(200);
    const v = await friend.poll();
    expect(v.members.map((m) => m.name)).toEqual(['friend_d']);
    expect(v.leader).toBe(v.me);
    expect((await call(t, 'POST', '/api/party/play', friend.partyToken, { gameType: 'tdm' })).status).toBe(200);
  });

  it('kicking, promoting and the mode need the leader; strangers and bad tokens learn nothing', async () => {
    const t = await start();
    const lead = await new Player(t, 'lead_four').create();
    const a = await new Player(t, 'friend_e').join(lead.view.code);
    const b = await new Player(t, 'friend_f').join(lead.view.code);
    expect((await call(t, 'POST', '/api/party/kick', a.partyToken, { member: b.view.me })).status).toBe(403);
    expect((await call(t, 'POST', '/api/party/mode', a.partyToken, { gameType: 'ctf' })).status).toBe(403);
    expect((await call(t, 'POST', '/api/party/mode', lead.partyToken, { gameType: 'minecraft' })).status).toBe(400);
    expect((await call(t, 'POST', '/api/party/mode', lead.partyToken, { gameType: 'ctf' })).body.party.mode).toBe('ctf');
    expect((await a.poll()).mode).toBe('ctf');
    expect((await call(t, 'POST', '/api/party/kick', lead.partyToken, { member: b.view.me })).status).toBe(200);
    expect((await call(t, 'GET', '/api/party', b.partyToken)).status).toBe(403); // told why
    expect((await call(t, 'GET', '/api/party', 'not-a-token')).status).toBe(404);
    expect((await call(t, 'GET', '/api/party')).status).toBe(404);
    expect((await call(t, 'POST', '/api/party/promote', lead.partyToken, { member: a.view.me })).status).toBe(200);
    expect((await call(t, 'POST', '/api/party/play', a.partyToken, { gameType: 'ffa' })).status).toBe(200);
  });

  it('the leader can take the party into one particular lobby, if it has room for all', async () => {
    const t = await start();
    const room = await (await fetch(`${t.base}/api/rooms`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Mine', gameType: 'tdm', maxPlayers: 4, mapId: 'rotate' }),
    })).json() as { code: string };
    const lead = await new Player(t, 'lead_five').create();
    for (const n of ['friend_g', 'friend_h']) await new Player(t, n).join(lead.view.code);
    const ok = await call(t, 'POST', '/api/party/play', lead.partyToken, { code: room.code });
    expect(ok.status).toBe(200);
    expect(ok.body.ticket.code).toBe(room.code);
    // The lobby holds 4: a second party of three does not fit any more.
    const other = await new Player(t, 'lead_six').create();
    for (const n of ['friend_i', 'friend_j']) await new Player(t, n).join(other.view.code);
    const no = await call(t, 'POST', '/api/party/play', other.partyToken, { code: room.code });
    expect(no.status).toBe(409);
    expect(no.body.code).toBe('no_room');
    expect((await call(t, 'POST', '/api/party/play', other.partyToken, { code: 'ZZZZZZ' })).status).toBe(404);
  });

  it('keeps nothing personal in what members get back', async () => {
    const t = await start();
    const lead = await new Player(t, 'lead_seven').makeProfile();
    await lead.create();
    const raw = JSON.stringify((await call(t, 'GET', '/api/party', lead.partyToken)).body);
    expect(raw).not.toContain('127.0.0.1');
    expect(raw).not.toContain(lead.partyToken);
    expect(raw).not.toContain(lead.profileToken);
    const profile = (await call(t, 'GET', '/api/profile', lead.profileToken)).body.profile as { id?: string };
    if (profile.id) expect(raw).not.toContain(profile.id);
  });
});

describe('party rate limits', () => {
  it('limits creating parties per address', async () => {
    const t = await start({ PARTY_CREATE_LIMIT: '2' });
    await new Player(t, 'maker_one').create();
    await new Player(t, 'maker_two').create();
    const r = await call(t, 'POST', '/api/party', undefined, { name: 'maker_three', gameType: 'tdm' });
    expect(r.status).toBe(429);
  });

  it('limits guessing party codes per address', async () => {
    const t = await start();
    let limited = 0;
    for (let i = 0; i < 40; i++) {
      const r = await call(t, 'POST', '/api/party/join', undefined, { code: 'ZZZZ' + 'AB'[i % 2], name: 'guesser_x' });
      if (r.status === 429) limited++;
      else expect(r.status).toBe(404);
    }
    expect(limited).toBeGreaterThan(0);
  });

  it('limits how often one member can poll', async () => {
    const t = await start();
    const p = await new Player(t, 'poller_one').create();
    let limited = 0;
    for (let i = 0; i < 130; i++) if ((await call(t, 'GET', '/api/party', p.partyToken)).status === 429) limited++;
    expect(limited).toBeGreaterThan(0);
  });

  it('a server with parties switched off says so', async () => {
    const t = await start({ PARTIES: 'off' });
    const info = await (await fetch(`${t.base}/api/server`)).json() as { features: { party?: boolean } };
    expect(info.features.party).toBe(false);
    expect((await call(t, 'POST', '/api/party', undefined, { name: 'nobody_x' })).status).toBe(404);
  });
});
