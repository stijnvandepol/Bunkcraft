import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '../../src/net/protocol';
import { Client, type TestServer, api, createRoom, startServer } from './harness';

/** Real server process: Realms quick play, the split listings and the per-mode statistics over HTTP. */
let srv: TestServer;
const clients: Client[] = [];
beforeAll(async () => { srv = await startServer(); });
afterAll(async () => { await srv.dispose(); });
afterEach(() => { clients.splice(0).forEach((c) => c.close()); });

async function joinRoom(code: string, name: string): Promise<Client> {
  const c = await Client.open(`${srv.ws}/ws/${code}`, name);
  clients.push(c);
  c.send({ t: 'hello', v: PROTOCOL_VERSION, name });
  await c.waitFor((m) => m.t === 'welcome' || m.t === 'kick');
  return c;
}

type Quick = { code: string; created: boolean };

describe('Realms quick play', () => {
  it('opens a new public lobby when none exists, then puts the next player into that lobby', async () => {
    const first = await api<Quick>(srv, 'POST', '/api/quickplay', { gameType: 'ffa' });
    expect(first.status).toBe(201);
    expect(first.body.created).toBe(true);
    const host = await joinRoom(first.body.code, 'qp_alice');
    expect(host.welcome).toMatchObject({ gameType: 'ffa', worldType: 'arena' });

    const second = await api<Quick>(srv, 'POST', '/api/quickplay', { gameType: 'ffa' });
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ code: first.body.code, created: false });
    const guest = await joinRoom(second.body.code, 'qp_bob');
    expect(guest.welcome.gameType).toBe('ffa');

    // The lobby is public and rotates maps; it shows up for Realms only, with its live phase.
    const info = await api<{ map: string; gameType: string }>(srv, 'GET', `/api/rooms/${first.body.code}`);
    expect(info.body).toMatchObject({ gameType: 'ffa', map: 'rotate' });
    const arcade = await api<{ rooms: { code: string; phase?: string; players: number }[] }>(srv, 'GET', '/api/rooms?public=1&kind=arcade');
    expect(arcade.body.rooms.find((r) => r.code === first.body.code)).toMatchObject({ players: 2, phase: 'warmup' });
    const mc = await api<{ rooms: { code: string }[] }>(srv, 'GET', '/api/rooms?public=1&kind=minecraft');
    expect(mc.body.rooms.some((r) => r.code === first.body.code)).toBe(false);
  });

  it('joins an existing public lobby someone created by hand instead of opening one', async () => {
    const code = await createRoom(srv, { name: 'Hand Made', gameType: 'ctf', listed: true, mapId: 'atomic' });
    await joinRoom(code, 'qp_carol');
    const r = await api<Quick>(srv, 'POST', '/api/quickplay', { gameType: 'ctf' });
    expect(r.body).toEqual({ code, created: false });
  });

  it('never matches into a private lobby, and refuses Minecraft and junk', async () => {
    const priv = await createRoom(srv, { name: 'Private', gameType: 'hardpoint' });
    await joinRoom(priv, 'qp_dave');
    const r = await api<Quick>(srv, 'POST', '/api/quickplay', { gameType: 'hardpoint' });
    expect(r.status).toBe(201);
    expect(r.body.code).not.toBe(priv);
    expect((await api(srv, 'POST', '/api/quickplay', { gameType: 'minecraft' })).status).toBe(400);
    expect((await api(srv, 'POST', '/api/quickplay', { gameType: 'banana' })).status).toBe(400);
  });

  it('reports players and public lobbies per mode', async () => {
    const r = await api<{ modes: { gameType: string; players: number; lobbies: number }[] }>(srv, 'GET', '/api/realms');
    expect(r.status).toBe(200);
    expect(r.body.modes.map((m) => m.gameType)).toContain('tdm');
    expect(r.body.modes.some((m) => m.gameType === 'minecraft')).toBe(false);
    for (const m of r.body.modes) expect(m.players).toBeGreaterThanOrEqual(0);
  });

  it('serves a household behind one address: four players with the playlist open and browsing for a minute (QA round 3)', async () => {
    const ip = '10.201.0.7';
    let refused = 0;
    // Four playlists polling every 10 s for a minute (24), each opening it three times (12) and browsing twice (8), with margin.
    for (let i = 0; i < 80; i++) {
      const r = await api(srv, 'GET', i % 5 === 4 ? '/api/rooms?public=1&kind=arcade' : '/api/realms', undefined, ip);
      if (r.status === 429) refused++;
    }
    expect(refused).toBe(0);
  });

  it('keeps the room creation limit: quick play may join but not open lobbies past it', async () => {
    const limited = await startServer({ ROOM_CREATE_LIMIT: '1' });
    try {
      const ip = '10.200.0.1';
      const a = await api<Quick>(limited, 'POST', '/api/quickplay', { gameType: 'tdm' }, ip);
      expect(a.status).toBe(201);
      const b = await api<Quick>(limited, 'POST', '/api/quickplay', { gameType: 'gungame' }, ip);
      expect(b.status).toBe(429);
      // Joining the existing lobby is still fine for the same address.
      const c = await api<Quick>(limited, 'POST', '/api/quickplay', { gameType: 'tdm' }, ip);
      expect(c.body).toEqual({ code: a.body.code, created: false });
    } finally {
      await limited.dispose();
    }
  });
});
