import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GameServer } from '../server/GameServer';
import { ServerWorld } from '../server/ServerWorld';
import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from '../src/net/protocol';
import { BLOCK } from '../src/world/BlockRegistry';
import { LEVER_ON } from '../src/world/Redstone';

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
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  servers.splice(0).forEach((s) => s.shutdown());
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
  vi.useRealTimers();
});

function sandbox(): GameServer {
  const dir = mkdtempSync(join(tmpdir(), 'bunk-'));
  dirs.push(dir);
  const s = new GameServer({ dataDir: dir, worldName: 'W', seed: '7', gameMode: 'creative', motd: '', maxPlayers: 4, quiet: true });
  servers.push(s);
  return s;
}

function connect(server: GameServer, name: string): FakeSocket {
  const ws = new FakeSocket();
  server.accept(ws as unknown as WebSocket);
  ws.say({ t: 'hello', v: PROTOCOL_VERSION, name });
  const sp = ws.of('welcome')[0].spawn;
  ws.say({ t: 'pos', x: sp.x, y: sp.y, z: sp.z, yaw: 0, pitch: 0, flags: 4, held: 0 });
  return ws;
}


/** Highest solid y at a column of a server world, after the chunks loaded. */
function ground(w: ServerWorld, x: number, z: number): number {
  for (let y = 120; y > 0; y--) if (w.getBlock(x, y, z) !== BLOCK.AIR) return y;
  return 0;
}

describe('ServerWorld redstone', () => {
  it('simulates a lever → dust → lamp circuit and reports the changes for broadcasting', () => {
    const w = new ServerWorld(1, {});
    for (let i = 0; i < 12; i++) w.update([{ x: 0, z: 0 }]);
    const y = 100;
    for (let x = 0; x <= 8; x++) w.setBlock(x, y - 1, 0, BLOCK.STONE);
    for (let x = 1; x <= 6; x++) w.setBlock(x, y, 0, BLOCK.REDSTONE_WIRE);
    w.setBlock(7, y, 0, BLOCK.REDSTONE_LAMP);
    w.setBlock(0, y, 0, BLOCK.LEVER, 3 | LEVER_ON);
    w.tickRedstone();
    const sim = w.drainSimEdits();
    expect(w.getBlock(7, y, 0)).toBe(BLOCK.REDSTONE_LAMP_LIT);
    expect(w.getMeta(6, y, 0) & 15).toBe(10);
    // x, y, z, id, meta tuples: six dust blocks and the lamp.
    expect(sim.length / 5).toBe(7);
  });

  it('a 500-dust circuit ticks cheaply (cost measurement)', () => {
    vi.useRealTimers();
    const w = new ServerWorld(1, {});
    for (let i = 0; i < 40; i++) w.update([{ x: 0, z: 0 }]);
    const y = 110;
    // 34 rows of 15 dust (510 blocks), each row fed by its own lever at x = 0.
    for (let z = -17; z < 17; z++) {
      for (let x = 0; x <= 15; x++) w.setBlock(x, y - 1, z * 2, BLOCK.STONE);
      for (let x = 1; x <= 15; x++) w.setBlock(x, y, z * 2, BLOCK.REDSTONE_WIRE);
    }
    w.tickRedstone();
    w.drainSimEdits();
    let worst = 0, total = 0;
    for (let round = 0; round < 20; round++) {
      const on = round % 2 === 0;
      for (let z = -17; z < 17; z++) w.setBlock(0, y, z * 2, BLOCK.LEVER, 3 | (on ? LEVER_ON : 0));
      const t0 = performance.now();
      w.tickRedstone();
      const dt = performance.now() - t0;
      worst = Math.max(worst, dt);
      total += dt;
      expect(w.getMeta(15, y, 0) & 15).toBe(on ? 1 : 0);
      w.drainSimEdits();
    }
    process.stdout.write(`[redstone] server: 510 dust toggled, ${(total / 20).toFixed(2)} ms per tick average, ${worst.toFixed(2)} ms worst\n`);
    expect(total / 20).toBeLessThan(50);
  });
});

describe('server redstone sync', () => {
  it('a lever placed by one player powers dust and a lamp that the other player sees', () => {
    const server = sandbox();
    const a = connect(server, 'alice');
    const b = connect(server, 'bobby');
    vi.advanceTimersByTime(50 * 60);
    const sp = a.of('welcome')[0].spawn;
    const x0 = Math.floor(sp.x) + 1, z = Math.floor(sp.z);
    const world = (server as unknown as { entities: { world: ServerWorld } }).entities.world;
    const y = ground(world, x0, z) + 1;
    let seq = 1;
    for (let x = x0; x <= x0 + 3; x++) a.say({ t: 'block', seq: seq++, x, y: y - 1, z, id: BLOCK.STONE });
    a.say({ t: 'block', seq: seq++, x: x0 + 1, y, z, id: BLOCK.REDSTONE_WIRE });
    a.say({ t: 'block', seq: seq++, x: x0 + 2, y, z, id: BLOCK.REDSTONE_LAMP });
    b.sent.length = 0;
    a.say({ t: 'block', seq: seq++, x: x0, y, z, id: BLOCK.LEVER, meta: 3 | LEVER_ON });
    expect(a.of('reject')).toHaveLength(0);
    vi.advanceTimersByTime(100);
    const tuples = b.of('blocks').flatMap((m) => m.edits);
    const has = (x: number, id: number, meta?: number) => {
      for (let i = 0; i < tuples.length; i += 5) {
        if (tuples[i] === x && tuples[i + 1] === y && tuples[i + 2] === z && tuples[i + 3] === id && (meta === undefined || tuples[i + 4] === meta)) return true;
      }
      return false;
    };
    expect(has(x0 + 1, BLOCK.REDSTONE_WIRE, 15)).toBe(true);
    expect(has(x0 + 2, BLOCK.REDSTONE_LAMP_LIT)).toBe(true);
    // The lever edit itself reached Bobby as a plain block message.
    expect(b.of('block').some((m) => m.id === BLOCK.LEVER)).toBe(true);
  });
});
