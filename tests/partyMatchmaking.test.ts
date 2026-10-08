import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type LobbyCandidate, joinable, partyFits, pickLobby, teamCapacity } from '../src/modes/Realms';
import { type ClientMessage, PROTOCOL_VERSION, type ServerMessage, type MatchInfo } from '../src/net/protocol';
import { Match, type MatchHost } from '../server/Match';
import { Rooms, type PartySeats } from '../server/Rooms';
import { BLOCK } from '../src/world/BlockRegistry';
import { FakeSocket, type SimClock, SimLobby } from './helpers/botServer';

const lobby = (code: string, over: Partial<LobbyCandidate> = {}): LobbyCandidate => ({
  code, gameType: 'tdm', players: 0, maxPlayers: 8, open: true, ...over,
});

describe('matchmaking with a party: the whole party has to fit', () => {
  it('needs a seat for every member', () => {
    expect(joinable(lobby('AAAAAA', { players: 5 }), 'tdm', 3)).toBe(true);
    expect(joinable(lobby('AAAAAA', { players: 6 }), 'tdm', 3)).toBe(false);
    expect(joinable(lobby('AAAAAA', { players: 8 }), 'tdm', 1)).toBe(false);
  });

  it('picks the fullest lobby the party fits in, not just the fullest one', () => {
    const pick = pickLobby([
      lobby('AAAAAA', { players: 7 }), // fuller but no room for three
      lobby('BBBBBB', { players: 4 }),
      lobby('CCCCCC', { players: 1 }),
    ], 'tdm', 3);
    expect(pick?.code).toBe('BBBBBB');
    expect(pickLobby([lobby('AAAAAA', { players: 7 })], 'tdm', 3)).toBeNull();
  });

  it('seats held for other parties count as taken (they are part of `players`)', () => {
    // 3 people inside + 4 seats held for a party on its way in = 7 of 8
    expect(joinable(lobby('AAAAAA', { players: 7 }), 'tdm', 2)).toBe(false);
    expect(joinable(lobby('AAAAAA', { players: 7 }), 'tdm', 1)).toBe(true);
  });

  it('a team mode lobby with people takes the party only when one team can hold all of them', () => {
    const cap = teamCapacity(8);
    expect(cap).toBe(4);
    // blue has 1, red has 3: the party joins blue, 1 + 3 = 4 fits
    expect(partyFits(lobby('AAAAAA', { players: 4, teams: { red: 3, blue: 1 } }), 'tdm', 3)).toBe(true);
    // 2 + 3 = 5 > 4: the lobby would go lopsided
    expect(partyFits(lobby('AAAAAA', { players: 4, teams: { red: 2, blue: 2 } }), 'tdm', 3)).toBe(false);
    // an empty lobby always fits: the party is its first team
    expect(partyFits(lobby('AAAAAA', { players: 0 }), 'tdm', 6)).toBe(true);
    // ... as long as the seats are there
    expect(partyFits(lobby('AAAAAA', { players: 0, maxPlayers: 4 }), 'tdm', 6)).toBe(false);
  });

  it('free for all and infected have no team limit', () => {
    const teams = { red: 2, blue: 2 };
    expect(partyFits(lobby('AAAAAA', { gameType: 'ffa', players: 4, teams }), 'ffa', 4)).toBe(true);
    expect(partyFits(lobby('AAAAAA', { gameType: 'infected', players: 4, teams }), 'infected', 4)).toBe(true);
  });

  it('a party of one is the old quick play', () => {
    const c = lobby('AAAAAA', { players: 5, teams: { red: 3, blue: 2 } });
    expect(joinable(c, 'tdm')).toBe(joinable(c, 'tdm', 1));
    expect(pickLobby([c], 'tdm')?.code).toBe('AAAAAA');
  });
});

describe('team balance never splits a party', () => {
  class Stub implements MatchHost {
    t = 1000;
    blocks = { getBlock: () => BLOCK.AIR };
    now() { return this.t; }
    send() { /* nobody listens */ }
    broadcast() { /* nobody listens */ }
    random() { return 0; }
    ping() { return 0; }
    moveTo() { /* nothing */ }
  }
  const make = () => new Match(new Stub(), { type: 'tdm', scoreLimit: 30, timeLimitSec: 600 } satisfies MatchInfo);
  const teamsOf = (m: Match, ids: number[]) => ids.map((id) => m.players.get(id)!.team);

  it('a seat with a team puts the player on that team', () => {
    const m = make();
    m.join(1, 'solo_one');
    m.join(2, 'solo_two');
    for (const id of [3, 4, 5]) m.join(id, `friend_${id}`, false, { party: 'P1', team: 'red' });
    expect(teamsOf(m, [3, 4, 5])).toEqual(['red', 'red', 'red']);
    expect(m.players.get(3)!.party).toBe('P1');
  });

  it('when others leave, the lopsided teams are evened out with solo players, not with party members', () => {
    const m = make();
    for (const id of [1, 2, 3]) m.join(id, `friend_${id}`, false, { party: 'P1', team: 'red' });
    m.join(4, 'solo_four', false, { team: 'red' });
    m.join(5, 'solo_five', false, { team: 'blue' });
    // red: 3 friends + solo, blue: solo  -> diff 3: the solo moves, the party stays.
    (m as unknown as { rebalance(): void }).rebalance();
    expect(teamsOf(m, [1, 2, 3])).toEqual(['red', 'red', 'red']);
    expect(m.players.get(4)!.team).toBe('blue');
    expect(m.teamSize('red')).toBe(3);
    expect(m.teamSize('blue')).toBe(2);
  });

  it('a party bigger than the gap stays together even if the teams stay uneven', () => {
    const m = make();
    for (const id of [1, 2, 3, 4]) m.join(id, `friend_${id}`, false, { party: 'P1', team: 'red' });
    m.join(5, 'solo_five', false, { team: 'blue' });
    (m as unknown as { rebalance(): void }).rebalance();
    expect(teamsOf(m, [1, 2, 3, 4])).toEqual(['red', 'red', 'red', 'red']);
  });

  it('a party member left alone in the match is a solo player again', () => {
    const m = make();
    m.join(1, 'friend_one', false, { party: 'P1', team: 'red' });
    m.join(2, 'friend_two', false, { party: 'P1', team: 'red' });
    m.join(3, 'solo_three', false, { team: 'blue' });
    m.leave(2);
    m.join(4, 'solo_four', false, { team: 'red' });
    (m as unknown as { rebalance(): void }).rebalance();
    // red 2 (friend_one + solo_four), blue 1: already even
    expect(m.teamSize('red') + m.teamSize('blue')).toBe(3);
    m.join(5, 'solo_five', false, { team: 'red' });
    (m as unknown as { rebalance(): void }).rebalance();
    // red 3, blue 1 -> the latest joiner moves, even though friend_one is a (former) party member
    expect(Math.abs(m.teamSize('red') - m.teamSize('blue'))).toBeLessThanOrEqual(1);
  });
});

describe('Rooms.quickPlay for a party', () => {
  const dirs: string[] = [];
  const sets: Rooms[] = [];
  afterEach(() => {
    sets.splice(0).forEach((r) => r.shutdown());
    dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
  });
  function rooms(over: Partial<ConstructorParameters<typeof Rooms>[0]> = {}): Rooms {
    const dir = mkdtempSync(join(tmpdir(), 'bunk-partyrooms-'));
    dirs.push(dir);
    const r = new Rooms({ dataDir: dir, maxRooms: 40, maxPlayers: 8, motd: '', idleUnloadMs: 60_000, expireDays: 0, ...over });
    sets.push(r);
    return r;
  }
  let n = 0;
  const seats = (size: number): PartySeats => ({ key: `k${++n}`.padEnd(32, 'x'), party: `P${n}`, size, ttlMs: 45_000 });
  const connect = (r: Rooms, code: string, name: string, key?: string) => {
    const ws = new FakeSocket();
    r.get(code)!.server.accept(ws as unknown as WebSocket);
    ws.say({ t: 'hello', v: PROTOCOL_VERSION, name, ...(key ? { party: key } : {}) } satisfies ClientMessage);
    return ws;
  };
  const kicked = (ws: FakeSocket) => ws.sent.find((m): m is Extract<ServerMessage, { t: 'kick' }> => m.t === 'kick');
  const teamOf = (r: Rooms, code: string, name: string) => [...(r.get(code)!.server as unknown as { match: Match }).match.players.values()].find((p) => p.name === name)?.team;

  it('opens a lobby for a party when there is none, and holds its seats', () => {
    const r = rooms();
    const res = r.quickPlay('tdm', () => true, seats(4)) as { code: string; created: boolean };
    expect(res.created).toBe(true);
    expect(r.get(res.code)!.server.reservedSeats).toBe(4);
  });

  it('a second party and a solo go to the lobby that still has room, the others do not squeeze in', () => {
    const r = rooms();
    const a = r.quickPlay('tdm', () => true, seats(4)) as { code: string };
    const b = r.quickPlay('tdm', () => true, seats(4)) as { code: string; created: boolean };
    expect(b.code).toBe(a.code); // 4 + 4 = 8 seats, one team each
    const c = r.quickPlay('tdm', () => true, seats(2)) as { code: string; created: boolean };
    expect(c.created).toBe(true);
    expect(c.code).not.toBe(a.code);
    const solo = r.quickPlay('tdm', () => true) as { code: string };
    expect(solo.code).toBe(c.code);
  });

  it('a party that cannot fit one team of an existing lobby gets a lobby of its own', () => {
    const r = rooms();
    const first = r.quickPlay('tdm', () => true, seats(1)) as { code: string };
    connect(r, first.code, 'solo_one');
    const big = r.quickPlay('tdm', () => true, seats(5)) as { code: string; created: boolean };
    expect(big.created).toBe(true);
    expect(big.code).not.toBe(first.code);
  });

  it('a party bigger than the server\'s lobbies is refused', () => {
    const r = rooms({ maxPlayers: 4 });
    expect(r.quickPlay('tdm', () => true, seats(5))).toEqual({ error: 'toobig' });
  });

  it('respects the lobby creation limit like any quick play', () => {
    const r = rooms();
    expect(r.quickPlay('tdm', () => false, seats(2))).toEqual({ error: 'limited' });
  });

  it('every member lands in the lobby on the same team, and a solo who comes in between gets the other one', () => {
    const r = rooms();
    const s = seats(3);
    const { code } = r.quickPlay('tdm', () => true, s) as { code: string };
    const joiners = ['party_one', 'party_two', 'party_three'].map((name, i) => {
      const ws = connect(r, code, name, s.key);
      if (i === 0) connect(r, code, 'solo_pla'); // a stranger arrives between the party's members
      return ws;
    });
    for (const ws of joiners) expect(kicked(ws)).toBeUndefined();
    const teams = ['party_one', 'party_two', 'party_three'].map((nm) => teamOf(r, code, nm));
    expect(new Set(teams).size).toBe(1);
    expect(teamOf(r, code, 'solo_pla')).not.toBe(teams[0]);
    expect(r.get(code)!.server.reservedSeats).toBe(0);
  });

  it('strangers cannot take the seats held for a party, but can once the hold is released', () => {
    const r = rooms({ maxPlayers: 4 });
    const s = seats(3);
    const { code } = r.quickPlay('tdm', () => true, s) as { code: string };
    connect(r, code, 'solo_one');
    const late = connect(r, code, 'solo_two'); // 1 + 3 held + this one = 5 > 4
    expect(kicked(late)?.code).toBe('full');
    r.release(code, s.key);
    const ok = connect(r, code, 'solo_two');
    expect(kicked(ok)).toBeUndefined();
  });

  it('a wrong or foreign key gives no seat and no team', () => {
    const r = rooms({ maxPlayers: 4 });
    const s = seats(3);
    const { code } = r.quickPlay('tdm', () => true, s) as { code: string };
    connect(r, code, 'solo_one');
    const bad = connect(r, code, 'faker_one', 'nope'.padEnd(32, 'z'));
    expect(kicked(bad)?.code).toBe('full');
  });

  it('a party joins one particular lobby when it has room; a lobby with a password is refused', () => {
    const r = rooms();
    const code = r.create('Mine', undefined, undefined, { gameType: 'tdm', maxPlayers: 6 })!;
    expect(r.joinLobby(code, seats(3))).toEqual({ code });
    expect(r.joinLobby(code, seats(4))).toEqual({ error: 'no_room' });
    expect(r.joinLobby('ZZZZZZ', seats(2))).toEqual({ error: 'not_found' });
    const sandbox = r.create('Sand', 'survival', undefined, {})!;
    expect(r.joinLobby(sandbox, seats(2))).toEqual({ error: 'mode' });
    const locked = r.create('Pw', undefined, undefined, { gameType: 'tdm' }, { passwordHash: 'x' })!;
    expect(r.joinLobby(locked, seats(2))).toEqual({ error: 'locked' });
  });

  it('free for all gives the party seats but no team', () => {
    const r = rooms();
    const s = seats(3);
    const { code } = r.quickPlay('ffa', () => true, s) as { code: string };
    expect(r.get(code)!.server.reservedSeats).toBe(3);
    const ws = connect(r, code, 'party_one', s.key);
    expect(kicked(ws)).toBeUndefined();
    expect(teamOf(r, code, 'party_one')).toBe('');
  });
});

describe('bots make room for a party', () => {
  const clock: SimClock = { ms: 1_700_000_000_000 };
  const lobbies: SimLobby[] = [];
  beforeEach(() => { vi.spyOn(Date, 'now').mockImplementation(() => clock.ms); });
  afterEach(() => {
    lobbies.splice(0).forEach((l) => l.dispose());
    vi.restoreAllMocks();
  });

  const KEY = 'a'.repeat(32);
  function party(l: SimLobby, names: string[], key = KEY): FakeSocket[] {
    return names.map((name) => {
      const ws = new FakeSocket();
      l.server.accept(ws as unknown as WebSocket);
      ws.say({ t: 'hello', v: PROTOCOL_VERSION, name, party: key });
      l.humans.push(ws);
      return ws;
    });
  }

  it('a full quick play lobby (one person, the rest bots) still takes a party of three, all on one team', () => {
    const l = new SimLobby(clock, { gameType: 'tdm', map: 'classic', maxPlayers: 8, bots: { fill: 8, difficulty: 'easy' } });
    lobbies.push(l);
    l.join('Host_one');
    l.run(4);
    expect(l.bots.count).toBe(7);
    const held = l.server.reserve(KEY, 'PARTY1', 3, 45_000);
    expect(held).not.toBeNull();
    l.run(3);
    // the bots keep clear of the held seats
    expect(l.bots.count).toBe(4);
    const members = party(l, ['party_one', 'party_two', 'party_three']);
    l.run(1);
    for (const ws of members) expect(ws.sent.find((m) => m.t === 'kick')).toBeUndefined();
    const players = [...l.match.players.values()];
    const mates = players.filter((p) => p.name.startsWith('party_'));
    expect(mates).toHaveLength(3);
    expect(new Set(mates.map((p) => p.team)).size).toBe(1);
    expect(mates[0].team).toBe(held!.team);
    expect(players.filter((p) => !p.bot)).toHaveLength(4);
    // bots yield: the lobby never holds more than its seats
    expect(l.server.playerList().length).toBeLessThanOrEqual(8);
  });

  it('the bots come back to fill the seats when the party does not show up', () => {
    const l = new SimLobby(clock, { gameType: 'tdm', map: 'classic', maxPlayers: 8, bots: { fill: 8, difficulty: 'easy' } });
    lobbies.push(l);
    l.join('Host_one');
    l.run(3);
    l.server.reserve(KEY, 'PARTY1', 3, 10_000);
    l.run(3);
    expect(l.bots.count).toBe(4);
    l.run(10); // the hold runs out
    expect(l.bots.count).toBe(7);
  });
});
