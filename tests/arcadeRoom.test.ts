import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from '../src/net/protocol';
import { GameServer } from '../server/GameServer';
import { Rooms } from '../server/Rooms';

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
const roomSets: Rooms[] = [];
afterEach(() => {
  servers.splice(0).forEach((s) => s.shutdown());
  roomSets.splice(0).forEach((r) => r.shutdown());
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'bunk-'));
  dirs.push(d);
  return d;
}

function arcade(type: 'tdm' | 'ffa' = 'tdm'): GameServer {
  const s = new GameServer({
    dataDir: tmp(), worldName: 'Arena', seed: '7', gameMode: 'survival', motd: '', maxPlayers: 8, quiet: true,
    gameType: type, scoreLimit: 20, timeLimitSec: 300,
  });
  servers.push(s);
  return s;
}

function connect(server: GameServer, name: string): FakeSocket {
  const ws = new FakeSocket();
  server.accept(ws as unknown as WebSocket);
  ws.say({ t: 'hello', v: PROTOCOL_VERSION, name });
  return ws;
}

describe('arcade rooms', () => {
  it('welcome announces the game type, the arena and a spawn; spawn, match and roster follow', () => {
    const ws = connect(arcade('tdm'), 'alice');
    const w = ws.of('welcome')[0];
    expect(w).toMatchObject({ gameType: 'tdm', worldType: 'arena', match: { type: 'tdm', scoreLimit: 20, timeLimitSec: 300 } });
    expect(w.spawn.y).toBe(65);
    expect(w.edits).toEqual([]);
    expect(ws.of('spawn')[0]).toMatchObject({ team: 'red', primary: 'rifle', health: 100, x: w.spawn.x });
    expect(ws.of('match')[0].phase).toBe('warmup');
    expect(ws.of('roster')[0].players).toHaveLength(1);
  });

  it('puts the second player on the other team and lists teams in the welcome', () => {
    const server = arcade('tdm');
    connect(server, 'alice');
    const bob = connect(server, 'bobby');
    expect(bob.of('spawn')[0].team).toBe('blue');
    expect(bob.of('welcome')[0].players).toEqual([{ id: 1, name: 'alice', team: 'red' }]);
  });

  it('refuses block edits and tells the client what is really there', () => {
    const server = arcade();
    const a = connect(server, 'alice');
    const b = connect(server, 'bobby');
    const w = a.of('welcome')[0];
    a.say({ t: 'pos', x: w.spawn.x, y: w.spawn.y, z: w.spawn.z, yaw: 0, pitch: 0, flags: 4, held: 0 });
    b.sent.length = 0;
    a.say({ t: 'block', seq: 5, x: Math.floor(w.spawn.x), y: 64, z: Math.floor(w.spawn.z), id: 0 });
    a.say({ t: 'block', seq: 6, x: Math.floor(w.spawn.x), y: 66, z: Math.floor(w.spawn.z), id: 1 });
    expect(a.of('reject').map((r) => r.seq)).toEqual([5, 6]);
    expect(a.of('reject')[0].id).not.toBe(0); // the floor is still there
    expect(b.of('block')).toHaveLength(0);
    // Mob and item requests are ignored too.
    a.say({ t: 'drop', id: 1, count: 1, x: 0, y: 65, z: 0 });
    a.say({ t: 'ignite', x: 0, y: 65, z: 0 });
    a.say({ t: 'take', id: 1 });
    expect(a.of('ent')).toHaveLength(0);
  });

  it('ignores positions outside the arena and positions from before a spawn', () => {
    const server = arcade();
    const a = connect(server, 'alice');
    const w = a.of('welcome')[0];
    a.say({ t: 'pos', x: 200, y: 65, z: 0, yaw: 0, pitch: 0, flags: 0, held: 0 });
    a.say({ t: 'pos', x: 0, y: 5, z: 0, yaw: 0, pitch: 0, flags: 0, held: 0 });
    a.say({ t: 'pos', x: 0, y: 65, z: 0, yaw: 0, pitch: 0, flags: 0, held: 0 }); // before the client reached the spawn
    a.say({ t: 'pos', x: w.spawn.x + 1, y: w.spawn.y, z: w.spawn.z, yaw: 0, pitch: 0, flags: 0, held: 0 }); // arrived
    return new Promise<void>((done) => setTimeout(() => {
      const snap = a.of('snap').at(-1);
      expect(snap?.players[0][1]).toBeCloseTo(w.spawn.x + 1, 1);
      done();
    }, 120));
  });

  it('keeps the time at noon and has no mobs', () => {
    const server = arcade();
    const a = connect(server, 'alice');
    expect(a.of('welcome')[0].time).toBe(0.25);
    return new Promise<void>((done) => setTimeout(() => {
      expect(a.of('ent')).toHaveLength(0);
      expect(a.of('time')).toHaveLength(0);
      done();
    }, 150));
  });

  it('answers fire requests over the wire with shot and ammo messages', () => {
    const server = arcade('ffa');
    const a = connect(server, 'alice');
    const w = a.of('welcome')[0];
    a.say({ t: 'fire', slot: 0, ox: w.spawn.x, oy: w.spawn.y + 1.62, oz: w.spawn.z, dx: 1, dy: 0, dz: 0, ads: false });
    expect(a.of('shot')).toHaveLength(1);
    expect(a.of('ammo').at(-1)).toMatchObject({ slot: 0, mag: 29 });
  });
});

describe('rooms API', () => {
  function rooms(dir = tmp()): Rooms {
    const r = new Rooms({ dataDir: dir, maxRooms: 10, maxPlayers: 8, motd: '', idleUnloadMs: 60_000, expireDays: 0 });
    roomSets.push(r);
    return r;
  }

  it('creates arcade rooms with clamped limits and gives them an arena world', () => {
    const r = rooms();
    const code = r.create('Fight', 'creative', '5', { gameType: 'tdm', scoreLimit: 1000, timeLimitSec: 10 })!;
    expect(r.info(code)).toMatchObject({ gameType: 'tdm', scoreLimit: 100, timeLimitSec: 120, name: 'Fight' });
    const code2 = r.create('Fight 2', 'creative', undefined, { gameType: 'ffa', scoreLimit: 1, timeLimitSec: 99999 })!;
    expect(r.info(code2)).toMatchObject({ gameType: 'ffa', scoreLimit: 5, timeLimitSec: 1800 });
    const code3 = r.create('Fight 3', undefined, undefined, { gameType: 'tdm' })!;
    expect(r.info(code3)).toMatchObject({ scoreLimit: 30, timeLimitSec: 600 });
  });

  it('keeps minecraft the default and ignores limits for it', () => {
    const r = rooms();
    const a = r.create('Build', 'creative', '1')!;
    expect(r.info(a)).toMatchObject({ gameType: 'minecraft', gameMode: 'creative', scoreLimit: 0, timeLimitSec: 0 });
    const b = r.create('Odd', 'survival', '1', { gameType: 'banana', scoreLimit: 50 })!;
    expect(r.info(b)).toMatchObject({ gameType: 'minecraft', scoreLimit: 0 });
  });

  it('persists the game type in world.json and restores it after a restart', () => {
    const dir = tmp();
    const r1 = rooms(dir);
    const code = r1.create('Persist', 'survival', '9', { gameType: 'ffa', scoreLimit: 40, timeLimitSec: 400 })!;
    r1.shutdown();
    const saved = JSON.parse(readFileSync(join(dir, code, 'world.json'), 'utf8'));
    expect(saved).toMatchObject({ gameType: 'ffa', scoreLimit: 40, timeLimitSec: 400 });
    const r2 = rooms(dir);
    expect(r2.info(code)).toMatchObject({ gameType: 'ffa', scoreLimit: 40, timeLimitSec: 400 });
  });
});
