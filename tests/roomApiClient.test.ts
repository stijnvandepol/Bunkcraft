import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoom, forgetGame, inviteLink, inviteText, lookupRoom, recentGames, rememberGame, serverInfo } from '../src/net/RoomApi';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

class MemoryStorage {
  private readonly data = new Map<string, string>();
  getItem(k: string): string | null { return this.data.get(k) ?? null; }
  setItem(k: string, v: string): void { this.data.set(k, v); }
  removeItem(k: string): void { this.data.delete(k); }
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('localStorage', new MemoryStorage());
  vi.stubGlobal('location', { origin: 'https://play.example.com' });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('serverInfo', () => {
  it('returns the capabilities, or null when there is no game server', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { rooms: true, main: false }));
    expect(await serverInfo()).toEqual({ rooms: true, main: false });
    expect(fetchMock).toHaveBeenCalledWith('/api/server', undefined);
    fetchMock.mockResolvedValueOnce(new Response('<html>', { status: 404 }));
    expect(await serverInfo()).toBeNull();
    fetchMock.mockRejectedValueOnce(new TypeError('offline'));
    expect(await serverInfo()).toBeNull();
  });
});

describe('createRoom', () => {
  it('posts the settings as JSON and returns the code', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { code: 'K7QM2X' }));
    const code = await createRoom('My game', 'creative', 'seed1');
    expect(code).toBe('K7QM2X');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/rooms');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ name: 'My game', gameMode: 'creative', seed: 'seed1', gameType: 'minecraft', scoreLimit: 0, timeLimitSec: 0 });
  });

  it('sends arcade options including the map only when given', async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, { code: 'ABCDEF' }));
    await createRoom('Arena', 'survival', '', { gameType: 'tdm', scoreLimit: 20, timeLimitSec: 600, mapId: 'rotate' });
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toMatchObject({ gameType: 'tdm', scoreLimit: 20, timeLimitSec: 600, mapId: 'rotate' });
    await createRoom('Arena', 'survival', '', { gameType: 'ffa', scoreLimit: 10, timeLimitSec: 300 });
    expect(JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string)).not.toHaveProperty('mapId');
  });

  it('surfaces the server error message, a generic one for non-JSON errors, and network failures', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(429, { error: 'Too many games created, try again later' }));
    await expect(createRoom('a', 'survival', '')).rejects.toThrow('Too many games created, try again later');
    fetchMock.mockResolvedValueOnce(new Response('oops', { status: 502 }));
    await expect(createRoom('a', 'survival', '')).rejects.toThrow('Server error (502)');
    fetchMock.mockRejectedValueOnce(new TypeError('failed'));
    await expect(createRoom('a', 'survival', '')).rejects.toThrow('Could not reach the server');
  });
});

describe('lookupRoom', () => {
  it('encodes the code and defaults an unknown game type to minecraft', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { code: 'K7QM2X', name: 'Hi', gameMode: 'survival', players: 1, maxPlayers: 8, gameType: 'bogus' }));
    const info = await lookupRoom('K7Q/M2X');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/rooms/K7Q%2FM2X');
    expect(info.gameType).toBe('minecraft');
  });

  it('keeps a known arcade type and throws the server message for a 404', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { code: 'K7QM2X', name: 'A', gameMode: 'survival', players: 0, maxPlayers: 8, gameType: 'tdm', map: 'desert' }));
    expect(await lookupRoom('K7QM2X')).toMatchObject({ gameType: 'tdm', map: 'desert' });
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { error: 'Game not found. Check the code.' }));
    await expect(lookupRoom('ZZZZZZ')).rejects.toThrow('Game not found');
  });
});

describe('invite links', () => {
  it('builds a join link on the current origin and a shareable text with the formatted code', () => {
    expect(inviteLink('K7QM2X')).toBe('https://play.example.com/?join=K7QM2X');
    expect(inviteText('K7QM2X')).toContain('K7Q-M2X');
    expect(inviteText('K7QM2X')).toContain('https://play.example.com/?join=K7QM2X');
  });
});

describe('recent games', () => {
  it('remembers the latest five games, most recent first, without duplicates', () => {
    for (let i = 0; i < 7; i++) rememberGame({ code: `CODE${i}0`, name: `g${i}` });
    rememberGame({ code: 'CODE30', name: 'renamed' });
    const list = recentGames();
    expect(list).toHaveLength(5);
    expect(list[0]).toMatchObject({ code: 'CODE30', name: 'renamed' });
    expect(list.filter((g) => g.code === 'CODE30')).toHaveLength(1);
    forgetGame('CODE30');
    expect(recentGames().some((g) => g.code === 'CODE30')).toBe(false);
  });

  it('survives corrupt storage and drops malformed entries', () => {
    localStorage.setItem('bunkcraft.games', '{not json');
    expect(recentGames()).toEqual([]);
    localStorage.setItem('bunkcraft.games', JSON.stringify({ not: 'a list' }));
    expect(recentGames()).toEqual([]);
    localStorage.setItem('bunkcraft.games', JSON.stringify([{ code: 'K7QM2X', name: 'ok' }, { code: 5 }, null, { name: 'x' }]));
    expect(recentGames()).toHaveLength(1);
  });

  it('does not throw when storage is unavailable', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } });
    expect(() => rememberGame({ code: 'K7QM2X', name: 'x' })).not.toThrow();
    expect(() => forgetGame('K7QM2X')).not.toThrow();
    expect(recentGames()).toEqual([]);
  });
});
