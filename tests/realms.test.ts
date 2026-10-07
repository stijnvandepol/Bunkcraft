import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { getMap, voteChoices } from '../src/modes/maps';
import {
  LOBBY_SIZES, type LobbyCandidate, NEAR_END_PROGRESS, NEAR_END_SECONDS, REALMS_MODES, filterRooms, joinable, lobbySizes, parseListingKind, pickLobby, quickPlayName,
} from '../src/modes/Realms';
import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from '../src/net/protocol';
import { Rooms } from '../server/Rooms';
import { ENDED_SECONDS, Match, type MatchHost, VOTE_SECONDS, WARMUP_SECONDS, tallyVotes } from '../server/Match';

const lobby = (code: string, over: Partial<LobbyCandidate> = {}): LobbyCandidate => ({
  code, gameType: 'tdm', players: 0, maxPlayers: 8, open: true, ...over,
});

describe('Realms matchmaking: pickLobby', () => {
  it('lists every arcade mode in the playlist, and not Minecraft', () => {
    expect(REALMS_MODES).toEqual(['tdm', 'ffa', 'gungame', 'elimination', 'hardpoint', 'domination', 'ctf']);
  });

  it('returns null when there is no lobby of the mode (create a new one)', () => {
    expect(pickLobby([], 'tdm')).toBeNull();
    expect(pickLobby([lobby('AAAAAA', { gameType: 'ffa', players: 3 })], 'tdm')).toBeNull();
  });

  it('joins the fullest lobby that still has room', () => {
    const pick = pickLobby([
      lobby('AAAAAA', { players: 2, phase: 'live', timeLeft: 400 }),
      lobby('BBBBBB', { players: 5, phase: 'live', timeLeft: 400 }),
      lobby('CCCCCC', { players: 8, phase: 'warmup' }), // full
    ], 'tdm');
    expect(pick?.code).toBe('BBBBBB');
  });

  it('skips private, password-protected and full lobbies', () => {
    expect(pickLobby([lobby('AAAAAA', { players: 3, open: false })], 'tdm')).toBeNull();
    expect(pickLobby([lobby('AAAAAA', { players: 8, maxPlayers: 8 })], 'tdm')).toBeNull();
    expect(joinable(lobby('AAAAAA', { players: 7, maxPlayers: 8 }), 'tdm')).toBe(true);
  });

  it('skips a match that is about to end (clock or score), but not one between matches', () => {
    const late = lobby('AAAAAA', { players: 6, phase: 'live', timeLeft: NEAR_END_SECONDS - 1 });
    const close = lobby('BBBBBB', { players: 6, phase: 'live', timeLeft: 500, progress: NEAR_END_PROGRESS });
    const ended = lobby('CCCCCC', { players: 4, phase: 'ended', timeLeft: 5, progress: 1 });
    const fine = lobby('DDDDDD', { players: 2, phase: 'live', timeLeft: 300, progress: 0.3 });
    expect(joinable(late, 'tdm')).toBe(false);
    expect(joinable(close, 'tdm')).toBe(false);
    expect(joinable(ended, 'tdm')).toBe(true);
    expect(pickLobby([late, close, fine], 'tdm')?.code).toBe('DDDDDD');
    expect(pickLobby([late, close, ended, fine], 'tdm')?.code).toBe('CCCCCC');
  });

  it('ignores the round clock in round-based modes (elimination rounds are short)', () => {
    expect(joinable(lobby('AAAAAA', { gameType: 'elimination', players: 4, phase: 'live', timeLeft: 20, progress: 0.25 }), 'elimination')).toBe(true);
    expect(joinable(lobby('AAAAAA', { gameType: 'elimination', players: 4, phase: 'live', timeLeft: 20, progress: 0.75 }), 'elimination')).toBe(true);
    expect(joinable(lobby('AAAAAA', { gameType: 'elimination', players: 4, phase: 'roundend', progress: 0.8 }), 'elimination')).toBe(false);
  });

  it('prefers a lobby in warm-up over a running one of the same size, then the lowest code', () => {
    const pick = pickLobby([
      lobby('BBBBBB', { players: 3, phase: 'live', timeLeft: 500 }),
      lobby('CCCCCC', { players: 3, phase: 'warmup' }),
    ], 'tdm');
    expect(pick?.code).toBe('CCCCCC');
    expect(pickLobby([lobby('ZZZZZZ'), lobby('AAAAAA')], 'tdm')?.code).toBe('AAAAAA');
  });

  it('names quick play lobbies after the mode and the code', () => {
    expect(quickPlayName('tdm', 'K7QM2X')).toBe('Team Deathmatch #K7Q');
  });
});

describe('Realms lobby sizes', () => {
  it('offers only sizes the server allows (ROOM_MAX_PLAYERS), all of them when unknown', () => {
    expect(lobbySizes(8)).toEqual([2, 4, 6, 8]);
    expect(lobbySizes(16)).toEqual(LOBBY_SIZES);
    expect(lobbySizes(20)).toEqual(LOBBY_SIZES);
    expect(lobbySizes(9)).toEqual([2, 4, 6, 8]);
    expect(lobbySizes(undefined)).toEqual(LOBBY_SIZES);
    expect(lobbySizes(1)).toEqual([2]);
  });
});

describe('Realms listing filter', () => {
  const rooms = [
    { code: 'A', gameType: 'minecraft' as const },
    { code: 'B', gameType: 'tdm' as const },
    { code: 'C' }, // an older server: no game type = Minecraft
    { code: 'D', gameType: 'ctf' as const },
  ];

  it('keeps Minecraft games for Multiplayer and arcade lobbies for Realms', () => {
    expect(filterRooms(rooms, 'minecraft').map((r) => r.code)).toEqual(['A', 'C']);
    expect(filterRooms(rooms, 'arcade').map((r) => r.code)).toEqual(['B', 'D']);
    expect(filterRooms(rooms, null).map((r) => r.code)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('parses the kind parameter strictly', () => {
    expect(parseListingKind('arcade')).toBe('arcade');
    expect(parseListingKind('minecraft')).toBe('minecraft');
    expect(parseListingKind('ARCADE')).toBeNull();
    expect(parseListingKind(null)).toBeNull();
  });
});

describe('map vote', () => {
  it('offers the rotation pick first and two other maps the mode can use', () => {
    const opts = voteChoices('classic', undefined, () => 0);
    expect(opts).toHaveLength(3);
    expect(new Set(opts).size).toBe(3);
    expect(opts).not.toContain('classic');
    const ctf = voteChoices('atomic', ['flags'], Math.random);
    for (const id of ctf) expect(getMap(id).supports(['flags'])).toBe(true);
  });

  it('tallies votes: most votes win, a tie goes to the first option', () => {
    expect(tallyVotes(3, [])).toBe(0);
    expect(tallyVotes(3, [2, 2, 1])).toBe(2);
    expect(tallyVotes(3, [1, 2])).toBe(1);
    expect(tallyVotes(3, [5, -1, 2])).toBe(2);
  });
});

// ---------------------------------------------------------------- rooms: quick play and listing

class FakeSocket extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  sent: ServerMessage[] = [];
  send(data: string) { this.sent.push(JSON.parse(data) as ServerMessage); }
  close() { this.readyState = 3; }
  ping() { this.emit('pong'); }
  say(msg: ClientMessage) { this.emit('message', Buffer.from(JSON.stringify(msg)), false); }
}

const dirs: string[] = [];
const roomSets: Rooms[] = [];
afterEach(() => {
  roomSets.splice(0).forEach((r) => r.shutdown());
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

function rooms(maxPlayers = 8): Rooms {
  const dir = mkdtempSync(join(tmpdir(), 'bunk-realms-'));
  dirs.push(dir);
  const r = new Rooms({ dataDir: dir, maxRooms: 20, maxPlayers, motd: '', idleUnloadMs: 60_000, expireDays: 0 });
  roomSets.push(r);
  return r;
}

function enter(r: Rooms, code: string, name: string): FakeSocket {
  const ws = new FakeSocket();
  r.get(code)!.server.accept(ws as unknown as WebSocket);
  ws.say({ t: 'hello', v: PROTOCOL_VERSION, name });
  return ws;
}

describe('Rooms quick play', () => {
  it('opens a public rotating lobby when there is none, then sends the next player into it', () => {
    const r = rooms();
    let creates = 0;
    const first = r.quickPlay('tdm', () => { creates++; return true; });
    expect(first).toMatchObject({ created: true });
    const code = (first as { code: string }).code;
    expect(r.info(code)).toMatchObject({ gameType: 'tdm', map: 'rotate', name: quickPlayName('tdm', code) });
    enter(r, code, 'alice');
    const second = r.quickPlay('tdm', () => { creates++; return true; });
    expect(second).toEqual({ code, created: false });
    expect(creates).toBe(1);
    // Another mode gets its own lobby.
    expect(r.quickPlay('ffa', () => true)).toMatchObject({ created: true });
  });

  it('skips a listed lobby whose files are gone instead of sending everyone to "Game not found"', () => {
    const r = rooms();
    const { code } = r.quickPlay('gungame', () => true) as { code: string };
    r.close(code, false); // unloaded, still listed
    rmSync(join(dirs.at(-1)!, code), { recursive: true, force: true });
    const next = r.quickPlay('gungame', () => true) as { code: string; created: boolean };
    expect(next.code).not.toBe(code);
    expect(next.created).toBe(true);
    expect(r.info(next.code)).toMatchObject({ gameType: 'gungame' });
  });

  it('starts new lobbies on a random map the mode can be played on', () => {
    const r = rooms();
    const seen = new Set<string>();
    for (let i = 0; i < 12; i++) {
      const { code } = r.quickPlay('ctf', () => true) as { code: string };
      const map = r.get(code)!.server.lobbyStatus()!.map;
      expect(getMap(map).supports(['flags'])).toBe(true);
      seen.add(map);
      r.close(code, true); // no players: the next quick play would otherwise join this lobby
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it('does not create a lobby when the creation limit says no', () => {
    expect(rooms().quickPlay('tdm', () => false)).toEqual({ error: 'limited' });
  });

  it('never matches into private or password lobbies, and refuses Minecraft', () => {
    const r = rooms();
    const priv = r.create('Private', undefined, undefined, { gameType: 'tdm' })!;
    const locked = r.create('Locked', undefined, undefined, { gameType: 'tdm' }, { listed: true, passwordHash: 'x' })!;
    enter(r, priv, 'alice');
    const res = r.quickPlay('tdm', () => true) as { code: string; created: boolean };
    expect(res.created).toBe(true);
    expect([priv, locked]).not.toContain(res.code);
    expect(r.quickPlay('minecraft', () => true)).toEqual({ error: 'full' });
  });

  it('lists Minecraft games and arcade lobbies separately, with the live phase of busy lobbies', () => {
    const r = rooms();
    const mc = r.create('Build', 'creative', '1', {}, { listed: true })!;
    const arena = r.create('Arena', undefined, undefined, { gameType: 'tdm', mapId: 'atomic' }, { listed: true })!;
    enter(r, arena, 'alice');
    expect(r.listPublic('minecraft').map((x) => x.code)).toEqual([mc]);
    const arcade = r.listPublic('arcade');
    expect(arcade.map((x) => x.code)).toEqual([arena]);
    expect(arcade[0]).toMatchObject({ gameType: 'tdm', players: 1, phase: 'warmup', currentMap: 'atomic' });
    expect(r.listPublic().length).toBe(2);
  });

  it('counts players and public lobbies per mode', () => {
    const r = rooms();
    const a = r.create('A', undefined, undefined, { gameType: 'ctf' }, { listed: true })!;
    const b = r.create('B', undefined, undefined, { gameType: 'ctf' })!;
    enter(r, a, 'alice');
    enter(r, a, 'bob');
    enter(r, b, 'carol');
    const ctf = r.modeStats().find((m) => m.gameType === 'ctf');
    expect(ctf).toEqual({ gameType: 'ctf', players: 3, lobbies: 1 });
    expect(r.modeStats().map((m) => m.gameType)).toEqual(REALMS_MODES);
  });

  it('open lobbies keep no names: a name is only taken while it plays', () => {
    const r = rooms();
    const { code } = r.quickPlay('tdm', () => true) as { code: string };
    const hello = (name: string, key: string) => {
      const ws = new FakeSocket();
      r.get(code)!.server.accept(ws as unknown as WebSocket);
      ws.say({ t: 'hello', v: PROTOCOL_VERSION, name, key });
      return ws;
    };
    const a = hello('alice', 'a'.repeat(32));
    expect(a.sent.some((m) => m.t === 'welcome')).toBe(true);
    // A stranger with the same name cannot kick the player out...
    const b = hello('alice', 'b'.repeat(32));
    expect(b.sent.find((m) => m.t === 'kick')).toMatchObject({ code: 'identity' });
    expect(a.sent.some((m) => m.t === 'kick')).toBe(false);
    // ... but once alice left, the name is free for another browser (nothing was claimed for good).
    a.emit('close');
    const c = hello('alice', 'c'.repeat(32));
    expect(c.sent.some((m) => m.t === 'welcome')).toBe(true);
  });

  it('wires the map vote through the game server: rotating lobbies vote, fixed maps do not', () => {
    const r = rooms();
    const { code } = r.quickPlay('tdm', () => true) as { code: string };
    const a = enter(r, code, 'alice');
    const b = enter(r, code, 'bob');
    const server = r.get(code)!.server as unknown as { match: Match };
    server.match.endMatch();
    const offer = a.sent.filter((m) => m.t === 'vote').at(-1) as Extract<ServerMessage, { t: 'vote' }>;
    expect(offer.options).toHaveLength(3);
    for (const id of offer.options) expect(getMap(id).supports(undefined)).toBe(true);
    b.say({ t: 'vote', map: 1 });
    expect(a.sent.filter((m) => m.t === 'vote').at(-1)).toMatchObject({ counts: [0, 1, 0] });
    expect(b.sent.filter((m) => m.t === 'vote').at(-1)).toMatchObject({ mine: 1 });

    const fixed = r.create('Fixed', undefined, undefined, { gameType: 'tdm', mapId: 'atomic' }, { listed: true })!;
    const c = enter(r, fixed, 'carol');
    enter(r, fixed, 'dave');
    (r.get(fixed)!.server as unknown as { match: Match }).match.endMatch();
    expect(c.sent.some((m) => m.t === 'vote')).toBe(false);
  });

  it('keeps a private lobby size, clamped to the server limit, across a restart', () => {
    const r = rooms(8);
    const small = r.create('Duel', undefined, undefined, { gameType: 'ffa', maxPlayers: 2 })!;
    const big = r.create('Huge', undefined, undefined, { gameType: 'ffa', maxPlayers: 64 })!;
    expect(r.info(small)?.maxPlayers).toBe(2);
    expect(r.info(big)?.maxPlayers).toBe(8);
    enter(r, small, 'alice');
    enter(r, small, 'bob');
    const third = enter(r, small, 'carol');
    expect(third.sent.find((m) => m.t === 'kick')).toMatchObject({ reason: 'The server is full' });
    const dir = dirs[dirs.length - 1];
    r.shutdown();
    expect(JSON.parse(readFileSync(join(dir, small, 'world.json'), 'utf8'))).toMatchObject({ maxPlayers: 2 });
    const r2 = new Rooms({ dataDir: dir, maxRooms: 20, maxPlayers: 8, motd: '', idleUnloadMs: 60_000, expireDays: 0 });
    roomSets.push(r2);
    expect(r2.info(small)?.maxPlayers).toBe(2);
  });
});

describe('Match map vote (server-authoritative)', () => {
  function voteMatch(rotating: boolean) {
    let t = 1000;
    const sent: { id: number; msg: ServerMessage }[] = [];
    const chosen: (string | undefined)[] = [];
    const host: MatchHost = {
      now: () => t,
      send: (id, msg) => sent.push({ id, msg }),
      broadcast: () => undefined,
      blocks: { getBlock: () => 0 },
      moveTo: () => undefined,
      random: () => 0.5,
      ping: () => 0,
      nextMap: (_cur, _req, preferred) => { chosen.push(preferred); return rotating ? preferred ?? null : null; },
      voteMaps: () => (rotating ? ['suburb', 'dockyard', 'desert'] : null),
    };
    const match = new Match(host, { type: 'tdm', scoreLimit: 30, timeLimitSec: 600, map: 'classic' });
    const advance = (sec: number) => { for (let s = 0; s < sec; s += 0.1) { t += 0.1; match.tick(); } };
    for (const [id, name] of [[1, 'alice'], [2, 'bob'], [3, 'carol']] as const) { match.join(id, name); match.ready(id); }
    advance(WARMUP_SECONDS + 0.5);
    expect(match.phase).toBe('live');
    return { match, sent, chosen, advance };
  }

  const lastVote = (sent: { id: number; msg: ServerMessage }[], id: number) =>
    sent.filter((s) => s.msg.t === 'vote' && s.id === id).at(-1)!.msg as Extract<ServerMessage, { t: 'vote' }>;

  it('offers three maps at the end, counts one vote per player and plays the winner next', () => {
    const { match, sent, chosen, advance } = voteMatch(true);
    match.endMatch();
    const offer = lastVote(sent, 1);
    expect(offer.options).toEqual(['suburb', 'dockyard', 'desert']);
    expect(offer.endsIn).toBe(ENDED_SECONDS + VOTE_SECONDS);
    expect(match.castVote(1, 2)).toBe(true);
    expect(match.castVote(2, 2)).toBe(true);
    expect(match.castVote(3, 0)).toBe(true);
    expect(match.castVote(3, 1)).toBe(true); // changing your mind replaces the vote
    expect(match.castVote(1, 7)).toBe(false);
    expect(lastVote(sent, 1)).toMatchObject({ counts: [0, 1, 2], mine: 2 });
    advance(ENDED_SECONDS + VOTE_SECONDS + 0.5);
    expect(match.phase).toBe('warmup');
    expect(chosen).toEqual(['desert']);
    expect(match.map.id).toBe('desert');
    expect(match.castVote(1, 0)).toBe(false); // no vote outside the break
  });

  it('has no vote on a fixed map and keeps the plain pause', () => {
    const { match, sent } = voteMatch(false);
    match.endMatch();
    expect(sent.some((s) => s.msg.t === 'vote')).toBe(false);
    expect(match.castVote(1, 0)).toBe(false);
    expect(match.timeLeft()).toBe(ENDED_SECONDS);
  });
});
