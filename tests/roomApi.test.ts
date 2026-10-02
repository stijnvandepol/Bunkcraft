import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browseRooms, createRoom, identityKey, lookupRoom, ownerToken, roomPassword, setRoomPassword } from '../src/net/RoomApi';

/** Minimal localStorage and fetch stand-ins: the client helpers are DOM-free apart from these. */
function installStorage(): Map<string, string> {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v); },
    removeItem: (k: string) => { data.delete(k); },
  });
  return data;
}

function installFetch(handler: (path: string, init?: RequestInit) => { status?: number; body: unknown }): { calls: { path: string; init?: RequestInit }[] } {
  const calls: { path: string; init?: RequestInit }[] = [];
  vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    const r = handler(path, init);
    const status = r.status ?? 200;
    return { ok: status < 400, status, json: async () => r.body };
  });
  return { calls };
}

let storage: Map<string, string>;
beforeEach(() => { storage = installStorage(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('client room helpers', () => {
  it('createRoom sends the password and listing flag, and keeps the owner token the server returns once', async () => {
    const { calls } = installFetch(() => ({ status: 201, body: { code: 'K7QM2X', ownerToken: 'tok123', locked: true } }));
    const code = await createRoom('My Game', 'survival', '', { gameType: 'minecraft', scoreLimit: 0, timeLimitSec: 0, password: 'pw', listed: true });
    expect(code).toBe('K7QM2X');
    const sent = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>;
    expect(sent).toMatchObject({ password: 'pw', listed: true, name: 'My Game' });
    expect(ownerToken('K7QM2X')).toBe('tok123');
    expect(roomPassword('K7QM2X')).toBe('pw'); // the creator does not have to type it again
  });

  it('leaves password and listing out when not asked for', async () => {
    const { calls } = installFetch(() => ({ status: 201, body: { code: 'AAAAAA', ownerToken: 't' } }));
    await createRoom('Plain', 'creative', 'seed');
    const sent = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>;
    expect('password' in sent).toBe(false);
    expect('listed' in sent).toBe(false);
  });

  it('works against an older server that returns no owner token', async () => {
    installFetch(() => ({ status: 201, body: { code: 'BBBBBB' } }));
    await createRoom('Old', 'creative', '');
    expect(ownerToken('BBBBBB')).toBeUndefined();
  });

  it('lookupRoom reports locked games; browseRooms lists what the server returns', async () => {
    installFetch((path) => (path.includes('public=1')
      ? { body: { rooms: [{ code: 'CCCCCC', name: 'Open', gameMode: 'survival', players: 1, maxPlayers: 8, gameType: 'tdm', locked: false }] } }
      : { body: { code: 'DDDDDD', name: 'Locked', gameMode: 'survival', players: 0, maxPlayers: 8, locked: true } }));
    expect((await lookupRoom('DDDDDD')).locked).toBe(true);
    const list = await browseRooms();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ code: 'CCCCCC', gameType: 'tdm' });
  });

  it('browseRooms surfaces server errors', async () => {
    installFetch(() => ({ status: 404, body: { error: 'Games are disabled on this server' } }));
    await expect(browseRooms()).rejects.toThrow(/disabled/);
  });

  it('identity keys are random, stable per server and game, and different across them', () => {
    vi.stubGlobal('crypto', { getRandomValues: (a: Uint8Array) => a.map(() => Math.floor(Math.random() * 256)) });
    const a = identityKey('play.example.com', 'K7QM2X');
    expect(a).toMatch(/^[0-9a-f]{48}$/);
    expect(identityKey('play.example.com', 'K7QM2X')).toBe(a);
    expect(identityKey('play.example.com', 'OTHER2')).not.toBe(a);
    expect(identityKey('evil.example.net', 'K7QM2X')).not.toBe(a);
    expect([...storage.keys()].some((k) => k.startsWith('bunkcraft.key.'))).toBe(true);
  });

  it('works without storage (private mode): the key is still random and passwords stay in memory', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } });
    vi.stubGlobal('crypto', { getRandomValues: (a: Uint8Array) => a.map(() => 7) });
    expect(identityKey('h', 'R')).toHaveLength(48);
    expect(ownerToken('R')).toBeUndefined();
    setRoomPassword('R', 'x');
    expect(roomPassword('R')).toBe('x');
  });
});
