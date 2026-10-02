import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { GameServer } from '../server/GameServer';
import { ServerWorld } from '../server/ServerWorld';
import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from '../src/net/protocol';
import { ChunkMesher } from '../src/rendering/ChunkMesher';
import type { WorkerPool } from '../src/workers/WorkerPool';
import type { WorkerRequest } from '../src/workers/protocol';
import { BLOCK } from '../src/world/BlockRegistry';
import { packState, stateId, stateMeta } from '../src/world/BlockStates';
import { CHUNK_AREA, CHUNK_VOLUME, blockIndex, chunkKey } from '../src/world/constants';
import { CHUNK_READY, Chunk } from '../src/world/Chunk';
import type { ChunkMaterials } from '../src/world/ChunkManager';
import { World } from '../src/world/World';
import { emptyChunk, setLocal } from './helpers';

/** A World whose chunks are installed by hand (no workers), around chunk (0, 0). */
function makeWorld(edits = new Map<number, Map<number, number>>(), requests: WorkerRequest[] = []): World {
  const pool = { size: 1, submit: (req: WorkerRequest) => { requests.push(req); } } as unknown as WorkerPool;
  const world = new World(1, pool, {} as ChunkMaterials, edits);
  for (let cz = -1; cz <= 1; cz++) {
    for (let cx = -1; cx <= 1; cx++) {
      const c = new Chunk(cx, cz, chunkKey(cx, cz));
      c.blocks = new Uint8Array(CHUNK_VOLUME);
      c.biomes = new Uint8Array(CHUNK_AREA);
      c.state = CHUNK_READY;
      world.chunks.chunks.set(c.key, c);
      world.chunks.onGenerated?.(c);
    }
  }
  world.chunks.epoch++;
  return world;
}

describe('state packing', () => {
  it('round-trips id and meta', () => {
    expect(packState(44, 0)).toBe(44);
    expect(stateId(packState(255, 17))).toBe(255);
    expect(stateMeta(packState(5, 255))).toBe(255);
    expect(stateMeta(packState(5, 3))).toBe(3);
  });
});

describe('World block states', () => {
  it('stores meta lazily and reports it', () => {
    const world = makeWorld();
    const c = world.chunks.get(0, 0)!;
    expect(c.meta).toBeNull();
    expect(world.setBlock(3, 70, 4, BLOCK.STONE)).toBe(true);
    expect(c.meta).toBeNull(); // meta 0 never allocates
    expect(world.setBlock(3, 70, 4, BLOCK.STONE, 5)).toBe(true); // same id, new state
    expect(c.meta).not.toBeNull();
    expect(world.getMeta(3, 70, 4)).toBe(5);
    expect(world.setBlock(3, 70, 4, BLOCK.STONE, 5)).toBe(false); // unchanged
    expect(world.getMeta(5, 70, 4)).toBe(0);
    expect(world.edits.get(c.key)!.get(blockIndex(3, 70, 4))).toBe(packState(BLOCK.STONE, 5));
  });

  it('hands the neighbours meta to the mesh worker (null where a chunk has none)', () => {
    const requests: WorkerRequest[] = [];
    const world = makeWorld(undefined, requests);
    for (const c of world.chunks.chunks.values()) c.version = 1;
    world.setBlock(3, 70, 4, BLOCK.STONE, 5);
    const mesh = requests.find((r) => r.type === 'mesh');
    expect(mesh).toBeDefined();
    const metas = (mesh as Extract<WorkerRequest, { type: 'mesh' }>).metas;
    expect(metas).toHaveLength(9);
    expect(metas[4]).toBe(world.chunks.get(0, 0)!.meta);
    expect(metas.filter((m) => m !== null)).toHaveLength(1);
  });

  it('resets meta when the block is replaced by air', () => {
    const world = makeWorld();
    world.setBlock(-1, 70, -1, BLOCK.STONE, 3);
    expect(world.getMeta(-1, 70, -1)).toBe(3);
    world.setBlock(-1, 70, -1, BLOCK.AIR);
    expect(world.getMeta(-1, 70, -1)).toBe(0);
  });

  it('tells onEdit about the new and the previous state', () => {
    const world = makeWorld();
    const seen: number[][] = [];
    world.onEdit = (...a) => seen.push(a);
    world.setBlock(1, 70, 1, BLOCK.COBBLESTONE, 2);
    world.setBlock(1, 70, 1, BLOCK.COBBLESTONE, 4);
    expect(seen).toEqual([[1, 70, 1, BLOCK.COBBLESTONE, 2, 0, 0], [1, 70, 1, BLOCK.COBBLESTONE, 4, BLOCK.COBBLESTONE, 2]]);
  });

  it('applies saved edits with meta when a chunk generates, and remote edits are not echoed', () => {
    const idx = blockIndex(2, 80, 2);
    const world = makeWorld(new Map([[chunkKey(0, 0), new Map([[idx, packState(BLOCK.GLASS, 7)]])]]));
    expect(world.getBlock(2, 80, 2)).toBe(BLOCK.GLASS);
    expect(world.getMeta(2, 80, 2)).toBe(7);
    let echoed = 0;
    world.onEdit = () => echoed++;
    world.applyRemoteEdit(6, 80, 6, BLOCK.STONE, 9);
    expect(echoed).toBe(0);
    expect(world.getMeta(6, 80, 6)).toBe(9);
  });

  it('remembers an edit for an unloaded chunk, state included', () => {
    const world = makeWorld();
    world.applyRemoteEdit(100, 70, 100, BLOCK.STONE, 3);
    expect(world.edits.get(chunkKey(6, 6))!.get(blockIndex(100 & 15, 70, 100 & 15))).toBe(packState(BLOCK.STONE, 3));
  });
});

describe('ServerWorld block states', () => {
  it('keeps meta in the chunk and in the edit list, also for chunks that load later', () => {
    const w = new ServerWorld(1, { '3,100,3': packState(BLOCK.GLASS, 6), '4,100,4': BLOCK.STONE }); // second one: pre-states format
    const seen: string[] = [];
    w.onEdit = (x, y, z, id, meta) => seen.push(`${x},${y},${z}=${id}:${meta}`);
    for (let i = 0; i < 10; i++) w.update([{ x: 0, z: 0 }]);
    expect(w.getBlock(3, 100, 3)).toBe(BLOCK.GLASS);
    expect(w.getMeta(3, 100, 3)).toBe(6);
    expect(w.getMeta(4, 100, 4)).toBe(0);
    w.setBlock(5, 100, 5, BLOCK.STONE, 2);
    expect(w.getMeta(5, 100, 5)).toBe(2);
    expect(w.setBlock(5, 100, 5, BLOCK.STONE, 2)).toBe(-1);
    expect(w.setBlock(5, 100, 5, BLOCK.STONE, 3)).toBe(BLOCK.STONE);
    expect(seen).toContain('5,100,5=1:3');
  });
});

describe('ChunkMesher meta input', () => {
  it('accepts meta arrays (null = none) without changing plain geometry', () => {
    const mesher = new ChunkMesher();
    const nb = Array.from({ length: 9 }, () => emptyChunk());
    setLocal(nb[4], 5, 64, 5, BLOCK.STONE);
    const biomes = Array.from({ length: 9 }, () => new Uint8Array(CHUNK_AREA));
    const plain = mesher.mesh(nb, biomes, true);
    const metas = Array.from({ length: 9 }, () => null as Uint8Array | null);
    const withNulls = mesher.mesh(nb, biomes, true, metas);
    metas[4] = new Uint8Array(CHUNK_VOLUME);
    const withMeta = mesher.mesh(nb, biomes, true, metas);
    expect(withNulls.opaque!.index.length).toBe(plain.opaque!.index.length);
    expect(withMeta.opaque!.index.length).toBe(plain.opaque!.index.length);
  });
});

// ---------------------------------------------------------------- server protocol

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
afterEach(() => {
  servers.splice(0).forEach((s) => s.shutdown());
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

function sandbox(dataDir?: string): GameServer {
  const dir = dataDir ?? mkdtempSync(join(tmpdir(), 'bunk-'));
  dirs.push(dir);
  const s = new GameServer({ dataDir: dir, worldName: 'W', seed: '7', gameMode: 'creative', motd: '', maxPlayers: 4, quiet: true });
  servers.push(s);
  return s;
}

function connect(server: GameServer, name: string, v = PROTOCOL_VERSION): FakeSocket {
  const ws = new FakeSocket();
  server.accept(ws as unknown as WebSocket);
  ws.say({ t: 'hello', v, name });
  return ws;
}

describe('multiplayer block states', () => {
  it('is protocol version 4 and rejects older clients', () => {
    expect(PROTOCOL_VERSION).toBe(4);
    const ws = connect(sandbox(), 'alice', 3);
    expect(ws.of('kick')[0].reason).toContain('Outdated');
  });

  it('relays block edits, refuses a meta the block cannot have, persists and sends 5-tuples in the welcome', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bunk-'));
    const server = sandbox(dir);
    const a = connect(server, 'alice');
    const b = connect(server, 'bobby');
    const sp = a.of('welcome')[0].spawn;
    a.say({ t: 'pos', x: sp.x, y: sp.y, z: sp.z, yaw: 0, pitch: 0, flags: 4, held: 0 });
    const x = Math.floor(sp.x) + 1, y = Math.floor(sp.y), z = Math.floor(sp.z);
    // Plain stone has no states: a meta is refused and echoed back in the reject.
    a.say({ t: 'block', seq: 1, x, y, z, id: BLOCK.STONE, meta: 3 });
    expect(a.of('reject')[0]).toMatchObject({ seq: 1, x, y, z, id: BLOCK.STONE, meta: 3 });
    expect(b.of('block')).toHaveLength(0);
    // A plain edit goes out without a meta field.
    a.say({ t: 'block', seq: 2, x, y, z, id: BLOCK.STONE });
    expect(b.of('block')[0]).toEqual({ t: 'block', x, y, z, id: BLOCK.STONE });
    server.save();
    const saved = JSON.parse(readFileSync(join(dir, 'world.json'), 'utf8'));
    expect(saved.edits[`${x},${y},${z}`]).toBe(BLOCK.STONE);
    const c = connect(server, 'carol');
    expect(c.of('welcome')[0].edits).toEqual([x, y, z, BLOCK.STONE, 0]);
  });

  it('reads a world.json from before block states (plain ids)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bunk-'));
    writeFileSync(join(dir, 'world.json'), JSON.stringify({
      name: 'Old', seed: 5, gameMode: 'creative', time: 0.1, spawn: { x: 0.5, y: 90, z: 0.5 }, edits: { '1,2,3': BLOCK.BRICKS }, players: {},
    }));
    const ws = connect(sandbox(dir), 'dave');
    expect(ws.of('welcome')[0].edits).toEqual([1, 2, 3, BLOCK.BRICKS, 0]);
  });
});
