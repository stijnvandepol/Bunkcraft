/**
 * Shared helpers for the multiplayer QA scripts (scripts/qa/*.ts): a WebSocket bot that speaks the real
 * protocol (JSON or binary snap/ent), room creation, a managed throwaway server, /metrics parsing and a
 * PASS/FAIL/INFO reporter. Nothing here touches game source.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { decodeBinary } from '../../src/net/binary';
import { type ClientMessage, PROTOCOL_VERSION, type ServerMessage } from '../../src/net/protocol';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- reporting

export interface Result { id: string; status: 'PASS' | 'FAIL' | 'INFO'; detail: string }
export const results: Result[] = [];
export function check(id: string, ok: boolean, detail = ''): boolean {
  results.push({ id, status: ok ? 'PASS' : 'FAIL', detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}${detail ? `  — ${detail}` : ''}`);
  return ok;
}
export function info(id: string, detail: string): void {
  results.push({ id, status: 'INFO', detail });
  console.log(`INFO  ${id}  — ${detail}`);
}

// ---------------------------------------------------------------- server

export interface ManagedServer { base: string; port: number; dataDir: string; logFile: string; proc: ChildProcess; stop(signal?: NodeJS.Signals): Promise<number | null> }

/** Starts `server/index.ts` with tsx on a port and data dir; resolves once /health answers. */
export async function startServer(port: number, dataDir: string, env: Record<string, string> = {}): Promise<ManagedServer> {
  mkdirSync(dataDir, { recursive: true });
  const logFile = join(dataDir, `server-${Date.now()}.log`);
  const out = createWriteStream(logFile);
  const proc = spawn('npx', ['tsx', 'server/index.ts'], {
    cwd: new URL('../..', import.meta.url).pathname,
    env: {
      ...process.env, PORT: String(port), DATA_DIR: join(dataDir, 'data'), ROOM_CREATE_LIMIT: '1000', MAX_CONN_PER_IP: '200',
      LOG_FORMAT: 'text', MAIN_WORLD: 'on', BACKUP_KEEP: '0', ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout!.pipe(out);
  proc.stderr!.pipe(out);
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* not yet */ }
    await sleep(250);
  }
  const exited = new Promise<number | null>((r) => proc.on('exit', (c) => r(c)));
  return {
    base, port, dataDir, logFile, proc,
    stop: async (signal = 'SIGTERM') => {
      // tsx forwards signals to the child node process.
      proc.kill(signal);
      return Promise.race([exited, sleep(8000).then(() => { proc.kill('SIGKILL'); return -1; })]);
    },
  };
}

export async function createRoom(base: string, body: Record<string, unknown>): Promise<{ code: string; ownerToken: string; status: number }> {
  const r = await fetch(`${base}/api/rooms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = (await r.json()) as { code: string; ownerToken: string };
  return { ...j, status: r.status };
}

export async function metrics(base: string): Promise<Record<string, number>> {
  const text = await (await fetch(`${base}/metrics`)).text();
  const out: Record<string, number> = {};
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const i = line.lastIndexOf(' ');
    out[line.slice(0, i)] = Number(line.slice(i + 1));
  }
  return out;
}

// ---------------------------------------------------------------- bot

export interface Kick { reason: string; code?: string }
type Msg = ServerMessage & { at: number; bytes: number };

/** A protocol-level player. Positions are only sent when `pos()` is called or the auto-mover runs. */
export class Bot {
  readonly log: Msg[] = [];
  readonly key: string;
  ws!: WebSocket;
  id = -1;
  welcome!: Extract<ServerMessage, { t: 'welcome' }>;
  x = 0; y = 0; z = 0; yaw = 0; pitch = 0; held = 0;
  closeCode = 0;
  /** Set when the server moved us (spawn, teleport): the next position sent should be exactly that spot. */
  fresh = false;
  bytesIn = 0;
  private seq = 1;
  private timer: NodeJS.Timeout | null = null;

  constructor(readonly name: string, key?: string) {
    this.key = key ?? randomBytes(16).toString('hex');
  }

  connect(base: string, code: string | null, opts: { owner?: string; password?: string; bin?: boolean } = {}): Promise<Extract<ServerMessage, { t: 'welcome' }>> {
    const url = base.replace(/^http/, 'ws') + (code ? `/ws/${code}` : '/ws');
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);
      this.ws.binaryType = 'arraybuffer';
      this.ws.on('open', () => this.send({
        t: 'hello', v: PROTOCOL_VERSION, name: this.name, key: this.key, bin: !!opts.bin,
        ...(opts.owner ? { owner: opts.owner } : {}), ...(opts.password ? { password: opts.password } : {}),
      }));
      this.ws.on('error', (e) => reject(e));
      this.ws.on('close', (c) => { this.closeCode = c; reject(new Error(`closed ${c}`)); });
      this.ws.on('message', (raw: Buffer | ArrayBuffer, isBinary: boolean) => {
        let m: ServerMessage | null;
        let bytes: number;
        if (isBinary) {
          const ab = raw instanceof ArrayBuffer ? raw : (raw as Buffer).buffer.slice((raw as Buffer).byteOffset, (raw as Buffer).byteOffset + (raw as Buffer).byteLength);
          bytes = (ab as ArrayBuffer).byteLength;
          m = decodeBinary(ab as ArrayBuffer);
        } else {
          const s = raw.toString();
          bytes = s.length;
          m = JSON.parse(s) as ServerMessage;
        }
        this.bytesIn += bytes;
        if (!m) return;
        this.log.push({ ...m, at: performance.now(), bytes } as Msg);
        if (m.t === 'welcome') {
          this.id = m.id; this.welcome = m;
          const p = m.player ?? m.spawn;
          this.x = p.x; this.y = p.y; this.z = p.z;
          resolve(m);
        }
        if (m.t === 'teleport' || m.t === 'spawn') { this.x = m.x; this.y = m.y; this.z = m.z; this.fresh = true; }
        if (m.t === 'kick') reject(Object.assign(new Error(m.reason), { code: m.code }));
      });
    });
  }

  send(m: ClientMessage): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  pos(x = this.x, y = this.y, z = this.z, held = this.held): void {
    this.x = x; this.y = y; this.z = z; this.held = held;
    this.send({ t: 'pos', x, y, z, yaw: this.yaw, pitch: this.pitch, flags: 4, held });
  }

  /** Re-sends the position every `ms` (keeps the server's view fresh, like a client at 20 Hz). */
  autoPos(ms = 50): void {
    this.stopAuto();
    this.timer = setInterval(() => this.pos(), ms);
  }

  stopAuto(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  block(x: number, y: number, z: number, id: number, meta = 0): number {
    const seq = this.seq++;
    this.send(meta ? { t: 'block', seq, x, y, z, id, meta } : { t: 'block', seq, x, y, z, id });
    return seq;
  }

  chat(text: string): void { this.send({ t: 'chat', text }); }

  of<T extends ServerMessage['t']>(t: T, since = 0): (Extract<ServerMessage, { t: T }> & { at: number; bytes: number })[] {
    return this.log.filter((m) => m.t === t && m.at >= since) as (Extract<ServerMessage, { t: T }> & { at: number; bytes: number })[];
  }

  /** System chat lines received since a time. */
  sys(since = 0): string[] {
    return this.of('chat', since).filter((c) => c.system).map((c) => c.text);
  }

  async waitFor<T extends ServerMessage['t']>(t: T, pred: (m: Extract<ServerMessage, { t: T }>) => boolean = () => true, timeout = 3000, since = 0):
    Promise<(Extract<ServerMessage, { t: T }> & { at: number }) | null> {
    const end = performance.now() + timeout;
    while (performance.now() < end) {
      const hit = this.of(t, since).find(pred);
      if (hit) return hit;
      await sleep(25);
    }
    return null;
  }

  close(): void {
    this.stopAuto();
    try { this.ws.close(); } catch { /* closed */ }
  }
}

/** Connects and returns the bot, or the kick it got. */
export async function tryJoin(bot: Bot, base: string, code: string | null, opts: { owner?: string; password?: string; bin?: boolean } = {}): Promise<{ ok: true } | { ok: false; kick: Kick }> {
  try {
    await bot.connect(base, code, opts);
    return { ok: true };
  } catch (e) {
    const err = e as Error & { code?: string };
    return { ok: false, kick: { reason: err.message, code: err.code } };
  }
}

export function summary(): number {
  const fail = results.filter((r) => r.status === 'FAIL').length;
  const pass = results.filter((r) => r.status === 'PASS').length;
  console.log(`\n${pass} passed, ${fail} failed, ${results.filter((r) => r.status === 'INFO').length} info`);
  return fail;
}
