import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { type RunningServer, startServer } from '../../server/App';
import { type Config, loadConfig } from '../../server/Config';
import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from '../../src/net/protocol';
import { decodeBinary } from '../../src/net/binary';
import { BLOCK } from '../../src/world/BlockRegistry';
import type { ServerWorld } from '../../server/ServerWorld';

/** A started server on a random port with its own temp DATA_DIR. */
export interface TestServer {
  server: RunningServer;
  config: Config;
  dir: string;
  base: string;
  wsBase: string;
  stop(): Promise<void>;
}

export async function startTestServer(env: Record<string, string> = {}, dir = mkdtempSync(join(tmpdir(), 'bunk-int-'))): Promise<TestServer> {
  const config = loadConfig({
    PORT: '0', DATA_DIR: dir, STATIC_DIR: join(dir, 'static'), MAIN_WORLD: 'off', BACKUP_KEEP: '0', ROOM_CREATE_LIMIT: '1000', ...env,
  } as NodeJS.ProcessEnv);
  const server = await startServer(config);
  return {
    server, config, dir,
    base: `http://127.0.0.1:${server.port}`,
    wsBase: `ws://127.0.0.1:${server.port}`,
    stop: async () => { await server.close(); },
  };
}

export function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export async function createRoom(base: string, body: Record<string, unknown> = {}): Promise<{ code: string; ownerToken: string; locked: boolean }> {
  const res = await fetch(`${base}/api/rooms`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Test Game', gameMode: 'survival', seed: 'test', ...body }),
  });
  if (res.status !== 201) throw new Error(`create failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<{ code: string; ownerToken: string; locked: boolean }>;
}

/** WebSocket test client that records everything it receives. */
export class TestClient {
  readonly ws: WebSocket;
  readonly messages: ServerMessage[] = [];
  readonly frames: ArrayBuffer[] = [];
  closed: { code: number } | null = null;
  private waiters: { test: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];

  constructor(url: string, headers: Record<string, string> = {}) {
    this.ws = new WebSocket(url, { headers });
    this.ws.on('message', (data, isBinary) => {
      let msg: ServerMessage | null;
      if (isBinary) {
        const buf = data as Buffer;
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
        this.frames.push(ab);
        msg = decodeBinary(ab);
      } else {
        msg = JSON.parse(data.toString()) as ServerMessage;
      }
      if (!msg) return;
      this.messages.push(msg);
      this.waiters = this.waiters.filter((w) => {
        if (!w.test(msg!)) return true;
        w.resolve(msg!);
        return false;
      });
    });
    this.ws.on('close', (code) => { this.closed = { code }; });
    this.ws.on('error', () => undefined);
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState === WebSocket.OPEN) return resolve();
      this.ws.once('open', () => resolve());
      this.ws.once('error', (e) => reject(e));
      this.ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      this.ws.once('close', () => reject(new Error('closed')));
    });
  }

  send(msg: ClientMessage): void {
    this.ws.send(JSON.stringify(msg));
  }

  /** Resolves with the first message (already received or future) matching. */
  waitFor<T extends ServerMessage['t']>(t: T, test: (m: Extract<ServerMessage, { t: T }>) => boolean = () => true, timeout = 4000): Promise<Extract<ServerMessage, { t: T }>> {
    const match = (m: ServerMessage) => m.t === t && test(m as Extract<ServerMessage, { t: T }>);
    const have = this.messages.find(match);
    if (have) return Promise.resolve(have as Extract<ServerMessage, { t: T }>);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${t}; got ${this.messages.map((m) => m.t).join(',')}`)), timeout);
      this.waiters.push({ test: match, resolve: (m) => { clearTimeout(timer); resolve(m as Extract<ServerMessage, { t: T }>); } });
    });
  }

  /** Waits for the next chat line containing `text`. */
  chatContaining(text: string): Promise<Extract<ServerMessage, { t: 'chat' }>> {
    return this.waitFor('chat', (m) => m.text.includes(text));
  }

  close(): void {
    this.ws.close();
  }
}

export const KEY_A = 'a'.repeat(32);
export const KEY_B = 'b'.repeat(32);

/** Connects, says hello and resolves with the welcome (or the kick as an error with `.kick`). */
export async function joinGame(
  t: TestServer, code: string | null, name: string, extra: { key?: string; owner?: string; password?: string; bin?: boolean; rejoin?: string; profile?: string; party?: string; headers?: Record<string, string> } = {},
): Promise<{ client: TestClient; welcome: Extract<ServerMessage, { t: 'welcome' }> }> {
  const { headers, ...hello } = extra;
  const client = new TestClient(`${t.wsBase}${code ? `/ws/${code}` : '/ws'}`, headers);
  await client.open();
  client.send({ t: 'hello', v: PROTOCOL_VERSION, name, ...hello });
  const first = await Promise.race([client.waitFor('welcome'), client.waitFor('kick')]);
  if (first.t === 'kick') {
    const err = new Error(first.reason) as Error & { kick: typeof first };
    err.kick = first;
    throw err;
  }
  return { client, welcome: first };
}

/**
 * Resolves once the server has loaded the chunks within `radius` chunks of (x, z) in the room's world. The server loads
 * a few chunks per tick, so how long that takes depends on the machine: a fixed sleep either wastes time or lets the
 * test run against unloaded terrain on a slow one. Polls the room in this process; rejects after `timeoutMs`.
 */
export async function waitForChunks(t: TestServer, code: string, x: number, z: number, radius = 2, timeoutMs = 60_000): Promise<void> {
  const room = t.server.rooms?.get(code)?.server as unknown as { entities: { world: ServerWorld } | null } | undefined;
  const world = room?.entities?.world;
  if (!world) throw new Error(`room ${code} has no terrain world`);
  const cx = Math.floor(x) >> 4, cz = Math.floor(z) >> 4;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let missing = 0;
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) if (world.getBlock((cx + dx) * 16 + 8, 64, (cz + dz) * 16 + 8) === BLOCK.UNLOADED) missing++;
    }
    if (missing === 0) return;
    if (Date.now() > deadline) throw new Error(`${missing} chunks around ${x},${z} still not loaded after ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
