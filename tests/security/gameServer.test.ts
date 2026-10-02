import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type ServerMessage } from '../../src/net/protocol';
import { GameServer, cleanInventory } from '../../server/GameServer';

class FakeSocket extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  terminated = false;
  sent: ServerMessage[] = [];
  send(data: string) { this.sent.push(JSON.parse(data) as ServerMessage); }
  close() { this.readyState = 3; }
  terminate() { this.terminated = true; this.readyState = 3; }
  ping() { this.emit('pong'); }
  raw(text: string) { this.emit('message', Buffer.from(text), false); }
  say(msg: unknown) { this.raw(JSON.stringify(msg)); }
  of<T extends ServerMessage['t']>(t: T): Extract<ServerMessage, { t: T }>[] {
    return this.sent.filter((m) => m.t === t) as Extract<ServerMessage, { t: T }>[];
  }
}

const dirs: string[] = [];
const servers: GameServer[] = [];
afterEach(() => {
  servers.splice(0).forEach((s) => s.shutdown());
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

function survival(): { server: GameServer; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'bunk-sec-'));
  dirs.push(dir);
  const server = new GameServer({ dataDir: dir, worldName: 'T', seed: '7', gameMode: 'survival', motd: '', maxPlayers: 8, quiet: true });
  servers.push(server);
  return { server, dir };
}

function connect(server: GameServer, name: string): FakeSocket {
  const ws = new FakeSocket();
  server.accept(ws as unknown as WebSocket);
  ws.say({ t: 'hello', v: PROTOCOL_VERSION, name });
  return ws;
}

const pos = (x: number, y: number, z: number) => ({ t: 'pos', x, y, z, yaw: 0, pitch: 0, flags: 0, held: 0 });

type Sessions = Map<number, { x: number; y: number; z: number }>;
const sessionOf = (server: GameServer, id: number) => (server as unknown as { sessions: Sessions }).sessions.get(id)!;

describe('malformed WebSocket messages', () => {
  it('JSON that is not an object is ignored, before and after the hello', () => {
    const { server } = survival();
    const early = new FakeSocket();
    server.accept(early as unknown as WebSocket);
    for (const text of ['null', '5', '"x"', '[]', 'true']) expect(() => early.raw(text)).not.toThrow();
    const ws = connect(server, 'alice');
    for (const text of ['null', '5', '"x"', '[]', 'true', '{"t":5}', '{}']) expect(() => ws.raw(text)).not.toThrow();
    expect(ws.readyState).toBe(1);
  });

  it('survives every message type filled with junk values', () => {
    const { server } = survival();
    const ws = connect(server, 'alice');
    const junk = [null, 'a', Number.NaN, 1e308, -1, {}, [], true, '__proto__'];
    for (const t of ['pos', 'block', 'chat', 'state', 'attack', 'shoot', 'ignite', 'take', 'drop', 'loadout', 'fire', 'reload', 'weapon', 'hello']) {
      for (const j of junk) {
        const f = { t, x: j, y: j, z: j, id: j, count: j, text: j, name: j, inventory: j, stats: j, seq: j, v: j, damage: j, slot: j, meta: j };
        expect(() => ws.say(f)).not.toThrow();
      }
    }
  });

  it('a handler that throws closes that socket and does not propagate', () => {
    const { server } = survival();
    const ws = connect(server, 'alice');
    const evil = { t: 'chat' };
    Object.defineProperty(evil, 'text', { get() { throw new Error('boom'); }, enumerable: true });
    const orig = JSON.parse;
    JSON.parse = () => evil;
    try { expect(() => ws.raw('x')).not.toThrow(); } finally { JSON.parse = orig; }
    expect(ws.readyState).toBe(3);
  });
});

describe('player records', () => {
  it('names such as __proto__ and constructor do not touch Object.prototype or leak records', () => {
    const { server, dir } = survival();
    for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      const ws = connect(server, name);
      expect(ws.of('welcome')).toHaveLength(1);
      expect(ws.of('welcome')[0].player).toBeNull();
      ws.say(pos(0.5, 70, 0.5));
      ws.say({ t: 'state', inventory: [[1, 2, 0]], stats: [20] });
    }
    server.save();
    const saved = JSON.parse(readFileSync(join(dir, 'world.json'), 'utf8')) as { players: Record<string, unknown> };
    expect(({} as Record<string, unknown>).x).toBeUndefined();
    expect(Object.keys(saved.players).sort()).toEqual(['__proto__', 'constructor', 'hasOwnProperty', 'toString']);
    expect(connect(server, 'fresh').of('welcome')[0].player).toBeNull();
  });

  it('cleanInventory keeps only rows of finite numbers', () => {
    expect(cleanInventory([[1, 2, 3], 'x', null, [1, { a: 1 }, Infinity], new Array(500).fill(1)])).toEqual([[1, 2, 3], [], [], [1, 0, 0], []]);
  });
});

describe('movement', () => {
  it('cannot teleport by reporting a position below y=-60', () => {
    const { server } = survival();
    const ws = connect(server, 'alice');
    ws.say(pos(0.5, 70, 0.5));
    ws.say(pos(5_000_000, -100, 5_000_000));
    ws.say(pos(5_000_000, 70, 5_000_000));
    const s = sessionOf(server, ws.of('welcome')[0].id);
    expect(Math.abs(s.x)).toBeLessThan(1000);
    expect(Math.abs(s.z)).toBeLessThan(1000);
  });

  it('ignores positions outside the world border', () => {
    const { server } = survival();
    const ws = connect(server, 'alice');
    ws.say(pos(0.5, 70, 0.5));
    ws.say(pos(1e300, 70, 0.5));
    ws.say(pos(0.5, 1e9, 0.5));
    const s = sessionOf(server, ws.of('welcome')[0].id);
    expect(s.x).toBeLessThan(10);
    expect(s.y).toBeLessThan(200);
  });
});

describe('slow readers', () => {
  it('terminates a client whose send buffer keeps growing instead of buffering for it', () => {
    const { server } = survival();
    const slow = connect(server, 'slow');
    const chatty = connect(server, 'chatty');
    slow.bufferedAmount = 64 * 1024 * 1024;
    chatty.say({ t: 'chat', text: 'hello' });
    expect(slow.terminated).toBe(true);
    expect(chatty.terminated).toBe(false);
  });
});
