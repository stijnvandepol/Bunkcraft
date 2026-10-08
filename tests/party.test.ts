import { describe, expect, it } from 'vitest';
import { PartyService, type PartyResult } from '../server/Parties';
import {
  LEADER_AWAY_MS, MAX_PARTY, MEMBER_DROP_MS, MEMBER_ONLINE_MS, PARTY_IDLE_MS, TICKET_MS, normalizePartyCode, partyLink,
} from '../src/modes/Party';

function setup(over: ConstructorParameters<typeof PartyService>[0] = {}) {
  let now = 1_000_000;
  const released: [string, string][] = [];
  const svc = new PartyService({ now: () => now, release: (c, k) => released.push([c, k]), rank: (id) => (id === 'p-high' ? 1205 : 0), ...over });
  const advance = (ms: number) => { now += ms; };
  return { svc, advance, released };
}

type Ok<T> = Extract<PartyResult<T>, { ok: true }>;
function ok<T>(r: PartyResult<T>): Ok<T> {
  if (!r.ok) throw new Error(`${r.error}: ${r.message}`);
  return r as Ok<T>;
}

/** A party of `n` (the first is the leader); returns their tokens. */
function party(svc: PartyService, n: number): { code: string; tokens: string[]; ids: string[] } {
  const first = ok(svc.create('lead_er', 'tdm'));
  const tokens = [first.token];
  const ids = [first.view.me];
  for (let i = 1; i < n; i++) {
    const j = ok(svc.join(first.view.code, `member_${i}`));
    tokens.push(j.token);
    ids.push(j.view.me);
  }
  return { code: first.view.code, tokens, ids };
}

describe('party codes', () => {
  it('are five characters from the lobby alphabet, tolerant of case, dashes, spaces and links', () => {
    expect(normalizePartyCode('k7qm2')).toBe('K7QM2');
    expect(normalizePartyCode(' K7-QM2 ')).toBe('K7QM2');
    expect(normalizePartyCode(partyLink('https://bunkcraft.example', 'K7QM2'))).toBe('K7QM2');
    expect(normalizePartyCode('K7QM2X')).toBeNull(); // a lobby code is not a party code
    expect(normalizePartyCode('K7QI2')).toBeNull(); // I is not in the alphabet
    expect(normalizePartyCode('')).toBeNull();
  });
});

describe('creating and joining a party', () => {
  it('the creator leads, others join by code, everybody sees the same members', () => {
    const { svc } = setup();
    const p = party(svc, 3);
    const v = ok(svc.view(p.tokens[1])).view;
    expect(v.members.map((m) => m.name)).toEqual(['lead_er', 'member_1', 'member_2']);
    expect(v.leader).toBe(p.ids[0]);
    expect(v.me).toBe(p.ids[1]);
    expect(v.members.filter((m) => m.leader).map((m) => m.name)).toEqual(['lead_er']);
    expect(v.max).toBe(MAX_PARTY);
    expect(v.mode).toBe('tdm');
  });

  it('holds at most six players, and refuses a seventh', () => {
    const { svc } = setup();
    const p = party(svc, MAX_PARTY);
    const r = svc.join(p.code, 'one_too_many');
    expect(r).toMatchObject({ ok: false, error: 'full' });
  });

  it('refuses unknown codes, invalid names and duplicate names, without telling which part was wrong in the code', () => {
    const { svc } = setup();
    const p = party(svc, 1);
    expect(svc.join('ZZZZZ', 'someone')).toMatchObject({ ok: false, error: 'not_found' });
    expect(svc.join(p.code, 'no')).toMatchObject({ ok: false, error: 'name' });
    expect(svc.join(p.code, 'has space')).toMatchObject({ ok: false, error: 'name' });
    expect(svc.join(p.code, 'LEAD_ER')).toMatchObject({ ok: false, error: 'name' });
    expect(svc.create('x', 'tdm')).toMatchObject({ ok: false, error: 'name' });
  });

  it('shows the rank of members with a profile and 0 for guests', () => {
    const { svc } = setup();
    const lead = ok(svc.create('lead_er', 'tdm', 'p-high'));
    ok(svc.join(lead.view.code, 'guest_one'));
    const v = ok(svc.view(lead.token)).view;
    expect(v.members.map((m) => m.rank)).toEqual([1205, 0]);
  });

  it('keeps no address, token or profile id in what members see', () => {
    const { svc } = setup();
    const lead = ok(svc.create('lead_er', 'tdm', 'p-high'));
    const json = JSON.stringify(ok(svc.view(lead.token)).view);
    expect(json).not.toContain('p-high');
    expect(json).not.toContain(lead.token);
  });

  it('a profile is in one party at a time: joining another leaves the first', () => {
    const { svc } = setup();
    const a = ok(svc.create('alice_a', 'tdm', 'p-a'));
    const b = ok(svc.create('bob_bbb', 'tdm'));
    ok(svc.join(b.view.code, 'alice_a', 'p-a'));
    expect(svc.view(a.token)).toMatchObject({ ok: false, error: 'no_party' });
    expect(svc.count).toBe(1); // the first party had nobody left
  });
});

describe('ready, mode and the leader', () => {
  it('members toggle ready, the leader is always ready, and only the leader picks the mode', () => {
    const { svc } = setup();
    const p = party(svc, 2);
    expect(ok(svc.view(p.tokens[0])).view.members.map((m) => m.ready)).toEqual([true, false]);
    ok(svc.setReady(p.tokens[1], true));
    expect(ok(svc.view(p.tokens[0])).view.members.map((m) => m.ready)).toEqual([true, true]);
    expect(svc.setMode(p.tokens[1], 'ctf')).toMatchObject({ ok: false, error: 'forbidden' });
    expect(ok(svc.setMode(p.tokens[0], 'ctf')).view.mode).toBe('ctf');
    expect(ok(svc.view(p.tokens[1])).view.mode).toBe('ctf');
  });

  it('the seq changes when anything does, and stays when nothing does', () => {
    const { svc } = setup();
    const p = party(svc, 2);
    const a = ok(svc.view(p.tokens[0])).view.seq;
    expect(ok(svc.view(p.tokens[0])).view.seq).toBe(a);
    ok(svc.setReady(p.tokens[1], true));
    expect(ok(svc.view(p.tokens[0])).view.seq).toBeGreaterThan(a);
  });

  it('leader leaves: the longest-standing member takes over', () => {
    const { svc, advance } = setup();
    const p = party(svc, 3);
    advance(1000);
    ok(svc.leave(p.tokens[0]));
    const v = ok(svc.view(p.tokens[1])).view;
    expect(v.members.map((m) => m.name)).toEqual(['member_1', 'member_2']);
    expect(v.leader).toBe(p.ids[1]);
    expect(svc.view(p.tokens[0])).toMatchObject({ ok: false, error: 'no_party' });
  });

  it('the last one leaving removes the party and frees its code', () => {
    const { svc } = setup();
    const p = party(svc, 1);
    ok(svc.leave(p.tokens[0]));
    expect(svc.count).toBe(0);
    expect(svc.join(p.code, 'late_one')).toMatchObject({ ok: false, error: 'not_found' });
  });

  it('a leader who stays away hands the crown to an online member; coming back does not take it back', () => {
    const { svc, advance } = setup();
    const p = party(svc, 3);
    advance(LEADER_AWAY_MS + 1000);
    // Only the members poll; the leader's tab is gone.
    ok(svc.view(p.tokens[1]));
    ok(svc.view(p.tokens[2]));
    const v = ok(svc.view(p.tokens[1])).view;
    expect(v.leader).toBe(p.ids[1]);
    const back = ok(svc.view(p.tokens[0])).view;
    expect(back.leader).toBe(p.ids[1]);
    expect(back.members.find((m) => m.id === p.ids[0])!.leader).toBe(false);
  });

  it('the leader hands the crown over on purpose, members cannot', () => {
    const { svc } = setup();
    const p = party(svc, 3);
    expect(svc.promote(p.tokens[1], p.ids[2])).toMatchObject({ ok: false, error: 'forbidden' });
    ok(svc.promote(p.tokens[0], p.ids[2]));
    expect(ok(svc.view(p.tokens[0])).view.leader).toBe(p.ids[2]);
  });
});

describe('kicking', () => {
  it('only the leader kicks; the kicked member is told why, and cannot kick back', () => {
    const { svc } = setup();
    const p = party(svc, 3);
    expect(svc.kick(p.tokens[1], p.ids[2])).toMatchObject({ ok: false, error: 'forbidden' });
    expect(svc.kick(p.tokens[0], p.ids[0])).toMatchObject({ ok: false, error: 'not_found' }); // not yourself
    ok(svc.kick(p.tokens[0], p.ids[2]));
    expect(ok(svc.view(p.tokens[0])).view.members.map((m) => m.name)).toEqual(['lead_er', 'member_1']);
    expect(svc.view(p.tokens[2])).toMatchObject({ ok: false, error: 'forbidden' });
    expect(svc.kick(p.tokens[2], p.ids[1])).toMatchObject({ ok: false });
  });
});

describe('expiry', () => {
  it('a member who is not seen for a while shows offline, then is dropped; the party carries on', () => {
    const { svc, advance } = setup();
    const p = party(svc, 3);
    advance(MEMBER_ONLINE_MS + 1000);
    ok(svc.view(p.tokens[0]));
    ok(svc.view(p.tokens[1]));
    const v = ok(svc.view(p.tokens[0])).view;
    expect(v.members.map((m) => m.online)).toEqual([true, true, false]);
    advance(MEMBER_DROP_MS);
    ok(svc.view(p.tokens[0]));
    ok(svc.view(p.tokens[1]));
    expect(ok(svc.view(p.tokens[0])).view.members.map((m) => m.name)).toEqual(['lead_er', 'member_1']);
    expect(svc.view(p.tokens[2])).toMatchObject({ ok: false, error: 'no_party' });
  });

  it('a party nobody polls is swept away with its ticket released', () => {
    const { svc, advance, released } = setup();
    const p = party(svc, 2);
    ok(svc.play(p.tokens[0], () => ({ code: 'ABC234', gameType: 'tdm' })));
    advance(PARTY_IDLE_MS + 1000);
    expect(svc.sweep()).toBe(1);
    expect(svc.count).toBe(0);
    expect(svc.view(p.tokens[0])).toMatchObject({ ok: false, error: 'no_party' });
    expect(released).toHaveLength(1);
    expect(released[0][0]).toBe('ABC234');
  });

  it('a party that is polled does not expire', () => {
    const { svc, advance } = setup();
    const p = party(svc, 1);
    for (let i = 0; i < 20; i++) {
      advance(60_000);
      ok(svc.view(p.tokens[0]));
      svc.sweep();
    }
    expect(svc.count).toBe(1);
  });

  it('refuses new parties when the server holds too many', () => {
    const { svc } = setup({ maxParties: 2 });
    ok(svc.create('aaa_aaa', 'tdm'));
    ok(svc.create('bbb_bbb', 'tdm'));
    expect(svc.create('ccc_ccc', 'tdm')).toMatchObject({ ok: false, error: 'unavailable' });
  });
});

describe('coming back after a reload', () => {
  it('the same profile gets a fresh token and its place back; the old token stops working', () => {
    const { svc } = setup();
    const lead = ok(svc.create('lead_er', 'tdm', 'p-lead'));
    const friend = ok(svc.join(lead.view.code, 'friend_f', 'p-friend'));
    const back = ok(svc.resume('p-friend', 'friend_f'));
    expect(back.view.me).toBe(friend.view.me);
    expect(back.token).not.toBe(friend.token);
    expect(svc.view(friend.token)).toMatchObject({ ok: false, error: 'no_party' });
    expect(ok(svc.view(back.token)).view.members).toHaveLength(2);
  });

  it('joining again with the same profile is a resume, not a second seat', () => {
    const { svc } = setup();
    const lead = ok(svc.create('lead_er', 'tdm', 'p-lead'));
    ok(svc.join(lead.view.code, 'friend_f', 'p-friend'));
    ok(svc.join(lead.view.code, 'friend_f', 'p-friend'));
    expect(ok(svc.view(lead.token)).view.members).toHaveLength(2);
  });

  it('a profile without a party has nothing to resume', () => {
    const { svc } = setup();
    expect(svc.resume('p-nobody', 'nobody_x')).toMatchObject({ ok: false, error: 'no_party' });
  });

  it('a token that was never issued finds nothing', () => {
    const { svc } = setup();
    expect(svc.view('made-up-token')).toMatchObject({ ok: false, error: 'no_party' });
    expect(svc.leave('')).toMatchObject({ ok: false, error: 'no_party' });
  });
});

describe('playing', () => {
  it('only the leader plays; the seats asked for are the members that are here', () => {
    const { svc, advance } = setup();
    const p = party(svc, 4);
    advance(MEMBER_ONLINE_MS + 1000);
    for (const i of [0, 1, 2]) ok(svc.view(p.tokens[i])); // member 3 went away
    expect(svc.play(p.tokens[1], () => ({ code: 'ABC234', gameType: 'tdm' }))).toMatchObject({ ok: false, error: 'forbidden' });
    let asked = 0;
    const r = ok(svc.play(p.tokens[0], (seats) => { asked = seats.size; return { code: 'ABC234', gameType: 'tdm' }; }));
    expect(asked).toBe(3);
    expect(r.ticket.code).toBe('ABC234');
  });

  it('members in another match are not waited for', () => {
    const { svc } = setup();
    const p = party(svc, 3);
    ok(svc.view(p.tokens[2], 'game'));
    let asked = 0;
    ok(svc.play(p.tokens[0], (seats) => { asked = seats.size; return { code: 'ABC234', gameType: 'tdm' }; }));
    expect(asked).toBe(2);
  });

  it('every member sees the ticket with the same lobby and key, and the ready flags reset', () => {
    const { svc } = setup();
    const p = party(svc, 3);
    ok(svc.setReady(p.tokens[1], true));
    ok(svc.setReady(p.tokens[2], true));
    const r = ok(svc.play(p.tokens[0], () => ({ code: 'ABC234', gameType: 'ctf' })));
    const seen = [1, 2].map((i) => ok(svc.view(p.tokens[i])).view);
    for (const v of seen) {
      expect(v.ticket).toMatchObject({ code: 'ABC234', gameType: 'ctf', key: r.ticket.key, id: r.ticket.id });
      expect(v.mode).toBe('ctf');
      expect(v.members.filter((m) => !m.leader).every((m) => !m.ready)).toBe(true);
    }
    expect(r.ticket.key).toMatch(/^[0-9a-f]{32}$/);
  });

  it('a ticket expires on its own', () => {
    const { svc, advance } = setup();
    const p = party(svc, 2);
    ok(svc.play(p.tokens[0], () => ({ code: 'AAAAAA', gameType: 'tdm' })));
    expect(ok(svc.view(p.tokens[1])).view.ticket).toBeDefined();
    advance(TICKET_MS + 1);
    ok(svc.view(p.tokens[0]));
    expect(ok(svc.view(p.tokens[1])).view.ticket).toBeUndefined();
  });

  it('a new play makes a new ticket and gives the seats of the old one back', () => {
    const { svc, released } = setup();
    const p = party(svc, 2);
    const first = ok(svc.play(p.tokens[0], () => ({ code: 'AAAAAA', gameType: 'tdm' }))).ticket;
    const second = ok(svc.play(p.tokens[0], () => ({ code: 'BBBBBB', gameType: 'tdm' }))).ticket;
    expect(second.id).toBe(first.id + 1);
    expect(second.key).not.toBe(first.key);
    expect(released).toEqual([['AAAAAA', first.key]]);
  });

  it('when no lobby has room nothing changes and the party keeps no ticket', () => {
    const { svc } = setup();
    const p = party(svc, 2);
    const r = svc.play(p.tokens[0], () => ({ error: 'no_room', message: 'No room' }));
    expect(r).toMatchObject({ ok: false, error: 'no_room' });
    expect(ok(svc.view(p.tokens[1])).view.ticket).toBeUndefined();
  });
});
