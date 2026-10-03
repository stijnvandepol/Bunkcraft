import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from '../../src/net/protocol';

const ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');

export function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => res(port));
    });
  });
}

export interface TestServer {
  port: number;
  dataDir: string;
  http: string;
  ws: string;
  /** Captured stdout + stderr. */
  log: () => string;
  /** SIGTERM (the server saves) and wait for exit. */
  stop(): Promise<void>;
  /** Stop, keeping the data dir, and start again on the same port with the given env overrides. */
  restart(env?: Record<string, string>): Promise<void>;
  /** Stop and delete the data dir. */
  dispose(): Promise<void>;
}

/** Starts the real `server/index.ts` on a random port with a temporary data dir. */
export async function startServer(env: Record<string, string> = {}, existingDir?: string): Promise<TestServer> {
  const dataDir = existingDir ?? mkdtempSync(join(tmpdir(), 'bunk-it-'));
  const port = await freePort();
  let child: ChildProcess | null = null;
  let output = '';
  let currentEnv = env;

  const boot = (): Promise<void> => new Promise((res, rej) => {
    let ready = false;
    const c = spawn(join(ROOT, 'node_modules/.bin/tsx'), ['server/index.ts'], {
      cwd: ROOT,
      env: {
        ...process.env, PORT: String(port), DATA_DIR: dataDir, ROOM_CREATE_LIMIT: '1000', MAIN_WORLD: 'off', TRUST_PROXY: '1', MAX_CONN_PER_IP: '1000', MAX_CONNECTIONS: '5000', BACKUP_KEEP: '0', LOG_FORMAT: 'text', LOG_LEVEL: 'info',
        STATIC_DIR: join(ROOT, 'tests/integration'), ...currentEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child = c;
    const onData = (d: Buffer) => {
      output += d.toString();
      if (!ready && /server started/.test(d.toString())) { ready = true; res(); }
    };
    c.stdout!.on('data', onData);
    c.stderr!.on('data', onData); // the structured logger may write to either stream
    c.once('exit', (code) => { if (!ready) rej(new Error(`server exited (${code}):\n${output}`)); });
    setTimeout(() => rej(new Error(`server start timeout:\n${output}`)), 40_000).unref();
  });

  const halt = (): Promise<void> => new Promise((res) => {
    const c = child;
    if (!c || c.exitCode !== null) return res();
    c.once('exit', () => res());
    c.kill('SIGTERM');
    setTimeout(() => c.kill('SIGKILL'), 5000).unref();
  });

  await boot();
  return {
    port, dataDir, http: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}`,
    log: () => output,
    stop: halt,
    restart: async (e) => { await halt(); if (e) currentEnv = { ...currentEnv, ...e }; await boot(); },
    dispose: async () => { await halt(); if (!existingDir) rmSync(dataDir, { recursive: true, force: true }); },
  };
}

let ipCounter = 0;
/** A fresh fake client address: the server runs with TRUST_PROXY=1, so per-address limits do not couple tests. */
export const freshIp = (): string => `10.${(++ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;

export async function api<T = unknown>(srv: TestServer, method: string, path: string, body?: unknown, ip = freshIp()): Promise<{ status: number; body: T }> {
  const res = await fetch(srv.http + path, {
    method, headers: { 'x-forwarded-for': ip, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

export async function createRoom(srv: TestServer, body: Record<string, unknown> = {}): Promise<string> {
  const r = await api<{ code: string }>(srv, 'POST', '/api/rooms', { name: 'Test', gameMode: 'creative', seed: 'it', ...body });
  if (r.status !== 201) throw new Error(`create room failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.code;
}

type Msg<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>;

/** A real WebSocket client that records every server message. */
export class Client {
  readonly msgs: ServerMessage[] = [];
  closed: { code: number; reason: string } | null = null;
  pings = 0;
  id = 0;
  private waiters: Array<() => void> = [];
  private constructor(readonly ws: WebSocket, readonly name: string) {
    ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      const m = JSON.parse(raw.toString()) as ServerMessage;
      this.msgs.push(m);
      if (m.t === 'welcome') this.id = m.id;
      this.waiters.forEach((w) => w());
    });
    ws.on('ping', () => { this.pings++; });
    ws.on('close', (code, reason) => {
      this.closed = { code, reason: reason.toString() };
      this.waiters.forEach((w) => w());
    });
    ws.on('error', () => { /* surfaced through close */ });
  }

  /** Opens the socket (no hello). Rejects when the server refuses the upgrade. */
  static open(url: string, name = 'tester', ip = freshIp()): Promise<Client> {
    return new Promise((res, rej) => {
      const ws = new WebSocket(url, { headers: { 'x-forwarded-for': ip } });
      const c = new Client(ws, name);
      ws.once('open', () => res(c));
      ws.once('error', rej);
      ws.once('unexpected-response', (_req, r) => { ws.removeAllListeners('error'); ws.on('error', () => {}); rej(new Error(`HTTP ${r.statusCode}`)); });
    });
  }

  /** Opens the socket and logs in; resolves after the welcome message. */
  static async join(url: string, name: string, version = PROTOCOL_VERSION): Promise<Client> {
    const c = await Client.open(url, name);
    c.send({ t: 'hello', v: version, name });
    await c.waitFor((m) => m.t === 'welcome' || m.t === 'kick');
    return c;
  }

  send(msg: ClientMessage | Record<string, unknown>): void {
    this.ws.send(JSON.stringify(msg));
  }

  sendRaw(data: string | Buffer): void {
    this.ws.send(data);
  }

  of<T extends ServerMessage['t']>(t: T): Msg<T>[] {
    return this.msgs.filter((m) => m.t === t) as Msg<T>[];
  }

  get welcome(): Msg<'welcome'> {
    const w = this.of('welcome')[0];
    if (!w) throw new Error(`${this.name} has no welcome; got ${JSON.stringify(this.msgs.slice(0, 3))}`);
    return w;
  }

  /** Resolves with the first message (existing or future) matching the predicate. `after` skips messages up to that index. */
  async waitFor<T extends ServerMessage>(pred: (m: ServerMessage) => boolean, timeoutMs = 10_000, after = 0): Promise<T> {
    const start = Date.now();
    for (;;) {
      const hit = this.msgs.slice(after).find(pred);
      if (hit) return hit as T;
      if (this.closed) throw new Error(`${this.name}: socket closed (${this.closed.code} ${this.closed.reason}) while waiting`);
      const left = timeoutMs - (Date.now() - start);
      if (left <= 0) throw new Error(`${this.name}: timeout waiting for message; got types ${[...new Set(this.msgs.map((m) => m.t))].join(',')}`);
      await new Promise<void>((res) => {
        const t = setTimeout(done, left);
        const self = this;
        function done() { clearTimeout(t); self.waiters = self.waiters.filter((w) => w !== done); res(); }
        this.waiters.push(done);
      });
    }
  }

  waitType<T extends ServerMessage['t']>(t: T, timeoutMs = 10_000, after = 0): Promise<Msg<T>> {
    return this.waitFor<Msg<T>>((m) => m.t === t, timeoutMs, after);
  }

  /** Index to pass as `after` to only see messages that arrive from now on. */
  mark(): number {
    return this.msgs.length;
  }

  async waitClosed(timeoutMs = 5000): Promise<{ code: number; reason: string }> {
    const start = Date.now();
    while (!this.closed) {
      if (Date.now() - start > timeoutMs) throw new Error(`${this.name}: socket still open`);
      await new Promise((r) => setTimeout(r, 20));
    }
    return this.closed;
  }

  close(): void {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) this.ws.close();
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
