import { createHmac } from 'node:crypto';
import { type IncomingMessage, type ServerResponse, request as httpRequest } from 'node:http';
import { safeEqual } from '../Security';

/**
 * The internal API between the control plane and its match runners (MATCH_ISOLATION=container). It only listens on
 * the internal Docker network (never published). Every call carries the runner id and that runner's key:
 *
 *   x-bc-runner: <id>      authorization: Bearer <key>      key = HMAC-SHA256(MATCH_SECRET, "runner:" + id)
 *
 * A runner never sees MATCH_SECRET, only its own key: a runner taken over by an exploit can speak for itself and
 * nobody else (and the control plane checks what it says against what it knows, see ControlPlane).
 */

/** Runner ids are made by the control plane: short, lower-case, safe in container names and DNS. */
export const RUNNER_ID = /^[a-z0-9]{8,24}$/;

export function runnerKey(secret: Buffer | string, id: string): string {
  return createHmac('sha256', secret).update(`runner:${id}`).digest('base64url');
}

/** The runner id of an authenticated internal request, or null. */
export function authRunner(req: IncomingMessage, secret: Buffer | string): string | null {
  const id = req.headers['x-bc-runner'];
  const auth = req.headers.authorization;
  if (typeof id !== 'string' || !RUNNER_ID.test(id) || typeof auth !== 'string' || !auth.startsWith('Bearer ')) return null;
  return safeEqual(auth.slice(7), runnerKey(secret, id)) ? id : null;
}

/** Whether a request to a runner carries its own key (the runner knows only that). */
export function authByKey(req: IncomingMessage, id: string, key: string): boolean {
  const auth = req.headers.authorization;
  return req.headers['x-bc-runner'] === id && typeof auth === 'string' && auth.startsWith('Bearer ') && safeEqual(auth.slice(7), key);
}

export function authHeaders(id: string, key: string): Record<string, string> {
  return { 'x-bc-runner': id, authorization: `Bearer ${key}` };
}

/** A JSON body of at most `limit` bytes. */
export function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); return; }
      parts.push(c);
    });
    req.on('end', () => {
      try {
        const v = parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown : {};
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
        resolve(v as Record<string, unknown>);
      } catch (e) { reject(e instanceof Error ? e : new Error(String(e))); }
    });
    req.on('error', reject);
  });
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

/** POST (or GET without a body) to the other side of the internal API; rejects on a non-2xx answer or after `timeoutMs`. */
export function callJson<T = Record<string, unknown>>(url: string, headers: Record<string, string>, body?: unknown, timeoutMs = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = httpRequest(url, {
      method: data ? 'POST' : 'GET',
      headers: { ...headers, ...(data ? { 'content-type': 'application/json', 'content-length': String(data.length) } : {}) },
      timeout: timeoutMs,
    }, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (c: Buffer) => parts.push(c));
      res.on('end', () => {
        const text = Buffer.concat(parts).toString('utf8');
        if ((res.statusCode ?? 500) >= 300) { reject(new Error(`${res.statusCode} ${text.slice(0, 200)}`)); return; }
        try { resolve((text ? JSON.parse(text) : {}) as T); } catch (e) { reject(e instanceof Error ? e : new Error(String(e))); }
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(data);
  });
}

/** What the control plane computes about a player from their `hello` (the runner has no profile store). */
export interface Ident {
  /** sha256 of the profile token the hello carried (only its owner can present it), and the profile it stands for. */
  th?: string;
  pid?: string;
  rank?: number;
  skin?: string;
  /** The hello's name, and the profile of the account that holds it (null: nobody). */
  name?: string;
  reserved?: string | null;
}

export function encodeIdent(i: Ident): string {
  return Buffer.from(JSON.stringify(i)).toString('base64url');
}

export function decodeIdent(v: unknown): Ident | null {
  if (typeof v !== 'string' || v.length > 2048) return null;
  try {
    const o = JSON.parse(Buffer.from(v, 'base64url').toString('utf8')) as unknown;
    return o && typeof o === 'object' && !Array.isArray(o) ? o as Ident : null;
  } catch {
    return null;
  }
}

/** Runner status as the heartbeat carries it (also the answer of GET /internal/status). */
export interface RunnerStatus {
  id: string;
  version: string;
  room: string | null;
  players: number;
  reservedSeats: number;
  botCount: number;
  playersInPlay: number;
  listed: boolean;
  locked: boolean;
  maxPlayers: number;
  info: unknown;
  lobby: unknown;
  teams: unknown;
  holds: string[];
  playerList: unknown[];
  /** Ticks: p99 of the last window in ms; process: CPU fraction of one core since the last beat, resident memory. */
  tickP99Ms: number;
  cpu: number;
  rssBytes: number;
  heapBytes: number;
}
