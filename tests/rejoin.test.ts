import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebSocket } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from '../src/net/protocol';
import { weaponDef } from '../src/modes/Weapons';
import { GameServer } from '../server/GameServer';
import type { Match } from '../server/Match';
import { ProfileService } from '../server/progression/ProfileService';
import { MatchRecorder } from '../server/progression/MatchRecorder';

class FakeSocket extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  sent: ServerMessage[] = [];
  send(data: string) { this.sent.push(JSON.parse(data) as ServerMessage); }
  close() { this.readyState = 3; this.emit('close'); }
  terminate() { this.close(); }
  ping() { this.emit('pong'); }
  say(msg: ClientMessage) { this.emit('message', Buffer.from(JSON.stringify(msg)), false); }
  of<T extends ServerMessage['t']>(t: T): Extract<ServerMessage, { t: T }>[] {
    return this.sent.filter((m) => m.t === t) as Extract<ServerMessage, { t: T }>[];
  }
  get welcome() { return this.of('welcome')[0]; }
  get kick() { return this.of('kick')[0]; }
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

interface Opts { type?: 'tdm' | 'ffa' | 'gungame'; maxPlayers?: number; grace?: number; bots?: { fill: number } }

function setup(o: Opts = {}) {
  vi.useFakeTimers({ toFake: ['Date'], now: Date.UTC(2026, 9, 8, 12) });
  const data = mkdtempSync(join(tmpdir(), 'bunk-rejoin-'));
  dirs.push(data);
  const profiles = new ProfileService({ dataDir: data, maxProfiles: 100, secret: 'integration-test-secret-123' });
  services.push(profiles);
  const server = new GameServer({
    dataDir: join(data, 'room'), worldName: 'Arena', seed: '7', gameMode: 'survival', motd: '', maxPlayers: o.maxPlayers ?? 8, quiet: true,
    gameType: o.type ?? 'tdm', scoreLimit: 50, timeLimitSec: 600, profiles, rejoinGraceSec: o.grace ?? 120, ...(o.bots ? { bots: o.bots } : {}),
  });
  servers.push(server);
  const match = (server as unknown as { match: Match }).match;
  const connect = (name: string, hello: Partial<Extract<ClientMessage, { t: 'hello' }>> = {}) => {
    const ws = new FakeSocket();
    server.accept(ws as unknown as WebSocket);
    ws.say({ t: 'hello', v: PROTOCOL_VERSION, name, ...hello });
    return ws;
  };
  const tick = () => (server as unknown as { tick(): void }).tick();
  /** Moves the clock and lets the server tick once at the new time. */
  const later = (sec: number) => { vi.setSystemTime(Date.now() + sec * 1000); tick(); };
  /** Runs the server for `sec` seconds in ticks of 0.1 s (the match clock only follows ticks that are close together). */
  const run = (sec: number) => { for (let i = 0; i < Math.round(sec * 10); i++) { vi.setSystemTime(Date.now() + 100); tick(); } };
  return { data, profiles, server, match, connect, tick, later, run };
}

function goLive(match: Match): void {
  (match as unknown as { beginMatch(now: number): void }).beginMatch(Date.now() / 1000);
  expect(match.phase).toBe('live');
}

/** A kill through the real damage path; the victim is brought back right away. */
function kill(match: Match, killer: number, victim: number, head = false): void {
  const m = match as unknown as { applyDamage(k: unknown, v: unknown, amount: number, w: unknown, head: boolean, now: number): void };
  m.applyDamage(match.players.get(killer), match.players.get(victim), 500, weaponDef('rifle'), head, Date.now() / 1000);
  match.respawn(match.players.get(victim)!, Date.now() / 1000);
}

describe('rejoin: a dropped player gets the seat, score and class back', () => {
  it('restores team, kills, deaths and class for the player with the rejoin secret, once', () => {
    const { match, connect } = setup();
    const a = connect('alice');
    const b = connect('bobby');
    expect(a.welcome).toMatchObject({ rejoined: false, rejoinSec: 120 });
    const secret = a.welcome.rejoin!;
    expect(secret.length).toBeGreaterThanOrEqual(16);
    expect(b.welcome.rejoin).not.toBe(secret);
    goLive(match);
    a.say({ t: 'loadout', primary: 'smg', secondary: 'revolver', optic: 'iron', perk: 'ninja' });
    kill(match, 1, 2);
    kill(match, 1, 2);
    kill(match, 2, 1);
    const before = { ...match.players.get(1)! };

    a.close(); // the connection dropped: no goodbye
    expect(match.players.has(1)).toBe(false);
    expect(match.parked.has(1)).toBe(true);
    expect(b.of('leave').at(-1)).toMatchObject({ id: 1, name: 'alice' });

    const a2 = connect('alice', { rejoin: secret });
    expect(a2.welcome).toMatchObject({ id: 1, rejoined: true });
    expect(a2.welcome.rejoin).not.toBe(secret); // single use
    expect(match.parked.size).toBe(0);
    const back = match.players.get(1)!;
    expect(back).toMatchObject({ team: before.team, kills: 2, deaths: 1 });
    expect(back.next).toMatchObject({ primary: 'smg', perk: 'ninja' });
    expect(b.of('join').at(-1)).toMatchObject({ id: 1, name: 'alice' });
    expect(b.of('chat').at(-1)!.text).toContain('rejoined');
    // A fresh life: after the short wait they spawn at full health, with a full magazine.
    expect(a2.of('hp').at(-1)).toMatchObject({ health: 0 });
    vi.setSystemTime(Date.now() + 4000);
    (match as unknown as { tick(): void }).tick();
    expect(a2.of('spawn').at(-1)).toMatchObject({ health: 100, team: before.team });
    // The roster shows the score again.
    expect(a2.of('roster').at(-1)!.players.find((p) => p.name === 'alice')).toMatchObject({ kills: 2, deaths: 1 });
  });

  it('works with the identity key alone when the secret got lost, and with the signed profile token', () => {
    const { match, profiles, connect } = setup();
    const key = 'k'.repeat(32);
    const made = profiles.create('alice')!;
    const a = connect('alice', { key });
    connect('bobby');
    goLive(match);
    kill(match, 1, 2);
    a.close();
    const a2 = connect('alice', { key });
    expect(a2.welcome).toMatchObject({ id: 1, rejoined: true });
    expect(match.players.get(1)!.kills).toBe(1);

    // A profile player: the signed token is proof enough, even with nothing else stored in the browser.
    const c = connect('carol', { profile: made.token });
    goLive(match);
    kill(match, c.welcome.id, 2);
    c.close();
    const c2 = connect('carol', { profile: made.token });
    expect(c2.welcome).toMatchObject({ id: c.welcome.id, rejoined: true });
    expect(match.players.get(c.welcome.id)!.kills).toBe(1);
  });

  it('a rejoin secret cannot take another player\'s seat, another name, or a seat in another lobby', () => {
    const { match, connect } = setup();
    const other = setup();
    const a = connect('alice');
    connect('bobby');
    goLive(match);
    const secret = a.welcome.rejoin!;
    a.close();

    // Alice's secret under another name: a newcomer, and alice's seat is untouched.
    const mallory = connect('mallory', { rejoin: secret });
    expect(mallory.welcome).toMatchObject({ rejoined: false });
    expect(match.parked.has(1)).toBe(true);
    // Another browser claiming alice's name without the proof is refused while the seat is kept.
    const squatter = connect('alice', { rejoin: 'x'.repeat(24), key: 'z'.repeat(32) });
    expect(squatter.kick).toMatchObject({ code: 'identity' });
    expect(squatter.welcome).toBeUndefined();
    expect(match.parked.has(1)).toBe(true);
    // The same secret in a different game does nothing.
    const elsewhere = other.connect('alice', { rejoin: secret });
    expect(elsewhere.welcome).toMatchObject({ rejoined: false });
    // The rightful player still gets in.
    const a2 = connect('alice', { rejoin: secret });
    expect(a2.welcome).toMatchObject({ rejoined: true, id: 1 });
  });

  it('takes the seat over from a session that is still open (a reload that beat the server)', () => {
    const { match, connect } = setup();
    const a = connect('alice');
    connect('bobby');
    goLive(match);
    kill(match, 1, 2);
    const a2 = connect('alice', { rejoin: a.welcome.rejoin });
    expect(a.kick).toMatchObject({ reason: expect.stringContaining('another location') });
    expect(a2.welcome).toMatchObject({ id: 1, rejoined: true });
    expect(match.players.get(1)!.kills).toBe(1);
    expect(match.parked.size).toBe(0);
    expect(match.players.size).toBe(2);
  });

  it('does not keep anything when the player says goodbye, is kicked, or the feature is off', () => {
    const { match, server, connect } = setup();
    const a = connect('alice');
    const b = connect('bobby');
    const c = connect('carol');
    a.say({ t: 'bye' });
    expect(match.parked.size).toBe(0);
    expect(connect('alice').welcome.rejoined).toBe(false); // the name is free again at once
    expect(server.kickPlayer('bobby', 'misbehaving')).toBe(true);
    expect(b.kick).toMatchObject({ reason: 'misbehaving' });
    expect(match.parked.size).toBe(0);
    c.close();
    expect(match.parked.size).toBe(1);

    const off = setup({ grace: 0 });
    const d = off.connect('dave');
    expect(d.welcome.rejoin).toBeUndefined();
    d.close();
    expect(off.match.parked.size).toBe(0);
  });

  it('a lag kick keeps the seat and tells the client to come back; a cheat kick does not', () => {
    const { match, server, connect } = setup();
    const a = connect('alice');
    const b = connect('bobby');
    const kickSession = (name: string, lag: boolean) => {
      const s = [...(server as unknown as { sessions: Map<number, unknown> }).sessions.values()].find((x) => (x as { name: string }).name === name);
      (server as unknown as { kickSession(s: unknown, reason: string, lag: boolean): void }).kickSession(s, 'test', lag);
    };
    kickSession('alice', true);
    expect(a.kick).toMatchObject({ reconnect: 1500 });
    expect(match.parked.has(1)).toBe(true);
    kickSession('bobby', false);
    expect(b.kick.reconnect).toBeUndefined();
    expect(match.parked.has(2)).toBe(false);
  });
});

describe('rejoin: seats stay taken during the grace period', () => {
  it('a full lobby does not give a dropped player\'s seat to somebody else', () => {
    const { match, connect, later } = setup({ maxPlayers: 2 });
    const a = connect('alice');
    const b = connect('bobby');
    const secret = b.welcome.rejoin!;
    b.close();
    const c = connect('carol');
    expect(c.kick).toMatchObject({ code: 'full' });
    expect(a.of('chat').some((m) => m.text.includes('carol'))).toBe(false);
    const b2 = connect('bobby', { rejoin: secret });
    expect(b2.welcome).toMatchObject({ rejoined: true });
    expect(match.players.size).toBe(2);
    // Once the seat has run out, the next player can have it.
    b2.close();
    expect(connect('dave').kick).toMatchObject({ code: 'full' });
    later(121);
    expect(match.parked.size).toBe(0);
    expect(connect('dave').welcome).toBeDefined();
  });

  it('bots do not fill a kept seat, and make room for a person who needs a seat', () => {
    const { match, server, connect, tick, later } = setup({ maxPlayers: 6, bots: { fill: 6 } });
    const a = connect('alice');
    const b = connect('bobby');
    for (let i = 0; i < 60; i++) { vi.setSystemTime(Date.now() + 100); tick(); }
    expect(server.botCount).toBe(4);
    expect(match.players.size).toBe(6);
    const secret = b.welcome.rejoin!;
    b.close();
    for (let i = 0; i < 60; i++) { vi.setSystemTime(Date.now() + 100); tick(); }
    // Bobby's seat is held: five people-or-bots play, one seat waits.
    expect(match.parked.size).toBe(1);
    expect(match.players.size).toBe(5);
    const b2 = connect('bobby', { rejoin: secret });
    expect(b2.welcome).toMatchObject({ rejoined: true });
    expect(match.players.size).toBe(6);
    expect(a.welcome).toBeDefined();
    // A newcomer to a lobby of bots and people pushes a bot out; a kept seat is never the one that goes.
    b2.close();
    const c = connect('carol');
    expect(c.welcome).toBeDefined();
    expect(match.parked.size).toBe(1);
    later(1);
  });

  it('keeps the match standing while only kept seats are left, and starts over after they expire', () => {
    const { match, connect, run } = setup({ type: 'ffa' });
    const a = connect('alice');
    const b = connect('bobby');
    goLive(match);
    kill(match, 1, 2);
    const left = match.timeLeft();
    a.close();
    b.close();
    run(60);
    expect(match.phase).toBe('live');
    expect(Math.abs(match.timeLeft() - left)).toBeLessThanOrEqual(1);
    const a2 = connect('alice', { rejoin: a.welcome.rejoin });
    expect(a2.welcome.rejoined).toBe(true);
    expect(match.players.get(1)!.kills).toBe(1);
    expect(match.phase).toBe('live');
    a2.close();
    run(125);
    expect(match.parked.size).toBe(0);
    expect(match.phase).toBe('warmup');
  });
});

describe('rejoin and XP', () => {
  it('pays a seat that expires like a leaver (kills so far, no completion bonus), and only once', () => {
    const { match, profiles, connect, later } = setup({ type: 'ffa' });
    const made = profiles.create('alice')!;
    const a = connect('alice', { profile: made.token });
    connect('bobby');
    goLive(match);
    kill(match, 1, 2);
    kill(match, 1, 2);
    a.close();
    const p = profiles.get(profiles.verify(made.token)!)!;
    expect(p.xp).toBe(0); // nothing yet: she may come back
    later(121);
    expect(p.xp).toBe(200);
    expect(p.stats.matches).toBe(0);
    expect(p.recent[0]).toMatchObject({ result: 'loss', kills: 2 });
    // A later end of the match does not pay the same tally again.
    match.endMatch();
    later(1);
    expect(p.xp).toBe(200);
    expect(p.recent).toHaveLength(1);
  });

  it('a match that ends while the player is away still pays them, once, and the report is waiting when they are back', () => {
    const { match, profiles, connect, later, run } = setup({ type: 'ffa' });
    const made = profiles.create('alice')!;
    const a = connect('alice', { profile: made.token });
    const bob = profiles.create('bobby')!;
    connect('bobby', { profile: bob.token });
    goLive(match);
    kill(match, 1, 2);
    kill(match, 1, 2);
    kill(match, 1, 2);
    kill(match, 2, 1);
    run(20); // 20 s played
    a.close();
    run(70); // gone for 70 s: not time played
    match.endMatch();
    const p = profiles.get(profiles.verify(made.token)!)!;
    expect(p.xp).toBeGreaterThanOrEqual(300);
    const paid = p.xp;
    expect(p.recent).toHaveLength(1);
    // Not there when it ended: the standings are decided among the people present.
    expect(p.recent[0]).toMatchObject({ result: 'loss', kills: 3 });
    expect(p.stats.matches).toBe(0); // 20 s is not a completed match: the away time did not count

    // Back before the seat runs out: they land in the lobby, the report is delivered, nothing is paid twice.
    const a2 = connect('alice', { profile: made.token });
    expect(a2.welcome.rejoined).toBe(true);
    const reports = a2.of('progress');
    expect(reports).toHaveLength(1);
    expect(reports[0].report.xp).toBe(paid);
    later(120);
    later(1);
    a2.say({ t: 'bye' });
    expect(p.xp).toBeGreaterThanOrEqual(paid);
    expect(p.recent.filter((r) => r.kills === 3)).toHaveLength(1);
  });

  it('a player whose seat ran out while the match ended still gets the report on their next visit', () => {
    const { match, profiles, connect, later } = setup({ type: 'ffa' });
    const made = profiles.create('alice')!;
    const a = connect('alice', { profile: made.token });
    connect('bobby');
    goLive(match);
    kill(match, 1, 2);
    a.close();
    match.endMatch();
    later(125);
    const p = profiles.get(profiles.verify(made.token)!)!;
    const paid = p.xp;
    expect(paid).toBeGreaterThan(0);
    const a2 = connect('alice', { profile: made.token });
    expect(a2.welcome.rejoined).toBe(false);
    expect(a2.of('progress')).toHaveLength(1);
    expect(p.xp).toBe(paid);
  });

  it('shutting the game down pays the kept seats too', () => {
    const { match, server, profiles, connect } = setup({ type: 'ffa' });
    const made = profiles.create('alice')!;
    const a = connect('alice', { profile: made.token });
    connect('bobby');
    goLive(match);
    kill(match, 1, 2);
    a.close();
    server.shutdown();
    expect(profiles.get(profiles.verify(made.token)!)!.xp).toBe(100);
  });
});

describe('MatchRecorder: time away is not time played', () => {
  it('stops the clock while paused and keeps the tally', () => {
    const rec = new MatchRecorder();
    rec.start([1, 2], 0);
    rec.kill(1, 2, 'rifle', false, 5);
    rec.pause(1, 30);
    rec.resume(1, 90); // 60 s away
    const taken = rec.take(1, 100)!;
    expect(taken.tally.kills).toBe(1);
    expect(taken.tally.seconds).toBe(40);
    // Taken while still away: the clock stopped when the connection dropped.
    rec.pause(2, 10);
    expect(rec.take(2, 500)!.tally.seconds).toBe(10);
    expect(rec.take(2, 500)).toBeNull();
  });
});
