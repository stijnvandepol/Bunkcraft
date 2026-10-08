/**
 * Dropped connections over real WebSockets: an arcade player who disconnects mid-match comes back to the same lobby
 * with kills, score and level (and the rejoin offer says how long the seat is kept); a Build & Survival player
 * comes back with position and inventory, also when the server saves only moments after they left.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { weaponDef } from '../src/modes/Weapons';
import type { GameServer } from '../server/GameServer';
import type { Match } from '../server/Match';
import { KEY_A, KEY_B, type TestClient, type TestServer, cleanup, createRoom, joinGame, startTestServer } from './helpers/serverHarness';

let t: TestServer;
beforeAll(async () => { t = await startTestServer({ REJOIN_GRACE_SEC: '90' }); });
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

/** A kill through the real damage path (hit message, kill feed, mode logic, progression hooks). */
function kill(match: Match, killer: number, victim: number): void {
  const m = match as unknown as { applyDamage(k: unknown, v: unknown, amount: number, w: unknown, head: boolean, now: number): void };
  m.applyDamage(match.players.get(killer), match.players.get(victim), 500, weaponDef('rifle'), false, Date.now() / 1000);
  match.respawn(match.players.get(victim)!, Date.now() / 1000);
}

function goLive(match: Match): void {
  (match as unknown as { beginMatch(now: number): void }).beginMatch(Date.now() / 1000);
  expect(match.phase).toBe('live');
}

async function rejoinOffer(code: string, token: string | undefined): Promise<{ state: string; secondsLeft: number; name?: string; gameType?: string }> {
  const res = await fetch(`${t.base}/api/rejoin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, token }) });
  expect(res.status).toBe(200);
  return res.json() as Promise<{ state: string; secondsLeft: number; name?: string; gameType?: string }>;
}

describe('an arcade player who drops mid-match comes back to it', () => {
  it('team deathmatch: kills, score and team are restored, and the offer shows the seat is kept', async () => {
    const { code } = await createRoom(t.base, { gameType: 'tdm', scoreLimit: 50, timeLimitSec: 600 });
    const a = await joinGame(t, code, 'alice', { key: KEY_A });
    const b = await joinGame(t, code, 'bobby', { key: KEY_B });
    expect(a.welcome).toMatchObject({ rejoined: false, rejoinSec: 90 });
    const secret = a.welcome.rejoin!;
    const match = matchOf(code);
    goLive(match);
    kill(match, 1, 2);
    kill(match, 1, 2);
    kill(match, 2, 1);
    const team = match.players.get(1)!.team;
    const scores = { ...match.scores };

    a.client.close(); // closes the socket without a goodbye: the same thing a reload or a crash does
    await until(() => match.parked.has(1));
    await b.client.waitFor('leave', (m) => m.name === 'alice');
    const offer = await rejoinOffer(code, secret);
    expect(offer).toMatchObject({ state: 'kept', name: 'alice', gameType: 'tdm' });
    expect(offer.secondsLeft).toBeGreaterThan(80);
    expect(offer.secondsLeft).toBeLessThanOrEqual(90);
    expect(await rejoinOffer(code, 'w'.repeat(32))).toMatchObject({ state: 'none' });
    expect(await rejoinOffer(code, undefined)).toMatchObject({ state: 'none' });
    expect(await rejoinOffer('ZZZZZZ', secret)).toMatchObject({ state: 'none' });

    const a2 = await joinGame(t, code, 'alice', { key: KEY_A, rejoin: secret });
    expect(a2.welcome).toMatchObject({ id: a.welcome.id, rejoined: true, gameType: 'tdm' });
    expect(a2.welcome.rejoin).not.toBe(secret);
    expect(match.players.get(1)).toMatchObject({ team, kills: 2, deaths: 1 });
    expect(match.scores).toEqual(scores);
    const roster = await a2.client.waitFor('roster', (m) => m.players.some((p) => p.name === 'alice' && p.kills === 2));
    expect(roster.players.find((p) => p.name === 'alice')).toMatchObject({ kills: 2, deaths: 1, team });
    // The old secret is spent, and no seat is kept any more.
    expect(await rejoinOffer(code, secret)).toMatchObject({ state: 'none' });
    a2.client.close();
    b.client.close();
  });

  it('gun game: the level survives the drop, and so does the weapon that goes with it', async () => {
    const { code } = await createRoom(t.base, { gameType: 'gungame' });
    const a = await joinGame(t, code, 'alice', { key: KEY_A });
    const b = await joinGame(t, code, 'bobby', { key: KEY_B });
    const match = matchOf(code);
    goLive(match);
    kill(match, 1, 2);
    kill(match, 1, 2);
    kill(match, 1, 2);
    const level = match.players.get(1)!.pts;
    expect(level).toBeGreaterThanOrEqual(3);
    const weapon = match.players.get(1)!.primary;

    a.client.close();
    await until(() => match.parked.has(1));
    const a2 = await joinGame(t, code, 'alice', { key: KEY_A, rejoin: a.welcome.rejoin });
    expect(a2.welcome.rejoined).toBe(true);
    expect(match.players.get(1)!.pts).toBe(level);
    expect(match.players.get(1)!.primary).toBe(weapon);
    a2.client.close();
    b.client.close();
  });

  it('a stranger cannot use the rejoin offer or the secret to get in the seat; the seat times out', async () => {
    const { code } = await createRoom(t.base, { gameType: 'ffa' });
    const a = await joinGame(t, code, 'alice', { key: KEY_A });
    const b = await joinGame(t, code, 'bobby', { key: KEY_B });
    const match = matchOf(code);
    goLive(match);
    kill(match, 1, 2);
    const secret = a.welcome.rejoin!;
    a.client.close();
    await until(() => match.parked.has(1));
    // Somebody else, same name, no proof: refused. Somebody else with the secret under their own name: a newcomer.
    await expect(joinGame(t, code, 'alice', { key: 'q'.repeat(32) })).rejects.toMatchObject({ kick: { code: 'identity' } });
    const m = await joinGame(t, code, 'mallory', { key: 'm'.repeat(32), rejoin: secret });
    expect(m.welcome.rejoined).toBe(false);
    expect(match.parked.has(1)).toBe(true);
    expect(match.players.get(m.welcome.id)!.kills).toBe(0);
    m.client.close();
    // Time runs out: the seat is gone, and the secret is worth nothing.
    (match.parked.get(1) as { until: number }).until = Date.now() / 1000 - 1;
    await until(() => !match.parked.has(1));
    const late = await joinGame(t, code, 'alice', { key: KEY_A, rejoin: secret });
    expect(late.welcome.rejoined).toBe(false);
    late.client.close();
    b.client.close();
  });
});

describe('Build & Survival: a dropped player comes back with position and inventory', () => {
  const inv = (...stacks: number[][]): number[][] => [...stacks, ...Array.from({ length: 36 - stacks.length }, () => [0, 0, 0])];

  async function joinAt(code: string, key: string, name = 'alice'): Promise<{ client: TestClient; welcome: Awaited<ReturnType<typeof joinGame>>['welcome'] }> {
    return joinGame(t, code, name, { key });
  }

  it('restores them after a reload, and has it on disk shortly after they left', async () => {
    const { code } = await createRoom(t.base, { gameMode: 'creative' });
    const a = await joinAt(code, KEY_A);
    const sp = a.welcome.spawn;
    const spot = { x: sp.x + 3.5, y: sp.y, z: sp.z + 1.5 };
    a.client.send({ t: 'pos', x: spot.x, y: spot.y, z: spot.z, yaw: 1.25, pitch: -0.5, flags: 4, held: 3 });
    await sleep(100);
    a.client.send({ t: 'state', inventory: inv([4, 32, 0], [20, 5, 0]), stats: [14, 18, 5, 0] });
    await sleep(200);

    a.client.close();
    await until(() => (gameOf(code) as unknown as { sessions: Map<number, unknown> }).sessions.size === 0);
    const b = await joinAt(code, KEY_A);
    expect(b.welcome.player).toMatchObject({ x: spot.x, y: spot.y, z: spot.z, yaw: 1.25, pitch: -0.5, stats: [14, 18, 5, 0] });
    expect(b.welcome.player!.inventory![0]).toEqual([4, 32, 0]);
    expect(b.welcome.player!.inventory![1]).toEqual([20, 5, 0]);
    b.client.send({ t: 'pos', x: spot.x + 1, y: spot.y, z: spot.z, yaw: 0, pitch: 0, flags: 4, held: 0 });
    await sleep(100);
    b.client.close();

    // Written to world.json within moments of leaving, not only at the next 30 s save.
    const file = join(t.dir, 'rooms', code, 'world.json');
    await until(() => {
      const w = JSON.parse(readFileSync(file, 'utf8')) as { players: Record<string, { x: number }> };
      return w.players.alice?.x === spot.x + 1;
    }, 6000);
  });

  it('a reload that beats the server (the old socket still open) takes the same state over', async () => {
    const { code } = await createRoom(t.base, { gameMode: 'creative' });
    const a = await joinAt(code, KEY_A);
    const sp = a.welcome.spawn;
    a.client.send({ t: 'pos', x: sp.x + 2, y: sp.y, z: sp.z, yaw: 0.5, pitch: 0, flags: 4, held: 0 });
    await sleep(100);
    a.client.send({ t: 'state', inventory: inv([4, 7, 0]), stats: [20, 20, 5, 0] });
    await sleep(200);
    const b = await joinAt(code, KEY_A); // second connection, same player, the first one never closed
    expect(b.welcome.player).toMatchObject({ x: sp.x + 2, y: sp.y, z: sp.z, yaw: 0.5 });
    expect(b.welcome.player!.inventory![0]).toEqual([4, 7, 0]);
    await a.client.waitFor('kick', (m) => /another location/.test(m.reason));
    b.client.close();
  });
});
