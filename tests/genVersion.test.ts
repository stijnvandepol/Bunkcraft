import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from '../src/net/protocol';
import type { WorkerPool } from '../src/workers/WorkerPool';
import type { WorkerRequest } from '../src/workers/protocol';
import type { ChunkMaterials } from '../src/world/ChunkManager';
import { GEN_VERSION_CURRENT, GEN_VERSION_LEGACY } from '../src/world/GenVersion';
import { TerrainGenerator } from '../src/world/TerrainGenerator';
import { CHUNK_VOLUME } from '../src/world/constants';
import { createGenerator } from '../src/world/WorldGenerator';
import { World } from '../src/world/World';
import { GameServer } from '../server/GameServer';
import { ServerWorld } from '../server/ServerWorld';
import { fnv1a } from './helpers';

class FakeSocket extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  sent: ServerMessage[] = [];
  send(data: string) { this.sent.push(JSON.parse(data) as ServerMessage); }
  close() { this.readyState = 3; }
  ping() { this.emit('pong'); }
  say(msg: ClientMessage) { this.emit('message', Buffer.from(JSON.stringify(msg)), false); }
}

const dirs: string[] = [];
const servers: GameServer[] = [];
afterEach(() => {
  servers.splice(0).forEach((s) => s.shutdown());
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'bunk-gen-'));
  dirs.push(d);
  return d;
}

function server(dir: string): GameServer {
  const s = new GameServer({ dataDir: dir, worldName: 'W', seed: '7', gameMode: 'creative', motd: '', maxPlayers: 4, quiet: true });
  servers.push(s);
  return s;
}

function welcomeOf(s: GameServer): Extract<ServerMessage, { t: 'welcome' }> {
  const ws = new FakeSocket();
  s.accept(ws as unknown as WebSocket);
  ws.say({ t: 'hello', v: PROTOCOL_VERSION, name: 'alice' });
  return ws.sent.find((m) => m.t === 'welcome') as Extract<ServerMessage, { t: 'welcome' }>;
}

describe('generator version plumbing', () => {
  it('createGenerator builds the generator of the requested version', () => {
    const v1 = new Uint8Array(CHUNK_VOLUME), v2 = new Uint8Array(CHUNK_VOLUME), direct = new Uint8Array(CHUNK_VOLUME);
    createGenerator('terrain', 5, GEN_VERSION_LEGACY).generate(2, 3, v1);
    createGenerator('terrain', 5, GEN_VERSION_CURRENT).generate(2, 3, v2);
    new TerrainGenerator(5, 1).generate(2, 3, direct);
    expect(fnv1a(v1)).toBe(fnv1a(direct));
    expect(fnv1a(v1)).not.toBe(fnv1a(v2));
  });

  it('chunk generation requests carry the world\'s generator version', () => {
    const requests: WorkerRequest[] = [];
    const pool = { size: 1, submit: (r: WorkerRequest) => { requests.push(r); } } as unknown as WorkerPool;
    for (const version of [GEN_VERSION_LEGACY, GEN_VERSION_CURRENT]) {
      requests.length = 0;
      const world = new World(9, pool, {} as ChunkMaterials, undefined, 'terrain', version);
      expect(world.genVersion).toBe(version);
      world.chunks.renderDistance = 2;
      world.chunks.update(8, 8);
      const gens = requests.filter((r) => r.type === 'generate');
      expect(gens.length).toBeGreaterThan(0);
      for (const r of gens) expect(r.type === 'generate' && r.genVersion).toBe(version);
    }
  });

  it('a server world keeps its generator version, an unversioned world file means version 1', () => {
    const w1 = new ServerWorld(5, {}, 'terrain', 1), w2 = new ServerWorld(5, {}, 'terrain');
    expect(w1.genVersion).toBe(1);
    expect(w2.genVersion).toBe(GEN_VERSION_CURRENT);
  });

  it('a new server world is created with the current version and announces it in the welcome', () => {
    const dir = tmp();
    const s = server(dir);
    expect(welcomeOf(s).genVersion).toBe(GEN_VERSION_CURRENT);
    s.shutdown();
    expect(JSON.parse(readFileSync(join(dir, 'world.json'), 'utf8')).genVersion).toBe(GEN_VERSION_CURRENT);
  });

  it('a world file from before versioning stays on version 1, in the welcome and on disk', () => {
    const dir = tmp();
    const file = join(dir, 'world.json');
    const first = server(dir);
    first.shutdown();
    servers.length = 0;
    const data = JSON.parse(readFileSync(file, 'utf8'));
    delete data.genVersion;
    writeFileSync(file, JSON.stringify(data));
    const s = server(dir);
    expect(welcomeOf(s).genVersion).toBe(GEN_VERSION_LEGACY);
    s.shutdown();
    expect(JSON.parse(readFileSync(file, 'utf8')).genVersion).toBe(GEN_VERSION_LEGACY);
  });
});
