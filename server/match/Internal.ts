import { createHmac } from 'node:crypto';
import { type IncomingMessage, type ServerResponse, request as httpRequest } from 'node:http';
import { INVISIBLE_CHARS } from '../../src/net/protocol';
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

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null);
const count = (v: unknown, max: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(max, Math.floor(v))) : 0);
const real = (v: unknown, max: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(max, v)) : 0);
/** Text a runner reports that ends up in listings and the ops dashboard: no control or bidi characters, capped. */
const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(INVISIBLE_CHARS, '').slice(0, max) : '');

/** Most players or seats a runner can report for one lobby (lobbies hold at most 16; generous headroom). */
const MAX_REPORTED = 256;

/**
 * A runner's status (heartbeat, assignment answer, adoption) as the control plane keeps it. A runner is only half
 * trusted (see ControlPlane): what it says goes into public listings, matchmaking and the ops dashboard, so every
 * field is rebuilt here with its type and bounds; nothing else of the body is kept.
 */
export function cleanStatus(raw: unknown): RunnerStatus {
  const s = obj(raw) ?? {};
  const info = obj(s.info);
  const lobby = obj(s.lobby);
  const teams = obj(s.teams);
  return {
    id: text(s.id, 24), version: text(s.version, 64), room: typeof s.room === 'string' ? text(s.room, 16) : null,
    players: count(s.players, MAX_REPORTED), reservedSeats: count(s.reservedSeats, MAX_REPORTED), botCount: count(s.botCount, MAX_REPORTED),
    playersInPlay: count(s.playersInPlay, MAX_REPORTED), listed: s.listed === true, locked: s.locked === true, maxPlayers: count(s.maxPlayers, MAX_REPORTED),
    info: info ? {
      name: text(info.name, 32), gameMode: text(info.gameMode, 16), gameType: text(info.gameType, 16), players: count(info.players, MAX_REPORTED),
      maxPlayers: count(info.maxPlayers, MAX_REPORTED), scoreLimit: count(info.scoreLimit, 1e6), timeLimitSec: count(info.timeLimitSec, 1e6), locked: info.locked === true,
      ...(typeof info.map === 'string' ? { map: text(info.map, 32) } : {}),
    } : null,
    lobby: lobby ? { phase: text(lobby.phase, 16), timeLeft: real(lobby.timeLeft, 1e6), progress: real(lobby.progress, 1), map: text(lobby.map, 32) } : null,
    teams: teams ? { red: count(teams.red, MAX_REPORTED), blue: count(teams.blue, MAX_REPORTED) } : null,
    holds: Array.isArray(s.holds) ? s.holds.slice(0, 64).filter((h): h is string => typeof h === 'string' && h.length <= 128) : [],
    playerList: Array.isArray(s.playerList) ? s.playerList.slice(0, MAX_REPORTED).map(obj).filter((p): p is Record<string, unknown> => !!p).map((p) => ({
      id: count(p.id, 2 ** 31), name: text(p.name, 32), ip: text(p.ip, 64), op: p.op === true, pingMs: count(p.pingMs, 1e6),
      ...(typeof p.suspicion === 'number' ? { suspicion: count(p.suspicion, 100) } : {}),
      ...(typeof p.strikes === 'number' ? { strikes: real(p.strikes, 1e6) } : {}),
    })) : [],
    tickP99Ms: real(s.tickP99Ms, 1e6), cpu: real(s.cpu, 1024), rssBytes: count(s.rssBytes, 2 ** 50), heapBytes: count(s.heapBytes, 2 ** 50),
  };
}
