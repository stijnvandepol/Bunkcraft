import { afterEach, describe, expect, it } from 'vitest';
import { type PartyChange, type PartyTicket, partyChanges } from '../src/modes/Party';
import { PartyCallError, PartyClient } from '../src/net/PartyApi';
import { type TestServer, cleanup, startTestServer } from './helpers/serverHarness';

const stoppers: TestServer[] = [];
afterEach(async () => {
  const all = stoppers.splice(0);
  for (const t of all) await t.stop();
  for (const t of all) cleanup(t.dir);
});

class MemoryStorage {
  private readonly map = new Map<string, string>();
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { this.map.set(k, v); }
  removeItem(k: string) { this.map.delete(k); }
}

/** A browser: its own sessionStorage and (optionally) profile token, talking to the test server. */
function browser(t: TestServer, storage = new MemoryStorage(), profile?: string) {
  let now = 1_000_000;
  const client = new PartyClient({
    fetch: (path, init) => fetch(`${t.base}${path}`, init), storage, profileToken: () => profile, host: 'test', now: () => now,
  });
  const events: PartyChange[] = [];
  const tickets: PartyTicket[] = [];
  client.onEvent((c) => events.push(c));
  client.onTicket((x) => tickets.push(x));
  return { client, storage, events, tickets, advance: (ms: number) => { now += ms; } };
}

async function start(): Promise<TestServer> {
  const t = await startTestServer({ QUICKPLAY_BOTS: '0' });
  stoppers.push(t);
  return t;
}

describe('partyChanges', () => {
  const view = (members: string[], leader: string) => ({
    code: 'K7QM2', seq: 1, max: 6, leader, me: 'a', mode: 'tdm' as const,
    members: members.map((id) => ({ id, name: `n_${id}`, rank: 0, leader: id === leader, ready: false, online: true, status: 'menu' as const })),
  });

  it('names who joined, who left and the new leader', () => {
    expect(partyChanges(view(['a'], 'a'), view(['a', 'b'], 'a'))).toEqual([{ kind: 'joined', name: 'n_b' }]);
    expect(partyChanges(view(['a', 'b'], 'a'), view(['b'], 'b'))).toEqual([{ kind: 'left', name: 'n_a' }, { kind: 'leader', name: 'n_b', you: false }]);
    expect(partyChanges(view(['b', 'a'], 'b'), view(['b', 'a'], 'a'))).toEqual([{ kind: 'leader', name: 'n_a', you: true }]);
  });

  it('says nothing for the first view, and one thing when the party is gone', () => {
    expect(partyChanges(null, view(['a'], 'a'))).toEqual([]);
    expect(partyChanges(view(['a'], 'a'), null)).toEqual([{ kind: 'ended' }]);
  });
});

describe('PartyClient against a real server', () => {
  it('creates, joins, sees the others come, and receives the leader\'s ticket exactly once', async () => {
    const t = await start();
    const lead = browser(t);
    const friend = browser(t);
    const view = await lead.client.create('lead_aaa', 'tdm');
    expect(lead.client.active && lead.client.isLeader).toBe(true);
    await friend.client.join(view.code.toLowerCase(), 'friend_bb');
    expect(friend.client.isLeader).toBe(false);

    await lead.client.poll();
    // (poll() only runs for a client with a token; the join above set it)
    expect(lead.events).toContainEqual({ kind: 'joined', name: 'friend_bb' });
    expect(lead.client.view!.members).toHaveLength(2);

    await friend.client.setReady(true);
    await lead.client.poll();
    expect(lead.client.view!.members.find((m) => m.name === 'friend_bb')!.ready).toBe(true);

    const ticket = await lead.client.play({ gameType: 'tdm' });
    expect(lead.tickets.map((x) => x.id)).toEqual([ticket.id]);
    await lead.client.poll(); // the leader's own poll sees the ticket again but does not announce it twice
    expect(lead.tickets).toHaveLength(1);

    await friend.client.poll();
    await friend.client.poll();
    expect(friend.tickets.map((x) => x.id)).toEqual([ticket.id]);
    expect(friend.client.keyFor(ticket.code)).toBe(ticket.key);
    expect(friend.client.keyFor('ZZZZZZ')).toBeUndefined();
    // the ticket stops counting once its time is up
    friend.advance(ticket.ttlMs + 1000);
    expect(friend.client.keyFor(ticket.code)).toBeUndefined();
  });

  it('a reload keeps the party through the session token; a new tab finds it through the profile', async () => {
    const t = await start();
    const prof = await (await fetch(`${t.base}/api/profile`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'lead_aaa' }) })).json() as { token: string };
    const first = browser(t, new MemoryStorage(), prof.token);
    const view = await first.client.create('lead_aaa', 'ctf');

    const reloaded = browser(t, first.storage, prof.token);
    expect(reloaded.client.active).toBe(false);
    const again = await reloaded.client.resume();
    expect(again?.code).toBe(view.code);
    expect(reloaded.client.isLeader).toBe(true);

    const newTab = browser(t, new MemoryStorage(), prof.token);
    const found = await newTab.client.resume('lead_aaa');
    expect(found?.code).toBe(view.code);

    const stranger = browser(t);
    expect(await stranger.client.resume()).toBeNull();
  });

  it('leaving ends it for you; the others see you go; a removed member is told', async () => {
    const t = await start();
    const lead = browser(t);
    const a = browser(t);
    const b = browser(t);
    const view = await lead.client.create('lead_aaa', 'tdm');
    await a.client.join(view.code, 'friend_aa');
    const joinedB = await b.client.join(view.code, 'friend_bb');
    await lead.client.poll();
    await a.client.leave();
    expect(a.client.active).toBe(false);
    await lead.client.poll();
    expect(lead.events).toContainEqual({ kind: 'left', name: 'friend_aa' });

    await lead.client.kick(joinedB.me);
    await b.client.poll();
    expect(b.client.active).toBe(false);
    expect(b.events).toContainEqual({ kind: 'kicked' });
    expect(b.storage.getItem('bunkcraft.party.test')).toBeNull();
  });

  it('turns server refusals into errors with a code the menu can translate', async () => {
    const t = await start();
    const lead = browser(t);
    const view = await lead.client.create('lead_aaa', 'tdm');
    const friend = browser(t);
    await expect(friend.client.join('ZZZZZ', 'friend_aa')).rejects.toMatchObject({ code: 'not_found' });
    await friend.client.join(view.code, 'friend_aa');
    await expect(friend.client.play({ gameType: 'tdm' })).rejects.toBeInstanceOf(PartyCallError);
    await expect(friend.client.play({ gameType: 'tdm' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(lead.client.setMode('minecraft')).rejects.toMatchObject({ code: 'bad_request' });
  });
});
