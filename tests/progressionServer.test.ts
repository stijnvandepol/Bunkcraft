import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebSocket } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from '../src/net/protocol';
import { weaponDef } from '../src/modes/Weapons';
import { parseRank } from '../src/modes/progression/Levels';
import { GameServer } from '../server/GameServer';
import type { Match } from '../server/Match';
import { ProfileService } from '../server/progression/ProfileService';
import { ProfileStore } from '../server/progression/ProfileStore';
import { cleanup, startTestServer, type TestServer } from './helpers/serverHarness';

class FakeSocket extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  sent: ServerMessage[] = [];
  send(data: string) { this.sent.push(JSON.parse(data) as ServerMessage); }
  close() { this.readyState = 3; }
  ping() { this.emit('pong'); }
  say(msg: ClientMessage) { this.emit('message', Buffer.from(JSON.stringify(msg)), false); }
  of<T extends ServerMessage['t']>(t: T): Extract<ServerMessage, { t: T }>[] {
    return this.sent.filter((m) => m.t === t) as Extract<ServerMessage, { t: T }>[];
  }
}

const dirs: string[] = [];
const servers: GameServer[] = [];
const services: ProfileService[] = [];
afterEach(() => {
  vi.useRealTimers();
  servers.splice(0).forEach((s) => s.shutdown());
  services.splice(0).forEach((s) => s.close());
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'bunk-progsrv-'));
  dirs.push(d);
  return d;
}

function setup(type: 'tdm' | 'ffa' = 'ffa') {
  const data = tmp();
  const profiles = new ProfileService({ dataDir: data, maxProfiles: 100, secret: 'integration-test-secret-123' });
  services.push(profiles);
  const server = new GameServer({
    dataDir: join(data, 'room'), worldName: 'Arena', seed: '7', gameMode: 'survival', motd: '', maxPlayers: 8, quiet: true,
    gameType: type, scoreLimit: 50, timeLimitSec: 600, profiles,
  });
  servers.push(server);
  const match = (server as unknown as { match: Match }).match;
  const connect = (name: string, profile?: string) => {
    const ws = new FakeSocket();
    server.accept(ws as unknown as WebSocket);
    ws.say({ t: 'hello', v: PROTOCOL_VERSION, name, ...(profile ? { profile } : {}) });
    return ws;
  };
  return { data, profiles, server, match, connect };
}

/** Puts the match live (warm-up over) the way Match.tick does. */
function goLive(match: Match): void {
  (match as unknown as { beginMatch(now: number): void }).beginMatch(Date.now() / 1000);
  expect(match.phase).toBe('live');
}

/** A kill through the real damage path (hit message, kill feed, mode logic, progression hooks). */
function kill(match: Match, killer: number, victim: number, head = false): void {
  const m = match as unknown as { applyDamage(k: unknown, v: unknown, amount: number, w: unknown, head: boolean, now: number): void };
  m.applyDamage(match.players.get(killer), match.players.get(victim), 500, weaponDef('rifle'), head, Date.now() / 1000);
}

describe('Realms progression on the server', () => {
  it('a finished match grants XP once, sends the report and persists it', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.UTC(2026, 9, 7, 12) });
    const { data, profiles, match, connect } = setup('ffa');
    const alice = profiles.create('alice')!;
    const bob = profiles.create('bobby')!;
    const a = connect('alice', alice.token);
    const b = connect('bobby', bob.token);
    const guest = connect('guest'); // no profile: plays, earns nothing
    expect(a.of('welcome')).toHaveLength(1);
    expect(guest.of('welcome')).toHaveLength(1);

    goLive(match);
    for (let i = 0; i < 3; i++) {
      kill(match, 1, 2, i === 0);
      match.respawn(match.players.get(2)!, Date.now() / 1000);
    }
    kill(match, 3, 1);
    vi.setSystemTime(Date.now() + 120_000); // long enough for the completion bonus
    match.endMatch();
    match.endMatch(); // a second end is ignored by Match
    (match as unknown as { phase: string }).phase = 'live';
    match.endMatch(); // even a forced second end: the tallies were handed over already

    expect(a.of('progress')).toHaveLength(1);
    expect(b.of('progress')).toHaveLength(1);
    expect(guest.of('progress')).toHaveLength(0);
    const rep = a.of('progress')[0].report;
    expect(rep.lines.find((l) => l.key === 'kills')).toMatchObject({ count: 3, xp: 300 });
    expect(rep.lines.find((l) => l.key === 'headshots')).toMatchObject({ count: 1 });
    expect(rep.lines.find((l) => l.key === 'completion')).toBeTruthy();
    expect(rep.before.level).toBe(1);
    expect(rep.after.xp).toBe(rep.xp);

    const pa = profiles.get(profiles.verify(alice.token)!)!;
    expect(pa.xp).toBe(rep.xp);
    expect(pa.stats).toMatchObject({ kills: 3, deaths: 1, headshots: 1, matches: 1 });
    expect(pa.weapons.rifle.kills).toBe(3);
    expect(pa.recent).toHaveLength(1);

    // The roster carries the new rank.
    const roster = a.of('roster').at(-1)!.players;
    expect(parseRank(roster.find((p) => p.name === 'alice')!.rk)).toEqual({ level: rep.after.level, prestige: 0 });
    expect(roster.find((p) => p.name === 'guest')!.rk).toBeUndefined();

    // Written to DATA_DIR/profiles and readable by a fresh store.
    profiles.flush();
    const disk = new ProfileStore({ dir: join(data, 'profiles'), maxProfiles: 100 });
    expect(disk.get(pa.id)!.xp).toBe(rep.xp);
    expect(disk.get(pa.id)!.stats.kills).toBe(3);
  });

  it('XP cannot come from the client, a forged token is ignored, and one profile counts once per lobby', () => {
    const { profiles, match, connect } = setup('ffa');
    const real = profiles.create('alice')!;
    const forged = `${real.token.slice(0, 30)}${real.token[30] === 'A' ? 'B' : 'A'}${real.token.slice(31)}`;
    connect('alice', real.token);
    const twin = connect('alice2', real.token); // the same profile in a second tab
    const faker = connect('faker', forged);
    faker.say({ t: 'progress', report: { xp: 1e9 } } as unknown as ClientMessage);
    faker.say({ t: 'xp', amount: 1e9 } as unknown as ClientMessage);
    goLive(match);
    kill(match, 2, 3);
    kill(match, 3, 1);
    match.endMatch();
    expect(twin.of('progress')).toHaveLength(0);
    expect(faker.of('progress')).toHaveLength(0);
    expect(profiles.store.count).toBe(1);
  });

  it('leaving a live match keeps the XP earned so far, without the completion bonus', () => {
    const { profiles, match, connect } = setup('ffa');
    const alice = profiles.create('alice')!;
    const a = connect('alice', alice.token);
    connect('bobby');
    goLive(match);
    kill(match, 1, 2);
    a.say({ t: 'bye' }); // leaving on purpose pays at once; a dropped connection waits for its rejoin (tests/rejoin.test.ts)
    const p = profiles.get(profiles.verify(alice.token)!)!;
    expect(p.xp).toBe(100);
    expect(p.stats.matches).toBe(0);
    expect(p.recent[0]).toMatchObject({ result: 'loss', kills: 1 });
  });

  it('Create-a-Class stays within the unlocks of the profile', () => {
    const { profiles, connect } = setup('tdm');
    const alice = profiles.create('alice')!;
    const a = connect('alice', alice.token);
    a.say({ t: 'loadout', primary: 'sniper', secondary: 'revolver', optic: 'scope', perk: 'suppressor' });
    expect(a.of('gear').at(-1)).toMatchObject({ primary: 'rifle', secondary: 'pistol', perk: 'none' });
    a.say({ t: 'loadout', primary: 'smg', secondary: 'pistol', optic: 'reddot', perk: 'extmag' });
    expect(a.of('gear').at(-1)).toMatchObject({ primary: 'smg', optic: 'reddot', perk: 'extmag' });
    // At level 20 everything is open.
    const p = profiles.get(profiles.verify(alice.token)!)!;
    p.xp = 1e6;
    a.say({ t: 'loadout', primary: 'sniper', secondary: 'revolver', optic: 'scope', perk: 'suppressor' });
    expect(a.of('gear').at(-1)).toMatchObject({ primary: 'sniper', secondary: 'revolver', perk: 'suppressor' });
  });
});

describe('profile HTTP API', () => {
  let t: TestServer | null = null;
  afterEach(async () => {
    if (t) { await t.stop(); cleanup(t.dir); t = null; }
  });

  const call = async (method: string, path: string, body?: unknown, token?: string) => {
    const res = await fetch(`${t!.base}${path}`, {
      method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };

  it('creates a profile once, reads it back with the token and refuses tampering', async () => {
    t = await startTestServer({ PROFILE_CREATE_LIMIT: '2' });
    const made = await call('POST', '/api/profile', { name: 'alice' });
    expect(made.status).toBe(201);
    const token = made.body.token as string;
    expect((made.body.profile as { name: string }).name).toBe('alice');
    expect((await call('GET', '/api/profile', undefined, token)).status).toBe(200);
    // Posting with a valid token returns the same profile instead of a new one.
    const again = await call('POST', '/api/profile', { name: 'alice' }, token);
    expect(again.status).toBe(200);
    expect((again.body.profile as { id: string }).id).toBe((made.body.profile as { id: string }).id);
    expect((await call('GET', '/api/profile', undefined, `${token}x`)).status).toBe(401);
    expect((await call('GET', '/api/profile')).status).toBe(401);
    // Locked cosmetics are refused, prestige needs the cap.
    expect((await call('POST', '/api/profile/equip', { title: 'legend' }, token)).status).toBe(409);
    expect((await call('POST', '/api/profile/prestige', {}, token)).status).toBe(409);
    expect((await call('POST', '/api/profile/equip', { title: 'recruit' }, token)).status).toBe(200);
    // Creation is rate limited per address.
    expect((await call('POST', '/api/profile', { name: 'bobby' })).status).toBe(201);
    expect((await call('POST', '/api/profile', { name: 'carol' })).status).toBe(429);
    expect((await call('GET', '/api/server')).body.features).toMatchObject({ profiles: true });
  });

  it('can be switched off', async () => {
    t = await startTestServer({ PROFILES: 'off' });
    expect((await call('POST', '/api/profile', { name: 'alice' })).status).toBe(404);
  });
});
