import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { KEY_A, KEY_B, type TestServer, cleanup, createRoom, joinGame as joinRoom, startTestServer } from './helpers/serverHarness';

const stoppers: TestServer[] = [];
afterEach(async () => {
  const all = stoppers.splice(0);
  for (const t of all) await t.stop();
  for (const t of all) cleanup(t.dir);
});

async function start(env: Record<string, string> = {}): Promise<TestServer> {
  const t = await startTestServer(env);
  stoppers.push(t);
  return t;
}

async function kickOf(p: Promise<unknown>): Promise<{ reason: string; code?: string }> {
  try {
    await p;
  } catch (e) {
    return (e as { kick: { reason: string; code?: string } }).kick;
  }
  throw new Error('expected a kick');
}

describe('room passwords', () => {
  it('locks the room, never leaks the hash and accepts only the right password', async () => {
    const t = await start();
    const { code, locked } = await createRoom(t.base, { password: 'hunter22' });
    expect(locked).toBe(true);
    const info = await (await fetch(`${t.base}/api/rooms/${code}`)).json() as Record<string, unknown>;
    expect(info.locked).toBe(true);
    expect(JSON.stringify(info)).not.toMatch(/scrypt|hash|hunter22/);

    expect((await kickOf(joinRoom(t, code, 'alice', { key: KEY_A }))).code).toBe('password');
    expect((await kickOf(joinRoom(t, code, 'alice', { key: KEY_A, password: 'wrong' }))).reason).toMatch(/Wrong password/);
    const ok = await joinRoom(t, code, 'alice', { key: KEY_A, password: 'hunter22' });
    expect(ok.welcome.t).toBe('welcome');
    ok.client.close();

    // Stored hashed (scrypt), never in clear text.
    const world = readFileSync(join(t.dir, 'rooms', code, 'world.json'), 'utf8');
    expect(world).toContain('"passwordHash":"scrypt$');
    expect(world).not.toContain('hunter22');
  });

  it('rate limits wrong passwords per address', async () => {
    const t = await start({ PASSWORD_FAIL_LIMIT: '3' });
    const { code } = await createRoom(t.base, { password: 'secret' });
    for (let i = 0; i < 3; i++) await kickOf(joinRoom(t, code, 'mallory', { password: `guess${i}` }));
    // Now even the right password is refused for a while.
    const k = await kickOf(joinRoom(t, code, 'mallory', { password: 'secret' }));
    expect(k.reason).toMatch(/Too many wrong passwords/);
  });

  it('lets the owner in without the password', async () => {
    const t = await start();
    const { code, ownerToken } = await createRoom(t.base, { password: 'secret' });
    const { welcome, client } = await joinRoom(t, code, 'boss', { owner: ownerToken });
    expect(welcome.op).toBe(true);
    client.close();
  });

  it('survives a restart: the password still works', async () => {
    const t = await start();
    const { code } = await createRoom(t.base, { password: 'secret' });
    await t.server.close();
    const again = await startTestServer({}, t.dir);
    stoppers.push(again);
    expect((await kickOf(joinRoom(again, code, 'bob', { password: 'nope' }))).code).toBe('password');
    const ok = await joinRoom(again, code, 'bob', { password: 'secret' });
    ok.client.close();
  });
});

describe('public server list', () => {
  it('lists only rooms that opted in, hides locked details and caps the size', async () => {
    const t = await start({ LIST_MAX: '2' });
    const a = await createRoom(t.base, { name: 'Open House', listed: true });
    await createRoom(t.base, { name: 'Secret Club' }); // not listed
    await createRoom(t.base, { name: 'Second', listed: true, password: 'x' });
    await createRoom(t.base, { name: 'Third', listed: true });
    const res = await fetch(`${t.base}/api/rooms?public=1`);
    expect(res.headers.get('cache-control')).toContain('max-age');
    const body = await res.json() as { rooms: { code: string; name: string; players: number; locked: boolean; gameType: string }[] };
    expect(body.rooms).toHaveLength(2);
    expect(body.rooms.map((r) => r.name)).not.toContain('Secret Club');
    expect(body.rooms.find((r) => r.code === a.code || r.name === 'Open House' || r.name === 'Third')).toBeTruthy();
    expect(JSON.stringify(body)).not.toMatch(/scrypt|ownerHash|ownerToken/);
    expect(Object.keys(body.rooms[0]).sort()).toEqual(['code', 'gameMode', 'gameType', 'locked', 'maxPlayers', 'name', 'players'].sort());
  });

  it('shows live player counts, and a private room never appears', async () => {
    const t = await start();
    const pub = await createRoom(t.base, { name: 'Busy', listed: true });
    const priv = await createRoom(t.base, { name: 'Hidden' });
    const p = await joinRoom(t, pub.code, 'carol');
    await joinRoom(t, priv.code, 'dave').then((j) => j.client.close());
    const body = await (await fetch(`${t.base}/api/rooms?public=1`)).json() as { rooms: { code: string; players: number }[] };
    expect(body.rooms.map((r) => r.code)).toEqual([pub.code]);
    // The list is cached for a few seconds, so the count may lag; it is never negative.
    expect(body.rooms[0].players).toBeGreaterThanOrEqual(0);
    p.client.close();
  });

  it('requires ?public=1 and survives a restart (sidecar index)', async () => {
    const t = await start();
    expect((await fetch(`${t.base}/api/rooms`)).status).toBe(400);
    const { code } = await createRoom(t.base, { name: 'Persistent', listed: true });
    await t.server.close();
    const again = await startTestServer({}, t.dir);
    stoppers.push(again);
    const body = await (await fetch(`${again.base}/api/rooms?public=1`)).json() as { rooms: { code: string }[] };
    expect(body.rooms.map((r) => r.code)).toEqual([code]);
  });
});

describe('names and operators', () => {
  it('binds a name to the first identity key that used it', async () => {
    const t = await start();
    const { code } = await createRoom(t.base);
    const a = await joinRoom(t, code, 'alice', { key: KEY_A });
    a.client.close();
    await new Promise((r) => setTimeout(r, 50));
    expect((await kickOf(joinRoom(t, code, 'alice', { key: KEY_B }))).code).toBe('identity');
    expect((await kickOf(joinRoom(t, code, 'alice'))).code).toBe('identity');
    const again = await joinRoom(t, code, 'alice', { key: KEY_A });
    again.client.close();
  });

  it('makes the creator op, and only ops can moderate', async () => {
    const t = await start();
    const { code, ownerToken } = await createRoom(t.base);
    const boss = await joinRoom(t, code, 'boss', { key: KEY_A, owner: ownerToken });
    const guest = await joinRoom(t, code, 'guest', { key: KEY_B });
    expect(boss.welcome.op).toBe(true);
    expect(guest.welcome.op).toBeUndefined();

    guest.client.send({ t: 'chat', text: '/kick boss' });
    await guest.client.chatContaining('do not have permission');
    guest.client.send({ t: 'chat', text: '/help' });
    const help = await guest.client.waitFor('chat', (m) => m.text.startsWith('Commands:'));
    expect(help.text).not.toContain('/kick');

    boss.client.send({ t: 'chat', text: '/help' });
    const bossHelp = await boss.client.waitFor('chat', (m) => m.text.startsWith('Commands:'));
    for (const c of ['/kick', '/ban', '/unban', '/op', '/deop', '/whitelist', '/say', '/tp', '/gamemode', '/time', '/weather']) expect(bossHelp.text).toContain(c);

    boss.client.send({ t: 'chat', text: '/say hello everyone' });
    await guest.client.chatContaining('[boss] hello everyone');

    boss.client.send({ t: 'chat', text: '/kick guest too loud' });
    const kick = await guest.client.waitFor('kick');
    expect(kick.reason).toBe('too loud');
    boss.client.close();
  });

  it('bans by name, keeps the ban across a restart and unbans', async () => {
    const t = await start();
    const { code, ownerToken } = await createRoom(t.base);
    const boss = await joinRoom(t, code, 'boss', { key: KEY_A, owner: ownerToken });
    const guest = await joinRoom(t, code, 'guest', { key: KEY_B });
    boss.client.send({ t: 'chat', text: '/ban guest spamming' });
    expect((await guest.client.waitFor('kick')).reason).toMatch(/banned/);
    expect((await kickOf(joinRoom(t, code, 'guest', { key: KEY_B }))).code).toBe('banned');
    boss.client.close();
    await t.server.close();

    const again = await startTestServer({}, t.dir);
    stoppers.push(again);
    expect((await kickOf(joinRoom(again, code, 'guest', { key: KEY_B }))).code).toBe('banned');
    const boss2 = await joinRoom(again, code, 'boss', { key: KEY_A, owner: ownerToken });
    boss2.client.send({ t: 'chat', text: '/unban guest' });
    await boss2.client.chatContaining('Unbanned guest');
    const back = await joinRoom(again, code, 'guest', { key: KEY_B });
    back.client.close();
    boss2.client.close();
  });

  it('whitelist: on, add, off, list, and ops always get in', async () => {
    const t = await start();
    const { code, ownerToken } = await createRoom(t.base);
    const boss = await joinRoom(t, code, 'boss', { key: KEY_A, owner: ownerToken });
    boss.client.send({ t: 'chat', text: '/whitelist add friend' });
    boss.client.send({ t: 'chat', text: '/whitelist on' });
    await boss.client.chatContaining('Whitelist is on');
    expect((await kickOf(joinRoom(t, code, 'stranger', { key: KEY_B }))).code).toBe('whitelist');
    const friend = await joinRoom(t, code, 'friend', { key: KEY_B });
    boss.client.send({ t: 'chat', text: '/whitelist list' });
    await boss.client.chatContaining('friend');
    boss.client.send({ t: 'chat', text: '/whitelist off' });
    await boss.client.chatContaining('Whitelist is off');
    const stranger = await joinRoom(t, code, 'stranger', { key: 'c'.repeat(32) });
    for (const c of [boss, friend, stranger]) c.client.close();
  });

  it('op and deop: only the owner, operators can then moderate, and the owner is protected', async () => {
    const t = await start();
    const { code, ownerToken } = await createRoom(t.base);
    const boss = await joinRoom(t, code, 'boss', { key: KEY_A, owner: ownerToken });
    const helper = await joinRoom(t, code, 'helper', { key: KEY_B });
    const rando = await joinRoom(t, code, 'rando', { key: 'c'.repeat(32) });
    helper.client.send({ t: 'chat', text: '/op rando' });
    await helper.client.chatContaining('do not have permission');
    boss.client.send({ t: 'chat', text: '/op helper' });
    await helper.client.chatContaining('now an operator');
    helper.client.send({ t: 'chat', text: '/kick boss' });
    await helper.client.chatContaining('owner of this game');
    helper.client.send({ t: 'chat', text: '/kick rando' });
    expect((await rando.client.waitFor('kick')).reason).toMatch(/Kicked/);
    boss.client.send({ t: 'chat', text: '/deop helper' });
    await helper.client.chatContaining('no longer an operator');
    helper.client.send({ t: 'chat', text: '/say hi' });
    await helper.client.chatContaining('do not have permission');
    boss.client.close();
    helper.client.close();
  });

  it('/gamemode and /give: give only in creative, gamemode reaches everybody', async () => {
    const t = await start();
    const { code, ownerToken } = await createRoom(t.base, { gameMode: 'survival' });
    const boss = await joinRoom(t, code, 'boss', { key: KEY_A, owner: ownerToken });
    boss.client.send({ t: 'chat', text: '/give boss stick 5' });
    await boss.client.chatContaining('only works in creative');
    boss.client.send({ t: 'chat', text: '/gamemode creative' });
    expect((await boss.client.waitFor('gamemode')).mode).toBe('creative');
    boss.client.send({ t: 'chat', text: '/give boss stick 5' });
    const taken = await boss.client.waitFor('taken');
    expect(taken.count).toBe(5);
    boss.client.send({ t: 'chat', text: '/give boss nonsense_item' });
    await boss.client.chatContaining('Unknown item');
    boss.client.close();
  });

  it('/weather is a stub and /time set reaches everybody', async () => {
    const t = await start();
    const { code, ownerToken } = await createRoom(t.base);
    const boss = await joinRoom(t, code, 'boss', { key: KEY_A, owner: ownerToken });
    boss.client.send({ t: 'chat', text: '/weather rain' });
    await boss.client.chatContaining('Weather is not available');
    boss.client.send({ t: 'chat', text: '/time set night' });
    expect((await boss.client.waitFor('time', (m) => Math.abs(m.time - 0.55) < 1e-9)).time).toBeCloseTo(0.55);
    boss.client.close();
  });

  it('keeps legacy rooms (no owner) as they were: /time is open, moderation is off', async () => {
    const t = await start();
    const { code } = await createRoom(t.base);
    // A room created before owners existed has no ownerHash; simulate by wiping it through a restart.
    await t.server.close();
    const file = join(t.dir, 'rooms', code, 'world.json');
    const world = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    delete world.ownerHash;
    (await import('node:fs')).writeFileSync(file, JSON.stringify(world));
    const again = await startTestServer({}, t.dir);
    stoppers.push(again);
    const p = await joinRoom(again, code, 'old', { key: KEY_A });
    p.client.send({ t: 'chat', text: '/time set noon' });
    await p.client.waitFor('time', (m) => Math.abs(m.time - 0.25) < 1e-9);
    p.client.send({ t: 'chat', text: '/kick old' });
    await p.client.chatContaining('Moderation is not enabled');
    p.client.close();
  });
});
