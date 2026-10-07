import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Rooms } from '../server/Rooms';
import type { GameType } from '../src/modes/GameTypes';
import type { MapSetting } from '../src/modes/maps';
import { SUSPICION } from '../server/anticheat/Suspicion';
import { metrics } from '../server/Metrics';
import { type SimClock, SimLobby } from './helpers/botServer';
import type { BotDifficulty } from '../server/bots/BotSkill';

/**
 * Bots play whole matches on the real server code (GameServer, Match, anti-cheat) on a simulated clock.
 * They must finish the match by its own rules and never trip the anti-cheat that honest players pass.
 */
const clock: SimClock = { ms: 1_700_000_000_000 };
const lobbies: SimLobby[] = [];
beforeEach(() => { vi.spyOn(Date, 'now').mockImplementation(() => clock.ms); });
afterEach(() => {
  lobbies.splice(0).forEach((l) => l.dispose());
  vi.restoreAllMocks();
});

interface Watch { cheats: string[]; teleports: number; origin: number; vector: number }

/** Counts every anti-cheat verdict against bots: movement corrections, rubber bands, replaced shot origins. */
function watch(l: SimLobby): Watch {
  const w: Watch = { cheats: [], teleports: 0, origin: 0, vector: 0 };
  const gs = l.server as unknown as { onCheat(s: { name: string; sink?: unknown }, r: { rule: string }): void };
  const orig = gs.onCheat.bind(gs);
  gs.onCheat = (s, r) => { if (s.sink) w.cheats.push(`${s.name}: ${r.rule}`); orig(s, r); };
  const cheat = metrics.cheat.bind(metrics);
  vi.spyOn(metrics, 'cheat').mockImplementation((rule: string) => {
    if (rule === 'origin') w.origin++;
    if (rule === 'aim-vector') w.vector++;
    cheat(rule);
  });
  return w;
}

function lobby(gameType: GameType, map: MapSetting, o: { scoreLimit?: number; timeLimitSec?: number; difficulty?: BotDifficulty; fill?: number; seed?: string } = {}): SimLobby {
  const l = new SimLobby(clock, {
    gameType, map, scoreLimit: o.scoreLimit, timeLimitSec: o.timeLimitSec ?? 600, seed: o.seed,
    bots: { fill: o.fill ?? 8, difficulty: o.difficulty ?? 'normal' },
  });
  lobbies.push(l);
  return l;
}

/** Runs until the match ends (or `limit` seconds pass); returns the seconds played. */
function playToEnd(l: SimLobby, limit: number): number {
  let t = 0;
  l.run(limit, 30, () => { t++; return l.match.phase === 'ended'; });
  return t / 30;
}

/** Movement violations the guard counted for bots (corrections, lag excuses included). */
function violations(l: SimLobby): number {
  const guard = (l.server as unknown as { guard: { violations(id: number): number } }).guard;
  let n = 0;
  for (const id of l.bots.bots.keys()) n += guard.violations(id);
  return n;
}

function suspicion(l: SimLobby): number {
  return Math.max(0, ...l.server.playerList().filter((p) => p.ip === 'bot').map((p) => p.suspicion ?? 0));
}

describe('bots play full matches', () => {
  it('fill a quick play lobby and finish a team deathmatch without a single anti-cheat flag', () => {
    const l = lobby('tdm', 'atomic', { scoreLimit: 25, difficulty: 'hard' });
    const w = watch(l);
    l.join('Tester');
    l.run(4);
    expect(l.bots.count).toBe(7);
    expect(l.match.teamSize('red')).toBe(4);
    expect(l.match.teamSize('blue')).toBe(4);
    const secs = playToEnd(l, 600);
    expect(l.match.phase).toBe('ended');
    expect(Math.max(l.match.scores.red, l.match.scores.blue)).toBe(25);
    expect(secs).toBeLessThan(600);
    expect(w.cheats).toEqual([]);
    expect(violations(l)).toBe(0);
    expect(w.origin).toBe(0);
    expect(w.vector).toBe(0);
    expect(suspicion(l)).toBeLessThan(SUSPICION.WARN_AT);
    // Bots are marked in the roster and by name.
    const roster = l.match.roster();
    expect(roster.filter((r) => r.bot).length).toBe(7);
    expect(roster.filter((r) => r.bot).every((r) => r.name.startsWith('[BOT] '))).toBe(true);
  });

  it('capture the flag: bots take flags home and win by captures', () => {
    const l = lobby('ctf', 'atomic', { scoreLimit: 2, difficulty: 'normal' });
    const w = watch(l);
    l.join('Tester');
    playToEnd(l, 600);
    expect(l.match.phase).toBe('ended');
    expect(Math.max(l.match.scores.red, l.match.scores.blue)).toBe(2);
    expect(w.cheats).toEqual([]);
    expect(w.origin).toBe(0);
    expect(suspicion(l)).toBeLessThan(SUSPICION.WARN_AT);
  });

  it('hardpoint and domination: bots score points by holding zones', () => {
    for (const type of ['hardpoint', 'domination'] as const) {
      const l = lobby(type, 'rotate', { scoreLimit: 500 });
      const w = watch(l);
      l.join('Tester');
      l.run(10 + 90);
      expect(l.match.phase, type).toBe('live');
      expect(l.match.scores.red + l.match.scores.blue, type).toBeGreaterThan(20);
      expect(w.cheats).toEqual([]);
    }
  });

  it('gun game: bots climb the ladder', () => {
    const l = lobby('gungame', 'classic', { difficulty: 'hard' });
    const w = watch(l);
    l.join('Tester');
    l.run(10 + 90);
    const top = Math.max(...[...l.match.players.values()].map((p) => p.pts));
    expect(top).toBeGreaterThanOrEqual(3);
    expect(w.cheats).toEqual([]);
  });

  it('every map: veteran bots move and fight for two minutes without a flag', () => {
    for (const map of ['classic', 'suburb', 'quarter', 'dockyard', 'desert', 'bunker', 'villa', 'yacht', 'town', 'station'] as const) {
      const l = lobby('ffa', map, { scoreLimit: 100, difficulty: 'veteran', fill: 6 });
      const w = watch(l);
      l.join('Tester');
      l.run(10 + 60);
      const kills = [...l.match.players.values()].reduce((s, p) => s + p.kills, 0);
      expect(kills, map).toBeGreaterThan(0);
      expect(w.cheats, map).toEqual([]);
      expect(violations(l), map).toBe(0);
      expect(w.origin, map).toBe(0);
      expect(suspicion(l), map).toBeLessThan(SUSPICION.WARN_AT);
      l.dispose();
      lobbies.splice(lobbies.indexOf(l), 1);
    }
  });
});

describe('the anti-cheat watch is live', () => {
  it('a bot that teleports is caught like a player (control for the zero-flag assertions above)', () => {
    const l = lobby('ffa', 'classic', { fill: 3 });
    const w = watch(l);
    l.join('Tester');
    l.run(3);
    const id = [...l.bots.bots.keys()][0];
    const p = l.match.players.get(id)!;
    const host = (l.bots as unknown as { host: { deliver(id: number, msg: unknown): void } }).host;
    host.deliver(id, { t: 'pos', x: p.x + 15, y: p.y, z: p.z, yaw: 0, pitch: 0, flags: 4, held: 0, step: 1e9 });
    expect(w.cheats.length).toBeGreaterThan(0);
    expect(violations(l)).toBeGreaterThan(0);
  });
});

describe('bot fill rules', () => {
  it('bots leave as people join, keep the teams even, and leave with the last person', () => {
    const l = lobby('tdm', 'atomic', { scoreLimit: 100, fill: 8 });
    const a = l.join('Alice');
    l.run(4);
    expect(l.bots.count).toBe(7);
    expect(l.server.playerCount).toBe(1);
    const others = ['Bob', 'Carol', 'Dave'].map((n) => { const ws = l.join(n); l.run(1.5); return ws; });
    expect(l.server.playerCount).toBe(4);
    expect(l.bots.count).toBe(4);
    expect(Math.abs(l.match.teamSize('red') - l.match.teamSize('blue'))).toBeLessThanOrEqual(1);
    for (const ws of others) l.leave(ws);
    l.run(4);
    expect(l.bots.count).toBe(7);
    expect(Math.abs(l.match.teamSize('red') - l.match.teamSize('blue'))).toBeLessThanOrEqual(1);
    l.leave(a);
    l.run(1);
    expect(l.bots.count).toBe(0);
    expect(l.match.players.size).toBe(0);
  });

  it('a person never finds a full lobby full of bots', () => {
    const l = new SimLobby(clock, { gameType: 'ffa', map: 'classic', maxPlayers: 4, bots: { fill: 4 } });
    lobbies.push(l);
    l.join('Alice');
    l.run(3);
    expect(l.bots.count).toBe(3);
    const b = l.join('Bob');
    expect(b.of('kick')).toEqual([]);
    expect(l.server.playerCount).toBe(2);
    expect(l.bots.count).toBe(2);
  });

  it('a private lobby keeps the host\'s bot count', () => {
    const l = new SimLobby(clock, { gameType: 'tdm', map: 'classic', maxPlayers: 8, bots: { count: 3, difficulty: 'easy' } });
    lobbies.push(l);
    l.join('Host');
    l.run(3);
    expect(l.bots.count).toBe(3);
    l.join('Friend');
    l.run(2);
    expect(l.bots.count).toBe(3);
  });
});

describe('bot settings of rooms', () => {
  it('quick play lobbies fill with bots, private lobbies keep the host\'s choice, sandbox games never get any', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bunk-botrooms-'));
    const rooms = new Rooms({ dataDir: dir, maxRooms: 20, maxPlayers: 12, motd: '', idleUnloadMs: 60_000, expireDays: 0, quickPlayBots: 8, quickPlayBotDifficulty: 'hard' });
    try {
      const q = rooms.quickPlay('tdm', () => true);
      expect('code' in q).toBe(true);
      const code = (q as { code: string }).code;
      expect(rooms.get(code)!.server.botSettings).toEqual({ fill: 8, difficulty: 'hard' });
      const priv = rooms.create('Mine', undefined, undefined, { gameType: 'ctf', maxPlayers: 6, bots: 9, botDifficulty: 'veteran' })!;
      expect(rooms.get(priv)!.server.botSettings).toEqual({ count: 5, difficulty: 'veteran' });
      const none = rooms.create('None', undefined, undefined, { gameType: 'ffa' })!;
      expect(rooms.get(none)!.server.botSettings).toBeNull();
      const mc = rooms.create('Sandbox', 'survival', undefined, { bots: 4 })!;
      expect(rooms.get(mc)!.server.botSettings).toBeNull();
      // Saved with the world: a reloaded lobby keeps its bots.
      rooms.shutdown();
      expect(JSON.parse(readFileSync(join(dir, priv, 'world.json'), 'utf8')).bots).toEqual({ count: 5, difficulty: 'veteran' });
    } finally {
      rooms.shutdown();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
