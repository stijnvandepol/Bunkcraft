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
import { MAX_CHANGES_PER_TICK, WATER_TICK_DELAY } from '../src/world/Liquids';

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

describe('ServerWorld liquids', () => {
  it('floods through the same setBlock path, records the edits and reports them for broadcasting', () => {
    const w = new ServerWorld(1, {});
    for (let i = 0; i < 12; i++) w.update([{ x: 0, z: 0 }]);
    const edits: string[] = [];
    w.onEdit = (x, y, z, id, meta) => edits.push(`${x},${y},${z}=${id}:${meta}`);
    w.setBlock(2, 120, 2, BLOCK.WATER, 0);
    let ticks = 0;
    for (; ticks < 100 && w.liquids.pendingCount > 0; ticks++) w.tickLiquids();
    expect(ticks).toBeGreaterThan(WATER_TICK_DELAY);
    // The source dropped as a column of falling water.
    expect(w.getBlock(2, 119, 2)).toBe(BLOCK.WATER);
    expect(w.getMeta(2, 119, 2)).toBe(8);
    const sim = w.drainSimEdits();
    expect(sim.length % 5).toBe(0);
    expect(sim.length).toBeGreaterThan(5);
    expect(w.drainSimEdits()).toEqual([]);
    // Every simulated change was also a recorded edit (the world file keeps the lake).
    expect(edits.length).toBeGreaterThan(sim.length / 5);
  });

  it('keeps a liquid that was still flowing flowing after its chunk is loaded again', () => {
    const w = new ServerWorld(1, { '3,120,3': BLOCK.WATER | (1 << 8) });
    expect(w.liquids.pendingCount).toBe(0); // nothing loaded yet
    for (let i = 0; i < 12; i++) w.update([{ x: 0, z: 0 }]);
    expect(w.liquids.pendingCount).toBeGreaterThan(0);
  });
});

describe('server liquid broadcasting', () => {
  it('sends flowing water to every client in bounded batches, at most 200 changes per tick', () => {
    const server = sandbox();
    const a = connect(server, 'alice');
    const b = connect(server, 'bobby');
    // Let the world around the spawn load (2 chunks per tick).
    vi.advanceTimersByTime(50 * 60);
    const sp = a.of('welcome')[0].spawn;
    const x = Math.floor(sp.x) + 2, z = Math.floor(sp.z), y = Math.floor(sp.y) + 3;
    b.sent.length = 0;
    a.say({ t: 'block', seq: 1, x, y, z, id: BLOCK.WATER });
    let maxTuples = 0;
    for (let tick = 0; tick < 200; tick++) {
      const before = b.of('blocks').length;
      vi.advanceTimersByTime(50);
      const fresh = b.of('blocks').slice(before);
      let tuples = 0;
      for (const m of fresh) {
        expect(m.edits.length % 5).toBe(0);
        expect(m.edits.length / 5).toBeLessThanOrEqual(100);
        tuples += m.edits.length / 5;
      }
      maxTuples = Math.max(maxTuples, tuples);
    }
    const blocks = b.of('blocks');
    expect(blocks.length).toBeGreaterThan(5);
    // The placed source reached Bobby as a plain block message, the flow as batches of water.
    expect(b.of('block')[0]).toMatchObject({ x, y, z, id: BLOCK.WATER });
    // (Random ticks share the batch: grass spreading can come first, so look for the water.)
    const water = blocks.flatMap((m) => m.edits.filter((v, k) => k % 5 === 3 && v === BLOCK.WATER));
    expect(water.length).toBeGreaterThan(0);
    expect(maxTuples).toBeGreaterThan(0);
    expect(maxTuples).toBeLessThanOrEqual(MAX_CHANGES_PER_TICK + 8);
    // Alice (who placed it) gets the flow too, not an echo of her own placement.
    expect(a.of('blocks').length).toBeGreaterThan(5);
    expect(a.of('block').filter((m) => m.y === y)).toHaveLength(0);
  });
});
