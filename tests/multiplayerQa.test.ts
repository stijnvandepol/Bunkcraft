/**
 * Regression tests for bugs found by the multiplayer QA pass (docs/qa/MULTIPLAYER.md, scripts/qa/).
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { GameServer } from '../server/GameServer';
import { InventoryGuard } from '../server/InventoryGuard';
import { ITEM, itemId } from '../src/items/ItemRegistry';
import { type ClientMessage, PROTOCOL_VERSION, type ServerMessage } from '../src/net/protocol';
import { BLOCK } from '../src/world/BlockRegistry';

class FakeSocket extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  sent: ServerMessage[] = [];
  send(data: string) { this.sent.push(JSON.parse(data) as ServerMessage); }
  close() { this.readyState = 3; }
  terminate() { this.readyState = 3; }
  ping() { this.emit('pong'); }
  say(msg: ClientMessage) { this.emit('message', Buffer.from(JSON.stringify(msg)), false); }
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

function sandbox(): GameServer {
  const dir = mkdtempSync(join(tmpdir(), 'bunk-qa-'));
  dirs.push(dir);
  const s = new GameServer({ dataDir: dir, worldName: 'W', seed: '7', gameMode: 'creative', motd: '', maxPlayers: 4, quiet: true });
  servers.push(s);
  return s;
}

function connect(server: GameServer, name: string): FakeSocket {
  const ws = new FakeSocket();
  server.accept(ws as unknown as WebSocket);
  ws.say({ t: 'hello', v: PROTOCOL_VERSION, name });
  return ws;
}

/** Two players at spawn, with the server's chunks there loaded (normally the tick does that). */
function twoPlayers() {
  const server = sandbox();
  const a = connect(server, 'alice'), b = connect(server, 'bobby');
  const sp = a.of('welcome')[0].spawn;
  for (const ws of [a, b]) ws.say({ t: 'pos', x: sp.x, y: sp.y, z: sp.z, yaw: 0, pitch: 0, flags: 4, held: 0 });
  const world = (server as unknown as { entities: { world: { update(c: { x: number; z: number }[]): void; getBlock(x: number, y: number, z: number): number } } }).entities.world;
  for (let i = 0; i < 8; i++) world.update([{ x: sp.x, z: sp.z }]);
  // An air cell in reach (the spawn can stand under a tree).
  const x = Math.floor(sp.x) + 1, z = Math.floor(sp.z);
  let y = Math.floor(sp.y);
  while (world.getBlock(x, y, z) !== BLOCK.AIR && y < sp.y + 4) y++;
  return { server, a, b, world, x, y, z };
}

describe('simultaneous edits of one block (QA: owner and friend ended up seeing different blocks)', () => {
  it('ends with the same block for both players and the server', () => {
    const { a, b, world, x, y, z } = twoPlayers();
    expect(world.getBlock(x, y, z)).toBe(BLOCK.AIR);
    // Both clicked at the same moment: each saw air.
    a.say({ t: 'block', seq: 1, x, y, z, id: BLOCK.STONE, prev: BLOCK.AIR });
    b.say({ t: 'block', seq: 1, x, y, z, id: BLOCK.GLASS, prev: BLOCK.AIR });
    expect(world.getBlock(x, y, z)).toBe(BLOCK.STONE);
    // Bobby's edit lost the race: it is refused and he gets the server's block after the reject.
    expect(b.of('reject')).toHaveLength(1);
    const last = b.sent.filter((m) => m.t === 'block' || m.t === 'reject').at(-1);
    expect(last).toMatchObject({ t: 'block', x, y, z, id: BLOCK.STONE });
    // Alice never hears of the glass.
    expect(a.of('block').some((m) => m.id === BLOCK.GLASS)).toBe(false);
  });

  it('still accepts edits whose view matches, and edits from clients that send no prev', () => {
    const { a, b, world, x, y, z } = twoPlayers();
    a.say({ t: 'block', seq: 1, x, y, z, id: BLOCK.STONE, prev: BLOCK.AIR });
    b.say({ t: 'block', seq: 1, x, y, z, id: BLOCK.AIR, prev: BLOCK.STONE }); // bobby saw the stone and breaks it
    expect(b.of('reject')).toHaveLength(0);
    expect(world.getBlock(x, y, z)).toBe(BLOCK.AIR);
    a.say({ t: 'block', seq: 2, x, y, z, id: BLOCK.GLASS }); // an older client
    expect(a.of('reject')).toHaveLength(0);
    expect(world.getBlock(x, y, z)).toBe(BLOCK.GLASS);
  });
});

describe('InventoryGuard: everyday item changes without a recipe (QA: the server "corrected" them back)', () => {
  const inv = (...stacks: number[][]): number[][] => stacks;
  const accepts = (from: number[][], to: number[][]) => {
    const g = new InventoryGuard([]);
    g.trustNextState();
    expect(g.check(from).ok).toBe(true);
    return g.check(to).ok;
  };

  it('fills and empties buckets', () => {
    expect(accepts(inv([ITEM.BUCKET, 1, 0]), inv([ITEM.WATER_BUCKET, 1, 0]))).toBe(true);
    expect(accepts(inv([ITEM.BUCKET, 1, 0]), inv([ITEM.LAVA_BUCKET, 1, 0]))).toBe(true);
    expect(accepts(inv([ITEM.WATER_BUCKET, 1, 0]), inv([ITEM.BUCKET, 1, 0]))).toBe(true);
    expect(accepts(inv([itemId('milk_bucket'), 1, 0]), inv([ITEM.BUCKET, 1, 0]))).toBe(true);
  });

  it('gives the bowl back after eating stew', () => {
    expect(accepts(inv([itemId('mushroom_stew'), 1, 0]), inv([itemId('bowl'), 1, 0]))).toBe(true);
  });

  it('still refuses a conversion without its source item', () => {
    expect(accepts(inv([ITEM.BUCKET, 1, 0]), inv([ITEM.WATER_BUCKET, 1, 0], [ITEM.LAVA_BUCKET, 1, 0]))).toBe(false);
    expect(accepts(inv(), inv([ITEM.WATER_BUCKET, 1, 0]))).toBe(false);
  });
});

describe('locked game: a typo in the password (QA: the wrong password was reused forever, never asked again)', () => {
  it('forgets a password the server refused, keeps one that worked', async () => {
    const { NetClient } = await import('../src/net/NetClient');
    const { roomPassword, setRoomPassword } = await import('../src/net/RoomApi');
    /** Minimal browser WebSocket: answers the hello with the scripted message. */
    class StubSocket {
      static reply: ServerMessage;
      readyState = 0;
      binaryType = '';
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: (() => void) | null = null;
      constructor() { setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
      send() { setTimeout(() => this.onmessage?.({ data: JSON.stringify(StubSocket.reply) }), 0); }
      close() { this.readyState = 3; }
    }
    const g = globalThis as Record<string, unknown>;
    const saved = { WebSocket: g.WebSocket, window: g.window, location: g.location, localStorage: g.localStorage };
    Object.assign(g, {
      WebSocket: Object.assign(StubSocket, { OPEN: 1 }), window: globalThis, location: { protocol: 'http:', host: 'localhost' },
      localStorage: { getItem: () => null, setItem: () => undefined },
    });
    try {
      setRoomPassword('ABCDEF', 'gehiem');
      StubSocket.reply = { t: 'kick', reason: 'Wrong password.', code: 'password' };
      await expect(new NetClient().connect('', 'Dave', 'ABCDEF')).rejects.toThrow('Wrong password.');
      expect(roomPassword('ABCDEF')).toBeUndefined();

      setRoomPassword('ABCDEF', 'geheim');
      StubSocket.reply = { t: 'kick', reason: 'The server is full', code: 'full' };
      await expect(new NetClient().connect('', 'Dave', 'ABCDEF')).rejects.toThrow('full');
      expect(roomPassword('ABCDEF')).toBe('geheim');
    } finally {
      Object.assign(g, saved);
    }
  });
});
